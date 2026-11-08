import { count, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ListTotal } from '@nexa/contracts';
import type { Database } from './database.js';

/**
 * The total behind a list's count chip (web redesign PR-10), computed so that it can never
 * make the list slower or fail it.
 *
 * Three rules, each with the failure it prevents:
 *
 * - NO `count(*)` over a large selection. A tenant that imported ~200k customers, services
 *   or orders would pay a scan on every page turn. The planner is asked first
 *   (`EXPLAIN (FORMAT JSON)` plans and does not execute, so it costs a millisecond whatever
 *   the table holds, and it honours the tenant filter and the list's own filters, which a
 *   table-wide `reltuples` would not). Only when it expects at most `EXACT_COUNT_CEILING`
 *   rows is the selection counted, and that count is itself capped by a `LIMIT`, so a stale
 *   estimate cannot turn it into a scan of everything.
 * - A count that overshoots the ceiling, or an estimate that was wrong, is returned as the
 *   estimate with `estimated: true` and never as an exact figure.
 * - The work runs in its own short transaction under `SET LOCAL statement_timeout`. A
 *   `Promise.race` would hand the page back on time and leave the query running on a pooled
 *   connection; here the server cancels it. Any failure, timeout included, is `null` — the
 *   page then draws no chip — because a count chip is not worth a failed list.
 *
 * The caller passes the list's own FILTERS (tenant included), never its keyset cursor: the
 * total is of the selection, not of the rest of the traversal.
 */
export const LIST_TOTAL_EXACT_CEILING = 5_000;
export const LIST_TOTAL_TIMEOUT_MS = 1_500;

export async function listTotal(
  db: Database,
  table: PgTable,
  where: SQL | undefined,
): Promise<ListTotal | null> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SET LOCAL statement_timeout = ${sql.raw(String(LIST_TOTAL_TIMEOUT_MS))}`,
      );
      const selection = tx
        .select({ one: sql`1`.as('one') })
        .from(table)
        .where(where);
      const plan = await tx.execute(sql`EXPLAIN (FORMAT JSON) ${selection}`);
      const estimate = planRows(plan);
      if (estimate === null) return null;
      if (estimate > LIST_TOTAL_EXACT_CEILING) return { value: estimate, estimated: true };
      const capped = tx
        .select({ one: sql`1`.as('one') })
        .from(table)
        .where(where)
        .limit(LIST_TOTAL_EXACT_CEILING + 1)
        .as('capped');
      const counted = await tx.select({ n: count() }).from(capped);
      const exact = Number(counted[0]?.n ?? 0);
      return exact > LIST_TOTAL_EXACT_CEILING
        ? { value: Math.max(estimate, exact), estimated: true }
        : { value: exact, estimated: false };
    });
  } catch {
    return null;
  }
}

/** The top plan node's `Plan Rows` out of `EXPLAIN (FORMAT JSON)`; null for anything else. */
export function planRows(result: unknown): number | null {
  const rows = (result as { rows?: Record<string, unknown>[] }).rows;
  const cell = rows?.[0]?.['QUERY PLAN'];
  const parsed: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
  const rowsOfPlan = (parsed as { Plan?: { 'Plan Rows'?: unknown } }[] | undefined)?.[0]?.Plan?.[
    'Plan Rows'
  ];
  return typeof rowsOfPlan === 'number' && Number.isFinite(rowsOfPlan)
    ? Math.max(0, Math.round(rowsOfPlan))
    : null;
}
