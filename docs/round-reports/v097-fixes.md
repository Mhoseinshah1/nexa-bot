# v0.9.7 — lighter database and backups, Web Admin polish

Round NEXA-FIX-V097 of 2026-11-04. Five PRs against `Mhoseinshah1/nexa-bot`, owner issue #358.
All five are CI-green on their final heads and Codex-reviewed, and **none is merged**: the session's
safety layer refused the merge call ("merge without review") despite the round's merge permission.
The owner merges them. Per-PR detail (changes, tests, mutation checks, decisions) is in each PR
description. Trial-merging all five in the order below onto main `4f36aa2c` is conflict-free.

## PRs (not merged — merge in this order, as merge commits)

| Order | PR   | Subject                                                                          | Head       | Link                                              |
| ----- | ---- | -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| 1     | #396 | Web Admin polish and the grouped sidebar menu                                    | `94475d4d` | https://github.com/Mhoseinshah1/nexa-bot/pull/396 |
| 2     | #397 | cutover journal written atomically, unreadable one alerts                        | `c638d613` | https://github.com/Mhoseinshah1/nexa-bot/pull/397 |
| 3     | #398 | PR-1: automatic cleanup of import data after a clean import                      | `0d00e142` | https://github.com/Mhoseinshah1/nexa-bot/pull/398 |
| 4     | #399 | PR-5: remove the per-invoice legacy outcome card (stacked on #398)               | `2afca15f` | https://github.com/Mhoseinshah1/nexa-bot/pull/399 |
| 5     | #400 | PR-2: shorter retention, leaner backups, capped verify-restore (stacked on #398) | `f08f4528` | https://github.com/Mhoseinshah1/nexa-bot/pull/400 |

Migrations: `0311`, `0312` (#398), `0313` (#400, renumbered from 0311, SQL byte-identical). #396 and
#397 add none. Contract changes are their own commits in #396 (nav i18n keys), #398 and #400.

Codex: #396 one P2 (touch-hover and selected rows), fixed. #397 clean. #398 clean on its own review;
a P1 raised on #399 (bot-link eligibility after the import map is cleared) was fixed in #398 `0d00e142`.
#399 clean after that. #400 clean.

CI fixes: `0254f970` in #398 hardened `wp20-outbox-retry`'s planner-dependent index check. #399's
liveness-watchdog test was given a real timing margin (a test bug, not production).

## Not done

- **The < 50 MB / one-part backup goal is NOT met** (table below).
- **OQ-V097-P2-01**: the audit log's 90-day retention is not implemented. `audit_logs` is append-only
  by trigger, and the round also says the audit log stays.
- **OQ-V097-P2-02**: removing the importer's own idempotency keys in PR-1's cleanup. Both are in
  `docs/open-questions.md` (on #400).
- PR-1 decisions: an import recorded before this release is never cleaned automatically (no balance
  reconciliation was recorded). The trial limit 0 written by the import is lifted by the cleanup;
  until it runs, imported customers cannot take a trial.
- PR-5 keeps `GET /legacy-services` (the held-services review lane and its integration test use it).
- The audit label `migration:0311_compaction_mode_apply` stays after the renumber (byte-identity).
- `backup-verify` picks up a changed CPU setting only at the next `botctl restart`.
- No before/after screenshots for the polish (`web:shots`, `web:sweep`, `web:responsive` not run).

## Sizes

Database tables (before/after): **not measured.** The fixtures are too small for the cleanup to show
anything meaningful. The real numbers appear on the compaction card (before/after per table) and in
the ops group's `maintenance.legacy_compaction_completed` message after the owner's fresh import.

Backup, `pnpm test:migration-scale` fixture (200k customers, 130k invoices, 45 MiB parts):

| Scenario                                                     | Dump     | Archive | Parts |
| ------------------------------------------------------------ | -------- | ------- | ----- |
| right after the import (main today)                          | 1245 MiB | 103 MiB | 3     |
| + PR-1 cleanup                                               | 1006 MiB | 74 MiB  | 2     |
| + 7 days of E3 retention                                     | 812 MiB  | 64 MiB  | 2     |
| also without the importer's idempotency keys (OQ-V097-P2-02) | 715 MiB  | 51 MiB  | 2     |

## CPU of a backup (`backup.cpu_limit_percent` 70, 4 vCPU, 1.0 GB dump)

| Measure                                | % of one core           |
| -------------------------------------- | ----------------------- |
| whole run                              | 67.8 (within 70 +/- 10) |
| 7-Zip stage                            | 66                      |
| verify step, `backup-verify` container | 77.5 (server 52)        |
| verify step on main before (old)       | 90.5                    |
| dump itself (7 s)                      | 110                     |
| peak 5-second window                   | 144                     |

## Owner checklist (test server, in order)

1. After you merge the five PRs and tag `v0.9.7` (the lead pushes no tags):
   `sudo botctl update v0.9.7`, then `sudo botctl version`.
2. `sudo botctl status`: ready, and it prints the backup-verify CPU and memory limits (70% setting ->
   0.70 CPU). If you change `backup.cpu_limit_percent` later, run `sudo botctl restart` once.
3. `sudo botctl roles enable provisioner monitor`, then `sudo botctl roles status` (both running).
4. Fresh one-click import: Web Admin restore page, upload the `.nxpkg`, dry run, approve, apply.
5. Watch the automatic cleanup: no button to press. Within the hour the Recovery page's compaction
   card goes through its states to completed, with before/after sizes per table and a total row.
   The ops group gets `maintenance.legacy_compaction_completed` with the sizes. If no backup
   destination is set, expect «پاک‌سازی داده‌های انتقال منتظر تنظیم مقصد بکاپ است» instead.
6. After the import: `sudo botctl restart background`, then `sudo botctl status`.
7. Run a backup from the Web Admin backup page; note the archive size and the part count
   (compare with the table above). `sudo botctl logs backup-verify` shows the verify restore ran there.
8. CPU during that backup: `sudo botctl status` (limits), and `docker stats` while it runs; expect
   around 70% of one core overall, short peaks above.
9. The new menu: open the Web Admin on a phone and a desktop; walk the sidebar groups and check every
   page you use is reachable. Check the «پشتیبانی» group holds tickets and support.
10. End: `sudo botctl roles disable provisioner monitor`.

## Usage

| Item                             | Count | Tier                                                     |
| -------------------------------- | ----: | -------------------------------------------------------- |
| PRs                              |     5 | none merged                                              |
| Lead                             |     1 | lead                                                     |
| Implementers PR-1, PR-2, PR-4    |     3 | money                                                    |
| Implementers PR-3, PR-5          |     2 | default                                                  |
| CI triage (wp20, liveness, #399) |     3 | default                                                  |
| CI checker (8 checks)            |     1 | cheapest                                                 |
| Codex reviews                    |     5 | one per PR; findings on #396 and #399 (P1 fixed in #398) |
| CI cycles                        |     - | #396 2, #397 1, #398 3, #399 2, #400 2                   |

CLI usage numbers: not shown to the lead in this session.
