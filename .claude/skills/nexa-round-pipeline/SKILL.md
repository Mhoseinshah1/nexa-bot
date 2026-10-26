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
- Integration suites run against **separate databases** (or one at a time).
- Model split comes from the round prompt; the default is Sonnet for everything.
- Light work (fact collection, README, formatting) goes to the cheapest capable
  agent; fact collection is read-only.
- Nobody sits idle waiting on CI: while one agent watches it, the others take
  the remaining review, docs or test work.
- **Fresh agent per PR.** The lead delegates each PR's merge-main, renumber,
  gate and fix work to a fresh agent that returns the 25-line report (§2); the
  lead does not run those steps, or read their logs, in its own context.
- Agents run tests and the gate through `test-summary.sh` (`nexa-log-digest`:
  `bash scripts/claude/test-summary.sh <command...>`) and quote its summary,
  never raw output.

## 2. Lead review

- **Subagent report cap: at most 25 lines**, containing only: files changed;
  tests added and their mutation checks; decisions taken; open problems.
  No code excerpts, logs or narration — the lead reads code from the diff.
- The lead reads each report once and the full diff once, line by line, and
  confirms no reviewer mutation is left behind (`git status`, every line of
  `git diff`; deletions especially).
- **Non-merchandise shortcut.** For a PR that touches no money, ledger,
  payment, gateway, pricing, provisioning or migration code, the local gate may
  be the affected suites only (`nexa-test-selection`) and the lead's own
  one-pass review may be skipped; CI still runs the full suite on the exact
  head and the Codex review is still read and fixed (§3). The pre-commit
  `git status` and line-by-line `git diff` read for leftover reviewer
  mutations is never skipped. Money PRs — and any PR where it is unclear —
  keep the full local gate and the lead review.
- **Lead narration:** the lead writes a progress line only when a PR merges,
  something breaks, or a decision is taken. No step-by-step narration.
- The incidents behind these rules: `references/agent-review-lessons.md`.

## 3. PR pipeline

Push → open the PR → **one** CI checker (`nexa-ci-watch`) → read the **one**
Codex review (it runs automatically when the PR opens; never request another;
if it reviewed an older head, say so) → fix its findings in **one** commit →
green CI on that head → merge with a **merge commit**. There is no second
review round.

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
