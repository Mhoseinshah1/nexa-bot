# Web Admin v2 — Business Rules (WEB-BR)

**WEB-BR-001** — Rule: `درآمد کل` = `درآمد اشتراک` + `درآمد سرویس‌های جانبی`. · Domain: reporting ·
Precondition: any of the 7/30/90-day windows · Result: total revenue including renewals and add-ons ·
Evidence: 1,438,030,525 + 874,563,823 = 2,312,594,348, exact · Telegram cross-ref: **confirms Robot
Statistics v2 REC-001** — Telegram's `مجموع فروش` is only the subscription half · Confidence: VERIFIED_BY_MATH

**WEB-BR-002** — Rule: `میانگین درآمد هر خریدار` = `درآمد اشتراک` ÷ `خریدار فعال` (subscription revenue,
not total). · Evidence: 1,438,030,525 ÷ 6,294 = 228,476.41 → displayed 228,476 · Confidence: VERIFIED_BY_MATH

**WEB-BR-003** — Rule: the web `تعداد سفارش` counts **subscription orders plus test-account orders**;
Telegram's `تعداد سفارش‌های ثبت‌شده` counts subscription orders only. · Evidence: 2026/08/31 → web 397,
Telegram 272 orders + 125 test accounts · Confirmed structurally by the order filter's
`نوع سفارش = تست` · Confidence: VERIFIED_BY_MATH

**WEB-BR-004** — Rule: orders carry a **7-value status** (`فعال`, `حذف شده توسط کاربر`, `پرداخت نشده`,
`حذف شده توسط ادمین`, `غیرفعال شده توسط ادمین`, `ناموجود در پنل`, `ناموفق`) and a **3-value type**
(`عادی`, `تست`, `سفارشی`). · Evidence: `/invoice/` filter radios · Telegram cross-ref: exposes neither ·
Confidence: VERIFIED_BY_UI

**WEB-BR-005** — Rule: panel capabilities are stored as thirteen `status_*` booleans in five form
groups, and **the available set depends on the provider**. · Evidence: Marzban renders 1 limit toggle
and the pasargard flag; x-ui renders 3 limit toggles and no provider tab · Telegram cross-ref: resolves
UNK-XUI-013 · Confidence: VERIFIED_BY_UI

**WEB-BR-006** — Rule: `پنل پاسارگارد` (`status_active_pasargard`) is a **Marzban-only per-panel
compatibility flag**, distinct from the standalone `پاسارگارد` provider type in Telegram's Add-Panel
picker. · Evidence: the toggle exists on panel 16 (Marzban) and the whole tab is empty on panel 18
(x-ui) · Confidence: VERIFIED_BY_UI

**WEB-BR-007** — Rule: for an x-ui/Sanaei panel the creation `توکن` is stored in the **password**
column and the username column is `null`. · Evidence: `/panel/18/` renders `نام کاربری پنل … null` and
`رمز عبور پنل … audit_test_token` · Telegram cross-ref: **resolves UNK-XUI-002** · Confidence: VERIFIED_BY_UI

**WEB-BR-008** — Rule: a new panel receives default trial parameters of **1 hour / 100 MB**. ·
Evidence: `/panel/18/` shows `زمان سرویس تست 1 ساعت` and `حجم سرویس تست 100 مگابایت` on a panel whose
trial values were never set · Confidence: VERIFIED_BY_UI

**WEB-BR-009** — Rule: panels can be **viewed, edited and deleted** from the web but **not created** —
there is no Add Panel anywhere. Panel creation is Telegram-only. · Confidence: VERIFIED_BY_UI (absence)

**WEB-BR-010** — Rule: custom-service pricing is a set of **price bands** keyed by
(range type ∈ {volume GB, time days}) × (tier ∈ {f, n, n2}) × (panel or all) × (optional specific user),
each with a `min`, `max` and a `قیمت پایه`. · Evidence: `/product/custom_srrvice_list/` and its add form
· Confidence: VERIFIED_BY_UI (schema) / PARTIALLY_RESOLVED (absolute vs per-unit)

**WEB-BR-011** — Rule: custom-pricing rules have **no priority, no enabled flag, no date scope and no
edit action** — precedence is implicit in code and a change means delete-and-recreate. ·
Confidence: VERIFIED_BY_UI (absence)

**WEB-BR-012** — Rule: the gateway roster is a **fixed eleven** with no Add Gateway; the web configures
only enable, three eligibility numbers, min/max amount and cashback percent, while credentials and
presentation live in Telegram. · Evidence: `/settings/gateway/`, 79 inputs = 2 hidden + 11 × 7 ·
Confidence: VERIFIED_BY_UI

**WEB-BR-013** — Rule: three gateways are enabled — NOWPayments (10 % cashback), درگاه سفارشی,
استارز تلگرام (5 % cashback); `کارت به کارت` is disabled. · Telegram cross-ref: independently confirms
the Financial phase and explains the zero card-to-card activity in Robot Statistics v2 ·
Confidence: VERIFIED_BY_UI

**WEB-BR-014** — Rule: a `0` in a gateway eligibility field means the condition is **disabled**, and the
form submits only changed fields. · Evidence: the page's own instruction text · Confidence: VERIFIED_BY_UI

**WEB-BR-015** — Rule: the admin model is `Admin(bot, username, permission)` where `permission` is one
of **seven** fixed role strings; there is no Role entity, no Permission entity and no per-admin override.
· Telegram cross-ref: **the Telegram phase found four roles** — CON-WEB-001 · Confidence: VERIFIED_BY_UI

**WEB-BR-016** — Rule: an admin can be **created and deleted but not edited** — the list has no edit
action. · Confidence: VERIFIED_BY_UI (absence)

**WEB-BR-017** — Rule: `انتقال` in the ancillary-service type chart is **account transfer between
Telegram ids**, not location change. · Evidence: the user detail page's `انتقال حساب کاربری` form
(`new_userid`) · Confidence: STRONGLY_INFERRED

**WEB-BR-018** — Rule: location change is switched off at **both** levels — globally
(`status_change_location` = false in shop settings) and per panel (`status_changeloc` = false on every
panel). · Telegram cross-ref: this is why `تعداد تغییر لوکیشن` reads 0 in every window ·
Confidence: VERIFIED_BY_UI

**WEB-BR-019** — Rule: the bot text store is a flat `users.*` key→string map of **608 entries**, each
with a stored default (per-key `بازگردانی` and `نمایش پیش‌فرض`), capped at 1000 characters. ·
Telegram cross-ref: Telegram edits **36** of them · Confidence: VERIFIED_BY_UI

**WEB-BR-020** — Rule: product **edit** exposes `limit_user`, a panel-hiding multi-select
(`/product/hide_panel/<id>/`) and a per-product inbound (`/product/set_inbound_product/<id>/`) that the
**create** form does not. · Confidence: VERIFIED_BY_UI

**WEB-BR-021** — Rule: cashback is configured per user tier globally (`cashbackf`/`cashbackn`/`cashbackn2`,
all 0) **and** per gateway (`کش‌بک (درصد)`). Two independent cashback mechanisms. ·
Confidence: VERIFIED_BY_UI

**WEB-BR-022** — Rule: Mini-App purchases are tracked as their own ancillary types
(`add_volume_miniapp`, `add_time_miniapp`, `extend_user_miniapp`) and are invisible to Telegram
statistics. `extend_user_miniapp` is the extra-user purchase Robot Statistics v2 found no counter for. ·
Confidence: VERIFIED_BY_UI

**WEB-BR-023** — Rule: order tracking codes are 8 lowercase hex; payment tracking codes are 10 lowercase
hex; panel-side service usernames are `<telegram_id>_<8 hex>`. · Confidence: VERIFIED_BY_MATH (measured
over full pages)

**WEB-BR-024** — Rule: the admin log records actor, a Persian action sentence, one customer id, a
timestamp and an IP — but **no before/after values and no entity id**. It is an activity feed, not an
audit trail. · Confidence: VERIFIED_BY_UI

**WEB-BR-025** — Rule: the panel is **multi-tenant** — a bot selector in the header, a `bot` hidden
input on every page, an `اضافه کردن ربات جدید` modal (token + username), a per-bot subscription with an
expiry and a server number, and an `/subscriptions/extend/<id>/` billing action. ·
Confidence: VERIFIED_BY_UI
