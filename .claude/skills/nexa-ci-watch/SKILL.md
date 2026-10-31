---
name: nexa-ci-watch
description: How to read and wait for NEXA CI and the Codex review cheaply — scripts/claude/ci-status.sh prints one line per head (green/pending/red), trimmed failure logs, the gate-only-red rerun command and the Codex findings, over the REST API because GitHub GraphQL is blocked in these sessions. Use whenever you check a PR's CI, wait for a run, read a failing job, handle a CI or Codex notification, or decide whether a PR is green enough to merge.
---

# Watching CI and the Codex review

GraphQL is blocked here (`gh pr view`, `gh pr checks`, `gh run …` → 403). Use
the script; it calls `gh api repos/{owner}/{repo}/...` REST only.

```bash
S=scripts/claude/ci-status.sh
bash $S <pr|sha>                 # one line; exit 0 green, 1 red, 2 pending
bash $S <pr> --fail-logs         # ≤20 lines around the first error, per red job
bash $S <pr> --gate              # gate red while every job it needs is green?
bash $S --codex <pr>             # Codex comments, threads, findings; reviewed=/findings=none read its issue-comment marker
bash $S --wait <pr> --every 60 --max 540     # bounded loop, fits one foreground call
```

## Rules

- **Always this script.** Never read raw job lists or whole logs into context.
- **Job logs:** `--fail-logs` tries `gh api .../actions/jobs/{id}/logs` first;
  the proxy blocks the blob host it redirects to, so when it prints an
  `mcp__github__get_job_logs` call, make that call (with `tail_lines`), not a
  full-log fetch.
- **Waiting** is ONE foreground blocking call with a timeout: the bounded
  `--wait` loop, with `--max` under the Bash tool's 600 s limit in the
  foreground (`--max 540`). Never an agent polling in a loop; never
  `gh pr checks` (GraphQL). A scheduled check-in can lapse silently (one left a session idle for
  an hour): at most one per wait, at least 20 minutes apart, as a backstop only.
- **One checker.** Never spawn a watcher agent per wait or per notification. If
  the round names one CI-checking agent, it is the only one; everyone else keeps
  working.
- **Duplicates:** do not reply to, or act twice on, a duplicate CI or Codex
  notification. Re-run the script; if the line has not changed, do nothing.
- **Codex**: request it yourself at once with one `@codex review` comment
  (when, how, the 2-comment cap: `nexa-round-pipeline` §3). Read it with
  `--codex`: `receipt=<sha>:clean|findings` is Codex's "Reviewed commit"
  receipt (the FIRST one for the head); `thumbsup=head` is its 👍 newer than
  the head's push (first check suite; `stale` older, `unknown` no suite). Clean
  on the head = findings=none. If `reviewed` ≠ `head`, it
  reviewed an older head. Act on the first complete review of a head only.
- **Re-runs:** once, and only when the failure is in a test this PR does not
  touch (or `--gate` reports gate-only-red, using the exact command it prints).
  A second failure is real: investigate. "Flake" is not a root cause.
- **Never merge on red**, on pending, or on a head other than the one that went
  green. Merge only under `nexa-round-pipeline` §3 or explicit owner approval.

## Reading the line

`3f2a9c1e green=14 pending=0 red=1 skipped=2 [red: integration (2/3)]` — the
first field is the head SHA the checks belong to; confirm it is the head you
pushed before believing the rest.
