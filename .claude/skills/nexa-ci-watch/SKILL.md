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
bash $S --codex <pr>             # Codex comment count, unresolved threads, findings
bash $S --wait <pr> --every 300 --max 5400   # bounded loop; returns on completion
```

## Rules

- **Always this script.** Never read raw job lists or whole logs into context.
- **Job logs:** `--fail-logs` tries `gh api .../actions/jobs/{id}/logs` first;
  the proxy blocks the blob host it redirects to, so when it prints an
  `mcp__github__get_job_logs` call, make that call (with `tail_lines`), not a
  full-log fetch.
- **Waiting:** the bounded `--wait` loop inside the session is the primary
  mechanism — a scheduled check-in can lapse silently (one left a session idle
  for an hour). At most one scheduled check-in per wait, at least 20 minutes
  apart, as a backstop only.
- **One checker.** Never spawn a watcher agent per wait or per notification. If
  the round names one CI-checking agent, it is the only one; everyone else keeps
  working.
- **Duplicates:** do not reply to, or act twice on, a duplicate CI or Codex
  notification. Re-run the script; if the line has not changed, do nothing.
- **Codex** reviews automatically when the PR opens. Never request it again.
  Read the existing review with `--codex`; if `reviewed` ≠ `head`, say in the
  report that it reviewed an older head. No second review.
- **Re-runs:** once, and only when the failure is in a test this PR does not
  touch (or `--gate` reports gate-only-red, using the exact command it prints).
  A second failure is real: investigate. "Flake" is not a root cause.
- **Never merge on red**, on pending, or on a head other than the one that went
  green. Merge only under `nexa-round-pipeline` §3 or explicit owner approval.

## Reading the line

`3f2a9c1e green=14 pending=0 red=1 skipped=2 [red: integration (2/3)]` — the
first field is the head SHA the checks belong to; confirm it is the head you
pushed before believing the rest.
