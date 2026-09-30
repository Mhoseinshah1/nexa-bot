# Web Admin redesign — the dashboard (round W, agent DASH)

The owner's brief §4 (dashboard), §5 (charts), §12 (performance, sidebar counters) and §13
(invariants), mapped to what the system can state truthfully. Every figure on the new `/`
is a persisted-row derivation that already existed on `main` as a WP12 report metric
(`docs/wp12-business-analytics-audit.md`), or a gauge over a predicate an existing page
already filters by. Nothing is recomputed in the browser, nothing is seeded, and a figure
with no trustworthy source is omitted and said to be omitted.

Part 1 (this commit range) is the backend: the audit, one contract commit, three read-only
endpoints and their tests. Part 2, the page itself on the shared kit, lands after the
foundation merges and is recorded at the end of this file.

---

## 1. Endpoints

All three are `GET` under `/api/admin/v1`, authenticated by the session cookie, tenant-scoped
by the session (never by a parameter), and write nothing. Shapes: `packages/contracts/src/dashboard.ts`.

| Route                   | Gate                                                                                                                                                                                                         | Cadence                                  | Cost                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `/dashboard/summary`    | **Super Admin** — `reports.view` through the guard AND the `owner` role, by `ReportAccess`, charged FIRST. A refusal is the guard's 403 and is recorded (`access.permission_denied`, `requiredRole: owner`). | `DASHBOARD_SUMMARY_REFRESH_MS` = 60 s    | ≈ 20 statements, each bounded by the tenant and ONE half-open window (below) |
| `/dashboard/operations` | per section, the permission of the page it summarises (`DASHBOARD_OPERATION_PERMISSIONS`); a section the viewer may not see is `null` and its query never runs                                               | `DASHBOARD_OPERATIONS_REFRESH_MS` = 30 s | 4–5 indexed counts                                                           |
| `/nav-counters`         | per counter, the permission of the page the sidebar link opens (`NAV_COUNTER_PERMISSIONS`); `null` when not held                                                                                             | `NAV_COUNTERS_REFRESH_MS` = 60 s         | ≤ 6 counts, each reading at most `COUNTER_CAP` (1000) rows                   |

`/dashboard/summary` takes the reports' own range query (`reportRangeQuerySchema`: a preset, or
`CUSTOM` with tenant-calendar `from`/`to`), so a malformed range is the same 400 the reports give.

**Why a withheld section is `null`, not a 403.** The sidebar asks on every page, once a minute,
whatever the viewer's role. Charging each missing counter through `PermissionGuard.check`
would record one `access.permission_denied` operational event per missing permission per
poll per tab — `operational_events` has no retention sweeper, and that is exactly the feed
the alerts page exists to keep readable (the hazard `polling.ts` describes). The decision is
still the guard's: `permissionsOf`, its one resolution rule, read once per request. Nothing is
disclosed by the omission — a viewer's own permission list is already theirs
(`GET /auth/session`) — and nothing is computed for a withheld section. The business
summary, whose gate is a refusal on the reports too, stays a recorded 403.

**Why not N client queries.** The WP12 dashboard section made five business requests
(summary, trend, products, failures, plus the range card) and drew the fleet by walking one
page of `GET /panels` in the browser, with a "partial fleet" note when the tenant had more
than 200 panels. The summary is one request; the fleet is now an exact server count, so the
partial-fleet caveat disappears rather than being redrawn.

**Why the business summary may poll at 60 s** while the report pages stay at
`REPORT_REFRESH_INTERVAL_MS` (5 min). Its statements are all window-bounded. The two report
figures whose cost no window bounds — new buyers (every customer's EARLIEST sale, a scan of
the tenant's paid orders) and active customers (a union over every active service) — are
deliberately NOT in it. They stay on `/reports/summary` and its five-minute cadence, which
the dashboard's secondary figures card keeps reading (part 2).

---

## 2. Periods and deltas

The period is resolved by the ONE resolver (`resolveReportPeriod`, `report-calendar.ts`) in the
tenant's `display_timezone` and `calendar`, as half-open UTC intervals `[start, end)`; SQL never
applies a time zone. The dashboard offers امروز (`TODAY`), ۷ روز (`LAST_7_DAYS`), ۳۰ روز
(`LAST_30_DAYS`), این ماه (`THIS_MONTH`) and دلخواه (`CUSTOM`); the endpoint accepts every
report range.

- **Previous period**: the same span one unit back (a day, N days, a calendar month in the
  tenant's calendar), `wp12 §3`'s one rule.
- **Like for like**: when the current period contains _now_, it runs to _now_ and the previous
  one runs for the same elapsed duration from its own start. "Today so far" is compared with
  "yesterday to the same minute"; "this month so far" with "last month's same elapsed span".
  Pinned by the stopped-clock test: a sale at yesterday 15:00 exactly is outside a comparison
  cut at 15:00.
- **Granularity** follows the resolver: a day is hourly, up to 31 days daily, beyond that weekly
  or monthly. Bucket `i` of the current series is compared with bucket `i` of the previous.
- **A bucket that has not begun is `null`**, never `0`, on every series and on the sales-by-kind
  bars, so a chart never draws a collapse for hours that have not happened.
- **Today and this month are fixed windows**, shown whatever period is selected (as the reference
  shows «فروش امروز» and «فروش این ماه» above a 30-day selection), resolved at the same instant
  as the selected period so the three agree on "now".
- **Delta text** is the reports' existing pure rule (`describeChange` in `report-view.ts`): both
  zero → `—`; nothing before and something now → «جدید»; otherwise a signed percentage in basis
  points from integer arithmetic on the exact values. Money is compared per currency and never
  summed across currencies.

**Good/bad colour.** WP12 §3 never coloured a movement, because a report page has no business
opinion. The owner's brief for this round asks for semantic green/red "only when the metric has
a meaningful good/bad direction". The dashboard applies it to exactly these, and nothing else:

| Direction up is… | Metrics                                                             |
| ---------------- | ------------------------------------------------------------------- |
| good (green)     | today's and this month's revenue, sales, renewals, new customers    |
| bad (red)        | failed payments                                                     |
| not coloured     | every gauge (no comparison exists) and every report page, unchanged |

---

## 3. The metric table

"Registry" is the `METRIC_DEFINITIONS` name in `packages/contracts/src/metrics.ts`. "Existing"
means the definition and its SQL were on `main` before this round; "split" and "gauge" are the
five entries this round registers, each over rows and predicates the reports or a page already
read.

| Brief item                            | Shown as                                                                              | Registry / source                                                                                                             | Definition                                                                                                                                                                                                                                                       | Delta                              | Direction | Visible to                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------- | --------------------------------------------- |
| فروش امروز                            | revenue per currency, sales count, hourly revenue sparkline                           | `sales.revenue`, `sales.count` (existing) — `salesTotals`, `trend(REVENUE)`                                                   | PAID orders of a sale purpose (never TRIAL, never REFUNDED), `settled_at ∈ [today 00:00, now)`, `sum(total_amount)` after discount, by currency                                                                                                                  | yesterday, to the same minute      | up good   | Super Admin                                   |
| فروش این ماه                          | as above, daily sparkline                                                             | same                                                                                                                          | same, `settled_at ∈ [1st of this tenant-calendar month, now)`                                                                                                                                                                                                    | last month, same elapsed span      | up good   | Super Admin                                   |
| (selected period's revenue)           | the revenue chart's total                                                             | same                                                                                                                          | same, over the selected period                                                                                                                                                                                                                                   | previous period, like for like     | up good   | Super Admin                                   |
| اشتراک/سرویس فعال                     | a count                                                                               | `services.active` (existing) — `activeServices`                                                                               | `state = 'ACTIVE'`, now. Never inferred from `expires_at`                                                                                                                                                                                                        | none: no stored history of a state | —         | Super Admin (it is a report figure on `main`) |
| مشتری جدید                            | count + sparkline                                                                     | `customers.new` (existing) — `newCustomers`, `trend(NEW_USERS)`                                                               | customers with `created_at` (first `/start`) in the period                                                                                                                                                                                                       | previous period                    | up good   | Super Admin                                   |
| تمدیدها                               | count + sparkline (the RENEWAL bars)                                                  | `sales.renewals` (existing)                                                                                                   | PAID `RENEW` orders settled in the period                                                                                                                                                                                                                        | previous period                    | up good   | Super Admin                                   |
| پرداخت ناموفق                         | count, alert-style card                                                               | `failures.payments`, its FAILED part (existing) — `paymentFailures`, now shared with `/reports/failures`                      | payments `state = 'FAILED'` with `resolved_at` in the period (CANCELLED and EXPIRED are not "failed": they stay on the failure report)                                                                                                                           | previous period                    | up bad    | Super Admin                                   |
| سرویس‌های رو به انقضا                 | count, "within 7 days"                                                                | `services.expiring` (gauge, new) — the audience's own `expiringWithinHours` predicate (`audienceServicePredicate`), 168 hours | `state = 'ACTIVE'` AND `expires_at ∈ [now, now + 7 days)`. A SUSPENDED service, or one already past its expiry, is not "expiring"                                                                                                                                | none                               | —         | `services.view` (the services page)           |
| مصرف ترافیک ۲۴ ساعت                   | **omitted**                                                                           | —                                                                                                                             | `services.traffic_used_bytes` is a cumulative snapshot OVERWRITTEN by each usage read; no table keeps its history, so "consumed in the last 24 hours" has no source.                                                                                             | —                                  | —         | —                                             |
| پنل‌های فعال                          | `active / total`, the health distribution and the provider breakdown (secondary card) | `panels.fleet` (gauge, new) — the panels module's own projection (`healthViewOf`, extracted from `readHealth`)                | panels with `status <> 'ARCHIVED'`, each once; health is the latest probe, DISABLED projected from the status, UNCHECKED where no probe ran                                                                                                                      | none                               | —         | `panels.view`                                 |
| صف Provisioning / در انتظار           | queued count, alert-style when anything is UNKNOWN or UNRECONCILED                    | `provisioning.queue` (gauge, new)                                                                                             | operations `PLANNED` or `IN_FLIGHT`; apart, operations `UNKNOWN` (a READ decides; never retried) and services `UNRECONCILED`                                                                                                                                     | none                               | —         | `services.view`                               |
| سفارش‌ها و تمدیدها (chart)            | stacked bars per bucket: new, renewal, add-on                                         | `sales.by_kind` (split, new) — `salesTrendByPurpose` folded by `dashboardSaleKindOf`                                          | the `sales.count` rows by bucket and purpose. NEW = NEW_SERVICE, CUSTOM_SERVICE; RENEWAL = RENEW; ADDON = ADD_TRAFFIC, ADD_TIME, ADD_DEVICES, CHANGE_LOCATION. A unit test holds the kinds to `orderPurposeIsSale`, so the bars of a bucket add up to its sales. | current period only                | —         | Super Admin                                   |
| درآمد روزانه (chart)                  | current line, previous period dashed                                                  | `sales.revenue` by bucket — the SAME `series()` the reports' trend uses                                                       | in the tenant's `sales.currency`; `currencies` lists every currency taken so the page can say another one exists                                                                                                                                                 | bucket `i` against bucket `i`      | —         | Super Admin                                   |
| payment-method share (secondary card) | confirmed ORDER payments per method, count and amount                                 | `payments.attempts` (existing) — `paymentGroups`, kind ORDER                                                                  | attempts CREATED in the period that are CONFIRMED, per `method`. A wallet top-up is not a sale's payment and is excluded                                                                                                                                         | none                               | —         | Super Admin                                   |
| attention-required conditions         | the list stays (existing `GET /ops-log?scope=MANAGEMENT_CONDITIONS&open=true`)        | —                                                                                                                             | unchanged                                                                                                                                                                                                                                                        | —                                  | —         | `opslog.view`                                 |

The Super Admin figures are also the ones already on `main`'s dashboard for the owner (the WP12
business section), so the gate is unchanged: a non-owner's dashboard never showed them, and the
server refuses them regardless.

### Sidebar counters (`/nav-counters`)

| Counter                  | Link                          | Permission      | Predicate                                                                                                                                          |
| ------------------------ | ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openConditions`         | `/alerts`                     | `opslog.view`   | `operational_events` with `code ∈ MANAGEMENT_CONDITION_FAILURE_CODES`, `resolved_at IS NULL` — the dashboard's "needs attention" set               |
| `ticketsAwaitingSupport` | `/tickets`                    | `tickets.view`  | `status ∈ TICKET_AWAITING_SUPPORT_STATUSES` = OPEN, WAITING_FOR_SUPPORT (the next word is support's)                                               |
| `unhealthyPanels`        | `/panels`                     | `panels.view`   | `status = 'ACTIVE'` AND latest probe `∈ NAV_ATTENTION_PANEL_HEALTH_STATES` (DEGRADED, UNREACHABLE, AUTH_FAILED). A disabled panel is never counted |
| `unreconciledServices`   | `/services`                   | `services.view` | `state = 'UNRECONCILED'`                                                                                                                           |
| `refundRequestsAwaiting` | `/services` (refund requests) | `refunds.view`  | `state ∈ SERVICE_REFUND_REQUEST_ATTENTION_STATES` = OPEN, EXECUTING, FAILED — the page's own attention queue                                       |
| `paymentsUnknown`        | `/payments`                   | `payments.view` | `state = 'UNKNOWN'`, awaiting reconciliation                                                                                                       |

Considered and not added: **receipts awaiting review**. A card-to-card receipt is reviewed in
Telegram (the Web Admin can confirm on one payment, but has no list filter for "has an
unreviewed receipt"), so a badge would count a set its link cannot show. **Orders awaiting
payment** are not attention (owner revision 3, recorded on the WP12 dashboard).

Each counter reads at most `COUNTER_CAP` rows (`count(*)` over a `LIMIT`ed subquery), so a
pathological backlog costs what a large one does; the value 1000 means "1000 or more".

---

## 4. Also on `main`'s dashboard, and where each goes

Nothing currently on `/` disappears. Part 2 recomposes; this is the inventory it is held to.

| On `main` today                                                                                                                                                                                                                                                                   | Source                           | In the new composition                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business section (owner): range picker, KPIs (sales, revenue, successful orders, new users, new services, renewals, top-up, active services; new buyers, active customers, trials, discount), trend chart (revenue / sales / new users / renewals), top products, failure summary | WP12 `/reports/*`                | KPI rows + the two charts from `/dashboard/summary`; the remaining report figures on a secondary card from `/reports/summary` (5 min); top products and failure summary kept as cards |
| System status (readiness dependencies)                                                                                                                                                                                                                                            | `GET /system/readiness` (15 s)   | kept, compact                                                                                                                                                                         |
| Panel distribution by health, by provider                                                                                                                                                                                                                                         | one page of `GET /panels` (60 s) | exact counts from `/dashboard/operations` (30 s)                                                                                                                                      |
| Needs attention (open management conditions)                                                                                                                                                                                                                                      | `GET /ops-log` (15 s)            | kept                                                                                                                                                                                  |

---

## 5. Tests and falsification

- `tests/integration/dashboard.test.ts` (16 tests, real HTTP and SQL on the agent's own
  database): each figure against a hand-seeded Tehran day with the traps listed in its
  docblock; agreement figure-for-figure with `/reports/summary` and `/reports/trend` for the
  same range; today and this month on a stopped clock; tenant isolation for all three routes;
  the business refusal (403, recorded) for three non-owner roles and 401 without a session;
  withheld operations sections and counters that record NO denial; the counter cap.
- `tests/unit/dashboard-aggregates.test.ts` (9 tests): the sale kinds partition exactly the
  sales; the fold; the fleet aggregation; `healthViewOf` agrees with `readHealth` for every
  status × stored state; every counter and section names a real permission; the new
  registry entries exist.
- `tests/integration/reports.test.ts` still passes unchanged (21 tests) over the refactored
  `failures()` and `trend()`.

**Mutation evidence.** Each rule below was reverted on its own against the committed tree,
the two suites above were run, and the change was restored (script:
`python3 mutate.py` in the agent's scratchpad; results recorded here).

| #   | Mutation                                                      | Failed                                                                |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| M1  | the owner role is not required (`ReportAccess`)               | refuses the business summary to every non-owner                       |
| M2  | a window includes its end instant (`<` → `<=`)                | selected period; sales by kind; today and this month                  |
| M3  | today compared with ALL of yesterday, not like for like       | today and this month                                                  |
| M4  | a bucket not yet begun drawn as a value                       | today and this month (hours after now must be null)                   |
| M5  | a renewal classified as a new sale (`dashboardSaleKindOf`)    | 3 unit tests; sales by kind                                           |
| M6  | top-ups admitted to the payment-method share                  | method share                                                          |
| M7  | a disabled panel keeps its probe's state (`healthViewOf`)     | unit fleet test; fleet                                                |
| M8  | archived panels counted in the fleet                          | fleet                                                                 |
| M9  | a disabled panel counted as unhealthy                         | counters; withheld counters                                           |
| M10 | a counter computed without its permission                     | withheld counters                                                     |
| M11 | an operations section computed without its permission         | withheld operations sections                                          |
| M12 | open conditions of every tenant                               | counters; withheld counters; tenant isolation of counters             |
| M13 | a counter reads every row (no `LIMIT`)                        | counter cap                                                           |
| M14 | the expiry window in hours instead of days                    | fleet/provisioning; withheld sections; tenant isolation of operations |
| M15 | tickets waiting for the CUSTOMER counted                      | counters; withheld counters                                           |
| M16 | resolved conditions counted                                   | counters; withheld counters                                           |
| M17 | failed payments read on `created_at` instead of `resolved_at` | selected period                                                       |

---

## 6. Part 2 — the page

`apps/web/src/pages/dashboard.tsx` on the foundation's kit, its pure rules in
`apps/web/src/dashboard-view.ts`, styles only in `styles/pages/dashboard.css` (`dash-*`
classes; no `style` attribute anywhere — every continuous value is an SVG attribute of a kit
chart). The sidebar badges come from `useNavCounters()` (`apps/web/src/nav-counters.ts`).

### What is drawn, top to bottom

| Place                                            | Drawn as                                                                                                                                                                                                                         | Source                                                                                                                                                        | Who                                         | Cadence     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------- |
| page head                                        | title, subtitle, «آخرین به‌روزرسانی» = the server's `generatedAt`, in the tenant's zone and calendar                                                                                                                             | `summary.period` (owner), else `operations.generatedAt`                                                                                                       | everyone                                    | —           |
| period control                                   | امروز · ۷ روز · ۳۰ روز · این ماه · دلخواه + «مقایسه با دورهٔ قبل» + تازه‌سازی (re-asks every business figure; withheld after a final answer)                                                                                     | `?range=` (`TODAY`, `LAST_7_DAYS`, `LAST_30_DAYS` default, `THIS_MONTH`, `CUSTOM` + `from`/`to`), `?compare=0`                                                | owner (it changes only owner figures)       | —           |
| KPI row 1                                        | فروش امروز (+ sales count, hourly sparkline), فروش این ماه (+ count, daily sparkline), سرویس فعال, مشتری جدید (+ sparkline), تمدیدها (+ sparkline from the RENEWAL bars), پرداخت ناموفق (outlined while > 0)                     | `summary.today`, `summary.month`, `activeServices`, `selected.newCustomers`/`newCustomerSeries`, `selected.renewals`/`salesByKind`, `selected.failedPayments` | owner                                       | 60 s        |
| KPI row 2                                        | سرویس‌های رو به انقضا (N روز), پنل‌های فعال `active / total` (red when a probe says UNREACHABLE/AUTH_FAILED, amber for DEGRADED), صف تحویل (queued; amber while UNKNOWN or UNRECONCILED > 0), فروش در این دوره (count + revenue) | `operations.expiring`, `.panels`, `.provisioning`; `summary.selected.sales`/`revenue`                                                                         | per section permission; the last card owner | 30 s / 60 s |
| درآمد روزانه (ساعتی/هفتگی/ماهانه by granularity) | current line + area, previous period dashed while comparing; the period total in the head                                                                                                                                        | `selected.revenueSeries`, `selected.revenue`                                                                                                                  | owner                                       | 60 s        |
| سفارش‌ها و تمدیدها                               | stacked bars: خرید جدید / تمدید / افزودنی                                                                                                                                                                                        | `selected.salesByKind`                                                                                                                                        | owner                                       | 60 s        |
| سهم روش‌های پرداخت                               | donut of confirmed ORDER payments per method + the exact amounts per currency                                                                                                                                                    | `selected.paymentMethods`                                                                                                                                     | owner                                       | 60 s        |
| محصولات پرفروش                                   | top 5, by revenue or count, «مشاهدهٔ همه» → `/reports?tab=products`                                                                                                                                                              | `GET /reports/products`                                                                                                                                       | owner                                       | 5 min       |
| خلاصهٔ خطاها                                     | the WP12 failure strip                                                                                                                                                                                                           | `GET /reports/failures`                                                                                                                                       | owner                                       | 5 min       |
| سایر شاخص‌های دوره                               | successful orders, new services, trials, new buyers, active customers, top-up (amount, count), discount; «گزارش‌های کامل» → `/reports`                                                                                           | `GET /reports/summary`                                                                                                                                        | owner                                       | 5 min       |
| توزیع پنل‌ها                                     | health distribution, then by provider — exact counts, one row per PANEL                                                                                                                                                          | `operations.panels`                                                                                                                                           | `panels.view`                               | 30 s        |
| وضعیت سامانه                                     | readiness dependencies (timing only where reported)                                                                                                                                                                              | `GET /system/readiness`                                                                                                                                       | everyone                                    | 15 s        |
| نیازمند توجه                                     | open management conditions, first-seen time, the count of the rest (a floor when paged)                                                                                                                                          | `GET /ops-log?scope=MANAGEMENT_CONDITIONS&open=true`                                                                                                          | `opslog.view`                               | 15 s        |
| sidebar badges                                   | alerts (amber), tickets, panels (red), payments (amber), services = unreconciled + refund requests (red while any is unreconciled); zero or withheld draws nothing                                                               | `GET /nav-counters`, one request                                                                                                                              | per counter permission                      | 60 s        |

**Deltas** are drawn only while comparison is on, worded by the reports' one rule
(`describeChange`: `—`, «جدید», or a signed percentage from integer arithmetic), and coloured
by the §2 table through `kpiDelta`'s sense: up-good for revenue, sales, renewals and new
customers; up-bad for failed payments; no delta at all on a gauge (active services, the fleet,
the queue, expiring). Today's and this month's deltas carry their like-for-like caption
(«نسبت به دیروز تا همین ساعت», «نسبت به همین بازهٔ ماه قبل»). The report figures in «سایر
شاخص‌ها» carry an uncoloured movement, as the report pages do.

**Money** is `formatMoney`/`<Money>` over the exact minor-unit string, in the tenant's sales
currency; any other currency taken in a window is listed beside it, never summed into it. A
chart coordinate is the major-unit number, but every number a reader sees (axis, readout,
hidden table) goes back through the same formatter. Chart axes drop the year from a local date
(`06/15`); the page names the period.

**States.** Each section is its own `StateSwitch`: a skeleton while loading, the kit's error
card on failure (a stale-data banner over kept data on a transient failure), and the refusal
copy on a 403 — the business section on a refused summary; the fleet card when the server
withheld `panels` although the session believed it held `panels.view` (the permission list
can be a minute old). A section the viewer does not hold is not drawn and not requested:
a non-owner never asks for `/dashboard/summary` or any `/reports/*`, and a viewer with neither
`panels.view` nor `services.view` never asks for `/dashboard/operations`. A CUSTOM range with
a missing date asks nothing and says to enter both dates.

**Requests.** Switching the period asks for the new summary (and the three report cards);
switching the comparison asks nothing. The report cards keep `BUSINESS_REFRESH_MS`. Nothing
polls faster than its constant, and every poll stops on a final answer (`pollUnlessFinal`).

### Omitted, and why

- **24-hour traffic** — no history exists (`services.traffic_used_bytes` is overwritten by
  each read); drawn nowhere, asserted absent.
- **Location distribution** — owner revision 2 and no location field in the panel contract.
- **Recent purchases, busiest panels, monitor process heartbeats, 12-month subscription growth**
  (reference cards) — no endpoint gives them without either counting a page of rows in the
  browser (lead decision D2) or inventing a history (active services has none). Orders and
  the monitor keep their own pages.
- **The yesterday / previous-month / this-year ranges** on this control — the reference's five
  presets only; `/reports` keeps all eight. A URL naming another range falls back to 30 days
  rather than drawing figures for a period no pressed button names.
- **`/services` badge capping** — a counter is at most `COUNTER_CAP`, which the §3 note
  defines as "that many or more"; since the consistency pass the sidebar draws a badge holding
  a capped counter as a floor («۱۰۰۰+», `navCounterText`), never as an exact number.

### What moved

- `BusinessOverview` (`pages/business.tsx`, COMMERCE-B's file) is no longer mounted on `/`:
  its range picker, KPI grid and trend chart are replaced by the period control, the KPI rows
  and the two charts above; its top-products and failure cards are redrawn here compactly
  over the same report endpoints. The export is left in place for its owner to remove.
- The panel cards no longer walk one page of `GET /panels`, so the partial-fleet caveat and
  its copy are gone; `docs/phase3d-falsification.md` R-01, V5 and W11 cite tests that now pin
  the exact-count successors of those rules (same names, `dashboard.test.tsx` › "the dashboard
  fleet").
- The WP12 dashboard assertions left `reports.test.tsx` for `dashboard.test.tsx`; the two
  pure report rules they also held (range from the URL, the five-minute cadence) stay there.

### Tests and falsification

`tests/web/dashboard.test.tsx` (31 tests; real API client and schemas, `fetch` stubbed):
exact money and no abbreviation; delta wording and colour by sense; the period switch asks
for the reports' range; CUSTOM asks nothing until both dates, then sends them; the comparison
toggle removes deltas and the dashed line and asks nothing; null buckets draw no bar; the
report cards and their links; omitted and withheld sections absent; the 403 refusal state;
no `style` attribute anywhere in the document; the 60 s / 30 s / 5 min cadences; the refresh button re-asks every business figure and is withheld after a refusal; the non-owner
view asks for no business figure; the fleet outline; withheld fleet → refusal; the attention
card's scope and first-seen time; the pure rules (`dashboardSelection`, `compareFromRoute`,
`kpiDelta`, `axisLabel`, the slices); the nav-counter mapping. `tests/web/csp.test.tsx` and
`tests/web/permissions-and-refresh.test.tsx` now stub `/dashboard/operations` in place of
`/panels`. `pnpm web:shots /` renders from `tests/web/shots/fixtures/dashboard.ts` (a
deterministic, internally summed Tehran month around `SHOT_NOW`), with no WARN.

Mutation record (each reverted alone, `dashboard.test.tsx` + `reports.test.tsx` run, restored):

| #   | Mutation                                                   | Failed                                                                                                                     |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P1  | up-bad coloured as up-good (`kpiDelta`)                    | colours a movement by what it means; words and colours a delta                                                             |
| P2  | the comparison in the summary's query key                  | turns the comparison off without asking again                                                                              |
| P3  | the summary polled at the gauges' 30 s                     | re-reads the summary once a minute and the gauges every thirty seconds                                                     |
| P4  | a withheld fleet not treated as a refusal                  | says so when the server withheld a section the session believed it held                                                    |
| P5  | a zero counter drawn                                       | draws nothing for a withheld counter or a zero                                                                             |
| P6  | any report range accepted by the dashboard                 | asks for the five offered ranges only                                                                                      |
| P7  | the summary asked for without the owner standing           | draws the operational figures, and asks for no business figure; asks for no operational section it holds no permission for |
| P8  | a bucket not begun drawn as zero                           | breaks the sales down by kind, and a bucket not yet begun draws nothing                                                    |
| P9  | a gauge given a delta                                      | colours a movement by what it means; turns the comparison off                                                              |
| P10 | a CUSTOM range asked before both dates (`rangeIsComplete`) | asks nothing for a custom range until both dates are applied                                                               |
| P11 | the services badge not loud for unreconciled services      | places each counter beside the link that acts on it                                                                        |
| P12 | deltas drawn whatever the comparison                       | turns the comparison off without asking again                                                                              |
| P13 | the refresh button drawn over a refused summary            | draws no refresh over a refused summary                                                                                    |
