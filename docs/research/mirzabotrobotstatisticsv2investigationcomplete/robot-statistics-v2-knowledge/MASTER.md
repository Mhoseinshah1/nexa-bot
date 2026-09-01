# MASTER — Robot Statistics, second pass (deep audit)

**Feature**: `پنل مدیریت → 📊 آمار ربات` (Telegram admin statistics)
**Date**: 2026-09-01, 05:58–06:22 bot time · Bot 7.5.10 / Mini App 0.1.2 / Bot Agent 1.3.14
**Mode**: READ-ONLY. Zero mutations. 26/26 buttons opened.
**Authorised lookup**: user [TELEGRAM_USER_ID_REDACTED] only.

## The five findings that matter most

1. **`مجموع فروش` is not revenue.** Orders exclude renewals, extra volume, extra time and test accounts.
   Real August revenue was 2,362,249,973 تومان; the metric an admin would read as "sales" says
   1,464,486,775 — a 38 % understatement. No screen anywhere shows the true total. (REC-001, REC-005)
2. **`میانگین خرید هر مشتری` = active-service revenue ÷ paid order count.** Solved and verified on two
   live snapshots. It is neither an average purchase nor per customer, and the identically-labelled group
   metric uses a completely different (correct) formula. (REC-008)
3. **"Buyer" has two definitions in one feature** — 56,792 on the all-time card, 27,732 across the group
   report. The tiers partition users exactly, so both cannot be right. (REC-002)
4. **`ماه قبل` silently drops its own end day**, and the sibling comparison feature's "ماه قبل" does not.
   Proved three independent ways. The comparison presets have the opposite problem: their two periods
   overlap by a day and each is a day too long. (SOURCE_BUG-STATS-004/005)
5. **Historical product attribution is by current reference.** Deleted products collapse into
   `محصول حذف‌شده`; renaming a product rewrites history. Direct input to the pricing-snapshot model.
   (RSV2-BR-015)

## Files

| File | Contents |
|---|---|
| `_raw-captures.md` | every report verbatim — the primary evidence |
| `menu-tree.md` | RST-001…011a, the edit-in-place canvas model, what is NOT_EXPOSED |
| `metrics-catalog.md` | MET-001…066 with unit, kind, period, entity, formula, confidence |
| `date-filter-model.md` | all 9 range methods, inclusivity, calendars, timezone, the off-by-one proofs |
| `cross-surface-reconciliation.md` | REC-001…012 plus the overlap map |
| `calculation-semantics.md` | every reproduced formula, and every wrong one |
| `sales-statistics.md` | what each monetary metric represents; sales ≠ cash in |
| `order-statistics.md` | what is exposed, and the total absence of order status/type |
| `renewal-statistics.md` | purchase vs renewal, and the 6.5 % renewal gap |
| `addons-statistics.md` | extra volume / time / location change; extra user missing |
| `payment-statistics.md` | two gateway surfaces with different names |
| `wallet-statistics.md` | reason codes; why it is not a ledger |
| `refund-statistics.md` | exposed, zero for August, no drill-down |
| `referral-commission-statistics.md` | commission and lottery as period costs |
| `reseller-statistics.md` | panel owners (2) vs tier resellers (30) |
| `user-statistics.md` | tier snapshot, the buyer-definition problem, count vs unique |
| `test-account-statistics.md` | historical event counter, unaffected by eligibility resets |
| `product-statistics.md` | comparison model, % formula, product-history semantics |
| `per-user-statistics.md` | 25 fields, the [TELEGRAM_USER_ID_REDACTED] cross-check |
| `drilldowns.md` | there are none — and why that makes the feature safe |
| `status-semantics.md` | the six state words, and the missing order statuses |
| `business-rules.md` | RSV2-BR-001…025 |
| `source-bugs.md` | 9 bugs + 10 UX risks, all proven from displayed numbers |
| `unknowns.md` | UNK-RSV2-001…016 with status |
| `contradictions.md` | CON-001…014 against the first pass |
| `incidents.md` | one benign stale-keyboard press; nothing else |
| `evidence-index.md` | E2-01…24 |
| `progress.md` | the checkpoint block |

## Safety statement

NO REFUND EXECUTED · NO WALLET CHANGE · NO ORDER DELETED · NO SERVICE DELETED · NO PAYMENT STATUS
CHANGED · NO RECEIPT APPROVED OR REJECTED · NO USER MODIFIED · NO COUNTER RESET · NO FINANCIAL MUTATION.
Every action was a report render, a navigation step, or a date/identifier typed into a read-only prompt.
