# Nexa Bot

A tenant-aware Telegram service-sales and management platform.

Nexa Bot is a from-scratch replacement for MirzaBot, a PHP system whose product
behaviour was reverse-engineered in detail. The research informs the domain
model; the implementation is new. See `docs/research/README.md` for how to read
that evidence, and `docs/adr/` for the decisions taken from it.

## Status: Phase 0 — foundation

Phase 0 delivers the engineering foundation and **no product features**. What
exists today:

- A frozen contracts package: branded ids, `Money`, half-open time periods,
  actor and tenant contexts, the permission catalog, the ledger reason
  vocabulary, the event catalog, the error taxonomy, the metric registry, the
  provider adapter interface, the price quote shape and template keys.
- Tenancy primitives with a repository guard, and a two-tenant isolation suite.
- A transactional outbox with a relay, per-aggregate ordering, at-least-once
  delivery and effectively-once consumer effects.
- Durable idempotency, an append-only audit log, and operational events with
  deduplication.
- Envelope-encrypted secrets, deny-by-default authorization, and the canonical
  seven-step write path composed end to end.
- Health endpoints that distinguish liveness from readiness, a Telegram webhook
  receiver, and a React admin shell that renders live readiness.

What does **not** exist: purchases, orders, payments, wallet, receipts, refunds,
cashback, discounts, pricing, catalog, provider adapters, resellers, broadcasts,
reporting, backups, `botctl`, the installer, and authentication. Those are later
phases; see `docs/architecture.md`.

## Getting started

Requires Node 22 and pnpm 10. PostgreSQL 16 and Redis 7 come from Docker, or
natively if no Docker daemon is available.

```bash
pnpm install
cp .env.example .env
# generate a key-encryption key and paste it into SECRETS_KEK:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

bash scripts/dev-services.sh
pnpm db:migrate
pnpm db:seed
```

Run the processes:

```bash
pnpm --filter @nexa/api start:api      # HTTP API, health, Telegram webhook
pnpm --filter @nexa/api start:worker   # outbox relay
pnpm --filter @nexa/web dev            # admin shell on :5173
```

## Verification

```bash
pnpm verify              # typecheck, lint, boundary checks, i18n, unit tests, build
pnpm test:integration    # against real PostgreSQL and Redis
pnpm db:check            # schema and migrations agree
```

`pnpm check:boundaries` enforces the rules a type system cannot: dependency
direction, money never typed as `number`, no mutable balance column, no empty
catch blocks, no server code in the web bundle, and no identifiers in the
committed research.

## Documentation

| File                      | What it covers                                              |
| ------------------------- | ----------------------------------------------------------- |
| `CLAUDE.md`               | Working notes and the non-negotiables                       |
| `docs/architecture.md`    | Module structure, process roles, the write path, phase plan |
| `docs/conventions.md`     | Every convention, and the failure it prevents               |
| `docs/domain-glossary.md` | The vocabulary, including the boundaries that must not blur |
| `docs/open-questions.md`  | Unresolved product decisions, carried not guessed           |
| `docs/adr/`               | Decisions, with reasons and rejected alternatives           |
| `docs/research/`          | Sanitized reverse-engineering evidence                      |

## Licence

Proprietary. All rights reserved.
