# Demo parity audit — the services family

Routes: `/services`, `/services/:id`, `/orders`, `/extra-devices`, `/custom-service`,
`/service-locations`, `/trials`, `/compensations`, `/bulk-operations`, `/bulk-operations/new`.

Evidence: `docs/web-redesign/demo-parity/sidebyside/<page>--<theme>--<width>.jpg` (APP left,
DEMO right) at 1440 dark, 1440 light, 390 dark and 390 light, with the `demo-parity` fixture
set (`tests/web/shots/fixtures/demo-parity/services.ts`). Rules pinned in
`tests/web/services-family-parity.test.tsx`.

Shared pieces this family added (additive, opt-in): `formatTimestampNumeric` (the demo's
«۱۴۰۵/۰۷/۱۴ ۱۹:۳۰», Persian digits, isolated left to right) and `DataTable stack` /
`stack="labelled"` (one card per row at ≤820px, as the demo draws every list at 390).

Phase A SHAs: breadcrumb and header 3d51d2b6 (X1/X3/X4), pagers fd5dfbe5 (X2), callouts
22c931ce (X5), linkable ids d7f4bda0 (X7), toolbar order dd8f02b5 (X8), wide tables
ed676810 (X9), outlined pills 4f4f5e1a (X10).

## services

| #   | difference                                                                     | status                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS: breadcrumb missing («مشتریان و پشتیبانی / سرویس‌ها»)                    | ✅ fixed (Phase A 3d51d2b6)                                                                                                                                                                                                                                                                 |
| 2   | DIFFS: location column shows «—»; demo shows flag + «country — city»           | ✅ the column is the API's own `locationLabel`, drawn as sent — the flag is part of the label the operator configures (the demo's label is literally `'🇩🇪 آلمان — فرانکفورت'`). Fixture rows carry real labels (7adfc80e); a service with no location stays «—» (skill: no fabricated data) |
| 3   | DIFFS: saved-filters chip lacks its count                                      | ✅ already drawn: the count of this admin's own saved views (`lfb-n`, `tests/web/saved-views.test.tsx`); the screenshot browser has none saved, so none is counted — never a result count (redesign-status: no API field)                                                                   |
| 4   | DIFFS: pager labels «قدیمی‌تر / تازه‌تر»                                       | ✅ fixed (Phase A fd5dfbe5)                                                                                                                                                                                                                                                                 |
| 5   | DIFFS: refund table's leftmost columns clipped                                 | ✅ fixed: outcome and time wrap tight, the queue fits at 1440 (de825162)                                                                                                                                                                                                                    |
| 6   | own: list times «۷ شهریور ۱۴۰۵، ۷:۵۷» vs the demo's numeric «1405/07/14 19:30» | ✅ fixed (c66bfc96, 83bc5ec3; Persian digits per owner rule)                                                                                                                                                                                                                                |
| 7   | own: customer column «مشتری نامشخص» vs «@parisa_h 513033985»                   | ✅ the column already draws both from the API; the fixture now carries them (7adfc80e)                                                                                                                                                                                                      |
| 8   | own 390: the table scrolls sideways; the demo draws one labelled card per row  | ✅ fixed (c66bfc96, ef5dd180, 11f39ca4)                                                                                                                                                                                                                                                     |
| 9   | own: Track 3's «فعال / پایان‌یافته / همه» tabs (no demo counterpart)           | ✅ kept, drawn as the demo's `.tabs` rail (the kit `Tabs` already is); no per-tab count — the API has no per-tab total (skill: counts are server totals)                                                                                                                                    |
| 10  | own: last column header «تاریخ خرید» vs the demo's «زمان ثبت»                  | ⛔ Track 3 decision kept: the column is the ORIGINAL purchase the list is ordered by (preamble: keep Track 1/3 additions)                                                                                                                                                                   |
| 11  | own: demo puts the search row above «فیلترها»                                  | ⛔ X8 (Phase A dd8f02b5, DIFFS X: filter row first on every list)                                                                                                                                                                                                                           |
| 12  | own 390: header action «عملیات گروهی…» is a full-width capsule in the demo     | ⛔ shared `PageHead` (Phase A, X3); reported to the lead as cross-cutting                                                                                                                                                                                                                   |
| 13  | own: incident banner and «دادهٔ نمونه» badge in the demo                       | ⛔ excluded (PROMPT.md: sample incident content, sample badge)                                                                                                                                                                                                                              |

## services-detail

| #   | difference                                                                                     | status                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS: breadcrumb missing («… / سرویس‌ها / جزئیات سرویس»)                                      | ✅ fixed (Phase A 3d51d2b6)                                                                                                                             |
| 2   | DIFFS: «حجم مصرف‌شده» tile has a percentage beside its bar («۷۱٪»)                             | ✅ fixed: percentage beside a neutral bar (warn >75%, danger >90%, as the demo's meter); limit and last-read lines label/value at either end (de825162) |
| 3   | own: title copy icon visible; the demo's `.cpb` is hidden until hover/focus (shown on a phone) | ✅ fixed: same button, the demo's resting opacity (11f39ca4)                                                                                            |
| 4   | own: expiry drawn as a 24px figure; the demo's is the smaller date line (`.svc-v`, 16px)       | ✅ fixed (de825162)                                                                                                                                     |
| 5   | own: tile figures smaller than the demo's 24–25px                                              | ✅ fixed (de825162)                                                                                                                                     |
| 6   | own: times in month-name form                                                                  | ✅ fixed (c66bfc96)                                                                                                                                     |
| 7   | own 390: one tile a row; the demo keeps two                                                    | ✅ fixed (11f39ca4)                                                                                                                                     |
| 8   | own 390: refund decisions inline; the demo stacks two full-width capsules                      | ✅ fixed (11f39ca4)                                                                                                                                     |
| 9   | own: identity ids underlined (demo plain)                                                      | ⛔ X7 (Phase A d7f4bda0: linkable ids are underlined links)                                                                                             |

## orders

| #   | difference                                                                | status                                                                                                                 |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS: «خوانده‌شده در …» + round refresh under the subtitle               | ✅ fixed (Phase A 3d51d2b6)                                                                                            |
| 2   | DIFFS: pager labels                                                       | ✅ fixed (Phase A fd5dfbe5)                                                                                            |
| 3   | DIFFS: customer column `@username` + Telegram id in monospace; breadcrumb | ✅ the column draws both from the API (`CustomerIdentityLink`); fixture rows carry them (7adfc80e). Breadcrumb Phase A |
| 4   | own: numeric times; 390 labelled cards                                    | ✅ fixed (c66bfc96, cfd88811, ef5dd180, 11f39ca4)                                                                      |
| 5   | own: product names underlined (demo bold)                                 | ⛔ X7 (Phase A)                                                                                                        |

## extra-devices

| #   | difference                                                                    | status                                                                     |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | DIFFS: breadcrumb                                                             | ✅ fixed (Phase A 3d51d2b6)                                                |
| 2   | DIFFS: pager labels                                                           | ✅ fixed (Phase A fd5dfbe5)                                                |
| 3   | DIFFS: «آخرین تغییر» numeric date-time («1405/07/03 12:10»)                   | ✅ fixed, in the body colour as the demo (c66bfc96, cfd88811, 83bc5ec3)    |
| 4   | own: rows denser than the demo's (~40px)                                      | ✅ fixed (cfd88811)                                                        |
| 5   | own: max-quantity column aligned to the end; the demo reads it from the start | ✅ fixed (cfd88811)                                                        |
| 6   | own: an unknown product shown as a raw id                                     | ✅ data only: fixture rows reference listed panels and products (7adfc80e) |
| 7   | own 390: labelled cards                                                       | ✅ fixed (ef5dd180, 11f39ca4)                                              |

## custom-service

| #   | difference                                                                            | status                                |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | DIFFS: capability callout outlined, no icon                                           | ✅ fixed (Phase A 22c931ce)           |
| 2   | DIFFS: rule-type pills outlined; breadcrumb                                           | ✅ fixed (Phase A 4f4f5e1a, 3d51d2b6) |
| 3   | own: card action centred between title and hint; the demo's sits level with the title | ✅ fixed (cfd88811)                   |
| 4   | own: panel/tier copy icons always visible; the demo's `.cpb` shows on row hover/focus | ✅ fixed (11f39ca4)                   |
| 5   | own: dense rows (demo ~46px); red trash icon (demo neutral)                           | ✅ fixed (cfd88811)                   |
| 6   | own: rule-order card's list and notes tighter than the demo's                         | ✅ fixed (cfd88811)                   |
| 7   | own 390: cards titled by the first cell, as the demo                                  | ✅ fixed (c66bfc96)                   |

## service-locations

| #   | difference                                                             | status                                                                               |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | DIFFS: «افزودن» below the subtitle; breadcrumb                         | ✅ fixed (Phase A 3d51d2b6)                                                          |
| 2   | own: numeric times in the body colour; taller rows; neutral trash icon | ✅ fixed (c66bfc96, cfd88811)                                                        |
| 3   | own 390: labelled cards                                                | ✅ fixed (ef5dd180, 11f39ca4)                                                        |
| 4   | own: panel names «Frankfurt A» vs «DE-1»                               | ⛔ data only: `/panels` belongs to the panels family's fixtures; not overridden here |

## trials

| #   | difference                                            | status                                  |
| --- | ----------------------------------------------------- | --------------------------------------- |
| 1   | DIFFS: pager labels                                   | ✅ fixed (Phase A fd5dfbe5)             |
| 2   | DIFFS: actor copy icon; breadcrumb                    | ✅ fixed (Phase A d7f4bda0, 3d51d2b6)   |
| 3   | own: numeric times; 390 labelled cards                | ✅ fixed (c66bfc96, ef5dd180, 11f39ca4) |
| 4   | own: panel names and customers underlined (demo bold) | ⛔ X7 (Phase A)                         |

## compensations

| #   | difference                                                          | status                                                                                                                                   |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS: pager labels                                                 | ✅ fixed (Phase A fd5dfbe5)                                                                                                              |
| 2   | DIFFS: payment and order ids underlined monospace links; breadcrumb | ✅ fixed (Phase A d7f4bda0, 3d51d2b6)                                                                                                    |
| 3   | DIFFS: order shown as «ORD-xxxx»                                    | ⛔ no API field: `compensationViewSchema` carries `orderId` only; an invented number is fabricated data (skill) — the id prefix is drawn |
| 4   | own: numeric times; taller rows; 390 cards titled by the payment    | ✅ fixed (c66bfc96, cfd88811)                                                                                                            |

## bulk-operations

| #   | difference                                                   | status                          |
| --- | ------------------------------------------------------------ | ------------------------------- |
| 1   | DIFFS: «عملیات گروهی جدید» on its own row under the subtitle | ✅ fixed (Phase A 3d51d2b6, X3) |
| 2   | DIFFS: breadcrumb                                            | ✅ fixed (Phase A 3d51d2b6)     |
| 3   | DIFFS: operation-type cells underlined links                 | ✅ fixed (Phase A d7f4bda0)     |
| 4   | DIFFS: pager labels                                          | ✅ fixed (Phase A fd5dfbe5)     |
| 5   | own: numeric times; taller rows; 390 cards                   | ✅ fixed (c66bfc96, cfd88811)   |

## bulk-operations-new

| #   | difference                                         | status                                                                                              |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | DIFFS: breadcrumb                                  | ✅ fixed (Phase A 3d51d2b6)                                                                         |
| 2   | DIFFS: «مخاطبان این عملیات» + big figure + «مشتری» | ✅ fixed (3f86dfbb)                                                                                 |
| 3   | own: audience figure 1,284 vs the demo's 34        | ⛔ data only: `POST /audience/preview` is shared with broadcasts and campaigns; not overridden here |

## Cross-cutting, reported to the lead (shared kit, not this family's to change)

- Card heads: the kit `.card-head` draws a divider under every card title; the demo's `.ch`
  has none (visible on every page, e.g. bulk-operations-new).
- Inputs and selects: the demo's controls are a little taller than `--ctl-h` 32px.
- 390: header actions are full-width capsules in the demo (`PageHead`).
- `formatTimestampNumeric` and `DataTable stack` are opt-in; every other family's lists still
  use month-name times and scroll sideways at 390.
