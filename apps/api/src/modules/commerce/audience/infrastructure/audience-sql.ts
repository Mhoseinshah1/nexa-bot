import { sql, type SQL } from 'drizzle-orm';
import { SALE_ORDER_PURPOSES, type AudienceDefinition } from '@nexa/contracts';

/**
 * THE audience query (round N, `docs/round-n-broadcast-audit.md` §3) — one SQL builder that
 * every consumer materialises from: the preview count, a broadcast's frozen recipients, a
 * mass credit's items, a mass grant's services and a campaign's targets. Nothing loads a
 * tenant's customers into Node to filter them; every criterion is a predicate on indexed
 * facts, evaluated by PostgreSQL:
 *
 *   customers            (tenant_id, …)            the row itself, `customers_tenant_created_idx`
 *   resellers            (tenant_id, customer_id)  `resellers_customer_key`
 *   orders               (customer_id, …)          `orders_customer_created_idx`
 *   wallet_entries       (customer_id, …)          `wallet_entries_customer_created_idx`
 *   trial_grants         (tenant_id, customer_id)  `trial_grants_customer_idx` (round N)
 *   referrals            (tenant_id, referee_id) / (referrer_id, …)
 *   services             (customer_id, …)          `services_customer_created_idx`
 *
 * Every relative criterion is computed from `asOf`, a bound parameter, NEVER from the
 * database's `now()`: the same definition evaluated twice at the same instant selects the
 * same set, which is what lets a preview and a launch be compared at all.
 *
 * Tenant isolation: every subquery joins on `tenant_id = c.tenant_id` AND the outer query
 * binds `c.tenant_id` to the caller's tenant, so no criterion can reach another tenant's rows
 * even through an id an operator typed.
 */

export interface AudienceEvaluation {
  readonly tenantId: string;
  readonly definition: AudienceDefinition;
  readonly asOf: Date;
  /**
   * Round N close (§D): leave out customers who opted out of promotional broadcasts
   * (`customers.marketing_opt_out_at`). NOT part of the definition and NOT in its hash —
   * it is a fact about the SEND's purpose, which a MARKETING broadcast applies and a
   * service announcement or a gift does not. Applied by the preview and the launch alike,
   * so the count an operator confirmed is the count that is materialised.
   */
  readonly excludeMarketingOptOuts?: boolean;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function instant(value: Date | string): SQL {
  const iso = typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
  return sql`${iso}::timestamptz`;
}

function uuids(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::uuid[]`;
}

function texts(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

/** A PAID sale order of the customer aliased `c`: Nexa's one "purchase" predicate. */
function saleOrderOf(customer: SQL, alias: SQL): SQL {
  return sql`${alias}.tenant_id = ${customer}.tenant_id
         AND ${alias}.customer_id = ${customer}.id
         AND ${alias}.state = 'PAID'
         AND ${alias}.purpose = ANY(${texts(SALE_ORDER_PURPOSES)})`;
}

/**
 * The service block's predicate on a service aliased `s`. Shared by the customer predicate's
 * EXISTS and by the service-targeted query, so "customers with a service on panel X" and "the
 * services on panel X" cannot mean two different things.
 */
export function audienceServicePredicate(
  evaluation: AudienceEvaluation,
  service: SQL = sql`s`,
): SQL {
  const criteria = evaluation.definition.service;
  if (criteria === null) return sql`true`;
  const parts: SQL[] = [];
  if (criteria.productIds.length > 0) {
    parts.push(sql`${service}.product_id = ANY(${uuids(criteria.productIds)})`);
  }
  if (criteria.panelIds.length > 0) {
    parts.push(sql`${service}.panel_id = ANY(${uuids(criteria.panelIds)})`);
  }
  if (criteria.states.length > 0) {
    parts.push(sql`${service}.state = ANY(${texts(criteria.states)})`);
  }
  if (criteria.expiringWithinHours !== null) {
    const until = new Date(evaluation.asOf.getTime() + criteria.expiringWithinHours * HOUR_MS);
    parts.push(
      sql`(${service}.state = 'ACTIVE' AND ${service}.expires_at >= ${instant(evaluation.asOf)}
           AND ${service}.expires_at < ${instant(until)})`,
    );
  }
  if (criteria.expired) {
    parts.push(
      sql`(${service}.state = 'EXPIRED'
           OR (${service}.state = 'ACTIVE' AND ${service}.expires_at <= ${instant(evaluation.asOf)}))`,
    );
  }
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

/**
 * The customer predicate, over a customer aliased `c`, tenant-bound. Every criterion the
 * definition leaves open contributes nothing.
 */
export function audienceCustomerPredicate(
  evaluation: AudienceEvaluation,
  customer: SQL = sql`c`,
): SQL {
  const d = evaluation.definition;
  const c = customer;
  const parts: SQL[] = [sql`${c}.tenant_id = ${evaluation.tenantId}::uuid`];

  if (d.customerIds !== null) parts.push(sql`${c}.id = ANY(${uuids(d.customerIds)})`);

  if (d.customerStatus !== 'ANY') parts.push(sql`${c}.status = ${d.customerStatus}`);

  if (evaluation.excludeMarketingOptOuts === true) {
    parts.push(sql`${c}.marketing_opt_out_at IS NULL`);
  }

  if (d.segment !== null) {
    const branches: SQL[] = [];
    if (d.segment.ordinary) {
      branches.push(sql`NOT EXISTS (
        SELECT 1 FROM resellers r
         WHERE r.tenant_id = ${c}.tenant_id AND r.customer_id = ${c}.id AND r.status = 'ACTIVE')`);
    }
    if (d.segment.resellerTierIds.length > 0) {
      branches.push(sql`EXISTS (
        SELECT 1 FROM resellers r
         WHERE r.tenant_id = ${c}.tenant_id AND r.customer_id = ${c}.id AND r.status = 'ACTIVE'
           AND r.tier_id = ANY(${uuids(d.segment.resellerTierIds)}))`);
    }
    parts.push(sql`(${sql.join(branches, sql` OR `)})`);
  }

  if (d.purchase !== 'ANY') {
    const exists = sql`EXISTS (SELECT 1 FROM orders o WHERE ${saleOrderOf(c, sql`o`)})`;
    parts.push(d.purchase === 'PURCHASED' ? exists : sql`NOT ${exists}`);
  }

  if (d.registeredFrom !== null)
    parts.push(sql`${c}.first_seen_at >= ${instant(d.registeredFrom)}`);
  if (d.registeredBefore !== null) {
    parts.push(sql`${c}.first_seen_at < ${instant(d.registeredBefore)}`);
  }
  // Age in whole days at `asOf`: age >= min  <=>  first_seen <= asOf - min days, and
  // age <= max  <=>  first_seen > asOf - (max + 1) days.
  if (d.accountAgeMinDays !== null) {
    const latest = new Date(evaluation.asOf.getTime() - d.accountAgeMinDays * DAY_MS);
    parts.push(sql`${c}.first_seen_at <= ${instant(latest)}`);
  }
  if (d.accountAgeMaxDays !== null) {
    const earliest = new Date(evaluation.asOf.getTime() - (d.accountAgeMaxDays + 1) * DAY_MS);
    parts.push(sql`${c}.first_seen_at > ${instant(earliest)}`);
  }

  if (d.lastPurchaseFrom !== null || d.lastPurchaseBefore !== null) {
    const last = sql`(SELECT max(o.settled_at) FROM orders o WHERE ${saleOrderOf(c, sql`o`)})`;
    if (d.lastPurchaseFrom !== null) parts.push(sql`${last} >= ${instant(d.lastPurchaseFrom)}`);
    if (d.lastPurchaseBefore !== null) parts.push(sql`${last} < ${instant(d.lastPurchaseBefore)}`);
  }

  if (d.noPurchaseForDays !== null) {
    const since = new Date(evaluation.asOf.getTime() - d.noPurchaseForDays * DAY_MS);
    parts.push(sql`NOT EXISTS (
      SELECT 1 FROM orders o WHERE ${saleOrderOf(c, sql`o`)} AND o.settled_at >= ${instant(since)})`);
  }

  if (d.walletBalance !== null) {
    // Derived from the append-only ledger, in the range's own currency. Never a column.
    const balance = sql`(SELECT coalesce(sum(CASE WHEN w.direction = 'CREDIT' THEN w.amount
                                                  ELSE -w.amount END), 0)
                           FROM wallet_entries w
                          WHERE w.tenant_id = ${c}.tenant_id AND w.customer_id = ${c}.id
                            AND w.currency = ${d.walletBalance.currency})`;
    if (d.walletBalance.minMinor !== null) {
      parts.push(sql`${balance} >= ${d.walletBalance.minMinor}::numeric`);
    }
    if (d.walletBalance.maxMinor !== null) {
      parts.push(sql`${balance} <= ${d.walletBalance.maxMinor}::numeric`);
    }
  }

  if (d.trial !== 'ANY') {
    const used = sql`EXISTS (SELECT 1 FROM trial_grants tg
                              WHERE tg.tenant_id = ${c}.tenant_id AND tg.customer_id = ${c}.id)`;
    parts.push(d.trial === 'USED' ? used : sql`NOT ${used}`);
  }

  if (d.referral !== 'ANY') {
    const referrer = sql`EXISTS (SELECT 1 FROM referrals rf
                                  WHERE rf.tenant_id = ${c}.tenant_id AND rf.referrer_id = ${c}.id)`;
    const referred = sql`EXISTS (SELECT 1 FROM referrals rf
                                  WHERE rf.tenant_id = ${c}.tenant_id AND rf.referee_id = ${c}.id)`;
    switch (d.referral) {
      case 'REFERRER':
        parts.push(referrer);
        break;
      case 'REFERRED':
        parts.push(referred);
        break;
      case 'PARTICIPANT':
        parts.push(sql`(${referrer} OR ${referred})`);
        break;
      case 'NON_PARTICIPANT':
        parts.push(sql`NOT ${referrer} AND NOT ${referred}`);
        break;
    }
  }

  if (d.service !== null) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM services s
       WHERE s.tenant_id = ${c}.tenant_id AND s.customer_id = ${c}.id
         AND ${audienceServicePredicate(evaluation, sql`s`)})`);
  }

  return sql.join(parts, sql` AND `);
}

/**
 * The selected customers as rows: `customer_id`, the bot a message would go through
 * (`bot_instance_id`, null when the customer never wrote to one) and the chat to reach
 * (`chat_id`, the private chat IS the Telegram user id). A consumer wraps this in its own
 * `INSERT ... SELECT` to materialise its frozen recipient rows.
 */
export function audienceCustomersQuery(evaluation: AudienceEvaluation): SQL {
  return sql`SELECT c.id AS customer_id,
                    c.first_bot_instance_id AS bot_instance_id,
                    c.telegram_user_id AS chat_id
               FROM customers c
              WHERE ${audienceCustomerPredicate(evaluation, sql`c`)}`;
}

/**
 * The SERVICES the definition's service block selects, owned by customers the rest of the
 * definition selects, and further narrowed by `extra` — a consumer's own eligibility rule
 * (e.g. "ACTIVE, with a finite allowance, on an operable panel"). Columns: `service_id`,
 * `customer_id`, `panel_id`, `service_label`.
 */
export function audienceServicesQuery(evaluation: AudienceEvaluation, extra: SQL = sql`true`): SQL {
  return sql`SELECT s.id AS service_id,
                    s.customer_id AS customer_id,
                    s.panel_id AS panel_id,
                    s.provider_username AS service_label
               FROM services s
               JOIN customers c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
              WHERE s.tenant_id = ${evaluation.tenantId}::uuid
                AND ${audienceCustomerPredicate(evaluation, sql`c`)}
                AND ${audienceServicePredicate(evaluation, sql`s`)}
                AND ${extra}`;
}

/**
 * The set's fingerprint: md5 over the sorted ids, as text. The same expression wherever a
 * set is compared — a preview and the materialisation that must match it.
 */
export function fingerprintOf(idColumn: SQL): SQL {
  return sql`md5(coalesce(string_agg(${idColumn}::text, ',' ORDER BY ${idColumn}), ''))`;
}
