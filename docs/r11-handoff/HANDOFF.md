# Handoff — NEXA-MASTER-NEXT (owner's `_prompts/NEXA-ALL.md`), after Phase 1

Resume: the owner says "Continue NEXA-MASTER-NEXT from the latest handoff". Re-read
`_prompts/NEXA-ALL.md` (master section + the current phase section) and this file. Skills were
slimmed in Phase 0; read them fresh. The older R11 handoff is in this branch's history
(`git show 6b2515f:docs/r11-handoff/HANDOFF.md`); its PR texts and scripts are kept here.

## main

`main` = e93baa4 (after #356). Migrations end at 0295. Push CI was green on 76921ca and
7105aa2; check e93baa4 with `bash scripts/claude/ci-status.sh e93baa4`.

## Phases

| Phase              | State       | PRs                                                                                                                                                                                                                                         |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 token diet       | merged      | #352 (01c9d70); plus owner add-on `chore/codex-self-request` #353 (19117cd)                                                                                                                                                                 |
| 1 open R11 Phase A | merged      | #349 A4 (c26ff7e), #351 A10 (a8daa8b), #355 main-red test fix (7105aa2), #354 A11 (76921ca), #356 A8 (e93baa4)                                                                                                                              |
| 2 fixes            | IN PROGRESS | agents running (local branches, not pushed): `fix/r11-discount-button-bidi` (hotfix), `fix/r12-security-reliability` (F2), `fix/r12-money-edges` (F1). F3 `fix/r12-ux-quick-wins` not started (start when a slot frees; max 3 implementers) |
| 3–6                | not started |                                                                                                                                                                                                                                             |

Phase 1 report (to commit as `docs/round-reports/phase-1.md` with the next suitable PR): it is
in the session scratchpad, so if lost, rebuild it from the PR descriptions above.

## Owner decisions this session (binding)

- 2026-10-31: the lead posts `@codex review` itself right after opening a PR or pushing a head that
  needs its one review; at most 2 per PR; act on the FIRST complete review of a head only; never
  request after the fix commit. Recorded in `nexa-round-pipeline` §3 (#353).
- 2026-10-31: main-red test fix as its own PR, merged before A11/A8; A11/A8 brought onto the
  green main (done by merge, not rebase: no force-push).

## Decisions taken

See `docs/round-reports/phase-1.md` (pending commit): rebase→merge; #355 diagnosis correction;
A11 trusts only the sweep's EXPIRED; A8 HELD-cancel requeue bounded by the customer window.

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

Wait for the hotfix / F2 / F1 agents; lead-review each diff, push, open the PR, post
`@codex review`, CI, one fix commit, merge. Start F3 (Sonnet implements, Opus reviews) when a slot frees.
