# Demo-parity audit — customers and support family

Branch `t2/f-customers`. Routes: `/users`, `/users/:id` (Customer 360), `/tickets`, `/support`,
`/business-chats`, `/notification-center` (reference: the demo's `#/inbox`), `/support-ai`,
`/support-analytics`, `/support-knowledge`, `/knowledge-build`, `/support-learning` (no demo page:
the shared patterns). Side-by-sides (app left, demo right, `--fixtures demo-parity`) are in
`../sidebyside/<route>--{dark,light}--{1440,390}.jpg`.

Status: ✅ fixed (commit) · ✅ A = already fixed by Phase A's shell/kit, verified on the new
side-by-sides · ⛔ excluded, with the rule.

Exclusions that apply to every route below and are not repeated per table: the demo's Latin
digits (Persian digits are the convention), the «داده نمونه» badge, the incident banner's sample
content, the demo state bar. Two cross-cutting differences seen on every route are reported to the
lead rather than changed here (they are kit-wide, not this family's):

- At 390 the demo draws each table row as a stacked card; the kit's `DataTable` keeps a table
  that scrolls inside its wrapper. ⛔ kit-wide (X9's table wrap), not a page change.
- The demo's info callouts carry an ⓘ and its danger alerts none; the kit's `Banner` (X5) draws
  info callouts iconless and keeps the sign on warnings and errors. ⛔ X5.

## /users

| #        | difference                                                                     | status                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| users #1 | Refresh is a circular icon button next to «مدیریت برچسب‌ها»                    | ✅ A (ListFreshness), verified                                                                                                          |
| users #2 | Pager labels «تازه‌تر / قدیمی‌تر»; breadcrumb                                  | ✅ A (CursorPager, PageTrail), verified                                                                                                 |
| own      | Names bold, usernames monospaced, avatars tinted as the demo's `avc`           | ✅ d17855c9                                                                                                                             |
| own      | Rows at the demo's height (not dense)                                          | ✅ d17855c9                                                                                                                             |
| own      | Demo puts the search row above «فیلترها» on this one page, with a narrow input | ✅ 3c55279d (search row first, as the demo — owner decision 2026-10-19: follow the demo per page; X8 overridden where the demo differs) |

## /users/:id — Customer 360

| #               | difference                                                                                                                                             | status                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| users-detail #1 | Stat strip after the operations card, six separate stat cards; identity head not a card                                                                | ✅ d17855c9                                         |
| users-detail #2 | «میان‌برهای اپراتور» a vertical list                                                                                                                   | ✅ d17855c9                                         |
| users-detail #3 | Tab labels «محدودیت‌ها و کنترل‌ها», «معرف و نماینده», «یادداشت‌ها و برچسب‌ها», «تاریخچهٔ مدیریتی» (the demo's own text)                                | ✅ d17855c9                                         |
| users-detail #4 | «→ کاربران» back link above the header                                                                                                                 | ✅ bbba0332 (kit, additive) + d17855c9              |
| users-detail #5 | Blocked alert below the stats; empty «نیازمند رسیدگی» line — fixtures added and verified                                                               | ✅ d17855c9                                         |
| own             | Telegram id in the head without a copy icon (X7)                                                                                                       | ✅ d17855c9                                         |
| own             | Round, tinted avatar; name at the page title's size                                                                                                    | ✅ 32615dc5 (kit, additive) + d17855c9              |
| own             | Empty attention is one checked line, not a tall centred empty state                                                                                    | ✅ d17855c9                                         |
| own             | Stat dates in the demo's numeric form, one line at 1440, two short lines on a phone                                                                    | ✅ d17855c9, af97a28c                               |
| own             | Latest orders/payments rows at the demo's height                                                                                                       | ✅ af97a28c                                         |
| own             | Demo shows a «نماینده» pill in the head; the app draws it only once the reseller card's query has answered (it is observed, never fetched by the head) | ⛔ no request change for a layout (nexa-web-design) |
| own             | At 390 the demo wraps the nine tabs onto three lines; the kit's tab strip scrolls sideways                                                             | ⛔ kit `Tabs` (W2 strip, `tests/web` pinned)        |

## /tickets

| #          | difference                                                            | status                                                                                                                  |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| tickets #1 | Extra search row at the top of the table card                         | ✅ bfc77e95 — the customer field moved into the «فیلترها» panel (same field, URL key, debounce, Enter); nothing removed |
| tickets #2 | «خواندن دوباره» with «خوانده‌شده در …»                                | ✅ A (ListFreshness `labelled`), verified                                                                               |
| tickets #3 | Pager labels; 10 rows per page                                        | ✅ A (CursorPager; `LIST_PAGE_SIZE`), verified with a 10-row fixture                                                    |
| tickets #4 | «افزودن دسته» «+» icon; pencil on «تغییر نام»; breadcrumb             | ✅ bfc77e95; breadcrumb ✅ A                                                                                            |
| own        | Rows at the demo's height (inbox and categories); assignee monospaced | ✅ 046302f6                                                                                                             |

## /support

| #          | difference                                                     | status         |
| ---------- | -------------------------------------------------------------- | -------------- |
| support #1 | Breadcrumb                                                     | ✅ A, verified |
| support #2 | «رفتن به تنظیمات» aligned with the card title                  | ✅ d1c1d016    |
| own        | Contact card at the card radius; FAQ rows at the demo's height | ✅ 046302f6    |

## /business-chats

| #                 | difference                                                                                   | status                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| business-chats #1 | Breadcrumb                                                                                   | ✅ A, verified                                                         |
| business-chats #2 | Footer «نمایش N» + «نمایش بیشتر»                                                             | ✅ 70f9fb7e (same infinite query; ten, ten more, then the next cursor) |
| business-chats #3 | «تیکت دارد» under the status badge                                                           | ✅ 70f9fb7e (fixture row with a ticket)                                |
| business-chats #4 | Waiting time bold                                                                            | ✅ 70f9fb7e                                                            |
| own               | Headers on one line, preview one truncated line, ticket pill not underlined, demo row height | ✅ 046302f6                                                            |

## /notification-center (reference `#/inbox`)

| #                      | difference                                                                       | status              |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------- |
| notification-center #1 | Audit against `#/inbox`                                                          | ✅ 8c444df9 — below |
| own                    | «خوانده‌نشده / همه» compact on the start side, not a full-width bar              | ✅ 8c444df9         |
| own                    | No rule under the filter line; it sits on the page                               | ✅ 8c444df9         |
| own                    | Unread item marked by a line on its start edge, not a filled row; inset dividers | ✅ 8c444df9         |
| own                    | Fixture: the demo's six unread notifications                                     | ✅ 8c444df9         |

## /support-ai

| #             | difference                                                                                                      | status                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| support-ai #1 | Provider block: vertical label/value list, actions below, separate «آزمون اتصال» + «مدل آزمون:» row             | ✅ 2631b6ac                                                                |
| support-ai #2 | Rejected-key alert and the «موقتاً کنار گذاشته شده», «محدودیت تعداد درخواست», «در انتظار یک آزمون دوباره» pills | ✅ 2631b6ac (fixture rows; the app drew them already from data)            |
| support-ai #3 | Mode pill under the subtitle on the controls' side                                                              | ✅ 2631b6ac                                                                |
| support-ai #4 | Numbered backup rows with provider, model and trash                                                             | ✅ 2631b6ac (fixture with a backup step; provider and model share the row) |
| support-ai #5 | Modes one per line; soft inset cards; breadcrumb                                                                | ✅ 2631b6ac; breadcrumb ✅ A                                               |
| own           | «افزودن پشتیبان» compact on the start side                                                                      | ✅ 2631b6ac                                                                |
| own           | «ذخیرهٔ پیکربندی» on the form's end side                                                                        | ✅ 4395a44c                                                                |
| own           | Provider blocks divided by rules, no list markers                                                               | ✅ 2631b6ac                                                                |

## /support-analytics

| #                    | difference                                        | status                                                                   |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| support-analytics #1 | Four KPI cards in four equal columns              | ✅ A (X6 stat-grid), verified                                            |
| support-analytics #2 | «بازه» beside the pills; no empty rule under them | ✅ 91ac11bb                                                              |
| support-analytics #3 | Bar rows: label, bar, number on one line          | ✅ 91ac11bb (+ e42dc3bf: bars scaled to the largest slice, kit additive) |
| support-analytics #4 | A colour per automatic outcome; breadcrumb        | ✅ 91ac11bb; breadcrumb ✅ A                                             |
| own                  | Bars grow from the start side, beside their label | ✅ 91ac11bb                                                              |

## /support-knowledge

| #                    | difference                                | status                                                                                                                                                                                           |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| support-knowledge #1 | Filters row in its own bordered card      | ✅ dd1902c0                                                                                                                                                                                      |
| support-knowledge #2 | Counted footer «۱–۱۰ از ۳۷ · صفحه ۱ از ۴» | ⛔ nexa-web-design: the articles endpoint returns the whole list with no server total, so no counted pager; the in-memory list pages ten at a time with the kit's «قبلی / بعدی» (`usePagedRows`) |
| support-knowledge #3 | Slimmer info callout; breadcrumb          | ✅ A (X5 Banner, breadcrumb), verified                                                                                                                                                           |
| own                  | Rows at the demo's height                 | ✅ dd1902c0                                                                                                                                                                                      |

## /knowledge-build

| #                  | difference                                                                                           | status                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| knowledge-build #1 | «متن فعلی» / «متن پیشنهادی» as bordered cards side by side; an addition's one card on the start side | ✅ 87ad87af                  |
| knowledge-build #2 | Unnumbered rows divided by rules; badge + category on top, the action below                          | ✅ 87ad87af                  |
| knowledge-build #3 | Conflict chooser and retire rows — fixture rows added and verified; breadcrumb                       | ✅ 87ad87af; breadcrumb ✅ A |

## /support-learning (no demo page)

| #                   | difference                                                                | status                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| support-learning #1 | Shared shell/header/pagination/callout and the demo's card/table patterns | ✅ dd1902c0 — header and breadcrumb (A), iconless callout (X5), state pills in a toolbar card like the knowledge list's filter line, table at the demo's row height, the kit's pager over the in-memory list |
