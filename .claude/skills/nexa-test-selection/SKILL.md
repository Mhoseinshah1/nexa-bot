---
name: nexa-test-selection
description: Which NEXA tests to run for a given change — targeted unit/web/integration suites while iterating, the guard suites money, migration, security and legacy-import changes always keep, and the full gate before a PR is ready or a release is cut. Use before running tests, when a suite is slow, or when deciding whether `pnpm verify` is needed yet.
---

# Choosing tests in NEXA

This skill decides _when_ each layer runs. It never decides that a test may be
skipped, deleted, weakened or marked `.skip`/`.todo`, even for a red CI. Read
`references/test-details.md` for runner output, heavy suites, other commands.

## Step 1 — ask the selector

```bash
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh   # vs origin/main
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh --base <ref>
bash .claude/skills/nexa-test-selection/scripts/select-tests.sh --files <path>...
```

Prints commands, runs nothing: changed tests, one-hop importers, the whole
project when a `tests/` helper changes, the change's guard suites. Blind beyond
one hop and to `@nexa/contracts` consumers; typecheck and the full gate catch
the rest. A bad `--base` is exit 2.

## Step 2 — the three tiers

1. **Iterating** — `pnpm typecheck` plus the selected files only:
   `pnpm exec vitest run --project unit|web|integration <files>`.
2. **Before pushing a commit others will review** — the selected integration
   suites in full (never a `-t` filter on a money or migration suite) plus the
   selector's class checks (`pnpm db:check`, `pnpm check:shell && pnpm
test:deploy`, `pnpm check:i18n`).
3. **Before a money PR is ready, before merge, before any release** —
   `pnpm verify` once, plus the selector's money/guard suites (affected files). The **full** `pnpm test:integration` runs on
   CI only, for every PR, on the exact head; a green local gate does not
   replace green CI.

Run every tier through the shared runner (queues, prints a digest):

```bash
bash scripts/claude/run-gate.sh pnpm verify
bash scripts/claude/run-gate.sh --integration pnpm exec vitest run --project integration <files>
bash scripts/claude/run-gate.sh pnpm exec vitest run --project unit <files>
bash scripts/claude/run-gate.sh pnpm typecheck      # lint, format:check, db:check likewise
bash scripts/claude/test-summary.sh --from "$SCRATCH/int.log"   # an existing log
```

Binding in a round (`nexa-round-pipeline` §1a): every test, typecheck, lint,
format, `db:check` or verify run goes through it, in the foreground; max 2 at once, `--integration` one at a time; waits resume by themselves; exit 75 =
gave up waiting (re-run later). Outside a round `test-summary.sh` suffices.

Trap: `pnpm test:integration -- <files>` ignores the file list and runs the
WHOLE suite; use `pnpm exec vitest run --project integration <files>` (same for
`unit`, `web`). Split long lists to fit Bash's 600000 ms limit.

**Non-money shortcut.** A PR touching no money, ledger, payment, gateway,
pricing, provisioning or migration code may use tiers 1–2 as its local gate
instead of tier 3; CI still runs the full suite on the exact head and Codex
still reviews (`nexa-round-pipeline` §3). A PR touching any of those keeps
tier 3 locally. When unsure, it is a money PR.

## Guard classes the selector never narrows

- `commerce/payments`, `wallet`, `orders`, `pricing`, `resellers`, `referrals`,
  `provisioning` → every matching integration suite.
- `apps/api/drizzle`, `schema.ts`, `online-indexes.ts` → `pnpm db:check` +
  `tests/integration/migration-*` (`nexa-migrations`).
- identity, access, auth controllers, crypto, redaction → auth/admin-security
  suites. Backup, recovery, `main.recovery.ts` → backup-* and recovery-*.
- `platform/legacy-*`, `infrastructure/nxpkg`, `main.migration.ts` →
  `legacy-migration*` suites (CI adds MySQL/MariaDB and the rehearsal).
- `deploy/`, `scripts/*.sh`, `Dockerfile` → `pnpm check:shell && pnpm test:deploy`.
- `packages/contracts`, `packages/i18n` → `pnpm check:i18n && pnpm test`.

## Heavy suites — run on purpose, not by reflex

`pnpm test:exhaustive` (~4 min, nightly; only for notification ordering
changes), `pnpm test:migration-scale`,
`pnpm rehearsal:synthetic`, `pnpm test:legacy-mysql` (only when the Mirza
importer's apply path changes), `pnpm test:acceptance` (needs a real panel;
never in the PR path). With Docker: `bash scripts/deployment-smoke.sh`,
`bash scripts/deployment-update-smoke.sh`.

## Running integration safely

Integration suites truncate tables. `bash scripts/dev-services.sh` first (an
unreachable Postgres or Redis is not a test result); one integration process
per database, never two agents on one. Each agent uses its own database with BOTH `TEST_DATABASE_URL` and `DATABASE_URL` set to it. A
**stale migration history** fails like a real bug: create a fresh private
database (`createdb -h 127.0.0.1 -U nexa nexa_test_<you>`), drop it at round end.

A red test is a bug in the change, the test or the environment — find which.
"Flake" is not a root cause.
