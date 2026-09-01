# Robot Statistics v2 — Business Rules (RSV2-BR)

**RSV2-BR-001** — Rule: `📊 آمار ربات` is a single edit-in-place report canvas; every report replaces the
previous one in the same Telegram message. · Metric/Report: all · Scope: feature · Period: n/a ·
Calculation: n/a · Evidence: message id stayed constant across 14 consecutive reports · Confidence: VERIFIED_BY_UI

**RSV2-BR-002** — Rule: A report longer than one Telegram message spills into a newly sent continuation
message which carries the live keyboard; the canvas keeps a stale one. · Report: مقایسه فروش محصولات ·
Evidence: mid 29489 (3408 chars) + mid 29490 (709 chars) · Confidence: VERIFIED_BY_UI

**RSV2-BR-003** — Rule: `تعداد سفارش‌های ثبت‌شده` / `مجموع مبلغ سفارش‌ها` count **new service orders
only**. Renewals, extra volume, extra time and location changes are parallel streams, and test accounts
are excluded entirely. · Scope: every period report and the all-time card · Calculation:
total revenue = orders + renewals + extra volume + extra time + location change · Evidence: REC-001,
REC-005 · Confidence: STRONGLY_INFERRED

**RSV2-BR-004** — Rule: No metric anywhere in the feature shows total revenue. The admin must add four to
five numbers by hand. · Evidence: metrics catalog · Confidence: VERIFIED_BY_UI

**RSV2-BR-005** — Rule: `مقایسه فروش محصولات` is exactly `تعداد سفارش‌های ثبت‌شده` grouped by product;
its `جمع کل` equals the orders metric for the same range to the unit. · Evidence: REC-005 (three ranges)
· Confidence: VERIFIED_BY_MATH

**RSV2-BR-006** — Rule: The comparison lists only products that had at least one sale in one of the two
periods; it is not the full catalogue. · Evidence: `10 گیگ 30 روزه` is absent from the 41-row month view
yet appears in the per-user report · Confidence: STRONGLY_INFERRED

**RSV2-BR-007** — Rule: Percentage change in the comparison is computed on **revenue**, not units, as
(B − A)/A × 100, one decimal place. · Evidence: −85.8 % from 49,507,050 → 7,027,000 = −85.804 %;
−99.5 %, −9.9 %, +40.3 % all reproduce · Confidence: VERIFIED_BY_MATH

**RSV2-BR-008** — Rule: When the first period is zero the bot prints `🟢 🚀` instead of a percentage; when
both amounts are zero it prints `⚪️ ۰٪`. · Evidence: observed in the 7/7 and 30/30 views · Confidence: VERIFIED_BY_UI

**RSV2-BR-009** — Rule: The financial block (wallet charges by gateway, refunds, referral commission,
lottery) exists **only** in the custom-range report. No preset shows it. · Confidence: VERIFIED_BY_UI

**RSV2-BR-010** — Rule: Wallet top-ups are reported by "gateway", and the gateway list includes three
non-gateways: `هدیه شروع` (start gift), `افزایش موجودی توسط ادمین`, `کسر موجودی توسط ادمین`. ·
Confidence: VERIFIED_BY_UI

**RSV2-BR-011** — Rule: `کارت به کارت` shows 87,115 all-time payments but **zero** activity in August.
This is consistent with the Financial phase's finding that card-to-card is currently DISABLED and only
`درگاه سفارشی`, `nowpayment` and `Star Telegram` are enabled. · Confidence: STRONGLY_INFERRED

**RSV2-BR-012** — Rule: `آمار نمایندگان` reports on **resellers who own a reseller PANEL** (2 of them),
not on the 30 users in tiers n/n2. The two populations are unrelated and must never be conflated. ·
Evidence: section header `🗂 بخش: نمایندگانی که پنل نمایندگی دارند`; 2 vs 30 · Confidence: VERIFIED_BY_UI

**RSV2-BR-013** — Rule: Reseller-panel "sales" is a **wallet debit** (`کسرشده از حساب`), a different
transaction type from an order. Reseller settlement has two modes, `پیش‌پرداخت` (prepaid) and `مصرفی`
(usage-based). · Confidence: VERIFIED_BY_UI

**RSV2-BR-014** — Rule: `اکانت تست` counters are historical event counts and are never reset by changing
a user's test-account eligibility limit. · Evidence: user [TELEGRAM_USER_ID_REDACTED] shows 37 test accounts received
while their `محدودیت اکانت تست` is 1; the all-time counter reads 40,668 after the global reset performed
in an earlier phase · Confidence: VERIFIED_BY_MATH + cross-phase

**RSV2-BR-015** — Rule: Historical product statistics resolve the product **by current reference**, not by
a snapshot. Orders whose product row has been deleted collapse into a single literal bucket
`محصول حذف‌شده`. · Evidence: per-user report for [TELEGRAM_USER_ID_REDACTED], `محصول حذف‌شده : 11 بار` ·
Confidence: VERIFIED_BY_UI. **Direct input to the future pricing-snapshot model: MirzaBot has no snapshot.**

**RSV2-BR-016** — Rule: Leaderboards are capped at 10 and the `🔢 نمایش: N` line reports the ACTUAL number
returned, not the cap (observed 1, 2 and 10). · Confidence: VERIFIED_BY_UI

**RSV2-BR-017** — Rule: The empty state is `❌ داده‌ای برای نمایش وجود ندارد.` and it omits the
`🔢 نمایش:` line. · Evidence: `🟢 بیشترین سرویس فعال` under آمار نمایندگان · Confidence: VERIFIED_BY_UI

**RSV2-BR-018** — Rule: `گزارش یک کاربر` accepts either a numeric Telegram id or an `@username`. ·
Confidence: VERIFIED_BY_UI

**RSV2-BR-019** — Rule: The per-user `مجموع شارژ حساب` EXCLUDES admin manual credits, which are reported
separately as `شارژ دستی توسط ادمین`. · Evidence: user [TELEGRAM_USER_ID_REDACTED] shows 3,306,418 total charge and
5,501,000 admin charge — the "total" is smaller than one of its supposed parts · Confidence: STRONGLY_INFERRED

**RSV2-BR-020** — Rule: `مجموع فروش (فقط سرویس‌های فعال)` is a live-filtered subset of all-time sales:
it moves whenever a service expires, without any new order. · Evidence: 4,020,111,113 → 4,018,909,113
in 23 minutes while total sales stayed fixed · Confidence: VERIFIED_BY_UI

**RSV2-BR-021** — Rule: `تعداد پنل‌های متصل` counts CONFIGURED panels, not reachable ones — it reads 5
and includes the deliberately unreachable TEST_3XUI_AUDIT created earlier the same day. ·
Confidence: VERIFIED_BY_UI (cross-phase)

**RSV2-BR-022** — Rule: The feature is entirely read-only. It contains no refund, credit, settlement,
delete or status-change control, and no drill-down from any number into an actionable record. ·
Confidence: VERIFIED_BY_UI (26/26 buttons opened)

**RSV2-BR-023** — Rule: Refunds ARE a first-class reported metric (`عودت وجه`), available only in the
custom-range financial block, count + amount, no actor/reason/status breakdown. Value for all of
August 2026: 0 / 0. · Confidence: VERIFIED_BY_UI

**RSV2-BR-024** — Rule: Referral commission and the lottery wheel are reported as period costs
(429 payouts / 7,502,465 تومان and 712 wins from 4,405 spins / 4,820,000 تومان in August). Neither has
its own menu; both appear only inside the custom-range financial block. · Confidence: VERIFIED_BY_UI

**RSV2-BR-025** — Rule: Day boundaries follow Iran local time (UTC+03:30); `امروز` ends at the moment of
the request, with seconds precision. · Confidence: STRONGLY_INFERRED
