# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform: TypeScript, NestJS, PostgreSQL 16,
Redis, React; one codebase, several process roles. TonPays is built and NOT yet
accepted against the real provider. **Every standing owner decision and
per-feature rule that used to open this file is in `docs/project-status.md`,
verbatim — it is binding, not history to skim.**

## Where to look

| For                                                                                                                       | Read                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Phase status, owner decisions, per-feature rules (money, pricing, referral, resellers, panels, backup, recovery, TonPays) | `docs/project-status.md`                                                  |
| Rules to apply while writing code, incl. the domain invariants                                                            | skill `nexa-conventions`, then `docs/conventions.md`                      |
| Finding the files behind a feature; the layout; files over 800 lines                                                      | skill `nexa-code-navigation` (`scripts/claude/module-map.sh`, `trace.sh`) |
| Which tests to run; reading their output                                                                                  | skills `nexa-test-selection`, `nexa-log-digest`                           |
| A migration or a schema change                                                                                            | skill `nexa-migrations`                                                   |
| Branch → PR → CI → merge                                                                                                  | skills `nexa-pr-workflow`, `nexa-ci-watch`                                |
| A whole round (agents, review, PR pipeline, report)                                                                       | skill `nexa-round-pipeline`                                               |
| Adding a payment gateway                                                                                                  | skill `nexa-gateway-integration`                                          |
| Ending or resuming a session                                                                                              | skill `nexa-handoff`                                                      |
| The Web Admin                                                                                                             | skill `nexa-web-design`                                                   |
| Deployment, `botctl`, releases; backup and restore                                                                        | `docs/deployment.md` (ADR-0022); `docs/backup.md` (ADR-0025, ADR-0028)    |
| Open owner questions                                                                                                      | `docs/open-questions.md`                                                  |

Never read a file over 800 lines whole: `grep -n`, then read a range. The
biggest: `apps/api/src/infrastructure/persistence/schema.ts` (~17k lines),
`packages/contracts/src/templates.ts` (~13.6k), `apps/web/src/i18n/web.fa.ts`
(~11k), the Telegram router `apps/api/src/surfaces/telegram/bot-runtime.ts`
and its flows under `apps/api/src/surfaces/telegram/runtime/`. The full list in
`nexa-code-navigation` is a snapshot; the 800-line rule binds. A bot handler's
file: `bash scripts/claude/module-map.sh --bot <handler>`; `docs/telegram-runtime.md`.

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
- Dependencies point inward (the tree: `nexa-code-navigation` § Layout). Domain
  and application layers declare ports; infrastructure implements them.
  Surfaces call application services and never touch the database. `apps/web`
  may import `@nexa/contracts` and `@nexa/i18n` only.

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
pnpm verify                    # the gate: static, shell, unit, deploy logic, build
pnpm test:integration          # needs the services above
```

`pnpm verify` is the gate; after a schema change also `pnpm db:check`. Run tests
and the gate as `bash scripts/claude/test-summary.sh <command...>`, never reading
raw output; other long output goes through `bash scripts/claude/log-digest.sh`.
Other commands (provisioning, backup, shell, deploy, Docker smoke):
`nexa-test-selection`. CI: `bash scripts/claude/ci-status.sh <pr>`. GraphQL is
blocked here: `gh api repos/...` REST only, never `gh pr …` or `gh run …`.

## Reviewing with agents

Six rules, in full with their incidents in `nexa-round-pipeline`
(`references/agent-review-lessons.md`): a mutating reviewer gets its own
worktree; agents sharing PostgreSQL are serialised or get separate databases; a
fix is reviewed as hard as the bug; every rule has a test that fails when the
rule is reverted; commit the probe or do not cite it; before any commit
that follows agent work, read `git status` and every line of `git diff` for
leftover reviewer mutations — deletions especially.

## Git

Work on the session's task branch. **Never push implementation directly to
`main`**, and never force-push anything. `main` moves only through a PR the
owner has explicitly approved after review, with CI green on the exact reviewed
head. Merging is the owner's call, never a step you take because the work looks
finished: absent that approval, leave the PR open and say it is ready. A round
prompt that says to push, open a PR and merge on green IS that approval, for
that round's PRs only. Full text and procedure: `nexa-pr-workflow`.
