---
name: nexa-log-digest
description: Read NEXA test and gate runs through scripts/claude/test-summary.sh (passed/failed/skipped counts, failing tests or stages, the first 20 lines of each failure, exit code, raw log path), and shrink any other long tool output - typecheck, lint, format, drizzle-kit - to the failures only (≤40 lines) with scripts/claude/log-digest.sh. Use every time you or a subagent run tests, pnpm verify, pnpm typecheck, pnpm lint or pnpm db:check, and before pasting any test output into a report.
---

# Digest tool output before reading it

## In a round: run-gate.sh wraps test-summary.sh

```bash
bash scripts/claude/run-gate.sh [--integration] [--max-wait <s>] <command...>
bash scripts/claude/run-gate.sh --integration pnpm exec vitest run --project integration <files>
```

Every test, typecheck, lint, format, `db:check` or verify-stage run in a round
goes through this runner, in the foreground (`nexa-round-pipeline` §1a). It
queues behind other agents (2 runs at once, one integration run, round-wide),
resumes by itself, runs the command through `test-summary.sh` and prints that
digest below, so you read the digest and nothing else. Exit 75 = it gave up
waiting: keep coding, re-run later. `--raw` skips the digest. Waiting is
bounded: a watched output file that stays empty for 3 min means check the
process exists (`pgrep -af`), never wait blindly on a background command.

## Tests and the gate: test-summary.sh

```bash
bash scripts/claude/test-summary.sh pnpm verify
bash scripts/claude/test-summary.sh pnpm exec vitest run --project integration <files>
bash scripts/claude/test-summary.sh --from "$SCRATCH/int.log"
```

Runs the command (or reads a saved log) and prints only
`passed=N failed=N skipped=N`, the failing test names or failed `pnpm verify`
stages, the first 20 lines of each failure, `exit=N` and the raw log's path. Its
exit code mirrors the command's, so no `pipefail` is needed. Use it instead of
reading raw test output; open the raw log only at a failure it names.

Trap: `pnpm test:integration -- <files>` ignores the file list and runs the
WHOLE integration suite; pass selected files to `pnpm exec vitest run --project
integration <files>` instead.

## Any other long output: log-digest.sh

```bash
pnpm typecheck 2>&1 | bash scripts/claude/log-digest.sh
pnpm db:check 2>&1 | bash scripts/claude/log-digest.sh
pnpm lint 2>&1 | tee "$SCRATCH/lint.log" | bash scripts/claude/log-digest.sh
```

It also digests test output (`… vitest run … 2>&1 | log-digest.sh`) when you
want one short digest rather than `test-summary.sh`'s per-failure excerpts.

It prints each failing test as `file › title`, its first error message,
`file:line` for each tsc/eslint/prettier/drizzle-kit error, and a last line
`failed=N passed=N` — at most 40 lines. A clean run prints only the summary.

## Rules

- Every agent that runs tests or `pnpm verify` reads them through
  `run-gate.sh` (which uses `test-summary.sh`) or pipes other output through
  `log-digest.sh`. Reports quote the summary or the digest, never raw output.
- Keep the full log in a scratch file (`tee`) when a run is slow, so the
  digest is not the only copy.
- Read full output only when the digest is not enough — and then only the named
  file's section (`grep -n` the test title in the saved log, read a range).
- The exit status of `cmd | log-digest.sh` is the digest's. Use
  `set -o pipefail` or check `failed=` when the result decides anything.
- A digest of an unreachable Postgres or Redis is not a test result: start
  services first (`bash scripts/dev-services.sh`).
