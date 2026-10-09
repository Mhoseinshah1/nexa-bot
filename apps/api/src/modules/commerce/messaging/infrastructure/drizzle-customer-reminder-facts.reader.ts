import { sql } from 'drizzle-orm';
import {
  minutesLeft,
  money,
  paymentTrackingCode,
  type CurrencyCode,
  type CustomerNotificationKind,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { resellerMinimumValues } from '../../resellers/infrastructure/drizzle-reseller-minimum-facts.js';

/**
 * WP-A9: what the three non-service reminders render, read at send time from their subject.
 *
 * A READER, not a payload (ADR 0030 §1): the producer enqueued a kind and an id, and these
 * values are derived from the row the id names — the payment's reference and deadline, the
 * order's total and deadline, the wallet's balance off the ledger and the threshold its
 * alert recorded. Read-only by construction: the dispatcher that holds it can render a
 * sentence and do nothing else.
 *
 * `null` means the subject is gone, and the dispatcher then sends nothing — a reminder
 * with an empty reference or a missing amount is worse than silence.
 */
export class DrizzleCustomerReminderFactsReader {
  constructor(private readonly db: Database) {}

  async valuesFor(
    scope: TenantContext,
    kind: CustomerNotificationKind,
    subjectId: string,
    now: Date,
  ): Promise<TemplateValues | null> {
    const tenantId = requireTenantId(scope);
    if (kind === 'PAYMENT_PENDING_REMINDER') {
      const result = await this.db.execute(sql`
        SELECT reference, expires_at FROM payments
        WHERE tenant_id = ${tenantId} AND id = ${subjectId} AND expires_at IS NOT NULL
        LIMIT 1`);
      const row = result.rows[0] as { reference: string; expires_at: string } | undefined;
      if (row === undefined) return null;
      const expiresAt = new Date(row.expires_at);
      return {
        reference: paymentTrackingCode(row.reference),
        expiresAt,
        minutes: minutesLeft(expiresAt, now),
      };
    }
    if (kind === 'ORDER_PENDING_REMINDER') {
      const result = await this.db.execute(sql`
        SELECT total_amount, currency, expires_at FROM orders
        WHERE tenant_id = ${tenantId} AND id = ${subjectId} AND expires_at IS NOT NULL
        LIMIT 1`);
      const row = result.rows[0] as
        { total_amount: string; currency: string; expires_at: string } | undefined;
      if (row === undefined) return null;
      const expiresAt = new Date(row.expires_at);
      return {
        // `BigInt(string)`: the column is bigint and the driver hands back its text.
        total: money(BigInt(row.total_amount), row.currency as CurrencyCode),
        expiresAt,
        minutes: minutesLeft(expiresAt, now),
      };
    }
    // Round N R2: the reseller monthly minimum, from its notice row and the month's sales.
    if (kind === 'RESELLER_MINIMUM_REMINDER' || kind === 'RESELLER_MINIMUM_ACHIEVED') {
      return resellerMinimumValues(this.db, tenantId, kind, subjectId, now);
    }
    if (kind === 'WALLET_LOW_BALANCE') {
      const result = await this.db.execute(sql`
        SELECT a.currency, a.threshold_amount,
               (SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT'
                                         THEN e.amount ELSE -e.amount END), 0)
                FROM wallet_entries e
                WHERE e.tenant_id = a.tenant_id
                  AND e.customer_id = a.customer_id
                  AND e.currency = a.currency) AS derived
        FROM wallet_threshold_alerts a
        WHERE a.tenant_id = ${tenantId} AND a.id = ${subjectId}
        LIMIT 1`);
      const row = result.rows[0] as
        { currency: string; threshold_amount: string; derived: string } | undefined;
      if (row === undefined) return null;
      const currency = row.currency as CurrencyCode;
      return {
        balance: money(BigInt(row.derived), currency),
        threshold: money(BigInt(row.threshold_amount), currency),
      };
    }
    return null;
  }
}
