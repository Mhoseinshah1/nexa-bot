# Web Admin navigation performance (Issue 16)

The owner reported that moving between Web Admin pages — Dashboard to the others in
particular — takes two to three seconds. This document is the measurement that
decided what to change, and the measurement after the change. Nothing here is a
service-level promise; every number is from the setup described below and is
reproducible with the committed scripts.

## How it was measured

- **Data.** A disposable database (`nexa_b2_perf`) migrated and seeded with
  `db:seed`, then filled by [`scripts/perf/seed-volume.mjs`](../../scripts/perf/seed-volume.mjs)
  at `--scale 8`: 160 000 customers, 320 000 orders over 180 days (70 % paid),
  320 000 payments, 224 000 services, 160 000 wallet entries, 1 600 000 audit rows and
  24 000 operational events in the seed's tenant `acme`. Every row goes through the
  real CHECK constraints and triggers. Then `VACUUM ANALYZE`, which is what autovacuum
  leaves a live installation in. The volume is an assumption about a large
  installation, not a copy of the owner's; at `--scale 1` (one eighth of it) the same
  shapes appear at one eighth of the cost (see "Scaling" below).
- **Server.** `node apps/api/dist/main.js` (the production build) against that database,
  on the same 4-CPU container as Postgres. SQL timings come from a measurement-only
  `node --import` hook that wraps `pg.Client#query`; it is not committed.
- **Browser.** [`scripts/perf/web-nav-bench.mjs`](../../scripts/perf/web-nav-bench.mjs):
  the production web build served the way `deploy/caddy/routes.caddy` serves it (gzip,
  immutable `/assets/*`, SPA fallback, production CSP), headless Chromium driven over
  the DevTools protocol, signing in as an owner and clicking the sidebar links
  Dashboard → Customers → Audit Log → Settings → Dashboard: once cold, then three
  repeated cycles (medians reported). `--rtt 200` adds 200 ms of round-trip latency to
  every request, which is what an operator who is not on the API's loopback sees.
- **One difference from production, stated:** the bench server speaks HTTP/1.1 (six
  connections per origin); the edge speaks HTTP/2. Where more than six requests are in
  flight at once (only the initial load), the bench queues and production would not.

```bash
node scripts/perf/seed-volume.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_b2_perf --scale 8
NEXA_BENCH_PASSWORD=… node scripts/perf/web-nav-bench.mjs --api http://127.0.0.1:3917 --username perfowner --rtt 200 [--hover 150]
```

Columns: **shell** — click to the first frame in which the URL, the sidebar's current
link and the top bar name the destination; **content** — click to the destination drawn
without a skeleton (a page served from the query cache draws before its refetch
answers); **ready** — click to the requests this navigation started all answered and the
page settled; **api** — API requests the navigation caused; **js** — JavaScript chunks it
loaded; **kept** — the sidebar and top bar DOM nodes survived the navigation.

## Before

### Browser, 0 ms added latency (ms, medians)

| Navigation                             | shell | content |     ready | api |  js | kept |
| -------------------------------------- | ----: | ------: | --------: | --: | --: | :--: |
| Dashboard → Customers, cold            |    18 |      66 |        96 |   2 |   0 | yes  |
| Dashboard → Customers, repeat          |    28 |      28 |        63 |   2 |   0 | yes  |
| Customers → Audit Log, cold            |    18 |      79 |        79 |   1 |   0 | yes  |
| Customers → Audit Log, repeat          |    21 |      21 |        58 |   1 |   0 | yes  |
| Audit Log → Settings, cold             |    18 |      63 |        63 |   1 |   0 | yes  |
| Audit Log → Settings, repeat           |    37 |      37 |        71 |   1 |   0 | yes  |
| Settings → Dashboard, cold             |    30 |      30 | **1 597** |   7 |   0 | yes  |
| Settings → Dashboard, repeat           |    19 |      19 | **1 381** |   7 |   0 | yes  |
| Dashboard (still loading) → Customers  |     7 |       7 |       141 |   2 |   0 | yes  |
| Initial load of `/` (empty HTTP cache) |       |         | **1 841** |  12 |   1 |      |

### Browser, 200 ms added latency (ms, medians)

| Navigation                             | shell | content |     ready | api |  js | kept |
| -------------------------------------- | ----: | ------: | --------: | --: | --: | :--: |
| Dashboard → Customers, cold            |    21 |     251 |       251 |   2 |   0 | yes  |
| Dashboard → Customers, repeat          |     8 |       8 |       214 |   2 |   0 | yes  |
| Customers → Audit Log, cold            |    20 |     248 |       248 |   1 |   0 | yes  |
| Customers → Audit Log, repeat          |    11 |      11 |       230 |   1 |   0 | yes  |
| Audit Log → Settings, cold             |    19 |     238 |       238 |   1 |   0 | yes  |
| Audit Log → Settings, repeat           |    18 |      18 |       230 |   1 |   0 | yes  |
| Settings → Dashboard, cold             |    16 |      16 | **1 180** |   7 |   0 | yes  |
| Settings → Dashboard, repeat           |    21 |      21 | **1 196** |   7 |   0 | yes  |
| Dashboard (still loading) → Customers  |     8 |       8 |       356 |   2 |   0 | yes  |
| Initial load of `/` (empty HTTP cache) |       |         | **2 283** |  12 |   1 |      |

Every navigation also requested `/favicon.ico` (not counted under api): the page
declares no icon, the edge's SPA fallback answers that path with `index.html` under
`Cache-Control: no-store`, so the browser asks again on every in-app navigation.

### The Dashboard's seven requests (0 ms latency, one repeat visit, ms)

| Request                          |    ms |
| -------------------------------- | ----: |
| `GET /reports/summary`           | 1 322 |
| `GET /dashboard/summary`         | 1 299 |
| `GET /reports/products`          |   301 |
| `GET /reports/failures`          |   268 |
| `GET /dashboard/operations`      |   235 |
| `GET /system/readiness`          |   121 |
| `GET /ops-log` (open conditions) |   167 |

All seven are issued in parallel (no waterfall); the page is as slow as its slowest
two, which are the two business aggregates.

### Server: the SQL behind the Dashboard

`dashboard/summary`, `reports/summary`, `reports/failures`, `reports/products` and
`dashboard/operations`, one after another, 82 statements, **2 020 ms of SQL**. Grouped by
shape (total ms, executions):

|  ms |   n | Statement                                                              |
| --: | --: | ---------------------------------------------------------------------- |
| 435 |   8 | `salesTotals` — paid orders in a `settled_at` window, by currency      |
| 379 |   2 | `newBuyers` — each customer's first paid order, all time               |
| 257 |   4 | `trend` REVENUE — paid orders bucketed by `settled_at`                 |
| 236 |   2 | `newServices` — services provisioned in the window, joined to orders   |
| 146 |   3 | `paymentFailures` — failed/cancelled/expired payments by `resolved_at` |
| 125 |   1 | `productRanking`                                                       |
| 120 |   1 | `activeCustomers`                                                      |
|  66 |   1 | `revenueCurrencies` — paid orders over six `settled_at` windows        |
|  65 |   1 | `salesTrendByPurpose`                                                  |

`EXPLAIN (ANALYZE, BUFFERS)` of `salesTotals` for ONE day: `Seq Scan on orders`,
`Rows Removed by Filter: 39 778` of 40 000 at scale 1. The only index on `orders` that
names `state` is `(tenant_id, state)`; nothing indexes `settled_at`, so every
windowed aggregate over paid orders — and `dashboard/summary` runs 29 statements, most of
them that — reads the tenant's whole order history. Its cost grows linearly with the
number of orders the installation has ever taken, which is why it is invisible on a new
installation and seconds on an established one:

| Scale |  orders | `dashboard/summary` | `reports/summary` |
| ----- | ------: | ------------------: | ----------------: |
| 1     |  40 000 |          190–270 ms |        140–150 ms |
| 8     | 320 000 |        900–1 690 ms |      930–1 610 ms |

(The ranges are repeated isolated requests; the container's four CPUs are shared, so
the spread is real noise, not a trend.)

## Root causes, with the evidence for each

1. **The Dashboard's two business aggregates scan every order the tenant has ever
   taken, on every visit.** 1.2–1.6 s each at scale 8 (table above), linear in history,
   issued again on every visit because the queries are refetched on mount. This is the
   "Dashboard" in the owner's report: the Dashboard is the page that takes seconds to
   be complete, every time it is opened, and it is the first page after sign-in.
2. **Leaving the Dashboard early makes the next page pay for it.** The abandoned
   aggregates keep running on the server; Customers' own two requests took 86–180 ms
   instead of 40–55 ms (0 ms latency) and 304–378 ms instead of ~250 ms (200 ms latency)
   while they did — the "Dashboard → others" half of the report.
3. **`/favicon.ico` on every navigation** — one extra, uncacheable round trip per click.

What the measurement ruled OUT, so it was not changed:

- **Shell or provider remounts:** none. The sidebar and top bar DOM nodes survived every
  one of the 4 × 4 + 3 navigations (`kept`), and the shell responds in 10–40 ms.
- **Route chunk loading:** none — the admin is one bundle (2.77 MB, 643 kB gzip),
  loaded once at sign-in. Splitting it would ADD a chunk round trip to the first visit
  of every page; the bundle's cost is the initial load only (its 1 of 17 requests).
- **Request waterfalls and duplicates:** none on any measured page. Each page issues its
  requests in parallel, once; the only serial dependency is the session lookup before
  the console renders, which is the permission list every page needs.
- **Render cost:** long tasks after a click total 0–56 ms (0–300 ms at a 6× CPU
  slowdown); no page re-renders expensively.
- **The other pages' endpoints:** `users` 8–80 ms, `audit-log` 7–43 ms, `settings`
  7–36 ms, `customer-tags` 5–30 ms server time at scale 8. With latency, a cold visit to
  any of them is one round trip plus that.
- **Repeat visits** already draw from the query cache in 8–37 ms and refetch in the
  background; nothing blocks on the refetch.

## What was changed, and why each is supported by the evidence

1. **`orders_tenant_paid_settled_idx`** — `(tenant_id, settled_at)` partial on
   `state = 'PAID'`, INCLUDE-ing the columns the sales aggregates group, filter and sum,
   so a window is an index-only range scan (root cause 1). An ONLINE index
   (`online-indexes.ts`, built `CONCURRENTLY` after migrating), so it needs no numbered
   migration and takes no write lock on a live `orders` table.
2. **`payments_tenant_resolved_idx`** — `(tenant_id, resolved_at)` INCLUDE `state`,
   partial on `resolved_at IS NOT NULL` (exactly the FAILED/CANCELLED/EXPIRED rows per
   `payments_resolved_check`): `paymentFailures`, the largest dashboard statement left
   after (1). Also online.
3. **An explicit empty icon** (`<link rel="icon" href="data:,">`) — removes the
   uncacheable `/favicon.ico` round trip from every navigation (root cause 3).
4. **Sidebar prefetch on pointing or focus** for Customers, Audit Log and Settings
   (`apps/web/src/nav-prefetch.ts`). The measurement showed a cold visit to them is one
   round trip and nothing else, which only asking earlier can hide. Limits, each a
   safety rule: non-financial reference pages only; only with the permission the page's
   own query is gated on (a refused request records a denial event); the SAME query the
   page asks, from builders the page modules export; tenant-independent keys as before,
   because the cache is emptied at every session change and sign-out cancels in-flight
   queries first. Those builders carry a 5-second `staleTime` so the page arriving after
   its prefetch does not ask again; it is the only staleness introduced, and every
   mutation of those lists invalidates them regardless.

Considered and NOT done, because the measurement did not support it: route-level code
splitting (no chunk loads on navigation; it would add one per first visit), memoisation
or render work (no long tasks), shell restructuring (no remounts), a `staleTime` on the
Dashboard's queries (financial and provider figures, refreshed on every visit by design),
aborting the Dashboard's abandoned requests on unmount (the server keeps executing them
either way; under HTTP/2 the browser does not queue behind them).

## After

Same database, same build options, same container. The payments and orders indexes
were built by `db:migrate` (`ensureOnlineIndexes`) and the tables vacuumed, as before.

### Server: the same five Dashboard endpoints

|                             |   before |    after |
| --------------------------- | -------: | -------: |
| SQL total, 82–83 statements | 2 020 ms | 1 044 ms |
| `GET /dashboard/summary`    |   899 ms |   270 ms |
| `GET /reports/summary`      |   928 ms |   634 ms |
| `GET /reports/failures`     |    95 ms |    51 ms |
| `GET /reports/products`     |   140 ms |   146 ms |
| `salesTotals` (8 calls)     |   435 ms |    88 ms |
| `trend` REVENUE (4 calls)   |   257 ms |    30 ms |
| `paymentFailures` (3 calls) |   146 ms |  ≤ 16 ms |
| `salesTrendByPurpose`       |    65 ms |  ≤ 16 ms |

### Browser, 0 ms added latency (ms, medians)

| Navigation                            | content before | content after | ready before | ready after | api before → after                |
| ------------------------------------- | -------------: | ------------: | -----------: | ----------: | --------------------------------- |
| Dashboard → Customers, cold           |             66 |            64 |           96 |          64 | 2 → 2                             |
| Customers → Audit Log, cold           |             79 |            54 |           79 |          54 | 1 → 1                             |
| Audit Log → Settings, cold            |             63 |            50 |           63 |          50 | 1 → 1                             |
| Settings → Dashboard, cold            |             30 |            28 |    **1 597** |     **831** | 7 → 7                             |
| Settings → Dashboard, repeat          |             19 |            18 |    **1 381** |     **884** | 7 → 7                             |
| Dashboard (still loading) → Customers |              7 |            11 |          141 |          69 | 2 → 2                             |
| Initial load of `/`                   |                |               |    **1 841** |   **1 384** | 12 → 12 (17 → 16 requests in all) |

### Browser, 200 ms added latency (ms, medians)

| Navigation                            | content before | content after, click only | content after, pointer 150 ms before the click | ready before | ready after |
| ------------------------------------- | -------------: | ------------------------: | ---------------------------------------------: | -----------: | ----------: |
| Dashboard → Customers, cold           |            251 |                       246 |                                         **55** |          251 |         246 |
| Customers → Audit Log, cold           |            248 |                       276 |                                         **70** |          248 |         276 |
| Audit Log → Settings, cold            |            238 |                       236 |                                         **78** |          238 |         236 |
| Settings → Dashboard, cold            |             16 |                        36 |                                             19 |    **1 180** |     **848** |
| Settings → Dashboard, repeat          |             21 |                        17 |                                             14 |    **1 196** |     **847** |
| Dashboard (still loading) → Customers |              8 |                        17 |                                             34 |          356 |         252 |
| Initial load of `/`                   |                |                           |                                                |    **2 283** |   **1 749** |

"Pointer 150 ms before the click" is `--hover 150`: the mouse arrives on the link,
then clicks, which is what a mouse does and what the bare `click()` of the other columns
does not. Before the change the sidebar had no pointer handler, so the "before" column
is the same with or without it. The "click only" column shows the prefetch costs a
keyboard-less, pointer-less click nothing.

Two caveats on the "repeat" rows, so they are not over-read. A bench cycle revisits a
page within about four seconds, inside the five-second freshness window, so in the
click-only runs the three prefetched pages' repeat visits made **no** request (they drew
from the cache, as they did before, and did not refetch); an operator who stays on a page
longer than five seconds gets the background refetch exactly as before. And the spread
between runs on this shared 4-CPU container is ±15–25 %; the Dashboard's halving is well
outside it, the single-digit differences in the other rows are not.

Shell persistence is unchanged: the sidebar and top bar survived every navigation of
every run (`kept`), the shell answered a click in 7–43 ms, and no navigation loaded a
JavaScript chunk.

## The rules, and the probe that proves each has a test

[`scripts/mutate-web-nav-perf.py`](../../scripts/mutate-web-nav-perf.py) reverts one rule
at a time, runs the test that names it, and restores the file. Every mutation must be
KILLED:

| Id    | Rule reverted                                    | Test that fails                       |
| ----- | ------------------------------------------------ | ------------------------------------- |
| NP-01 | the 5-second `staleTime` on the customer list    | page after its prefetch asks again    |
| NP-02 | the sidebar's pointer handler                    | no prefetch happens                   |
| NP-03 | the permission check before a prefetch           | a refused page is asked for           |
| NP-04 | the shell keyed by route (a remount)             | sidebar and top bar replaced          |
| NP-05 | the audit log key without its filters            | bare page answers a filtered one      |
| NP-06 | the customer key without the search              | bare list answers a searched one      |
| NP-07 | the empty icon                                   | `web-index-icon.test.ts`              |
| NP-08 | the `orders_tenant_paid_settled_idx` declaration | four `reporting-plan` plans           |
| NP-09 | the `payments_tenant_resolved_idx` declaration   | the `paymentFailures` plan            |
| NP-10 | the sidebar's keyboard-focus handler             | focusing a link prefetches nothing    |
| NP-11 | the audit-log invalidation after every mutation  | a write inside the window is not seen |

NP-08 and NP-09 also drop the index from the test database (online indexes are built
outside the migrator) and rebuild it afterwards with the compiled migrator, so they need
`TEST_DATABASE_URL` and `pnpm build`, and are SKIPPED without the database:

```bash
TEST_DATABASE_URL=postgres://nexa:nexa@127.0.0.1:5432/<your db> python3 scripts/mutate-web-nav-perf.py
```

Last run (on `nexa_b2_perf_it`): all eleven KILLED, tree clean afterwards.

## Remaining bottlenecks

- **`GET /reports/summary` is still ~630 ms at this volume**, and the Dashboard is as
  slow as it. What is left in it is not a windowed range: `newBuyers` reads every
  customer's FIRST paid order over all time (212 ms; now index-only, but still the whole
  history), `newServices` joins the window's services to their orders (208 ms, a hash
  join over the tenant's orders), `productRanking` (126 ms) and `activeCustomers`
  (97 ms). Each needs a different shape — a stored first-purchase fact, or a services
  index carrying what the join reads — and is a schema decision beyond this package.
- **The Dashboard refetches its seven requests on every visit.** That is a freshness
  decision about financial and provider figures, not an accident, and it was kept; with
  the indexes it costs ~0.85 s instead of ~1.4 s at this volume.
- **The statements inside one dashboard request run one after another** (29 for
  `dashboard/summary`). Running them concurrently would cut latency further at the cost
  of more simultaneous connections per request; not done without a measurement of the
  pool under load.
- **Initial load:** one 2.77 MB bundle (643 kB gzip), parsed once per tab. It does not
  affect navigation; a vendor split would shorten a cold first load on a slow link and
  is worth measuring on the owner's connection.
- **Pages not measured here** (Orders, Payments, Services, Panels) read financial or
  provider truth and were deliberately left out of the prefetch; their cold visits are
  still one round trip plus their endpoint.
