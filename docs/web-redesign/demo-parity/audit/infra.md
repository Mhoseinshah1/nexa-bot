# Audit — infrastructure and system family

Routes: `/panels`, `/panels/:id`, `/panels/new`, `/panel-health`, `/providers`, `/ops-group`,
`/system` (status, diagnostics, monitor, admins, roles), `/alerts`, `/audit-log`, `/incidents`,
`/account`. Evidence: `../sidebyside/<page>--{dark,light}--{1440,390}.jpg` (app left, demo right)
under `--fixtures demo-parity` (`tests/web/shots/fixtures/demo-parity/infra.ts`). Pages:
`panels`, `panel-detail`, `panel-new`, `panel-health`, `providers`, `ops-group`, `system`,
`system-diagnostics`, `system-monitor`, `system-admins`, `system-roles`, `alerts`, `audit-log`,
`incidents`, `account`.

SHAs are on branch `t2/f-infra`. Kit change, additive: `PermissionCatalog initialView` (4161c797). The 390 row cards are the
track's one stacking mechanism, `DataTable stack`, now the kit default (this branch's own
`phoneCards`, 7f4364ca and 297cd046, was dropped in the merge 587d2c79; the explicit props went
in 22a7369d). Composition is pinned by `tests/web/infra-demo-parity.test.tsx`
(e3fe2223 and later).

Shared for every route below — ⛔ excluded or owned elsewhere, not repeated per table:

- the incident banner over the header and the «داده نمونه» badge (excluded: sample content / badge);
- the demo's Latin digits and its timestamps (Persian digits are the convention);
- the breadcrumb and the header's action placement — Phase A X1/X3, verified on every route;
- card heads: the demo puts a card's hint on the title's row with no hairline under it; the app's
  `Card` stacks them — cross-cutting (`.card-head`, kit), raised to the lead;
- the tab rail at 390: the demo wraps it onto two rows — kit `Tabs`, wraps on the track head (7ace48d7);
- a header's primary button at 390 is full width in the demo — Phase A `PageHead`, raised.

## /panels

| #   | difference                                               | status                                                                              |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | DIFFS #1 table overflows, «ظرفیت» cut off                | ✅ no overflow at 1440 (Phase A X9 + short failure pills, de4bebfc), verified       |
| 2   | DIFFS #2 «وضعیت» column with «قابل فروش نیست» line       | ✅ present from the server's sellability; fixture rows show every reason (d4870222) |
| 3   | DIFFS #3 «نوع خطا» a short pill, not a sentence          | ✅ `FAILURE_SHORT_LABELS`, sentence as title (de4bebfc)                             |
| 4   | DIFFS #4 breadcrumb                                      | ✅ Phase A — verified                                                               |
| 5   | DIFFS #5 capacity «۱٬۴۲۰ / ۲٬۰۰۰», «(۲)» under it, bar   | ✅ reservations on their own line (de4bebfc)                                        |
| 6   | DIFFS #6 names underlined links                          | ✅ `RefLink` (de4bebfc)                                                             |
| 7   | DIFFS #7 pager «تازه‌تر / قدیمی‌تر»                      | ✅ Phase A X2 (`oldest-first`) — verified                                           |
| 8   | own: provider pill in the code face                      | ✅ de4bebfc                                                                         |
| 9   | own: rows at the demo's height, not dense                | ✅ 4c021f52                                                                         |
| 10  | own (390): one card per row, label … value               | ✅ `DataTable stack` (4c021f52, merge 587d2c79)                                     |
| 11  | own: a name's digits stay Latin («DE-1», not «DE-۱»)     | ✅ name isolated left to right (de4bebfc)                                           |
| 12  | own: capacity bar blue in the demo, accent/ok in the app | ⛔ kit `Progress` tone (tokens), not composition                                    |

## /panels/:id

| #   | difference                                                                       | status                                                                            |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | own: one hero card in the app; page header + six separate stat cards in the demo | ✅ `PageHead` (breadcrumb «… / پنل‌ها / جزئیات پنل») + `stat-grid` (de4bebfc)     |
| 2   | own: lifecycle hint line under the actions                                       | ✅ for an ACTIVE panel the operator may change (de4bebfc)                         |
| 3   | own: «بایگانی» an outlined red pill                                              | ✅ `btn danger` (de4bebfc)                                                        |
| 4   | own: capacity in its stat card on one line                                       | ✅ de4bebfc                                                                       |
| 5   | own: tabs, overview form and side cards                                          | ✅ same order and split — verified                                                |
| 6   | own: «فایل‌های اتصال» tab (Track 3)                                              | ⛔ kept on purpose (Track 3 addition), drawn only for a provider that sends files |

## /panels/new

| #   | difference                                          | status      |
| --- | --------------------------------------------------- | ----------- |
| 1   | own: required marks on نام، ارائه‌دهنده، نشانی پایه | ✅ de4bebfc |
| 2   | own: «ذخیره» the form's full-width last row         | ✅ de4bebfc |

## /panel-health

| #   | difference                                                   | status                                                                           |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | DIFFS #1 cards two a row                                     | ✅ `minmax(min(420px,100%),1fr)` (de4bebfc)                                      |
| 2   | DIFFS #2 «سابقه — در انتظار بسته‌شدن» block                  | ✅ rendered from `current: false`; DE-1 carries one (d4870222)                   |
| 3   | DIFFS #3 current alerts a bulleted list with severity pills  | ✅ list existed; Persian condition names, code as title (de4bebfc); fixture rows |
| 4   | DIFFS #4 amber «فروش جدید متوقف» callout and «ازسرگیری فروش» | ✅ rendered from `drain`; NL-1 drained in the fixture (d4870222)                 |
| 5   | DIFFS #5 error text overflowing the card                     | ✅ short pills; values wrap inside their card (de4bebfc)                         |
| 6   | DIFFS #6 «ناقص» / «آفلاین» neutral; breadcrumb               | ✅ Phase A X6 / X1 — verified                                                    |
| 7   | own: last failure by its short name                          | ✅ de4bebfc                                                                      |
| 8   | own: every card's footer on one line                         | ✅ de4bebfc                                                                      |

## /providers

| #   | difference                              | status                                                                            |
| --- | --------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | DIFFS #1 capability pills empty         | ✅ rendered from `capabilityRegistry`; fixture has the real registries (d4870222) |
| 2   | DIFFS #2 info callout outlined, no icon | ✅ Phase A X5 — verified                                                          |
| 3   | DIFFS #3 names as code-style pills      | ✅ de4bebfc                                                                       |
| 4   | DIFFS #4 RickPanel missing; breadcrumb  | ✅ fixture lists the three adapters (d4870222); breadcrumb Phase A                |
| 5   | own (390): row cards                    | ✅ 4c021f52                                                                       |

## /ops-group

| #   | difference                                                   | status                                                                                                              |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS #1 middle row two equal columns                        | ✅ `ops-group-cols` (9ec6119c)                                                                                      |
| 2   | DIFFS #2 «ارسال مجدد گزارش‌های ارسال‌نشده»                   | ✅ drawn when reports are preserved; fixture has four (d4870222)                                                    |
| 3   | DIFFS #3 «فیلترها» and «بدون فیلتر» above the connect button | ✅ it is the demo's bot choice: the bot select behind the filters button when there is more than one bot (9ec6119c) |
| 4   | DIFFS #4 one compact row per topic                           | ✅ 9ec6119c                                                                                                         |
| 5   | DIFFS #5 deleted-topic red pill; breadcrumb                  | ✅ `MISSING` state in the fixture (d4870222); breadcrumb Phase A                                                    |

## /system (status, diagnostics, monitor, admins, roles)

| #   | difference                                                             | status                                                                                                                                                             |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 breadcrumb                                                    | ✅ Phase A — verified                                                                                                                                              |
| 2   | DIFFS #2 status and build 50/50                                        | ✅ `system-cols` (32e89d13)                                                                                                                                        |
| 3   | DIFFS #3 logs button on the description's row, send icon, full name    | ✅ 32e89d13                                                                                                                                                        |
| 4   | DIFFS #4 dependency names bare monospace                               | ✅ 32e89d13                                                                                                                                                        |
| 5   | own (roles): «فهرست / جدول مقایسه» in the roles card, no second card   | ✅ 9e82d45e (+ `initialView`, 4161c797, additive); the catalogue keeps its list view and search                                                                    |
| 6   | own (roles): roles as rows of one list                                 | ✅ 9e82d45e                                                                                                                                                        |
| 7   | own (admins): roles filled neutral pills; Telegram control plain text  | ✅ 4c021f52                                                                                                                                                        |
| 8   | own (390): dependency and administrator tables as row cards            | ✅ 4c021f52                                                                                                                                                        |
| 9   | own (status, diagnostics): figures differ (outbox down, no stuck rows) | ⛔ data, not composition: the dashboard's demo fixture answers `/system/readiness` and `/system/diagnostics` first (the demo's dashboard and system page disagree) |

## /alerts

| #   | difference                                               | status                                                                                                                                                                                     |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 «رویداد» column, no «کد», no technical expander | ✅ «رویداد» with the Persian title, code as title attribute (93be48d1); «پیام» now Persian from the code (round 2), the server line only behind «جزئیات فنی» |
| 2   | DIFFS #2 «فیلترها» with a count and «وضعیت: همه ×»       | ✅ 93be48d1                                                                                                                                                                                |
| 3   | DIFFS #3 breadcrumb                                      | ✅ Phase A — verified                                                                                                                                                                      |
| 4   | DIFFS #4 pager «تازه‌تر / قدیمی‌تر»                      | ✅ Phase A X2 — verified                                                                                                                                                                   |
| 5   | DIFFS #5 message wraps to two lines                      | ✅ round 2: the Persian message (from the code's label) wraps; English only behind «جزئیات فنی». Test: every contract code has a label (`ops-code-labels.test.tsx`) |
| 6   | own: ten rows and an older page                          | ✅ fixture (d4870222)                                                                                                                                                                      |

## /audit-log

| #   | difference                                                                                                 | status                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | DIFFS #1 open grid of six labelled fields + «اعمال فیلتر» / «پاک کردن فیلترها»                             | ✅ 6256892e; selects and security slices stay in «فیلترها»                                         |
| 2   | DIFFS #2 columns, role sub-line, reason sub-line, entity chips, expandable rows, failed rows tinted, pager | ✅ columns existed; fixture rows (d4870222, e3fe2223); red row tint (6256892e, desk only 9e82d45e) |
| 3   | DIFFS #3 breadcrumb; CSV download icon                                                                     | ✅ Phase A / 6256892e                                                                              |
| 4   | own: action and entity filters plain accent text, entity links quiet                                       | ✅ 6256892e                                                                                        |
| 5   | own: action names read «subject — verb» («پرداخت — تأیید») vs «تأیید پرداخت»                               | ⛔ shared label rule (W5, `audit-action-labels.ts`), not composition                               |
| 6   | own (390): row cards                                                                                       | ✅ 4c021f52                                                                                        |

## /incidents

| #   | difference                                        | status                                                         |
| --- | ------------------------------------------------- | -------------------------------------------------------------- |
| 1   | DIFFS #1 «رخداد تازه» on the header's bottom edge | ✅ Phase A X3 — verified                                       |
| 2   | DIFFS #2 pager; breadcrumb                        | ✅ Phase A — verified                                          |
| 3   | own: four incidents of every status               | ✅ fixture (d4870222)                                          |
| 4   | own: titles underlined in the app                 | ⛔ X7 (a linkable name is an underlined link), kept consistent |
| 5   | own (390): row cards                              | ✅ 4c021f52, 587d2c79                                          |

## /account

| #   | difference                                          | status                                                                                                                                                                                   |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | own: breadcrumb «حساب من» over the title            | ✅ justified: no group sits above `/account` (no nav entry owns it), so — as on the dashboard — there is nowhere to go back to and `page-trail.ts` draws no trail of one (lead decision) |
| 2   | own: password boxes half width                      | ✅ b45080a9                                                                                                                                                                              |
| 3   | own: sign-in events as row boxes                    | ✅ b45080a9                                                                                                                                                                              |
| 4   | own: two sessions and four events                   | ✅ fixture (d4870222)                                                                                                                                                                    |
| 5   | own: a user agent shown whole, the demo shortens it | ⛔ data format (the server's string), not composition                                                                                                                                    |
