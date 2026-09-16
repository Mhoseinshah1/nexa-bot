import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  OrderId,
  PaymentEvidenceKind,
  PaymentId,
  PaymentMethod,
  PaymentState,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import type {
  PaymentConfirmation,
  PaymentCursor,
  PaymentDraft,
  PaymentPage,
  PaymentRecord,
  PaymentRepository,
  PaymentSearch,
} from '../application/ports.js';

/**
 * Payments, in PostgreSQL.
 *
 * Two writes and no third: `create` and `confirm`. There is no general `update`, and
 * that is not an omission a later commit should fill in —
 * `nexa_payments_confirmation_guard` (0035) rejects any change to a CONFIRMED
 * payment's money, customer, order, method, reference, evidence, confirming
 * administrator or state, leaving only `external_reference` mutable for a gateway that
 * does not ship. A general update method would be a capability the database refuses.
 */
export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Creates, or returns what is already written under this reference.
   *
   * The reference is derived from the command's idempotency key, so a retry lands on
   * `payments_tenant_reference_key` and re-reads rather than minting a second payment
   * for one order — which the customer could then also be asked to pay.
   */
  async create(scope: TenantContext, draft: PaymentDraft, tx?: unknown): Promise<PaymentRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(payments)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        // No `state`: the column defaults to the machine's initial state, and a caller
        // that could name one could create a payment already CONFIRMED.
        method: draft.method,
        amount: draft.amount.amountMinor,
        currency: draft.amount.currency,
        reference: draft.reference,
        expiresAt: draft.expiresAt,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .onConflictDoNothing({ target: [payments.tenantId, payments.reference] })
      .returning();

    const inserted = rows[0];
    if (inserted !== undefined) return toRecord(inserted);

    const existing = await this.findByReference(scope, draft.reference, tx);
    if (existing === null) {
      // See the wallet repository: a conflict with nothing to re-read means a
      // constraint OTHER than the reference index was violated, which would make a
      // create silently a no-op. Loud, because the alternative is a customer shown
      // instructions for a payment that does not exist.
      throw new Error(
        `payment ${draft.reference} conflicted on insert but could not be re-read; ` +
          'a constraint other than payments_tenant_reference_key was violated',
      );
    }
    return existing;
  }

  async findById(scope: TenantContext, id: PaymentId, tx?: unknown): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByReference(
    scope: TenantContext,
    reference: string,
    tx?: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.reference, reference)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    search: PaymentSearch,
    limit: number,
    cursor: PaymentCursor | null,
    tx?: unknown,
  ): Promise<PaymentPage> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(payments.tenantId, tenantId)];
    if (search.state !== undefined) conditions.push(eq(payments.state, search.state));
    if (search.method !== undefined) conditions.push(eq(payments.method, search.method));
    if (search.customerId !== undefined)
      conditions.push(eq(payments.customerId, search.customerId));
    if (search.orderId !== undefined) conditions.push(eq(payments.orderId, search.orderId));
    if (search.reference !== undefined) conditions.push(eq(payments.reference, search.reference));
    if (cursor !== null) {
      conditions.push(
        sql`(${payments.createdAt}, ${payments.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await this.exec(tx)
      .select({
        ...getTableColumns(payments),
        createdAtText: sql<string>`to_char(${payments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(payments)
      .where(and(...conditions))
      .orderBy(asc(payments.createdAt), asc(payments.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRecord),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.id as PaymentId }
          : null,
    };
  }

  /**
   * The `CONFIRM` edge, as one conditional UPDATE.
   *
   * `WHERE state = 'PENDING'` is what makes two operators pressing approve, a replayed
   * request and two replicas produce ONE confirmation — the same mechanism
   * `OrderRepository.transition` uses and ADR-0028 records, with no lock and no
   * read-then-write window.
   *
   * Every column here is set by the SAME statement, because `payments_confirmed_check`
   * binds them together: `(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND
   * evidence_kind IS NOT NULL)`. Moving the state in one statement and stamping the
   * evidence in another would leave the row violating its own constraint in between.
   *
   * There is no amount parameter. See `PaymentRepository.confirm`.
   */
  async confirm(
    scope: TenantContext,
    id: PaymentId,
    confirmation: PaymentConfirmation,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'CONFIRMED',
        evidenceKind: confirmation.evidenceKind,
        evidenceNote: confirmation.evidenceNote,
        confirmedByAdminId: confirmation.confirmedByAdminId,
        confirmedAt: confirmation.confirmedAt,
        updatedAt: now,
      })
      .where(
        and(eq(payments.tenantId, tenantId), eq(payments.id, id), eq(payments.state, 'PENDING')),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }
}

type Row = {
  id: string;
  customerId: string;
  orderId: string | null;
  state: string;
  method: string;
  amount: bigint;
  currency: string;
  reference: string;
  evidenceKind: string | null;
  evidenceNote: string | null;
  externalReference: string | null;
  confirmedAt: Date | null;
  confirmedByAdminId: string | null;
  resolvedAt: Date | null;
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Row): PaymentRecord {
  return {
    id: row.id as PaymentId,
    customerId: row.customerId as UserId,
    orderId: row.orderId as OrderId | null,
    state: row.state as PaymentState,
    method: row.method as PaymentMethod,
    // One value, so nothing downstream can read an amount without its currency.
    amount: money(row.amount, row.currency as CurrencyCode),
    reference: row.reference,
    evidenceKind: row.evidenceKind as PaymentEvidenceKind | null,
    evidenceNote: row.evidenceNote,
    externalReference: row.externalReference,
    confirmedAt: row.confirmedAt,
    confirmedByAdminId: row.confirmedByAdminId,
    resolvedAt: row.resolvedAt,
    resolvedByAdminId: row.resolvedByAdminId,
    resolutionNote: row.resolutionNote,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
