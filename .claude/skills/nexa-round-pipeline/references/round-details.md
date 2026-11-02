# Round details (moved verbatim from SKILL.md, token diet)

The rules stay in `SKILL.md`; this is the history and the long form behind
four of them.

## 1a. Test load: one runner, no pause

Round 10 coordinated machine load with a global "pause" that agents then waited
on for a resume that never came. These rules replace it, permanently.

- **The lead's tool is a priority hold, not a pause.** `run-gate.sh --hold lead`
  makes runs without `NEXA_GATE_PRIORITY=lead` queue; `--release lead` (or the
  4 h TTL, which a crashed lead cannot outlive) lets them resume on their own.
  `--status` shows slots, the integration lock and holds. Hold only for a short,
  named reason, and release it as soon as that reason is gone.
- **Never wait on a background command blindly.** Gates run in the foreground,
  stage by stage. If a watched output file stays empty for 3 min, check the
  process exists (`pgrep -af`) before waiting longer.

## 4. Multi-PR rounds — renumbering, long form

- Renumber that branch's migrations to follow `main` sequentially, regenerate
  snapshot and journal with the tooling (`nexa-migrations` § Renumbering),
  run `pnpm db:check`. The SQL stays byte-identical, and the PR body says so.
  **Rebuild `packages/contracts` first** (`pnpm --filter @nexa/contracts build`):
  drizzle-kit reads the built constants, and stale ones regenerate the wrong SQL
  (`nexa-migrations` § Renumbering).
  `bash scripts/claude/renumber-migration.sh` does the renumber, regeneration
  and byte-identity proof in one call (last line `renumbered=N identical=yes|no`;
  `identical=no` or a non-zero exit stops the merge); `pnpm db:check` and the
  migration suites stay yours.

## 1. Agents — agent setup

Every implementer, in its own worktree (rebuild contracts and i18n again after
any change to either):

```bash
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @nexa/contracts --filter @nexa/i18n build
bash scripts/dev-services.sh        # once; idempotent
psql postgres://nexa:nexa@127.0.0.1:5432/postgres -c 'create database nexa_test_<agent>'
```

A **private database per agent**, with BOTH `TEST_DATABASE_URL` and
`DATABASE_URL` set to it for every integration or migration run. Drop it at
the end of the round.
