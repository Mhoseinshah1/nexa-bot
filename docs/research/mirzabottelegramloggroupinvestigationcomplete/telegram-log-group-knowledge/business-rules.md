# Business Rules derived from the Telegram log group

Prefix **`LGR-BR`**. Confidence per rule.

## Pricing & wallet
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-001 | On a gateway purchase, `قیمت محصول = قیمت نهایی + مبلغ استفاده‌شده از موجودی کیف‌پول`. `قیمت نهایی` is therefore **the amount charged to the gateway**, not the product price. | VERIFIED_BY_MATH (145,000 = 120,000 + 25,000) |
| LGR-BR-002 | On a wallet-only purchase (`جزئیات ساخت اکانت در ربات:`), `موجودی قبل − موجودی بعد = قیمت نهایی`, and `قیمت نهایی` means the balance debit. Same label, different meaning than LGR-BR-001. | VERIFIED_BY_MATH (993,000 − 888,000 = 105,000) |
| LGR-BR-003 | Wallet may be applied **partially** to a purchase; the remainder goes to the gateway. Two mutually exclusive wallet lines encode this. | VERIFIED_BY_UI |
| LGR-BR-004 | Mini-app renewals are **wallet-only** — no wallet line, no gateway amount, balance debited in full. | VERIFIED_BY_MATH (200,500 − 145,000 = 55,500) |
| LGR-BR-005 | A buyer's first ever purchase is flagged with `📌 خرید اول کاربر` in both purchase families. | VERIFIED_BY_UI (17/114) |

## Revenue model (confirms the Robot-Statistics V2 finding independently)
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-010 | `فروش کل = جمع سفارش‌ها + جمع تمدیدها` | VERIFIED_BY_MATH |
| LGR-BR-011 | `درآمد ناخالص = فروش کل + ترافیک اضافه + زمان اضافه` — add-ons sit **outside** `فروش کل` | VERIFIED_BY_MATH |
| LGR-BR-012 | `خالص درآمد = درآمد ناخالص − پورسانت`. Commission is the **only** deduction; gateway fees and refunds are not deducted. | VERIFIED_BY_MATH |
| LGR-BR-013 | Test accounts are free and enter no revenue line. | VERIFIED_BY_UI |

## Test accounts
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-020 | Trial quota is fixed at **120 ساعت / 200 MB**. | VERIFIED_BY_UI (82/82) |
| LGR-BR-021 | Only tier `f` receives trials; resellers (`n`,`n2`) never appear in the trial log. | VERIFIED_BY_UI (82/82) |
| LGR-BR-022 | For a trial, `کد پیگیری` **equals** the hex suffix of `نام کاربری کانفیگ`. For a paid purchase the two are independent. Two different tracking-code generators exist. | VERIFIED_BY_MATH (82/82 match; paid samples all mismatch) |

## Service lifecycle (cron)
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-030 | Volume warning fires when remaining **≤ 5 GB**. | VERIFIED_BY_MATH (n=83, max 4.99) |
| LGR-BR-031 | Time warning fires at exactly **2 days** remaining. | VERIFIED_BY_MATH (24/24) |
| LGR-BR-032 | An expired service is removed at **−3 days** — a **3-day grace period**. | VERIFIED_BY_MATH (15/15) |
| LGR-BR-033 | A volume-exhausted service is removed regardless of days remaining (0…48 observed). | VERIFIED_BY_MATH |
| LGR-BR-034 | Warnings appear **once per service per threshold** — no escalation/repeat. | STRONGLY_INFERRED (no duplicates in an 11-h window) |
| LGR-BR-035 | An "active but never connected" service is reported separately, without removal. | VERIFIED_BY_UI |

## Retention (cleanup cron)
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-040 | Unpaid invoices older than **5 days** are **deleted**. | VERIFIED_BY_UI |
| LGR-BR-041 | Incomplete payments older than **1 day** are **expired** (row kept, status terminal). | VERIFIED_BY_UI |
| LGR-BR-042 | The cleanup job runs **every 10 minutes** and posts even when it removed nothing. | VERIFIED_BY_MATH |

## Backups
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-050 | Database backup runs **every 120 minutes**, no jitter, 12/day. | VERIFIED_BY_MATH (52/52) |
| LGR-BR-051 | Backups are password-protected ZIPs; the password is **not** transmitted with the file. | VERIFIED_BY_UI |
| LGR-BR-052 | Backup file name contains the **date only**, so all 12 daily files collide. | VERIFIED_BY_UI |

## Payments
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-060 | Four payment rails are in production: `درگاه سفارشی`, `استار تلگرام`, `NowPayments`, `cart to cart`. | VERIFIED_BY_UI |
| LGR-BR-061 | Only the NowPayments family carries a payment **status** field (`finished`). The other rails log success implicitly; failures land in `❌ گزارش خطا ها`. | VERIFIED_BY_UI |
| LGR-BR-062 | Telegram-Stars payments store the resulting IRR amount, not the rate (43 ⭐ ⇒ 137,922 تومان at capture time). | VERIFIED_BY_UI |
| LGR-BR-063 | Manual admin wallet adjustments are logged with the **acting admin's** id and username, the target user, the delta and the resulting balance — but **not the reason**. | VERIFIED_BY_UI |

## Referral commission
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-070 | Commission is credited to the referrer's **wallet**, and the log shows the referrer's balance after the credit. | VERIFIED_BY_UI |
| LGR-BR-071 | The log carries no order id, no purchase amount and no rate — the percentage is not derivable from this group. | VERIFIED_BY_UI (absence) |
| LGR-BR-072 | Commission ≈ 2.1% of gross revenue in the observed day (1,740,790 / 82,788,775). | VERIFIED_BY_MATH (single day) |

## Logging architecture
| ID | Rule | Confidence |
|---|---|---|
| LGR-BR-080 | The log is **append-only**: no message is ever edited or deleted; no dedup; no correlation ids between related events in different topics. | VERIFIED_BY_UI |
| LGR-BR-081 | Routing is **by topic**, one Telegram forum topic per event class; there is no severity level and no central stream. | VERIFIED_BY_UI |
| LGR-BR-082 | Success and failure of the same operation are logged in **different topics** (e.g. purchase → 🛍, failed purchase → ❌), with no shared key. | VERIFIED_BY_UI |
| LGR-BR-083 | Admin-side mutations other than wallet adjustment and receipt approval are **not logged at all**. | VERIFIED_BY_UI (absence across 11 topics) |
| LGR-BR-084 | Panel-down alerts are **not** sent to this group; they go to the admin privately. | VERIFIED_BY_UI (absence) + VERIFIED_BY_OWNER |
