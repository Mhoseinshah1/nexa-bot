# Conventions

Every rule here maps to a documented failure in the legacy system. Where a check
enforces the rule, it is named. Where nothing enforces it yet, that is said
plainly.

## Money

**Rule.** `Money` is `bigint` minor units plus an explicit `CurrencyCode`. Never
a float, never a bare number, never an amount without a currency. Arithmetic
across currencies throws.

**Why.** The legacy system has no currency selector on any of eleven gateways,
no exchange-rate field anywhere, and Toman implicit throughout. One card-to-card
template says تومان where its twin says ریال for the same `{price}` token,
because the unit was typed into the copy.

**Enforced by.** `check-boundaries.sh` rejects a monetary field typed as
`number`; the `Money` constructor rejects fractional and unsafe integers;
`formatMoney` is the only renderer, so a unit cannot be hand-typed into a
template.

---

## Rate snapshots

**Rule.** A native-currency amount is plain `Money` and carries no rate
snapshot. A rate snapshot is mandatory **only** for an amount derived through FX
or crypto conversion — above all a payment or gateway quote. That snapshot is
immutable and retained for the life of the record.

**Why.** A converted quote must always be able to show the rate it was quoted
at. Attaching a snapshot to every price instead would be noise on the majority
of rows that never went through a conversion.

**Enforced by.** Nothing yet — no priced tables exist. `ConvertedMoney` in
`@nexa/contracts` is the shape they must use.

---

## Ledger, not balance

**Rule.** Wallet balance is derived from an append-only ledger. Entries carry a
positive amount, an explicit direction, a reason from the frozen vocabulary, a
mandatory reference and an idempotency key. A reversal is a new entry
referencing the original, never an edit. **Never add a balance column.**

**Why.** A mutable balance column cannot be audited after the fact: when it
disagrees with reality, the information needed to explain the disagreement no
longer exists. The legacy system has an unexplained 916,550 residual in one
user's own report, a top-up total that adds an admin debit, and a total smaller
than one of its own parts.

**Enforced by.** `check-boundaries.sh` rejects a migration adding a balance
column; an integration test asserts no such column exists in the current schema.

---

## Time

**Rule.** Every timestamp is `timestamptz`, stored UTC, produced by the `Clock`
port. Reporting intervals are half-open `[start, end)`. Display timezone and
calendar live on the tenant; Jalali dates and Persian numerals are presentation.
No module computes its own date range.

**Why.** The legacy system has three distinct date-boundary defects — a
previous-month range that drops its own final day, comparison presets that
overlap by a day, and custom ranges that stop at 23:59:00 — all from
closed-interval arithmetic done independently in different places.

**Enforced by.** `check-boundaries.sh` and an ESLint rule reject `new Date()`
and `Date.now()` in domain and application code; an integration test asserts
every timestamp column carries a time zone.

---

## Identity

**Rule.** Primary keys are UUIDv7 generated in the application, so the id exists
before the INSERT and can be written into an outbox row in the same batch.
External ids (Telegram user id, panel id) are separate columns, never primary
keys. Telegram interactive callbacks carry a short opaque `callback_ref`
resolved through a registry row.

**Why.** `callback_data` is capped at 64 bytes; a 36-character UUID leaves 28
for the route, and Persian flow names are multi-byte. Separately, the service
username the legacy system generates embeds identifying information — ours is
opaque.

**Enforced by.** `IdGenerator.callbackRef()` and `callbackRefSchema`, with unit
tests for length, alphabet and uniqueness. The **registry table does not exist
yet**: it was created in migration 0000 with nothing reading or writing it and
dropped again in 0002, because a table nothing touches is exactly the
placeholder infrastructure this project avoids. It lands with the conversation
state machine in Phase 1, when something writes a row.

---

## Events, audit and operational events are three different things

**Rule.**

- **Domain event** (`outbox_messages`): a state change, written in the business
  transaction, relayed to consumers.
- **Audit log** (`audit_logs`): who changed what, with `before` and `after`
  **values** and a machine `action` code. Denials are audited too. Append-only.
- **Operational event** (`operational_events`): what the system did, with a
  severity, a dedupe key, an occurrence counter and an explicit recovery event.

Merging them loses the ability to answer "who did this and what changed".

**Why.** The legacy ops log is 38 hand-written message templates with no event
ids, no correlation, no dedupe and no recovery — 60 identical TLS errors in one
day with no way to suppress or resolve them. Its `/admin/logs` has an actor and
a free-text Persian sentence but no entity type and no before/after: an activity
feed, not an audit trail.

**Enforced by.** Database triggers refuse UPDATE and DELETE on `audit_logs`;
`operational_events` may accumulate occurrences but not change identity, and its
counter may not decrease; `outbox_messages` content is immutable while delivery
bookkeeping stays writable. Integration tests assert all of it.

---

## Correlation

**Rule.** One correlation id per business transaction, end to end. It is a
**column** on outbox messages and audit rows, not only an ambient value, so the
chain survives the queue boundary.

**Enforced by.** An integration test follows one id from an HTTP request through
the transaction, the relay and into the consumer's projection.

---

## Idempotency

**Rule.** Every state-changing command takes an idempotency key. A replay
returns the first result. A key reused with a **different** payload is rejected,
not treated as a replay.

**Why.** Telegram retries webhooks, queues redeliver, gateways double-post. The
legacy system has no idempotency, no payment record and no dedupe anywhere, so a
duplicate callback there is indistinguishable from a second purchase.

**Enforced by.** A unique index on `(scope_ref, key)`, where `scope_ref` carries
both the scope and the namespace; integration tests for replay, payload
mismatch, per-tenant scoping and per-surface scoping.

---

## Snapshots over references

**Rule.** Anything that will appear in a historical report is **copied** at
transaction time, never joined by current id: product name, panel, duration,
unit price, the full price quote trace.

**Why.** Legacy historical product statistics resolve by current reference.
Deleted products collapse into a literal "محصول حذف‌شده" bucket, and renaming a
product rewrites history.

---

## Text

**Rule.** Customer-facing strings are addressed by stable dotted keys and stored
**raw**, never rendered, with declared placeholder tokens. Money is rendered by
the single formatter, never interpolated as a bare number. The shared catalogue
lives in `@nexa/i18n` and serves both surfaces; surface-only chrome is
namespaced (`web.*`) and checked by the same script.

**Why.** In the legacy system the Persian caption _is_ the identifier, so
renaming a button renames its key. The template editor echoes the **rendered**
string — `{first_name}` resolves in the viewing admin's own context — so the raw
template cannot be read back from the edit screen, and saving from that view
would bake the editor's own name into the template. That last consequence is a
hazard rather than a recorded event: the investigation deliberately never sent a
character to the bot (TBR-TXT-004; `bot-text-management-knowledge/incidents.md`).
The corruption that _did_ happen is INCIDENT-FIN-001, where a typed menu label
was swallowed by a value-capture prompt and overwrote a production tutorial text.
Placeholders are unvalidated and overloaded: `{time}` means both "now" and
"service duration".

**Enforced by.** `check-i18n-keys.mjs` fails on a missing key, an undeclared
token, a hard-coded Persian string in **either** surface, or a `web.*` key
nothing renders any more. `validateTemplateBody` in `@nexa/contracts` refuses a
body that uses an undeclared token, drops a required one, or repeats a
single-use one; the web editor, the service and the tests all call that one
function, so they cannot disagree about what is valid.

---

## Settings are readable

**Rule.** Any setting surface must be able to return its current value, its
resolved source, and what `0` or empty means. No write-only setters.

**Why.** About fifteen legacy settings screens never echo their stored value —
"the only way to read a price is to overwrite it". Combined with a prompt that
captures the next message whatever it is, this is exactly how a production
gateway setting was overwritten by an ordinary chat message.

**Enforced by.** The settings registry (`@nexa/contracts`), where declaring what
`0` or empty means is a required field rather than a comment, and
`SettingsService`, whose every read returns the value, its resolved source and
that declaration. Asserted over HTTP in `tests/integration/control-plane-http`.
There is no write-to-read path anywhere in the module.

---

## Destructive and bulk operations

**Rule.** Dry run → affected count → explicit confirmation proportional to blast
radius → audited execution → recorded result. No fire-on-press bulk actions,
ever. Corrections are new ledger entries, never edits.

**Why.** The legacy mass wallet top-up credits every account in scope and never
states how many were affected; its cancel button cancels the broadcast but not
the money. A single "optimisation" button deletes six order classes with no
count, no dry run, no undo and no record of prior runs. The whole-bot kill
switch is rendered identically to the dice toggle.

**Enforced by.** Partially, and only where something destructive exists yet. A
feature flag declares its blast radius, and a `TENANT_WIDE` one is refused
unless the caller types the flag's own key and gives a reason — which the audit
row then carries. The web admin draws such a flag differently from a local one,
because the legacy capability screen renders the whole-bot kill switch
identically to the dice toggle.

No bulk operation exists yet, so the dry-run and counted-preview steps have
nothing to apply to. See `docs/adr/0010-destructive-operations.md`.

---

## Never report success for a write that did not happen

**Rule.** A service returns the persisted result. A no-op says so. Empty catch
blocks fail the build.

**Why.** Three unrelated legacy subsystems report success for operations that
changed nothing — re-adding an existing admin, a settings write, a panel
creation against an unreachable host. It is a cultural pattern there, which
makes it a review responsibility here.

**Enforced by.** `check-boundaries.sh` and the ESLint `no-empty` rule. From
Phase 2 the control-plane write responses also carry `changed`, so a save that
landed on the value already stored says so instead of answering "saved" — a
response that cannot express "nothing changed" cannot comply with this rule
however carefully the service works it out.

---

## Secrets

**Rule.** Stored credentials are envelope-encrypted with a data key wrapped by a
key-encryption key held outside the database. The `keyId` travels with the
ciphertext so keys rotate. Masking is computed server-side. No API response ever
contains a credential, and credentials are never entered through Telegram.

**Why.** The legacy panel detail page renders a masked field followed by the
real stored secret in the DOM. Panel tokens are typed as plain chat messages,
which puts them in Telegram's message history, the bot's update log and every
backup of both.

**Enforced by.** Unit tests for round-trip, wrong key, tampering and masking; an
integration test asserts the repository read model never carries the plaintext.

**One redactor, used everywhere.** `apps/api/src/infrastructure/redaction.ts` is
the single implementation, shared by the logger, the audit log and the
operational log. It traverses arrays as well as objects, bounds its recursion,
survives a cyclic value, and **fails closed on a key it cannot read** — a
homoglyph or a non-Latin key is redacted rather than passed through, because a
false positive costs a log line and a false negative costs a secret. Two
divergent implementations existed before, and both had holes.

---

## Authorization

**Rule.** Deny by default, for every actor type, with no exceptions. A
permission that is not granted is denied; an unknown permission is denied.
Background work holds an explicit `SYSTEM_JOB_PERMISSIONS` set from the frozen
contract — it does not skip the check.

**Why.** The guard originally returned early for `SYSTEM_JOB`, on the reasoning
that jobs are our own code and therefore trusted. That reasoning fails the
moment anything else can construct such an actor, and something did: an HTTP
controller built one for an anonymous caller, which handed every permission in
the catalog to the internet. "Trusted by construction" is a claim about the
whole codebase, and it is not one a guard can verify.

**Enforced by.** Unit tests assert that background work is denied a permission
outside its grant, that the grant is narrow, and that the resolver is not
consulted for it; an integration test asserts the denial is recorded.

---

## Idempotency keys are namespaced per surface

**Rule.** A key is unique within `(scope, surface)`, never within scope alone.

**Why.** Both the HTTP surface and the Telegram webhook run under a system
scope. Sharing one namespace meant an unauthenticated caller could pre-claim
`telegram:update:<n>` — guessable, because Telegram's update ids are sequential
— and either make the real update look like a replay or wedge the webhook into
an endless retry with a payload mismatch.

**Still open:** update ids are unique _per bot_, not globally. Once more than
one bot instance exists, the webhook's key must include the bot instance id.
Tracked for Phase 1.

---

## Migrations

**Rule.** Checked-in SQL, generated from the schema, reviewed like code, and
forward-only. An applied migration is never edited. A destructive change is
expand/contract across two releases. `drizzle-kit push` is banned outside a
throwaway local database.

**Enforced by.** `pnpm db:check` fails if the schema and migrations disagree.
