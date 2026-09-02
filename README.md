# Nexa Bot

A tenant-aware Telegram service-sales and management platform.

Nexa Bot is a from-scratch replacement for MirzaBot, a PHP system whose product
behaviour was reverse-engineered in detail. The research informs the domain
model; the implementation is new. See `docs/research/README.md` for how to read
that evidence, and `docs/adr/` for the decisions taken from it.

## Status: Phases 0, 1 and 2 — foundation, identity, control plane

There are still **no product features**. Nothing here sells, charges, provisions
or delivers anything to a customer.

**Phase 0 — foundation.** A frozen contracts package: branded ids, `Money`,
half-open time periods, actor and tenant contexts, the permission catalog, the
ledger reason vocabulary, the event catalog, the error taxonomy, the metric
registry, the provider adapter interface, the price quote shape and template
keys. Tenancy primitives with a repository guard and a two-tenant isolation
suite. A transactional outbox with a relay, per-aggregate ordering,
at-least-once delivery and effectively-once consumer effects. Durable
idempotency, an append-only audit log, and operational events with
deduplication. Envelope-encrypted secrets and the canonical seven-step write
path composed end to end. Health endpoints that distinguish liveness from
readiness, a Telegram webhook receiver, and a React admin shell.

**Phase 1 — identity and authorization.** Authentication and authorization are
real. Web Admin sign-in with argon2id password hashing, server-side sessions,
login throttling and session revocation on credential rotation. Roles,
per-admin permission overrides and a deny-by-default permission guard that
resolves authority on every call rather than caching it into a session.
Administrator management — create, disable, re-enable, change roles, rotate
credentials — with the authoritative permission check inside the mutation
transaction. `pnpm admin:bootstrap` creates an installation's first owner from
the command line, running compiled output (`admin:bootstrap:dev` runs the
source); there is no self-service registration.

**Phase 2 — the control plane.** Message templates stored **raw** and rendered
nowhere near where they are edited, with an append-only revision history and a
revert that removes the override rather than copying today's default. A settings
registry where a key is declared or it does not exist, and unknown keys fail
closed at the schema, the service and the surface. Feature flags as booleans
whose parameters are settings, with confirmation proportional to blast radius.
Operational events projected into notifications, delivered by a dispatcher with
leases, bounded attempts, rate limiting and redacted failure evidence. A read
model over the operational log. Web Admin screens for all of it, with optimistic
concurrency and idempotent writes.

What does **not** exist: purchases, orders, payments, wallet, receipts, refunds,
cashback, discounts, pricing, catalog, provider and panel adapters, resellers,
broadcasts, reporting and backups.

**This is not deployable yet.** There is no Dockerfile, no reverse-proxy or TLS
topology, no release wiring, no `botctl` and no installer. That is the
Deployment MVP checkpoint, which comes before Phase 3 — see
`docs/open-questions.md`. A second prerequisite is recorded there too: the
secret envelope is v1, and binding ciphertext to its context plus a practical
multi-key rotation path must land before Phase 3 introduces provider
credentials.

## Getting started

Requires Node 22 and pnpm 10. PostgreSQL 16 and Redis 7 come from Docker, or
natively if no Docker daemon is available.

```bash
pnpm install
cp .env.example .env
# generate a key-encryption key and paste it into SECRETS_KEK:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

bash scripts/dev-services.sh
pnpm db:migrate:dev
pnpm db:seed:dev
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
