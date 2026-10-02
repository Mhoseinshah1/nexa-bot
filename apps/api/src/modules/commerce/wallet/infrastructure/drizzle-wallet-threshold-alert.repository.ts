import { sql } from 'drizzle-orm';
import type { CurrencyCode, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  WalletCrossing,
  WalletThresholdAlertRepository,
} from '../application/wallet-low-balance.service.js';

interface Row {
  readonly customer_id: string;
  readonly crossing_entry_id: string;
  readonly crossed_at: string;
}

/**
 * WP-A9: the low-balance lane's one read and one write.
 *
 * The read derives every wallet's RUNNING balance from the ledger — the same signed sum
 * `balanceOf` takes, as a window over the wallet's entries in `(created_at, id)` order —
 * and never reads or writes a stored balance, because there is none.
 */
export class DrizzleWalletThresholdAlertRepository implements WalletThresholdAlertRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Wallets below the threshold now, with a fall they have not been told about.
   *
   * `running` numbers each wallet's entries and carries the balance after each one.
   * `summary` takes, per wallet, the position of its latest entry and of its latest entry
   * AT OR ABOVE the threshold. A wallet is a candidate when:
   *
   *   - its balance after the latest entry is below the threshold;
   *   - it has an entry at or above the threshold at all (`last_high IS NOT NULL`) — a
   *     wallet that never held the threshold did not FALL below it; and
   *   - no alert has been recorded for it at or after that last high point.
   *
   * The crossing is the entry right after the last high point. The third condition is what
   * makes an idle pass silent: a wallet that stayed low has an alert newer than its last
   * high, and is not returned at all. A threshold an operator raises later can produce a
   * new last-high point and so a new crossing — a genuinely different fact, told once.
   *
   * The alert comparison is on `(crossed_at, crossing_entry_id)` against the high entry's
   * `(created_at, id)`: the same total order the window uses, so entries written in one
   * transaction (one `created_at`) are still ordered by their UUIDv7 ids.
   */
  async listCrossings(
    scope: TenantContext,
    wallet: { readonly currency: CurrencyCode; readonly threshold: bigint },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly WalletCrossing[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      WITH running AS (
        SELECT e.customer_id, e.id, e.created_at, e.reason,
               SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
                 OVER w AS after_entry,
               ROW_NUMBER() OVER w AS pos
        FROM wallet_entries e
        WHERE e.tenant_id = ${tenantId} AND e.currency = ${wallet.currency}
        WINDOW w AS (PARTITION BY e.customer_id ORDER BY e.created_at, e.id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ),
      summary AS (
        SELECT customer_id,
               MAX(pos) AS last_pos,
               MAX(pos) FILTER (WHERE after_entry >= ${wallet.threshold}) AS last_high
        FROM running
        GROUP BY customer_id
      )
      SELECT s.customer_id, crossing.id AS crossing_entry_id,
             crossing.created_at AS crossed_at
      FROM summary s
      JOIN running latest ON latest.customer_id = s.customer_id AND latest.pos = s.last_pos
      JOIN running high ON high.customer_id = s.customer_id AND high.pos = s.last_high
      JOIN running crossing
        ON crossing.customer_id = s.customer_id AND crossing.pos = s.last_high + 1
      WHERE s.last_high IS NOT NULL
        AND latest.after_entry < ${wallet.threshold}
        -- Customer 360: a balance moved out by an account transfer is not a customer
        -- running low; the account it moved to is the one they use now.
        AND crossing.reason <> 'ACCOUNT_TRANSFER_OUT'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_threshold_alerts a
          WHERE a.tenant_id = ${tenantId}
            AND a.customer_id = s.customer_id
            AND a.currency = ${wallet.currency}
            AND (a.crossed_at, a.crossing_entry_id) >= (high.created_at, high.id)
        )
      ORDER BY crossing.created_at ASC, crossing.id ASC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as Row[]).map((row) => ({
      customerId: row.customer_id as UserId,
      crossingEntryId: row.crossing_entry_id,
      crossedAt: row.crossed_at,
    }));
  }

  /**
   * `ON CONFLICT DO NOTHING` on `wallet_threshold_alerts_crossing_key`: a row back means
   * this call recorded the crossing and owes the customer a message; nothing back means
   * another writer already did.
   *
   * `crossed_at` is cast back from the text the read returned, never through a `Date`,
   * for the microsecond reason `ServiceReminderBasis` gives: a millisecond-truncated copy
   * would sort BEFORE the entry it names and the arm test would never see this alert.
   */
  async raise(
    scope: TenantContext,
    alert: {
      readonly id: string;
      readonly customerId: UserId;
      readonly currency: CurrencyCode;
      readonly threshold: bigint;
      readonly crossingEntryId: string;
      readonly crossedAt: string;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx).execute(sql`
      INSERT INTO wallet_threshold_alerts (id, tenant_id, customer_id, currency,
                                           threshold_amount, crossing_entry_id, crossed_at,
                                           raised_at)
      VALUES (${alert.id}, ${tenantId}, ${alert.customerId}, ${alert.currency},
              ${alert.threshold}, ${alert.crossingEntryId}, ${alert.crossedAt}::timestamptz,
              ${now})
      ON CONFLICT (tenant_id, crossing_entry_id) DO NOTHING
      RETURNING id
    `);
    return inserted.rows.length > 0;
  }
}
