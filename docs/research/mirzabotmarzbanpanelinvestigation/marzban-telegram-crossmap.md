# MirzaBot — Marzban Panel-Settings ↔ Telegram Customer-Behavior Crossmap

Cross-references this phase's Panel Management findings against the earlier Telegram-customer-side phase (`telegram-knowledge/`) and Admin-web-panel phase (`project-knowledge/`). Source detail: `panel-management-knowledge/admin-telegram-map.md`.

## Headline finding: "location" = panel, not city — UNK-T004 resolved

`telegram-knowledge/unknowns.md` UNK-T004 asked why no location-change UI was ever found on the customer/Telegram side, despite `project-knowledge/vpn-panels.md` documenting a real per-panel toggle for it, and despite `project-knowledge/robot-statistics-investigation.md` §22 flagging a contradiction about location-change.

This phase found the answer directly inside Panel Management: **"لوکیشن" (location) in MirzaBot's internal data model means a PANEL, not a city or country.** "تغییر لوکیشن" (location change) is a panel-to-panel service-migration feature — moving a customer's existing service from one panel entirely to a different panel — independently gated by a capability toggle (`تغییر لوکیشن`, OFF by default on this test panel, see `marzban-panel-capability-matrix.md`) and priced via a dedicated field, `قیمت تغییر لوکیشن` ("قیمت تغییر لوکیشن از سایر پنل‌ها به این پنل را ارسال کنید" — send the price to migrate FROM other panels TO this panel).

This does not contradict the earlier phase's own INFERRED explanation (every product category is "multi-location" — a customer gets all of a panel's cities/countries simultaneously in one subscription, with nothing to individually pick) — that explanation remains true. What this phase adds is the coarser, ADMIN-level layer one step up: which whole PANEL (each internally multi-city) backs a customer's service, and the price to move that assignment. This is naturally an admin-initiated or admin-priced action (e.g. load-balancing, migrating customers off a struggling panel, or an upsell to a "better" panel), which explains why it never surfaced in the fine-grained, per-service customer-facing Telegram UI investigated in the earlier phase. **`project-knowledge/robot-statistics-investigation.md` §22's contradiction note can now be marked RESOLVED using this explanation.**

## Other confirmed relationships

- **Username-generation method** (`روش ساخت نام کاربری`, 8 options, built-in collision handling) is the mechanism behind the numeric-ID-plus-random-suffix usernames observed on the customer side in `telegram-knowledge/` (e.g. `6132869859_4cbfaaa6`-style). The test panel's own DEFAULT is a different option (custom-desired-username + random number) than the option that would produce that exact pattern (numeric-ID + random letters/number) — plausibly explained by production panels using a different selection than this fresh test panel's out-of-the-box default. Not fully reconciled; low-stakes, not filed as a new open question.
- **The 4-gate layered visibility model** discovered this phase (capability `نمایش پنل` ON + customer's user group included in the panel's group setting + customer not on the panel's per-user hidden list + capability `ارسال کانفیگ` ON for delivery) is new, more granular detail than either earlier phase could observe from their respective vantage points — purely additive, no contradiction with either.
- **SOCKS-proxy-for-Iran-hosted-panels** (`set proxy`, PBR-004) is a new infrastructure fact with no prior mention in either earlier phase's knowledge base — not cross-checked against any production panel (out of scope).

## Not cross-checked this phase (would require touching non-test panels or the live customer purchase flow)

Panel-color's actual customer-facing rendering; whether test-service duration/volume set here matches what real customers actually receive; whether the SOCKS-proxy feature is in active use on any production panel. See `panel-management-knowledge/admin-telegram-map.md` for the full list.
