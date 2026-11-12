# Demo parity: leftovers against the REAL demo (PR-1, reseller-panel phase)

Date: 2026-11-11. Branch `fix/parity-real-demo-leftovers`, from main `415fa9b7`.

**Demo used: the owner's REAL `reference/redesign-demo.html`** (the earlier round only had the older fallback). The live side is served with the demo's own `#nx-data`, so both sides show the same records. Committed byte-identical (checked with `cmp`). The reseller-panel demo is kept at `docs/reseller-panel/approved-demo.dc.html` (also byte-identical, ignored by prettier).

## 1. `pnpm web:demo-diff` (68 routes plus tabs, failed 0)

| Combination               | Before KEEP | Suppressed | Remaining |
| ------------------------- | ----------- | ---------- | --------- |
| light 1440, first run     | 410         | 133        | 277       |
| dark 1440, first run      | 410         | 133        | 277       |
| light 390, first run      | 410         | 133        | 277       |
| dark 390, first run       | 410         | 133        | 277       |
| light 1440, after this PR | 369         | 153        | 216       |

The signature is DOM-based, so the four first-run reports are identical line for line; only light 1440 was re-run after the changes. The 216 left are dominated by the items in section 3 (fixture or data gaps, and the per-setting «ذخیره», which repeats on every settings tab).

## 2. Owner rulings applied (presentation only; no API, permission or logic change)

- **KEEP list** (`scripts/web-shots/demo-diff.keep.json`) gained: the `/recovery` per-invoice card (heading, search label, empty text); the period chips inside «فیلترها» on `/reports` and `/referrals`. Whole-list server CSV export: NOT wanted, the list «خروجی CSV» keeps exporting the loaded rows (no diff item, so recorded here).
- `/resellers`, `/reseller-plans`, `/reseller-tiers`: a click, or Enter on the focused row, opens the standing drawer (`DataTable onRowActivate`; a click on a link, button, field or open menu inside the row stays with that control). Names are text. «صفحهٔ مشتری» is an entry of a per-row «بیشتر» menu on `/resellers`.
- `/reports`: range chips moved into «فیلترها» (default `THIS_MONTH`, same URL keys).
- `/incidents/:id`: head chips removed; severity and kind are rows of the summary box beside the status.
- `/notification-center`: the demo's «خوانده‌نشده | همه» pair on the page; «همه را خوانده‌شده کن» is a head button (same condition, same mutation); the «بیشتر» menu keeps the re-read.
- `/settings`: the section title is a plain heading (`SettingsSection collapsible={false}`), no second button of the tab's name.
- `/extra-devices` packages tables: title is text, «ویرایش» is the row's button (as the demo).
- `/content`: the demo's «one table per template» is the variables table of each template's editor (the 367 tables are the demo's hidden per-template panes). The app draws that table for the open template. No change.

## 3. The 33 NOT DONE (previous report) re-checked

| Route                                | Items | Status now                                                                                                                                                |
| ------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/content`                           | 1     | MATCH (see above)                                                                                                                                         |
| `/notification-center`               | 1     | FIXED                                                                                                                                                     |
| `/recovery`                          | 3     | KEEP                                                                                                                                                      |
| `/reports`                           | 7     | KEEP (owner ruling: chips in «فیلترها»)                                                                                                                   |
| `/reseller-plans`, `/reseller-tiers` | 8     | FIXED                                                                                                                                                     |
| `/resellers`                         | 11    | 10 FIXED; 1 differs: the demo's per-row «وضعیت» button. The row click opens the same drawer (owner ruling), so no second button                           |
| `/settings`                          | 1     | duplicate section button FIXED; the demo's per-setting «ذخیره» still differs: the app shows its save bar after an edit, on purpose (unsaved-changes rule) |
| `/incidents/:id`                     | 1     | FIXED                                                                                                                                                     |

## 4. The 17 UNVERIFIED re-checked

- `/extra-devices` (6): FIXED, no difference left.
- `/users/:id` (2): no difference left; the real demo's data shows the banner states.
- `/settings` (1): see above.
- `/bot-buttons` (8): still differs. The demo draws the live-menu preview items as buttons; the app draws them as non-interactive chips (same text), and adds the heading «پیش‌نمایش منوی ربات».

## 5. «بیشتر» menus

In the real demo, «بیشتر» beside a subtitle is the subtitle's expand toggle (the app's «درباره این صفحه» fold is a KEEP). A row-level «بیشتر» menu does not exist in the demo; the owner's ruling for `/resellers` created it. Page-head menus kept as before (`/payments`, `/campaigns`, `/gift-cards`, `/reminders`, `/audit-log`, `/content`, `/resellers`, `/notification-center`).

## 6. Does NOT match the real demo, and why

- `/panels`, `/panel-health`, `/panels/:id`, `/reports` «صورت مالی», `/users/:id` message/notes/history tabs: the app shows the server-rejected state because the demo's data shim has no answer for those endpoints. A data gap, not a layout gap.
- `/reports`, `/referrals`: the demo shows the period buttons on the page; the app has them in «فیلترها» (owner ruling).
- `/support-learning`: the demo has three state buttons (در انتظار بازبینی، تأییدشده، ردشده); the app has the «فیلترها» panel.
- `/product-categories`, `/service-locations`, `/trials`: the app has an extra «فیلترها» button.
- `/support`: the demo's «رفتن به تنظیمات» button is absent.
- `/products/:id`: the app has «ارسال توضیح از تلگرام» that the demo lacks (an existing action).
- `/tickets/:id`: the app has two extra box headings, «وضعیت» and «مسئول و اولویت».
- `/custom-service`: the demo's «عرضه» button is for a panel that is not yet offered; the live side has no such panel here (the code path exists).
- `/bot-buttons`: see section 4.
- `/content`: the tool counts hidden per-template panes (see section 2).
- Dashboard: `/` shows no difference after KEEP in the real-demo run, so «صف رسیدگی» / «وضعیت عملیاتی» are present in the real demo too. Nothing removed.

## 7. Date-time picker (section 4 of the phase)

At 23:55 to 23:59 with no time chosen, tapping today rounds up inside the same day, capped at 23:59 (never 00:00). If that default is outside `min`/`max` it moves to the nearest allowed moment and the field shows it. A time the user chose is still refused outside the range. Tests in `tests/web/date-field.test.tsx`.

## 8. Checks

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:i18n`, `pnpm check:boundaries`, `pnpm test:web` (3931 passed), the contrast and touch-token unit tests. Mutation checks (each reverted, test failed, restored): rounding cap; min/max clamp; Enter on the row; settings `collapsible`; reports `inFilterPanel`.
