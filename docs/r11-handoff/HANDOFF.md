# Handoff — NEXA Round 11 (paused for budget, 2026-10-27 ~14:30Z)

Round prompt: `NEXA-PROMPT-R11.md` (owner upload) + owner additions in chat (A7–A11, A4 QR kind, see below).
Read first on resume: `CLAUDE.md`, skills `nexa-round-pipeline` (§1a runner), `nexa-handoff`, this file.
PR description drafts for every item: `docs/r11-handoff/pr-texts/` on this branch.
Owner decisions this round are under "Decisions"; owner rules: Codex not started ~15 min after a PR opens → tell the owner (they comment `@codex review`); never hold merges assuming Codex is missing. Checklist ends with `sudo botctl roles disable provisioner monitor` (intentional).

## main

`main` = **3850c500** (after #350). Migrations on main end at **0293** (`0293_process_runs`).

## Merged (merge commit · Codex · CI)

| Item                                                                                | PR   | Merge    | Codex (head reviewed) → fix       |
| ----------------------------------------------------------------------------------- | ---- | -------- | --------------------------------- |
| P0 agent rules / run-gate.sh / renumber `-m` fix                                    | #342 | 341205e5 | 2×P2 (6815789f) → 230f58e4        |
| A5 Telegram 10.2 compat (tests + OQ)                                                | #343 | e758cf6f | none                              |
| A3 crash-loop < 60 s ops message (0293)                                             | #344 | 864f4636 | 1×P2 (5e1c3506) → f9b8145f        |
| A6 R10 follow-ups (UUID ids, L8/L9 MIRZA, card offered, confirm refuses commercial) | #345 | 63472cd9 | none                              |
| A7 ops-log «👤 نام کاربری سرویس»                                                    | #346 | b6f97a50 | none; CI fix 4bed29a5 (test fake) |
| A2 `botctl cutover rehearse`                                                        | #347 | 60c399f1 | none; CI fix 9149536a (SC2015)    |
| A1 Web Admin demo parity (+A1.1 new-customer count)                                 | #348 | cdf0bc3a | none                              |
| A9 personal-discount price lists                                                    | #350 | 3850c500 | none                              |

## Open PRs (not merged)

| Item                                               | PR   | Branch · last pushed                      | State                                                                                                                                                                                                     | Exact next step                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4 files-only + RickPanel «نوع بارکد» (0294, 0295) | #349 | `feat/r11-files-only-delivery` · a797cd05 | Codex 1×P2 FIXED in ee59f1ef (reply posted, thread not resolved — GraphQL blocked). CI RED: `tests/web/miniapp-personal-discount.test.tsx` (from A9) fails on the merged head — store never shows «تمدید» | Reproduce: `pnpm exec vitest run --project web tests/web/miniapp-personal-discount.test.tsx` in the branch; A4 changed the mini-app wire/projection (files-only/QR fields) and A9's fixture or the renewal button visibility no longer matches. Fix in one commit, push, CI green, merge. Then renumber nothing (A4 owns 0294/0295 on main next). |
| A10 TonPays rate limiter (call-rate table below)   | #351 | `fix/r11-tonpays-rate-limit` · 90bf501b   | Codex 1×P2 FIXED in 63599631 (reply posted). CI on 90bf501b was green 17/pending 5 at pause                                                                                                               | Check CI on 90bf501b (`bash scripts/claude/ci-status.sh 90bf501b`); green → merge main into it if main moved, else merge. Must merge BEFORE A8 cancel-retry.                                                                                                                                                                                      |

## Done, PR not opened (open only after Phase A merges; merge origin/main first, renumber migrations after rebuilding contracts)

| Item                                       | Branch · last pushed                      | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A8 TonPays cancel retry                    | `fix/r11-tonpays-cancel-retry` · 70472a30 | Merged A10's older head 5acde472. After A10 merges: merge origin/main, run `gateway-inquiry-schedule` + tonpays-telegram suites, open PR. Lead review pending (money).                                                                             |
| B2 usage chart (migration 0294 → renumber) | `feat/r11-usage-chart` · 84272291         | Done; lead review pending. Renewal write site has no dedicated test.                                                                                                                                                                               |
| B4 location remaining                      | `feat/r11-location-remaining` · ecb82669  | Done; no flag, no migration; lead review pending.                                                                                                                                                                                                  |
| B5 mini app Stars (`openInvoice`)          | `feat/r11-miniapp-stars` · 98020f47       | Done; flag `miniapp_stars_invoice` OFF. RISK OQ-R11-B5-01: chat invoice + in-app link paid within seconds can double-charge (2nd = mismatch, operator refund); fixing needs a bot pre-checkout change — owner's call. Lead review pending (money). |

## In progress at pause (WIP pushed)

| Item                                               | Branch · last pushed                            | State                                                                                                                                                                                                                                                                                                                                   | Exact next step                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A11 order expiry edit-in-place                     | `fix/r11-order-expiry-edit-in-place` · 75c0aae0 | Feature + owner's fuller spec done; integration (12 new + notification-invariants + payment/order/TonPays/refund guards) green; static + build green. Only mutation M1 run (6 tests red). Cause of the 3 messages (11:09/11:11/11:16): one expiry message per payment attempt + one new message per tap on a stale button — both fixed. | Run mutations M2–M8 with `docs/r11-handoff/scripts/a11-mutate.py M2` … (from `/home/user/r11-a11`, through `run-gate.sh --integration --raw`; `git status` clean after each); re-run `tests/unit/backup-cli.test.ts` after `pnpm build`, `pnpm test:web`, `test:deploy`, `check:shell`; fill `MUTATION_TABLE` in `pr-texts/r11-a11-PR.md`; lead review; open PR after A10/A8.                         |
| B1 notification centre (migration 0294 → renumber) | `feat/r11-notification-centre` · b6eb64c1       | Nearly done: contracts, backend, 3 mini-app routes, UI, docs. typecheck/lint/format/boundaries/i18n/db:check green; integration notification-centre 28/28, related suites 162/162; web 43/43; 8 unit/web mutations red.                                                                                                                 | DB-side mutation run (13): `docs/r11-handoff/scripts/b1-mutate1.py` in a fresh worktree of the branch, then `notification-centre.test.ts`. Write PR text. Lead review.                                                                                                                                                                                                                                |
| B3 referral friends list                           | `feat/r11-referral-list` · 01f4135a             | DONE: flag `referral_friends_list` OFF; MIRZA referrals listed (screen figure counts them; test pins it). Final run on clean head: integration 7/7, unit 6/6, registries 36, web 80; typecheck/lint/format/i18n green; mutations red.                                                                                                   | In `pr-texts/r11-b3-PR.md` fix two lines (unit-tests row → 6 tests; daily-cap mutation went red in the "every status" test); lead review; open PR once Phase A is merged.                                                                                                                                                                                                                             |
| B6 reminder opt-out (migration 0294 → renumber)    | `feat/r11-reminder-optout` · ce8c5f3b           | Half-done: built on every surface (flag `customer_reminder_opt_out` OFF; `customers.reminders_opt_out_at`; sweep skip; bot/mini app/Web Admin). Web 118 + unit 158 green. Integration RED only on the test's `setFlag` idempotency key (< 8 chars). No mutations.                                                                       | In `customer-reminder-opt-out.test.ts` make `key()` 8+ chars (`r11b6-key-${n}`); run the three `customer-reminder-opt-out*.test.ts` integration files; mutations (sweep skip, supersede guard, bot toggle, mini-app own customer, operator audit + permission); lint, db:check, check:i18n; write PR text. Note: operator control reuses `users.notifications.edit` (description says "promotional"). |
| B7 phone verification (migration 0294 → renumber)  | `feat/r11-phone-verify` · a575f4d9 (WIP)        | Half-done: contracts 7139ba82, migration f0858728 (`payment_gateways.requires_verified_phone`), service/rule/refusals/bot flow/Web Admin/docs/tests in WIP a575f4d9. API typecheck green; unit 210/1 (bot-runtime copy list).                                                                                                           | Add the new `bot.phone.*` keys and `bot.payment.phone_required` to the expected list in `tests/unit/bot-runtime.test.ts`; run `tests/integration/r11-b7-phone-verification.test.ts` (DB nexa_test_r11b7), web tests, lint, `pnpm verify`, mutations; write PR text; lead review (money-adjacent).                                                                                                     |

## Not started

- Phase C: C1 outbound webhooks (Opus), C2 reseller expiry.
- Phase D: D1–D5 hosted bots («میزبانی‌ها»).
- Phase E: E1–E5.
- End of round: cleanup, final report, v0.10.0 Persian release note, owner checklist.

## TonPays call rate (A10, for the final report)

| Situation                                     | Before (main)                              | After (A10)                                    |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| 1 fresh attempt, first 2 min                  | 6 checks/min (10 s)                        | 3/min (15 s, then 20 s)                        |
| N fresh attempts                              | 6N/min up to scheduled cap 30              | 3N/min; never above 30/min per key             |
| Checks per 70-min attempt                     | ~44                                        | ~38 (interval grows to 300 s)                  |
| «بررسی پرداخت» / webhook                      | up to 12/min per attempt                   | same, inside the key's pace; ≥60 s after a 429 |
| One 3 s worker pass (5 creates + 2×10 checks) | up to 25 calls back to back                | burst 3, then one every 2 s                    |
| Website key, worst rolling minute             | ~99 (fixed 50/min window vs documented 60) | ≤33                                            |
| Both routes on one TonPays account            | ~150                                       | ≤51                                            |
| Create retry after RATE_LIMIT_EXCEEDED        | ≤3 sends 15 s apart                        | same order id, ≤3, waits the pause             |
| Cancel/refund (Telegram route)                | 1 per request                              | same, paced and paused                         |

A tap only writes rows; re-tap / bot+mini app / replay reuse the open attempt, so the owner's two create 429s came from the worker's burst, not double taps. A bare 429 on create stays CREATE_UNKNOWN; only TonPays' `RATE_LIMIT_EXCEEDED` means "not created" (OQ-R11-A8-01/02).

## Decisions taken (round)

1. Per-PR branch names from the round prompt (not the session's single designated branch).
2. Phase A and B implementation started early; PRs opened only in phase order.
3. A1 split: A1.1 (reporting, Opus) on a sub-branch merged into A1; one PR.
4. Old scratch DBs from earlier rounds dropped (kept nexa_dev, nexa_test).
5. Labels: owner named cancel-retry A8 and personal-discount A9, so the TonPays rate limit is A10, order-expiry is A11.
6. A10 merges before A8; the limiter lives at the TonPays HTTP layer and covers cancel.
7. A11 kept on the Opus agent already running (owner suggested Sonnet + Opus review).
8. A7 relabelled the nine existing «🔑 نام سرویس:» lines to «👤 نام کاربری سرویس:» (owner named L10/L11); L8 left out (OQ-R11-A7-01).
9. A9: traffic/time packages keep their normal price (checkout doesn't discount them); tag uses Latin digits; pre-existing reseller package list < invoice left as OQ-R11-A9-05.
10. A1: Persian digits kept in server-written / @nexa/i18n strings (OQ-R11-A1-03); numbered pager only where the API returns a total.
11. B4: no new flag; Latin digits («2 از 3»); largest remaining across targets.

## Follow-ups found (not fixed)

- Card redactor still cuts card-shaped UUIDs in free-text log lines (A6 agent).
- A4 agent: `renumber-migration.sh` after a merge treated its first migration as hand-written and would fold both into one — verify the P0 fix covers this case.
- A3: a role crashing before the restart watch starts is not counted.
- A5: Telegram Mini App origin protection unverified (core.telegram.org unreachable) — OQ-R11-A5-01.
- Codex threads replied but not resolved (GraphQL blocked): #342 ×2, #344, #349, #351.

## Worktrees / DBs

All R11 worktrees (`/home/user/r11-*`) were removed at pause after confirming each branch was pushed and clean; recreate with `git worktree add /home/user/r11-<x> origin/<branch>`. Private test DBs `nexa_test_r11<x>` were left in the local Postgres (cheap; drop at round end). Migration numbers: main ends 0293; A4 owns 0294/0295 once merged; B1, B2, B6, B7 each carry a 0294 → renumber with `renumber-migration.sh` after `pnpm --filter @nexa/contracts build` (verify the A4-reported merge-commit case first).
