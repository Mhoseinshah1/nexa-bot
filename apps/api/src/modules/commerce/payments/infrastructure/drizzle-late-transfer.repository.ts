import { and, count, eq, inArray } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  LateTransferDecision,
  PaymentId,
  PaymentRejectionReason,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  lateTransferDecisions,
  paymentReceipts,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LateTransferDecisionDraft,
  LateTransferDecisionRecord,
  LateTransferRepository,
} from '../application/late-transfer-ports.js';

/**
 * Late-transfer decisions, in PostgreSQL. One write, `record`, and no second.
 *
 * There is no update and no delete here, and there is no place to add one: 0114 refuses
 * both at the table, and refuses an INSERT about anything but an expired manual
 * transfer, or a credit that is not the payment's exact amount.
 */
export class DrizzleLateTransferRepository implements LateTransferRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async findDecision(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<LateTransferDecisionRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(lateTransferDecisions)
      .where(
        and(
          eq(lateTransferDecisions.tenantId, tenantId),
          eq(lateTransferDecisions.paymentId, paymentId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async record(
    scope: TenantContext,
    draft: LateTransferDecisionDraft,
    tx: unknown,
  ): Promise<LateTransferDecisionRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .insert(lateTransferDecisions)
      .values({
        tenantId,
        paymentId: draft.paymentId,
        decision: draft.decision,
        reason: draft.reason,
        note: draft.note,
        amount: draft.amount?.amountMinor ?? null,
        currency: draft.amount?.currency ?? null,
        walletEntryId: draft.walletEntryId,
        decidedByAdminId: draft.decidedByAdminId,
        decidedAt: draft.decidedAt,
      })
      .returning();
    /* istanbul ignore next -- an INSERT ... RETURNING that did not throw returned its row. */
    if (row === undefined) {
      throw new Error(`late-transfer decision for ${draft.paymentId} was not written`);
    }
    return toRecord(row);
  }

  async decisionsFor(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, LateTransferDecisionRecord>> {
    const found = new Map<PaymentId, LateTransferDecisionRecord>();
    if (paymentIds.length === 0) return found;
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(lateTransferDecisions)
      .where(
        and(
          eq(lateTransferDecisions.tenantId, tenantId),
          inArray(lateTransferDecisions.paymentId, [...paymentIds]),
        ),
      );
    for (const row of rows) {
      const record = toRecord(row);
      found.set(record.paymentId, record);
    }
    return found;
  }

  async receiptCountsFor(
    scope: TenantContext,
    paymentIds: readonly PaymentId[],
    tx?: unknown,
  ): Promise<ReadonlyMap<PaymentId, number>> {
    const found = new Map<PaymentId, number>();
    if (paymentIds.length === 0) return found;
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ paymentId: paymentReceipts.paymentId, held: count() })
      .from(paymentReceipts)
      .where(
        and(
          eq(paymentReceipts.tenantId, tenantId),
          inArray(paymentReceipts.paymentId, [...paymentIds]),
        ),
      )
      .groupBy(paymentReceipts.paymentId);
    for (const row of rows) found.set(row.paymentId as PaymentId, Number(row.held));
    return found;
  }
}

type Row = typeof lateTransferDecisions.$inferSelect;

function toRecord(row: Row): LateTransferDecisionRecord {
  return {
    paymentId: row.paymentId as PaymentId,
    decision: row.decision as LateTransferDecision,
    reason: row.reason as PaymentRejectionReason | null,
    note: row.note,
    // Both or neither, by `late_transfer_decisions_credit_check`.
    amount:
      row.amount === null || row.currency === null
        ? null
        : money(row.amount, row.currency as CurrencyCode),
    walletEntryId: row.walletEntryId,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
  };
}
