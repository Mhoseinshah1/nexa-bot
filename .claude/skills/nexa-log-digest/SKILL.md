---
name: nexa-log-digest
description: Shrink NEXA test, typecheck, lint, format, drizzle-kit and pnpm verify output to the failures only (≤40 lines - failing test, first error, file:line, failed/passed summary) with scripts/claude/log-digest.sh. Use every time you or a subagent run tests, pnpm verify, pnpm typecheck, pnpm lint or pnpm db:check, and before pasting any test output into a report.
---

# Digest tool output before reading it

```bash
pnpm verify 2>&1 | bash scripts/claude/log-digest.sh
pnpm exec vitest run --project unit <files> 2>&1 | bash scripts/claude/log-digest.sh
pnpm test:integration 2>&1 | tee "$SCRATCH/int.log" | bash scripts/claude/log-digest.sh
```

It prints each failing test as `file › title`, its first error message,
`file:line` for each tsc/eslint/prettier/drizzle-kit error, and a last line
`failed=N passed=N` — at most 40 lines. A clean run prints only the summary.

## Rules

- Every agent that runs tests or `pnpm verify` pipes the output through it.
  Reports quote the digest, never raw output.
- Keep the full log in a scratch file (`tee`) when a run is slow, so the
  digest is not the only copy.
- Read full output only when the digest is not enough — and then only the named
  file's section (`grep -n` the test title in the saved log, read a range).
- The exit status of `cmd | log-digest.sh` is the digest's. Use
  `set -o pipefail` or check `failed=` when the result decides anything.
- A digest of an unreachable Postgres or Redis is not a test result: start
  services first (`bash scripts/dev-services.sh`).
