import { and, asc, eq, getTableColumns, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  OrderId,
  PaymentEvidenceKind,
  PaymentId,
  PaymentMethod,
  PaymentResolvedState,
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
  PaymentResolution,
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

  async findByIdForUpdate(
    scope: TenantContext,
    id: PaymentId,
    tx: unknown,
  ): Promise<PaymentRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, id)))
      .limit(1)
      .for('update');
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

  /**
   * The `FAIL`, `CANCEL` and `EXPIRE` edges, as one conditional UPDATE.
   *
   * `WHERE state = 'PENDING'` is the same mechanism `confirm` uses one method above and
   * carries the same guarantee across a wider set of racers: an operator rejecting
   * while the sweep expires, a customer withdrawing while an operator confirms, a
   * replayed command and two worker replicas all produce one transition and one `true`.
   *
   * Every column in one statement, because `payments_resolved_check` is an equality:
   * a statement that moved the state without stamping `resolved_at` would leave the row
   * violating its own constraint, and the database refuses it rather than storing it.
   */
  async resolve(
    scope: TenantContext,
    id: PaymentId,
    to: PaymentResolvedState,
    resolution: PaymentResolution,
    now: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: to,
        resolvedAt: resolution.resolvedAt,
        resolvedByAdminId: resolution.resolvedByAdminId,
        resolutionNote: resolution.resolutionNote,
        updatedAt: now,
      })
      .where(
        and(eq(payments.tenantId, tenantId), eq(payments.id, id), eq(payments.state, 'PENDING')),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  /**
   * The customer's claim to have sent the transfer, as one conditional UPDATE.
   *
   * Three predicates beside the tenant and the id, and each of them is a rule stated
   * where a later caller cannot skip it. `state = 'PENDING'` — a claim about a payment
   * that is over is a claim nobody can act on. `method = 'MANUAL_TRANSFER'` —
   * `payments_customer_signal_check` says so too, and having it here means a wallet
   * payment answers `false` rather than raising an integrity error at the surface.
   * `customer_signalled_at IS NULL` — the FIRST claim is the recorded one, because the
   * moment an operator compares against their bank statement must not move when the
   * customer taps again.
   *
   * It sets `updated_at` and nothing else beyond the stamp. No state moves here: this
   * is the one write in this repository that changes what an operator can SEE without
   * changing anything about the money.
   */
  async signalSent(scope: TenantContext, id: PaymentId, now: Date, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({ customerSignalledAt: now, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.id, id),
          eq(payments.state, 'PENDING'),
          eq(payments.method, 'MANUAL_TRANSFER'),
          isNull(payments.customerSignalledAt),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  /**
   * Whether a PENDING payment against this order carries the customer's claim.
   *
   * `LIMIT 1` over the three predicates, because the caller acts on the answer alone.
   * `customer_signalled_at IS NOT NULL` is the claim; `state = 'PENDING'` is what makes
   * it still open; the order is the scope. A payment an operator already resolved is
   * not a reason to refuse a cancellation, which is why the state is in the predicate
   * rather than assumed.
   */
  async hasClaimedPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.customerSignalledAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The `CANCEL` edge over every PENDING payment against one order.
   *
   * One statement rather than a read and a loop: the set is small, it is scoped to a
   * single order, and the UPDATE's own `state = 'PENDING'` is what makes it safe
   * against an operator confirming or the sweep expiring concurrently — whichever
   * commits first, the other matches nothing.
   *
   * `resolved_at` is set by the SAME statement, because `payments_resolved_check` binds
   * them: moving the state alone could not commit. No administrator and no note, for
   * the reason `PaymentService.withdrawPending` gives — nobody reviewed this, and
   * `payments_resolution_reviewer_check` would refuse an admin id in any case.
   *
   * It deliberately does NOT exclude a signalled payment. That refusal belongs to
   * `OrderService.cancelByCustomer`, which must answer the customer with a sentence
   * about their claim rather than silently cancelling one payment and not another.
   */
  async cancelPendingForOrder(
    scope: TenantContext,
    orderId: OrderId,
    now: Date,
    tx: unknown,
  ): Promise<readonly PaymentId[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(payments)
      .set({ state: 'CANCELLED', resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.state, 'PENDING'),
          /*
           * A SIGNALLED transfer is never withdrawn here, and the predicate belongs in
           * this statement rather than in the caller's guard.
           *
           * `OrderService.cancelByCustomer` asks whether a claim exists before it
           * writes, and READ COMMITTED lets a `signalTransferSent` commit between that
           * read and this UPDATE — so a `state = 'PENDING'` predicate alone cancelled
           * the payment whose customer had just been told it was recorded for review.
           * The guard cannot close that window; only the write can. The caller re-asks
           * afterwards and turns a row left behind into a refusal. Found by the Codex
           * review of PR #30.
           *
           * An operator's own withdrawal is unaffected: that path is
           * `PaymentService.withdrawPending` over a payment id, not this one.
           */
          isNull(payments.customerSignalledAt),
        ),
      )
      .returning({ id: payments.id });
    return rows.map((row) => row.id as PaymentId);
  }

  /**
   * The `EXPIRE` edge as a bounded set, for the sweep.
   *
   * Two statements rather than one, and the sub-select is not decoration: the UPDATE's
   * own predicates are re-checked AFTER the row lock is granted, because a sub-select
   * alone is satisfied by a scan that found the row before another writer moved it.
   * `ServiceRepository.expireDue` states the same rule and this follows it.
   *
   * `FOR UPDATE SKIP LOCKED` on the candidates is what makes two worker replicas —
   * the normal case on every rolling update — take DIFFERENT rows rather than one
   * blocking on the other's lock for the length of a tick.
   *
   * `expires_at IS NOT NULL` is redundant beside `<=` and kept for the reason
   * `ServiceRepository.expireDue` keeps its copy: it is the one place the intent is
   * written down, and a later `COALESCE(expires_at, ...)` would expire every payment
   * that has no deadline with nothing else in the query objecting. A wallet payment has
   * no deadline and is never PENDING either, so this predicate is the second of two
   * independent reasons it is never touched here.
   */
  async expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly PaymentRecord[]> {
    const tenantId = requireTenantId(scope);
    if (limit <= 0) return [];

    const due = this.exec(tx)
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.expiresAt),
          lte(payments.expiresAt, now),
        ),
      )
      .orderBy(asc(payments.expiresAt), asc(payments.id))
      .limit(limit)
      .for('update', { skipLocked: true });

    const rows = await this.exec(tx)
      .update(payments)
      .set({
        state: 'EXPIRED',
        /*
         * `resolved_at` is the CLOCK's now, not the deadline that passed.
         *
         * When the window closed and when this installation noticed are different
         * facts, and `expires_at` already records the first. Writing the deadline here
         * would make a sweep that ran an hour late look like one that ran on time.
         */
        resolvedAt: now,
        // Nobody decided this; `payments_resolution_reviewer_check` refuses an admin
        // id on anything but a FAILED payment, so these two are the schema's rule
        // restated where a caller can read it.
        resolvedByAdminId: null,
        resolutionNote: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.state, 'PENDING'),
          isNotNull(payments.expiresAt),
          lte(payments.expiresAt, now),
          sql`${payments.id} IN ${due}`,
        ),
      )
      .returning();

    return rows.map((row) => toRecord(row as Row));
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
  customerSignalledAt: Date | null;
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
    customerSignalledAt: row.customerSignalledAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
