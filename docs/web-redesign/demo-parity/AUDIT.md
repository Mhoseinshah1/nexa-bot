# Demo parity audit — Track 2

Every bullet of [`DIFFS.md`](./DIFFS.md), plus every difference the page agents found themselves at
1440 light and at 390, with its outcome: ✅ fixed (commit) or ⛔ excluded (the rule). Evidence:
[`sidebyside/`](./sidebyside/) — `<page>--<theme>--<width>.jpg`, APP left, DEMO right, rendered
with the `demo-parity` fixture set (`tests/web/shots/fixtures/demo-parity/`) by
`scripts/web-shots/side-by-side.mjs`.

Per-route tables live in one file per page family:

| Family                | Routes                                                                                                                                                       | Audit                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Customers and support | users, users/:id, tickets, support, business-chats, notification-center, support-ai, support-analytics, support-knowledge, support-learning, knowledge-build | [audit/customers.md](./audit/customers.md) |
| Services and orders   | services, services/:id, orders, extra-devices, custom-service, service-locations, trials, compensations, bulk-operations, bulk-operations/new                | [audit/services.md](./audit/services.md)   |
| Finance and sales     | payments, payment-gateways, discounts, referrals, campaigns, resellers, reseller-plans, reseller-tiers, reports                                              | [audit/finance.md](./audit/finance.md)     |
| Panels and system     | panels, panels/:id, panel-health, providers, ops-group, system, alerts, audit-log, incidents, admins, roles, account                                         | [audit/infra.md](./audit/infra.md)         |
| Bot and catalogue     | appearance, bot-buttons, bots, broadcasts, content, client-apps, features, notifications, reminders, settings, terms, products, product-categories           | [audit/bot.md](./audit/bot.md)             |
| Recovery and legacy   | recovery, legacy-products, legacy-services, legacy-cutover (+ the route sweep: every nav route is owned)                                                     | [audit/recovery.md](./audit/recovery.md)   |

## Cross-cutting (X1–X11)

| Item | Difference                                                                                | Status                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1   | Breadcrumb in the page header on every page                                               | ✅ 3d51d2b6, 938fec68 — derived from `nav.ts` (`page-trail.ts`); a page with no group above it (dashboard, `/account`) draws none, as the demo                                                                                                                                         |
| X2   | Pager labels «تازه‌تر / قدیمی‌تر»; counted pager where the demo has one                   | ✅ fd5dfbe5, 4f618050 (keyset labels on 45 lists, the unavailable direction disabled). ⛔ counted pager «… از N» except where the endpoint returns a server total (reports products, top referrers) — nexa-web-design: no client-side counts; lists ordered by code keep «قبلی / بعدی» |
| X2   | "Paginate at 10" on pages that list everything                                            | ⛔ no API change was made for it; such pages keep main's paging or use a height-limited scroll pane (features) — nexa-web-design / PROMPT rule                                                                                                                                         |
| X3   | Header actions below the subtitle                                                         | ✅ 3d51d2b6                                                                                                                                                                                                                                                                            |
| X4   | «خوانده‌شده در …» + round refresh; tickets «خواندن دوباره»                                | ✅ 3d51d2b6                                                                                                                                                                                                                                                                            |
| X5   | Callouts outlined, no icon                                                                | ✅ 22c931ce, ccf904b5 (no icon on any tone, as the demo's 24 warn/error notes)                                                                                                                                                                                                         |
| X6   | Stat strips: separate neutral cards, large numbers                                        | ✅ 82681e6b, d2ed7d96                                                                                                                                                                                                                                                                  |
| X7   | Linkable identifiers underlined, ids monospace                                            | ✅ d7f4bda0; copy buttons kept but hidden until hover/focus as the demo's `.cpb` (11f39ca4, 0204b302)                                                                                                                                                                                  |
| X8   | Filters row first, then search; saved-filter chips count                                  | ✅ dd8f02b5 (count = this admin's own saved views). ⛔ saved-filter RESULT counts — no API field (redesign-status: not carried over)                                                                                                                                                   |
| X9   | No horizontal table overflow at 1440                                                      | ✅ 9dee7037, ed676810, plus per-page wrapping; `web:shots` now fails on a sideways table at ≥1280px                                                                                                                                                                                    |
| X10  | Filled vs outlined pills                                                                  | ✅ 4f4f5e1a                                                                                                                                                                                                                                                                            |
| X11  | Shell: top bar, sidebar, title placement, incident banner, 390 layout                     | ✅ 938fec68 (title out of the top bar; brand block; bot switcher compact in the owner menu; soft active pill; amber group dot only from existing counters; version line; incident card only for a real open incident)                                                                  |
| own  | Scroll position kept across page changes (why v0.7.2's dashboard controls looked missing) | ✅ 938fec68 — reset on pathname change only, never on tab/filter changes                                                                                                                                                                                                               |
| own  | Tables at 390 as labelled row cards                                                       | ✅ c66bfc96, ef5dd180, 8e9998a9 — one `stack` mechanism, default below 820px                                                                                                                                                                                                           |
| own  | Card heads without a rule; tab strips wrap; header buttons full-width at 390              | ✅ 9b089883, 698e1642, 008151b5                                                                                                                                                                                                                                                        |
| own  | Dates in the demo's numeric form                                                          | ✅ 8592082d (`formatTimestamp` numeric by default; Persian digits)                                                                                                                                                                                                                     |

## Dashboard (`/`)

| #   | Difference                                                                             | Status                                                                                                           |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | KPI area: hero «فروش امروز» 5×2, «فروش این ماه» 3×2, four 2×2 tiles                    | ✅ 32d43709 (fixture 9e4970d0)                                                                                   |
| 2   | صف رسیدگی: side column, severe tiles 4/row, compact rows 3/row; empty keeps the column | ✅ 32d43709                                                                                                      |
| 3   | Period control, compare switch, refresh render                                         | ✅ 32d43709 — the cause was the shell keeping another page's scroll offset; test renders them with empty data    |
| 4   | وضعیت سامانه service cards with pill + latency                                         | ✅ 32d43709 — the dependencies the API reports; ⛔ provisioner/monitor/backup-storage tiles (no API field)       |
| 5   | توزیع پنل‌ها segmented bar per group                                                   | ✅ 32d43709                                                                                                      |
| 6   | خلاصهٔ خطاها 5 bordered mini-cards                                                     | ✅ 32d43709                                                                                                      |
| 7   | «وضعیت عملیاتی» section label                                                          | ✅ 32d43709                                                                                                      |
| 8   | Delta pills; gradient sparklines; flat baseline for zero/one point                     | ✅ bd93015c, 32d43709                                                                                            |
| 9   | درآمد روزانه range pager «۱–۱۰ از ۳۰»                                                  | ⛔ the demo pages a client-held bucket table — client-side offset paging with a client count (nexa-web-design)   |
| 10  | نیازمند توجه severity pills, timestamps, footer                                        | ✅ already present; pills in Persian (owner: no English in the UI)                                               |
| 11  | Compare is a toggle switch                                                             | ✅ 32d43709                                                                                                      |
| 12  | Row 3 equal widths                                                                     | ✅ 32d43709                                                                                                      |
| own | Empty period: one large empty card in place of the period blocks                       | ✅ 2c785d38 — decided only from the server's period figures; the «وضعیت عملیاتی» section stays (not period data) |
| own | «12.50 USDT» drawn with six decimals                                                   | ⛔ `formatMoney` always prints every minor-unit digit; rounding would change its contract                        |

## Documented exclusions (PROMPT.md)

The quick receipt review banner on payments (owner: on hold); the demo-only «نمایش حالت‌ها» state
bar; the «داده نمونه» badge; the incident banner's sample content (its style is in scope and
it shows only for a real open incident); the demo's Latin digits (Persian digits are the
project convention); any figure the API has no field for.
