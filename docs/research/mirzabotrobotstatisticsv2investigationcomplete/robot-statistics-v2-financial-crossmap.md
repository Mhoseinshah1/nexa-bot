# Payment Statistics

Two payment surfaces exist and **they use different names for the same gateways**.

## A. All-time block in `آمار کل` — `🔹 درگاه‌های پرداخت (از ابتدا تا کنون)`

| Gateway (verbatim) | Successful payments | Amount (تومان) |
|---|---|---|
| `کارت به کارت` | 87,115 | 14,301,073,526 |
| `درگاه ارز دیجیتال` | 303 | 327,859,190 |
| `💵 واریز رمزارز ترون` | 1 | 538,384 |
| `⭐️استارز تلگرام ( 5 درصد شارژ هدیه )⭐️` | 345 | 61,372,942 |
| *(blank)* | 36,432 | 6,543,053,894 |
| **total** | **124,196** | **21,233,897,936** |

The total is not displayed; it is computed here.

## B. Custom-range block — `💵 شارژ کیف پول به تفکیک درگاه پرداخت` (August 2026)

| Line (verbatim) | Amount | Transactions |
|---|---|---|
| `درگاه دلخواه` | 2,224,885,397 | 11,889 |
| `هدیه شروع` | 66,500,000 | 2,521 |
| `استارز تلگرام` | 19,056,529 | 92 |
| `NowPayments` | 11,605,685 | 36 |
| `افزایش موجودی توسط ادمین` | 9,880,800 | 13 |
| `کسر موجودی توسط ادمین` | 1,180,800 | 5 |
| `💳 مجموع کل شارژ کیف پول` | **2,333,109,211** | — |

## What this tells us

1. **Only successful payments are reported.** Neither block has a failed / pending / abandoned counter.
   Whether an unsuccessful attempt exists in the data at all is UNKNOWN.
2. **The two blocks disagree on names.** `درگاه ارز دیجیتال` (A) vs `NowPayments` (B); a blank name in A
   vs `درگاه دلخواه` in B. The all-time block appears to read a stored display-name column (blank for the
   custom gateway) while the range block uses hard-coded labels.
3. **Three "gateways" in block B are not gateways**: the start gift, and manual admin credit and debit.
   Reporting a wallet grant as payment income is a category error.
4. **`کارت به کارت` has zero August activity** despite being the largest all-time bucket — consistent
   with the Financial phase's finding that it is currently DISABLED and only `درگاه سفارشی`,
   `nowpayment` and `Star Telegram` are enabled.
5. **Gateway cashback does not appear.** `💰 کش بک کارت به کارت` exists as a per-gateway setting; no
   cashback figure is reported anywhere in `📊 آمار ربات`, so whether the amounts above are gross or net
   of cashback is UNKNOWN.
6. **Payments ≠ orders.** 124,196 all-time payments against 74,860 orders. They are wallet top-ups; the
   order pipeline spends from the wallet afterwards.
# Wallet Statistics

## Exposed reason codes for money entering or leaving a wallet

| Reason | Where reported | August 2026 |
|---|---|---|
| gateway top-up (`درگاه دلخواه`, `استارز تلگرام`, `NowPayments`) | custom-range financial block | 2,255,547,611 across 12,017 transactions |
| start gift `هدیه شروع` | same block, listed as a gateway | 66,500,000 / 2,521 |
| admin credit `افزایش موجودی توسط ادمین` | same block | 9,880,800 / 13 |
| admin debit `کسر موجودی توسط ادمین` | same block, **added to the total instead of subtracted** | 1,180,800 / 5 |
| refund `عودت وجه` | same block, separate line | 0 / 0 |
| referral commission `پورسانت زیرمجموعه‌گیری` | same block, separate line | 7,502,465 / 429 |
| lottery prize `گردونه شانس` | same block, separate line | 4,820,000 / 712 wins from 4,405 spins |
| purchase spend | **not reported as a wallet event** — only as order/renewal/add-on revenue | — |
| cashback | **NOT_EXPOSED** | — |

## Balance metrics

`💰 مجموع موجودی فعلی کاربران (هم‌اکنون)` = 2,885,273,946 تومان, and it partitions exactly across the
three tiers (REC-004). Per user, the same value appears as `💰 موجودی فعلی حساب`.

## Ledger completeness — it is not a ledger

Per-user, the numbers do not close: 3,306,418 (charges) + 5,501,000 (admin) in, versus
4,604,900 + 554,500 + 71,701 out, leaves 3,576,317 where the balance reads 2,659,767 — a residual of
916,550 (UNK-RSV2-012). Debits, gifts and refunds are not broken out per user, so the per-user report
cannot be reconciled from its own fields. Treat it as a summary, not an account statement.

Also note `مجموع شارژ حساب` **excludes** admin manual credits, which are reported separately — so the
line labelled "total" is smaller than one of its apparent components (RSV2-BR-019).
# Refund Statistics

**Exposed, and only in the custom-range financial block:**
```
🔁 تعداد عودت وجه به کاربران: 0 مورد
💸 مجموع مبلغ عودت وجه: 0 تومان
```

- Value for the whole of August 2026: **zero refunds**.
- Granularity: count and amount only. There is **no** breakdown by source order or payment, no
  wallet-vs-gateway distinction, no admin actor, no reason, no status, no date list, and no drill-down.
- **No refund can be executed from this feature.** There is no button anywhere in `📊 آمار ربات` that
  performs, approves or reverses anything. Refund actions live in Orders / User Management (the web admin
  panel's order actions include `حذف سرویس و بازگشت وجه`), not here.
- The preset reports never show refunds at all, so an admin using `امروز` or `ماه قبل` has no refund
  visibility whatsoever.

Nothing was executed. Confidence: VERIFIED_BY_UI.
# Referral / Commission Statistics

**Exposed, custom-range financial block only:**
```
🤝 تعداد پورسانت زیرمجموعه‌گیری: 429 مورد
💰 مجموع پورسانت پرداخت‌شده: 7,502,465 تومان
```
August 2026: 429 payouts, 7,502,465 تومان, average 17,488 تومان per payout.

Also related, in the same block:
```
🎯 گردونه شانس: 712 برد از 4405 چرخش
🎁 مجموع جوایز پرداختی گردونه شانس: 4,820,000 تومان
```
Win rate 16.2 % (not displayed by the bot). Average prize 6,770 تومان.

## Per-user

`🔗 تعداد زیرمجموعه` appears in `گزارش یک کاربر` (0 for the audited user). There is **no per-user
commission earned/paid figure** and no referral leaderboard.

## Not exposed

- commission rate or tier (User Management has `🧮 پورسانت اختصاصی` with a default of 10 %, but the
  statistics feature never shows a rate)
- signup gift as a distinct metric — the start gift appears only disguised as a payment gateway line
- reseller commission as a separate concept from referral commission
- payment status of a commission (pending vs paid); the label says `پرداخت‌شده`, so presumably only
  settled payouts are counted — INFERRED, not stated
- any period other than a custom range

Nothing was paid or recalculated. Confidence: VERIFIED_BY_UI.
# Reseller Statistics

## The critical distinction

There are **two different reseller populations** in MirzaBot, and this feature reports them in two
different places:

| | `👥 گزارش گروه‌های کاربری` | `👨‍💼 آمار نمایندگان` |
|---|---|---|
| Population | users in tiers `n` and `n2` | users who own a **reseller panel** |
| Size | 29 + 1 = 30 | **2** |
| Header | `گروه کاربری: نماینده عادی / نماینده پیشرفته` | `🗂 بخش: نمایندگانی که پنل نمایندگی دارند` |
| "Sales" means | order value, same as any customer | **wallet debit** (`کسرشده از حساب`) |

Conflating them is the single easiest mistake to make here, and the first pass made it (CON-007).

## `آمار نمایندگان` — every exposed metric (all-time snapshot)

| Metric | Value |
|---|---|
| `👥 تعداد کل پنل‌های نمایندگی` | 2 |
| `🟢 پنل‌های فعال و منقضی‌نشده` | 2 |
| `💠 نوع تسویه` | `پیش‌پرداخت 2 | مصرفی 0` |
| `👤 کل کاربران ساخته‌شده (از ابتدا)` | 2 |
| `🟢 کاربران فعال / منقضی‌نشده (هم‌اکنون)` | 0 |
| `📦 مجموع حجم فروخته‌شده (از ابتدا)` | 15 گیگ |
| `💵 مجموع فروش (کسرشده از حساب نمایندگان)` | 90,000 تومان |
| `🧾 تعداد تراکنش‌های کسر از حساب` | 2 |
| `💳 مجموع شارژ حساب توسط نمایندگان` | 571,848 تومان |
| `🔁 تعداد شارژ موفق` | 10 |
| `💰 مجموع موجودی فعلی نمایندگان (هم‌اکنون)` | 4,559,150 تومان |
| `📈 میانگین فروش به ازای هر نماینده` | 45,000 تومان = 90,000 ÷ 2, VERIFIED_BY_MATH |

New concept discovered: **settlement type**, prepaid (`پیش‌پرداخت`) vs usage-based (`مصرفی`). No
usage-based panel exists in this deployment, so its behaviour is unobservable (UNK-RSV2-010).

## Reseller leaderboards

Four, mirroring the user ones, each row carrying `📶 وضعیت پنل نمایندگی: 🟢 فعال`:
- `🏆 بیشترین فروش` — `💠 مجموع فروش (کسرشده از حساب)` · `📦 تعداد تراکنش` · 30-day figure
- `💳 بیشترین شارژ حساب` — `💠 مجموع شارژ حساب` · `📦 تعداد شارژ موفق` · 30-day figure
- `🟢 بیشترین سرویس فعال` — titled `بیشترین کاربر فعال`; returned the **empty state**
- `💰 بیشترین موجودی` — `💠 موجودی فعلی حساب` only

Cross-link: the top-balance reseller's 4,169,150 تومان equals the `نماینده پیشرفته` group's entire
current balance, so the single n2-tier user is also a reseller-panel owner. The second panel owner is
[TELEGRAM_USER_ID_REDACTED] — the same account authorised as the test admin in the Admin Management phase.

## Not exposed here

Membership fee, monthly purchase floor, reseller expiry date, sales-bot status, negative balance, and
per-reseller commission. Those live in General Settings and User Management, not in statistics.
