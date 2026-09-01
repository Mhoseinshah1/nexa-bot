# Unknown Register — Robot Statistics v2

**UNK-RSV2-001**
- Question: Which "buyer" definition do the bulk wallet tools in User Management (`buyer` / `non-buyer`
  filters) use — the 56,792 or the 27,732 one?
- Evidence: REC-002 proves two definitions coexist under one label.
- Missing: any screen that states the filter's predicate.
- Safe verification: open the mass-tool filter screen read-only and see whether it echoes a population size.
- Impact: HIGH — an earlier phase used those filters to target real users; the audience differs by 29,060.
- Status: OPEN

**UNK-RSV2-002**
- Question: Is the blank all-time gateway bucket (36,432 / 6,543,053,894) the custom gateway?
- Evidence: only three gateways are enabled; card-to-card shows zero August activity; `درگاه دلخواه` shows
  11,889 August transactions; no other candidate exists.
- Missing: the gateway's own name field, readable from `💎 مالی → ⚙️ درگاه سفارشی → 🗂 نام درگاه`.
- Safe verification: open that settings screen read-only.
- Impact: MEDIUM
- Status: PARTIALLY_RESOLVED

**UNK-RSV2-003**
- Question: Why do the group totals lose 6 orders and 5,312,000 تومان against the all-time card?
- Evidence: REC-006; the same gap appeared in the first pass at a similar magnitude.
- Missing: any "no group" or "deleted user" bucket in the UI.
- Safe verification: none available from this feature.
- Impact: LOW (0.05 %) but it signals a hidden bucket.
- Status: OPEN

**UNK-RSV2-004**
- Question: Why is the all-time renewal total 309,978,600 تومان (6.5 %) larger than the sum of the three
  groups' renewal totals, when order totals partition to within 0.05 %?
- Evidence: REC-007.
- Missing: a per-group renewal basis statement.
- Safe verification: none from this feature; would need source or DB.
- Impact: **HIGH** — 6.5 % is far too large to be drift, and it means one of the two renewal figures is
  measuring something else.
- Status: OPEN

**UNK-RSV2-005**
- Question: What exact window does `درآمد پیش‌بینی‌شده ماهانه` sum, and does it apply any projection?
- Evidence: 1,394,242,740 against a measured 30-day (Aug 2 – Sep 1) order total of 1,438,391,525; the
  44,148,785 difference is the size of a single busy day, consistent with a 30-day window one day narrower.
- Missing: a trailing-30-day single-range preset to compare against directly.
- Safe verification: a custom range 2026/08/03 → 2026/09/01 would settle it in one query.
- Impact: MEDIUM
- Status: PARTIALLY_RESOLVED

**UNK-RSV2-006**
- Question: What timestamp field does each metric filter on (created / paid / completed / renewed)?
- Evidence: the feature never states a basis; `آمار کل`'s `مجموع فروش (فقط سرویس‌های فعال)` clearly mixes
  a historical amount with a current-state filter.
- Missing: any per-metric basis label.
- Safe verification: none non-destructive.
- Impact: HIGH for a rebuild.
- Status: OPEN — use conceptual labels, never assume field names.

**UNK-RSV2-007**
- Question: Does `تعداد کل سفارشات` include orders in non-active statuses (unpaid, failed, deleted by
  user, deleted by admin, deactivated, missing on panel)?
- Evidence: the web-admin status enum has seven values; this feature exposes none of them and offers no
  status filter. `سفارش‌های دارای مبلغ (غیررایگان)` is the only sub-classification, and it is about price,
  not status.
- Missing: any status-aware view.
- Safe verification: compare against the web panel's filtered order list — out of scope here.
- Impact: HIGH
- Status: OPEN

**UNK-RSV2-008**
- Question: How does the date prompt handle invalid input, an end before a start, or a Jalali date?
- Evidence: none — deliberately not probed, per the brief.
- Impact: LOW
- Status: NOT_TESTED (deliberate)

**UNK-RSV2-009**
- Question: Are the two 100 % metrics really inverted-and-clamped?
- Evidence: both true ratios invert to > 100 %; the hypothesis fits both.
- Missing: source.
- Impact: LOW (the values are unusable either way)
- Status: PARTIALLY_RESOLVED

**UNK-RSV2-010**
- Question: What is `نوع تسویه: پیش‌پرداخت / مصرفی` — how does usage-based reseller settlement differ?
- Evidence: the counter exists (2 prepaid, 0 usage-based); no usage-based panel exists to observe.
- Impact: MEDIUM for reseller rebuild.
- Status: OPEN

**UNK-RSV2-011**
- Question: Does `شارژ دستی توسط ادمین` in the per-user report sum credits only, or credits and debits as
  positives?
- Evidence: user [TELEGRAM_USER_ID_REDACTED] shows 5,501,000; an earlier phase applied +1,000 then −1,000 to this account.
- Missing: a pre-change baseline of this specific metric.
- Impact: LOW
- Status: OPEN

**UNK-RSV2-012**
- Question: Why does the per-user money not close? Charges 3,306,418 + admin 5,501,000 = 8,807,418 in;
  purchases 4,604,900 + renewals 554,500 + extra volume 71,701 = 5,231,101 out; balance should be
  3,576,317 but reads 2,659,767 — a 916,550 residual.
- Evidence: the per-user report itself.
- Missing: admin debits, refunds and gift credits are not broken out per user.
- Impact: MEDIUM — it means the per-user report is not a complete ledger.
- Status: OPEN

**UNK-RSV2-013** — Export / scheduled / group-delivered reports.
- Evidence: none of the 26 buttons offers export, file generation, "send to group", or scheduling; nothing
  references `📣 گزارشات ربات`.
- Status: **NOT_EXPOSED** (not incomplete work)

**UNK-RSV2-014** — Drill-down from any metric or leaderboard row into an order, payment or user record.
- Evidence: every report is terminal text; the only "navigation" is between reports.
- Status: **NOT_EXPOSED**

**UNK-RSV2-015** — Status filters, pagination, sorting controls, peak-hour or weekday breakdowns, charts.
- Status: **NOT_EXPOSED**

**UNK-RSV2-016** — Order-status and order-type reporting (عادی / تست / سفارشی; فعال / پرداخت نشده /
حذف شده / ناموفق / …).
- Evidence: the enums exist in the web admin panel; this feature reports none of them.
- Status: **NOT_EXPOSED**
