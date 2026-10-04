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
NEXA_BENCH_PASSWORD=… node scripts/perf/web-nav-bench.mjs --api http://127.0.0.1:3917 --username perfowner --rtt 200
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
