# PR-10 item 3: count chips with a total

Lists: `/users` (customers), `/services`, `/orders`. The response gains an optional `total: { value, estimated }`
(`listTotalSchema`, its own contracts commit). The page head draws it through `PageHead count` / `countEstimated`
(«حدود N» when estimated). Absent = no chip. Other lists (payments, tickets, reports, ...) are not changed: each needs its
own repository filter set, so it is not a one-line change per page.

## How the total is produced (`infrastructure/persistence/list-total.ts`)

1. `EXPLAIN (FORMAT JSON)` of `SELECT 1 FROM <table> WHERE <the list's own filters, tenant first, no cursor>`. Planning
   only, nothing is executed, so it costs ~1 ms at any table size. It honours the tenant and every filter (a table-wide
   `reltuples` would count other tenants).
2. Plan Rows > 5 000: returned as `{ value: estimate, estimated: true }`. No `count(*)` runs.
3. Plan Rows <= 5 000: `count(*)` over `(SELECT 1 ... LIMIT 5001)`, exact (`estimated: false`). If it hits 5 001 (stale
   statistics) the value is `max(estimate, 5001)` and `estimated: true`.
4. All in its own short transaction with `SET LOCAL statement_timeout = 1500`; any error or timeout gives `null` (no chip).
   The service runs it with `Promise.all` beside the page query, on its own pooled connection, so the page never waits on
   it beyond its own time and never fails because of it. Permissions, tenant scope and RLS are those of the list (same
   `this.db`, same guard call before both).

## Plans checked (200k-row tenant A + 3k-row tenant B, `ANALYZE`d, `tests/integration/list-total.test.ts`)

Estimate step (EXPLAIN only, tenant A, unfiltered): all three plan as `Index Only Scan ... Index Cond: (tenant_id = ...)`,
estimated rows 200 092 (customers), 200 036 (orders), 199 698 (services) against 200 000 real (within 0.1 %). Nothing
was executed.

Exact step, small selection (`customers ... status = 'BLOCKED'`, 7 rows): planner estimate 7, so the capped count runs:
`Limit -> Gather -> Parallel Seq Scan`, 21.9 ms at 203k rows (no index on `status`; the scan ends at the limit, and is
bounded by the 1.5 s timeout in any case). Small tenant (3 000 services): `Limit -> Index Only Scan
services_tenant_state_idx`, Heap Fetches 0, 0.3 ms.

For contrast, an exact `count(*)` of the 200k tenant: `Index Only Scan`, 9.4 ms here on a settled table (heap fetches 0),
and much more on an un-vacuumed table or a cold cache; the estimate path avoids that dependence entirely.

Test assertions: 200k unfiltered customers/orders/services come back `estimated: true` (only the planner path can return
that, so no count ran), within 10 % of the real figure, in under 400 ms; filtered small selections (7 blocked customers,
7 refunded orders) and the 3k tenant are exact with `estimated: false` and never include the other tenant; a total that
cannot finish (`pg_sleep` in the filter) returns `null` in under 4 s.

## After the Opus review

- The page never waits on the total beyond 1.5 s (`totalWithin`, in `modules/commerce/list-total-deadline.ts`; the
  server-side `statement_timeout` still cancels the query). It is opt-in (`withTotal`, set only by the three Web Admin
  list handlers; global search and the Telegram flows never pay for it) and is computed for the first page only. A page
  turn does not recount: the web keeps the chip of the same list (`useKeptTotal`) until a filter changes.
- `OrderService.list` resolves the product-name arm once (`productIdsTitled`) and passes it to the page and the total;
  `total()` cannot throw (any error is `null`).
- The count is planned before it runs: `SET LOCAL max_parallel_workers_per_gather = 0`, then `EXPLAIN` of the capped
  `count(*)` itself; a top-node Total Cost above 20 000 returns the row estimate (`estimated: true`) and executes
  nothing. This replaces the earlier "known limit": a rare un-indexed filter that is expensive to find is no longer
  scanned. The 1.5 s timeout stays as the backstop. When the pool is saturated (no idle connection, callers waiting) the
  total is skipped.
- Statistics: the planner's row estimate uses the table's statistics, which are table-wide (most-common values and
  n_distinct over all tenants), not per tenant. An estimate above the threshold therefore says something about the
  installation's row distribution as well as this tenant's. This is accepted: it is shown as «حدود N», it only ever
  decides between "estimate" and "exact count", and the exact path is for small selections only.
