## R11 Phase 0 — agent rules from Round 10, `run-gate.sh`, renumber fix (tooling only)

No product code. Files: `scripts/claude/*`, `.claude/skills/*`, `.claude/README.md`, `CLAUDE.md`.

### What changed

**1. `scripts/claude/renumber-migration.sh` — second-renumber bug (commit a)**
The script decides GENERATED (regenerate with drizzle-kit) vs HAND-WRITTEN (git mv + journal entry) by asking whether the branch added `meta/NNNN_snapshot.json`, using `git log --diff-filter=A`. `git log` shows no diff for a merge commit unless given `-m`. The round pipeline does the first renumber inside the "merge origin/main" commit, so the snapshot it generated was invisible, and the next renumber treated that generated migration as hand-written (no regeneration, no snapshot, journal entry only).

- Fix: `git log -m`.
- Why not `--first-parent`: `BASE..HEAD` already excludes main's history, and a branch that merged another branch (stacked PRs) owns the snapshots on that second-parent side; `--first-parent` would hide them.
- Side effect of `-m`, handled: a merge commit also lists, as added against its first parent, the snapshots main brought in, and a later main snapshot can carry the number of a hand-written branch migration (main's `0004` vs the branch's hand-written `0004_widgets_guard`). A snapshot whose blob in HEAD equals the blob in BASE is dropped; a snapshot the branch really generated always differs (new id). Reasoning is a comment at the site.

**2. `scripts/claude/run-gate.sh` — one shared runner, no global pause (commit b)**
`bash scripts/claude/run-gate.sh [--integration] [--priority] [--max-wait <s>] [--raw] <command...>`, plus `--hold <name> [--ttl <s>]`, `--release <name>`, `--status`.

- Lock dir `${NEXA_GATE_DIR:-/tmp/claude-0/nexa-gate}`, shared by all worktrees. At most 2 concurrent runs (two `flock` slot locks); `--integration` also takes the single integration lock (taken first, then a slot: one consistent order, no deadlock; released while a hold blocks so a priority run can use it).
- Priority hold instead of a pause: `--hold <name>` writes a marker file (name, created, expires — no pid), TTL default 4 h (`NEXA_GATE_HOLD_TTL` / `--ttl`). While a live hold exists only runs with `NEXA_GATE_PRIORITY=<name>` proceed; the rest queue and resume by themselves on `--release` or expiry (expired markers are purged by the next poll). `--priority` asserts the env is set (exit 2 otherwise).
- Runs the command through `test-summary.sh` (digest) unless `--raw`; exit code is the command's.
- Waiting prints at most one line per `NEXA_GATE_NOTICE` (60 s); gives up with exit 75 after `--max-wait` (default 1800 s).
- No stale locks by construction: `flock` on descriptors held by the gate process, released by the kernel on death; no pid files for slots. The wrapped command does not inherit the descriptors (a daemon it leaves behind cannot hold a slot). TERM/INT/HUP to the gate stops the command.
- Wiring: the existing `scripts/claude/*.test.sh` are run by hand (`.claude/README.md`: "not part of `pnpm verify`"; no CI/package.json hook exists), so `run-gate.test.sh` sits beside them and `.claude/README.md` lists both the runner and the loop to run all script tests. `scripts/check-shell.sh` already lints `scripts/**/*.sh` at warning, including its tier-3 `grep -q`-in-pipeline rule (which caught three pipes in the first draft of the test).

**3. Skills and `CLAUDE.md` (commit c)**

- `nexa-round-pipeline`: Agent setup (install, build contracts+i18n, dev-services, private DB per agent with `TEST_DATABASE_URL` and `DATABASE_URL` both set); new §1a: no global pause, every gate through `run-gate.sh` in the foreground, the lead's priority hold, never wait on a background command blindly (empty output for 3 min → check the process), local gate = affected suites only and the full integration suite CI-only for every PR (money PRs keep `pnpm verify` + money suites + lead review); Codex "running" > 1 h is reported to the owner, who comments `@codex review` (we never post it); §4 renumber step: rebuild contracts first.
- `nexa-test-selection`: tier 3 no longer runs the full integration suite locally; runner commands, exit 75, holds, private DB.
- `nexa-log-digest`: `run-gate.sh` is how `test-summary.sh` is invoked in a round.
- `nexa-migrations`: § Renumbering: rebuild `packages/contracts` before `renumber-migration.sh` with the reason (drizzle-kit reads the built constants; stale ones regenerate from the wrong enums), step 0 of the manual fallback, note on the second-renumber fix; the normal-path step 4 and checklist ask for affected integration files, not the full suite.
- `nexa-handoff`: PR section records a Codex review stuck > 1 h and any gate hold still set.
- `CLAUDE.md`: short pointer in Commands; all headings and bold spans untouched.

### Tests

| Suite                                                                                                                            | Result                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `scripts/claude/renumber-migration.test.sh`                                                                                      | 57 ok (11 new: second renumber after a merge-commit renumber; main's snapshot number vs hand-written migration) |
| `scripts/claude/run-gate.test.sh`                                                                                                | 43 ok, ~11 s                                                                                                    |
| other `scripts/claude/*.test.sh` (ci-status, log-digest, module-map, test-summary), `node --test check-claude-md-moves.test.mjs` | all pass (7)                                                                                                    |
| `bash scripts/check-shell.sh`, `run-gate.sh pnpm format:check`, `node scripts/claude/check-claude-md-moves.mjs`                  | clean / OK (7 headings, 76 bold spans, 40 paths)                                                                |

Mutation checks (each rule reverted → named checks red → restored → green):

| Mutation                                  | Red                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| renumber: drop `-m`                       | second renumber is "generated" (dry-run), "regenerated, not just registered", "snapshot for the generated migration" |
| renumber: keep `-m`, drop the blob filter | main's snapshot with a hand-written migration's number does not make it "generated"                                  |
| run-gate: 3 slots                         | third run queues, never more than 2, integration waits for a slot, exit 75 checks                                    |
| run-gate: no integration lock             | second integration run queues, plain run beside integration                                                          |
| run-gate: holds ignored                   | queue under hold, priority checks, TTL, exit 75 under a hold                                                         |
| run-gate: TTL not honoured                | resume on expiry, expired file purged, `NEXA_GATE_HOLD_TTL`                                                          |
| run-gate: exit 75 → 1                     | give-up checks (3)                                                                                                   |
| run-gate: exit code swallowed             | propagated with and without digest                                                                                   |
| run-gate: command inherits lock fds       | leaked daemon holds no slot                                                                                          |

`--first-parent` was also tried on the renumber script: no case goes red (no stacked-branch fixture), so that part is reasoning, not tested.

### Decisions

- Commit trailers use `Claude Sonnet 5.5` (the model that wrote them), not the `Opus 5.5` line in the rules file.
- `--priority` takes no argument (the name comes from `NEXA_GATE_PRIORITY`), as specified; the env var alone also marks a run as priority.
- Child inherits no lock descriptors: a SIGKILLed gate frees its slot while the command may run on briefly (cap can be exceeded for that command's remaining life) — chosen over a leaked daemon wedging a slot.
- The script tests stay "run by hand", like their siblings; wiring them into CI is a separate decision.

### Migrations

None. (The renumber fix has no effect on any existing migration.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
