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
/**
 * The planner's total cost above which the capped `count(*)` is not executed: the estimate
 * is returned as it is. A selection the planner thinks is small but whose cheapest plan is
 * a walk of a big table (a rare, un-indexed filter) would otherwise run until the timeout.
 */
export const LIST_TOTAL_COUNT_COST_CEILING = 20_000;

/** True when every pooled connection is busy and callers are already queueing for one. */
function poolSaturated(db: Database): boolean {
  const pool = (db as unknown as { $client?: { idleCount?: number; waitingCount?: number } })
    .$client;
  return (
    pool !== undefined &&
    typeof pool.idleCount === 'number' &&
    typeof pool.waitingCount === 'number' &&
    pool.idleCount === 0 &&
    pool.waitingCount > 0
  );
}

export async function listTotal(
  db: Database,
  table: PgTable,
  where: SQL | undefined,
  /** Only a test lowers the ceiling, to reach the "too costly to count" branch. */
  options: { readonly countCostCeiling?: number } = {},
): Promise<ListTotal | null> {
  // A chip is not worth queueing behind the page for a connection.
  if (poolSaturated(db)) return null;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SET LOCAL statement_timeout = ${sql.raw(String(LIST_TOTAL_TIMEOUT_MS))}`,
      );
      // One backend: a parallel scan for a count would take workers from the page.
      await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
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
      // Plan the count itself: a cheap estimate of ROWS says nothing about what finding
      // them costs. Past the ceiling, the estimate is the answer and nothing is executed.
      const countPlan = await tx.execute(
        sql`EXPLAIN (FORMAT JSON) ${tx.select({ n: count() }).from(capped)}`,
      );
      const cost = planTotalCost(countPlan);
      if (cost === null || cost > (options.countCostCeiling ?? LIST_TOTAL_COUNT_COST_CEILING)) {
        return { value: estimate, estimated: true };
      }
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

/** The top plan node's `Total Cost` out of `EXPLAIN (FORMAT JSON)`; null for anything else. */
export function planTotalCost(result: unknown): number | null {
  const rows = (result as { rows?: Record<string, unknown>[] }).rows;
  const cell = rows?.[0]?.['QUERY PLAN'];
  const parsed: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
  const cost = (parsed as { Plan?: { 'Total Cost'?: unknown } }[] | undefined)?.[0]?.Plan?.[
    'Total Cost'
  ];
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
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
