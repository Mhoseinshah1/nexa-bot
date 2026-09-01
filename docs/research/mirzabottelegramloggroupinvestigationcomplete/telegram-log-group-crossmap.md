# Cross-surface reconciliation — log group vs bot admin vs web panel

| ID | Claim | Log group evidence | Other surface | Verdict |
|---|---|---|---|---|
| LGR-REC-001 | `فروش کل = سفارش + تمدید` | nightly report arithmetic | `📊 آمار ربات` (RSV2 phase) and web `/reports/` | **AGREE** |
| LGR-REC-002 | Add-ons excluded from `فروش کل`, added to gross | nightly report | RSV2 `آمار افزونه‌ها` separate section | **AGREE** |
| LGR-REC-003 | Commission is the only gross→net deduction | nightly report | RSV2 `آمار پورسانت` | **AGREE** |
| LGR-REC-004 | Orders exclude renewals, add-ons and tests | purchase vs service-purchase vs test topics are disjoint | RSV2 order-statistics finding | **AGREE** — the topic split is the structural proof |
| LGR-REC-005 | Tracking code format = 8 lowercase hex | `کد پیگیری` in 🛍 and 🔑 | web-admin-v2 `identifiers.md` | **AGREE** |
| LGR-REC-006 | Config username = `<tgid>_<hex>` | every topic | web-admin-v2 `identifiers.md` | **AGREE**, but the log reveals a **4-hex legacy form** the web audit did not surface — extends the earlier finding |
| LGR-REC-007 | User tier enum `f` / `n` / `n2` | `نوع کاربر` in 🛍/📌/🔑 (`f`, `n` observed) | user-management phase | **AGREE**; `n2` NOT_OBSERVED in this group |
| LGR-REC-008 | `درگاه سفارشی` is the dominant gateway | 169/174 financial messages | RSV2 payment-statistics: the blank gateway resolved as `درگاه سفارشی`/`پرداخت سفارشی` | **AGREE** — the log confirms the name |
| LGR-REC-009 | Panel health check every 3 min with a private admin alert | **no such message in any topic** | owner statement (code-only) | **CONSISTENT** — the absence is expected, not a contradiction |
| LGR-REC-010 | `🚀 مولتی لوکیشن` is the panel used for essentially all traffic | 100% of sampled purchase/trial/notification messages | panel-management phase (multi-location panel) | **AGREE** |
| LGR-REC-011 | Backup cadence 120 min | 52/52 gaps | previously established in this same phase | **AGREE** |
| LGR-REC-012 | NowPayments as a live gateway | 1 financial message | **not** seen in the bot's gateway settings audit nor in web-admin-v2 | **NEW** — the log surfaces a rail the settings audit did not name. Flag for re-check. |
| LGR-REC-013 | Telegram Stars as a live gateway | 2 financial messages | bot-capabilities phase mentioned Stars support | **AGREE** |
| LGR-REC-014 | Mini-app is a live purchase channel | `تمدید اکانت از مینی اپ` | not covered by any earlier phase | **NEW** — the mini-app is a second front-end with its own code path |

## Two genuinely new facts this phase adds
1. **A Telegram mini-app renewal path exists** and is wallet-only. No earlier phase saw it.
2. **NowPayments (crypto/TON) is a live payment rail** with a much richer payload than any
   other. Earlier gateway audits did not list it — either it is configured outside the
   settings screens that were audited, or it was added after those captures.
