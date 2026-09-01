# Unknown Register — Web Admin v2

**UNK-WEB-001** · Question: what does `/admin/set_id_notif/` actually control, and why is it empty while
Telegram's report group is set? · Web evidence: a single empty `id_notif` field · Telegram evidence: a
live `-100…` supergroup id in `📣 گزارشات ربات` · Missing: any description text on either screen ·
Safe verification: none without saving · Impact: notification architecture · Status: **OPEN**

**UNK-WEB-002** · Question: why does `/admin/list` show only one admin when the Telegram phase used a
test admin `[TELEGRAM_USER_ID_REDACTED]`? · Missing: the Telegram admin list re-read (out of scope) · Impact: RBAC model ·
Status: **OPEN**

**UNK-WEB-003** · Question: is a custom-pricing `قیمت پایه` an absolute price for the band or a per-unit
rate? · Web evidence: rule 9 (30–500 GB @ 4,500) + rule 10 (10–90 d @ 1,000) prices a 30 GB/30 d service
at 165,000, plausibly above the 141,778 fixed plan — but rule 3 (5–50 GB @ 450,000) is nonsensical
per-GB · Missing: a customer-side custom purchase to price-check · Impact: **high — pricing engine** ·
Status: **PARTIALLY_RESOLVED**

**UNK-WEB-004** · Question: how are overlapping custom-pricing rules resolved? · Web evidence: overlaps
exist by design; there is no priority, enabled flag or date scope · Safe verification: none from the UI ·
Impact: high · Status: **OPEN**

**UNK-WEB-005** · Question: is the payment-status enum three values or four? · Web evidence: charts say
`موفق`/`در انتظار`/`ناموفق`; the list renders `رد شده` · Status: **OPEN**

**UNK-WEB-006** · Question: what is a user id in the `1000…` range (`[WEB_USER_ID_REDACTED]`)? · Impact: identifier
model · Status: **OPEN**

**UNK-WEB-007** · Question: the 96,000 (0.29 %) daily gap between web and Telegram ancillary revenue ·
Status: **OPEN**

**UNK-WEB-008** · Question: does `دامنه لینک ساب` auto-seed from the panel address at creation, or is the
detail page falling back to it for display? · Web evidence: panel 18 shows the panel URL in that field
although nothing was ever submitted to it · Status: **OPEN**

**UNK-WEB-009** · Question: why do `/users/agent_panels/` and `/discount/sell/` silently redirect to
`/subscriptions/list_bot/`? · Web evidence: both redirect with no error; `/discount/sell/add/` clearly
exists as a POST target · Safe verification: try the routes with an explicit `?bot=` parameter ·
Impact: two list pages could not be inspected · Status: **OPEN**

**UNK-WEB-010** · Question: the exact labels of six `shop_setting` toggles whose `<label>` text the
extraction filter dropped (`status_extra_volume`, `status_extra_time`, `show_price_in_name_product`,
`status_category`, `status_category_timeline`, `status_change_location`) · Note: the field names are
recorded and unambiguous; only the Persian captions are missing · Status: **PARTIALLY_RESOLVED**

## NOT_EXPOSED in the web admin (answers, not gaps)

| Feature | Status |
|---|---|
| Add Panel / Add Provider | **NOT_EXPOSED** — Telegram-only |
| Add Gateway | **NOT_EXPOSED** — the eleven are fixed |
| Add User | **NOT_EXPOSED** — users exist by pressing /start |
| Edit Admin (change a role) | **NOT_EXPOSED** — create/delete only |
| Role & permission management (matrix, overrides, expiry) | **NOT_EXPOSED** — roles are a fixed enum |
| Edit custom-pricing rule | **NOT_EXPOSED** — create/delete only |
| Gateway credentials, callback/webhook, display name, colour, sort, proxy | **NOT_EXPOSED** — Telegram-only |
| Panel connection editing (URL, username, password, token) | **NOT_EXPOSED** — the tab is read-only text |
| Bulk price tools | **NOT_EXPOSED** — no bulk price update page exists |
| Bulk actions of any kind on any list | **NOT_EXPOSED** |
| Export (CSV / Excel / PDF / JSON) anywhere | **NOT_EXPOSED** |
| Cron / scheduler / automation pages | **NOT_EXPOSED** |
| Cleanup / optimisation | **NOT_EXPOSED** (Telegram's `🗑 بهینه سازی ربات` has no web counterpart) |
| Receipts (pending / approve / reject) | **NOT_EXPOSED** — Telegram-only |
| Refund execution | **NOT_EXPOSED** — reporting only |
| KYC / phone / channel-membership verification pages | **NOT_EXPOSED** as pages (fields appear on the user record) |
| Audit-log filter, search, export, before/after values | **NOT_EXPOSED** |
| Log clearing | **NOT_EXPOSED** |
| Global search | **NOT_EXPOSED** — search is per-list |
| Notifications centre / bell | **NOT_EXPOSED** |
| Custom date range in `/reports/` | **NOT_EXPOSED** — only 7 / 30 / 90 days |
