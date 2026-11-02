---
name: nexa-conventions
description: The load-bearing rules for writing code in this repository — money, time, tenancy, events, audit, idempotency, text, secrets, and the domain invariants (gateway inquiry, refunds, UNKNOWN, pricing, resellers, capacity, import silence). Read before adding a table, service, handler or migration, and before changing packages/contracts.
---

# Nexa Bot conventions

Reasoning: `docs/conventions.md`. Read
`references/conventions-detail.md` for the full wording of the sections below,
and `references/domain-invariants.md` (your area, before writing code there).

## Money

- `Money` is `{ amountMinor: bigint; currency: CurrencyCode }`. Never `number`,
  never a float, never an amount without a currency. Cross-currency arithmetic
  throws.
- **Never add a `balance` column.** Balance is derived from an append-only
  ledger; `check-boundaries.sh` rejects one.
- A rate snapshot is required **only** for FX or crypto-derived amounts
  (`ConvertedMoney`).
- Render money with `formatMoney` (`@nexa/i18n`), never a bare number.

## Time

- Every timestamp is `timestamptz`, UTC, from the injected `Clock` port.
  `new Date()` / `Date.now()` are banned in domain and application code.
- Reporting intervals are half-open `[start, end)` (`TimePeriodResolver`).

## Tenancy

- Every tenant-owned table has `tenant_id uuid NOT NULL`, composite indexes
  lead with it. Tenant-scoped repository methods call `requireTenantId(scope)`;
  no tenant means an explicit `SystemContext` with a reason, never a null.
- A **Tenant** is not a **BotInstance**: a tenant owns several; a reseller
  sales bot is a tenant with a parent.

## The write path

In order (copy `RecordPingService`): authenticate (`ActorContext`)
→ resolve scope (`TenantContext` / explicit `SystemContext`) → authorize
(`guard.check(scope, actor, permission)`; deny by default for **every** actor
type incl. `SYSTEM_JOB`; no actor-type bypass; audit the denial) → validate
(zod) → idempotency key (replay returns the first result) → transact (domain
change, audit row, outbox rows in **one** transaction) → project.

## Events, audit, idempotency

- Domain event → `outbox_messages` inside the business transaction, type
  already in the catalog (a new one is a contract change). Audit → who,
  `before`/`after` values, `action`, `result` (incl. `DENIED`). Operational event
  → code, severity, dedupe key, counter, recovery event. Never merge the three.
- Every state-changing command takes an idempotency key namespaced by the
  acting surface; a **different** payload on a reused key is rejected; never
  widen a namespace.

## Text and secrets

- Customer-facing strings come from a template key in `@nexa/contracts` with a
  Persian string in `@nexa/i18n`; **no string literals in surfaces**
  (`pnpm check:i18n`). Templates are stored raw; web chrome is `web.*`.
- Credentials use `SecretCipher`; no API response contains one. Redact before
  writing anything durable via `infrastructure/redaction.ts` (the only
  implementation; no bypass).

## Domain invariants (most often broken by a refactor)

- **Only the inquiry decides** a gateway payment; a webhook is a hint; the
  deadline is checked under the payment's lock.
- **A create whose answer was lost is never retried and never re-keyed**;
  **UNKNOWN is never refunded** — a READ decides first.
- An order has **two terminal outcomes and no third**: FULFILLED or REFUNDED,
  via the **one credit path**, `RefundService.refundUndeliverable`. A
  **wallet purchase is refused, never refunded**.
- **One pricing boundary**, `PricingService.price`; a quote is **honoured, never
  re-priced**. Cashback and commission are earned once, at delivery.
- **There is no reseller credit**; a negative wallet blocks every purchase.
- **Every state change is a conditional UPDATE naming its `from` states.**
  There is no `setState`.
- A capacity slot is a **RESERVATION ROW**, not a count; one eligibility
  evaluator, four callers.
- A panel credential travels **one way**; never a masked stand-in.
- A customer is told a fact through the **notification lane**, never a string.
- An operational-event CODE is part of the schema: never rename or split it.
- **Import silence:** imported subjects are never notified for state that
  existed at import; the first figure observed after import is silent, only a
  later change is news. No customer message from a migration, an import or a
  backfill. The operations log is silent only for records the import itself
  created (provenance of the record a log is ABOUT, never the customer's).

Gateways: `nexa-gateway-integration`.

## Never

- Report success for a no-op write, or write `catch {}`.
- Add a bulk or destructive operation without dry run, counted preview,
  proportional confirmation, audit and a recorded result.
- Resolve an `UNKNOWN` in `docs/research/` by guessing (use
  `docs/open-questions.md`); read `NOT_EXPOSED` as "does not exist".

## Before you finish

```bash
pnpm verify
pnpm test:integration  # needs postgres and redis
pnpm db:check          # if the schema changed
```
