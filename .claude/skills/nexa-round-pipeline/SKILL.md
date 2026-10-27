---
name: nexa-round-pipeline
description: The owner's standing rules for a NEXA work round — parallel agents in git worktrees, the 25-line subagent report, the lead's one-pass review, the push → one CI checker → one Codex review → one fix commit → green → merge-commit pipeline, multi-PR ordering and migration renumbering, invariants, safety, budget and the final report format. Use when a round prompt says "Follow nexa-round-pipeline", when planning or delegating a multi-agent round, or when deciding whether a PR may be merged.
---

# A NEXA round, start to finish

A round prompt names its tasks and the model split; everything else is here.
`CLAUDE.md`, `nexa-pr-workflow` and `nexa-test-selection` still apply.

## 1. Agents

- Multi-agent and parallel: every implementer gets its own
  `git worktree add -b <branch> <dir> <base>`. Never two agents in one checkout.
- Integration suites run against **separate databases**, and one integration run
  at a time round-wide (the runner, §1a).
- Model split comes from the round prompt; the default is Sonnet for everything.
- Light work (fact collection, README, formatting) goes to the cheapest capable
  agent; fact collection is read-only.
- Nobody sits idle waiting on CI: while one agent watches it, the others take
  the remaining review, docs or test work.
- **Fresh agent per PR.** The lead delegates each PR's merge-main, renumber,
  gate and fix work to a fresh agent that returns the 25-line report (§2); the
  lead does not run those steps, or read their logs, in its own context.
- **Agent setup**, every implementer, in its own worktree (rebuild contracts and
  i18n again after any change to either):

  ```bash
  pnpm install --frozen-lockfile --prefer-offline
  pnpm --filter @nexa/contracts --filter @nexa/i18n build
  bash scripts/dev-services.sh        # once; idempotent
  psql postgres://nexa:nexa@127.0.0.1:5432/postgres -c 'create database nexa_test_<agent>'
  ```

  A **private database per agent**, with BOTH `TEST_DATABASE_URL` and
  `DATABASE_URL` set to it for every integration or migration run. Drop it at
  the end of the round.

- Agents run tests and the gate through the shared runner (§1a) and quote the
  digest it prints (`nexa-log-digest`), never raw output.

## 1a. Test load: one runner, no pause

Round 10 coordinated machine load with a global "pause" that agents then waited
on for a resume that never came. These rules replace it, permanently.

- **No global test pause, ever.** EVERY test, unit, web, integration, typecheck,
  lint, format, `db:check` or verify-stage run, from every worktree, goes
  through the runner, in the foreground (Bash timeout 600000; split file lists
  so a call fits):

  ```bash
  bash scripts/claude/run-gate.sh [--integration] [--max-wait <s>] <command...>
  ```

  It allows at most 2 runs at once and one integration run at a
  time round-wide, queues the rest, resumes them by itself, and prints the
  `test-summary.sh` digest. Exit 75 = it gave up waiting (default 30 min): keep
  coding and run it again later. Nobody bypasses it and nobody waits for a manual
  "resume".

- **The lead's tool is a priority hold, not a pause.** `run-gate.sh --hold lead`
  makes runs without `NEXA_GATE_PRIORITY=lead` queue; `--release lead` (or the
  4 h TTL, which a crashed lead cannot outlive) lets them resume on their own.
  `--status` shows slots, the integration lock and holds. Hold only for a short,
  named reason, and release it as soon as that reason is gone.
- **Never wait on a background command blindly.** Gates run in the foreground,
  stage by stage. If a watched output file stays empty for 3 min, check the
  process exists (`pgrep -af`) before waiting longer.
- **Local gate = affected suites only** (`nexa-test-selection`), plus typecheck,
  lint, `format:check` and `check:i18n` as relevant. The file-list form is
  `pnpm exec vitest run --project integration <files>`; the script
  `pnpm test:integration` ignores a file list and runs everything. The **full
  integration suite runs on CI only**, for every PR including money PRs. A money PR keeps `pnpm verify` once at the end
  and its money/guard suites locally, and the lead's review.

## 2. Lead review

- **Subagent report cap: at most 25 lines**, containing only: files changed;
  tests added and their mutation checks; decisions taken; open problems.
  No code excerpts, logs or narration — the lead reads code from the diff.
- The lead reads each report once and the full diff once, line by line, and
  confirms no reviewer mutation is left behind (`git status`, every line of
  `git diff`; deletions especially).
- **Non-money shortcut.** For a PR that touches no money, ledger,
  payment, gateway, pricing, provisioning or migration code, the local gate may
  be the affected suites only (`nexa-test-selection`) and the lead's own
  one-pass review may be skipped; CI still runs the full suite on the exact
  head and the Codex review is still read and fixed (§3). The pre-commit
  `git status` and line-by-line `git diff` read for leftover reviewer
  mutations is never skipped. Money PRs — and any PR where it is unclear —
  keep `pnpm verify` and their money/guard suites locally, and the lead review.
  The full integration suite is CI-only for every PR (§1a).
- **Lead narration:** the lead writes a progress line only when a PR merges,
  something breaks, or a decision is taken. No step-by-step narration.
- The incidents behind these rules: `references/agent-review-lessons.md`.

## 3. PR pipeline

Push → open the PR → **one** CI checker (`nexa-ci-watch`) → read the **one**
Codex review (it runs automatically when the PR opens; never request another;
if it reviewed an older head, say so) → fix its findings in **one** commit →
green CI on that head → merge with a **merge commit**. There is no second
review round.

If the Codex review is still "running" more than 1 h after the PR opened, report
it to the owner in the round report or the handoff and keep working: the owner
comments `@codex review` on the PR. Agents and the lead never post that comment
themselves.

A round prompt that says to push, open a PR and merge on green **is** the
explicit owner approval `nexa-pr-workflow` §6 requires — for that round's PRs,
on the exact head where CI is fully green and the Codex findings are fixed.
Nothing else is approval.

## 4. Multi-PR rounds

- Merge in the stated order. After each merge, merge `origin/main` into the
  next branch (a merge, never a rebase).
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

## 5. Invariants

- A `packages/contracts` change is its own commit, with the reason.
- Every new rule has a test that fails when the rule is reverted.
- A citation or falsification pin count rises only by exactly the number of
  citations this PR adds. Never raise it to hide a missing reference.

## 6. Safety

- No customer message from a migration, an import or a backfill.
- Never push to `main`. Never force-push. Never push a tag.
- The owner's test-server checklist always ends with
  `sudo botctl roles disable provisioner monitor`.
- Before integration tests, `bash scripts/dev-services.sh`: an unreachable
  Postgres or Redis is not a test result.
- Trap: `pnpm test:integration -- <files>` ignores the file list and runs the
  WHOLE suite. Selected files: `pnpm exec vitest run --project integration <files>`.
- Repo-wide checks (lint, boundaries) run from a clean checkout; stale
  `.claude/worktrees/*` copies break them.

## 7. Ambiguity

Work without stopping to ask. Take the reading that moves no money and sends no
customer message, and record it under "Decisions taken".

## 8. Budget

Near the session limit: finish and merge what is done, write a handoff
(`nexa-handoff`), list the rest. A round always ends with a handoff; never
leave a half-done change pushed without one.

Write or refresh the handoff after every merged PR and whenever the context
passes ~50 %. After a compact, re-read the round prompt and the handoff before
continuing.

## 9. End of round

Remove every worktree and temporary test database the round created. Final
report, per PR: link and merge commit; what changed; the Codex fixes; tests and
their mutation checks. Then decisions taken, and the owner's test checklist
with exact `botctl` commands (ending as in §6).
