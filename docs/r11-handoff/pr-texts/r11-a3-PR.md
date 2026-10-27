## R11 A3 — a role that crash-loops with lives shorter than 60 s is now reported (once)

### What changed

**Problem.** The v0.8.2 worker died every ~13 s and the ops group never said so. The loop-stall watchdog
(`LoopStallReporter`) deliberately gives a process no verdict in its first minute (the v0.8.2 hotfix, which
stopped a stalled/recovered pair per boot), so a role that dies within seconds is invisible to it by construction;
`restart: unless-stopped` restarts it at once, so no container health check stays red either. Nothing host-side
watches (`botctl` is a CLI, not a daemon), so detection lives in the roles and its memory must survive the crash.

**Commit 1 — contracts (own commit).** `process.restart_storm` (JOBS, CONDITION, one per role, dedupe key
`process.restart_storm:<role>`) and its recovery `process.restart_storm_ended`; constants
`PROCESS_RUN_STABLE_AFTER_MS` (60 s), `PROCESS_RESTART_STORM_MIN_RESTARTS` (3), `PROCESS_RESTART_STORM_WINDOW_MS`
(5 min). Persian event titles/messages, Persian name for the `api` role, exception-inventory row 39, topic test row
(both codes route to SYSTEM, like `job.loop_stalled`). No template key was needed: the message rides the existing
`ops.notification.operational_event` template.

**Commit 2 — implementation.**

- Migration `0293_process_runs`: one row per role (`role` PK, `run_id`, `started_at`, `stable_at`, `stopped_at`,
  `restarts`, `restarts_since`; role-name and streak CHECKs). Installation-wide, no tenant, no money.
- `process-run-state.ts`: the pure rules. `recordBoot(previous, …)`: previous life crashed young (neither stable nor
  stopped on purpose) lengthens the streak, or restarts it at 1 when the streak's first life is older than the window;
  anything else clears it. Shared by the DB store and the unit tests' store.
- `ProcessRestartWatch` (`start`, `check`, `stop`): at boot records this life and, when the streak reaches 3, records
  `process.restart_storm` through the ordinary recorder. The recorder's dedupe row is what makes it ONE message per
  episode (4th/40th restart and a process that never knew it had announced only count on the open row). A 10 s timer
  (unref'd); once the life is 60 s old it marks itself stable (clears the streak) and, if the condition is open (read
  from the rows, not memory), records `process.restart_storm_ended`; a failed recovery write is retried next tick.
  `stop()` (handled SIGTERM) marks the life stopped, so an operator's `botctl restart` is not a crash. Never throws,
  never blocks a role.
- `DrizzleProcessRunStore`: one transaction under a `pg_advisory_xact_lock` per role.
- Wired via `startProcessRestartWatch(container, role)` (bootstrap.ts) in api, worker, monitor, provisioner,
  assistant, recovery (every compose service Docker restarts), after the tenant is resolved; `stop()` in each
  shutdown `close`, before `container.shutdown()`. The `migration` role is a rehearsal one-shot, not supervised.
- Presenter: «سرویس <نام فارسی نقش> پی‌درپی ری‌استارت می‌شود», lines «فرایند: …» and «۳ بار ری‌استارت در ۵ دقیقه،
  هر بار کمتر از یک دقیقه کار کرد»; recovery «سرویس … دوباره پایدار شد». No Latin letter outside the 🔧 line.
- Docs: `docs/deployment.md` paragraph, `docs/ops-error-events.md` row 39.

### Tests

Unit (`tests/unit/`): `process-run-state.test.ts` (10), `process-restart-watch.test.ts` (13: 3 crashes → 1 message,
10/12 crashes → still 1 with count on the open row, two roles, restarts spread > window never storm, stable life
records the recovery once, clears the streak, new episode after quiet → 1 new message, no recovery without a storm,
failed recovery retried, premature crash continues the episode, clean stop, stale stop cannot mark a newer life,
DB down / no tenant never throw), `process-restart-presenter.test.ts` (4), `process-restart-wiring.test.ts` (19,
reads compose + mains). Integration: `process-restart-storm.test.ts` (7: real recorder, condition reader, group
projection, store; concurrent boots serialised; null change writes nothing; bad role refused; `startProcessRestartWatch`).
Also green: ops-error-events/topics/labels, loop-stall-* , role-loop-stall (int), migration-ordering (int), migration-journal.
Local gate: typecheck, lint, format:check, check:i18n, check:boundaries, db:check all exit 0. `pnpm test:deploy` not
run: nothing under `deploy/` changed.

| Mutation (restored after)                 | Test that went red                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| announce at `> 3` instead of `>= 3`       | "3 quick crashes announce once…" (+2)                                      |
| clean stop counted as a crash             | "a stop ends a streak that was running" (+2)                               |
| window ignored                            | "restarts spread over more than the window never make a storm" (+1)        |
| stable mark keeps the streak              | "clears the streak: the next crash is restart 1" (+1)                      |
| recovery without the open-condition check | "does nothing before the stable window and records the recovery once" (+1) |
| stop ignores the run id                   | "a stop from an older life cannot mark a newer one"                        |
| stable window check removed               | "does nothing before the stable window…" (+1)                              |
| failed recovery treated as done           | "a recovery that could not be written is tried again"                      |
| dedupe key per life                       | 8 failures ("3 quick crashes…", "10 quick crashes…", …)                    |
| worker no longer stops the watch          | wiring "worker starts the watch … and stops it on shutdown"                |
| Persian heading changed                   | presenter "reads «سرویس … پی‌درپی ری‌استارت می‌شود»" (+1)                  |
| advisory lock removed                     | integration "serialises boots of one role" (got 4, not 19)                 |

### Decisions

- Detection in-process with a DB row, not host-side: `botctl` is not a daemon.
- Recovery message exists (the existing style has `job.loop_recovered`); without it the condition could never reopen.
- Window anchored at the first crashed life of the streak (fixed, not sliding) — simplest; a storm still announces within
  one more restart in the edge case.
- Clean stop (handled SIGTERM) is not a crash. A SIGKILLed stop after the shutdown timeout is.
- A PostgreSQL that is down at boot hides that boot from the count; such a role is down anyway.
- The message is SENT by the worker's dispatcher: if the worker itself is the crash-looping role it goes out the first
  time a life lives long enough to dispatch; the row is visible in the Web Admin at once (documented).
- `api` Persian role label «سرور وب و وب‌هوک تلگرام» added to the shared role table.
- Single instance per role assumed (one row per role).

### Migrations

`0293_process_runs` (generated by drizzle-kit, `db:check` clean; not renumbered). Other open PRs may also claim 0293.

### Notes

- `tests/integration/backup.test.ts` "drops the scratch database" failed locally only because other agents' concurrent
  backup runs left `nexa_verify_*` databases on the shared server (the check is server-wide); unrelated.

### Lead review note

A role that crashes BEFORE `startProcessRestartWatch` runs (config load, container creation, database unreachable, before the installation tenant resolves) is not counted — it cannot write its run row. Those failures are what `botctl status`/health already show; this PR covers roles that start and then die within a minute. Migration `0293_process_runs` will be renumbered if another Phase A migration merges first (byte-identical SQL).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
