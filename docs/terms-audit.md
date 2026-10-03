# Terms and rules (program §6)

A tenant's terms and rules are a sequence of versions, enforced at the one central
Telegram gate. This note records the decisions and where each rule is tested.

## Model

- `terms_versions`: at most one `DRAFT` per tenant (partial unique index), edited in
  place with a `revision` every edit and the publication name. Publishing is a
  conditional UPDATE from `DRAFT` at that revision, giving the next `version_number` in
  the same statement. A `PUBLISHED` row is immutable: `0166_terms_guards.sql` refuses
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
existing features write (`features.edit`); the terms page draws the switch only for an
actor who holds that key, and asks before turning it on.

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
announced (`CustomerTermsAccepted`). After acceptance the customer gets the main menu;
what they first asked for is never replayed.

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
requires re-acceptance, stale callback, duplicate and concurrent accept, cross-tenant
isolation, the gate not bypassable by any customer intent or crafted callback, admin
permissions with DENIED audit, audit and outbox rows, immutability in the database,
the HTTP surface and Customer 360. Each key rule was mutation-checked (gate removed,
stale check removed, any-version acceptance, audit on duplicate, publish under the edit
key, flag ignored) and a test failed for each.
