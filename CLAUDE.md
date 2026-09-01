# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, BullMQ, grammY, React. One codebase, several process roles.

**Phase 0 is the foundation only.** There are no product features yet: no
purchases, payments, wallet, providers, resellers or production Telegram
operations. Do not add them without an explicit instruction.

## Before you change anything

- `packages/contracts` is the **frozen specification**. Adding a state, event,
  permission, ledger reason, metric or template key is a contract change:
  make it its own commit, and say why in the message. Never fold one into a
  feature change.
- Read `docs/conventions.md`. Every rule there maps to a documented failure in
  the legacy system, and the boundary checks enforce most of them.
- `docs/research/` is **evidence, not specification**. `NOT_EXPOSED` means "the
  UI did not show it", never "it does not exist". Never resolve an `UNKNOWN` by
  guessing — add it to `docs/open-questions.md` instead.

## Layout

```
packages/contracts   frozen spec: types, schemas, catalogs, ports. Depends on nothing.
packages/i18n        the shared Persian catalogue, used by BOTH server and web
apps/api             src/modules/<context>/{domain,application,infrastructure}
                     src/surfaces/{telegram,web}   src/infrastructure/  (adapters)
                     entrypoints: main.ts (api), main.worker.ts (worker)
apps/web             React admin shell; may import @nexa/contracts and @nexa/i18n only
```

Dependencies point inward. Domain and application layers declare ports;
infrastructure implements them. Surfaces call application services and never
touch the database.

## Non-negotiables

- Money is `bigint` minor units plus an explicit currency. Never a float, never
  a bare number, never an amount without a currency.
- Balance is derived from an append-only ledger. **Never add a balance column.**
- Every timestamp is `timestamptz` in UTC, from the `Clock` port. Reporting
  intervals are half-open `[start, end)`.
- Every state-changing command takes an idempotency key.
- Domain events go to the outbox **inside the business transaction**.
- Every write path takes a `ScopeContext` and an `ActorContext`; jobs act as
  `SYSTEM_JOB`. Deny by default.
- Customer-facing text comes from a template key. No string literals in surfaces.
- No fake authentication, no placeholder abstractions, no fabricated actors.

## Commands

```bash
bash scripts/dev-services.sh   # postgres + redis (docker, or native fallback)
pnpm db:migrate && pnpm db:seed
pnpm verify                    # typecheck, lint, boundaries, i18n, unit tests, build
pnpm test:integration          # needs the services above
```

`pnpm verify` is the gate. If you changed the schema, also run `pnpm db:check`.

## Git

Work on the session's task branch. Never push to `main`, never merge to `main`,
never force-push.
