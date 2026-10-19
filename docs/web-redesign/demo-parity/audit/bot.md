# Demo parity audit — the bot and content family

Routes: `/appearance`, `/bot-buttons`, `/bots`, `/broadcasts`, `/content`, `/client-apps`,
`/features`, `/notifications`, `/reminders`, `/settings`, `/terms`, `/products`,
`/product-categories`. Side-by-sides (app left, demo right) at 1440 dark, 1440 light,
390 dark and 390 light: `../sidebyside/<route>--<theme>--<width>.jpg`, fed the family's
fixture set `tests/web/shots/fixtures/demo-parity/bot.ts`.

Breadcrumbs (X1) came with Phase A and were verified on every route here.

Kit changes this family made (additive, each in its own commit): `usePagedRows(…, { wholeCollection })`
(974985e9) — the demo's counted pager over a list the endpoint answers whole; `DataTable stackOnPhone`
(8a8a9b04, 9c874054) — the demo's stacked «label: value» rows at phone width.

Exclusions used: **E-sample** the «داده نمونه» badge and the incident banner's sample content
(PROMPT.md, excluded); **E-digits** the demo's Latin digits (Persian digits are the project
convention); **E-time** the demo's relative times («۵ روز پیش») — the admin states every
timestamp absolutely through `formatTimestamp` and has no relative-time presentation;
**E-kit** a difference in a shared kit component every family shares (reported to the lead,
not patched per page).

## Every route — shared

| #   | difference                                                             | status                |
| --- | ---------------------------------------------------------------------- | --------------------- |
| 1   | Breadcrumb above the title                                             | ✅ Phase A (verified) |
| 2   | «داده نمونه» badge beside the title; incident banner                   | ⛔ E-sample           |
| 3   | Card header drawn with a hairline under it (the demo's `.ch` has none) | ⛔ E-kit (Card)       |
| 4   | Latin digits in the demo                                               | ⛔ E-digits           |

## /appearance

| #   | difference                                                     | status                                           |
| --- | -------------------------------------------------------------- | ------------------------------------------------ |
| 1   | DIFFS #1 breadcrumb                                            | ✅ Phase A                                       |
| 2   | DIFFS #2 test card lists every bot with its pill and line      | ✅ 71b94ec0 (fixture adds the stopped bot)       |
| 3   | DIFFS #3 expand chevron on every row; the whole row opens      | ✅ 71b94ec0                                      |
| 4   | DIFFS #4 «جایگاه‌های آیکون» tab count                          | ✅ 71b94ec0                                      |
| 5   | DIFFS #5 «خاموش» pill beside the badge                         | ✅ 71b94ec0 (fixture: a stored, switched-off id) |
| 6   | DIFFS #6 «۱–۱۰ از ۲۹ · صفحه ۱ از ۳»                            | ✅ 974985e9, 71b94ec0                            |
| 7   | DIFFS #7 footer note removed                                   | ✅ 71b94ec0                                      |
| 8   | Own: the marker alone under the slot name (no «نشانگر در متن») | ✅ 71b94ec0                                      |
| 9   | Own: roomy rows and the 20px glyph                             | ✅ 71b94ec0                                      |
| 10  | Own: test card hint in the body, bulleted bot list             | ✅ 71b94ec0                                      |
| 11  | Own (390): rows stack into labelled cards                      | ✅ af550159                                      |

## /bot-buttons

| #   | difference                                                                    | status                                             |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | DIFFS #1 «دکمه‌های آزاد» a full-width card above the menu, full-width rows    | ✅ 71b94ec0                                        |
| 2   | DIFFS #2 the cramped-row warning and the ⚠ beside the row                     | ✅ 71b94ec0 (fixture: row 4 holds the wide «apps») |
| 3   | DIFFS #3 «منو» its own card, segmented control opposite the title, wide phone | ✅ 71b94ec0                                        |
| 4   | DIFFS #4 green «منتشرشده و یکسان با پیش‌نویس» pill                            | ✅ 71b94ec0 (fixture: published = draft)           |
| 5   | DIFFS #5 breadcrumb                                                           | ✅ Phase A                                         |
| 6   | Own: the draft callout is the demo's quiet hairline note                      | ✅ 71b94ec0                                        |
| 7   | Own: inspector title ruled, full width                                        | ✅ 71b94ec0                                        |
| 8   | Own (390): free buttons wrap as chips                                         | ✅ af550159                                        |

## /bots

| #   | difference                                                   | status                                                                           |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | DIFFS #1 «افزودن ربات» a bordered card with a «+» header row | ✅ eee2803b                                                                      |
| 2   | DIFFS #2 «نیازمند توجه» always in the strip, zero included   | ✅ eee2803b, 118aeeac (the figure is the readiness rule over the fixture's bots) |
| 3   | DIFFS #3 the unhealthy bot's amber box of causes; breadcrumb | ✅ eee2803b (fixture: the stopped support bot); breadcrumb Phase A               |
| 4   | Own: fact values in the body colour on the raised cell       | ✅ eee2803b                                                                      |
| 5   | Own: username in the mono face                               | ✅ eee2803b                                                                      |
| 6   | Own: «۵ روز پیش» webhook time                                | ⛔ E-time                                                                        |

## /broadcasts

| #   | difference                                                              | status                                               |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | DIFFS #1 titles are underlined links                                    | ✅ Phase A (X7, verified)                            |
| 2   | DIFFS #2 progress blue while running/paused, green when finished        | ✅ 913e101a                                          |
| 3   | DIFFS #3 «تازه‌تر / قدیمی‌تر», only the available direction; breadcrumb | ✅ 913e101a (fixture: an older page exists); Phase A |
| 4   | Own: the list framed inside the card, demo row height                   | ✅ 913e101a                                          |
| 5   | Own (390): rows stack                                                   | ✅ af550159                                          |

## /content

| #   | difference                                                           | status                                                                                           |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 bounded list pane, «۱–۱۰ از ۷۳۲ · صفحه ۱ از ۷۴» + قبلی/بعدی | ✅ 179b2ad4 (the endpoint answers every template; rows off the page are hidden, never unmounted) |
| 2   | DIFFS #2 dot markers on customised texts; breadcrumb                 | ✅ 179b2ad4 (fixture: four customised texts); Phase A                                            |
| 3   | Own: list column 330px so the pager is one row                       | ✅ 179b2ad4                                                                                      |
| 4   | Own (390): category chips wrap; the pane takes its own height        | ✅ af550159                                                                                      |

## /client-apps

| #   | difference                                                                  | status      |
| --- | --------------------------------------------------------------------------- | ----------- |
| 1   | DIFFS #1 breadcrumb                                                         | ✅ Phase A  |
| 2   | Own: «حذف» an outlined danger capsule                                       | ✅ 6079739e |
| 3   | Own: roomy rows                                                             | ✅ 6079739e |
| 4   | Own: «v2rayNG» drawn «v۲rayNG» — a product name keeps its typed digits      | ✅ 6079739e |
| 5   | Own: «۳ روز پیش» in «آخرین تغییر»                                           | ⛔ E-time   |
| 6   | Own (390): rows stack                                                       | ✅ af550159 |
| 7   | Own (390): opening the editor dropped the header button and the page jumped | ✅ 5b694c35 |

## /features

| #   | difference                                              | status                                                |
| --- | ------------------------------------------------------- | ----------------------------------------------------- |
| 1   | DIFFS #1 ten a page with «۱–۱۰ از ۲۱ · صفحه ۱ از ۳»     | ✅ 6079739e (the endpoint answers every flag)         |
| 2   | DIFFS #2 red invalid-value sentence beside the value    | ✅ 6079739e (fixture: an invalid stored minute count) |
| 3   | DIFFS #3 values at the far end of a related-setting row | ✅ 6079739e                                           |
| 4   | DIFFS #4 breadcrumb                                     | ✅ Phase A                                            |

## /notifications

| #   | difference                                   | status                                                   |
| --- | -------------------------------------------- | -------------------------------------------------------- |
| 1   | DIFFS #1 «تازه‌تر / قدیمی‌تر»                | ✅ Phase A (X2), verified with an older page in a070a577 |
| 2   | DIFFS #2 the amber «در انتظار» pill          | ✅ a070a577 (fixture: a pending notification)            |
| 3   | DIFFS #3 breadcrumb                          | ✅ Phase A                                               |
| 4   | Own: category a filled pill; demo row height | ✅ a070a577                                              |
| 5   | Own (390): rows stack                        | ✅ af550159                                              |

## /reminders

| #   | difference                                                             | status                                                   |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | DIFFS #1 switch and pill in the card header, no labelled row           | ✅ a070a577                                              |
| 2   | DIFFS #2 breadcrumb                                                    | ✅ Phase A                                               |
| 3   | DIFFS #3 «متن پیام‌ها (۳)»                                             | ✅ a070a577                                              |
| 4   | DIFFS #4 a switched-off reminder's value muted                         | ✅ a070a577 (fixture: wallet reminder off, ۵۰٬۰۰۰ تومان) |
| 5   | Own: the day/percent sequences and the quiet window read right to left | ✅ a070a577                                              |

## /settings

| #   | difference                                                     | status                                                                               |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | DIFFS #1 «سایر تنظیمات ۱» tab                                  | ✅ a070a577 (the tab exists for a key this build does not know; fixture carries one) |
| 2   | DIFFS #2 «اطلاعات فنی» a full-width bordered collapsible bar   | ✅ a070a577                                                                          |
| 3   | DIFFS #3 «آخرین تغییر» on edited rows                          | ✅ a070a577 (fixture: two edited rows)                                               |
| 4   | DIFFS #4 breadcrumb                                            | ✅ Phase A                                                                           |
| 5   | Own: the words take the wider column, the control the narrower | ✅ a070a577                                                                          |

## /terms

| #   | difference                                                                      | status                                                      |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | DIFFS #1 four bordered neutral stat cards with large numbers                    | ✅ b627ebd5 (Phase A stat-grid; tones removed per X6)       |
| 2   | DIFFS #2 history table with chevrons and the «نسخهٔ فعلی» pill                  | ✅ b627ebd5                                                 |
| 3   | DIFFS #3 version cards' meta lines, «مشاهده», draft buttons                     | ✅ b627ebd5 (fixture: v3 in force, a draft, three versions) |
| 4   | DIFFS #4 the switch's «روشن» pill                                               | ✅ b627ebd5                                                 |
| 5   | DIFFS #5 breadcrumb                                                             | ✅ Phase A                                                  |
| 6   | Own: the history's last header keeps «عملیات» (the chevron column needs a name) | ⛔ accessibility — a column of buttons keeps its header     |
| 7   | Own (390): history stacks                                                       | ✅ af550159                                                 |

## /products

| #   | difference                                                           | status                                                        |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | DIFFS #1 «فیلترها» row first, search under it                        | ✅ Phase A (X8, verified)                                     |
| 2   | DIFFS #2 header buttons at the bottom of the header block            | ✅ Phase A (X3, verified)                                     |
| 3   | DIFFS #3 «تازه‌تر / قدیمی‌تر»; breadcrumb                            | ✅ Phase A (ascending keyset, «تازه‌تر» is next, as the demo) |
| 4   | Own: Track 1's «آرشیو» tab is the page's tab bar above the list card | ✅ b627ebd5                                                   |
| 5   | Own: the list framed under the filters, demo row height              | ✅ b627ebd5                                                   |
| 6   | Own (390): rows stack, no trapped scroll pane                        | ✅ 9c874054, af550159                                         |

## /product-categories

| #   | difference                                                                                                         | status                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | DIFFS #1 icon cards: a small coloured chip at the far end; labelled full-width inputs; «حذف» beside a filled value | ✅ b627ebd5 (fixture decorates three categories, colours four) |
| 2   | DIFFS #2 «N دسته‌بندی آیکون یا ایموجی دارد»                                                                        | ✅ b627ebd5 (present; fixture makes it ۳)                      |
| 3   | DIFFS #3 more padding per card; breadcrumb                                                                         | ✅ b627ebd5; Phase A                                           |
| 4   | Own (390): the category table stacks                                                                               | ✅ af550159                                                    |
