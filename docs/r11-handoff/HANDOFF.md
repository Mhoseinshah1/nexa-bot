# Handoff — NEXA-MASTER-NEXT (owner's `_prompts/NEXA-ALL.md`), after Phase 1

Resume: the owner says "Continue NEXA-MASTER-NEXT from the latest handoff". Re-read
`_prompts/NEXA-ALL.md` (master section + the current phase section) and this file. Skills were
slimmed in Phase 0; read them fresh. The older R11 handoff is in this branch's history
(`git show 6b2515f:docs/r11-handoff/HANDOFF.md`); its PR texts and scripts are kept here.

## main

`main` = 767576f (after #357). Migrations end at 0295. Push CI was green on 76921ca and
7105aa2; check e93baa4 with `bash scripts/claude/ci-status.sh e93baa4`.

## Phases

| Phase              | State       | PRs                                                                                                                                                       |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 token diet       | merged      | #352 (01c9d70); plus owner add-on `chore/codex-self-request` #353 (19117cd)                                                                               |
| 1 open R11 Phase A | merged      | #349 A4 (c26ff7e), #351 A10 (a8daa8b), #355 main-red test fix (7105aa2), #354 A11 (76921ca), #356 A8 (e93baa4)                                            |
| 2 fixes            | IN PROGRESS | hotfix #357 merged (767576f). Agents running (local, not pushed): F1 `fix/r12-money-edges`, F2 `fix/r12-security-reliability`, F3 `fix/r12-ux-quick-wins` |
| 3–6                | not started |                                                                                                                                                           |

Phase 1 report (to commit as `docs/round-reports/phase-1.md` with the next suitable PR): it is
in the session scratchpad, so if lost, rebuild it from the PR descriptions above.

## Owner decisions this session (binding)

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

## Next step

Wait for the F1 / F2 / F3 agents; lead-review each diff (F3 gets an Opus review), push, open the
PR, post `@codex review`, CI, one fix commit, merge. Then the phase-2 report + comment on #358.
