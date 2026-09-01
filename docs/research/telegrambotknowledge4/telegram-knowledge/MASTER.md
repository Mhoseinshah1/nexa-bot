# MASTER — MirzaBot Telegram Bot Reverse-Engineering (Phase 3)

## Purpose
Deep behavioral/business-logic reverse-engineering of the MirzaBot Telegram end-user experience (bot: [BOT_USERNAME_REDACTED]) to prepare an independent from-scratch reimplementation. This is analysis only — NOT implementation. No source code, credentials, or secrets are copied. This phase builds on, and must never silently overwrite, the completed Admin Panel investigation in `project-knowledge/`.

## Relationship to Phase 2 (Admin Panel)
`project-knowledge/` (17 files + `admin-panel-investigation-report.md`) and `report.md` are the source of truth for everything already established about the Admin Panel. This phase treats them as READ-ONLY reference material. Do not edit `project-knowledge/*` or `report.md` during this phase except to append a cross-reference note if truly necessary — findings go in `telegram-knowledge/` instead. If Telegram evidence conflicts with an Admin Panel finding, record it in `contradictions.md` — never silently overwrite the Admin finding.

## Scope boundary
- OUT OF SCOPE: Reseller Bots / Agent Bots (creating, configuring, tokens, domains, child bots, deployment, lifecycle, server assignment, subscriptions). If encountered, mark `OUT_OF_SCOPE_FOR_NOW — Reseller Bots` and continue with the rest of the investigation.
- IN SCOPE: Normal User / Normal Reseller / Advanced Reseller Telegram experience — onboarding, main menu, purchase flow, checkout, pricing, discounts, payment selection, wallet, My Services, service details, renewal, extra traffic/time, location changes, test accounts, referral system, reseller USER functionality, reseller panels (where relevant to reseller-user functionality, not reseller-bot setup), support, tutorials, Mini App, notifications, service rating/CSAT, errors, validation, Back/Cancel behavior, Telegram-visible state transitions, Admin↔Telegram relationships, business rules exposed through Telegram.
- Normal Reseller and Advanced Reseller USERS are absolutely IN SCOPE (only the Reseller *Bot* deployment mechanism is out of scope).

## Inputs (read-only reference)
- `project-knowledge/` — completed Admin Panel investigation (Phase 2). Especially: MASTER.md, progress.md, business-rules.md (BR-001..BR-016), entities.md, unknowns.md (UNK-001..UNK-006), reseller-system.md, orders.md, payments.md, products-pricing.md, vpn-panels.md, permissions.md, admin-panel.md, feature-gap-checklist.md, admin-panel-investigation-report.md.
- `report.md` — Phase 1 Admin Panel UI-structure discovery.

## File index (telegram-knowledge/)
- `progress.md` — resumable checkpoint. READ THIS FIRST after any compaction/restart, along with `unknowns.md`.
- `menu-tree.md` — complete safe menu/submenu map, from /start.
- `onboarding.md` — /start, verification, welcome, first-time vs returning behavior.
- `purchase-flow.md` — buy flow up to (not including) final payment confirmation.
- `pricing-checkout.md` — pricing precedence evidence gathered from real checkout screens (UNK-003 follow-up).
- `discounts.md` — discount code UX (UNK-006 follow-up).
- `payments-wallet.md` — payment method selection, wallet balance/top-up/history.
- `services.md` — My Services list + service detail.
- `renewal.md` — renewal flow up to (not including) confirmation.
- `extra-traffic-time.md` — extra traffic / extra time purchase flows.
- `location-change.md` — location/panel change flow.
- `test-account.md` — free test-account flow.
- `referral.md` — referral/affiliate Telegram UX (BR-008/009/010 follow-up).
- `reseller-users.md` — Normal/Normal Reseller/Advanced Reseller Telegram-side comparison (HIGHEST PRIORITY).
- `reseller-panels.md` — Reseller Panel Telegram-side UX (UNK-002 follow-up), strictly excluding Reseller Bot setup.
- `support.md` — support/tickets/FAQ/tutorials.
- `mini-app.md` — Telegram Mini App storefront (TOTAL vs PAYABLE — high priority for UNK-003).
- `notifications.md` — catalog of bot-sent notifications.
- `service-rating.md` — post-service CSAT survey (ServiceRating entity follow-up).
- `errors-edge-cases.md` — safely observed error/validation states.
- `admin-telegram-map.md` — verified Admin Setting/Entity ↔ Telegram Screen/Behavior relationships.
- `business-rules.md` — TBR-catalog (Telegram Business Rules).
- `entities-states.md` — Telegram-visible entity/state model, mapped to Admin entities where evidence supports it.
- `unknowns.md` — open questions needing verification or approval.
- `contradictions.md` — Telegram vs Admin evidence conflicts (never silently resolved by overwrite).
- `incidents.md` — safety incidents during this phase (hopefully empty).
- `evidence-index.md` — running index of what was checked, when, and where the evidence lives.
- `feature-gap-checklist.md` — Phase 3 completion tracker (per §43 of the brief).

## Confidence labels (used everywhere, this phase)
OBSERVED, VERIFIED_BY_TELEGRAM, VERIFIED_BY_ADMIN, VERIFIED_BY_BOTH, INFERRED, UNKNOWN, NOT_TESTED, OUT_OF_SCOPE_FOR_NOW
No vague language ("probably", "almost certainly", "presumably") without explicitly tagging the finding INFERRED.

## Hard safety rules (see incidents.md; also project-knowledge/incidents.md for INC-001, the reason these rules are this strict)
- ABSOLUTE: never delete, modify, or state-change any existing production data (users, orders, services, configs, products, categories, panels, locations, payments, transactions, discount codes, messages, tickets, reseller records, settings, wallet transactions, referrals, admins, logs, or anything else).
- Never complete a purchase, payment, renewal, extra-traffic/time buy, location change, test-account creation, rating submission, ticket/support-message send, or any other state-changing action without explicit prior user approval (§9 format: TEST / WHY NEEDED / EXACT ACTION / WHAT COULD CHANGE / RISK / REVERSIBLE / SAFEST PROCEDURE / EXPECTED INFORMATION GAIN).
- Investigate every flow to the LAST SAFE STEP, then stop (Back/Cancel), never guessing whether a button shows a confirmation dialog first — treat Delete/Reset/Default/Restore/Activate/Deactivate/Regenerate/Block/Unblock/Confirm/Apply/Submit/Send as potentially immediate.
- Never touch Reseller Bot creation/management flows.
- Never record credentials, tokens, cookies, session tokens, Authorization headers, API keys, private keys, payment secrets, or unnecessary personal user information (redact/ignore if seen).

## Status
Phase 3 started 2026-08-30. Seventh exploration pass complete — SAFE/FREE INVESTIGATION EXHAUSTED. 17 TBRs and 8 UNK-Ts recorded (UNK-T004 closed, UNK-T001 deferred by user decision). No contradictions found. Every remaining gap now requires either explicit user approval for a financial/irreversible test (discount-code redemption, transfer-service ID entry, payment-gateway step for the Mini App question) or a reseller-tier account the user hasn't provided. Reported all 3 queued tests to the user in TEST/WHY-NEEDED format; awaiting their decision before proceeding further, per their own request to review before moving to the next phase ("مدیریت"). See `progress.md` for exact position and `unknowns.md` for the open-item list.
