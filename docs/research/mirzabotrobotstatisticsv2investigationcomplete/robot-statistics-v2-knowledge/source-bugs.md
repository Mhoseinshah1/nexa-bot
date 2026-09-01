# Source Bugs and UX Risks — 📊 آمار ربات

Only defects proven from displayed numbers. Nothing invented.

## Bugs

**SOURCE_BUG-STATS-001 — two headline percentages are hard-wrong.**
`📈 نرخ تبدیل کاربر به مشتری: 100٪` (true value 28.77 %) and `📊 سهم تمدید از کل فروش: 100٪`
(true value 42.05 %). Both appear on the primary all-time card. Inverting each ratio gives 347.6 % and
237.8 %, so a swapped numerator/denominator with a clamp at 100 fits both. Evidence: REC-009.

**SOURCE_BUG-STATS-002 — `مجموع کل شارژ کیف پول` adds the admin debit.**
The displayed total is the plain sum of all six lines including `کسر موجودی توسط ادمین`, money taken OUT
of wallets. Verified to the Toman: 2,333,109,211. Correct value 2,330,747,611. Evidence: REC-010.

**SOURCE_BUG-STATS-003 — `کاربران جدید عضوشده` ignores the end date in a custom range.**
Aug 1–31 returns 2530 where the true figure is 2521; the excess of exactly 9 equals today's new users.
The `هدیه شروع` counter a few lines below the same metric, in the same message, returns 2521 correctly.
Evidence: REC-011.

**SOURCE_BUG-STATS-004 — the `ماه قبل` preset excludes its own stated end day.**
Stamped `2026/08/01 تا 2026/08/31`, returns August 1–30. Proved three ways, and the sibling
`مقایسه فروش محصولات` feature's "ماه قبل" returns the full month, so the two disagree by a day.
Evidence: date-filter-model.md.

**SOURCE_BUG-STATS-005 — comparison periods overlap by one day and are one day too long.**
`۷ روز اخیر / ۷ روز قبل` runs 2026/08/18–08/25 against 2026/08/25–09/01: both inclusive, sharing
2026/08/25, so that day is counted in both halves and each "7-day" window is 8 days. Same for 30/30.

**SOURCE_BUG-STATS-006 — `میانگین خرید هر مشتری` is neither an average purchase nor per customer.**
It is `مجموع فروش (فقط سرویس‌های فعال)` ÷ `سفارش‌های دارای مبلغ` — active-service revenue per paid
order. Reproduced to the unit on two independent snapshots. The same label in the group report uses a
different, correct formula (sales ÷ buyers), so one label carries two meanings inside one feature.
Evidence: REC-008.

**SOURCE_BUG-STATS-007 — the custom range truncates the end day at 23:59:00.**
59 seconds of every custom query are silently dropped, and it costs real rows: the August test-account
count is 2727 by custom range versus 2728 by preset arithmetic. Evidence: REC-012.

**SOURCE_BUG-STATS-008 — the gateway with no name.**
The all-time gateway block prints `📌 درگاه:` with nothing after the colon, for the bucket holding
36,432 payments and 6,543,053,894 تومان. Its own name field is empty.

**SOURCE_BUG-STATS-009 — the end-date example precedes the start-date example.**
The custom-range prompt shows a start example of `2026/09/01` (dynamically today) and an end example of
`2025/09/08` (a frozen literal a year earlier). The comparison flow's four examples are all frozen 2025
literals.

## UX risks

**SOURCE_UX-RISK-STATS-001 — no total-revenue figure anywhere.** The admin must add orders + renewals +
extra volume + extra time by hand, and nothing on screen says those are additive rather than nested.
Anyone reading `مجموع فروش (همه سفارش‌ها)` as gross revenue understates August by 60 %.

**SOURCE_UX-RISK-STATS-002 — one label, two definitions.** `کاربرانی که حداقل یک خرید دارند` reads
56,792 on the all-time card and 27,732 across the group report. Both are shown as facts.

**SOURCE_UX-RISK-STATS-003 — the financial block only exists in the custom range.** An admin who uses
`امروز` or `ماه قبل` never sees refunds, commissions, lottery cost or gateway income at all.

**SOURCE_UX-RISK-STATS-004 — date-prompt examples are wrong or stale** (see BUG-009).

**SOURCE_UX-RISK-STATS-005 — four presentation conventions in one feature.** Gregorian Latin digits in
period stamps, Jalali Persian digits in comparison stamps, Jalali in per-user dates, and one percentage
sentinel that prints `۰٪` in Persian numerals amid Latin ones.

**SOURCE_UX-RISK-STATS-006 — PII with no friction.** Four leaderboards expose real display names,
`@usernames`, numeric Telegram ids, wallet balances and lifetime spend, ten users at a time, to any bot
admin, with no confirmation and no audit trail. `گزارش یک کاربر` does the same for any user on demand.

**SOURCE_UX-RISK-STATS-007 — historical reports rename themselves.** Because product resolution is by
current reference (RSV2-BR-015), renaming a product rewrites history and deleting one erases it into
`محصول حذف‌شده`. Past revenue attribution is not stable.

**SOURCE_UX-RISK-STATS-008 — stale keyboards accumulate.** Overflow continuation messages leave older
keyboards live in the chat; pressing one silently re-renders a report onto an old canvas.

**SOURCE_UX-RISK-STATS-009 — button label ≠ report title.** `🟢 بیشترین سرویس فعال` under
`آمار نمایندگان` opens a report titled `🟢 نمایندگان با بیشترین کاربر فعال` — services versus users.

**SOURCE_UX-RISK-STATS-010 — no currency label on the raw numbers in `آمار کل`.** Three values
(`مجموع موجودی فعلی کاربران`, `مجموع فروش (فقط سرویس‌های فعال)`, and the gateway amounts) are printed
without thousands separators while their neighbours have them, e.g. `4020111113 تومان` beside
`11,337,487,762 تومان`.
