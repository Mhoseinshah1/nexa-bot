import { sql } from 'drizzle-orm';
import { money, type Calendar, type CurrencyCode, type TemplateValues } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { TenantMonthlyPeriods } from '../../../../infrastructure/time/monthly-period.js';
import { resellerSalesStatement } from '../../reporting/infrastructure/drizzle-reporting.repository.js';

/**
 * What the two monthly-minimum notifications render, and whether the reminder still holds,
 * read at send time from the `reseller_minimum_notices` row the notification names
 * (round N R2, `docs/round-n-reseller-audit.md` §3.4).
 *
 * A READER, not a payload (ADR 0030 §1): the producer enqueued a kind and a notice id; the
 * minimum is the one the notice recorded, and the sales figure is the reports' own
 * `resellerSalesStatement` over the notice's month — the `WALLET_LOW_BALANCE` shape, whose
 * balance is re-derived from the ledger at send time. Read-only by construction.
 */

interface NoticeRow {
  customer_id: string;
  kind: string;
  period_start: string;
  period_end: string;
  minimum_amount: string;
  currency: string;
  achieved_amount: string;
  status: string;
  tier_minimum_amount: string | null;
  tier_minimum_currency: string | null;
  own_minimum_amount: string | null;
  own_minimum_currency: string | null;
  display_timezone: string;
  calendar: string;
}

async function noticeOf(db: Database, tenantId: string, id: string): Promise<NoticeRow | null> {
  const result = await db.execute(sql`
    SELECT n.customer_id, n.kind, n.period_start, n.period_end, n.minimum_amount::text,
           n.currency, n.achieved_amount::text, r.status,
           tr.monthly_minimum_amount::text AS tier_minimum_amount,
           tr.monthly_minimum_currency AS tier_minimum_currency,
           r.monthly_minimum_amount::text AS own_minimum_amount,
           r.monthly_minimum_currency AS own_minimum_currency,
           t.display_timezone, t.calendar
      FROM reseller_minimum_notices n
      JOIN resellers r ON r.tenant_id = n.tenant_id AND r.customer_id = n.customer_id
      JOIN reseller_tiers tr ON tr.tenant_id = r.tenant_id AND tr.id = r.tier_id
      JOIN tenants t ON t.id = n.tenant_id
     WHERE n.tenant_id = ${tenantId}::uuid AND n.id = ${id}::uuid
     LIMIT 1`);
  return (result.rows[0] as NoticeRow | undefined) ?? null;
}

/** The month's sales in the notice's currency, by the reports' one definition. */
async function salesOf(db: Database, tenantId: string, notice: NoticeRow): Promise<bigint> {
  const result = await db.execute(sql`
    SELECT coalesce(sum(s.amount), 0)::text AS amount
      FROM (${resellerSalesStatement(tenantId, {
        from: new Date(notice.period_start),
        to: new Date(notice.period_end),
      })}) s
     WHERE s.reseller_customer_id = ${notice.customer_id}::uuid AND s.currency = ${notice.currency}`);
  const row = result.rows[0] as { amount: string } | undefined;
  return BigInt(row?.amount ?? '0');
}

/**
 * The minimum in force NOW, by `effectiveMonthlyMinimum`'s rule, spelled over the two
 * stored pairs: the reseller's own when set (zero included), else the tier's.
 */
function effectiveNow(notice: NoticeRow): { amount: bigint; currency: string } | null {
  const own =
    notice.own_minimum_amount === null || notice.own_minimum_currency === null
      ? null
      : { amount: BigInt(notice.own_minimum_amount), currency: notice.own_minimum_currency };
  const tier =
    notice.tier_minimum_amount === null || notice.tier_minimum_currency === null
      ? null
      : { amount: BigInt(notice.tier_minimum_amount), currency: notice.tier_minimum_currency };
  const applies = own ?? tier;
  return applies === null || applies.amount <= 0n ? null : applies;
}

const periods = new TenantMonthlyPeriods();

/**
 * `RESELLER_MINIMUM_REMINDER`'s precondition: the reseller is still ACTIVE, the month has
 * not ended, the minimum in force is still the one the notice recorded, and the month's
 * sales are still below it. Any of those false and the reminder is SUPERSEDED unsent: a
 * reseller who reached the minimum, or whose minimum an operator removed, while the message
 * waited is not told they are behind.
 */
export async function resellerMinimumReminderHolds(
  db: Database,
  tenantId: string,
  noticeId: string,
  now: Date,
): Promise<boolean> {
  const notice = await noticeOf(db, tenantId, noticeId);
  if (notice === null || notice.kind !== 'REMINDER') return false;
  if (notice.status !== 'ACTIVE') return false;
  if (now.getTime() >= new Date(notice.period_end).getTime()) return false;
  const minimum = effectiveNow(notice);
  if (
    minimum === null ||
    minimum.amount !== BigInt(notice.minimum_amount) ||
    minimum.currency !== notice.currency
  ) {
    return false;
  }
  return (await salesOf(db, tenantId, notice)) < minimum.amount;
}

/**
 * The values of either notification, or null when the notice is gone (nothing is sent).
 * The reminder renders the LIVE sales and what remains; the achievement renders the figures
 * recorded when it was raised — a fact about that moment, still true later.
 */
export async function resellerMinimumValues(
  db: Database,
  tenantId: string,
  kind: 'RESELLER_MINIMUM_REMINDER' | 'RESELLER_MINIMUM_ACHIEVED',
  noticeId: string,
  now: Date,
): Promise<TemplateValues | null> {
  const notice = await noticeOf(db, tenantId, noticeId);
  if (notice === null) return null;
  const currency = notice.currency as CurrencyCode;
  const minimum = BigInt(notice.minimum_amount);
  if (kind === 'RESELLER_MINIMUM_ACHIEVED') {
    return {
      minimum: money(minimum, currency),
      achievedSales: money(BigInt(notice.achieved_amount), currency),
    };
  }
  const achieved = await salesOf(db, tenantId, notice);
  return {
    minimum: money(minimum, currency),
    achievedSales: money(achieved, currency),
    remainingSales: money(achieved >= minimum ? 0n : minimum - achieved, currency),
    days: periods.daysLeft(now, new Date(notice.period_end), {
      timezone: notice.display_timezone,
      calendar: notice.calendar as Calendar,
    }),
  };
}
