# Handoff — v0.9.7 fix round — 5 PRs green, AWAITING OWNER MERGE (Phase 6A next, NEW session)

Resume: read this file and `docs/round-reports/v097-fixes.md` (in the report PR, `docs/v097-round-report`).
Older blocks (v0.9.5, Phase 5, 4, 3) are in `docs/r11-handoff/ARCHIVE.md`; read a section only when cited.

## State

- Round prompt: `NEXA-FIX-V097.md`. Issue #358 comment «اصلاحات v0.9.7 — دیتابیس و بکاپ سبک‌تر» is drafted, NOT posted.
- main = 4f36aa2c (PR #395, v0.9.6 report) at the start; none of this round is merged. Re-verify with `git fetch origin main`.
- The session's safety layer refused the merge call ("merge without review") despite the round's merge permission.
  The owner merges, as merge commits, in this order. Trial merge of all five onto 4f36aa2c: conflict-free.
- Migrations on the PRs: 0311, 0312 (#398), 0313 (#400, renumbered from 0311, SQL byte-identical).

## PRs (all CI-green on the final head, Codex-reviewed, NOT merged)

| Order | PR   | Branch                                | Head     | Note                                                                |
| ----- | ---- | ------------------------------------- | -------- | ------------------------------------------------------------------- |
| 1     | #396 | fix/v097-web-polish-and-menu          | 94475d4d | polish + grouped menu; Codex P2 touch-hover/selected rows fixed     |
| 2     | #397 | fix/v097-cutover-journal              | c638d613 | atomic journal write, alert on unreadable one; Codex clean          |
| 3     | #398 | feat/v097-import-auto-cleanup         | 0d00e142 | auto cleanup; Codex P1 (raised on #399) fixed here; CI fix 0254f970 |
| 4     | #399 | chore/v097-remove-legacy-invoice-card | 2afca15f | stacked on #398; liveness test given a timing margin                |
| 5     | #400 | perf/v097-lean-backups                | f08f4528 | stacked on #398; retention, lean backup, `backup-verify` CPU cap    |
| 6     | docs | docs/v097-round-report                | see PR   | the report; merge LAST                                              |

## Done

- Cleanup after a clean import, retention defaults, lean backups, capped verify-restore, atomic cutover journal,
  grouped menu and polish, per-invoice outcome card removed. Detail in each PR body and the report.

## Unresolved

- The < 50 MB / one-part backup goal is NOT met: 200k-customer fixture 103 MiB/3 parts after import, 74/2 after
  the cleanup, 64/2 after 7 days of E3, 51/2 without the importer's idempotency keys.
- No before/after DB table sizes were measured (fixtures too small); real numbers appear after the owner's fresh import.
- CPU at the 70% setting (4 vCPU, 1.0 GB dump): whole run 67.8% of one core; peak 5-s window 144%.

## Owner decisions (binding)

- Standing rules: `docs/project-status.md`, `CLAUDE.md`. Budget rules: `nexa-round-pipeline`, `nexa-handoff`.
- This round: no manual «پایان انتقال» button (cleanup is automatic); operational history lives in the Telegram
  operations group; the audit log stays (hence OQ-V097-P2-01); verification of a backup stays mandatory.

## Open questions for the owner

- OQ-V097-P2-01 audit log 90-day retention (`audit_logs` is append-only by trigger). OQ-V097-P2-02 remove the
  importer's own idempotency keys in the cleanup. Both in `docs/open-questions.md` on #400.
- Older: OQ-V095-01, OQ-C2-09, OQ-C2-10, OQ-V095-P4-01..05, OQ-R11-B7-03, OQ-R12-F3-02, OQ-C2-02.

## Not done on purpose

- Imports recorded before this release are never auto-cleaned (no reconciliation recorded). The trial limit 0 the
  import wrote is lifted by the cleanup; until it runs, imported customers cannot take a trial.
- `GET /legacy-services` kept (held-services review lane). `migration:0311_compaction_mode_apply` audit label kept.
- `backup-verify` reads a changed CPU setting only at the next `botctl restart`.
- No tag pushed, no server updated, no screenshots for the polish, Phase 6A not started.

## Notes for the next session

- Planner-dependent tests flaked this round (`public-codes`, `wp20-outbox-retry`): fixed by pinning the plan. If a
  similar index-check test fails on a small table, suspect the planner before product code.
- Locally the 7-Zip backup unit tests fail in cloud containers (no `7z`); CI has it.

## Cleanup

- Worktrees and test databases created by the round: removed (verify with `git worktree list`, `psql -l`).
- Branches the session could not delete (owner): the five PR branches above, `docs/v097-round-report`, and the
  older ones in ARCHIVE.md (§ Open for the owner).

## Next step

After the owner merges #396-#400 and the report PR in order: fetch main, confirm CI green on its head, tag
`v0.9.7`, run the checklist in the report. Then STOP: Phase 6A starts in a NEW session.
