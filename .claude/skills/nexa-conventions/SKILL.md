---
name: nexa-conventions
description: The load-bearing rules for writing code in this repository — money, time, tenancy, events, audit, idempotency, text and secrets. Read before adding a table, a service, a handler or a migration, and before changing anything in packages/contracts.
---

# Nexa Bot conventions

Every rule below maps to a documented failure in the legacy system this project
replaces. `docs/conventions.md` has the full reasoning and the evidence; this is
the version to apply while writing code.

## Money

- `Money` is `{ amountMinor: bigint; currency: CurrencyCode }`. Never `number`,
  never a float, never an amount without a currency.
- Arithmetic across currencies throws. Do not add a coercion.
- **Never add a `balance` column.** Balance is derived from an append-only
  ledger. `check-boundaries.sh` fails a migration that adds one.
- A native amount carries no rate snapshot. A rate snapshot is required **only**
  for an amount derived through FX or crypto conversion — use `ConvertedMoney`.
- Render money through `formatMoney` from `@nexa/i18n`. Never interpolate a bare
  number and type a currency unit into a template.

## Time

- Every timestamp is `timestamptz`, UTC, from the injected `Clock` port.
- `new Date()` and `Date.now()` are banned in domain and application code, by
  lint and by the boundary check.
- Reporting intervals are half-open `[start, end)`. Never compute a date range
  ad hoc — that is the `TimePeriodResolver`'s job.

## Tenancy

- Every tenant-owned table has `tenant_id uuid NOT NULL`, and composite indexes
  lead with it.
- Tenant-scoped repository methods call `requireTenantId(scope)`. Work with no
  tenant passes an explicit `SystemContext` with a reason — never a null.
- A **Tenant** is not a **BotInstance**. One tenant owns several bot instances;
  a reseller sales bot is a tenant with a parent.

## The write path

Every state-changing operation follows all seven steps, in order. Copy
`RecordPingService` rather than inventing a variant.

1. Authenticate — the caller supplies an `ActorContext`.
2. Resolve scope — `TenantContext` or explicit `SystemContext`.
3. Authorize — `guard.check(scope, actor, permission)`. Deny by default. Audit
   the denial before rethrowing.
4. Validate — parse into a typed command with zod at the boundary.
5. Idempotency — look the key up; return the first result on a replay.
6. Transact — domain change, audit row and outbox rows in **one** transaction.
7. Project — the relay publishes; consumers do the rest.

## Events, audit and operational events

Three different things. Do not merge them.

- **Domain event** → `outbox_messages`, written inside the business transaction.
  The event type must already be in the catalog; adding one is a contract change.
- **Audit** → who changed what, `before`/`after` as **values**, machine `action`
  code, and `result` including `DENIED`.
- **Operational event** → what the system did: code, severity, dedupe key,
  occurrence counter, and an explicit recovery event when a condition clears.

The database is the log. Telegram is a projection of it.

## Idempotency

Every state-changing command takes a key. A replay returns the first result. A
key reused with a **different** payload is rejected — that is a caller bug, and
returning the stale result would hide it.

## Text

- Customer-facing strings come from a template key in `@nexa/contracts`, with a
  Persian string in `@nexa/i18n`. **No string literals in surfaces**, checked by
  `pnpm check:i18n`.
- Templates are stored raw, never rendered. Placeholders are declared per key.
- Web-only chrome is namespaced `web.*` in `apps/web/src/i18n/`.

## Secrets

- Stored credentials use `SecretCipher` (envelope encryption, `keyId` on the
  ciphertext). No API response ever contains a credential.
- Redact before writing to an audit row or a log line — both do it, do not
  bypass them.

## Never

- Report success for a write that changed nothing.
- Write `catch {}` — the build fails.
- Add a bulk or destructive operation without dry run, counted preview,
  proportional confirmation, audit and a recorded result.
- Resolve an item marked `UNKNOWN` in `docs/research/` by guessing. Add it to
  `docs/open-questions.md`.
- Read `NOT_EXPOSED` in the research as "this does not exist". It means the UI
  did not show it.

## Before you finish

```bash
pnpm verify              # typecheck, lint, boundaries, i18n, unit tests, build
pnpm test:integration    # needs postgres and redis
pnpm db:check            # only if you touched the schema
```
