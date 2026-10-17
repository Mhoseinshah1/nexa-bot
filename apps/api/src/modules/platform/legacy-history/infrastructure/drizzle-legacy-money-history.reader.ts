import { sql, type SQL } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  LEGACY_AMOUNT_PATTERN,
  type AmountGroup,
  type CustomerOpeningEvidence,
  type PaymentGroup,
  type StatedImportTotals,
  type StatusGroup,
  type TenantMoneyInput,
  type WalletTransactionGroup,
  type WheelGroup,
} from '../application/money-reconciliation.js';
import type {
  CustomerMoneyFacts,
  LegacyMoneyHistoryReader,
} from '../application/legacy-money-history.service.js';

/**
 * Mirza `.nxpkg` importer — the money history's aggregates, READ ONLY.
 *
 * Every statement runs inside one `REPEATABLE READ, READ ONLY` transaction: PostgreSQL itself
 * refuses any write, so this reader cannot become a second writer of the ledger, a payment,
 * an order or a debt even by mistake. It SELECTs grouped codes, counts and sums (as decimal
 * text, read into `bigint`); the pure `money-reconciliation.ts` decides what they mean.
 *
 * Reads, and nothing else: `legacy_history_records` (the archive), the ledger's
 * `MIGRATION_OPENING_BALANCE` entries, the legacy debt rows and the import's own stated totals.
 */

const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

type Q = Pick<Executor, 'execute'>;

interface CustomerRef {
  readonly id: string;
  readonly telegramUserId: string;
}

/** Constant JSON paths only (never a caller value): `payload #>> '{a,b}'`. */
function at(path: string): SQL {
  if (!/^[a-z_]+(,[a-z_]+)*$/u.test(path)) throw new Error('bad json path');
  return sql.raw(`h.payload #>> '{${path}}'`);
}

const big = (value: unknown): bigint => BigInt(String(value ?? '0'));
const int = (value: unknown): number => Number(value ?? 0);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export class DrizzleLegacyMoneyHistoryReader implements LegacyMoneyHistoryReader {
  constructor(private readonly db: Pick<Database, 'transaction'>) {}

  async forCustomer(scope: TenantContext, customer: CustomerRef): Promise<CustomerMoneyFacts> {
    const tenantId = requireTenantId(scope);
    return this.db.transaction(async (q) => {
      const of = sql`(h.customer_id = ${customer.id}::uuid
        OR (h.customer_id IS NULL AND h.legacy_user_id = ${customer.telegramUserId}))`;
      const [referrer] = await rows<{ n: number; gifts: number }>(
        q,
        sql`SELECT count(*)::int AS n,
                   count(*) FILTER (WHERE h.payload ->> 'referrer_gift_paid' = 'true')::int AS gifts
              FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'referral'
               AND ${at('referrer,telegram_user_id')} = ${customer.telegramUserId}`,
      );
      const evidence = await this.openingEvidence(q, tenantId, customer);
      return {
        payments: await this.payments(q, tenantId, of),
        walletTransactions: await this.walletTransactions(q, tenantId, of),
        wheel: await this.wheel(q, tenantId, of),
        serviceOperations: await this.serviceOperations(q, tenantId, of),
        referrals: {
          asReferee: await this.count(q, tenantId, 'referral', of),
          asReferrer: int(referrer?.n),
          referrerGiftsPaid: int(referrer?.gifts),
        },
        discountsUsed: await this.count(q, tenantId, 'discount_usage', of),
        opening: evidence[0] ?? EMPTY_EVIDENCE,
      };
    }, SNAPSHOT);
  }

  /**
   * The tenant-wide aggregates. Slow on a large archive (a scan per record type), which is why
   * it is a CLI and not a request: `statementTimeoutMs` raises the limit for this transaction.
   */
  async forTenant(scope: TenantContext, statementTimeoutMs: number): Promise<TenantMoneyInput> {
    const tenantId = requireTenantId(scope);
    return this.db.transaction(async (q) => {
      const timeout = Math.max(1_000, Math.trunc(statementTimeoutMs));
      await q.execute(sql.raw(`SET LOCAL statement_timeout = ${String(timeout)}`));
      const all = sql`TRUE`;
      const [referrals] = await rows<{ n: number; gifts: number }>(
        q,
        sql`SELECT count(*)::int AS n,
                   count(*) FILTER (WHERE h.payload ->> 'referrer_gift_paid' = 'true')::int AS gifts
              FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'referral'`,
      );
      const [unlinked] = await rows<{ n: number }>(
        q,
        sql`SELECT count(*)::int AS n FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'wallet_history_check'
               AND h.customer_id IS NULL`,
      );
      const stated = await rows<Record<string, unknown>>(
        q,
        sql`SELECT dry_run_report #>> '{wallets,customers}' AS wc,
                   dry_run_report #>> '{wallets,afterTotalMinor}' AS wa,
                   dry_run_report #>> '{wallets,beforeTotalMinor}' AS wb,
                   dry_run_report #>> '{wallets,currency}' AS wcur,
                   dry_run_report #>> '{debts,count}' AS dc,
                   dry_run_report #>> '{debts,totalMinor}' AS dt,
                   dry_run_report #>> '{debts,currency}' AS dcur
              FROM legacy_nxpkg_imports
             WHERE tenant_id = ${tenantId}::uuid AND status = 'COMPLETED'`,
      );
      const reasons = await rows<{ reason: string; n: number }>(
        q,
        sql`SELECT reason, count(*)::int AS n FROM wallet_entries
             WHERE tenant_id = ${tenantId}::uuid GROUP BY reason`,
      );
      return {
        customers: await this.openingEvidence(q, tenantId, null),
        unlinkedChecks: int(unlinked?.n),
        stated: stated.map(statedOf),
        payments: await this.payments(q, tenantId, all),
        walletTransactions: await this.walletTransactions(q, tenantId, all),
        wheel: await this.wheel(q, tenantId, all),
        serviceOperations: await this.serviceOperations(q, tenantId, all),
        referrals: { records: int(referrals?.n), referrerGiftsPaid: int(referrals?.gifts) },
        discountsUsed: await this.count(q, tenantId, 'discount_usage', all),
        ledgerReasons: reasons.map((r) => ({ reason: r.reason, count: int(r.n) })),
      };
    }, SNAPSHOT);
  }

  private async count(q: Q, tenantId: string, type: string, of: SQL): Promise<number> {
    const [row] = await rows<{ n: number }>(
      q,
      sql`SELECT count(*)::int AS n FROM legacy_history_records h
           WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = ${type} AND ${of}`,
    );
    return int(row?.n);
  }

  /** `count`, readable `sum` and `unparsed` of one amount path, grouped by `keys`. */
  private async amountGroups(
    q: Q,
    tenantId: string,
    type: string,
    of: SQL,
    keys: Readonly<Record<string, SQL>>,
    amountPath: string,
    currencyPath: string,
  ): Promise<(AmountGroup & Record<string, unknown>)[]> {
    const names = Object.keys(keys);
    const select = sql.join(
      [
        ...names.map((name) => sql`${keys[name]} AS ${sql.identifier(name)}`),
        sql`${at(currencyPath)} AS currency`,
      ],
      sql`, `,
    );
    const groupBy = sql.raw(
      Array.from({ length: names.length + 1 }, (_, i) => String(i + 1)).join(', '),
    );
    const amount = at(amountPath);
    const found = await rows<Record<string, unknown>>(
      q,
      sql`SELECT ${select},
                 count(*)::int AS n,
                 COALESCE(sum(CASE WHEN ${amount} ~ ${LEGACY_AMOUNT_PATTERN}
                                   THEN (${amount})::numeric END), 0)::text AS total,
                 count(*) FILTER (WHERE (${amount} ~ ${LEGACY_AMOUNT_PATTERN}) IS NOT TRUE)::int AS unparsed
            FROM legacy_history_records h
           WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = ${type} AND ${of}
           GROUP BY ${groupBy}`,
    );
    return found.map((row) => ({
      ...row,
      currency: str(row['currency']),
      count: int(row['n']),
      sumMinor: big(row['total']),
      unparsed: int(row['unparsed']),
    }));
  }

  private async payments(q: Q, tenantId: string, of: SQL): Promise<PaymentGroup[]> {
    const groups = await this.amountGroups(
      q,
      tenantId,
      'payment',
      of,
      {
        outcome: at('status,outcome'),
        method: at('method,normalized'),
        purpose: at('purpose,normalized'),
      },
      'amount,amount_minor',
      'amount,currency',
    );
    return groups.map((g) => ({
      currency: g.currency,
      count: g.count,
      sumMinor: g.sumMinor,
      unparsed: g.unparsed,
      outcome: str(g['outcome']),
      method: str(g['method']),
      purpose: str(g['purpose']),
    }));
  }

  private async wheel(q: Q, tenantId: string, of: SQL): Promise<WheelGroup[]> {
    const groups = await this.amountGroups(
      q,
      tenantId,
      'wheel_result',
      of,
      { won: sql.raw(`h.payload ->> 'won'`) },
      'prize,amount_minor',
      'prize,currency',
    );
    return groups.map((g) => ({
      currency: g.currency,
      count: g.count,
      sumMinor: g.sumMinor,
      unparsed: g.unparsed,
      won: g['won'] === 'true' ? true : g['won'] === 'false' ? false : null,
    }));
  }

  private async serviceOperations(q: Q, tenantId: string, of: SQL): Promise<StatusGroup[]> {
    const groups = await this.amountGroups(
      q,
      tenantId,
      'service_operation',
      of,
      { status: at('status,normalized') },
      'amount,amount_minor',
      'amount,currency',
    );
    return groups.map((g) => ({
      currency: g.currency,
      count: g.count,
      sumMinor: g.sumMinor,
      unparsed: g.unparsed,
      status: str(g['status']),
    }));
  }

  private async walletTransactions(
    q: Q,
    tenantId: string,
    of: SQL,
  ): Promise<WalletTransactionGroup[]> {
    const value = at('amount,value_minor');
    const found = await rows<Record<string, unknown>>(
      q,
      sql`WITH x AS (
            SELECT ${at('amount,currency')} AS currency,
                   CASE WHEN ${value} ~ ${LEGACY_AMOUNT_PATTERN} THEN (${value})::numeric END AS v
              FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'wallet_transaction' AND ${of})
          SELECT currency,
                 count(*) FILTER (WHERE v > 0)::int AS in_n,
                 COALESCE(sum(v) FILTER (WHERE v > 0), 0)::text AS in_sum,
                 count(*) FILTER (WHERE v < 0)::int AS out_n,
                 COALESCE(sum(v) FILTER (WHERE v < 0), 0)::text AS out_sum,
                 count(*) FILTER (WHERE v = 0)::int AS zero_n,
                 count(*) FILTER (WHERE v IS NULL)::int AS unparsed
            FROM x GROUP BY currency`,
    );
    return found.map((row) => ({
      currency: str(row['currency']),
      inCount: int(row['in_n']),
      inSumMinor: big(row['in_sum']),
      outCount: int(row['out_n']),
      outSumMinor: big(row['out_sum']),
      zeroCount: int(row['zero_n']),
      unparsed: int(row['unparsed']),
    }));
  }

  /**
   * Per customer: the opening CREDIT(s), any non-credit opening entry, whether every opening
   * reference names the customer's own Telegram id, the legacy debt, and the converter's
   * wallet-history check(s) and difference analysis. `customer` null reads every customer
   * with any of them (checks linked to no customer are counted apart by the caller).
   */
  private async openingEvidence(
    q: Q,
    tenantId: string,
    customer: CustomerRef | null,
  ): Promise<CustomerOpeningEvidence[]> {
    const entryOf = customer === null ? sql`TRUE` : sql`w.customer_id = ${customer.id}::uuid`;
    const debtOf =
      customer === null
        ? sql`d.customer_id IS NOT NULL`
        : sql`d.customer_id = ${customer.id}::uuid`;
    const recordOf =
      customer === null
        ? sql`h.customer_id IS NOT NULL`
        : sql`(h.customer_id = ${customer.id}::uuid
            OR (h.customer_id IS NULL AND h.legacy_user_id = ${customer.telegramUserId}))`;
    // In the per-customer read every record is this customer's; tenant-wide, by its link.
    const key = customer === null ? sql`h.customer_id` : sql`${customer.id}::uuid`;
    const found = await rows<Record<string, unknown>>(
      q,
      sql`WITH o AS (
            SELECT w.customer_id AS cid,
                   COALESCE(json_agg(json_build_object('a', w.amount::text, 'c', w.currency))
                            FILTER (WHERE w.direction = 'CREDIT'), '[]'::json) AS credits,
                   count(*) FILTER (WHERE w.direction <> 'CREDIT')::int AS non_credit,
                   bool_and(c.telegram_user_id IS NOT NULL
                            AND w.reference = 'legacy:opening:' || c.telegram_user_id) AS ref_ok
              FROM wallet_entries w
              LEFT JOIN customers c ON c.tenant_id = w.tenant_id AND c.id = w.customer_id
             WHERE w.tenant_id = ${tenantId}::uuid AND w.reason = 'MIGRATION_OPENING_BALANCE' AND ${entryOf}
             GROUP BY w.customer_id),
          d AS (
            SELECT d.customer_id AS cid, d.amount_minor::text AS a, d.currency AS c, d.state
              FROM legacy_wallet_debts d
             WHERE d.tenant_id = ${tenantId}::uuid AND ${debtOf}),
          k AS (
            SELECT ${key} AS cid,
                   json_agg(json_build_object(
                     'v', h.payload ->> 'verdict',
                     's', ${at('snapshot_balance,amount_minor')},
                     'sc', ${at('snapshot_balance,currency')},
                     'h', ${at('history_last_balance_after,amount_minor')},
                     'hc', ${at('history_last_balance_after,currency')},
                     'd', h.payload ->> 'delta_snapshot_minus_history_minor')) AS checks
              FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'wallet_history_check' AND ${recordOf}
             GROUP BY 1),
          f AS (
            SELECT ${key} AS cid,
                   json_agg(json_build_object('cause', h.payload ->> 'cause',
                                              'certainty', h.payload ->> 'certainty')) AS diffs
              FROM legacy_history_records h
             WHERE h.tenant_id = ${tenantId}::uuid AND h.record_type = 'wallet_difference' AND ${recordOf}
             GROUP BY 1),
          ids AS (SELECT cid FROM o UNION SELECT cid FROM d UNION SELECT cid FROM k)
          SELECT o.credits, o.non_credit, o.ref_ok, d.a AS debt_a, d.c AS debt_c, d.state AS debt_state,
                 k.checks, f.diffs
            FROM ids
            LEFT JOIN o ON o.cid = ids.cid
            LEFT JOIN d ON d.cid = ids.cid
            LEFT JOIN k ON k.cid = ids.cid
            LEFT JOIN f ON f.cid = ids.cid`,
    );
    return found.map(evidenceOf);
  }
}

const EMPTY_EVIDENCE: CustomerOpeningEvidence = {
  openingCredits: [],
  openingNonCredits: 0,
  openingReferenceMatches: null,
  debt: null,
  checks: [],
  differences: [],
};

async function rows<T>(q: Q, query: SQL): Promise<T[]> {
  return (await q.execute(query)).rows as unknown as T[];
}

function jsonArray(value: unknown): Record<string, unknown>[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

function evidenceOf(row: Record<string, unknown>): CustomerOpeningEvidence {
  const debtA = str(row['debt_a']);
  return {
    openingCredits: jsonArray(row['credits']).map((c) => ({
      amountMinor: big(c['a']),
      currency: String(c['c']),
    })),
    openingNonCredits: int(row['non_credit']),
    openingReferenceMatches: typeof row['ref_ok'] === 'boolean' ? row['ref_ok'] : null,
    debt:
      debtA === null
        ? null
        : {
            amountMinor: big(debtA),
            currency: String(row['debt_c']),
            state: String(row['debt_state']),
          },
    checks: jsonArray(row['checks']).map((c) => ({
      verdict: str(c['v']),
      snapshotMinor: str(c['s']),
      snapshotCurrency: str(c['sc']),
      historyLastMinor: str(c['h']),
      historyLastCurrency: str(c['hc']),
      deltaMinor: str(c['d']),
    })),
    differences: jsonArray(row['diffs']).map((c) => ({
      cause: str(c['cause']),
      certainty: str(c['certainty']),
    })),
  };
}

function statedOf(row: Record<string, unknown>): StatedImportTotals {
  return {
    walletCustomers: row['wc'] === null ? null : int(row['wc']),
    walletAfterTotalMinor: str(row['wa']),
    walletBeforeTotalMinor: str(row['wb']),
    walletCurrency: str(row['wcur']),
    debtCount: row['dc'] === null ? null : int(row['dc']),
    debtTotalMinor: str(row['dt']),
    debtCurrency: str(row['dcur']),
  };
}
