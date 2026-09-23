import { and, eq } from 'drizzle-orm';
import { money, type CurrencyCode, type PaymentId, type TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { receiptCredits } from '../../../../infrastructure/persistence/schema.js';
import type {
  ReceiptCreditRecord,
  ReceiptCreditRepository,
} from '../application/receipt-credit-ports.js';

/**
 * Receipt credits, in PostgreSQL (D2).
 *
 * Two methods and no third. There is no update and no delete, and not by omission:
 * `receipt_credits_no_update` and `_no_delete` (0114) refuse both, and a method that
 * offered either would be a capability the database refuses.
 */
export class DrizzleReceiptCreditRepository implements ReceiptCreditRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async record(
    scope: TenantContext,
    record: ReceiptCreditRecord,
    tx: unknown,
  ): Promise<ReceiptCreditRecord> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .insert(receiptCredits)
      .values({
        tenantId,
        paymentId: record.paymentId,
        amount: record.amount.amountMinor,
        currency: record.amount.currency,
        walletEntryId: record.walletEntryId,
        decidedByAdminId: record.decidedByAdminId,
        decidedAt: record.decidedAt,
        note: record.note,
      })
      .returning();
    /* istanbul ignore next -- a plain INSERT that did not throw returned its row. */
    if (row === undefined) throw new Error(`receipt credit ${record.paymentId} returned no row`);
    return toRecord(row);
  }

  async findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<ReceiptCreditRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(receiptCredits)
      .where(and(eq(receiptCredits.tenantId, tenantId), eq(receiptCredits.paymentId, paymentId)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }
}

function toRecord(row: typeof receiptCredits.$inferSelect): ReceiptCreditRecord {
  return {
    paymentId: row.paymentId as PaymentId,
    // `receipt_credits_currency_check` is built from the contract enum.
    amount: money(row.amount, row.currency as CurrencyCode),
    walletEntryId: row.walletEntryId,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
    note: row.note,
  };
}
