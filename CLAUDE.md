# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, React. One codebase, several process roles. (No queue library and no
Telegram framework are installed yet — the webhook is parsed at the boundary
and the notification dispatcher polls Postgres.)

**Phases 0, 1 and 2 are done: foundation, identity and RBAC, then the control
plane** — templates, settings, feature flags, notifications and the operational
log. There are still no product features: no purchases, payments, wallet,
providers, resellers or customer-facing Telegram operations. Do not add them
without an explicit instruction.

Authentication and authorization are real. Every new write path takes a
`ScopeContext` and an `ActorContext` and checks a permission through the guard —
never by inspecting an actor's type, and never by not drawing a button.

Three Phase 2 rules that are easy to break by accident:

- A template body is stored **raw** and rendered nowhere near where it is
  edited. Nothing in this codebase may persist a rendered string.
- A setting is declared in the registry or it does not exist. Unknown keys fail
  closed at the schema, the service and the surface.
- A feature flag is a boolean; its parameters are settings. Neither registry
  grows a field that belongs to the other.

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
pnpm db:migrate:dev && pnpm db:seed:dev   # compiled: pnpm build && pnpm db:migrate
pnpm admin:bootstrap           # create the installation's first owner (CLI only)
pnpm verify                    # typecheck, lint, boundaries, i18n, unit tests, build
pnpm test:integration          # needs the services above
pnpm test:exhaustive           # 1341 notification orderings; nightly in CI, ~4 min
pnpm check:runtime             # dist CLI runs without devDeps; web ships no source maps
```

`pnpm verify` is the gate. If you changed the schema, also run `pnpm db:check`.
`pnpm test:exhaustive` is off the pull-request path on purpose — it is the
search, not the safety net, and every shape it has found has a named regression
in `tests/integration/notification-invariants.test.ts`.

## Reviewing with agents

Two rules, both learned the expensive way on the Phase 2 branch.

**A reviewer that mutates code works in its own worktree.** Falsifiability
review — reverting a production rule to watch a test fail — is the standard
here, and it means reviewers edit source. A reviewer sharing the implementation
checkout twice clobbered real fixes mid-edit, once by silently deleting
`claimDue`'s attempt-count backstop while its author was three files away.
Reviewers never mutate the primary feature worktree; give each one
`git worktree add`, or make it read-only and have it write experiments up for
somebody else to run.

**Agents that share PostgreSQL are serialised or given separate databases.**
The integration suite truncates tables between tests. Two suites against one
database produced 122 false failures that looked exactly like real ones.

**Before any commit that follows agent work**, run `git status`, read every
line of `git diff`, and confirm no reviewer mutation is still in the tree —
deletions especially, because an added line is conspicuous and a removed
predicate is not.

## Git

Work on the session's task branch. **Never push implementation directly to
`main`**, and never force-push anything.

`main` moves only through a pull request that the owner has explicitly approved
after review, with CI green on the exact reviewed head. Phase 1 was merged that
way — reviewed to a clean round, then merged as a merge commit on the owner's
instruction, so the reviewed history stays reachable.

So: normal feature work happens on a branch and reaches `main` through a PR.
Merging one is the owner's call, never a step you take because the work looks
finished. Absent that explicit approval, leave the PR open and say it is
ready.
