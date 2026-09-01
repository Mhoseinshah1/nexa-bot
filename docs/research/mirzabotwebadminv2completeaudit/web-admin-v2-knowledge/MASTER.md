# MASTER — MirzaBot Web Admin, second-pass complete audit

**Target**: `[VENDOR_ADMIN_HOST_REDACTED]` (Persian RTL SPA, Django-backed, multi-tenant by bot)
**Date**: 2026-09-01 · **Mode**: strictly READ-ONLY · **Production changes**: NONE

## The ten findings that matter most

1. **The web reports true total revenue; Telegram does not.** `درآمد کل` = `درآمد اشتراک` +
   `درآمد سرویس‌های جانبی`, verified to the Toman — independently confirming Robot Statistics v2's
   quantitative proof that Telegram's `مجموع فروش` is only the subscription half.
2. **Seven admin roles, not four.**
3. **608 editable bot texts, not 36** — and each carries a stored default with per-key revert.
4. **`پنل پاسارگارد` is a Marzban-only per-panel compatibility flag**, distinct from the `پاسارگارد`
   provider type. A question open since the Marzban phase, now settled by direct comparison.
5. **The 3X-UI `توکن` is stored in the password column** (username is `null`) — UNK-XUI-002 closed.
6. **Panel capability sets are provider-specific**, not bot-version drift — UNK-XUI-013 closed.
7. **Custom-service pricing is fully mapped**: price bands keyed by (volume GB | time days) × tier ×
   panel × optional specific user. The §25 "high priority unresolved area" is now a schema.
8. **The web order counter includes test orders**; Telegram's excludes them — 272 + 125 = 397, exactly.
9. **`انتقال` is account transfer, not location change** — the long-running location-change
   contradiction is closed, and location change is switched off globally *and* per panel.
10. **Mini-App purchase channels exist** (`add_volume_miniapp`, `add_time_miniapp`,
    `extend_user_miniapp`) and are entirely invisible to Telegram statistics.

## Files
`menu-tree.md` · `dashboard.md` · `reports-statistics.md` · `users.md` · `users-detail.md` ·
`admins-rbac.md` · `orders.md` · `panels-providers.md` · `store-catalog.md` · `pricing-discounts.md` ·
`payments-gateways.md` · `wallet-finance.md` · `bot-settings.md` · `logs-audit.md` ·
`forms-inventory.md` · `identifiers.md` · `business-rules.md` · `telegram-web-contradictions.md` ·
`unknowns.md` · `incidents.md` · `progress.md`

## Final safety review (§58)
NO USER CREATED · NO USER EDIT SAVED · NO ADMIN CREATED · NO ROLE/PERMISSION SAVED · NO ORDER CREATED ·
NO ORDER MODIFIED · NO SERVICE CREATED · NO SERVICE MODIFIED · NO PANEL CREATED · NO PANEL MODIFIED ·
NO PANEL DELETED · NO PRODUCT CREATED · NO PRODUCT MODIFIED · NO CATEGORY CREATED · NO DISCOUNT CREATED ·
NO PRICING RULE CREATED · NO GATEWAY CREATED · NO GATEWAY MODIFIED · NO PAYMENT CHANGED ·
NO WALLET CHANGED · NO RECEIPT APPROVED/REJECTED · NO TEXT SAVED · NO FEATURE TOGGLED · NO CRON EXECUTED ·
NO CLEANUP EXECUTED · NO LOG CLEARED · NO PRODUCTION RECORD DELETED.
**Every statement is true.**
