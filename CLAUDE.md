# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, React. One codebase, several process roles. Phases 0–4, the deployment
checkpoint, Telegram Backup V1, Web Admin Disaster Recovery, pricing, referral
and resellers are built; TonPays is built and NOT yet accepted against the real
provider. **Every standing owner decision and per-feature rule that used to
open this file is in `docs/project-status.md`, verbatim — it is binding, not
history to skim.**

## Where to look

| For                                                                                                                       | Read                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Phase status, owner decisions, per-feature rules (money, pricing, referral, resellers, panels, backup, recovery, TonPays) | `docs/project-status.md`                                                  |
| Rules to apply while writing code, incl. the domain invariants                                                            | skill `nexa-conventions`, then `docs/conventions.md`                      |
| Finding the files behind a feature                                                                                        | skill `nexa-code-navigation` (`scripts/claude/module-map.sh`, `trace.sh`) |
| Which tests to run; reading their output                                                                                  | skills `nexa-test-selection`, `nexa-log-digest`                           |
| A migration or a schema change                                                                                            | skill `nexa-migrations`                                                   |
| Branch → PR → CI → merge                                                                                                  | skills `nexa-pr-workflow`, `nexa-ci-watch`                                |
| A whole round (agents, review, PR pipeline, report)                                                                       | skill `nexa-round-pipeline`                                               |
| Adding a payment gateway                                                                                                  | skill `nexa-gateway-integration`                                          |
| Ending or resuming a session                                                                                              | skill `nexa-handoff`                                                      |
| The Web Admin                                                                                                             | skill `nexa-web-design`                                                   |
| Deployment, `botctl`, releases                                                                                            | `docs/deployment.md`, ADR-0022                                            |
| Backup and restore                                                                                                        | `docs/backup.md`, ADR-0025, ADR-0028                                      |
| Open owner questions                                                                                                      | `docs/open-questions.md`                                                  |

Never read `apps/api/src/infrastructure/persistence/schema.ts`,
`packages/contracts/src/templates.ts`, the Telegram router
`apps/api/src/surfaces/telegram/bot-runtime.ts` (~2.5k lines) or a flow under
`apps/api/src/surfaces/telegram/runtime/` whole: `grep -n`, then read a range.
`bash scripts/claude/module-map.sh --bot <handler>` names a bot handler's file;
the map and how to add a screen are in `docs/telegram-runtime.md`.

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
                                  main.monitor.ts (panel health monitor),
                                  main.recovery.ts (the destructive restore lane),
                                  main.provisioner.ts (creates services on panels)
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
- Every write path also reads `ScopeActivityReader` **inside its transaction**,
  and refuses a scope that has stopped accepting work. Not in the controller: a
  surface checks activity when the request arrives, and a stop can commit in
  between. Panels was the one module that skipped this, which let a tenant an
  operator had stopped be given new panels and a background monitor.
- Customer-facing text comes from a template key. No string literals in surfaces.
- No fake authentication, no placeholder abstractions, no fabricated actors.

## Commands

```bash
bash scripts/dev-services.sh   # postgres + redis (docker, or native fallback)
pnpm db:migrate:dev && pnpm db:seed:dev   # compiled: pnpm build && pnpm db:migrate
pnpm provision                 # the primary tenant (dev: provision:dev)
pnpm admin:bootstrap           # first owner, from dist (dev: admin:bootstrap:dev)
pnpm backup run|list|verify|restore   # the DR pipeline (dev: backup:dev)
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

Pipe long output through `bash scripts/claude/log-digest.sh`; read CI with
`bash scripts/claude/ci-status.sh <pr>`. GitHub GraphQL is blocked in these
sessions: `gh api repos/...` REST only, never `gh pr …` or `gh run …`.

## Reviewing with agents

Six rules; the incidents behind each are in `nexa-round-pipeline`
(`references/agent-review-lessons.md`), verbatim.

- **A reviewer that mutates code works in its own worktree.** Give each one
  `git worktree add`, or make it read-only.
- **Agents that share PostgreSQL are serialised or given separate databases.**
- **A fix is reviewed as hard as the bug.** Ask: what does this fix now do that
  it did not do before, and in which state is that wrong?
- **A rule with no test is a rule that will be silently reverted.** Revert the
  single rule a test names and watch that test fail.
- **A claim about testing that leaves no test behind is worse than no claim.**
  Commit the probe or do not cite it.
- **Before any commit that follows agent work**, run `git status`, read every
  line of `git diff`, and confirm no reviewer mutation is still in the tree —
  deletions especially.

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
ready. A round prompt that says to push, open a PR and merge on green IS that
approval, for that round's PRs only (`nexa-round-pipeline`).
