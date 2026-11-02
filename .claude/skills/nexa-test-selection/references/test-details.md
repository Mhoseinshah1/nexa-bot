# Test selection in full (moved verbatim from SKILL.md, token diet)

`SKILL.md` keeps the decision rules and commands; this is the long wording.

## Heavy suites — run on purpose, not by reflex

- `pnpm test:exhaustive` — 1341 notification orderings, ~4 min; nightly in CI;
  run locally only when changing the notification dispatcher/announcer
  ordering. It is off the pull-request path on purpose — it is the search, not
  the safety net, and every shape it has found has a named regression in
  `tests/integration/notification-invariants.test.ts`.
- `pnpm test:migration-scale`, `pnpm rehearsal:synthetic`, `pnpm test:legacy-mysql`
  — only for the Mirza importer and only when its apply path changes.
- `pnpm test:acceptance` — needs a disposable real panel and fails without one;
  never in the PR path.
- With a Docker daemon (the Ubuntu CI job; cloud sessions usually have no
  registry egress for base images): `bash scripts/deployment-smoke.sh` (build,
  up, migrate, serve, back up) and `bash scripts/deployment-update-smoke.sh`
  (A -> B -> failed health -> rollback).
- Do not re-run a suite that already passed on the same tree; re-run after the
  tree changes.

## Other commands (moved from CLAUDE.md § Commands)

```bash
pnpm provision                 # the primary tenant (dev: provision:dev)
pnpm admin:bootstrap           # first owner, from dist (dev: admin:bootstrap:dev)
pnpm backup run|list|verify|restore   # the DR pipeline (dev: backup:dev)
pnpm check:runtime             # dist CLI runs without devDeps; web ships no source maps
pnpm check:shell               # shellcheck; deploy/ at info, scripts/ at warning
pnpm test:deploy               # botctl update/rollback logic against a fake docker
```

## Running integration safely

Integration suites truncate tables. Start services with
`bash scripts/dev-services.sh`; run one integration process per database at a
time (the runner's `--integration` lock enforces it round-wide); never run two
agents' suites against the same database (CLAUDE.md, "Reviewing with agents").
Each agent uses its own database with BOTH `TEST_DATABASE_URL` and
`DATABASE_URL` set to it.

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

## Step 1 — the selector, limits and runner output

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

The runner is binding in a round (`nexa-round-pipeline` §1a): every test,
typecheck, lint, format, `db:check` or verify-stage run, from every worktree,
goes through it, in the foreground. At most 2 runs execute at once round-wide
and `--integration` runs one at a time, so a run may print "waiting" lines
first; they resume by themselves, never on a manual signal. Exit 75 means it
gave up waiting (30 min, `--max-wait <s>`): keep coding, re-run later. A lead's
`--hold <name>` makes runs without `NEXA_GATE_PRIORITY=<name>` queue until
`--release <name>` or its 4 h expiry. Outside a round `test-summary.sh` alone is
fine.

It prints `passed=N failed=N skipped=N`, the failing test names or failed
`pnpm verify` stages, the first 20 lines of each failure, `exit=N` and the raw
log's path; its exit code is the command's. Open the raw log only at the
failure it names (`grep -n`, then a range). `log-digest.sh` (`nexa-log-digest`)
stays for other long output.
