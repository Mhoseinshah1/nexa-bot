# Demo parity audit — finance family

Routes: `/payments`, `/payment-gateways`, `/discounts`, `/referrals`, `/campaigns`, `/resellers`,
`/reseller-plans`, `/reseller-tiers`, `/reports`. Branch `t2/f-finance`. Evidence: `../sidebyside/<route>--{dark,light}--{1440,390}.jpg`
(app left, demo right, `--fixtures demo-parity`), and `payment-gateways-topup-warning--dark--1440.jpg`.
Fixtures: `tests/web/shots/fixtures/demo-parity/finance.ts`. "Phase A" means the shared kit/shell commits already on
`feat/web-admin-demo-parity`, verified here in the side-by-sides.

Shared changes this family needed (kit, additive, opt-in):

| change                                                                                                                                                                                 | commits             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `DataTable` `detail`: a row's full-width detail line under a toggle (the facts a wide list cannot hold as columns at 1440)                                                             | 2c889b1d, cfe70653  |
| Phone cards at 390: first `phoneCards` (a83c3186), folded into the track's one mechanism `DataTable` `stack` / `stack="labelled"` with the row-detail toggle ported onto it (b02c5f41) | a83c3186 → b02c5f41 |
| `shots-fixtures` test parses the named fixture sets (`demo-parity`) with their schemas too                                                                                             | 5a7ad23e            |

## /payments

| #   | difference                                                                                                      | status                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | «وضعیت عملیاتی» showed «—»; demo shows outlined situation pills                                                 | ✅ the column always rendered the server's situation; the fixture now carries it (53431f72). Tones/fill follow the demo (filled when a person must act, outlined otherwise — the demo's `fin-ol`)                                                                                                                 |
| 2   | Numeric pager «۱–۱۰ از N · صفحه ۱ از M» above «تازه‌تر / قدیمی‌تر»                                              | ⛔ nexa-web-design: counted pagers only over a server total; `GET /payments` returns `{payments, nextCursor}` and no total. The keyset pager stays (Phase A X2)                                                                                                                                                   |
| 3   | Tracking code an underlined link without copy icons; an extra «مشتری» column; match the demo's column set/order | ✅ 61572a4f — the nine columns the demo shows at 1440 (id … amount) in its order; who paid, order, the customer's claim, external reference, both times and «باز کردن» are the row's detail (one toggle on the row); «از درگاه دوباره بپرس» stays on the row under the gateway's answer. Link/no-copy: Phase A X7 |
| 4   | Breadcrumb «مالی و پرداخت / پرداخت‌ها و کیف پول»                                                                | ✅ 9b1bb5de (the trail named the page title «مرکز عملیات پرداخت»)                                                                                                                                                                                                                                                 |
| —   | Quick receipt review banner                                                                                     | ⛔ excluded by the owner (on hold)                                                                                                                                                                                                                                                                                |
| own | Horizontal overflow at 1440 (the demo itself scrolls its 16 columns)                                            | ✅ 61572a4f — no overflow (web:shots `tableOverflow: []`)                                                                                                                                                                                                                                                         |
| own | 390: the demo's rows are cards                                                                                  | ✅ f1946c6e, b02c5f41 (the detail stays behind its toggle in the card's corner)                                                                                                                                                                                                                                   |
| own | Toolbar: demo draws search above filters                                                                        | ✅ 3c55279d (search row first, as the demo — owner decision 2026-10-19: follow the demo per page; X8 overridden where the demo differs)                                                                                                                                                                           |

## /payment-gateways

| #   | difference                                                                                                                  | status                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Breadcrumb                                                                                                                  | ✅ Phase A, verified                                                                                                   |
| 2   | Rate stats as four separate cards                                                                                           | ✅ Phase A (X6), verified; «آخرین به‌روزرسانی» now at a fact's size as the demo (907082d9)                             |
| 3   | Multi-line rows: name link, «نام پیش‌فرض» pill and last change below; limits on several lines; stacked key pills with dates | ✅ 907082d9, eb66cc63 (+ fixture 5dec4f02: keys, IPN secret, passed check, missing verify key, a route on for nothing) |
| 4   | «جزئیات فنی» a full-width bordered bar                                                                                      | ✅ 907082d9                                                                                                            |
| own | Track 3 wallet top-up warning kept, styled as the demo's amber callout, a route a line                                      | ✅ d650cfa3 (evidence: `payment-gateways-topup-warning--dark--1440.jpg`)                                               |
| own | Rows at the demo's standard height                                                                                          | ✅ eb66cc63                                                                                                            |
| own | 390 cards, key pill and date on one line                                                                                    | ✅ f1946c6e, eb66cc63                                                                                                  |
| own | Dates read «۱۵ شهریور ۱۴۰۵، ۷:۵۹», demo «1405/07/15 14:31»                                                                  | ⛔ the shared `formatTimestamp` (Persian digits are the project convention; the demo's Latin digits are not spec)      |

## /discounts

| #   | difference                                            | status                                                                                                                |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Breadcrumb                                            | ✅ Phase A, verified                                                                                                  |
| 2   | Price preview a 2×2 grid                              | ✅ 6763a63e                                                                                                           |
| 3   | Actions: pencil icon above the switch; column clipped | ✅ 6763a63e (side by side on a phone card, eb66cc63)                                                                  |
| 4   | Pager labels «تازه‌تر / قدیمی‌تر» in both tables      | ✅ Phase A (X2), verified                                                                                             |
| 5   | Taller rows; scope cell on 2–3 lines                  | ✅ 642b265b (standard row height); scope already 2–3 lines; product/category named without a copy icon (6763a63e, X7) |

## /referrals

| #   | difference                                                 | status                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | «دفتر پورسانت» overflowed: «زمان» and «برگشت‌داده‌شده» cut | ✅ 43038c19, f63b63aa — the demo's columns up to «برگشت‌داده‌شده» on one line each; unrecovered, recorded and decided times are the row's detail. No overflow (web:shots) |
| 2   | Breadcrumb                                                 | ✅ Phase A, verified                                                                                                                                                      |
| 3   | «تحلیل معرف» period a full-width segmented bar             | ✅ a6f4e798                                                                                                                                                               |
| 4   | Codes, names, order ids underlined links                   | ✅ Phase A (X7) + order id as the demo's code link (43038c19)                                                                                                             |
| 5   | ⓘ on «خریدار شده» and «درآمد از معرفی‌شده‌ها»              | ✅ a6f4e798 (on every tile with an explanation; the explanation stays the tooltip)                                                                                        |
| 6   | Pager labels                                               | ✅ Phase A (X2), verified                                                                                                                                                 |
| own | Five analytics tiles in one row; one a row on a phone      | ✅ a6f4e798, eb66cc63                                                                                                                                                     |
| own | Attribution rows at the demo's height                      | ✅ 642b265b                                                                                                                                                               |
| own | Warning callout keeps its ⚠ (demo has none)                | ⛔ X5 (Phase A kit rule: a warning keeps its sign)                                                                                                                        |

## /campaigns

| #   | difference                             | status                                                             |
| --- | -------------------------------------- | ------------------------------------------------------------------ |
| 1   | «کمپین چه کاری می‌کند…» outlined, no ⓘ | ✅ Phase A (X5), verified                                          |
| 2   | Names underlined links                 | ✅ Phase A (X7), verified with the demo's ten campaigns (7b2964f1) |
| 3   | Pager labels                           | ✅ Phase A (X2), verified                                          |
| 4   | Breadcrumb                             | ✅ Phase A, verified                                               |
| own | Rows a third shorter than the demo's   | ✅ 426b2d4e                                                        |

## /resellers

| #   | difference                                                  | status                                                                                     |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Remove «سقف خرید در میرزا (اعمال نمی‌شود)»                  | ✅ already gone on the track branch (no such column or string in `apps/web/src`), verified |
| 2   | Filters row first, then a full-width search with its button | ✅ order Phase A (X8); full width 435d8f51                                                 |
| 3   | Rules card half width, start side                           | ✅ 435d8f51                                                                                |
| 4   | Pager labels; breadcrumb                                    | ✅ Phase A, verified                                                                       |
| own | Rows at the demo's height                                   | ✅ 435d8f51                                                                                |
| own | Names not underlined in the demo                            | ⛔ X7 (names are linkable identifiers, underlined)                                         |

## /reseller-plans

| #   | difference                                                                | status                                                                                                                                                     |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Remove the «این ماه / ماه قبل» control                                    | ✅ 435d8f51 — no control on the card; the month moved into the «فیلترها» panel (same request), so no capability is lost                                    |
| 2   | Four equal full-width cards, none highlighted                             | ✅ 435d8f51 (neutral: X6, Phase A); one a row on a phone (eb66cc63)                                                                                        |
| 3   | Pager under the progress table («قبلی / ۱–۱۰ از ۱۱ · صفحه ۱ از ۲ / بعدی») | ✅ shown with the demo's eleven rows (6795606f) as «قبلی / صفحه ۱ / ۲ / بعدی»; the «۱–۱۰ از ۱۱» count ⛔ nexa-web-design (the report sends no total field) |
| 4   | «معلق» pill beside the tier; breadcrumb                                   | ✅ pill already drawn, visible with the fixture (6795606f); breadcrumb names the menu entry «پلن‌ها و حداقل فروش» (9b1bb5de)                               |
| own | Per-tier plans table showed raw ids for unknown subjects (fixture)        | ✅ fixture uses the registry's panels/categories (6795606f)                                                                                                |

## /reseller-tiers

| #   | difference                                                   | status                                          |
| --- | ------------------------------------------------------------ | ----------------------------------------------- |
| 1   | «مجوزها» one vertical list, a kind a line                    | ✅ 435d8f51 (+ the demo's four tiers, 6795606f) |
| 2   | «سطح تازه» footer: hint start side, «ساخت سطح» end, one row  | ✅ 435d8f51 (wraps on a phone)                  |
| 3   | Header buttons at the bottom of the header block; breadcrumb | ✅ Phase A (X3, X1), verified                   |
| own | Rows read from the top line                                  | ✅ 435d8f51                                     |
| own | The form's warning keeps its ⚠                               | ⛔ X5 (warning keeps its sign)                  |

## /reports

| #   | difference                                                                           | status                                                                                                                    |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Six KPI cards in the first row, then top-up and active services; ⓘ icons             | ✅ a6f4e798 (one a row on a phone, eb66cc63; fixture e5db285b)                                                            |
| 2   | Trend: y-axis, x dates, grid lines, filled area; no second legend                    | ✅ a6f4e798 — y ticks are grouped figures, never abbreviated («20M» ⛔ the repo's chart rule); test in `reports.test.tsx` |
| 3   | Breadcrumb                                                                           | ✅ Phase A, verified                                                                                                      |
| own | Period picker a full-width track                                                     | ✅ a6f4e798                                                                                                               |
| own | 390: report tables as cards                                                          | ✅ f1946c6e                                                                                                               |
| own | 390: PageHead refresh full width and the tab rail wrapping into two rows in the demo | ⛔ shared shell/kit (PageHead actions, `Tabs`) — not this family's files; reported to the lead                            |
