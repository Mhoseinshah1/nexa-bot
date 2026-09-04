# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, React. One codebase, several process roles. (No queue library and no
Telegram framework are installed yet — the webhook is parsed at the boundary
and the notification dispatcher polls Postgres.)

**Phases 0, 1 and 2 are done: foundation, identity and RBAC, then the control
plane** — templates, settings, feature flags, notifications and the operational
log. **Phase 3 is in progress**: 3A gave providers, panels, credentials and
health; 3B added the MHSanaei/3x-ui v3.7.0 adapter; **3C is the current work**
— a dedicated `monitor` process role that keeps panel health up to date on a
schedule. There are still no product features: no purchases, payments, wallet,
resellers or customer-facing Telegram operations, and nothing consumes a panel
yet. Do not add them without an explicit instruction.

**The deployment checkpoint after Phase 2 is done too**: an immutable image,
a production Compose topology behind Caddy, an Ubuntu installer, and `botctl`
with update and rollback (ADR-0022, `docs/deployment.md`). It has never been
run against a real server — `docs/vps-acceptance.md` is the checklist that
decides that. `BLOCKER-SECRETS-V2` is still open and is the next prerequisite
before Phase 3.

Three deployment rules that are easy to break by accident:

- The root `docker-compose.yml` is **development infrastructure**. Production
  is `deploy/`. Never merge the two.
- A release is a **digest**, never a tag. `botctl` resolves a version once and
  addresses the image by digest everywhere afterwards.
- `botctl rollback` never restores the database. The backup predates the
  migration, so restoring it would discard every write made since.

Authentication and authorization are real. Every new write path takes a
`ScopeContext` and an `ActorContext` and checks a permission through the guard —
never by inspecting an actor's type, and never by not drawing a button.

Four Phase 3 rules that are easy to break by accident (ADR-0023):

- A panel credential travels **one way**. The repository projection selects the
  three set-at timestamps and never a ciphertext, so no response builder can
  acquire a value. Never add a masked stand-in either — `********` can be
  resubmitted as the real password.
- A provider type is **code**, not a row, and the adapter is resolved before the
  panel row is written. A panel that cannot be operated must not become a row.
- Health is **latest state only**, and `DISABLED` and `UNCHECKED` are projected
  rather than stored. A probe result changes health and nothing else — never a
  status, never a credential.
- Private addresses are **deliberately reachable**; only destinations that are
  never a panel are refused. Redirects are never followed and the socket is
  pinned to a pre-validated address, which is why that code is on `node:http`
  rather than `fetch`.

Four more from Phase 3C:

- There is **one probe implementation**, `panels/application/probe-core.ts`.
  The operator's connection test and the background monitor are two wrappers
  over it. Never copy it; the copy that would silently keep the old behaviour
  is the unattended one that dials panels on a timer.
- The monitor probes **ACTIVE panels only**, and the rule is enforced in the
  discovery query and again in the core. `DISABLED` means the operator said
  stop using this for now.
- Background work takes the SAME tenant probe budget with a **reserve floor**,
  never a second bucket. A second bucket would raise a tenant's total outbound
  rate, which is the bound's whole purpose.
- Nothing about a probe is decided in a process. The per-panel claim and the
  budget are conditional writes; **two monitor replicas are the normal case**,
  briefly, on every rolling update.

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
                     entrypoints: main.ts (api), main.worker.ts (worker),
                                  main.monitor.ts (panel health monitor)
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
pnpm provision                 # the primary tenant (dev: provision:dev)
pnpm admin:bootstrap           # first owner, from dist (dev: admin:bootstrap:dev)
pnpm verify                    # the gate: static, shell, unit, deploy logic, build
pnpm test:integration          # needs the services above
pnpm test:exhaustive           # 1341 notification orderings, ~4 min; nightly in CI
pnpm check:runtime             # dist CLI runs without devDeps; web ships no source maps
pnpm check:shell               # shellcheck; deploy/ at info, scripts/ at warning
pnpm test:deploy               # botctl update/rollback logic against a fake docker
```

With a Docker daemon (the Ubuntu CI job; cloud sessions usually have no
registry egress for base images):

```bash
bash scripts/deployment-smoke.sh          # build, up, migrate, serve, back up
bash scripts/deployment-update-smoke.sh   # A -> B -> failed health -> rollback
```

`pnpm verify` is the gate. If you changed the schema, also run `pnpm db:check`.
`pnpm test:exhaustive` is off the pull-request path on purpose — it is the
search, not the safety net, and every shape it has found has a named regression
in `tests/integration/notification-invariants.test.ts`.

## Reviewing with agents

Five rules. The first two were learned the expensive way on the Phase 2 branch;
the last three on the deployment branch, where four review rounds each found
their defect inside the fix written for the round before.

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

**A fix is reviewed as hard as the bug.** On the deployment branch the
readiness parser was rewritten three times, and the first two rewrites each
INVERTED the behaviour they were written to protect — the second preferred a
dead container over a healthy one, the third preferred a running one-off
reporting `starting` over the healthy container beside it. Three separate fixes
told the operator to run a command that could not work, each introduced by the
commit that removed the previous one. Reviewing a diff for "does it fix the
bug" catches none of this. Ask instead: what does this fix now do that it did
not do before, and in which state is that wrong?

**A rule with no test is a rule that will be silently reverted.** Five
production rules changed in one commit there had no test at all, so the suite
could not distinguish three successive versions of the same function — every
inversion above passed a green suite. Mutation is the only check that finds
this: revert the single rule a test names and watch that test fail. A test that
stays green under mutation is not a test.

**A claim about testing that leaves no test behind is worse than no claim.** A
commit message on that branch cited eleven parser shapes and twelve guard
probes. Both sets had been run and thrown away, so the next reader believed a
coverage that did not exist. Commit the probe or do not cite it.

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
