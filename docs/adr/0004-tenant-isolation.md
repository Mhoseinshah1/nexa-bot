# ADR-0004 — Application-level tenant scoping, without row-level security

**Status:** Accepted. **Deviates from the architecture review's ADR-004, which
is marked ACCEPTED.** The deviation was raised explicitly with the owner and
chosen deliberately.

## Decision

`tenant_id` is `NOT NULL` on every tenant-owned row and leads every composite
index. Every tenant-scoped query resolves its tenant through
`requireTenantId(scope)` in the repository layer. Work that genuinely has no
tenant passes an explicit `SystemContext` carrying a reason, never a null.

Postgres row-level security is **not** enabled.

## What the review said

The architecture review requires `tenant_id` enforced by **RLS and** a
repository guard, from day one, and names RLS as the backstop against a missed
tenant predicate: "every query carries a tenant predicate; a missed one is a
data leak."

That reasoning is sound. It was put to the owner alongside the alternative, with
the cost of each stated, and the owner chose application-level scoping.

## Why the choice is defensible here

The deployment model is **one install per customer**. A tenant-scoping bug
therefore leaks data between tenants belonging to _the same customer_ — a
customer's own primary tenant and its own reseller sales bots — not between
unrelated companies sharing a database. That is a real bug, and a much smaller
blast radius than the multi-tenant SaaS case the review's reasoning assumes.

## What it costs

The expensive part of retrofitting RLS is not writing policies. It is that RLS
requires **every tenant-scoped read to run inside a transaction that has set
`app.current_tenant_id`**. Adopting that now costs one helper. Adopting it after
several phases means finding every non-transactional read and proving none was
missed.

We pay some of that cost forward:

- `DrizzleUnitOfWork.withTenant(tenant, fn)` already has the shape RLS needs — a
  transaction with the tenant bound for its whole duration. Enabling RLS becomes
  a migration plus one `SET LOCAL` inside that method, not a sweep.
- The seed creates **two** tenants and a reseller sub-tenant. A cross-tenant test
  with one tenant seeded proves nothing.
- `tests/integration/tenant-isolation.test.ts` asserts, per repository method,
  that tenant B sees none of tenant A's rows, that another tenant's bot token
  cannot be resolved, and that a tenant-scoped read attempted under the system
  scope throws rather than returning everything.

Those tests are doing the job RLS would otherwise do, which makes them
load-bearing rather than incidental. Deleting or weakening one is a security
change.

## Revisit when

- The product moves to a shared multi-tenant deployment, or
- a tenant-scoping defect reaches any environment, or
- the repository surface grows past the point where the generated isolation
  suite can cover every method.

At that point: add the three database roles (`nexa_migrator`, `nexa_app`,
`nexa_system`), add `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`
policies, and set the variable inside `withTenant`. Decide at the same time how
the relay and workers run — an explicit system role, not a casual `BYPASSRLS`,
or RLS becomes decorative.
