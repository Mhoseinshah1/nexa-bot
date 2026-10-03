import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './database.js';
import { customers } from './schema.js';

/**
 * The SQL halves of the Web Admin's one search box (spec §10), shared by every list that
 * takes `q`. The classification itself is `classifyListSearch` in `@nexa/contracts`.
 *
 * Two rules every caller inherits from here rather than re-deriving:
 *
 * - A PREFIX, never an infix, against a column that grows with the installation. A
 *   `LIKE 'x%'` on `lower(col)` is served by a `text_pattern_ops` btree as an Index Cond
 *   (`~>=~` / `~<~`); a `LIKE '%x%'` is served by nothing this database has — `pg_trgm`
 *   is not installed by any migration, and adding an extension to an installation is its
 *   own decision (`docs/web-admin-search.md`). The one infix match is over `products`,
 *   a catalogue of tens of rows per tenant, and it RESOLVES ids first.
 * - The needle is ESCAPED. A Telegram username is `[A-Za-z0-9_]`, and an unescaped `_`
 *   is LIKE's single-character wildcard, so `ali_r` would also match `alixr`.
 */
export function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, '\\$&');
}

/** `lower(<expression>) LIKE '<folded needle>%'`, escaped. `folded` must already be lower-case. */
export function lowerPrefix(expression: SQL, folded: string): SQL {
  return sql`lower(${expression}) like ${`${escapeLike(folded)}%`}`;
}

/**
 * The ids of ONE tenant's customers holding this exact Telegram id, as an array the outer
 * query compares with `= ANY(...)`.
 *
 * `ARRAY(SELECT …)` rather than a join or an `IN (SELECT …)`, and the difference is the
 * plan: PostgreSQL evaluates an uncorrelated `ARRAY(...)` ONCE, as an InitPlan, and the
 * result is a parameter an index can take as its condition — so the outer list reaches
 * `orders_customer_created_idx` (or its siblings) directly, even as one arm of an `OR`.
 * An `IN (SELECT …)` inside an `OR` becomes a hashed SubPlan FILTER, which is a walk of
 * the tenant's whole table. At most one id here: `customers_tenant_telegram_key` is unique.
 */
export function customerIdsWithTelegramId(tenantId: string, telegramUserId: string): SQL {
  return sql`ARRAY(SELECT ${customers.id} FROM ${customers} WHERE ${customers.tenantId} = ${tenantId} AND ${customers.telegramUserId} = ${telegramUserId})`;
}

/**
 * The ids of one tenant's customers whose username starts with this folded prefix, served
 * by `customers_tenant_username_idx`. The same InitPlan shape as the function above.
 */
export function customerIdsWithUsernamePrefix(tenantId: string, folded: string): SQL {
  return sql`ARRAY(SELECT ${customers.id} FROM ${customers} WHERE ${customers.tenantId} = ${tenantId} AND ${lowerPrefix(sql`${customers.username}`, folded)})`;
}

/** A customer as Telegram knows them: the operator-facing identity on every list row. */
export interface CustomerTelegramIdentity {
  readonly telegramUserId: string;
  readonly username: string | null;
}

/**
 * The Telegram identity of each of these customers, in ONE query over the primary key and
 * inside the tenant. The single reader every list uses to put a Telegram id on its rows
 * instead of an internal uuid (spec §10); a list that grew its own copy would be a second
 * answer to "who is this".
 */
export async function readCustomerIdentities(
  executor: Executor,
  tenantId: string,
  customerIds: readonly string[],
): Promise<ReadonlyMap<string, CustomerTelegramIdentity>> {
  const identities = new Map<string, CustomerTelegramIdentity>();
  if (customerIds.length === 0) return identities;
  const rows = await executor
    .select({
      id: customers.id,
      telegramUserId: customers.telegramUserId,
      username: customers.username,
    })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, [...new Set(customerIds)])));
  for (const row of rows) {
    identities.set(row.id, { telegramUserId: row.telegramUserId, username: row.username });
  }
  return identities;
}
