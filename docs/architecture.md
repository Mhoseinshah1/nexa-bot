# Architecture

## The shape

A **tenant-aware modular monolith**: one repository, one deployable image,
several process roles started from the same image with different entrypoints.
Module boundaries are enforced by tooling, not by convention.

Not microservices. The hardest requirement here is that money operations be
atomic — an order, its item snapshots, its payment legs, its wallet entries, its
audit rows and its outbox events must commit or fail together. In a monolith
that is one transaction. Across services it is a saga with compensations,
machinery that exists to solve a distribution problem this system does not have.
The observed failure modes are I/O failures (panels unreachable, gateways slow,
Telegram rate-limited), and those are isolated by queues, timeouts and adapters,
which work perfectly inside a monolith.

## Process roles

| Role        | Entrypoint                    | Responsibility                                                                    | Exists in Phase 0 |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `api`       | `apps/api/src/main.ts`        | Admin API, Telegram webhook, gateway callbacks                                    | yes               |
| `worker`    | `apps/api/src/main.worker.ts` | Outbox relay; later provisioning, notifications, projections, broadcasts, backups | yes               |
| `scheduler` | —                             | Leader-elected; enqueues jobs, performs no business writes                        | Phase 2           |
| `monitor`   | —                             | Panel health loop with its own cadence and failure profile                        | Phase 3           |

The split matters from day one: a broadcast saturating the event loop must not
be able to take the webhook down with it. Splitting `worker` per queue later is
a config change, not a rewrite.

## Module structure

```
packages/contracts        the frozen specification — depends on nothing
packages/i18n             the shared Persian catalogue — server AND web

apps/api/src/
  modules/
    platform/             tenancy, access, audit, eventing, idempotency, opslog, system
    commerce/             catalog, pricing, promotions, ordering        (Phase 4–5)
    money/                wallet, payments, receipts, refunds           (Phase 5)
    fulfilment/           providers, provisioning, services             (Phase 3, 5–6)
    partner/              resellers                                     (Phase 7)
    insight/              reporting, support, backup                    (Phase 8)
  surfaces/
    telegram/             update handling, conversation, presentation
    web/                  admin API controllers, DTOs
  infrastructure/         config, persistence, redis, logging, crypto, clock, ids
  container.ts            the composition root — the only place adapters are constructed

apps/web/                 React admin shell
```

Only `platform` has content in Phase 0. The other contexts are named here rather
than created as empty directories: a folder with nothing in it is not
architecture, it is a promise.

### Boundary rules

1. **Dependencies point inward.** Domain and application layers declare ports;
   infrastructure implements them. A domain file importing a framework fails
   `pnpm check:boundaries`.
2. **`@nexa/contracts` depends on nothing.** It is the root of the graph and the
   thing every module agrees on.
3. **Surfaces contain no business logic.** Telegram handlers and web controllers
   call application services; they hold no SQL, no business conditionals and no
   customer-facing string literals.
4. **Modules communicate downward by call and upward by event.** Ordering may
   call Pricing; Pricing emits rather than calling Ordering.
5. **Every write path takes a `ScopeContext` and an `ActorContext`** — jobs
   included, acting as `SYSTEM_JOB` with their job id.

Rule 3 is the one that matters most. Every cross-surface inconsistency in the
legacy system has the same root cause: two surfaces each owning their own
version of a shared concept. Four admin roles in one surface and seven in the
other. Thirty-six editable texts in one and 608 in the other. Two definitions of
"buyer" inside one feature. Removing the possibility is a better fix than
resolving the instances.

## The canonical write path

Every business write, from either surface, follows the same seven steps.
`RecordPingService` composes them today so the shape is real and tested before
any business write exists.

```
1. AUTHENTICATE    resolve an ActorContext
2. RESOLVE SCOPE   a TenantContext, or an explicit SystemContext
3. AUTHORIZE       permission checked against the frozen catalog; deny by default
4. VALIDATE        a typed command, parsed at the boundary
5. IDEMPOTENCY     a replayed key returns the first result
6. TRANSACT        domain change + audit row + outbox row, one transaction
7. PROJECT         the relay publishes; consumers notify, log, project, mirror
```

Nothing about this changes between Telegram and Web. That is the whole answer to
"how do the two surfaces share logic": they do not share logic, they are both
clients of it.

## Eventing

**Outbox for events, BullMQ for work.** They solve different problems and
conflating them loses one of the two guarantees.

- The outbox row is written in the same transaction as the state change, so the
  event exists if and only if the change committed.
- The relay claims rows with `FOR UPDATE SKIP LOCKED`, so several relay
  instances are safe.
- Ordering is guaranteed per `(aggregateType, aggregateId)` and nowhere else.
  Nothing in the design needs global ordering.
- Delivery is at-least-once; effects are effectively-once, because each consumer
  records the event ids it has applied in `processed_messages`.
- The relay has no dead-letter queue by design. An event that cannot be
  delivered is a bug to fix, not a message to discard — it retries, and lag
  beyond the configured threshold makes the process unready.

The database is the log. Telegram, webhooks and any future ops channel are
projections of it, never the log itself.

## Consistency

- **Strong** inside one transaction: the change, its audit row, its outbox rows.
- **Eventually consistent** for anything a consumer does: notifications,
  projections, operational logs, mirroring.
- **Externally reconciled** for provider state: a service's panel-side facts
  carry `last_synced_at` and are never authoritative for money. Revenue is a
  commercial fact; service state is an operational fact. The legacy system
  multiplies one by the other, and its "total sales" figure moves by over a
  million Toman in 23 minutes with no new order.

## Tenancy

`tenant_id` is on every business row. A **Tenant** is a commercial boundary; a
**BotInstance** is a Telegram bot. One tenant owns several bot instances, and a
reseller sales bot is its own tenant with a parent.

Isolation is enforced in the repository layer: every tenant-scoped query
resolves its tenant through `requireTenantId`, and work that genuinely has no
tenant passes an explicit `SystemContext` rather than a null. Postgres row-level
security is **not** used — see `docs/adr/0004-tenant-isolation.md` for that
decision, its cost, and what would trigger revisiting it.

## Phase plan

| Phase | Scope                                                                 |
| ----- | --------------------------------------------------------------------- |
| **0** | Foundation and frozen contracts — **this phase**                      |
| 1     | Identity, tenancy, admins, RBAC, Telegram skeleton, web auth          |
| 2     | Templates, settings, feature flags, notifications, operational events |
| 3     | Providers, panels, credentials, health monitoring                     |
| 4     | Catalog and pricing                                                   |
| 5     | Ordering, payments, wallet, provisioning — the riskiest phase         |
| 6     | Service lifecycle and automation                                      |
| 7     | Promotions, referral, resellers                                       |
| 8     | Reporting, support, backup, hardening                                 |

The ordering rule: build what everything else depends on, and build the thing
that is most expensive to retrofit, first.
