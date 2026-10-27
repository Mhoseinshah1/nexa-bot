# R11 A1 — Web Admin vs the approved demo (all but A1.1 / B1)

Branch `fix/r11-webadmin-demo-parity`. Input: the owner's report `NEXA-WEBADMIN-VS-DEMO.pdf` (main 2117ebc vs
`approved-demo.html`). B1 (the new-customer count) is another PR. Side-by-side screenshots (1440 and 390, dark and
light, the routes changed): `/home/user/r11-a1-shots/` (app left, demo right, demo-parity fixtures).

## What changed

### 1. Latin digits everywhere (report B2, S2, items 2-5, 20) — commit `Web Admin: Latin digits everywhere`

Owner decision: the admin draws Latin digits; the Jalali CALENDAR stays.

- `base.css`: `font-feature-settings: 'ss01'` removed (it drew Latin figures in Persian shapes, and with `tabular-nums`
  spread them apart: "0 0 25,0"); the now-no-op `font-feature-settings: normal` resets on `.ltr` / `.ca-name` go too.
- Every formatter is `fa-IR-u-nu-latn`: `format.ts` (date-time, date), `list-search.tsx` (read-at pill),
  `ops-list-filters.ts`, `file-picker.tsx`, `handoff-context.tsx`; `business.tsx`/`@nexa/i18n` already were.
  `faDigits` (Persian digits for the Jalali date field) became `plainDigits` (Latin; also normalises typed Persian digits).
- `apps/web/src/i18n/web.fa.ts`: every Persian digit in a string became Latin and nothing else in the strings changed
  (a normalisation the owner ordered, not a copy rewrite).
- Guard: `tests/web/setup.ts` fails ANY web test whose rendered DOM holds U+06F0-U+06F9 (text or attribute; a typed
  `value` and an explicit opt-out are exempt); `tests/web/latin-digits.test.tsx` pins the catalogue, each formatter, the
  date field and the stylesheet.
- Docs: the "Latin digits" line of Demo parity in `redesign-status.md` (it lives at
  `.claude/skills/nexa-web-design/references/redesign-status.md`; there is no `docs/web-redesign/redesign-status.md`) is
  reversed and records the decision; the `format.ts` comments are updated.

### 2. Global search (B3 / S1 / item 6) — commits `Contracts: global search…`, `Global search: one permission-checked read API…`

- Contract (own commit): `GLOBAL_SEARCH_ROUTES`, `globalSearchQuerySchema` (q 1-64, limit 1-10), response schema. No
  new permission.
- `GET /api/admin/v1/search?q=&limit=` -> `GlobalSearchService` (commerce/global-search) over the three EXISTING list
  services (tenant scope, index-bounded search and each list's own permission check are theirs). A kind is searched only
  when the actor holds that kind's own list permissions (customers: `users.view` AND `users.search`; orders:
  `orders.view`; services: `services.view`), read once through `PermissionGuard.permissionsOf`; a kind the actor may not
  read is ABSENT (not an empty group, not an error). `q` is classified by `classifyListSearch` as every list's `q` is.
  <=`limit` (default 5, max 10) hits per kind, exact `hasMore` (asks `limit+1`). Read-only: no write, outbox, idempotency
  key or `ScopeActivityReader` (those are write-path rules).
- Web: `CommandSearch` (top bar / Ctrl+K) asks after 300 ms from two characters, draws the groups under Persian
  headings with the state name of the lists, arrow keys through pages then records, "failed" line while the page results
  keep working. Placeholder is the demo's («جست‌وجوی مشتری، سفارش، سرویس…»).

### 3. Demo-parity UI (commits `…level KPI cards, compact chart axes, link style`, `…pagers, accordions, panel names, phone search`, `Control API: state the size…`, `Contracts: optional server total…`)

See the table.

## Report items

| ID                                                                                       | Result                   | How / why                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 new customers count                                                                   | not mine                 | another PR                                                                                                                                                                     |
| B2 / S2 / items 2-5, 20 Latin digits                                                     | fixed                    | see 1; docs updated                                                                                                                                                            |
| B3 / S1 / item 6 global search                                                           | fixed                    | see 2                                                                                                                                                                          |
| B4 / item 7 KPI cards staggered, uneven height (1440 and 390)                            | fixed                    | zero-specificity `.card + .card` margin pushed cards 14px; grids reset it (base.css); a 24-route probe found two more (`dash-figures`, appearance `bx-side-split`), reset too  |
| item 8 / dashboard + reports Y axis full numbers                                         | fixed                    | compact axis (`21M`, `5.3M`); readouts/tables keep the exact figure                                                                                                            |
| item 9 orders+renewals chart scale/height                                                | fixed                    | tight ceiling (`tightCeiling`): stacked 69 -> 18/36/54/72 instead of 100                                                                                                       |
| S10 / item 10 phone list search squeezed, placeholder cut                                | fixed                    | full-width box, buttons beneath (ui.css)                                                                                                                                       |
| item 11 UUID instead of panel name (/custom-service, /service-locations)                 | fixed                    | the uuid came from fixture ids no panel owned (fixtures corrected) AND an unnameable panel was drawn as its id: now a Persian word, never the uuid                             |
| S8 / item 12 /content no paging                                                          | fixed                    | ten per page, counted pager over the server `total` (new optional field on `GET /templates`)                                                                                   |
| item 13 /ops-group wall of toggles                                                       | fixed                    | one closed accordion per topic (+ send options), summary counts types on                                                                                                       |
| S8 / item 14 numbered pager on every list                                                | NOT fixed                | the keyset lists return no total; a count query per list is the owner's call -> OQ-R11-A1-01. Done where the list holds all its rows and a total is cheap: /content, /features |
| item 15 pager on the revenue chart's range                                               | not fixed                | the demo pages a chart's days by a client count; the rule is no client counts/offsets, and a chart is not a list                                                               |
| S3 bell has no counter                                                                   | already supported        | `NotificationBell` draws the unread count; the default shot state has none unread (`NEXA_SHOTS_SHELL=attention` photographs the demo's state)                                  |
| S4 / item 16 sidebar badges                                                              | partly fixed             | tickets badge is warn (yellow), as the demo; services' red badge is real data (unreconciled services)                                                                          |
| S5 legacy items under «فروش و محصولات»                                                   | not a diff               | the legacy gate is off in the fixture; nothing to change                                                                                                                       |
| S6 / item 19 underlined links                                                            | fixed                    | faint dashed rule + bold names, as the demo's cells measure                                                                                                                    |
| S7 / item 19 extra «کد» and «مشاهده» columns                                             | kept                     | owner-approved function from main; the report says so itself                                                                                                                   |
| S9 page title/spacing                                                                    | not reproducible         | measured identical at 1440 and 390 (25px/800, 21px/800; same gap)                                                                                                              |
| S11 theme icon (sun in light)                                                            | kept                     | the control cycles system/dark/light and its icon names the current choice; the demo has two states                                                                            |
| S12 «خوانده‌شده در» pill digits                                                          | fixed                    | Latin digits                                                                                                                                                                   |
| /dashboard donut legend percentages                                                      | fixed                    | dashboard legend prints none (other donuts keep them)                                                                                                                          |
| /dashboard system status 6 tiles vs 4, attention list English severity                   | kept                     | data / owner-approved Persian severity                                                                                                                                         |
| /users times rounded, /products «tab» etc.                                               | data                     | fixture / main decides                                                                                                                                                         |
| /users/:id «انتقال حساب» pink                                                            | matches                  | the demo's button is the same solid danger; soft danger buttons keep the glass theme's red capsule                                                                             |
| /services tabs, /extra-devices title+tabs, /payments banner, support-analytics KPI count | kept                     | main's function / data; the quick-receipt banner stays off                                                                                                                     |
| /payment-gateways FX card                                                                | fixed (digits, grouping) | the rate drew `98450` / `1640.83`: now grouped                                                                                                                                 |
| /reports KPI layout                                                                      | kept                     | the app lays out 6+2 as the demo does                                                                                                                                          |
| /panel-health unequal card heights                                                       | not reproducible         | rows equalise (measured)                                                                                                                                                       |
| /settings every setting open (item 17)                                                   | fixed                    | each setting an accordion; `SettingRow` stays mounted                                                                                                                          |
| /features long (item 17)                                                                 | fixed                    | numbered pager over the server `total`                                                                                                                                         |
| /bot-buttons preview, /support-ai field order, /appearance S8                            | kept / S8 see item 14    | preview colours are data; no function change for order                                                                                                                         |
| /recovery, /system                                                                       | data / fixture           |                                                                                                                                                                                |
| item 20 redesign-status + format.ts comment                                              | fixed                    |                                                                                                                                                                                |

## Tests

- `tests/unit/global-search.test.ts` 9; `tests/integration/global-search.test.ts` 8 (found by id/@username/product/provider,
  cross-tenant twin, per-kind permissions, users.view without users.search, none of the three, 401, malformed queries,
  bounds + hasMore); `tests/web/global-search.test.tsx` 5; `tests/web/latin-digits.test.tsx` 6 (+ the global DOM guard in
  `tests/web/setup.ts`); `tests/web/chart-axis.test.tsx` 5; `tests/web/r11-demo-parity.test.tsx` 15;
  `tests/integration/control-plane-http.test.ts` (+2 assertions: `total`).
- Mutation checks (rule broken -> named test red -> restored -> green):

| Rule                                       | Mutation                                                            | Red                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| customers need users.view AND users.search | CUSTOMER perms = `users.view`                                       | unit "needs users.view AND users.search", unit "table", integration "users.view but not users.search" |
| a kind needs its permission                | check ignored                                                       | 3 unit tests                                                                                          |
| hits bounded by `limit`                    | `slice(0, limit)` removed                                           | unit "bounds the hits"                                                                                |
| tenant isolation                           | services read under a fixed tenant                                  | integration "never returns another tenant's record"                                                   |
| Latin digits                               | `ss01` back / `fa-IR` in file-picker / a Persian digit in web.fa.ts | latin-digits styles, formatters, catalogue                                                            |
| KPI margin reset                           | `.dash-kgrid` removed from the reset                                | r11 "zeroes the sibling margin"                                                                       |
| link rule                                  | `text-decoration: underline` back                                   | r11 "faint dashed rule"                                                                               |
| phone search                               | `flex: 1` instead of `1 1 100%`                                     | r11 "full line"                                                                                       |
| content/features paging                    | paging hidden-by-page removed / slice removed                       | r11 content + features tests                                                                          |
| tickets warn                               | tone removed                                                        | r11 "warn badge"                                                                                      |
| ops-group accordions                       | topics open by default                                              | r11 "folds each topic"                                                                                |
| panel name                                 | fallback to the id                                                  | r11 "says a Persian word"                                                                             |
| tight ceiling / donut shares               | replaced                                                            | chart-axis (3), r11 donut                                                                             |

## Gate

All through `scripts/claude/run-gate.sh`, on head f7617640 (origin/main merged in): `pnpm typecheck` ok,
`pnpm lint` ok, `pnpm check:i18n` ok, `pnpm format:check` ok, `scripts/check-boundaries.sh` ok; web suite in three
parts passed=890/1081/1420 failed=0 (3391); integration `global-search` + `control-plane-http` passed=33 failed=0;
unit `global-search` + web token contrast/touch passed=79 failed=0. Side-by-side screenshots: 13 routes x
{1440, 390} x {dark, light} = 52 images in `/home/user/r11-a1-shots/` (app left, demo right).

## Decisions

- Global search returns an absent group (not an empty one) for a kind the actor may not read.
- `total` is optional on the wire (an older server still parses; a client draws no «of N» without it).
- Not every Persian digit in the repository was converted: server-written text and the shared `@nexa/i18n`
  catalogue (customer-facing in Telegram) keep theirs (OQ-R11-A1-03).
- A service is found by its exact panel username or code, as the services list's own search finds it.

## Migrations

None.

---

## A1.1 — «مشتری جدید» / «کاربر جدید» count only NEXA customers (merged in from fix/r11-webadmin-demo-parity-reporting)

# R11 A1.1 — «مشتری جدید» / «کاربر جدید» no longer count Mirza-imported customers

## What changed

**The bug (owner's comparison report, B1).** `DrizzleReportingRepository.newCustomers` counted
`customers` rows with `created_at` inside the window and nothing else. The Mirza importer
(`drizzle-legacy-importer.repository.ts`) writes every customer it carries with
`created_at = first_seen_at = last_seen_at =` the import instant, and
`drizzle-customer-source-marker.ts` then sets `source = 'MIRZA'`. So any window that held the import
day reported the whole Mirza user base as new registrations (198,538 in the owner's screenshots).
It reached the owner in four places:

1. Dashboard KPI «مشتری جدید»: `ReportingService.dashboard` → `selected.newCustomers`, current and previous.
2. Dashboard sparkline under that card: `selected.newCustomerSeries` (`trend(NEW_USERS)`).
3. `/reports` «کاربر جدید»: `ReportingService.summary` → `newUsers`, current and previous, so the
   «نسبت به دورهٔ قبل» percentage the web computes from that pair was distorted too.
4. `/reports` trend chart with the NEW_USERS metric.

**The fix.** `apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository.ts`
gets one documented fragment, `nexaCustomer = c.source = 'NEXA'`, beside the existing `saleOrigin` and
`notLegacyImport` fragments, and both statements that mean "new customer" use it:

- `newCustomers(scope, window)`: `... AND c.source = 'NEXA' AND created_at ∈ [from, to)`.
- `trend(..., 'NEW_USERS', ...)`: the `customers c` source now carries the same predicate.

This is the predicate the nightly report already uses for its new customers
(`ops-log/infrastructure/drizzle-nightly-report.reader.ts`, `source = 'NEXA'`). A customer who was
already NEXA's when the import ran (`reason_code = 'EXISTING_CUSTOMER'`) is never re-marked, so it keeps
`source = 'NEXA'` and its own `created_at`, and still counts. `customers_tenant_created_idx`
`(tenant_id, created_at)` still drives both statements; `source` is a recheck on the same rows
(`reporting-plan.test.ts` green).

**Every other customer-related count in the repository was checked:**

| Figure                                                                        | Changed? | Why                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newCustomers` (KPI, summary `newUsers`, both periods)                        | yes      | meaning is "registered here in the window"                                                                                                                                                   |
| `trend` NEW_USERS (sparkline, /reports chart)                                 | yes      | same metric, bucketed                                                                                                                                                                        |
| `activeCustomers`                                                             | no       | a state _now_: an ACTIVE service, or a recent sale. An imported customer whose service is live is really active today; its sale half already excludes `LEGACY_ADOPTION` through `saleOrigin` |
| `activeServices`                                                              | no       | current state of live services; an imported live service is a live service                                                                                                                   |
| `newBuyers`, `newServices`, sales/revenue/renewals, referred sales, resellers | no       | already order-based and restricted to sale origins by `saleOrigin`, so an adoption is never a first purchase or a new service                                                                |
| `referralSignups`, `topReferrers` signups                                     | no       | an imported referral carries Mirza's own `attributed_at` (`legacy-materialize` referral step), never the import time, so it falls on the day it really happened                              |

**Docs.** The metric definitions now say `source = 'NEXA'`: `docs/wp12-business-analytics-audit.md`
(table row 4, `customers.new`) and `docs/web-redesign/dashboard.md` (the «مشتری جدید» row).

No contract change, no migration, no web change (the web already renders whatever pair the API returns).

## Tests

The `customer(tenantId, createdAt, source = 'NEXA')` seed helper in both suites gained an optional
`source`; `MIRZA` writes the row as the import leaves it (`source = 'MIRZA'`, `source_ref = 'user:<n>'`).

- `tests/integration/reports.test.ts` › _counts no customer the Mirza import carried as a new user, on
  either side of the comparison_: adds two MIRZA customers inside D (11:00, 11:15), one MIRZA the day
  before (11:00) and one NEXA on D (11:30). Asserts `summary.newUsers = {current: 3, previous: 1}` (not
  `{5, 2}`), and the NEW_USERS trend: buckets 9/10/11 = 1 each on D, previous bucket 9 = 1 and 11 = 0,
  totals 3 and 1.
- `tests/integration/dashboard.test.ts` › _counts no customer the Mirza import carried as a new customer,
  in the card, its comparison or its sparkline_: the same seed; asserts
  `selected.newCustomers = {current: 3, previous: 1}`, sparkline bucket 11 = 1, total 3.

Counts: reports + dashboard suites 40/40; with reporting-plan, financial-reports and order-origin
68/68; unit `dashboard-aggregates` + `financial-statement` 22/22.

| Mutation                                   | Result                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| drop `nexaCustomer` from `newCustomers`    | both new tests red: `{current: 5, previous: 2}` ≠ `{3, 1}` (38 passed / 2 failed) |
| drop `nexaCustomer` from `trend` NEW_USERS | both new tests red: bucket 11 is `'3'`, expected `'1'` (38 passed / 2 failed)     |
| restore                                    | 40/40 green                                                                       |

Local gate: `format:check`, `typecheck`, `lint` exit 0; the integration and unit suites above.

## Decisions

- "New customer" means "registered with this installation in the window", so imported customers are
  excluded even on the import day, whatever their Mirza registration date was. Same definition as
  the nightly report.
- Active customers/services keep imported customers: they describe the present, not an arrival.
- Imported referrals keep counting at their real historical attribution time.

## Migrations

None.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
