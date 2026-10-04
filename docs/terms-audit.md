# Terms and rules (program §6)

A tenant's terms and rules are a sequence of versions, enforced at the one central
Telegram gate. This note records the decisions and where each rule is tested.

## Model

- `terms_versions`: at most one `DRAFT` per tenant (partial unique index), edited in
  place with a `revision` every edit and the publication name. Publishing is a
  conditional UPDATE from `DRAFT` at that revision, giving the next `version_number` in
  the same statement. A `PUBLISHED` row is immutable: `0168_terms_guards.sql` refuses
  any UPDATE or DELETE of one.
- There is no `ARCHIVED` state and no stored "current" flag. The current version is the
  published row with the greatest number. A superseded version is history.
- `title` and `body` are the operator's raw text. They are rendered only when a customer
  is shown them, as the `{title}` / `{body}` placeholders of `bot.terms.required`.
- `terms_acceptances`: one row per (tenant, customer, version), append-only, with the
  source (`TELEGRAM` only — an operator cannot accept for a customer), the bot and the
  correlation id. Both references carry the tenant (composite foreign keys).

## Enforcement

`terms_enforcement` is a feature flag (default off, `TENANT_WIDE`): enforcement is on or
off and has no parameters, so it is a flag and not a setting. It is toggled through the
existing features write, which `FeatureFlagsService` charges as `settings.edit` (there is
no `features.edit` key); the terms page draws the switch only for an actor who holds
`settings.edit`, and asks before turning it on. The features page is a second path to
the same switch, so it asks too, in the same words: `FEATURE_PRESENTATION` carries a
per-flag `confirmEnable`, set only for `terms_enforcement` (pinned in
`tests/web/control-plane-pages.test.tsx`).

With enforcement on and something published, `TermsAcceptanceService.requirement` asks
one question: has this customer accepted the CURRENT version? An older acceptance never
counts. Publishing writes no acceptance, so every customer is asked again.

## The gate

`BotRuntime.guardedAct` (membership) → `termsGatedAct` (terms) → `act`. `act` is
reached from nowhere else (`tests/unit/terms-gate.test.ts` pins the call graph by source
scan). Exempt intents are the membership gate's: support, help, the promotional
opt-out/opt-in and the management panel; a bound administrator is never stopped.

The accept button is `ac:<version uuid>`. `accept` records the version the button names
only while it is still the current one, inside its transaction. A button under an older
message, a crafted id, or another tenant's id writes nothing and answers
`bot.terms.updated` with the current version and its own button. A duplicate or
concurrent tap inserts nothing the second time (`ON CONFLICT DO NOTHING` on the once
key), and only the row actually written is audited (`customer.terms_accept`) and
announced (`CustomerTermsAccepted`). What they first asked for is never replayed.

### The answer is an edit, not a message (Batch 01 item 1)

The accept tap EDITS the terms message it sits on (`termsAcceptedReply`, `edit: true`) into
`bot.terms.accepted` — «✅ قوانین و مقررات با موفقیت پذیرفته شد.» / «اکنون می‌توانید از ربات
استفاده کنید.» — and replaces the accept button with the main-menu button. No message is
sent. The persistent reply keyboard cannot ride on an `editMessageText`; a customer stopped at
their very first `/start` gets it from that main-menu button, at their own request.

- A double tap, a later tap and a redelivered update each edit the message into the same
  text again; Telegram answers `message is not modified`, which the messenger counts as
  delivered, so none of them sends anything. The row is still written once (above).
- When Telegram cannot edit the message at all (deleted, a photo), `editOrSend` sends the
  SAME reply once as a new message — its one fallback; nothing retries, so nothing loops.
- A stale button (`termsStaleReply`) edits the same message into the newer version with its
  own button, so the customer never has two prompts on screen, one of them dead.
- An over-long version cut into parts carries the button on the last part; that part is the
  one edited.

The 2026-10 report of "a new message, and/or the prompt again" was this answer: it was the
main menu reply sent as a NEW message with the accepted text, under a terms message whose
accept button was still live. Persistence was already per (customer, version) and survives a
restart; the integration suite now pins that too. A replayed acceptance (the same key) is
answered from the replay alone: ACCEPTED while its version is still current, otherwise
STALE with the current version — it never falls through to a second write under the
occupied key, which `rememberOnce` would refuse as in-flight.

## Message length

`{title}` (≤ 120) and `{body}` (≤ 3,500) are substituted into `bot.terms.required` and
`bot.terms.updated`, so those two keys carry their own ceiling,
`TERMS_TEMPLATE_MAX_LENGTH` = 4,096 − 120 − 3,500 = 476: an accepted override renders the
longest version in one message with its button. An override stored before the ceiling
(or written by hand) can still render past 4,096; the customer messenger then cuts it
into parts within the bound with the accept button on the last part, so the gate always
answers (`terms.test.ts`, "fits the longest version…").

## Permissions

| Key             | Risk   | Seeded to                          |
| --------------- | ------ | ---------------------------------- |
| `terms.view`    | LOW    | owner, operator, support, observer |
| `terms.edit`    | MEDIUM | owner, operator                    |
| `terms.publish` | HIGH   | owner                              |

`edit` and `publish` require `view`. The acceptance is written under `maintenance.run`,
the Telegram surface's `SYSTEM_JOB` key, like the customer's own row.

## Customer 360

`overview.terms` is `{ available: false }` only for a server without the domain;
otherwise the standing: enforced, current version, last accepted version and time,
whether the current version is accepted, and whether re-acceptance is required — the
same decision the gate makes.

## Tests

`tests/integration/terms.test.ts` (end to end through the webhook): no terms,
enforcement off, enforcement on, accepted current, accepted old version, new publication
requires re-acceptance, stale callback, duplicate and concurrent accept (exactly one edit
of the tapped message, zero sends, across concurrent taps and a redelivered update), no
re-prompt on later requests or after an application restart, the edit fallback, cross-tenant
isolation, the gate not bypassable by any customer intent or crafted callback, admin
permissions with DENIED audit, audit and outbox rows, immutability in the database,
the HTTP surface and Customer 360. Each key rule was mutation-checked (gate removed,
stale check removed, any-version acceptance, audit on duplicate, publish under the edit
key, flag ignored) and a test failed for each.

Batch 01 item 1 was mutation-checked the same way: the accepted reply without `edit`, the
old main-menu-as-a-new-message answer, "not modified" treated as a refusal, and the stale
answer sent rather than edited — each failed at least one test.
