# NEXA Round 11 — rules for every implementer agent

You implement ONE PR of NEXA Round 11 in your own git worktree (named in your brief). Never touch
`/home/user/nexa-bot` or any other worktree. Read `CLAUDE.md` in your worktree first, then the skills
your brief names under `.claude/skills/` (always `nexa-conventions`; `nexa-test-selection` and
`nexa-log-digest` before running tests; `nexa-code-navigation` to find code; `nexa-migrations` before
any schema change; `nexa-web-design` before touching apps/web).

Setup: `cd <worktree> && pnpm install --frozen-lockfile --prefer-offline` then
`pnpm --filter @nexa/contracts --filter @nexa/i18n build`. Postgres/Redis: `bash scripts/dev-services.sh`
(once; it is idempotent). Your PRIVATE database is named in your brief; set BOTH
`TEST_DATABASE_URL` and `DATABASE_URL` to `postgres://nexa:nexa@127.0.0.1:5432/<your db>` for every
integration/migration run (create it first: `psql postgres://nexa:nexa@127.0.0.1:5432/postgres -c
'create database <your db>'`). `nexa_test` / `nexa_dev` / other agents' databases are not yours.

- Files over 800 lines are never read whole: `grep -n`, then a range.
- RUNNER (binding): EVERY test, unit, web, integration, typecheck, lint, format, db:check or
  verify-stage run goes through `bash scripts/claude/run-gate.sh [--integration] <command...>` in the
  FOREGROUND (Bash timeout 600000; split file lists so a call fits). It enforces one integration run at
  a time and at most 2 concurrent test/format processes round-wide, and prints the test-summary digest.
  Exit 75 = it gave up waiting: keep coding, re-run later. Never bypass it, never wait for a manual
  "resume" — the queue resumes by itself. If `scripts/claude/run-gate.sh` is missing in your worktree,
  `git merge origin/main` first (Phase 0 adds it).
- Never wait on a background command blindly. Run gates stage by stage in the foreground. If a watched
  output file stays empty for 3 min, check the process exists (`pgrep -af`).
- TRAP: `pnpm test:integration -- <files>` IGNORES the file list and runs everything. Selected suites:
  `pnpm exec vitest run --project integration <files>` (same for unit/web projects).
- Local gate: affected suites only (`nexa-test-selection`) + typecheck, lint, format:check, check:i18n
  as relevant. NEVER run the full integration suite locally — CI runs it on every head. Money / ledger /
  payment / pricing / provisioning / migration PRs also run `pnpm verify` once at the end plus their
  money/guard suites.
- `packages/contracts` is the frozen spec: a contract change (template key, state, event, permission,
  ledger reason, ops code, setting, feature flag, metric) is ITS OWN commit with the reason in the
  message. After changing contracts or `packages/i18n`, rebuild them (command above).
- Rebuild contracts BEFORE `scripts/claude/renumber-migration.sh` (else drizzle-kit sees stale constants).
- Customer-facing text comes from template keys, Persian, no string literals in surfaces. Existing copy is
  not rewritten unless your brief says so; new features get new Persian text.
- Money is bigint minor units + explicit currency. Ledger is append-only, no balance column. Every write
  path takes ScopeContext + ActorContext, an idempotency key, reads ScopeActivityReader inside its
  transaction, and writes outbox events inside the business transaction. Timestamps from the Clock port.
- No customer message from a migration, import or backfill.
- Every feature ships OFF by default (feature flag), switchable in Web Admin, Persian errors only, an
  ops-log type where it moves money or creates a service.
- Every new rule has a test, and you mutation-check it: break the rule → the named test goes red →
  restore → green. Report each mutation. Never cite a probe you did not commit.
- Migrations: `nexa-migrations` (generate with drizzle-kit, read the SQL, `pnpm db:check`).
- Before committing: `git status`, read every line of `git diff`; nothing stray (deletions especially;
  no leftover mutation).
- Commit messages explain the why in detail and end with exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
  ```
- PUSH right after EVERY commit (`git push -u origin <branch>`, never force). Never push to `main`,
  never tag, never open or merge a PR (the lead does), never read `.env`, never touch a real server.
- Ambiguity: take the reading that moves no money and sends no customer message; record it as a decision.
  Unknowns go to `docs/open-questions.md` (OQ-R11-<item>-NN). Work without asking questions.

## Your final report (≤25 lines, no code excerpts, no logs, no narration)

Files changed; tests added (names) with counts and each mutation check; the gate you ran and its
`passed/failed` line; decisions taken; open problems; branch and head SHA pushed. ALSO write a
ready-to-paste PR description to `<worktree>/../r11-<item>-PR.md` (outside the repo): "What changed"
explaining every item in fine detail, "Tests" (names, counts, mutation table), "Decisions", "Migrations"
(numbers, byte-identity if renumbered). That file may be long; your reply stays ≤25 lines.
