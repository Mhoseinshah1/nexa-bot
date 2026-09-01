# Source bugs & inconsistencies visible in the log group

| ID | Where | Bug | Severity for a rebuild |
|---|---|---|---|
| BUG-LGR-001 | 🛍 LGR-MSG-001 | The label `زمان` is used **twice** in one message — once for the duration (`30 روز`) and once for the purchase timestamp. | parser-breaking |
| BUG-LGR-002 | 🛍 / 📌 | `قیمت نهایی` means "amount charged to gateway" in the gateway family but "amount debited from balance" in the wallet family. Same label, two semantics. | data-integrity |
| BUG-LGR-003 | 🛍 / 📌 | Amount formatting is inconsistent **inside the same message**: `188000 تومان` next to `25,000 تومان`. | parser-breaking |
| BUG-LGR-004 | 📌 R2 renewal | `زمان باقی‌مانده قبل تمدید` **equals** `تاریخ اتمام بعد تمدید` in 21/21 samples — the pre-renewal expiry is read after the update, so it is never reported. | correctness |
| BUG-LGR-005 | 📌 R2 renewal | The same field is labelled *remaining time* but holds a *date*. | correctness |
| BUG-LGR-006 | 📌 R2 renewal | R2 prints `موجودی قبل از خرید` but omits `موجودی بعد از خرید` (R1 prints both). | completeness |
| BUG-LGR-007 | 📌 | Two renewal templates (R1/R2) coexist in production with different field sets; the selector is unknown. | maintainability |
| BUG-LGR-008 | 📌 | `حجم مصرفی کاربر قبل تمدید` is suffixed `گیگابایت` in the bot path and `GB` in the mini-app path. | consistency |
| BUG-LGR-009 | 📌 add-ons | `👤 نام کاربری کانفیگ <value>` — the colon is missing entirely in the extra-traffic family. | parser-breaking |
| BUG-LGR-010 | 📌 add-ons | `موجودی کاربر قبل خرید : 0` — no `تومان` unit, unlike every other balance field. | consistency |
| BUG-LGR-011 | 📝 N-2 | `حجم باقی مانده : NAN بایت` in **37/37** volume-exhaustion messages. The remaining-volume computation produces NaN once the quota is consumed and the unit falls back to bytes. | correctness |
| BUG-LGR-012 | 📝 N-4 | `تعداد روز باقی مانده : -3` — a negative count instead of "expired N days ago". | presentation |
| BUG-LGR-013 | 📝 | Four encodings of one status enum: `active`, `فعال`, `🚫 پایان حجم`, `🔚 پایان زمان سرویس`. | data-integrity |
| BUG-LGR-014 | 📝 | `آخرین اتصال کاربر` is **Gregorian** while every other timestamp in the group is **Jalali**. | consistency |
| BUG-LGR-015 | 📝 | ZWNJ (U+200C) appears inside label/colon sequences (`تعداد روز باقی مانده ‌:‌2`). Any parser must normalise it. | parser-breaking |
| BUG-LGR-016 | ⚙️ سایر | Header spells `یادداشت` correctly, field labels spell it `یاداشت`. | cosmetic |
| BUG-LGR-017 | ⚙️ سایر | Lucky-wheel win logs **no prize** — the business event is unrecoverable from the log. | completeness |
| BUG-LGR-018 | ⚙️ سایر | New-user log carries **no referral source**, so referral attribution cannot be reconstructed. | completeness |
| BUG-LGR-019 | 💰 مالی | Five payment templates with no common schema; three different identifier spaces (`کد پیگیری`, `Order/Invoice/Purchase/Payment ID`, none). | architecture |
| BUG-LGR-020 | 💰 مالی | `مبلغ تراکنش <n>` has **no colon and no currency unit** in the dominant family. | parser-breaking |
| BUG-LGR-021 | 💰 مالی | The customer's **crypto wallet address** is written in clear into a shared group. | security |
| BUG-LGR-022 | 💰 مالی | FX rate printed at raw float precision (`4.7846889952153 usd`). | presentation |
| BUG-LGR-023 | 💰 مالی | Enum value is the misspelling `cart to cart` (should be *card to card*). | data quality |
| BUG-LGR-024 | 💰 مالی | The decrease template says `👤 اطلاعات کاربر :` where the increase says `👤 اطلاعات کاربر دریافت کننده موجودی :`, and drops the thousands separator on the amount. | consistency |
| BUG-LGR-025 | 🌙 شبانه | The nightly report is 4 unlinked messages with no run id; grouping is by timestamp proximity only. | parser-breaking |
| BUG-LGR-026 | 🤖 بکاپ | `backup_YYYY-MM-DD.zip` repeats 12× per day — guaranteed filename collision. | data-loss risk |
| BUG-LGR-027 | 🤖 بکاپ | Topic name says *ربات نماینده* but the caption says *ربات اصلی*. | documentation |
| BUG-LGR-028 | ❌ خطا | No dedup: the same expired-TLS error was posted 36 + 15 + 8 + 1 times in one day. | noise |
| BUG-LGR-029 | ❌ خطا | No recovery message — an error is never followed by "resolved". | observability |
| BUG-LGR-030 | group-wide | `نام کاربری کانفیگ` hex suffix is sometimes 4 chars, sometimes 8. Two generations coexist. | schema |
| BUG-LGR-031 | group-wide | Two spellings of the same inline button: `⚙️ مدیریت کاربر` and `مدیریت کاربر`. | cosmetic |
| BUG-LGR-032 | General | System-maintenance logs land in **General**, which Telegram always shows first, dominating the group preview. | UX |
