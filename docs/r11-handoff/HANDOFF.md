# Handoff — v0.9.5 fix round — DONE, STOPPED (Phase 6 next, NEW session)

Resume: the owner starts Phase 6 in a new session. Read this block, `docs/round-reports/v095-fixes.md`
(#390), then `docs/r11-handoff/phase5-decisions.md` only if a Phase 5 decision is cited.
Older blocks (Phase 5, 4, 3, NEXA-MASTER-NEXT) are in `docs/r11-handoff/ARCHIVE.md`; read a section only
when this file points to it.

## State

- Round prompt: `NEXA-FIX-V095.md` (fixes from the owner's v0.9.4 test). Issue #358 comment «اصلاحات تست v0.9.4».
- main = 83109e52 (PR-4) plus the report PR #390. Re-verify with `git fetch origin main`.
- Migrations end at 0309 (0307 PR-3, 0308 and 0309 PR-4).

## PRs (all merge commits, one Codex review each)

| PR   | #   | Merge    | Note                                                                                      |
| ---- | --- | -------- | ----------------------------------------------------------------------------------------- |
| PR-0 | 383 | efda52ab | budget rules in skills; reminder-test fix                                                 |
| PR-2 | 384 | 23d1b891 | custom naming, flag removed                                                               |
| PR-1 | 386 | af406ddc | features page                                                                             |
| PR-5 | 385 | 8ebb7f19 | mini app layout; Codex fix: long plan title overflow                                      |
| PR-6 | 387 | dc65ab47 | reseller edit; Codex fix: tab switch lost sub-editor edits                                |
| PR-3 | 388 | aa8bad55 | custom panel files; CI fix: stale capability pin from PR-2                                |
| PR-4 | 389 | 83109e52 | phone gate, exemptions, late Stars; Codex fix: Bot API 6.9 check; CI fix: Stars test to G |

## Owner decisions in force

- Budget rules (PR-0, in `nexa-round-pipeline` and `nexa-handoff`): lead on the money tier and thin;
  at most 2 implementers; one phase per session; report 150 lines, chat 20, issue comment 40; handoff 120.
- PR-6: no reason dialog for sensitive reseller actions (OQ-V095-01). PR-3: delivery options live on the
  panel page (OQ-C2-10). PR-4: OQ-V095-P4-01..05 (see `docs/open-questions.md`).
- Standing rules unchanged: `docs/project-status.md`, `CLAUDE.md`.

## Owner decisions (binding, carried from Phase 5; full history in ARCHIVE.md)

- 2026-11-01: the MirzaBot cutover is POSTPONED (blocked on an importer issue the owner handles
  separately). This overrides "stop after Phase 2 and wait for the cutover". Phase 3 ran and merged;
  Phase 4 (`NEXA-PROMPT-SAI.md` ONLY) starts in a NEW session.
- 2026-11-01 Phase 3 scope: no screenshots, no screenshot script, no demo seed, no chat mocks (a
  follow-up for the final release); a text wordmark; README.fa.md is for non-technical readers; only
  its commands must match README.md / botctl help (`pnpm check:readme`).
- Session rules (repeat each session): Sonnet lead for coordination; at most 2 implementers; one
  fresh Opus reviewer only for money/security/installer-verification PRs; mutation checks only for
  money/security/guard code; one blocking wait per CI run; per PR: push, `@codex review` yourself,
  first complete review only, ONE fix commit, green CI on the exact head (SHA from `git rev-parse`),
  merge.

- 2026-10-31 (after a container restart): every agent with uncommitted work pushes a WIP backup
  now and after each meaningful step to a SEPARATE branch `wip/<branch-name>`, never to a PR
  branch (a PR branch still gets exactly one fix commit). Fast-forward only (no force-push):
  snapshot with a temporary index + `git commit-tree -p HEAD -p <previous wip tip>`, push to
  `refs/heads/wip/<branch>`. Delete the `wip/` branches after each PR merges. Live now:
  `wip/fix/r12-money-edges`, `wip/fix/r12-security-reliability`,
  `wip/fix/r12-webhook-secret-per-bot`, `wip/fix/r12-ux-quick-wins`.

- 2026-10-31 token-budget rules, binding FROM THE NEXT SESSION (in-flight Phase 2 keeps its
  models and rules):
  1. One phase per session: when a phase ends, write the phase report + handoff and STOP; the
     owner starts a fresh session for the next phase.
  2. Lead = Sonnet for coordination. For money/ledger/payment/security PRs spawn ONE fresh Opus
     reviewer per PR for the lead review; implementers stay as the plan says.
  3. Mutation checks only for money, security and guard changes; UI/text/docs PRs skip them.
  4. No repeated wait tasks; one blocking wait per run.
  5. Disable unused connectors/MCP tools in the session where possible.

- 2026-10-31 (budget): after Phase 2 merges, STOP — write the Phase 2 report and this handoff,
  then wait for the owner (the owner runs the MirzaBot cutover first). Until then at most 2
  implementers at a time. Later: Phase 4 = `NEXA-PROMPT-SAI.md` ONLY (SAI-QUALITY and SAI-GUIDE
  deferred). Do not start Phase 3 without the owner's go.

- 2026-10-31: ONE GitHub issue «گزارش‌های NEXA-ALL» is the owner's report channel:
  https://github.com/Mhoseinshah1/nexa-bot/issues/358 (reuse it; never open another). At the end
  of EVERY phase, and whenever something is Blocked or an owner decision is needed, post one
  comment via REST: `gh api repos/Mhoseinshah1/nexa-bot/issues/358/comments -F body=@<file>`.
  It holds the ≤ 20-line Persian summary, PR links, and any question. GitHub emails the owner.
  Already posted: Phases 0–1 plus Phase 2 progress (issuecomment-6544213190).

- 2026-10-31: the lead posts `@codex review` itself right after opening a PR or pushing a head that
  needs its one review; at most 2 per PR; act on the FIRST complete review of a head only; never
  request after the fix commit. Recorded in `nexa-round-pipeline` §3 (#353).
- 2026-10-31: main-red test fix as its own PR, merged before A11/A8; A11/A8 brought onto the
  green main (done by merge, not rebase: no force-push).

## Open questions for the owner

- OQ-V095-01 (reseller sensitive actions need an API reason/credit-cap/demotion action to get a dialog).
- OQ-C2-09, OQ-C2-10 (custom panel delivery and capability behaviour).
- OQ-V095-P4-01..05 (phone gate exemptions, late Stars scope, exemption on account transfer, B applies with A off,
  mini app contact via the bot chat).
- OQ-R11-B7-03 from Phase 5 (check `docs/open-questions.md`; B7-01 superseded, B7-02 resolved, B5-04 closed by PR-4).
- OQ-R12-F3-02 (asked on #358): TonPays rate-limited cancel retry wording.
- OQ-C2-02: no real custom bridge has been accepted against Nexa yet (protocol doc §12).

## Notes for the next session

- Reminder test: `customer-reminder-opt-out.test.ts` failed nightly 20:30-00:30 UTC on main (now()+20h on
  the same Tehran day); fixed test-only in #383. If a similar clock-window test fails at those hours, suspect
  the same shape before suspecting product code.
- `list-search-plan.test.ts` `beforeAll` hook timed out once on a slow runner and turned main red at dc65ab47;
  it passed on one re-run. Not a product fault. If it recurs, raise the hook timeout rather than re-running blindly.
- `custom-menu-buttons` web test timed out once on #388 (1 s `waitFor`); passed on re-run. Watch for it.
- Locally the 7-Zip backup unit tests fail in cloud containers (no `7z`); CI has it.
- Evidence screenshots: branch `evidence/v095` (never merge it); linked from #386, #385, #387.

## Not done on purpose

- No tag pushed, no server updated, Phase 6 not started. `phone_verification` stays off by default
  (allowed numbers default to all), so existing installs are unchanged until the owner acts.

## Cleanup

- Worktrees and test databases created in this round: removed (verify with `git worktree list` and `psql -l`).
- Branches the session could not delete (owner): chore/v095-token-diet, chore/v095-custom-naming,
  feat/v095-features-page, fix/v095-miniapp-layout, fix/v095-reseller-edit, feat/v095-custom-panel-files,
  feat/v095-phone-and-exemptions, docs/v095-round-report, and the older ones listed in
  ARCHIVE.md (§ Open for the owner). Keep evidence/v095.

## Next step

STOP. The owner starts Phase 6 in a NEW session: fetch main, confirm CI green on its head, read #358.
