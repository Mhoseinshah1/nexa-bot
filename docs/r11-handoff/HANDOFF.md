# Handoff — Phase 4 (Support AI) — DONE, STOPPED (Phase 5 next, NEW session)

Resume: the owner starts Phase 5 in a new session. Read this block, then the older blocks below.

- main = 0d25a29 (after #372). Phase 4 merges, in order: #365 PR-1 a8fb982, #366 PR-5 e67879b, #367 PR-2 48d2db2,
  #369 PR-3 84e1f58, #371 PR-4 e0f6f31, #370 PR-6 dfd14a2, plus owner-requested #372 (gift-card test, 0d25a29).
  CI green 23/23 on every merged head. Migrations end at 0301.
- Round report: `docs/round-reports/phase-4.md` on THIS branch — carry it into main with Phase 5's first PR (D20).
- Owner report posted: https://github.com/Mhoseinshah1/nexa-bot/issues/358#issuecomment-6563735102
- OFF by default (owner turns on in Web Admin): support.ai.actions_enabled, support.ai.tickets_enabled,
  support.knowledge.auto_refresh, support.ai.label_enabled. Buttons on Business messages unverified live (OQ-SAI-3-01).
- Eval offline: legacy config 12/37 everyday without handoff → preset 37/37; hard 16/16; 45 attacks / 112 trials:
  0 leaks, 0 promises, 0 tool escapes (pipeline ceiling, scripted provider).
- Gift-card CI failure (gift-cards-http.test.ts:172): test bug, not a leak (regex matched digit groups in UUID ids);
  fixed by #372 (D21).
- Incident D13: one `@codex review` was posted on the owner's #368 by mistake and deleted within seconds.
- Branches for the owner to delete (the session cannot): fix/sai-handoff-policy, feat/sai-admin-ux,
  feat/sai-knowledge-live, feat/sai-actions, feat/sai-bot-tickets, chore/sai-eval, fix/gift-card-code-assertion,
  wip/feat/sai-bot-tickets — plus the older list below.
- Phase 5 note (owner, 2026-10-31) below still applies.

---

# Handoff — NEXA-MASTER-NEXT (owner's `_prompts/NEXA-ALL.md`), after Phase 3 — STOPPED (Phase 4 next, new session)

Resume: the owner says "Continue NEXA-MASTER-NEXT from the latest handoff". Re-read
`_prompts/NEXA-ALL.md` (master section + the current phase section) and this file. Skills were
slimmed in Phase 0; read them fresh. The older R11 handoff is in this branch's history
(`git show 6b2515f:docs/r11-handoff/HANDOFF.md`); its PR texts and scripts are kept here.

## main

`main` = e3f67a8 (after #364). CI green on every merged head. Migrations end at 0295.
Check main's push CI with `bash scripts/claude/ci-status.sh e3f67a8`.

## Phases

| Phase              | State       | PRs                                                                                                                                                                |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 token diet       | merged      | #352 (01c9d70); plus owner add-on `chore/codex-self-request` #353 (19117cd)                                                                                        |
| 1 open R11 Phase A | merged      | #349 A4 (c26ff7e), #351 A10 (a8daa8b), #355 main-red test fix (7105aa2), #354 A11 (76921ca), #356 A8 (e93baa4)                                                     |
| 2 fixes            | merged      | #357 hotfix (767576f), #359 F2 (d29b130), #360 F1 (1ef32e2), #361 F2.7 per-bot webhook secret (4a40484), #362 F3 (45de2f4); report `docs/round-reports/phase-2.md` |
| 3 README+installer | merged      | #363 PR-1 installer assets (3a1b499), #364 PR-2 README (e3f67a8); report `docs/round-reports/phase-3.md` on THIS branch (carry it to main in Phase 4's first PR) |
| 4–6                | not started |                                                                                                                                                                    |

Phase 1 and Phase 2 reports are on main: `docs/round-reports/phase-1.md`, `phase-2.md`.

## Owner decisions (binding)

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

## Decisions taken

See `docs/round-reports/phase-1.md` (pending commit): rebase→merge; #355 diagnosis correction;
A11 trusts only the sweep's EXPIRED; A8 HELD-cancel requeue bounded by the customer window.

## Phase 5 note (owner, 2026-10-31; act on it only when Phase 5 starts)

R11 B1/B2/B3 already have pushed work from 2026-10-27: `feat/r11-notification-centre` (WIP),
`feat/r11-usage-chart`, `feat/r11-referral-list`. Continue from those branches (merge latest
`main` into them, finish, PR) instead of rebuilding. If a branch's approach no longer fits main,
keep its intent and tests and record why (in the PR and `docs/round-reports/phase-5.md`).

Lead observation, not an owner instruction: origin also has `feat/r11-miniapp-stars` (98020f4),
`feat/r11-phone-verify` (a575f4d), `feat/r11-location-remaining` (ecb8266),
`feat/r11-reminder-optout` (ce8c5f3), `feat/r11-cutover-rehearsal` (cad6904) and
`feat/r11-ops-log-service-username` (e1c7064). Their state is not verified. Before building an
R11 B/C item, check whether one of these already carries it.

## Owner answers (2026-10-31, binding; both go into F3)

- OQ-R11-A11-04: change it — a still-live payment must never read "order again". NEW key for that
  case: payment still being checked, do NOT pay again, result comes in the bot, button to the
  order/payment status. (`bot.order.expired` stays for a draft past its hold.)
- A8 rate-limited cancel: NEW key, accurate sentence — the cancel request is queued and retried
  automatically; nothing to do; do not pay again.

## Sandbox notes

- `createdb` hangs here; use `psql postgres://nexa:nexa@127.0.0.1:5432/postgres -c 'create database …'`.
- backup 7-Zip unit tests need `7zz` (CI installs it; green there).
- `/home/user/nexa-bot` is on an OLD commit (adbe45b); run repo scripts from a worktree of
  `origin/main` (`/home/user/wt-main`).
- The sandbox's shellcheck (0.11) misses some SC2015 that CI flags; grep new deploy shell for
  `A && B ||` before pushing.

## Open for the owner

- OQ-R12-F3-02 (asked on #358): make a provider-rate-limited TonPays customer cancel retry inside the
  window and switch to the owner's wording (recommended), or keep F3's accurate wording.
- The session cannot delete branches. Owner deletes: `wip/fix/r12-money-edges`,
  `wip/fix/r12-security-reliability`, `wip/fix/r12-webhook-secret-per-bot`, `wip/fix/r12-ux-quick-wins`,
  `ci/release-installer-assets`, `wip/ci/release-installer-assets`, `docs/readme-pro`.
- Phase 3 low items (not fixed): release re-run `--clobber`, draft-release lookup, publish summary's
  clone-mode command (see phase-3.md).
- Merge tool lesson: pass the head SHA from `git rev-parse`, never typed (see phase-2.md).

## Next step

Phase 3 merged and reported on #358. STOP. A NEW session starts Phase 4 = `NEXA-PROMPT-SAI.md` ONLY
(SAI-QUALITY and SAI-GUIDE deferred), under the session rules above. Its first PR also carries
`docs/round-reports/phase-3.md` from this branch to main.
