# MASTER — Add Panel + Panel Management Investigation (Panel Phase)

## Purpose
Reverse-engineer MirzaBot Admin's "اضافه کردن پنل" (Add Panel) flow and the full "مدیریت پنل" (Panel Management) menu tree, using ONE newly-created TEST Marzban panel (planned name: `TEST_MARZBAN_[PANEL_NAME_REDACTED]`) as the only object this phase is authorized to create/modify/save. This phase builds on, and must never modify, `project-knowledge/` (Admin Panel, Phase 2) and `telegram-knowledge/` (Telegram Bot, Phase 3).

## Scope boundary (absolute)
- Authorized: CREATE, INSPECT, CONFIGURE, SAVE settings on the new test panel (`TEST_MARZBAN_[PANEL_NAME_REDACTED]`) only. ONE lightweight test VPN user/service may be created on that panel only if necessary.
- NOT authorized: deleting the test panel; touching any existing panel, production VPN user, customer service, product, order, customer, gateway, unrelated bot setting, or reseller panel — even read-adjacent edits.
- If any uncertainty exists about whether an action stays scoped to the test panel: STOP and ask the user.

## Credential handling (absolute)
- Marzban dashboard URL/username/password are supplied by the user in chat, never written to any file in this knowledge base (or anywhere else) — always redacted as `[REDACTED]` in every document.
- If credentials become unavailable (e.g. after a context compaction), STOP and ask the user to re-supply them. Never attempt to reconstruct, guess, or persist them for memory.

## File index (panel-management-knowledge/)
- `progress.md` — resumable checkpoint, read FIRST after any restart/compaction.
- `add-panel-flow.md` — the Add-Panel wizard, field by field.
- `panel-overview.md` — Panel Management menu tree / landing view for the test panel.
- `connection-settings.md` — connection info tab (URL, credentials behavior, validation — no secrets).
- `visibility-access.md` — enabled/disabled, display, user-group visibility, purchase/test-account eligibility.
- `general-settings.md` — raw config / subscription link / HAPP / custom subscription / QR / delivery behavior.
- `limits-capacity.md` — max users, unlimited mode, capacity behavior.
- `panel-capabilities.md` — capability toggles, especially "پنل پاسارگارد".
- `events-behavior.md` — first-connection / first-test-connection / location-change / notification-like settings.
- `test-account-behavior.md` — how the test panel participates in test-account creation.
- `subscription-config.md` — subscription URL/config-delivery specifics for the test panel/test service.
- `location-behavior.md` — any location-related settings surfaced at the panel level (cross-ref telegram-knowledge's open location-change contradiction, see project-knowledge/robot-statistics-investigation.md §22).
- `validation-errors.md` — naturally observed errors (bad URL, timeout, auth failure, limit reached, etc.) — never deliberately sabotaging the external panel.
- `business-rules.md` — PBR-catalog (Panel Business Rules).
- `admin-telegram-map.md` — verified Panel-setting ↔ Telegram customer-behavior relationships.
- `unknowns.md` — open questions needing verification or approval.
- `incidents.md` — safety incidents this phase (hopefully empty).
- `evidence-index.md` — running index of what was checked, when, and where.

## Confidence labels (this phase)
OBSERVED, VERIFIED_BY_UI, VERIFIED_BY_TELEGRAM, VERIFIED_BY_MARZBAN, VERIFIED_BY_BOTH, INFERRED, UNKNOWN, NOT_TESTED

## Hard safety rules
- Change ONE setting at a time: record baseline → change → save → observe (Admin/Telegram/Marzban) → record → continue.
- Never delete the test panel or any existing panel.
- Never touch existing panels/users/services/products/orders/customers/gateways/reseller panels.
- Never write credentials (URL/username/password) into any file — always `[REDACTED]`.
- If a secret is unexpectedly exposed by the source bot's own UI, record only `SECRET_EXPOSURE_FOUND: YES` plus location/type — never copy the actual value.
- Treat Delete/Reset/Deactivate-adjacent controls on OTHER panels as strictly off-limits even for inspection-only clicking.

## Status
**PHASE COMPLETE — stopped per §31, awaiting user's next instruction.** Test panel TEST_MARZBAN_[PANEL_NAME_REDACTED] created, protocol/inbound activated (with explicit user approval to enter the external panel once), and the full 25-button Panel Management menu inventoried (23 buttons opened/documented; رename and delete intentionally skipped/off-limits per the absolute scope rules). All knowledge files in this directory are populated, and all 7 final deliverables required by the parent brief (§29) have been written to `/tmp/mirzabot_audit/marzban-*.md`: marzban-add-panel-investigation.md, marzban-panel-management-investigation.md, marzban-panel-settings-matrix.md, marzban-panel-capability-matrix.md, marzban-telegram-crossmap.md, marzban-test-results.md, marzban-unknowns.md. No file in this directory was deleted. Test panel and test user (`mirzabot_audit_test`) left in place, not deleted. See `unknowns.md` for what remains open (all low-priority/optional, none blocking, each explicitly requiring fresh user approval before any further action).
