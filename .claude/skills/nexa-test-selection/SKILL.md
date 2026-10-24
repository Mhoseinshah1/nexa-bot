---
name: nexa-test-selection
description: Which NEXA tests to run for a given change — targeted unit/web/integration suites while iterating, the guard suites money, migration, security and legacy-import changes always keep, and the full gate before a PR is ready or a release is cut. Use before running tests, when a suite is slow, or when deciding whether `pnpm verify` / `pnpm test:integration` is needed yet.
---

# Choosing tests in NEXA

The full suite is large (~350 unit files, ~130 web, ~280 integration across
four CI shards; `pnpm test:exhaustive` alone is ~4 min). Running all of it on
every edit wastes time and context; running too little is how a rule gets
silently reverted. This skill decides _when_ each layer runs. It never decides
that a test may be skipped, deleted, weakened or marked `.skip`/`.todo` — that
is not allowed here, for any reason, including a red CI.

## Step 1 — ask the selector

```bash
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh            # vs origin/main
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh --base <ref>
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh --files <path>...
```

It prints commands and runs nothing. It selects: changed test files; tests
that import a changed source file by path (one hop, extensionless or `.js`);
the whole project when a shared helper under `tests/` changes; and the
standing guard suites for the change's risk class. An unresolvable `--base` is
an error (exit 2), never "no changes". Its own check:
`bash .claude/skills/nexa-test-selection/scripts/select-tests.test.sh`.

Limits, stated so you do not over-trust it: one-hop imports only (a change
deep in a shared helper reaches tests the selector does not name — typecheck
and the full gate catch those); name-based guard globs; no knowledge of
`@nexa/contracts` consumers (it answers "run the whole unit project").

## Step 2 — the three tiers

1. **While iterating** — `pnpm typecheck` plus the selected files only:
   `pnpm exec vitest run --project unit|web|integration <files>`.
2. **Before pushing a commit others will review** — the selected integration
   suites in full (never a `-t` filter on a money or migration suite), plus
   the class checks the selector printed (`pnpm db:check`, `pnpm check:shell &&
pnpm test:deploy`, `pnpm check:i18n`).
3. **Before marking a PR ready, before merge, before any release** —
   `pnpm verify`, and `pnpm test:integration` whenever the change can reach the
   database. CI runs both on the PR head; a green local gate is not a
   substitute for green CI on the exact head.

Pipe every run through the digest (`nexa-log-digest`), e.g.
`pnpm verify 2>&1 | bash scripts/claude/log-digest.sh`; read the full output
only for the section the digest names.

## Guard classes the selector never narrows

| Change touches                                                                               | Always keep                                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `commerce/payments`, `wallet`, `orders`, `pricing`, `resellers`, `referrals`, `provisioning` | every matching payment/refund/wallet/order/pricing integration suite                      |
| `apps/api/drizzle`, `schema.ts`, `online-indexes.ts`                                         | `pnpm db:check` + `tests/integration/migration-*` (see `nexa-migrations`)                 |
| identity, access, auth controllers, crypto, redaction                                        | auth / admin-security integration suites                                                  |
| backup, recovery, `main.recovery.ts`                                                         | backup-* and recovery-* integration suites                                                |
| `platform/legacy-*`, `infrastructure/nxpkg`, `main.migration.ts`                             | `legacy-migration*` suites; CI also runs legacy MySQL/MariaDB and the synthetic rehearsal |
| `deploy/`, `scripts/*.sh`, `Dockerfile`                                                      | `pnpm check:shell && pnpm test:deploy`                                                    |
| `packages/contracts`, `packages/i18n`                                                        | `pnpm check:i18n && pnpm test`                                                            |

## Heavy suites — run on purpose, not by reflex

- `pnpm test:exhaustive` — nightly in CI; run locally only when changing the
  notification dispatcher/announcer ordering.
- `pnpm test:migration-scale`, `pnpm rehearsal:synthetic`, `pnpm test:legacy-mysql`
  — only for the Mirza importer and only when its apply path changes.
- `pnpm test:acceptance` — needs a disposable real panel and fails without one;
  never in the PR path.
- Do not re-run a suite that already passed on the same tree; re-run after the
  tree changes.

## Running integration safely

Integration suites truncate tables. Start services with
`bash scripts/dev-services.sh`; run one integration process per database at a
time; never run two agents' suites against the same database (CLAUDE.md,
"Reviewing with agents").

- Check Postgres and Redis are up first; an unreachable service is not a test
  result.
- A shared test database with a **stale migration history** (applied rows from
  another branch's journal, e.g. after a renumber) fails in ways that look like
  real bugs. Do not repair it in place: create a fresh private database
  (`createdb -h 127.0.0.1 -U nexa nexa_test_<you>`), point `TEST_DATABASE_URL`
  at it, run, and drop it at the end of the round.

## A failure is information

A red test is a bug in the change, the test, or the environment — find which.
"Flake" is not a root cause. If a test is wrong, fix the test with a reason in
the commit message; a rule with no test, or a test that stays green when its
rule is reverted, is the failure the falsification records exist to prevent.
