# Audit — recovery family

Routes: `/recovery` (backup and restore, incl. the one-time legacy-package restore — the only
page allowed to name «میرزا»), `/legacy-products`, `/legacy-services`, `/legacy-cutover`, and the
redirect `/legacy-migration` → `/recovery`. Evidence: `../sidebyside/<route>--{dark,light}--{1440,390}.jpg`
(app left, demo right), under `--fixtures demo-parity` (`tests/web/shots/fixtures/demo-parity/recovery.ts`).

SHAs are on branch `t2/f-recovery`.

## /recovery

| #   | difference                                                                                                  | status                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS #1 «بازیابی‌های پیشین از میرزا» table (file / status / stop reason / backup id / time) missing        | ✅ the table existed (`MirzaHistory`) but no fixture had a finished import; rows added (e6580f7d), heading bold (0267f0f0) |
| 2   | DIFFS #2 latest-backup card lacks the amber «پاکسازی ناقص» callout                                          | ✅ drawn from `cleanupOk: false`; fixture's newest run has it (e6580f7d)                                                   |
| 3   | DIFFS #3 kit and restore-operations heads: title and hint on one row                                        | ✅ ca3f01e0 (also the schedule card, as in the demo)                                                                       |
| 4   | DIFFS #4 «ارسال‌های نامعلوم» stat card neutral                                                              | ✅ already neutral after Phase A X6 (verified in the side-by-side)                                                         |
| 5   | DIFFS #5 pager «تازه‌تر / قدیمی‌تر»; breadcrumb                                                             | ✅ Phase A (history pager is `newest-first`; breadcrumb from nav) — verified                                               |
| 6   | own: history shows 5 rows, demo 10 with «قدیمی‌تر» live                                                     | ✅ fixture: ten runs and a next cursor (e6580f7d)                                                                          |
| 7   | own: «کلیدهای این سرور» table empty                                                                         | ✅ fixture: the demo's three keys (active, configured, imported + «حذف») (e6580f7d)                                        |
| 8   | own: restore requests lack the demo's failed row with its reason and code                                   | ✅ fixture (e6580f7d); the reason wraps in its cell so the table fits its card (ca3f01e0)                                  |
| 9   | own: earlier-restores table ran past its card (long stop reason, full uuid)                                 | ✅ stop reason wraps; protective backup is the short id with the full one as tooltip (ca3f01e0)                            |
| 10  | own: schedule «اطلاعات فنی» is a boxed disclosure in the demo                                               | ✅ `variant="boxed"` (ca3f01e0)                                                                                            |
| 11  | own: history «دریافت آرشیو رمزشده» is quiet text in the demo, underlined in the app                         | ✅ ca3f01e0                                                                                                                |
| 12  | own: restore requests have two more columns (displaced database, cutover time) than the demo                | ⛔ kept — real data the page already shows (rule: never remove a capability); the table fits                               |
| 13  | own: warning callouts (Telegram, kit, cleanup) carry ⚠ in the app, none in the demo                         | ⛔ kit rule (Phase A X5, `Banner`): a warning keeps its sign — raised to the lead                                          |
| 14  | own: the demo's sample-file chips «پروندهٔ نمونه» and «حالت‌های سرور برای بازبینی نمونه»                    | ⛔ excluded: the demo's sample-scenario boxes                                                                              |
| 15  | own: incident banner above the header                                                                       | ⛔ excluded: incident banner content (shown only for a real open incident)                                                 |
| 16  | own (390): the demo stacks every table into label/value row cards; the app scrolls the table in its wrapper | ⛔ cross-cutting (`DataTable`, every page) — raised to the lead, not changed in one family                                 |
| 17  | own: card heads have a hairline under the title in the app, none in the demo                                | ⛔ cross-cutting (`.card-head` in kit.css, every page) — raised to the lead                                                |
| 18  | own: archive size drawn as a unit-formatted size, demo as a raw byte count                                  | ⛔ data format, not composition (`Bytes`), kept                                                                            |

## /legacy-products

| #   | difference                                                                               | status                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 filters toolbar first, then a narrow search                                     | ✅ order by Phase A X8; the search is now one narrow field on the start side, full width on a phone (dc4aa41f, ca3f01e0) |
| 2   | DIFFS #2 breadcrumb                                                                      | ✅ Phase A — verified                                                                                                    |
| 3   | DIFFS #3 warning pills «منبع تغییر کرده», «کد تکراری», «در خواندن آخر نبود» when flagged | ✅ already rendered from the data; fixture rows carry each flag (e6580f7d)                                               |
| 4   | DIFFS #4 info callout has no icon                                                        | ✅ Phase A X5 (and the page's stray `icon` prop removed, dc4aa41f)                                                       |
| 5   | DIFFS #5 pager «تازه‌تر / قدیمی‌تر»                                                      | ⛔ skill rule (`KeysetOrder`): the list is ordered by legacy code, so it is `sequence` → «قبلی / بعدی»                   |
| 6   | own: rows are taller in the demo                                                         | ✅ dense dropped (dc4aa41f)                                                                                              |
| 7   | own: search placeholder repeats the label; the demo's field is empty                     | ✅ dc4aa41f                                                                                                              |
| 8   | own: 9 demo rows                                                                         | ✅ fixture (e6580f7d)                                                                                                    |
| 9   | own (390): table stacking; callout look                                                  | ⛔ cross-cutting (see /recovery #16, Phase A X5)                                                                         |

## /legacy-services

| #   | difference                                                               | status                                                                                                          |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | DIFFS #1 results card a two-column grid of every category with its count | ✅ two pairs a row ≥901px (596eab54); fixture with every category (e6580f7d) — zeros omitted, as the demo does  |
| 2   | DIFFS #2 filters inline: five fields                                     | ✅ the demo draws the two selects in «فیلترها» and the three codes inline; the app now does the same (596eab54) |
| 3   | DIFFS #3 breadcrumb                                                      | ✅ Phase A — verified                                                                                           |
| 4   | DIFFS #4 the box has an icon; the demo's is plain                        | ✅ info callout iconless (Phase A X5; stray `icon` prop removed, 596eab54)                                      |
| 5   | DIFFS #5 pager «قدیمی‌تر / تازه‌تر»                                      | ✅ id ascending over uuid v7 → `oldest-first` (596eab54)                                                        |
| 6   | own: rows taller in the demo                                             | ✅ dense dropped (596eab54)                                                                                     |
| 7   | own (390): the code fields take the full line in the demo                | ✅ ca3f01e0                                                                                                     |
| 8   | own (390): table stacking                                                | ⛔ cross-cutting (see /recovery #16)                                                                            |

## /legacy-cutover

| #   | difference                                                                                       | status                                                                                           |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 «تأییدها» card (type / source fingerprint / state / actions, pills, «لغو تأیید», pager) | ✅ always a card, empty state inside (7191b2b3, test added); fixture active + revoked (e6580f7d) |
| 2   | DIFFS #2 «آزمایشی» pill in the read-set source cell                                              | ✅ already drawn; synthetic fixture rows (e6580f7d); small hash face so it fits (7191b2b3)       |
| 3   | DIFFS #3 pager «تازه‌تر / قدیمی‌تر»                                                              | ✅ id ascending over uuid v7 → `oldest-first` (7191b2b3)                                         |
| 4   | DIFFS #4 «ثبت تأیید مالک» below the subtitle; breadcrumb                                         | ✅ Phase A X3/X1 (bottom-aligned head action) — verified; the demo's check mark added (7191b2b3) |
| 5   | own: the read sets ran past the card (two 64-digit hashes + pill)                                | ✅ the demo's small code face (7191b2b3)                                                         |
| 6   | own: apply runs show the label and its code («کامل شد COMPLETED»); the demo the label alone      | ⛔ `LegacyCode` (code kept for the operator who reads the server log) — not composition          |
| 7   | own: warning callout carries ⓘ                                                                   | ⛔ kit rule (see /recovery #13)                                                                  |
| 8   | own (390): page-head action full width; tables stacked                                           | ⛔ cross-cutting (`PageHead`, `DataTable`) — raised to the lead                                  |

## /legacy-migration

Redirects to `/recovery` (`RedirectPage`); no own composition. Verified with `web:shots` (no problems).
