import { sql } from 'drizzle-orm';
import type { CurrencyCode, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  summarizeCompactionDay,
  type NightlyReportData,
  type PanelDayFact,
  type Tally,
} from '../application/nightly-report.js';
import type { NightlyReportReader, NightlyReportWindow } from '../application/ports.js';

type Row = Record<string, unknown>;
const big = (value: unknown): bigint =>
  BigInt(typeof value === 'string' ? value : String(value ?? 0));
const num = (value: unknown): number => Number(value ?? 0);
const NONE: Tally = { count: 0, sum: 0n };

/**
 * The nightly reports' numbers (Round 4 PR-D), read from the ledger and the orders over one
 * half-open window `[start, end)` the time resolver produced.
 *
 * Read-only, one query per figure, each naming the tenant, the installation's selling
 * currency and the NEXA provenance — a row the import wrote is history and is never a day's
 * sale. Nothing is cached and nothing is estimated.
 */
export class DrizzleNightlyReportReader implements NightlyReportReader {
  constructor(private readonly db: Database) {}

  private exec(tx: TransactionScope): Executor {
    return tx.tx ?? this.db;
  }

  private async rows(tx: TransactionScope, query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.exec(tx).execute(query)).rows as Row[];
  }

  async alreadyPosted(
    scope: TenantContext,
    dedupeKey: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const found = await this.rows(
      tx,
      sql`SELECT 1 FROM notifications WHERE tenant_id = ${tenantId} AND dedupe_key = ${dedupeKey} LIMIT 1`,
    );
    return found.length > 0;
  }

  async read(
    scope: TenantContext,
    window: NightlyReportWindow,
    tx: TransactionScope,
  ): Promise<Omit<NightlyReportData, 'day'>> {
    const tenantId = requireTenantId(scope);
    const { start, end, previousStart, previousEnd, currency, timezone } = window;

    // --- orders, by what they were for ------------------------------------------------
    const byPurpose = await this.rows(
      tx,
      sql`SELECT purpose, count(*)::int AS n, COALESCE(sum(total_amount), 0)::text AS s
            FROM orders
           WHERE tenant_id = ${tenantId} AND origin = 'STANDARD' AND source = 'NEXA'
             AND currency = ${currency} AND purpose <> 'TRIAL'
             AND settled_at >= ${start} AND settled_at < ${end}
           GROUP BY purpose`,
    );
    const tally = (...purposes: string[]): Tally =>
      byPurpose
        .filter((row) => purposes.includes(String(row['purpose'])))
        .reduce<Tally>(
          (total, row) => ({ count: total.count + num(row['n']), sum: total.sum + big(row['s']) }),
          NONE,
        );
    const known = ['NEW_SERVICE', 'CUSTOM_SERVICE', 'RENEW', 'ADD_TRAFFIC', 'ADD_TIME'];
    const other = byPurpose
      .filter((row) => !known.includes(String(row['purpose'])))
      .reduce<Tally>(
        (total, row) => ({ count: total.count + num(row['n']), sum: total.sum + big(row['s']) }),
        NONE,
      );

    const [first] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM orders o
           WHERE o.tenant_id = ${tenantId} AND o.origin = 'STANDARD' AND o.source = 'NEXA'
             AND o.currency = ${currency}
             AND o.purpose IN ('NEW_SERVICE', 'CUSTOM_SERVICE')
             AND o.settled_at >= ${start} AND o.settled_at < ${end}
             AND NOT EXISTS (
               SELECT 1 FROM orders e
                WHERE e.tenant_id = o.tenant_id AND e.customer_id = o.customer_id
                  AND e.id <> o.id AND e.origin = 'STANDARD'
                  AND e.purpose IN ('NEW_SERVICE', 'CUSTOM_SERVICE')
                  AND e.settled_at IS NOT NULL
                  AND (e.settled_at, e.id) < (o.settled_at, o.id))`,
    );
    const [previous] = await this.rows(
      tx,
      sql`SELECT COALESCE(sum(total_amount), 0)::text AS s FROM orders
           WHERE tenant_id = ${tenantId} AND origin = 'STANDARD' AND source = 'NEXA'
             AND currency = ${currency} AND purpose <> 'TRIAL'
             AND settled_at >= ${previousStart} AND settled_at < ${previousEnd}`,
    );
    const [best] = await this.rows(
      tx,
      sql`SELECT EXTRACT(HOUR FROM settled_at AT TIME ZONE ${timezone})::int AS h,
                 sum(total_amount) AS s
            FROM orders
           WHERE tenant_id = ${tenantId} AND origin = 'STANDARD' AND source = 'NEXA'
             AND currency = ${currency} AND purpose <> 'TRIAL' AND total_amount > 0
             AND settled_at >= ${start} AND settled_at < ${end}
           GROUP BY 1 ORDER BY sum(total_amount) DESC, 1 ASC LIMIT 1`,
    );
    const [trials] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM orders
           WHERE tenant_id = ${tenantId} AND origin = 'STANDARD' AND source = 'NEXA'
             AND purpose = 'TRIAL' AND state = 'PAID'
             AND settled_at >= ${start} AND settled_at < ${end}`,
    );

    // --- customers, services, the day's trouble ---------------------------------------
    const [created] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM customers
           WHERE tenant_id = ${tenantId} AND source = 'NEXA'
             AND created_at >= ${start} AND created_at < ${end}`,
    );
    const [active] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM customers
           WHERE tenant_id = ${tenantId} AND source = 'NEXA'
             AND last_seen_at >= ${start} AND last_seen_at < ${end}`,
    );
    const [services] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM services
           WHERE tenant_id = ${tenantId} AND source = 'NEXA' AND state = 'ACTIVE'`,
    );
    const [errors] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM operational_events
           WHERE tenant_id = ${tenantId} AND severity IN ('ERROR', 'CRITICAL')
             AND first_seen_at >= ${start} AND first_seen_at < ${end}`,
    );
    const [failed] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM payments
           WHERE tenant_id = ${tenantId} AND source = 'NEXA' AND state = 'FAILED'
             AND COALESCE(resolved_at, updated_at) >= ${start}
             AND COALESCE(resolved_at, updated_at) < ${end}`,
    );
    const [tickets] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM tickets
           WHERE tenant_id = ${tenantId} AND status <> 'CLOSED'`,
    );
    const [expired] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM payments
           WHERE tenant_id = ${tenantId} AND source = 'NEXA' AND state = 'EXPIRED'
             AND COALESCE(resolved_at, updated_at) >= ${start}
             AND COALESCE(resolved_at, updated_at) < ${end}`,
    );

    // --- Round 9 C3: the data compaction's passes of the day (part of L30) -------------
    const compactionRuns = await this.rows(
      tx,
      sql`SELECT mode, counts FROM data_compaction_runs
           WHERE tenant_id = ${tenantId} AND started_at >= ${start} AND started_at < ${end}
           ORDER BY started_at, id`,
    );
    const compaction = summarizeCompactionDay(
      compactionRuns.map((row) => ({
        mode: row['mode'] === 'APPLY' ? 'APPLY' : 'DRY_RUN',
        counts: (row['counts'] ?? {}) as Record<string, number>,
      })),
    );

    // --- refunds, commissions, gifts -------------------------------------------------
    const ledger = async (reason: string, direction: 'CREDIT' | 'DEBIT'): Promise<Tally> => {
      const [row] = await this.rows(
        tx,
        sql`SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS s FROM wallet_entries
             WHERE tenant_id = ${tenantId} AND direction = ${direction} AND reason = ${reason}
               AND currency = ${currency}
               AND created_at >= ${start} AND created_at < ${end}`,
      );
      return { count: num(row?.['n']), sum: big(row?.['s']) };
    };
    /*
     * REFUNDS are the refunds COMPLETED in the day, on EVERY channel, counted once each from
     * the refund rows themselves (money review of #301). The wallet's REFUND credits are only
     * the WALLET_CREDIT channel: a bank transfer back (EXTERNAL_MANUAL) or a provider refund
     * writes no wallet entry and was missing from the net, and a refund row per refund is
     * what keeps one refund from being counted twice. Day by `completed_at`, the moment the
     * money left; only the selling currency.
     */
    const [refundRow] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS s FROM refunds
           WHERE tenant_id = ${tenantId} AND state = 'COMPLETED' AND currency = ${currency}
             AND completed_at >= ${start} AND completed_at < ${end}`,
    );
    const refunds: Tally = { count: num(refundRow?.['n']), sum: big(refundRow?.['s']) };
    /*
     * COMMISSIONS are what the day's commissions COST: the credits less the day's reversals
     * (a refunded order takes its commission back, `REFERRAL_COMMISSION_REVERSAL`), never
     * below zero — a day of reversals is not income. The count is the credits'.
     */
    const credited = await ledger('REFERRAL_COMMISSION', 'CREDIT');
    const reversed = await ledger('REFERRAL_COMMISSION_REVERSAL', 'DEBIT');
    const commissions: Tally = {
      count: credited.count,
      sum: credited.sum > reversed.sum ? credited.sum - reversed.sum : 0n,
    };
    const gifts = await ledger('CASHBACK_TOPUP', 'CREDIT');

    // --- payment methods ---------------------------------------------------------------
    const methods = await this.rows(
      tx,
      sql`SELECT COALESCE(gateway_provider, method) AS key, sum(amount)::text AS s
            FROM payments
           WHERE tenant_id = ${tenantId} AND source = 'NEXA' AND state = 'CONFIRMED'
             AND order_id IS NOT NULL AND currency = ${currency}
             AND confirmed_at >= ${start} AND confirmed_at < ${end}
           GROUP BY 1`,
    );

    // --- panels ------------------------------------------------------------------------
    const panelRows = await this.rows(
      tx,
      sql`SELECT p.name AS name,
                 COALESCE(h.state, 'UNCHECKED') AS health,
                 p.max_services AS cap,
                 (SELECT count(*)::int FROM services s
                   WHERE s.tenant_id = p.tenant_id AND s.panel_id = p.id AND s.state <> 'TERMINATED') AS used,
                 COALESCE(o.n, 0) AS orders, COALESCE(o.s, 0)::text AS sales,
                 COALESCE(o.bytes, 0)::text AS bytes
            FROM panels p
            LEFT JOIN panel_health h ON h.tenant_id = p.tenant_id AND h.panel_id = p.id
            LEFT JOIN (
              SELECT panel_id, count(*)::int AS n, sum(total_amount) AS s,
                     sum(CASE WHEN purpose IN ('NEW_SERVICE', 'CUSTOM_SERVICE', 'RENEW', 'ADD_TRAFFIC')
                              THEN line_traffic_bytes ELSE 0 END) AS bytes
                FROM orders
               WHERE tenant_id = ${tenantId} AND origin = 'STANDARD' AND source = 'NEXA'
                 AND currency = ${currency} AND purpose <> 'TRIAL'
                 AND settled_at >= ${start} AND settled_at < ${end}
               GROUP BY panel_id) o ON o.panel_id = p.id
           WHERE p.tenant_id = ${tenantId}
           ORDER BY COALESCE(o.s, 0) DESC, p.name`,
    );
    const panels: PanelDayFact[] = panelRows.map((row) => ({
      name: String(row['name']),
      orders: num(row['orders']),
      sum: big(row['sales']),
      soldBytes: big(row['bytes']),
      health: String(row['health']),
      used: num(row['used']),
      capacity: row['cap'] === null || row['cap'] === undefined ? null : num(row['cap']),
    }));

    // --- resellers ---------------------------------------------------------------------
    const [activeResellers] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM resellers
           WHERE tenant_id = ${tenantId} AND status = 'ACTIVE' AND source = 'NEXA'`,
    );
    // The resellers' sales, summed in SQL over every reseller order of the day — never over a
    // capped list of resellers, which would drop the tail from the total (money review of
    // #301) — and the one top reseller beside it, by the same predicate.
    const [resellerTotal] = await this.rows(
      tx,
      sql`SELECT COALESCE(sum(o.total_amount), 0)::text AS s
            FROM order_reseller_terms t
            JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
           WHERE t.tenant_id = ${tenantId} AND o.origin = 'STANDARD' AND o.source = 'NEXA'
             AND o.currency = ${currency} AND o.purpose <> 'TRIAL'
             AND o.settled_at >= ${start} AND o.settled_at < ${end}`,
    );
    const [topRow] = await this.rows(
      tx,
      sql`SELECT c.username AS username, c.first_name AS first_name, c.last_name AS last_name,
                 c.telegram_user_id AS telegram_id, sum(o.total_amount)::text AS s
            FROM order_reseller_terms t
            JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
            JOIN customers c ON c.tenant_id = t.tenant_id AND c.id = t.reseller_customer_id
           WHERE t.tenant_id = ${tenantId} AND o.origin = 'STANDARD' AND o.source = 'NEXA'
             AND o.currency = ${currency} AND o.purpose <> 'TRIAL'
             AND o.settled_at >= ${start} AND o.settled_at < ${end}
           GROUP BY c.id, c.username, c.first_name, c.last_name, c.telegram_user_id
           ORDER BY sum(o.total_amount) DESC, c.telegram_user_id LIMIT 1`,
    );
    const salesSum = big(resellerTotal?.['s']);

    return {
      currency: currency as CurrencyCode,
      newPurchases: tally('NEW_SERVICE', 'CUSTOM_SERVICE'),
      firstPurchases: num(first?.['n']),
      renewals: tally('RENEW'),
      traffic: tally('ADD_TRAFFIC'),
      time: tally('ADD_TIME'),
      other,
      previousGross: big(previous?.['s']),
      bestHour: best === undefined ? null : num(best['h']),
      newCustomers: num(created?.['n']),
      activeCustomers: num(active?.['n']),
      trials: num(trials?.['n']),
      activeServices: num(services?.['n']),
      errors: num(errors?.['n']),
      failedPayments: num(failed?.['n']),
      openTickets: num(tickets?.['n']),
      expiredPayments: num(expired?.['n']),
      compaction,
      refunds,
      commissions,
      giftSum: gifts.sum,
      methods: methods.map((row) => ({ key: String(row['key']), sum: big(row['s']) })),
      panels,
      resellers: {
        active: num(activeResellers?.['n']),
        salesSum,
        top:
          topRow === undefined
            ? null
            : {
                username: typeof topRow['username'] === 'string' ? topRow['username'] : null,
                name:
                  [topRow['first_name'], topRow['last_name']]
                    .filter((part): part is string => typeof part === 'string' && part !== '')
                    .join(' ') || String(topRow['telegram_id']),
                sum: big(topRow['s']),
              },
      },
    };
  }
}
