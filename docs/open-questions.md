# Open questions

Unresolved product decisions, carried rather than guessed.

Nothing here blocks Phase 0 or Phase 1. Most of it blocks a specific later
phase, and the table says which. An entry leaves this file when someone with
product authority answers it — not when someone finds a plausible answer.

Entries that HAVE been answered move to **Resolved** at the bottom, with the ADR
that answered them. They are not deleted: a decision whose reasoning has been
thrown away gets re-litigated.

Two categories, kept apart deliberately:

- **UNKNOWN** — a fact about the legacy product that the investigation could not
  establish. It might be discoverable.
- **DECISION** — something the legacy system never had. There is nothing to
  discover; someone has to decide.

> `NOT_EXPOSED` in the research means the UI did not show it. It is never
> evidence that the underlying entity or column does not exist.

---

## Carried through Phase 1 — identity, tenancy, RBAC

Phase 1 shipped without answers to these. None of them blocked it: each has a
decision recorded in [ADR-0014](adr/0014-rbac-model.md) that is either the more
restrictive reading, or a rule that holds regardless of what the legacy system
turns out to have done. They block **reseller admin scoping** in Phase 7.

| Id                | Type    | Question                                                                                                                                                                | Fallback if unanswered                                                                                                                                                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNK-ADM-004`     | UNKNOWN | Is an admin global, or scoped per bot? The web `Admin` entity carries a bot column; the Telegram surface shows no scope at all.                                         | **Still open.** Phase 1 adopted tenant-wide admins (ADR-0014) because that scope can be narrowed later — adding `bot_instance_id` to `admin_roles` is additive. Answering it would let reseller admin scoping be built. |
| `UNK-ADM-001/002` | UNKNOWN | Are the legacy role descriptions enforced, or is "enforcement" only menu-hiding? All four production admins hold full access, so no restricted role was ever exercised. | Assumed menu-hiding, and it no longer matters what the answer is: Phase 1 enforces server-side on every call, from every surface.                                                                                       |
| `CON-WEB-001`     | UNKNOWN | Which role vocabulary is canonical — the four Telegram roles or the seven web roles? Only one name overlaps.                                                            | Seeded the eight `ROLE_SEEDS` presets over the permission catalog. Since a role is now editable data rather than an enum, picking wrong is a rename, not a migration.                                                   |

## Blocks Phase 2 — templates, settings, features

| Id                          | Type    | Question                                                                                                             | Fallback                                                              |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `UNK-BC-002`                | UNKNOWN | Are bot, store and panel capability layers AND-ed at runtime?                                                        | AND across layers; most restrictive wins.                             |
| `UNK-BC-003`, `UNK-GTL-005` | UNKNOWN | Do "global" flags scope to the deployment or to one bot instance, and how do reseller sub-bots inherit?              | Tenant-scoped, with inheritance from the parent tenant made explicit. |
| `UNK-TXT-004/005`           | UNKNOWN | How do the 36 Telegram-editable texts map to the 608 web ones, and where do the seven non-editable cron bodies live? | Key catalogue authored fresh; no automatic mapping.                   |
| `UNK-TXT-002`               | UNKNOWN | Does the template renderer support HTML? The contract is unstated.                                                   | Explicit renderer contract per key.                                   |
| `UNK-WEB-001`               | UNKNOWN | Two independent notification destinations exist for the same concept. Which is authoritative?                        | One destination per tenant, configured once.                          |
| `UNK-GS-002`                | UNKNOWN | The log group requires forum topics but no topic id was ever captured.                                               | Topic id is explicit configuration, with a test-send.                 |

### Added during the Phase 2 survey

Found while reading the corpus for Phase 2 and recorded rather than resolved.
Each has a decision in a Phase 2 ADR that either holds regardless of the answer,
or is the more conservative reading.

| Id                          | Type         | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fallback                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNK-LGR-015`               | UNKNOWN      | Does the legacy notification report record notifications that were **sent**, or merely conditions that **matched**? There is no delivery-status field anywhere.                                                                                                                                                                                                                                                                                                                      | Not inherited: Nexa models the two separately by decision (ADR-0018). The legacy answer changes nothing here, which is why the distinction is drawn in the schema.                                                                                                                                                                                                                                                                  |
| `UNK-GS-011`                | UNKNOWN      | What is the exact notification set delivered to the reports group? Eleven topics were sampled; the set was never enumerated.                                                                                                                                                                                                                                                                                                                                                         | Any catalogue drawn from this corpus is a lower bound. Notification kinds are registered per emitter, never harvested.                                                                                                                                                                                                                                                                                                              |
| `UNK-LGR-009/010`           | UNKNOWN      | The notification cron's exact period, and whether a warning repeats when the customer ignores it. The corpus says explicitly: do not infer the period from the logs.                                                                                                                                                                                                                                                                                                                 | Phase 6/7 question. Nothing in Phase 2 depends on it.                                                                                                                                                                                                                                                                                                                                                                               |
| `UNK-XUI-016/017`           | UNKNOWN      | Where the panel-down alert is delivered, whether the loop skips already-alerted panels, and whether any back-off exists. Code-only; `NOT_EXPOSED` in every admin surface.                                                                                                                                                                                                                                                                                                            | Dedupe and occurrence counting are properties of the operational event, not of the emitter.                                                                                                                                                                                                                                                                                                                                         |
| —                           | UNKNOWN      | Does the legacy system handle Telegram rate limits at all? No phase records a 429, a send queue, batching or a back-off — and no phase had code access, so this is `NOT_EXPOSED`, not an absence.                                                                                                                                                                                                                                                                                    | Assume none exists and build it: the notification transport honours `retry_after` and retries with back-off (ADR-0018).                                                                                                                                                                                                                                                                                                             |
| `UNK-GS-004`, `UNK-GTL-006` | UNKNOWN      | What `0` means for a given legacy setting. Two settings document it (`0` = disabled); elsewhere `0` means unlimited, disabled, or "condition not applied", and the meaning is not recoverable from the screen.                                                                                                                                                                                                                                                                       | Not inherited: every Nexa setting declares what `0` and empty mean, as a required field of its registry entry (ADR-0017).                                                                                                                                                                                                                                                                                                           |
| `UNK-TXT-012`               | UNKNOWN      | Which placeholders resolve in the editing administrator's own context during the legacy echo. `{first_name}` does; `{username}`, `{config}`, `{price}`, `{volume}` do not; the rest were never established.                                                                                                                                                                                                                                                                          | Not inherited: Nexa never renders a template into an edit field. The preview is a separate, explicitly-labelled call (ADR-0016).                                                                                                                                                                                                                                                                                                    |
| `UNK-WEB-010`               | UNKNOWN      | The Persian captions for six named `shop_setting` toggles. The field names are recorded and unambiguous; the captions are not.                                                                                                                                                                                                                                                                                                                                                       | Irrelevant to key design: a caption is never an identifier here.                                                                                                                                                                                                                                                                                                                                                                    |
| `UNK-RGS-005`               | UNKNOWN      | Three similarly-named legacy controls (`💝 هدیه استارت`, `🌟 مبلغ هدیه استارت`, and the referral submenu's `🎁 هدیه استارت`). The corpus calls this "a real modelling hazard".                                                                                                                                                                                                                                                                                                       | Do not merge on caption similarity. Phase 7 question.                                                                                                                                                                                                                                                                                                                                                                               |
| —                           | **DECISION** | How a date is rendered for a Persian reader. `Tenant` carries `display_timezone` and `calendar` (Jalali) and nothing consults them: every `DATETIME` placeholder renders as an ISO-8601 UTC string, so a Persian operational message contains `2026-09-02T14:03:11.000Z`. Money has one locale-aware formatter; dates have none.                                                                                                                                                     | Phase 2 renders ISO deliberately rather than guessing a format. The legacy log group mixes Jalali and Gregorian in one stream, which is the failure to avoid; a single date formatter reading the tenant's calendar and timezone is the answer, and it belongs with the first customer-facing message rather than with an operations channel.                                                                                       |
| —                           | **DECISION** | Which bot instance sends a notification. A tenant may own several; the transport resolves the oldest ACTIVE one, and nothing records which one actually sent a given message — the destination snapshot carries the chat and topic but not the sender.                                                                                                                                                                                                                               | Deterministic today and undeclared. Either snapshot the bot instance onto the intent, or state that operational notifications always come from the tenant's primary bot. Revisit with reseller sub-bots in Phase 7, which is when a tenant reliably has more than one.                                                                                                                                                              |
| —                           | **DECISION** | Whether a notification can be delivered twice. The dispatcher sends outside every transaction and records the attempt afterwards, and nothing durable marks "the send landed" in between — so a recorder failure after a successful send leaves the intent PENDING, and the next claim delivers the same message again.                                                                                                                                                              | Accepted: the subsystem is at-least-once and says so. The alternative is to write a verdict on a guess, which is what the first version did — it marked the intent permanently failed, turning a duplicate alert into a delivered message filed as failed. Closing it properly needs a durable in-flight marker written before the send, which is a table and a reconciliation loop rather than a comment.                          |
| —                           | **DECISION** | Which timezone an admin screen renders a timestamp in. `Tenant` carries `display_timezone`, and no response puts it on the wire, so `apps/web/src/format.ts` renders the Jalali calendar in the VIEWER's browser zone. Two operators in different zones see different times for one event.                                                                                                                                                                                           | Half of the conventions rule is met — the calendar — and the half that is not is recorded here rather than in a comment claiming otherwise. The fix is to carry the tenant's zone in the session response and pass it to the formatter; it belongs with the date-format decision above, which is a Phase 3 change to the same seam.                                                                                                 |
| —                           | **DECISION** | Whether an operational event can be recorded twice when a commit's outcome is unknown. `NotifyingOperationalEventRecorder` records the event alone if the event and its notification cannot commit together — but a rejected transaction does not prove nothing landed: Postgres can commit and then lose the connection before the client hears about it. A dedupe-keyed event then reads `occurrence_count = 2` for one occurrence; an event with no dedupe key gets a second row. | Phase 2 accepts the over-count. Both costs are bounded and visible in the log; losing the event is neither, because the condition's next occurrence would be a repeat rather than a new one and nothing would announce it until it resolved and came back. Closing the window needs an identity the retry can look itself up by — a caller-supplied event id on the port, or a transaction-outcome probe. Neither is invented here. |
| —                           | **DECISION** | What happens to operational events after some number of years. The table is append-only by a database trigger and nothing removes a row, so it grows without bound. Dedupe collapses a repeating condition onto one row with a counter, which removes the growth mode that hurt the legacy log group, but not the long tail.                                                                                                                                                         | Phase 2 deliberately ships no retention rather than weakening the append-only guard to give a drafted setting something to configure (ADR-0020). The honest options are archival to cold storage, or an argued decision to permit aged deletion. Neither is invented here.                                                                                                                                                          |

## Blocks Phase 3 — engineering prerequisites

Not product questions. Two pieces of work must land, each in its own PR, before
Phase 3 introduces provider and panel credentials or anything is deployed for
real. Both are recorded here so that "Phase 2 is done" is never mistaken for
"this can be run".

### `BLOCKER-DEPLOY` — the Deployment MVP — **CLOSED**

Closed by the deployment/installer checkpoint after Phase 2. What it asked for
now exists: an immutable multi-stage image pinned by digest, a production
Compose topology where only the edge publishes a port, a Caddy TLS layer, an
idempotent Ubuntu installer, and `botctl` with status, version, backup, update
and rollback — update holding an exclusive lock, migrating from the target
release's own compiled migrator, and activating only after a real readiness
check. See [ADR-0022](adr/0022-deployment-topology.md) and
[docs/deployment.md](deployment.md).

**Closed as an engineering prerequisite, not as a production rollout.** No part
of this has been run against a real server. `docs/vps-acceptance.md` is the
checklist to run on a fresh staging VPS, and it is the thing that decides
whether this model can carry a customer — CI cannot issue a certificate, reboot
a host, or prove that DNS points anywhere.

Two things this checkpoint deliberately did NOT do, recorded so they are not
mistaken for oversights:

- **No backup rotation.** Dumps accumulate in `/var/backups/nexa`. Retention is
  an operator decision and no duration is invented here, exactly as for the
  notification and operational-event tables.
- **No secret rotation tooling.** Rotating the database password or the KEK on
  a live installation has no supported procedure yet; the KEK half of that
  belongs to `BLOCKER-SECRETS-V2` below.
- **Release provenance is trust-on-first-use.** A release is pinned by digest,
  so a tag cannot be repointed under an installation once it has been resolved.
  Nothing verifies who BUILT that digest: `nexa_resolve_digest` trusts whatever
  the registry answers with the first time a version is named, so anyone able to
  publish to the package — a leaked `packages: write` token, a compromised
  runner — can publish a digest every installation will then faithfully pin.
  Closing it means signing at publish time and verifying before the pull, which
  is a key-management decision of its own. The digest-first model is arranged so
  that step can be added without changing anything else.
- **Migration compatibility now has a mechanism, but not a proof.**
  `tests/integration/migration-compatibility.test.ts` replays the previous
  release's operations against this release's schema in a scratch database, and
  refuses the obvious contracting statements in incoming migrations. That is
  evidence for each transition as it is made. It is NOT a general guarantee for
  all future migrations: the replay exercises the operations written into it,
  and a migration that breaks something it does not name would still pass.
  Widening the replay as the surface grows is the open work.

### `BLOCKER-SECRETS-V2` — the secret envelope

**Partly closed.** The v2 envelope, the keyring, the bounded rewrap and
`secrets retire-check` all exist; new writes are v2 and bound to their purpose,
tenant and row. What remains open is the LAST step: `SECRETS_ACCEPT_V1` still
defaults to true, so a v1 ciphertext written by an earlier release is still
readable and therefore still transplantable. Closing it means a release that
defaults it to false and drops the legacy `SECRETS_KEK` alias, after
`botctl secrets status` reports no v1 rows on the installations that matter.
The description below is kept because it is the reasoning that produced the
design.

The v1 cipher encrypts a secret as an opaque value. Two consequences, neither
acceptable once panel and gateway credentials exist:

- **Ciphertext is not bound to its context.** There is no associated data, so a
  value encrypted for one purpose, tenant or row decrypts perfectly well in
  another. Anyone who can write a ciphertext column can transplant a credential
  between rows.
- **Rotation does not actually work.** Rows carry a `key_id`, but exactly one
  KEK is configured, so after rotating it the old rows cannot be read at all.
  The column records which key was used and nothing can use it.

A separate hardening PR must deliver: a canonical secret context (purpose,
tenant, owning row) bound as AEAD associated data; a versioned v2 envelope; a
configured keyring of decryption KEKs with one explicit active encryption KEK;
v1 decryption kept working; new writes as v2; bounded, idempotent re-encryption
to the active key; and a safe retirement procedure for a retired KEK. With
tests proving a ciphertext cannot be transplanted across purpose, tenant or
row, and that a rotation decrypts with the old key while encrypting with the
new one.

Not attempted inside the Phase 2 PR: silently changing the stored secret format
in an already-large change is how a format migration becomes an outage.

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

| Id                 | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                              | Status                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C-BACKUP-CHANNEL` | The architecture review (ADR-013, ACCEPTED) says backups must **never** be delivered through Telegram — object storage only, with Telegram receiving a checksum notification. The product brief asks for encrypted scheduled backups **with Telegram delivery** plus off-server storage.                                                                                                                                                              | **Owner chose to keep Telegram delivery as a requirement.** The accepted risk is recorded in `docs/adr/0011-backup-delivery.md`, along with the compensating controls the eventual design must carry. Revisit before Phase 8.                                                                            |
| `C-RLS`            | The architecture review (ADR-004, ACCEPTED) requires Postgres row-level security alongside the repository guard.                                                                                                                                                                                                                                                                                                                                      | **Owner chose application-level scoping only.** Recorded with its cost in `docs/adr/0004-tenant-isolation.md`.                                                                                                                                                                                           |
| `C-LEDGER-COUNT`   | The review calls the ledger vocabulary "the 24-value reason enum" but its own verbatim list enumerates 25.                                                                                                                                                                                                                                                                                                                                            | The list is authoritative. `LEDGER_REASONS` has 25 entries.                                                                                                                                                                                                                                              |
| `C-TXT-COUNT`      | The bot-text phase reports the web store as **40 groups totalling more than 1,000 keys**, of which `users` is one group of 608. The Web Admin phase reports the store as **608 `users.*` keys, full stop**, and its own crossmap resolves a 608-vs-36 contradiction in favour of the web figure. Both are labelled VERIFIED_BY_UI, and `CON-WEB-002`, which would settle it, is not in the sanitized corpus.                                          | **Unresolved, and it does not need resolving.** Nexa's catalogue is authored per emitter (ADR-0016), so neither number is a target. Recorded because the Phase 0 docstring's "~650-key catalog" figure came from the smaller reading and should not be mistaken for a plan.                              |
| `C-TXT-BAKED`      | Phase 0 and Phase 1 documentation states as fact that saving from the legacy edit screen "once baked an admin's own name into `{first_name}` for roughly 13,700 customers". The bot-text investigation records the opposite: `**NO TEXT VALUE WAS MODIFIED** … Not one character was ever composed or sent to the bot during this phase`, and TBR-TXT-013 labels the rendering VERIFIED_BY_UI but the consequence INFERRED and deliberately untested. | **Resolved in favour of the research.** The claim was corrected in `docs/conventions.md`, `@nexa/contracts` and `@nexa/i18n` at the start of Phase 2. The hazard is real and the design rule is unchanged; the incident is not. The recorded text corruption is INCIDENT-FIN-001, a different mechanism. |
| `C-MODULE-TREE`    | The review's §3 module tree (`src/commerce/ordering`) and its agent-ownership section (`modules/ordering`) disagree on nesting.                                                                                                                                                                                                                                                                                                                       | Reconciled as `src/modules/<context>/<submodule>`; recorded in `docs/adr/0002-module-boundaries.md`.                                                                                                                                                                                                     |

---

## Accepted Phase 2 tradeoffs

Decided deliberately, with the consequence stated. Not questions, and not
oversights.

| Id                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `TRADEOFF-NOTIF-RETAIN`   | **No automatic retention or archive for notification intents in Phase 2.** Delivery attempts and released claims (`notification_released_claims`) remain append-only evidence. All three tables therefore grow without bound on a sufficiently long-lived installation, and a notification whose claim was ever returned cannot be deleted at all — the released-claim table has a foreign key to it and no-delete triggers of its own. Released claims are also accounting, not only history: spend is `attempt_count` minus these rows. No retention duration is invented; whoever adds one must decide archival, duration, evidence and history, referential integrity, released claims and the arithmetic that depends on them, storage bounds and any change to the append-only policy, in an ADR. | [ADR-0018](adr/0018-notifications.md)              |
| `TRADEOFF-OPSLOG-RETAIN`  | **No retention sweep for operational events.** Deleting them would require an actor allowed to delete evidence, which no role holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [ADR-0020](adr/0020-operational-events-phase-2.md) |
| `TRADEOFF-SWEEP-TENANT`   | **`failExhausted` is deliberately independent of the tenant's current ACTIVE status.** It records terminal bookkeeping for attempts genuinely spent while the tenant was active. Tenant status governs whether we SEND, not whether completed attempt history may be terminalized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [ADR-0018](adr/0018-notifications.md)              |
| `TRADEOFF-SENDTEST-LOSER` | **A concurrent `sendTest` idempotency loser rolls back with a conflict** rather than waiting to replay the winner immediately. The winning result is durable, so a later retry replays it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [ADR-0021](adr/0021-control-plane-concurrency.md)  |

## Accepted Phase 3A tradeoffs

Decided deliberately, with the consequence stated.

| Id                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `TRADEOFF-SSRF-PRIVATE`          | **Private and internal addresses are reachable by design.** A self-hosted panel on RFC1918 space is Nexa's ordinary case, so the policy refuses only destinations that are never a panel (link-local and every cloud metadata service, multicast, reserved, broadcast, unspecified, loopback unless explicitly enabled) and allows the rest. The residue this leaves is a malicious operator using their own installation as a port scanner against their own network, distinguishing hosts by normalized failure kind and latency. Closing it requires an egress proxy that can reach panels and nothing else — a deployment topology decision, not a code one.                                                                                                                                                                                                                          | [ADR-0023](adr/0023-providers-panels-credentials-health.md) |
| `TRADEOFF-HEALTH-LATEST`         | **One health row per panel, replaced on each probe; no history.** "When did this panel start failing" is not answerable from `panel_health` alone. An unbounded health-event table is a retention problem bought before a question has been asked that needs it, and the operational log already exists for transitions worth narrating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [ADR-0023](adr/0023-providers-panels-credentials-health.md) |
| `TRADEOFF-CAPS-DECLARED`         | **Capabilities are read from the adapter descriptor, never persisted.** No SQL query can filter panels by capability. The alternative — a cache of discovered capabilities — can be wrong in the one direction that matters, listing a capability a panel has lost and driving an operation that fails half-done.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [ADR-0023](adr/0023-providers-panels-credentials-health.md) |
| `TRADEOFF-SSRF-PLAINTEXT-NAME`   | **`http://` to a hostname is refused, even a private one.** A name is treated as public because the URL check cannot resolve it before deciding. `http://panel.lan:2053` is refused; `http://192.168.1.10:2053` is allowed. An operator whose panel is plain http behind private DNS must use its address or front it with TLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [ADR-0023](adr/0023-providers-panels-credentials-health.md) |
| `TRADEOFF-TESTS-TYPED-WEB-SPLIT` | **`tests/` is fully typechecked. The exclude list is empty.** All fifteen deferred Phase 1 and 2 files were fixed, and what they were hiding was real: an assertion comparing a template key against a value outside its own union, which could never be true and had been passing vacuously; a notification fixture built from a destination shape that no longer exists; port doubles implementing half an interface. One file remains outside `tsconfig.tests.json`, and it is not a gap — `session-view.test.ts` imports a `.tsx`, so checking it needs `jsx` and the DOM lib, which the other test files must NOT have or a node-only test could name `document` and still compile. It is checked by `tsconfig.tests.web.json`, and `pnpm typecheck:tests` runs both. A new test importing a `.tsx` fails the node config with TS6142, which is the signal to add it to the web one. | `tsconfig.tests.json`, `tsconfig.tests.web.json`            |

## Open, Phase 3

| Id                       | Question                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNK-XUI-010`            | Which authentication mechanism does the Sanaei / 3x-ui panel this installation talks to actually use, and at which version?                                                                      | **Open.** The descriptor records `USERNAME_PASSWORD` because that is 3X-UI's documented login, and says so explicitly — it is **not** a corpus finding. The corpus marks the panel's API `NOT_EXPOSED`, which is not the same as absent. 3C must confirm against a real panel or a fixture derived from one.                                                                                                                                                                                                                                                                                                                                  |
| `Q-MARZBAN-PROBE`        | The Marzban adapter's endpoints (`POST api/admin/token`, `GET api/system`) come from Marzban's documented API, not from the research corpus, and have not been run against a real panel.         | **Open.** Unit tests drive the adapter against a scripted client, so they prove the normalization and not the endpoints. First real-panel contact will confirm or correct them.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Q-CAP-COUNT`            | The descriptor catalogue declares a capability set per provider; the corpus's own feature inventories for the legacy panels enumerate different totals depending on which surface was inspected. | **Open and not blocking.** Nexa's capabilities are declared by adapters, so no corpus count is a target. Recorded so a future reader does not treat a corpus number as a specification.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `UNK-SANAEI-COOKIE-SIZE` | How large a `3x-ui` session cookie and CSRF token does v3.7.0 actually mint?                                                                                                                     | **Open.** The adapter bounds both at one kilobyte before putting them in a header, and the comment there used to assert 32 characters as a measured fact. It is not one: nothing in `docs/research/` records either size, and the upstream reading done for 3B covered the auth FLOW, not the session store. The bound is chosen as a bound — far above any plausible id, far below a header limit — and is written as that. If a panel is ever found to mint a serialized session payload rather than an id, every session-mode probe against it becomes `MALFORMED_RESPONSE`, so the number is worth measuring before the first real panel. |

### Closed during Phase 3A review

| Id                           | Was                                                                                                               | Now                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRADEOFF-SSRF-PIN-UNTESTED` | The DNS-to-socket pin was verified by reading the code. A mutation deleting it left every `safe-http` test green. | **Closed.** `tests/unit/safe-http-dns-pin.test.ts` drives a real TLS socket against two servers on the same port and different loopback addresses, and asserts which one answered. Deleting the pin, re-resolving inside it, or restoring connection pooling each turn it red on the destination. Fixing the test found the pin was broken outright for every hostname (`all: true` callback shape) — see ADR-0023. |

## Resolved

Answered by an explicit decision, with the ADR that records the reasoning. Kept
here so the question and its answer stay together.

| Id                       | Question                                                                         | Answer                                                                                                                                                                                                           | Where                                             |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `UNK-GTL-002/006`, `O-5` | Is a trial allowance a cap or a remaining balance, and what does `0` mean?       | A cap and a consumed count, stored separately, plus an optional persistent per-customer override. A global reset zeroes consumption and leaves overrides intact. `0` means zero trials and never unlimited.      | [ADR-0015](adr/0015-trial-allowance-semantics.md) |
| `ADR-0009` §1            | Telegram Login Widget, local credentials, or both, for the Web Admin?            | Username and password. The Login Widget makes Telegram an availability dependency of fixing Telegram, and account recovery becomes unrecoverable locally. `admins.telegram_user_id` is a link, not a credential. | [ADR-0013](adr/0013-web-admin-authentication.md)  |
| `ADR-0009` §3            | Does a role change take effect next request, or invalidate in-flight sessions?   | Next request. Sessions carry identity, never authority — permissions are resolved per request. Disabling an administrator additionally revokes their live sessions on the spot.                                  | [ADR-0013](adr/0013-web-admin-authentication.md)  |
| `UNK-ADM-005`            | Can a restricted admin reach admin management and escalate their own privileges? | Not here, whatever they hold: an administrator can never change their own roles or status. The question about the LEGACY system stays unanswered; the answer for ours is settled.                                | [ADR-0014](adr/0014-rbac-model.md)                |

## OQ-3D-01 — is an operator's own probe rate limit management-facing?

**Status: UNRESOLVED. Recorded rather than guessed.**

`panel.probe.limited` / `panel.probe.ok` (`PanelService`) and
`panel.monitor.tenant_budget_exceeded` / `_ok` (`PanelMonitorService`) are
structurally twins: tenant-scoped, deduped, opening and closing, over the _same_
token bucket. The monitor's pair is in `MANAGEMENT_EVENT_CODES`; the operator's
pair is not.

The asymmetry is deliberate and is argued in `packages/contracts/src/ports.ts`
and pinned by a test: the monitor's exhaustion is nobody's doing and nobody is
watching, whereas an operator who presses "test connection" too often is told so
synchronously, in the response, with a retry-after. Promoting the second would
put a self-inflicted, self-explaining refusal on the page reserved for things
nobody has seen yet.

**What is genuinely unknown** is whether an operator would want the _pattern_ —
a tenant whose manual testing repeatedly exhausts its budget — surfaced as a
management condition rather than only as individual synchronous refusals and a
Telegram projection. That is a product question about what the alerts page is
for, and the owner's revision 21 and 25 answer the general shape of it without
answering this case.

**Trigger to revisit:** the first report of an operator being surprised that
repeated probe limiting left no trace on the alerts page, or the first tenant
large enough that manual testing competes with the monitor for the budget.
Whoever revisits it changes the comment in `ports.ts` and the exclusion test in
`tests/unit/web-money-and-scope.test.ts` together.

## OQ-3D-02 — a malformed request refused before the guard leaves no `access.permission_denied`

**Status: UNRESOLVED — OPEN, NOT MERGE-BLOCKING. Classified in round 45; recorded
rather than argued away a fourth time.**

Classified, not redesigned. Merge-blocking would need a production defect that
weakens authorization or discloses something; this does neither — every
remaining case is answered `400` before the guard, tells the caller nothing,
and changes no state. Resolved would need an authoritative fix for each
remaining case; the ones listed under "What is still open" below need the
parse moved inside the lock of two identity mutations, or a permission that
only the parsed body can name, and the one attempt to guess that permission
from the raw body refused a legitimate operation and wrote a false record for
it. So it stays open, with its cases pinned one by one, and it does not hold
the branch.

An unprivileged but authenticated caller who sends a request the server cannot
parse is answered `400` and no `access.permission_denied` is recorded — that
event is written by the guard, and on those paths the guard never runs. The
same caller sending a well-formed request is answered `403` and the record is
written. So an operational-log entry that exists to be a security fact about
people can be suppressed by malforming the request.

**What is settled.** The exposure is the missing audit record, not a
disclosure: a `400` tells the caller nothing about what they may read, and
every path that would reveal something still authorizes first.

**What is not.** Which order the API should have, and whether the inconsistency
below is worth removing. Five successive attempts to state a RULE governing
it were each falsified by a case on an endpoint the rule named:

- "It is uniform; every surface parses before authorizing." False —
  `POST /settings/:key`, `POST /features/:key`, `POST /templates/:key` and
  `GET /panels/:id` hand the raw value to the service, which authorizes first.
- "A query string is parsed in the controller; a path parameter or body is
  handed to the service." False in both directions —
  `GET /notifications/:id` parses `uuidV7Schema` in the controller, and
  `/ops-log` splits inside itself.
- "Within `/ops-log`, `scope`, `severity`, `code` and `open` are
  service-parsed." False for `open`, which is `openFlag.parse(query.open)` in
  the argument list of the service call and therefore evaluated before it. The
  three that were listed correctly had assertions that DISCRIMINATED which
  side of the guard they were parsed on; `open` had assertions but none that
  did — it was pinned at 400 all along by `refuses an open filter that is
neither true nor false`, which cannot tell the two orders apart.
- "The ordering is per-PARAMETER." Still too general. It is per
  (parameter, MALFORMATION): `singleValued` refuses a REPEATED key in the
  controller, so `?scope=ALL&scope=ALL` is a 400 from a caller for whom
  `?scope=BOGUS` is a 403 — the same parameter, the same endpoint, the same
  caller.

- "A body is handed to the service, which authorizes first." False for every
  panel WRITE: `PanelService` parsed the body before it authorized on create,
  update, credentials, status and test, so an unprivileged caller posting
  `{nonsense:true}` was answered 400 and left no `access.permission_denied` —
  including on `panels.credentials.rotate`, the CRITICAL permission. **This
  one was FIXED** rather than recorded, because unlike the query cases the
  same layer already did it the other way round in settings, features,
  templates and the notification test. Pinned by
  `panels-http.test.ts` › records the denial even when the body is nonsense.
- And the same defect again in `AdminManagementService.create`, which parsed
  before `assertMayAttempt` while `setStatus` and `setRoles` in the SAME FILE
  authorized first — the one operation that mints a credential with roles
  attached. The round that fixed the panels said in three documents that "the
  panel service was the last to follow a rule the others kept"; it was not,
  and that sentence is corrected here. **The FIRST guard is fixed** and pinned
  by `admin-http.test.ts` › records the denial on create even when the body is
  nonsense.
- The SECOND guards are a different problem and are **not** fixed. See
  "Why the second guards cannot be pre-authorized" below.
- And once more INSIDE the file that had just been fixed: `create`'s second
  guard, `panels.credentials.rotate`, is gated on the parsed body, so an actor
  holding `panels.edit` but not the rotate permission could suppress the
  CRITICAL denial with a malformed idempotency key. Closed by authorizing on
  the raw body's shape when it mentions credentials at all. Pinned by
  `panels-http.test.ts` › records the CREDENTIALS denial on create, even with
  a malformed body.

The honest reading is that nothing decides this at all: the ordering follows
wherever each value happens to be validated, and five attempts to state it as
a rule were each falsified by a case the rule itself named. It is not stated
as a rule anywhere any more; the cases are pinned instead.
Making it uniform means moving every query parse behind the guard, which a
surface cannot do — it does not resolve permissions — so it means moving the
parsing into the application services, which is a change across three
controllers and every query schema, and is not what Phase 3D was asked for.

### Why the second guards cannot be pre-authorized, and what was learned trying

Some refusals depend on a permission that is only KNOWN once the body is
parsed. `admins.permissions.edit` is required when a request grants or removes
the owner role; `ADMIN_PRIVILEGE_ESCALATION` is raised when a request confers
authority the actor does not hold. Which permission applies is a function of
what the body asks for, so there is no permission to check before the parse —
only a guess at one.

**A guess was tried, measured, and reverted.** `mentionsOwnerRole` scanned the
raw body for the owner role and pre-authorized `admins.permissions.edit`. It
was wrong in both directions, and the second is the reason it is gone:

- Too NARROW. It required `Array.isArray(roleKeys)`, so `roleKeys: 'owner'` as
  a bare string went back to 400 with no record — the hole it was written to
  close, one keystroke away.
- Too WIDE, and harmful. The authoritative guard fires on the locked DELTA
  adding or removing owner; the guess fired on the body MENTIONING it. So an
  actor with `admins.edit` editing an existing owner's other roles — who must
  keep `owner` in the list, or trip the remove gate — was REFUSED an operation
  the system permits, and the refusal wrote a `DENIED` audit row and an
  `access.permission_denied` event describing an escalation attempt that never
  happened. Measured: parent RESOLVED with +0/+0; with the guess REJECTED with
  +1/+1. In the module whose whole thesis is audit fidelity, and on a row that
  reaches the Management Alerts page and never resolves.

A false record is worse than a missing one. The guess is reverted.

**What is still open**, all measured at +0/+0 with a malformed body and +1/+1
with a well-formed one:

- `create` and `setRoles` granting the owner role.
- `setRoles` removing it, and `setStatus` on an owner — these depend on the
  TARGET's roles rather than the body, and could be closed authoritatively by
  moving the parse inside the lock and gating on the locked `current`. That is
  a restructure of two locked mutations, not a Web Admin change.
- `assertGrantsNoMorePrivilegeThanHeld`, which covers every delegable role and
  is called "the more serious of the two" by the code that reports it.
- `POST /admins/:id/roles` and `POST /admins/:id/status`, where
  `admins.controller.ts` parses the path id before the service authorizes —
  the same construct as `GET /notifications/:id` above, on two WRITE routes.

**Trigger to revisit:** the phase that restructures the identity mutations, or
the first audit review that asks why a denied escalation left no trace.

**Trigger to revisit:** an operator or an auditor asking why a denied attempt
is missing from the log, or the first phase that adds an endpoint whose denial
record is relied on for anything more than reading. Whoever revisits it changes
the two tests that pin the current matrix together —
`panels-http.test.ts` › does not decide 400-before-403 by a rule, and the cases
are pinned one by one, and `web-admin-v2.test.ts` › splits 400-before-403
INSIDE one endpoint, by parameter.

## OQ-3D-03 — a denial writes its operational event twice

**Status: RESOLVED (round 45).** One denied request writes ONE
`access.permission_denied` event and ONE `DENIED` audit row, on both paths,
and the counts are pinned exactly.

**What it was.** Every refusal on a non-transactional guard call that went
through the shared recorder wrote `access.permission_denied` **twice**: `permission-guard.ts` recorded it whenever
no transaction was passed, and `recordMutationDenial` recorded it again for the
same attempt. `PanelService.authorize` and the other early checks — settings,
features, notifications — pass no transaction, so both fired: measured at two
rows per denied request. The code is in `MANAGEMENT_ONE_SHOT_CODES` and never
resolves, so an operator counting denials on the alerts page counted double,
permanently, and always had. Inside `runAuthorizedMutation` (and the panel
monitor, which checks inside `uow.run`) the guard is passed `tx`, writes
nothing, and the recorder was the only emitter — one and one, correct.

**What owns the record now.** The GUARD is the single authority for the
operational event. `PermissionGuard.check` still writes it only when no
transaction is passed — the reason is unchanged: writing from inside a
transaction takes a second pool connection while holding one, and deadlocks the
process at pool exhaustion — and it now marks the error it throws with whether
it did (`denialEventRecorded`, a non-enumerable symbol property, so it never
reaches the 403 body). `recordMutationDenial` writes the event only when the
guard says it could not, and writes the `DENIED` audit row unconditionally, as
before. Identity's `runLockedMutation`, the other after-the-fact recorder, asks
the same question (round 46), which is the reason it stays one event when an
in-lock check stops passing `tx` — pinned directly in round 48. Both recorders
write the audit row FIRST (round 48): the two writes are not atomic, and the
order decides which survives an operational log that is down. No caller decides: the six pre-transaction sites (five panel writes,
settings, features, notifications, templates' set and revert, and
`system.ping` on both surfaces — templates joined the shared recorder in
round 49 and the ping in round 52; the other four were unchanged) and
`runAuthorizedMutation` take the same code path they took before.

The two alternatives were a parameter (`{ eventRecorded }`) threaded through
every caller, which is the route-by-route shape the owner ruled out and the
next site would forget, and a field in `details`, which is serialised into the
403 body. A symbol on the error is neither.

**What is pinned.**

- `tests/unit/authorization.test.ts` › one denial is one event and one audit
  row — both branches, exactly: pre-transaction (guard event, recorder audit)
  and in-transaction (recorder event and audit), plus the marker staying off
  the wire.
- `tests/integration/panels-http.test.ts` › records the denial even when the
  body is nonsense — per route, for ONE request, `events === 1` and
  `audit === 1`, malformed and well-formed, on all five panel writes.
- `tests/integration/transactional-authorization.test.ts` › records an EARLY
  refusal the same way in every phase — settings, the shared recorder, exactly
  one event; the `some(...)` floor it replaces held under the duplicate.
- `tests/integration/admin-http.test.ts` › records the denial on create even
  when the body is nonsense — identity, exactly one and one.
- `tests/integration/identity-concurrency.test.ts` › refuses a REMOVE-ONLY
  setRoles whose actor lost admins.edit — the in-lock path, exactly one event,
  `WARN`, naming the actor (rounds 46 and 48); › records ONE event and ONE
  audit row when the in-lock check has already written the event — the guard's
  marker consulted by `runLockedMutation` (round 48); › writes the DENIED
  audit row even when the operational-event write fails — audit first (round
  48).
- `tests/integration/codex-findings-round-2.test.ts` › names the permissions
  the actor tried to confer, not "unknown" — an escalation refusal, which the
  guard never sees, leaves exactly one event naming what the audit row names
  (rounds 47 and 48).
- `tests/unit/authorization.test.ts` › writes the audit row before the event,
  so a failing event write cannot cost it — the shared recorder's order
  (round 48); › an audit failure costs the event, and is what the caller sees
  (round 49); › IN-transaction: the guard writes nothing, the recorder writes
  the event and the audit row — WARN, this permission, this actor (round 50).
- `tests/integration/transactional-authorization.test.ts` › records a
  TEMPLATES early refusal as one audit row and one event, and a non-denial as
  nothing — templates on the shared recorder, authorized before parsed
  (rounds 49–50); and every authority-revocation barrier case, parametrised and
  literal, asserts exactly one DENIED row and one WARN event naming the
  case's literal permission (rounds 50–52; the session-revocation case has
  no denial to pin).

Falsified in `docs/phase3d-falsification.md`, round 45: emitting from both
(AV1) fails the pins as a duplicate, removing the surviving emission (AV2)
fails them as a missing event, removing the audit write (AV3) fails them as a
missing audit row.

## OQ-3D-04 — an operational-log outage on the pre-transaction path leaves no audit row

**Status: UNRESOLVED — OPEN, NOT MERGE-BLOCKING. Recorded in round 49 rather
than decided on a guess.**

Round 48 wrote "both recorders write the audit row first, so an operational
log that is down costs the event and never the audit row". True of the two
after-the-fact recorders, and only of them. On the PRE-transaction path — the
eight early routes, templates' two, `system.ping`, identity's three pre-lock
checks, and every VIEW check, which is the path an ordinary unauthorized
request actually hits — the GUARD
writes the event before it has decided to throw the denial. If that write
fails, `check` rejects with the write's error, no `PERMISSION_DENIED` ever
exists, and the recorders (which audit only THIS permission's refusal) write
nothing. The caller sees the outage, not a 403, and the attempt leaves no
audit row.

Pinned as it is, so the limit is stated by a test rather than a sentence:
`tests/unit/authorization.test.ts` › PRE-transaction with the operational log
down: the guard fails before any denial exists.

**Why it is not changed here.** The structural fix is for the guard to catch
its own write failure, mark the error `recorded: false`, and throw the
denial — the recorders would then write the audit row first and re-attempt
the event, whose failure would propagate as it does today. That also changes
what a VIEW check does during an outage: `list` and `get` have no recorder
behind them, so their denial would become a quiet 403 with no event, where
today the outage is loud. Whether a refusal during an outage should be a
quiet 403 or a loud error is an operator-facing decision, not one to take
inside a Web Admin branch.

**Trigger to revisit:** the first operational-log outage in production, or
the phase that gives the guard a logger of its own.

## OQ-3D-05 — a write permission without its read permission has no usable screen

**Status: OPEN — OWNER-DEFERRED, not merge-blocking.** Raised by Codex's
seventh review of PR #15; the owner's disposition is to record it and not to
decide it at the end of Phase 3D.

`SettingsService.set` authorizes on `settings.edit` alone, and the feature
flag and template writes on `settings.edit` and `templates.edit` alike. An
administrator whose role grants the write and whose overrides DENY the read —
`effective = (role ∪ GRANT) − DENY`, so the combination is reachable — holds
a capability the Web Admin cannot offer: `/settings`, `/features` and
`/content` gate the whole page on the view permission, render the denied
state and hide their navigation entries. The server permits a write the
screen does not draw.

**Why it is not decided here.** Neither remedy is a Web Admin change. Requiring
the view permission on the server's write path changes what an existing
permission grants; drawing a write control without the read means editing a
value the actor may not see, which is the write-only settings screen the
registry exists to end. The right answer needs a decision about
read-before-write — every write here carries an `expectedVersion` read from
the page — and whether edit should imply view in the override resolver.
Not a privilege escalation, data loss, tenant isolation or security defect:
the mismatch denies, it never grants.

**Trigger to revisit:** the first override that produces this combination in
a real installation, or the phase that revisits the permission catalogue.

## A request-rate bound on the Telegram webhook belongs at the edge, and the edge cannot yet carry one

**Status: OPEN — recorded by the Architecture Hardening pass (item G).**

`/telegram/webhook/:botInstanceId` is the only route an unauthenticated caller
can usefully reach, and it has no request-rate bound. ADR-0026 records why none
is added inside the application: every admission counter in this codebase is a
conditional write in PostgreSQL on purpose, so a limiter here would convert a
cheap unauthenticated request — one 64 KiB parse and a constant-time digest
compare — into a database write, making a flood a flood against the one component
whose loss takes the installation down.

The right place is the front door, which is `deploy/`'s Caddy. Caddy's built-in
server has no rate limiter, so this needs a plugin in the production image or a
different front door.

**Why it is not decided here.** Adding an unexercised Caddy plugin to the
production image is a deployment change, and the deployment checkpoint has never
been run against a real server — `docs/vps-acceptance.md` is the checklist that
decides that. Adding one unknown to a topology that already has one makes the
acceptance run harder to interpret, not safer.

**Trigger to revisit:** the VPS acceptance run completing, or the first
installation that reports unauthenticated traffic on this route.

## `outbox_messages` retention waits on the reporting projections

**Status: OPEN — recorded by the Architecture Hardening pass (ADR-0027).**

A dispatched outbox row is the causal record of a domain event: which event, in
which transaction, with which correlation id, delivered when. It is the only place
`correlation_id` survives the queue boundary, which is what ADR-0006 says the
column is for.

Unlike `request_idempotency` and `processed_messages`, nothing about CORRECTNESS
needs an old dispatched row — `processed_messages` is what prevents a double
effect, and this is history. So this is the table whose retention is a reporting
question, and it is the one to bound first if any of them needs bounding.

**Why it is not decided here.** The row carries the event payload, and the
reporting projections Phase 4 will add are not designed yet. Choosing an age
before knowing what reads it would mean choosing it from the only fact available
— how large the table is — which is how the legacy system's one-button
"optimisation" came to delete six order classes.

**Trigger to revisit:** the first reporting projection that reads `outbox_messages`,
or the first installation that reports the table as a storage problem.

## Does either provider have a note field on a user at all?

**Status: OPEN — recorded by the Architecture Hardening pass (item L).**

`packages/contracts/src/provider-note.ts` declares the format this installation
would write on a provider-side user — Telegram id first, no `NEXA` prefix, a
500-character budget — and nothing writes it, because no adapter has a write path
to any provider-side user field.

The research corpus says nothing about a provider-side note. Per `CLAUDE.md` that
is `NOT_EXPOSED` — "the UI did not show it" — and never proof of absence, so:

- **Marzban.** `UNKNOWN` whether a user carries a free-text note, and if so what
  its length limit is and whether it survives an update that does not mention it.
- **Sanaei / 3X-UI v3.7.0.** Same three questions. Its client objects carry more
  fields than Marzban's and some are free text, but none has been observed being
  used as a note.

The 500-character cap in the contract is therefore a SELF-IMPOSED budget chosen
to be smaller than any plausible real limit, not a measured constraint. When a
provider's actual limit is known the smaller of the two wins.

**Why it is not decided here.** Resolving it by reading upstream source is
possible and is Phase 4D's work, where the first mutating call is written and the
field can be exercised against the deterministic fake server. Guessing now would
put a number in a frozen contract on the strength of nothing.

**Trigger to revisit:** Phase 4D, the first provider mutation.

## What a reusable operational log contract should render

**Status: PARTIALLY OPEN — recorded by the Architecture Hardening pass (item K).**

`OperationalSubject` now declares the keys an operational event may be searched
by, so a second spelling of one fact cannot appear. Two halves remain open, and
both are stated here rather than implied by the declaration:

1. **Nothing renders it.** The Telegram projector queues exactly five values and
   the Persian template renders only those, so a subject field would be invisible
   in the report group today. Declaring the shape still prevents the second
   spelling; it does not make operators able to see a panel id.
2. **`message` is stored raw and is what reaches Telegram.** `context` is redacted
   on write; `message` is not. Today that is safe by author discipline — a real,
   written-down discipline — but it is an argument rather than a mechanism, and the
   customer-supplied text Phase 4 introduces is exactly what would land there.

**Why the second is not fixed here.** A redactor on `message` has to be a
mechanism rather than a rule, which means either a template-key-and-parameters
shape for every event (so the renderer controls what interpolates) or a redaction
pass with a declared allowlist. The first is the right answer and it is a change to
every existing recorder call site; doing it without the Phase 4 events that
motivate it would mean guessing at the parameter shapes.

**Trigger to revisit:** the first operational event whose message would carry
customer-supplied text — Phase 4A, when a Telegram update can fail.

## Restoring a backup taken by a DIFFERENT installation

**Status: OPEN — recorded by the Web Admin Disaster Recovery pass (ADR-0028 § 10).**

An archive's data key is wrapped under the KEK of the installation that wrote it.
This installation holds its own keyring, so a foreign archive fails at the key —
`recovery.archive_foreign_key`, which is a distinct code from a corrupt file
precisely because the two need different actions — and the Web Admin reports it as
«پشتیبانی نمی‌شود» rather than leaving the option out.

The workaround is real and deliberate: add the other installation's KEK to
`SECRETS_KEYS`, out of band, restart, and the archive becomes an ordinary one.
Every held key may decrypt; only the active one encrypts.

**Why there is no feature.** The two shapes a feature would take are both worse
than the workaround:

1. **A form that accepts a pasted KEK.** Refused outright. It would put a
   master key in a browser, in a request body, in whatever logs that request,
   and in the paste buffer of whoever was asked for it — and it would teach
   operators that handing the key to a web page is a normal thing to do. The
   owner's instruction for this phase forbade it explicitly, and it would be the
   wrong answer without the instruction.
2. **A key-import path with its own storage.** Defensible, and a larger piece of
   work than it looks: an imported key needs a lifetime, a scope (decrypt-only,
   never active), an audit trail, a removal path, and a clear answer to what
   happens to archives sealed under it afterwards. That is a keyring feature, not
   a recovery feature, and it belongs with whatever first needs more than one
   installation's keys — migration tooling, or a managed deployment.

**What this means operationally.** Host rebuilt, same keys, archive from the old
host: works, because the keyring is the same installation's. Host rebuilt with a
NEW KEK and only the old archives: the old KEK must be recovered and configured,
or the archives are cryptographically lost. That is the property the encryption
buys and there is no way to have both.

**Trigger to revisit:** the first deployment that legitimately holds two
installations' archives — a migration tool, or a managed multi-install operator.

## UNK-DEPLOY-001 — RESOLVED: `compose up -d` does recreate when `nexa.env` changed

**Recorded as an open question on one reading of one measurement, and closed two rounds
later against it. The measurement was real; the inference from it was wrong, and it was
asserted here as fact.** Kept rather than deleted, because the way it was wrong is the
reusable part.

**What was measured.** On the pinned client, v5.1.1, `docker compose config --hash='*'`
does not change when `env_file` CONTENT changes, while an inline `environment:` value does
change it:

```
baseline                                        api 5fc5df86…
append BACKUP_SCHEDULE_ENABLED=true to env_file api 5fc5df86…   unchanged
change DATABASE_URL's password in env_file      api 5fc5df86…   unchanged
change an inline `environment:` value           api c26660b1…   CHANGED
```

**What was inferred, and is false.** That this is "the value `up -d` compares against the
running container's `com.docker.compose.config-hash` label", and therefore that an edit to
`nexa.env` cannot cause a recreation. `config --hash` is the wrong probe. In the pinned
binary:

```
callers of pkg/compose.ServiceHash
  (*convergence).mustRecreate        the recreation decision
  (*composeService).prepareLabels    stamping the label
  cmd/compose.runHash                behind `config --hash`

callers of types.Project.WithServicesEnvironmentResolved
  loader.ModelToProject
  cmd/compose.runConfigInterpolate
  cmd/compose.createCommand…WithServices.func5
  cmd/compose.runCommand.func2
  cmd/compose.upCommand…WithServices.func5      <-- up resolves env_file
  (runHash is NOT among them)
```

So `up` hashes a project whose `env_file` has been merged into `Environment` and
`config --hash` hashes one where it has not — the same function over different inputs.
`Environment` is demonstrably inside the hash, because the inline change above moves it.
An edit to `nexa.env` therefore changes the hash `mustRecreate` compares, and the
container is recreated.

**Three further measurements, because the symbol table alone leaves a gap: it shows `up`
calls the resolver, not what the resolver does to the field the hash reads.**

1. The resolver takes one argument, `discardEnvFiles`, and **`up` passes `true`**. In the
   pinned binary the instruction immediately before the call sets the boolean register:

   ```
   ff1913: mov  $0x1,%eax
   ff1918: call b44c20 <types.Project.WithServicesEnvironmentResolved>
   ```

   Four call sites set it that way — `createCommand`, `runCommand`, `upCommand` and
   `runConfigInterpolate`. So after resolution the service carries the file's content in
   `Environment` and no longer carries the `env_file` list at all.

2. That is observable without a daemon, through the one command that resolves and prints.
   With `env_file: [one.env]` holding `A=2`, `docker compose config` emits

   ```
   services:
     api:
       environment:
         A: "2"
       image: busybox:latest
   ```

   — the content under `environment:`, and **no `env_file:` key**. The discard is not an
   inference about a flag name; it is in the output.

3. `EnvFiles` is itself inside the hashed struct, which is what makes the discard decisive
   rather than merely tidy. Changing only the env file's PATH, with identical content,
   moves `config --hash`:

   ```
   env_file: [one.env]   A=1        api 7273e293…
   env_file: [two.env]   A=1        api a6823960…   CHANGED (path only)
   env_file: [two.env]   A=2        api a6823960…   unchanged (content only)
   ```

   So the hash reads both fields. For `config --hash` the content is in neither of them —
   it sits in a file named by `EnvFiles`, which is why only the path moves the hash. For
   `up` the path is gone and the content IS `Environment`. The probe that was mistaken for
   the answer measured the one project model in which `nexa.env`'s content is invisible.

Two further corrections to the original text. The decision is **client-side**, in
`mustRecreate`; the daemon never sees a service definition, so "the daemon may consider
other inputs" was wrong about where the decision lives — and that is why this was
settleable here at all. And the `cmd_restart` edge precedent, quoted accurately, is **not
the same mechanism**: a bind-mounted file's content never enters a service definition
because Compose never reads it, while an `env_file`'s content is read by the client and
merged into `Environment`. `nexa.env` needs no `NEXA_EDGE_CONFIG`-style trigger, and the
remedy this question originally proposed would have added a second fingerprint, a new
`deploy.env` key and a new divergence surface to solve a problem that does not exist.

**What is still unobserved.** None of this has been watched against a real daemon. The
deploy suite runs against a fake docker, and both smoke scripts write `nexa.env` before
the first `up` (`scripts/deployment-smoke.sh` writes at 128 and 139, first `up` at 184;
`scripts/deployment-update-smoke.sh` at 353, 360 and 362, first `up` at 387), so neither
exercises "edit `nexa.env` on a running stack, then restart, and read the value back".
The symbol evidence above is a deduction about a binary, not an observation of a
container.

**Where that is closed:** `docs/vps-acceptance.md` carries it as step 12c, because
pinning it to "the first run" of a checklist that had no such step would have let it
survive the event meant to close it. The check names ONE key rather than dumping
`.Config.Env`, which holds `DATABASE_URL`, `SECRETS_KEYS` and the backup bot token:

```
sudo grep -n '^LOG_LEVEL=' /etc/nexa/nexa.env                 # must print LOG_LEVEL=info
sudo sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=debug/' /etc/nexa/nexa.env
sudo grep -n '^LOG_LEVEL=' /etc/nexa/nexa.env                 # must print LOG_LEVEL=debug
sudo botctl restart
sudo docker inspect nexa-api-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^LOG_LEVEL='
```

The `grep`s are `sudo` too: `/etc/nexa` is installed `0700` and root-owned, so a plain one
fails for a non-root operator — and step 1 failing for THAT reason would stop the probe
before it tested anything.

**The key is `LOG_LEVEL` because `deploy/nexa.env.template` writes it, and the first draft
of that step got this wrong in a way that would have reopened this entry on a healthy
host.** It used `BACKUP_SCHEDULE_ENABLED`, which the template does not write and the
installer never adds — so the `sed` matched nothing, the file was unchanged, the restart
changed nothing, and the final `grep` printed nothing. Printing nothing is precisely the
outcome the step documents as _"the deduction is wrong … Reopen `UNK-DEPLOY-001`"_. The one
check pinned to close this question was wired to reopen it, on every host, from an edit
that never happened. Hence the two `grep`s around the `sed`: the step proves the key is in
the file, and proves the edit landed in the file, before anything is concluded from a
container's silence.

**The lesson, which is why this entry survives.** A measurement is evidence about the
command that produced it and nothing else. `config --hash` answers a question about
`config --hash`; treating it as an answer about `up -d` turned one reading into a
documented fact, and that fact deleted a true sentence from an operator-facing output for
two rounds. `CLAUDE.md` says never to resolve an UNKNOWN by guessing. This created one by
guessing, which the rule does not say and should.

## UNK-DEPLOY-002 — two `env_file` shapes the text scanners do not see: `NAME:value` and `NAME =value`

Two shapes of record in `/etc/nexa/nexa.env` are read by `deploy/`: an assignment
(`BUILD_COMMIT=deadbeef`) and a bare record (`BUILD_COMMIT`, which takes the variable
from the environment running Compose). **Compose v5.1.1 accepts a third.** Measured:

```
nexa.env        BUILD_COMMIT:deadbeef
                OTHER=1

docker compose config
    environment:
      BUILD_COMMIT: deadbeef
      OTHER: "1"
```

**And a fourth, found a round later, which is why this entry is about a FAMILY and not a
separator:** blanks before the equals sign. Measured, all effective:

```
SECRETS_KEYS =realkey        SECRETS_KEYS<TAB>=realkey      export SECRETS_KEYS =realkey
SECRETS_KEYS: v              SECRETS_KEYS :v                export SECRETS_KEYS:v
```

Neither `nexa_compose_env_value`, nor `nexa_env_has_bare_record`, nor the rewriter's awk
recognises either separator — the value reader requires the `=` to follow the name
immediately. Two consequences, both measured through the real functions:

1. `nexa_obsolete_app_env_keys` reports nothing, so `botctl update` says it removed the
   obsolete keys and leaves the record in place — the exact sentence the bare-record fix
   was written to retire, one shape over.
2. `botctl status` then reads the running container's `BUILD_COMMIT` against a file that
   appears not to set it, classifies it `stale`, and prints "The file no longer sets
   BUILD_COMMIT, but the RUNNING API container answers something other than its own
   image … Run `botctl restart`." The file DOES set it, so the restart re-applies the
   mask and the operator loops.

**A third consequence was claimed here and is false**, and it is recorded rather than
quietly deleted: "the capabilities section would miss a colon-form value, reading the schema
default instead of what the container receives". It would not. That section reads
`nexa_compose_resolved_env`, which runs `docker compose config` — so COMPOSE resolves the
shape and the section sees the real value, as the measurement at the top of this entry shows.
The scope of this open question is the TEXT scanners and the rewriter, and writing it wider
than that expanded deferred work into a path that was already correct.

**One consequence IS fixed, because refusing needs no new parser.** `SECRETS_KEYS` written
in the colon form made `botctl secrets migrate-config` dangerous rather than merely
incomplete: it read no `SECRETS_KEYS`, concluded the installation was legacy, and appended
`SECRETS_KEYS=<the old SECRETS_KEK>` — and the LAST record for a key wins, measured:

```
nexa.env        SECRETS_KEYS:realkeyring
                SECRETS_KEYS=staleappended      ->  container receives `staleappended`
```

So the restart that command advises would have left every row encrypted under the real
keyring unreadable. `nexa_env_has_unreadable_record` now refuses BOTH shapes for the four
keys `migrate-config` reads — one predicate for the family, after the colon form was closed
alone and the whitespace form turned up a round later. It is a REFUSAL detector and is
deliberately not wired into `nexa_obsolete_app_env_keys`: reporting a key there sends the
rewriter to remove it, which is the change this entry defers.

**Why the rest is recorded rather than fixed.** The fix is a second separator in three
scanners, one of which is the awk that in round twelve suppressed every line after an
unterminated quote and nearly installed a `nexa.env` with no encryption key. That edit
belongs in its own commit with its own adversarial round and its own mutation set, not
appended to a round that is already fixing four blockers. What is fixed now is the
CLAIM: the comment above the detector said "TWO shapes, because Compose accepts two",
which was false, and it now names the shape it does not cover.

**Reachability.** No template ever wrote either shape and the installer never does, so both
require a hand-edited file — the same reachability as the bare-record case, which was fixed
because it was cheap rather than because it was likely.

**Two further shapes, measured in the same round and FIXED rather than recorded**, since
they needed no new separator — only the removal of a claim and one extra input:

```
BUILD_COMMIT # why      REFUSED: unexpected character "#" in variable name
BUILD_COMMIT  (no final newline)          "": BUILD_COMMIT      the key is never set
BUILD_COMMIT=abc (no final newline)       BUILD_COMMIT: abc     honoured as usual
BUILD_COMMIT\r\n                          BUILD_COMMIT: <host>  CR stripped
```

So a trailing comment is not a bare record but a file Compose refuses whole, and a bare
name needs its newline to BE a record — an unterminated one is a variable with an empty
name. The bare-record scanner had allowed `(#.*)?`, on a behaviour Compose does not have,
and could not see a missing final newline at all; both are now driven by the measurements
above, and `nexa_env_rewrite` refuses a file ending in an unterminated bare name rather
than normalising the ending and thereby creating the record.

**Trigger to resolve:** the next change to `NEXA_ENV_AWK_LIB` or to any of the three
scanners. Whoever opens that file does this at the same time, with cases for `NAME:value`,
`NAME :value`, `NAME: value`, `NAME =value`, `NAME<TAB>=value`, a colon inside a quoted
value, and either form inside another variable's multiline value.

## OQ-4B-01 — how a customer reaches a catalogue longer than one Telegram message

`/catalog` answers with a heading and one inline-keyboard button per product, bounded at
`CATALOG_PAGE_SIZE = 20`. `ProductRepository.listCatalog` reports `hasMore` and the bot
surface **drops it**: a tenant with twenty-one sellable products shows twenty and says
nothing about the twenty-first.

**Why it is not resolved here.** Every way of fixing it is a product decision with no
evidence behind it in `docs/research/`: a next-page button (which needs a cursor over a
MUTABLE `sort_order` — the defect migration 0026 records), categories (which
`catalog.ts` deliberately does not have), or a search. The legacy bot's own catalogue is
not captured in the corpus at a size that decides it, and `NOT_EXPOSED` means "the UI did
not show it", never "it does not exist".

**Why twenty is safe meanwhile.** `MAX_ORDER_LINES` is 1 and every plan in the research
is a duration/traffic variant; twenty is above any catalogue the corpus shows. The bound
is stated in `bot-runtime.ts` where it is applied, so the limit is visible to the next
reader rather than discovered by a tenant.

**Trigger to resolve:** the first tenant with more than twenty sellable products, or the
phase that adds categories — whichever comes first. Whoever does it decides the ordering
key at the same time, because a cursor over `sort_order` is the part that is not
obvious.

## OQ-TG-01 — an installation cannot change the bot it serves, and cannot recover a revoked token

Status: OPEN. Raised by the fresh-install bootstrap (ADR-0029), which is where it
becomes reachable.

ADR-0029 decision 3 is right and this is its cost, stated plainly rather than
left for somebody to discover at the worst moment.

The installer reconciles and never rotates: `BotBootstrapRepository` deliberately
declares no method that writes a token onto an existing row, so the capability
does not exist to be called by accident. The ADR defers the deliberate version to
"an explicit operator command or the later Web Admin management workflow".
Neither has been built. So:

- an installation whose bot token is **revoked** in BotFather is permanently
  `incomplete`. Every `install.sh` rerun exits non-zero, `botctl telegram
register` fails with `telegram.bootstrap_token_rejected`, and the only way back
  is SQL against `bot_instances`;
- the same is true of a token **rotated** in BotFather, which is the ordinary
  reaction to a suspected leak — the thing an operator is most likely to do in a
  hurry;
- a developer running `bot:bootstrap:dev` against the seeded database hits it
  immediately: the seed's token is a fixture, `getMe` rejects it, and nothing in
  this release can replace it.

**What a resolution has to decide**, and why it is not a small command:

1. Whether replacing a token for the SAME `telegram_bot_id` (a rotation) and
   repointing at a DIFFERENT bot (a migration) are one operation or two. They
   have different blast radii: a rotation changes a credential, a repoint strands
   every stored `telegram_user_id` and `chat_id`.
2. What authorizes it. The bootstrap is a CLI precisely because provisioning has
   no caller to authorize; a management workflow has one, and needs a permission,
   an audit row and a confirmation.
3. What happens to the webhook. A new token does not change the registration, but
   the old bot may still hold one pointing here.

Until then: the constraint is documented in `docs/deployment.md`, and the error
message names this entry rather than implying a command that ships.

## OQ-TG-02 — a BotFather rename is not picked up after the first bootstrap

Status: OPEN, and small.

`bot_instances.username` is written from `getMe` when the row is created, and
refreshed only on the path that fills a NULL `telegram_bot_id` — a row that
predates migration 0038. For every row this release creates, `getMe` returns
before that write, so an operator who renames the bot in BotFather leaves the
stored username stale for ever.

Nothing reads it for routing — the identity that matters is the numeric id, and
the webhook is addressed by the bot instance's own UUID — so this is a reporting
defect rather than a functional one. It is recorded because a stale username is
exactly the kind of thing an operator later reads as evidence of which bot an
installation is bound to.

## OQ-TG-03 — the bootstrap's serialization is a host lock, not a database one

Status: OPEN, and bounded.

`BotBootstrapService.execute` makes two Telegram calls and then records what it
did. `setWebhook` cannot be inside the transaction that records it — a rolled-back
transaction would leave Telegram pointed somewhere the database does not know
about — so two concurrent reconciliations using DIFFERENT origins can commit the
external and the local effect in opposite orders, leaving a row that says `ready`
for a URL Telegram is not using.

The ordering is held from outside: `install.sh` and `botctl telegram register`
each take the installation's exclusive lock, and `check-boundaries.sh` now fails
the build if any other file runs the compiled CLI. That check exists because the
claim it replaces was false — `apps/api/package.json` exposed `bot:bootstrap`,
a third entry point taking no lock, on a host holding the production database.

What is NOT closed: an operator running the CLI inside the container by hand
bypasses the lock, and nothing in the application would refuse them.

A database advisory lock is the obvious alternative and is deliberately not used.
It would have to be held across two network calls while the marker transaction
checks out a second connection from the same pool; `DATABASE_POOL_MAX` may be 1,
and this codebase has already reproduced that deadlock twice — `permission-guard.ts`
records it as "reproduced at pool size 1". Closing this properly means either a
lease row with a takeover rule, the way the backup pipeline does it, or asking
Telegram what it actually has (`getWebhookInfo`) and recording that rather than
what was requested. Neither is worth doing before something other than an
installer reconciles a webhook.

## OQ-TG-01 addendum — what a revoked token actually leaves an operator

Recorded because the installer told them otherwise for one commit.

The summary added for `telegram.bootstrap_token_rejected` said that reissuing the
token for the same bot in BotFather and rerunning the installer was the supported
route. It is not, and the sentence above it already said why: `execute` resolves
the credential from the row and registers with that, every time. A supplied token
is read only so `refuseRepointing` can refuse one naming a different bot; its
secret half never replaces a stored credential, by design (ADR-0029 decision 3).

So a rerun with a reissued token fails exactly as the run before it did. Until a
release adds an explicit rotation command there is no supported recovery, and the
summary now says that rather than naming a procedure. This is the concrete cost
of OQ-TG-01 and the reason it should not stay open indefinitely.

## OQ-TG-04 — Telegram bootstrap hardening deferred by owner decision

**Status: RESOLVED in Phase 4I.** All thirteen items were re-verified against the
4H merge before any of them was touched — a finding written at `22239a6` is
evidence about `22239a6` — and all thirteen were still real. See
`docs/phase4i-audit.md` for the re-verification and `docs/phase4i-falsification.md`
for the evidence. The account below is kept intact because it is what the
resolution rests on; the closing section records what was done to each item.

The original status line, for the record: OPEN, DEFERRED. **Not rejected, and not false positives** — every item below
was reported by an independent review of head `22239a6` and is, as far as it was
examined, real. The owner stopped the review-and-fix loop and deferred them; this
entry exists so they can be picked up rather than rediscovered.

One finding from that round was NOT deferred and is fixed: `botctl telegram`
echoed its rejected arguments, so a token passed in argv reached stderr and any
log capturing it. See `tests/deploy/botctl.test.sh` › "a token passed in argv is
never echoed back by any refusal".

### Why the list is this long, which matters more than any single item

Five review rounds on this branch each found a defect inside the previous round's
fix. The shape is the same every time: **the installer derives an operator-facing
remedy from a cause, in prose, in a file that cannot see the code that decided
it.** `deploy/install.sh` now carries seven `INCOMPLETE_*` summaries — roughly 180
lines — and each new cause adds a message that must be true in every state
reachable with it. Nine of the thirteen items below are "that prose is false in
state X".

A structural fix was started and reverted unfinished when the loop was stopped:
collapse the seven cause-derived summaries to the TWO the installer can state
correctly from its own knowledge — whether anything was STORED, read back from the
database — and defer the cause and remedy to the CLI's error, which is printed
immediately above and is written by the code that decided it. That removes the
surface rather than adding to it, and would close items 1, 2, 4, 5, 7, 8, 9 and 11
at the root. Anyone resuming this should consider doing that before fixing the
items individually.

### Deferred items

1. **A rejected token on a FRESH bootstrap is told there is no recovery.**
   `bot-bootstrap.service.ts` `getMe`. The message says no supported recovery
   exists and a newly issued token will not be used. True of a STORED credential;
   false when no row exists yet, where rerunning with a corrected token is exactly
   the recovery — and is what the installer's own nothing-stored summary then
   advises. Two messages, contradicting each other.

2. **An already-bound refusal from a TTY install is not classified.**
   `deploy/install.sh`. The classifier reads captured output, and the interactive
   path is deliberately not captured, so a fresh bootstrap at a terminal with a
   bot already bound to another tenant falls to the nothing-stored summary and is
   told to retry with a token source, which will refuse for ever.

3. **The legacy identity fill commits before the different-bot refusal.**
   `bot-bootstrap.service.ts`. On a pre-0038 row, `getMe` records the stored
   token's bot id and refreshes the username in a committed transaction, with an
   audit row, before the second `refuseRepointing` throws. The different-bot
   summary then opens "Nothing was changed." Either compare before that commit,
   or stop claiming nothing was written.

4. **The decryption summary's header still prescribes key repair.** Its body was
   corrected to admit that restoring key material fixes neither
   `platform.secret_auth_failed` nor `platform.secret_key_id_mismatch`; the
   heading above it still says "Repair the keys first" and that the error names a
   key. `secret_auth_failed` deliberately names none.

5. **Already-bound needs two remedies, not one.** From the fresh INSERT the row
   rolled back and "create a second bot and rerun" is right. From
   `recordTelegramIdentity` the tenant already holds a legacy row and an encrypted
   token for the duplicated bot; reconciliation resolves that stored credential,
   hits the same violation, and no token-replacement operation exists — so the
   advertised retry cannot repair it.

6. **A misconfigured API base reports as a revoked token.**
   `telegram-bot-bootstrap.gateway.ts` maps every `FAILED_PERMANENT` to
   `REJECTED`, including a 2xx whose `result` is not a bot — the shape a wrong
   `TELEGRAM_API_BASE_URL` produces. Correcting that variable is the recovery, and
   the operator is told their token was revoked instead.

7. **The 0041 preflight names a remedy that does not remediate.** Creating
   separate bots and retrying changes no existing `telegram_bot_id` and no stored
   credential, so the same preflight fails again. The real remediation is direct
   database work (see OQ-TG-01), and `docs/deployment.md`'s "Migration preflight"
   section covers only duplicate PRIMARY tenants.

8. **A permanent `setWebhook` refusal is told to rerun.** `webhookFailure` shares
   one detail across `REFUSED` and `UNREACHABLE`; only the transient one is fixed
   by rerunning. A 4xx means the URL itself is wrong, and an unchanged rerun
   submits the same URL.

9. **`botctl telegram status` cannot report WHY a bot is unavailable.** It prints
   the literal state. The `--skip-telegram` text sends the operator there to find
   out which of three conditions applies, and skipping is precisely the path that
   avoids the `execute` call which would have said.

10. **Stale-username collisions are still a raw 23505.** `rethrowAlreadyBound`
    translates the bot-id constraint only; `bot_instances_username_key` can be
    violated by either writer when a bot takes a username still stored on another
    row after a rename, and surfaces as an unhandled database error.

11. **A disabled tenant with no bot is asked for a token first.** `status()`
    returns `none` before consulting `scopeIsActive`, so the installer prompts for
    a bearer credential and sends it to `getMe` before the create transaction
    refuses the inactive tenant. The credential need never have been transmitted.

12. **An outbound failure during `getMe` is diagnosed as a webhook problem.** On a
    rerun it leaves the state `ready` or `incomplete` and emits
    `telegram.bootstrap_unreachable`, which the classifier does not recognise, so
    the webhook summary points at inbound DNS and certificates — the wrong network
    boundary — for a call that never reached `setWebhook`.

13. **`docs/deployment.md` documents three status values, not four.** The
    script-readable contract still reads `none | incomplete | ready`; `unavailable`
    is missing, so automation written from that section rejects a legitimate
    answer exactly when something is disabled.

### How 4I resolved it

The structural fix this entry recommended was done FIRST, and it is what closes
most of the list: `deploy/install.sh` no longer derives a cause. The `case "$out"`
classifier is deleted, and three summaries keyed on `telegram_state()` replace
seven keyed on a grep over output the interactive path does not capture.

Three rather than the two suggested, and the third is what the rule produces
rather than an exception to it: after item 11 an inactive tenant answers
`unavailable` with no bot row, and the post-failure state read can fail outright
and leave the state empty. Neither may produce a sentence about a credential.

| item | what closed it                                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `getMe` branches the rejection message on `existing`; a FIRST bootstrap is told nothing is stored and a corrected token is the recovery                                                                                                                                                   |
| 2    | the classifier is gone, so there is nothing left to be unreachable                                                                                                                                                                                                                        |
| 3    | `refuseRepointing` is told whether the legacy identity fill committed, and stops saying "Nothing was changed." when it did                                                                                                                                                                |
| 4    | the heredoc is gone; the four secrets codes get four sentences from `bootstrapRemedy`, two of which say key material does not fix them                                                                                                                                                    |
| 5    | `rethrowAlreadyBound` takes which statement raised it and gives the fill path its own remedy                                                                                                                                                                                              |
| 6, 7 | `TELEGRAM_BOOTSTRAP_API_BASE_INVALID`; the gateway keys on `telegram.rejected.getme_shape`, which the transport always reported and the adapter discarded. The 0041 preflight stops prescribing what does not remediate, and `docs/deployment.md` documents the condition it is cited for |
| 8    | `TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED`, with its own sentence: an unchanged rerun submits the same URL                                                                                                                                                                                      |
| 9    | `statusWithReason`; the bare state stays on stdout and the cause goes to stderr                                                                                                                                                                                                           |
| 10   | a SECOND branch for `bot_instances_username_key`, never a wider first one                                                                                                                                                                                                                 |
| 11   | the scope-level causes are checked before the row lookup, so a stopped tenant with no bot never reaches the prompt that sends a credential to Telegram                                                                                                                                    |
| 12   | the unreachable message names the OUTBOUND boundary and rules out the two inbound things the webhook summary sent people to                                                                                                                                                               |
| 13   | all four values documented, and a deploy check reads the list from `BotBootstrapStatus` so a fifth cannot go undocumented                                                                                                                                                                 |

Three contract codes were added, each landing with its producer rather than in a
contracts-only commit — `check-boundaries.sh` refuses a declared code nothing can
produce, and argues in the file why: "A code arrives when a path produces it."

`OQ-TG-01` — token rotation — is deliberately NOT resolved here. Several of these
messages point at it and none of them invents it; removing prose that gestured at
a rotation is not the same as adding the command.

## OQ-4C-01 — when an unpaid order and its pending payment expire

**Status: RESOLVED in Phase 4G.** See the closing section below; the account of what
4C left is kept intact because it is the evidence the resolution rests on.

Phase 4C creates orders that reach `AWAITING_PAYMENT` and `MANUAL_TRANSFER` payments
that sit `PENDING`, and **nothing expires either of them**. `orders.expires_at` is
written at DRAFT and re-read at confirmation; `payments.expires_at` carries the order's
deadline onto the payment. Both are read by refusals and neither is swept.

**Why it is not resolved here.** The planned-payments copy this replaces recorded owner
revision 4 in these words: «مهلت پرداخت حداکثر **یک ساعت** است و پس از آن پرداخت و سفارش
باید منقضی یا لغو شوند. این قاعده باید در دامنه و سرور اجرا شود، نه با یک تایمر در
مرورگر.» — at most one hour, enforced in the domain and on the server rather than by a
browser timer. No contract states that hour. `sales.order_expiry_minutes` is the only configured
window and it bounds a DRAFT's price hold, not an unpaid confirmed order — a customer
who has been given bank details and an amount is in a different situation from one
holding a quote. Picking a second window is a financial product rule, and `FBR-008`
records that the legacy system's own amount/expiry layering is unresolved.

**What holds meanwhile, corrected.** This paragraph used to say an expired deadline
never settles anything by accident, because `orderAwaitingPayment` refuses an order in
any other state. That was circular and the behaviour was the opposite: nothing sweeps a
stale order, so it is never IN another state, so the refusal never fired. A customer who
scrolled back weeks later and tapped the still-live pay button settled at a quote they
had been told expired.

`orderAwaitingPayment` now compares the order's own `expires_at` against the clock and
refuses with `ORDER_EXPIRED`, on both customer-initiated paths. An OPERATOR confirming a
transfer that already arrived is deliberately exempt and the parameter says so by name:
the money is in the bank and this release has no refund path, so refusing because the
deadline lapsed while the receipt sat in the queue would strand it.

The gap that remains is the one this question is about: nothing MOVES a stale order to
`EXPIRED`, so it still sits in the admin as awaiting payment for ever. Refusing to act
on it is what 4C can do without inventing a window; expiring it is what needs the hour
nobody has stated.

**Trigger to resolve:** the phase that adds a sweeper, or the first operator who asks
why a month-old order still says it is waiting.

### How 4G resolved it

The hour was never unknown; it had nowhere to live. This question quotes owner revision
4 in the owner's own words — at most one hour, after which the payment AND the order
must be expired or cancelled, enforced in the domain and on the server rather than by a
browser timer — and then says _"no contract states that hour"_. 4G states it.

- `PAYMENT_WINDOW_MINUTES_MAX` is 60, and it is the CEILING rather than a default with a
  suggestion attached: `sales.payment_window_minutes` may be set lower by a tenant and
  cannot be set higher. `sales.order_expiry_minutes` is untouched and still bounds a
  DRAFT's price hold, which is the distinction its own registry entry already recorded.
- `requestManualTransfer` takes the EARLIER of the order's deadline and that window, so
  neither bound can be escaped by configuring the other. It used to take the order's
  alone, whose ceiling is fourteen days.
- `PaymentExpiryService`, in the worker, expires stale payments and then the orders they
  were against, in one transaction, bounded and tenant-scoped, with the scope-activity
  check inside the transaction. `orders_expiry_idx` — an index that had existed since
  0032 with no reader — is finally what it was built for.

**One consequence, stated because it is a real behaviour change.** The
`OPERATOR_MAY_CONFIRM_LATE` exemption described above still stands and is now BOUNDED:
once the sweep has closed a payment, a late confirmation finds it no longer PENDING and
is refused. That is the owner's rule applied rather than an oversight. The remedy for
money that did arrive after the window is a wallet credit (`users.wallet.credit`,
`POST /users/:id/wallet/adjust`) — audited, reversible by a second adjustment, and
requiring no closed payment to be reopened. That key belongs to `owner` and `finance`
and NOT to `receipt_reviewer`, so the operator most likely to meet this case is the one
who cannot perform the remedy; an installation that separates those roles has to route
it.

## OQ-4G-01 — nothing tells a customer their payment was rejected or expired

**Status: UNRESOLVED. Carried into 4H, which is the Telegram UX phase.**

4G makes three outcomes reachable and a customer is told about exactly one of them: the
withdrawal they performed themselves, synchronously. An operator's rejection and the
sweep's expiry both happen while the customer is not looking, and nothing sends them
anything. They meet the outcome the next time they press a button on the old message,
where `bot.payment.not_pending` says what happened.

**Why 4G did not simply send one.** There is no durable per-customer notification lane
in this release. `DeliveryService` is service delivery's own — its state lives on a
`services` column, its retries and its `UNCONFIRMED` outcome are about a subscription
link — and the Phase 2 notification dispatcher's destinations are operator channels.
A best-effort `CustomerMessenger.send` from inside the sweep would be a message whose
failure nobody records, which is the shape `DeliveryService` exists because of.

Building the lane is real work with a real design question attached (what a failed
send to a customer who has blocked the bot means), and it belongs with the rest of the
Telegram UX rather than bolted to a sweep.

**Trigger to resolve:** Phase 4H.

## OQ-4G-02 — may an operator reject a receipt AND end the order in one action?

**Status: UNRESOLVED. Recorded rather than guessed, and the narrow behaviour shipped.**

4G's rejection closes the payment and leaves the order `AWAITING_PAYMENT` until its own
deadline. The reasoning is that a rejected transfer is not a withdrawn purchase: the
customer still wants the thing and may pay from their wallet or transfer again inside
the window they were given, and `commerce.ts` keeps `CANCELLED` and `EXPIRED` apart
precisely because "the customer changed their mind" and "we stopped waiting" are
different facts.

What is genuinely unresolved is whether an operator who knows the transfer was
fraudulent — not merely absent — should be able to end the order in the same action.
That is a policy about what a failed attempt means, it needs a second confirmation step
to be safe, and nobody has stated it. `ORDER_MACHINE`'s `CANCEL` edge is now callable
(4G gave `OrderRepository.transition` its `cancelled_at` stamp), so the mechanism exists
and only the decision is missing.

**Trigger to resolve:** the owner, or the first operator who asks for it.

## OQ-4G-03 — a DRAFT order nothing ever confirms is never swept

**Status: UNRESOLVED, and deliberately out of 4G. Retention, not correctness.**

`ORDER_MACHINE` has `DRAFT → EXPIRED` and 4G gave it no caller either. A draft is a
quote the customer never confirmed: nothing was promised for it, no payment instruction
was issued, and `OrderService.confirm` already refuses one past its deadline. So it is
wrong in the way an unbounded table is wrong, not in the way a stale obligation is.

Two things point the same way. `orders_expiry_idx` is partial on `AWAITING_PAYMENT`
alone, so the schema's own author scoped the sweep there; and the owner's rule is about
a payment and the order it was against, which a draft has never had.

The decision it needs is a retention policy — ADR-0027's shape, like the backup-run and
recovery-request sweepers — rather than a lifecycle transition.

**Trigger to resolve:** the phase that revisits retention, or an installation whose
`orders` table is mostly abandoned drafts.

## OQ-4G-04 — `UNKNOWN` and the two reconciliation edges still have no producer

**Status: UNRESOLVED. Blocked on a gateway rail that is itself blocked on a decision
and a credential.**

`PAYMENT_MACHINE` has `PENDING → UNKNOWN on LOSE_TRACK` and two `RECONCILE_*` edges out
of it, and `payments_unknown_idx` describes itself as the reconciliation queue. 4G built
the four edges that have a real producer and left these three alone.

They need a gateway. `payment.ts` is explicit — _"A gateway is reached through
`PaymentGatewayPort` and there is no adapter in this release. An unconfigured gateway is
REFUSED, not simulated"_ — and `SELF_CONTAINED_PAYMENT_METHODS` is wallet and manual
transfer, neither of which can lose track of anything: a wallet debit commits or rolls
back with its own confirmation, and a manual transfer's outcome is an operator's
assertion.

Building the reconciliation consumer alone would give an operator a queue that is empty
by construction, and the only way to exercise it would be a fixture that put a payment
into `UNKNOWN` by hand — which is the failure `CLAUDE.md` names: a fake this repository
wrote and an adapter this repository wrote can only prove they agree with each other.

**Trigger to resolve:** the phase that adds a real gateway adapter, with a disposable
instance of it to accept against.

## OQ-4G-05 — does a payment's window closing end its ORDER, or only the payment?

**Status: UNRESOLVED. The narrow reading shipped; the owner's sentence admits both.**

`OQ-4C-01` quotes owner revision 4: «مهلت پرداخت حداکثر **یک ساعت** است و پس از آن پرداخت
و سفارش باید منقضی یا لغو شوند» — at most one hour, after which the payment **and** the
order must be expired or cancelled.

4G implements two windows. A payment's deadline is the earlier of `sales.payment_window_minutes`
and the order's own `sales.order_expiry_minutes`, and each row is expired by its own
deadline. Under the DEFAULTS — both sixty minutes — those coincide and the owner's
sentence holds exactly: the payment and its order expire in the same sweep pass. They
diverge only when a tenant deliberately sets a longer order window, and then a lapsed
manual transfer closes while its order stays `AWAITING_PAYMENT` for the rest of its own
window.

**The two readings.** One window (the checkout gives you an hour; after it both die), or
two (the payment attempt has a deadline, the order has its own). The Persian is
compatible with either, and the owner was describing a flow that has one.

**Why the narrow one shipped.** Nothing is stranded under it. A customer whose transfer
lapsed can start another, or pay from their wallet at the price they were quoted, inside
the deadline they were shown — that is the product working, not a hole. The wide reading
would take an order away from a customer who still had days of the window they were
given, on the strength of one clause. `CLAUDE.md`'s instruction for exactly this is to
choose the narrowest rule and record the ambiguity rather than invent policy.

It is also consistent with the rest of the phase: a rejection and a withdrawal both leave
the order open on purpose (`OQ-4G-02`), and making an expiry the one outcome that ends
the order would need the same decision this question is waiting for.

**Raised by** the Codex review of PR #29, which read the same sentence the other way.
Recorded rather than argued: both readings are defensible and only the owner can say
which they meant.

**Trigger to resolve:** the owner, on reading this — or the first operator who asks why
an order outlived the transfer instructions it issued.

## OQ-4C-02 — what a refund is, as a state

Refunds are out of scope for 4C and `REFUNDED` is in `ORDER_STATES` with no producer.
The deferred decision, recorded here rather than lost with the placeholder page that
carried it: **a refund REQUEST and a completed refund are different facts, and a refund
state and a delivery state must never combine into an impossible pair.** `ledger.ts`
already has `REFUND`, `PURCHASE_REVERSAL` and `CHARGEBACK` as distinct reasons, which is
the shape that keeps them apart.

`commerce.ts` also fixes the surrounding rule: a settlement that turns out to be wrong
is a refund plus a new order, never a reopened one, because the alternative is an order
whose paid-at timestamp is a lie.

**Trigger to resolve:** the phase that implements refunds.

## OQ-4C-03 — owner revision 17 says receipt review happens in Telegram; 4C confirms in the Web Admin

**The revision, as recorded on the planned payments page:** «رسید پرداخت در پنل وب
ذخیره، بایگانی، نمایش یا بررسی نمی‌شود. بررسی رسید در تلگرام انجام می‌شود.» — a payment
receipt is not stored, archived, displayed **or reviewed** in the web panel; receipt
review happens in Telegram.

**What 4C built, and why it is not simply a violation.** The frozen contracts are
web-admin-shaped and were frozen before this phase: `receipts.review` is a PERMISSION in
`permissions.ts` carried by the `finance` and `receipt_reviewer` roles;
`payments.confirmed_by_admin_id` is a column referencing `admins.id`; and
`confirmPaymentRequestSchema` takes an operator's `evidenceNote`. An admin id and an
admin permission do not describe a customer-side Telegram flow. Implementing the
confirmation anywhere else would have required inventing a mechanism no contract states.

**What 4C does NOT do, which is the half of the revision it honours in full.** No receipt
FILE is uploaded, stored, archived or displayed anywhere in this release. There is no
image, no attachment and no document: `payments.evidence_note` is an operator's own
bounded text, and the schema comment says it is _"never the customer's own message text
and never a gateway response body"_. `products-and-orders.test.tsx` and the payment page
tests assert the absence of any upload or attachment control.

**What is genuinely unresolved:** whether the APPROVAL DECISION belongs in Telegram, in
the Web Admin, or in both. 4C puts it where the frozen permission and the
`confirmed_by_admin_id` column point. If the owner's intent was that an operator approves
from a Telegram admin chat, that is a second surface over the same service — the
application layer already takes an `ActorContext` and `ACTOR_TYPES` includes
`TELEGRAM_ADMIN`, so it is an addition rather than a rewrite.

**Trigger to resolve:** the owner, on reading this. Nothing blocks on it: the
confirmation is audited, permission-checked and idempotent wherever it is invoked from.

**4G addendum.** The REJECTION shipped in the same place, for the same reason and with
the same caveat: `receipts.review` and `payments.resolved_by_admin_id` are both
web-admin-shaped, and putting the decision anywhere else would mean inventing a
mechanism no contract states. If the owner's intent was a Telegram admin chat, both
halves move together — the application layer takes an `ActorContext` and `ACTOR_TYPES`
already includes `TELEGRAM_ADMIN`, so it is an addition rather than a rewrite.

**5A addendum — the owner has reversed the storage half.** The Payment UX addendum
specifies an invoice button «✅ پرداخت را انجام دادم | ارسال رسید» whose tap starts
receipt submission for that exact payment, so receipts ARE stored — a later instruction
from the same owner, superseding «رسید پرداخت … ذخیره … نمی‌شود». The review model is
untouched: settlement still requires operator confirmation, `PAYMENT_EVIDENCE_KINDS`
stays `OPERATOR_REVIEW`, and an upload confirms nothing. The question this entry asks —
whether the approval DECISION belongs in Telegram or the Web Admin — is still open and
still blocks nothing. Storage is subphase 5R; see `docs/phase5-audit.md` §7.

## OQ-4C-04 — what happens to wallet funds in a currency the installation stopped selling

`sales.currency` is `RUNTIME`-mutable over `['IRT','IRR']` and the Web Admin ships a
picker for it. A wallet balance is derived per currency, so changing it strands every
entry denominated in the old one: `WalletService.adjust` refuses a movement in a
currency the installation does not sell, and `settleFromWallet` sums only the order's
currency, so no debit, settlement or adjustment can ever reach those funds.

**What 4C fixed, and what it did not.** The review found the history listing every
currency while the balance above it counted one, so a tenant that switched saw
«موجودی: ۰» over a populated table — the residual shape the module exists to prevent.
The history now takes the same currency predicate as the balance, so the two agree.
That makes the surface honest and makes the stranded entries INVISIBLE on it, which is
the half that is still wrong.

**Why it is not resolved here.** Every available answer is a financial product rule. To
convert needs a rate, and no rate exists anywhere in this system — `docs/research/`
records that none of the seven inspected gateways carries one. To refuse the setting
change needs a rule about when a tenant may re-denominate. To show both balances needs
a wire shape that carries more than one, and `walletBalanceSchema` is frozen with a
single `currency`. Picking any of them is exactly the invention this phase's runbook
forbids.

**What holds meanwhile.** The money is not lost — the ledger is append-only and every
entry keeps its own currency, so whatever is decided later can be applied to rows that
are all still there. What is missing is any way to see or move them.

**Trigger to resolve:** the first installation that changes `sales.currency` with wallet
entries already written, or the phase that gives a wallet more than one denomination.

## OQ-PROV-01 — a connection reset after the request is sent reads as `UNREACHABLE`

**Status: OPEN, contained, and deliberately not fixed in Phase 4D.**

`SafeHttpClient` maps every non-timeout, non-TLS socket error to `UNREACHABLE`
(`failureFromError`, `apps/api/src/infrastructure/net/safe-http.ts`), and
`SAFE_TO_REPLAY_FAILURE_KINDS` lists `UNREACHABLE` on the stated ground that _"the
request never reached an authenticated endpoint, so nothing happened."_

That is false for a connection torn down **after** the request was fully written — a
proxy timing out, a panel restarting mid-response, a load balancer dropping a
connection. The panel may well have committed the write, and Nexa calls the failure
safe to replay.

**Why it is not a duplicate account.** The provider username is derived from the
service id, so the replay addresses the SAME account. 3X-UI refuses a duplicate email
and Marzban a 409; both are `PROVIDER_ERROR`, which `failureOutcome` classifies UNKNOWN
on a mutating call, which sends the service to reconciliation, which adopts the account
that is already there. The cost is one wasted provider call and one spent attempt, not
a second thing a customer pays for.
`tests/integration/provisioning-delivery.test.ts` › creates one account when a create
is cut off after the panel stored it drives exactly this sequence and asserts the
account count.

**What a fix would be.** Node reports `'finish'` on the outgoing request once it has
been flushed; a socket error after that point is not "unreachable" and should be
reported as a kind that is not safe to replay. It is not done here because
`SafeHttpClient` is shared by every probe and adapter in the installation and is
covered by 42 fake-server scenarios that assert the current classification — changing
it is its own change, with its own review, and CLAUDE.md records what happens when a
fix is reviewed less hard than the bug.

## OQ-PROV-02 — the announcement uses the bot the customer FIRST wrote to

**Status: OPEN, contained, and deliberately not fixed in Phase 4D.**

`CustomerContactReader` (wired in `apps/api/src/container.ts`) resolves a service's
announcement destination as `customers.first_bot_instance_id`. `CustomerMessage`
requires the bot relevant to the interaction, and its own docblock gives the reason:
for a tenant running a public bot beside a reseller bot, a message from the wrong
account leaks the relationship between them.

Those two are not the same bot. `first_bot_instance_id` records the first contact
ever; a customer who first wrote to the public bot and later ordered through the
reseller bot is announced to from the public one.

**Why it is not fixed here.** There is nothing to fix it with. `orders` carries no
bot instance column — checked, not assumed — so this release does not record which
bot a purchase came through, and no other table does either. Using the only recorded
value is better than inventing one; the container comment now says this outright
rather than implying `first_bot_instance_id` is correct.

**Why it is contained today.** Reseller sub-bots are not implemented (CLAUDE.md: no
resellers), and a tenant with exactly one bot instance — the shape every installation
has until that phase — cannot hit it: first contact and purchase are necessarily the
same bot.

**What a fix would be.** `orders.bot_instance_id`, set where the Telegram order flow
creates the draft (it holds the bot instance already), carried onto the service, and
read by the delivery sweep in preference to the customer's first bot. That is an
orders schema change plus a port change, which belongs with Phase 4E's service work
rather than bolted onto the delivery wiring.

**Found by** the Codex review of PR #25, which reported it as a P1. The severity is
right about the rule and wrong about this release: the leak it describes needs a
second bot instance to exist, and nothing creates one yet.

---

## OQ-4F-01 — what a renewal does to an allowance the customer has not spent

**Status: OPEN. Phase 4F ships a default and names it.**

The research corpus contains two findings on this, from two surfaces, both verified, and
they point opposite ways.

- `PBR-003` — the panel carries a setting `روش تمدید سرویس` with **five** mutually
  exclusive strategies, and its default on a new panel is `ریست حجم و زمان`: reset volume
  and time. `XUI-BR-014` records the same five on 3X-UI, so this is not provider-specific.
  Both `VERIFIED_BY_UI`.
- `TBR-012` — the bot's own `/support` FAQ states that unused **days** stack on renewal: a
  one-month account renewed five days early gets 5 + 30. `VERIFIED_BY_TELEGRAM` as the
  bot's stated policy, never confirmed by a completed renewal.

They reconcile only if the live deployment is set to one of the four non-default
carry-over methods, and `UNK-XUI-006` records that nobody could read the current selection
off either screen — the enum is rendered as a bare list with no current value marked. The
five strategy names were never captured either.

So there is no single legacy behaviour to copy, and the corpus itself says to treat this
as a configuration variable rather than a rule.

**What Phase 4F does:** the strictly additive rule, and only that.

```
new_limit   = old_limit   + purchased_traffic
new_expiry  = max(old_expiry, now) + purchased_days
```

Consumption is never cleared and an unspent allowance is never forfeited, so the outcome
is the one no customer can be worse off under. `POST /api/user/{name}/reset` is not called
anywhere. The four other legacy strategies are not implemented, and the setting that would
choose between them is not invented.

**What is unresolved:** whether the owner wants forfeit-on-renewal
(`new_limit = used + purchased`) or any of the other three carry-over methods, and whether
that choice belongs to the panel, the product or the tenant. Implementing a chooser before
that decision exists would be inventing the policy.

## OQ-4F-02 — does a renewal's period run from now, or from the old expiry?

**Status: OPEN for the expired case. Phase 4F ships `max(old_expiry, now)`.**

`TBR-012` covers the early-renewal case only, and only as stated policy text: renewing five
days early adds to the remaining five. Nothing in the corpus describes renewing a service
that has **already** expired, in either direction.

Three adjacent facts constrain the question without answering it, all
`VERIFIED_BY_MATH` from the log-group phase: an expired service is removed at −3 days
(`LGR-BR-032`, 15/15), a volume-exhausted service is removed regardless of days remaining
(`LGR-BR-033`), and the expiry warning fires at exactly 2 days (`LGR-BR-031`, 24/24). So
the legacy system has a three-day window in which an expired service still exists and
could in principle be renewed, and it never says what happens inside it.

`max(old_expiry, now)` is the only rule that is right in both directions: it never
shortens a live service, and it never sells an expired customer a period that has already
elapsed. Nexa has no equivalent of the three-day removal and does not acquire one here —
`EXPIRED` is not terminal and `SERVICE_MACHINE`'s `EXPIRED → ACTIVE on RENEW` edge is what
this phase finally gives a caller.

## OQ-4F-03 — what a renewal costs when its product has changed since the purchase

**Status: OPEN. Phase 4F refuses rather than guesses.**

`TBR-008` establishes that the legacy renewal is priced from the ordinary catalogue: a
"renew the current plan" shortcut at the identical price, or the full picker, which means
a renewal can become an upgrade. `SBR-011` adds that withdrawing a product from sale does
**not** stop renewals of services already bought from it — and says nothing about what
those renewals then cost, because the price is read from a row the operator has just
withdrawn.

Phase 4F quotes a renewal from the product's **current** list price, snapshotted into the
order at quote time, and makes the action explicitly unavailable when that product is
absent, unpriced, or priced in a currency that is not the tenant's `sales.currency`. The
order's own frozen snapshot is never recomputed from the product afterwards.

That diverges from `SBR-011` on purpose: continuing to sell against a withdrawn row means
charging a price no operator can see. A renewal price that survives withdrawal needs a
place to live, and that place does not exist in this schema.

## OQ-4F-04 — the legacy renewal configuration Phase 4F does not implement

**Status: DEFERRED, recorded so it is not mistaken for an oversight.**

- `SBR-003` — a global renewal-eligibility threshold: a maximum remaining volume above
  which the bot refuses a renewal, currently `0 GB`, meaning unrestricted.
  `VERIFIED_BY_TELEGRAM` from the prompt text; the value was never changed.
- `SBR-013` — a per-product `نوع استفاده محصول` gate with three values: new-purchase only,
  renewal only, or both, defaulting to both. `VERIFIED_BY_TELEGRAM`.

Neither is implemented. Phase 4F's eligibility is the service's own lifecycle state, the
panel's declared capability, and the product still being purchasable — nothing else. Both
settings are ordinary catalogue configuration and belong with the Web Admin commercial
surfaces, not with the operation that spends a customer's money.

## OQ-4F-05 — a free-entry add-on quantity has no home in a bot with no FSM

**Status: RESOLVED by architecture, recorded because it is a deliberate divergence.**

`TBR-009` establishes that the legacy extra-volume flow takes a **free-text GB count**,
prices it at a flat rate — 4,500 Toman/GB, confirmed to the Toman on a 5 GB sample — and
creates the invoice at quantity entry, before any payment method is chosen. `PBR-009` adds
that the rate is configured per panel, as `قیمت حجم اضافه` and `قیمت زمان اضافه`. The
extra-time flow takes a free-text day count; **its rate was never captured**, so `TBR-015`
grouping the two as one pricing mechanism is an inference and not a measurement.

This bot has no FSM and no conversation state, by a rule with an incident behind it: the
legacy prompt capture swallowed an ordinary message and overwrote a production gateway
setting (`INCIDENT-FIN-001`). A callback carries an intent and an identifier, never a
quantity — so there is nowhere for a typed number to arrive and nowhere safe for it to be
carried.

Phase 4F therefore ships **configured add-on rows the customer selects by id**: the
amount, the unit and the price are server-side, and the callback names a row. Until an
operator configures one, the action is explicitly unavailable — never free, never
inferred from a per-unit rate that does not exist for one of the two kinds.

**What is unresolved:** whether the owner wants the legacy per-unit rate restored later
through a different surface — a Mini App or a Web Admin form, both of which can carry a
typed quantity safely — and whether add-on prices should be scoped per panel as `PBR-009`
has them rather than per tenant.

## OQ-4H-01 — an interactive Telegram reply that Telegram rate-limits is lost

**Status: OPEN, and it is a DEFECT rather than an ambiguity.** Found by the Codex
review of PR #30 and confirmed against the code.

`BotRuntime` answers a webhook turn by sending one reply. When `CustomerMessenger.send`
returns `RATE_LIMITED` the runtime records that outcome and the webhook still completes
successfully — and nothing reschedules the message. Telegram will not redeliver the
update either. So during a burst an order or payment mutation can COMMIT while the
customer sees no confirmation at all.

The two background callers do better: `CustomerNotificationService` and the delivery
lane both put the row back on the queue at Telegram's own `retryAfterMs` with no attempt
spent. The interactive path has nowhere to put it.

**Why it is not fixed in 4H.** Putting an interactive reply on the notification lane
needs the lane to carry an arbitrary message, and it deliberately does not: a
`CustomerNotificationKind` is a FACT with one template key and no values, which is what
lets `CUSTOMER_NOTIFICATION_PRECONDITIONS` ask whether the fact is still true before
sending. Several interactive replies carry values and an inline keyboard. Carrying one
through the lane means either storing a rendered string — which
`docs/conventions.md` forbids outright — or adding a parameterised payload column and
accepting that a queued reply cannot be re-checked. That is a contracts and schema
decision about what the lane IS, not a bug fix, and ADR 0030 §1 argues the opposite
position on purpose.

**What holds meanwhile.** The mutation is committed and durable; the customer's next
interaction reads real state rather than a cached claim, and `/start` and My Services
both show it. What they lose is the immediate confirmation, not the effect.

**Trigger to resolve:** Phase 4J, whose subject is exactly this class — crash windows
and cross-system delivery. Decide there whether the lane grows a parameterised payload,
or whether the webhook turn gains its own bounded retry before acknowledging.

## OQ-4H-02 — an upgraded installation keeps its old Telegram command menu

**Status: RESOLVED in Phase 4I**, by the mechanism this entry itself named. See
the closing section below; the account is kept because it is the evidence.

The original status line, for the record: OPEN, and it is a gap in a shipped
feature. Found by the Codex review of
PR #30 and confirmed against the code.

`registerCommands` runs inside `BotBootstrapService.execute` and nowhere else. A
`botctl update` does not invoke that CLI, and an already-`ready` bot is not reconciled
by starting the new image — so an installation that upgrades to the release carrying
`BOT_COMMANDS` keeps whatever menu it had, which for most installations is none, until
an operator happens to run `botctl telegram register`. The discoverability 4H item 8
delivers therefore applies to FRESH INSTALLS only.

**Why it is not fixed in 4H.** The right mechanism is a command REVISION stored beside
the bot, so an upgrade re-registers exactly once rather than on every boot of every
replica — a schema column, an upgrade path, and a decision about where the
reconciliation runs. Registering unconditionally at startup instead would put an
outbound Telegram call on the readiness path of every process, which is the coupling
`configure_telegram_bot` was moved out of the critical path to avoid.

**Trigger to resolve:** Phase 4I. Its subject is `OQ-TG-04` — Telegram bootstrap and
upgrade behaviour — and this is the same surface: what a RERUN reconciles, and what an
installation that upgrades rather than installs is left holding.

### How 4I resolved it

The mechanism is the one this entry specified, with no deviation: "a command
REVISION stored beside the bot, so an upgrade re-registers exactly once rather
than on every boot of every replica".

- `bot_instances.commands_revision` (migration `0059`) holds a digest of the menu
  Telegram last accepted. NULL means UNKNOWN, never "matches" — the same rule
  `webhook_secret_fingerprint` states, and every installation that upgrades into
  this release starts there, so each registers once.
- The digest is computed by the ADAPTER, from the rendered menu rather than from
  `BOT_COMMANDS` alone, so a catalogue rewording counts as a change too. It has to
  be the adapter: rendering needs `@nexa/i18n`, which `check-boundaries.sh`
  refuses to an application file by name.
- `execute` reconciles the menu on the ALREADY_COMPLETE path as well, which is
  the actual gap. `setMyCommands` ran only below that early return, so an
  installation whose webhook was current never reached it — not even under
  `botctl telegram register`.
- `botctl update` now invokes the bootstrap CLI once the release is COMMITTED.
  Best effort by construction and by placement: everything that can fail the
  update has already succeeded, and a customer whose client shows no command list
  types `/help` instead. The CLI's own digest comparison means this is at most one
  extra Telegram request per release that changes the menu.

The entry's two rejected alternatives stayed rejected. Registering
unconditionally at startup would put an outbound Telegram call on every process's
readiness path; a hand-bumped version number is a number somebody forgets to
increment in exactly the release that changed the list.

## OQ-5R-01 — `support` holds `receipts.view` and cannot reach a receipt

`support` is seeded with `receipts.view` and NOT `payments.view`. Until 5R nothing
consumed the key, so the grant was inert; the receipt card is now real and it lives on
the payment detail page, which refuses an actor without `payments.view`. This is the
shape migration `0055` repaired for `receipt_reviewer`, and both resolutions change what
an operator role may do:

- grant `payments.view` to `support` (seed plus a `0055`-style backfill) — support then
  reads every payment's financial detail, not only the evidence;
- withdraw `receipts.view` from `support` — a customer's bank screenshot becomes
  finance-and-review-only, and the seeded intent that support reads receipts goes.

Not resolved here: `packages/contracts/src/permissions.ts` is the frozen role vocabulary
and this is an authority decision, not a defect in the receipt lane. A third option — a
receipts queue of its own under `receipts.view` — is a surface nobody has asked for.

**Trigger to resolve:** whoever specifies operator staffing for the first production
installation, or 5F if it arrives first.

## OQ-5R-02 — may an operator's READ use a stopped bot's token?

`tokenForBotInstance` resolves `ACTIVE` rows only, and states why: stopping a bot stops
it sending, inbound and outbound alike. A receipt's bytes are fetched with the token of
the bot that received it, so stopping that bot also stops an operator opening evidence
already filed against a still-pending payment — a reversible loss that reads as
`RECEIPT_UNAVAILABLE`.

A `getFile` is not a message to a customer, so exempting the operator read is arguable.
It is still a widening of what a stopped credential may do, and the rule it would carve
out is stated deliberately. Left in force; the card's hint now names the stopped bot as
a cause so the operator's remedy is visible.

**Trigger to resolve:** the first operator who cannot read a receipt because a bot was
stopped, or 5F.

## OQ-5C-01 — do a route's bounds and eligibility apply to an ORDER payment?

5C binds the payment route to the wallet top-up path: `requestWalletTopup` resolves an
ACTIVE, eligible route inside its transaction and refuses an amount outside that route's
bounds. `requestManualTransfer` — the order path — does not consult a route at all.

That asymmetry is deliberate for this release and it is not obviously right. In the
legacy system gateways fund both, and `کارت به کارت` is the same route whichever the
customer is paying for. Extending the eligibility half is straightforward. Extending the
AMOUNT half is not: a top-up amount comes from `wallet.topup.presets`, so a preset
outside a route's bounds is a misconfiguration an operator can fix, whereas an order
total comes from the catalogue — and a route whose maximum sits below a product's price
would make that product unbuyable, with the refusal landing on the customer at checkout
rather than on the operator at configuration time.

Three shapes, and the choice is a product decision rather than a defect:

- eligibility applies to both, amount bounds only to top-up (bounds are a top-up
  control, which is how the legacy `حداقل/حداکثر شارژ موجودی` pair reads);
- both apply to both, and the catalogue gains a check that refuses a price no configured
  route can carry;
- both apply to both, and an order total outside the bounds is simply refused — the
  simplest, and the one that puts the failure in front of the wrong person.

**Trigger to resolve:** the first installation that configures a route maximum, or the
first external gateway adapter, whichever arrives first.

## OQ-5D-01 — the first concrete gateway provider

**First concrete gateway provider requires owner selection.**

5C shipped the provider-neutral route model: `PAYMENT_GATEWAY_PROVIDERS` holds
`MANUAL_TRANSFER` alone, and a route names the `PaymentMethod` it settles through so a
second provider is a descriptor plus an adapter rather than a redesign. What does not
exist is a decision about WHICH provider that is — NowPayments, Zarinpal, Telegram
Stars, a custom endpoint, or something else. Each implies different credentials, a
different callback shape and a different verification authority, and none of them can be
chosen from the research: the legacy system exposed seven gateways and no rate field on
any of them.

Nothing here is guessed and no adapter is written against invented credentials, which is
why 5D is the one part of the payment batch that is skipped rather than deferred.

**Trigger to resolve:** the owner naming a provider.

## OQ-5P-01 — a route's customer-facing name and tutorial have no consumer yet

The Mirza payment parity pass (FBR-009's eight-control schema) found Nexa carrying
seven of the eight controls, and two of the seven with nowhere to be seen.

`payment_gateways.display_name` and `payment_gateways.instructions` are written by the
Web Admin and read by the Web Admin and the audit payload. No customer ever sees either.
The invoice a customer receives renders `bot.payment.transfer_instructions`, whose whole
body is a tenant-overridable template — so the route's `instructions` duplicates a
capability that IS wired, and `display_name` reaches nobody at all.

That is the rule 5C applied to `settlesVia` and `requiresCredentials`, which were removed
for having no reader: do not store configuration nothing consumes. It is not applied here
because neither resolution is clean while one route exists. Rendering them creates two
places for the same sentence; removing a column is expand/contract across two releases.

Both fields acquire a real consumer the moment a SECOND route exists, because a chooser
needs a name per option and per-route instructions to tell them apart — which also makes
`sortOrder`, already consumed for ordering, visible to a customer rather than only to an
operator. So this resolves with `OQ-5D-01` rather than before it.

**Trigger to resolve:** the second payment route, whichever provider it is.

## OQ-5P-02 — receipt auto-approval is refused for this release, on purpose

`FBR-007` and `PRBR-003` record four legacy controls — auto-approve, approve-without-
review, an auto-approval delay, and a per-user exemption — whose combined effect is that
money claimed by an uploaded receipt can be credited with no human ever seeing it.
`PRBR-002` adds the consequence: an empty review queue then means either "no receipts" or
"receipts approved unseen", and the screen cannot tell them apart.

Nexa does not implement them, and that is a decision rather than an omission. Every
receipt is reviewed by a person who holds `receipts.review`, the reviewer and the time are
columns, and `payment_receipts` refuses UPDATE — so "was this approved by a human" is
always answerable, which `UNK-PR-010` records as unanswerable in the legacy system.

Recorded as an intentional safety difference, not as parity still owed. The product
question — whether the owner wants any bounded form of it — stays open in the Phase 5
table above, with the bounds it would need: an explicit cap, a `SYSTEM_JOB` audit actor,
and an alert.
