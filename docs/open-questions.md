# Open questions

Unresolved product decisions, carried rather than guessed.

Nothing here blocks Phase 0. Most of it blocks a specific later phase, and the
table says which. An entry leaves this file when someone with product authority
answers it — not when someone finds a plausible answer.

Two categories, kept apart deliberately:

- **UNKNOWN** — a fact about the legacy product that the investigation could not
  establish. It might be discoverable.
- **DECISION** — something the legacy system never had. There is nothing to
  discover; someone has to decide.

> `NOT_EXPOSED` in the research means the UI did not show it. It is never
> evidence that the underlying entity or column does not exist.

---

## Blocks Phase 1 — identity, tenancy, RBAC

| Id                       | Type    | Question                                                                                                                                                                | Fallback if unanswered                                                                                                                    |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `UNK-ADM-004`            | UNKNOWN | Is an admin global, or scoped per bot? The web `Admin` entity carries a bot column; the Telegram surface shows no scope at all.                                         | Tenant-scoped, keyed `(tenant_id, telegram_user_id)`, plus an explicit platform-admin flag. More restrictive, so it is safe to adopt now. |
| `UNK-ADM-001/002`        | UNKNOWN | Are the legacy role descriptions enforced, or is "enforcement" only menu-hiding? All four production admins hold full access, so no restricted role was ever exercised. | Assume menu-hiding. Treat descriptions as aspirational; build deny-by-default with a generated role × operation matrix test.              |
| `CON-WEB-001`            | UNKNOWN | Which role vocabulary is canonical — the four Telegram roles or the seven web roles? Only one name overlaps.                                                            | Seed the seven web names as presets over the permission catalog.                                                                          |
| `UNK-ADM-005`            | UNKNOWN | Can a restricted admin reach admin management and escalate their own privileges?                                                                                        | Assume yes. Self-protection rules are mandatory regardless.                                                                               |
| `UNK-GTL-002/006`, `O-5` | UNKNOWN | Is a trial allowance a cap or a remaining balance, and what does `0` mean?                                                                                              | Store allowance and consumed separately; `0` means no trials. Adopt this even if the single-field model is confirmed.                     |

## Blocks Phase 2 — templates, settings, features

| Id                          | Type    | Question                                                                                                             | Fallback                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `UNK-BC-002`                | UNKNOWN | Are bot, store and panel capability layers AND-ed at runtime?                                                        | AND across layers; most restrictive wins.                             |
| `UNK-BC-003`, `UNK-GTL-005` | UNKNOWN | Do "global" flags scope to the deployment or to one bot instance, and how do reseller sub-bots inherit?              | Tenant-scoped, with inheritance from the parent tenant made explicit. |
| `UNK-TXT-004/005`           | UNKNOWN | How do the 36 Telegram-editable texts map to the 608 web ones, and where do the seven non-editable cron bodies live? | Key catalogue authored fresh; no automatic mapping.                   |
| `UNK-TXT-002`               | UNKNOWN | Does the template renderer support HTML? The contract is unstated.                                                   | Explicit renderer contract per key.                                   |
| `UNK-WEB-001`               | UNKNOWN | Two independent notification destinations exist for the same concept. Which is authoritative?                        | One destination per tenant, configured once.                          |
| `UNK-GS-002`                | UNKNOWN | The log group requires forum topics but no topic id was ever captured.                                               | Topic id is explicit configuration, with a test-send.                 |

## Blocks Phase 3 — providers

| Id            | Type    | Question                                                                                                          | Fallback                                                  |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `UNK-P004`    | UNKNOWN | Does the inbound template actually capture protocols, or only verify that a username exists on the remote panel?  | Capture explicitly; do not infer.                         |
| `UNK-XUI-007` | UNKNOWN | Where does a service's device number come from?                                                                   | Explicit field on the service.                            |
| `UNK-XUI-012` | UNKNOWN | Does an unreachable panel automatically block purchases, or only raise an alert? Only the alert is confirmed.     | Block purchases; surface the reason.                      |
| `UNK-XUI-009` | UNKNOWN | The current value of nearly every per-panel setter is unreadable — "the only way to read one is to overwrite it". | Not a question for us: our settings are readable by rule. |

## Blocks Phase 4 — pricing

| Id                           | Type         | Question                                                                                                                                                                                                                                       | Status                                                                                                                                                 |
| ---------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SBR-033`, `UNK-S012`, `O-1` | **DECISION** | Pricing precedence across list price, tier price, custom-range price, per-user discount, reseller discount, discount code and cashback. `PRICING_PRECEDENCE = UNKNOWN` — the concept is absent from the legacy model, not merely undocumented. | Proposed in `PRICING_PRECEDENCE` in `@nexa/contracts`, **pending owner sign-off**. Seven ordered steps; wallet and cashback are settlement, not price. |
| `UNK-WEB-003/004`            | UNKNOWN      | Custom-pricing bands: absolute or per-unit? How do overlapping rules resolve? Legacy rules have no priority, no enabled flag and no date scope, and overlap by design.                                                                         | Overlaps become a database error via an exclusion constraint. The arithmetic question remains open.                                                    |
| `SBR-035`, `O-8`             | **DECISION** | The custom-service pricing formula. One observed price point, roughly 11% over the fixed ladder.                                                                                                                                               | Default: per-unit × 1.10, pending sign-off.                                                                                                            |
| `SBR-012`                    | UNKNOWN      | What does "first purchase only" actually do at runtime — hide the product, change its price, or gate checkout? Mechanism known, behaviour not.                                                                                                 | Gate at checkout.                                                                                                                                      |
| `UNK-S010/011`               | UNKNOWN      | Does a discount code's total-uses cap count distinct users or redemptions? No edit path exists to inspect it.                                                                                                                                  | Redemptions, with an explicit `cap_counts` field.                                                                                                      |
| `UNK-S022`                   | UNKNOWN      | Is "multi-location" real multi-panel routing or only a label, and what is "dedicated single-location"?                                                                                                                                         | Modelled as explicit panel selection.                                                                                                                  |

## Blocks Phase 5 — orders, payments, wallet

| Id                    | Type         | Question                                                                                                                                                                | Fallback                                                                                                    |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `UNK-T003`            | UNKNOWN      | Does an unpaid order row exist server-side at checkout-display time? The legacy checkout assigns a username before payment.                                             | An order exists from checkout; a service does not.                                                          |
| `UNK-PR-007`          | UNKNOWN      | What does approving a receipt actually credit — the wallet, an order settlement, or a payment confirmation?                                                             | Receipt approval credits the wallet; order settlement is a separate step.                                   |
| `UNK-PR-008/009/010`  | UNKNOWN      | The receipt status enum; whether approval is reversible; whether reviewer identity and time are recorded. No approved/rejected history is reachable at all.             | Explicit state machine, reversible with a reason, reviewer and timestamp always recorded.                   |
| `FBR-007`, `PRBR-003` | **DECISION** | Should unreviewed timer-based auto-approval exist? In the legacy system money claimed by an uploaded receipt can be credited with no human ever seeing it.              | Recommend: no silent auto-approval. If kept, it needs bounds, an audit actor of `SYSTEM_JOB`, and an alert. |
| `FBR-008`             | UNKNOWN      | Per-gateway or global amount limits — which wins?                                                                                                                       | Most restrictive.                                                                                           |
| `UNK-UM-005`          | UNKNOWN      | Can a wallet balance actually go negative, or is the ceiling only a purchase gate?                                                                                      | A purchase gate. Negative balances need an explicit ledger reason.                                          |
| `UNK-UM-010`          | UNKNOWN      | Three service-deletion variants exist. Which of them refunds?                                                                                                           | None implicitly. A refund is its own operation.                                                             |
| `UNK-UM-009`          | UNKNOWN      | Does activating or deactivating a config affect the bot only, the external panel, or both?                                                                              | Both, explicitly, with the panel as the reconciled side.                                                    |
| —                     | **DECISION** | Where do exchange rates and gateway fees come from? Neither exists anywhere in the legacy system: no rate field on any gateway, no Stars conversion rate, no fee field. | Centralised rate source with immutable snapshots. Provider to be chosen.                                    |
| `FBR-012`, `O-7`      | UNKNOWN      | Per-tier top-up minimums are inverted — the middle tier's minimum exceeds both others. Policy or configuration accident?                                                | Carry forward, flagged for review.                                                                          |
| —                     | UNKNOWN      | What is the "universal gateway" (`درگاه همگانی`)? Its two controls were never opened.                                                                                   | —                                                                                                           |

## Blocks Phase 7 — resellers and promotions

| Id           | Type         | Question                                                     | Fallback                                                  |
| ------------ | ------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| `O-2`        | **DECISION** | Reseller monthly-floor basis and calendar.                   | Paid purchases; Jalali month with a 48-hour grace period. |
| `O-3`        | **DECISION** | Reseller membership price and recurrence.                    | Entitlement with an expiry; feature ships disabled.       |
| `O-4`        | **DECISION** | Reseller settlement policy.                                  | Prepaid.                                                  |
| `O-6`        | **DECISION** | Do the three cashback sources stack?                         | Max wins.                                                 |
| `O-9`        | **DECISION** | Referral anti-abuse minimum-purchase floor.                  | On by default.                                            |
| `UNK-UM-006` | UNKNOWN      | Is referral binding immutable, and can an admin override it? | Immutable; override is an audited administrative action.  |

## Blocks Phase 8 — reporting

| Id                                    | Type    | Question                                                                                                                  | Fallback                                                                                      |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `UNK-RSV2-006`                        | UNKNOWN | What timestamp basis does each metric filter on — created, paid, completed or renewed? No legacy metric states it.        | Every metric declares its basis in the registry. No default.                                  |
| `UNK-RSV2-001`                        | UNKNOWN | Which "buyer" definition do bulk tools target? Two definitions inside one feature: 56,792 and 27,732.                     | One definition in the registry; bulk tools name which they use, with a counted preview.       |
| `UNK-RSV2-007`                        | UNKNOWN | Do order counts include non-active statuses?                                                                              | Declared per metric.                                                                          |
| `UNK-WEB-007`, `UNK-RSV2-003/004/012` | UNKNOWN | Several persistent unexplained gaps, including a 6.5% renewal-total mismatch and a 916,550 residual in one user's report. | A nightly cross-check job recomputes headline metrics independently and alerts on divergence. |

---

## Conflicts recorded, not resolved

| Id                 | Conflict                                                                                                                                                                                                                                                                                 | Status                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C-BACKUP-CHANNEL` | The architecture review (ADR-013, ACCEPTED) says backups must **never** be delivered through Telegram — object storage only, with Telegram receiving a checksum notification. The product brief asks for encrypted scheduled backups **with Telegram delivery** plus off-server storage. | **Owner chose to keep Telegram delivery as a requirement.** The accepted risk is recorded in `docs/adr/0011-backup-delivery.md`, along with the compensating controls the eventual design must carry. Revisit before Phase 8. |
| `C-RLS`            | The architecture review (ADR-004, ACCEPTED) requires Postgres row-level security alongside the repository guard.                                                                                                                                                                         | **Owner chose application-level scoping only.** Recorded with its cost in `docs/adr/0004-tenant-isolation.md`.                                                                                                                |
| `C-LEDGER-COUNT`   | The review calls the ledger vocabulary "the 24-value reason enum" but its own verbatim list enumerates 25.                                                                                                                                                                               | The list is authoritative. `LEDGER_REASONS` has 25 entries.                                                                                                                                                                   |
| `C-MODULE-TREE`    | The review's §3 module tree (`src/commerce/ordering`) and its agent-ownership section (`modules/ordering`) disagree on nesting.                                                                                                                                                          | Reconciled as `src/modules/<context>/<submodule>`; recorded in `docs/adr/0002-module-boundaries.md`.                                                                                                                          |
