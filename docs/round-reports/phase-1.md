# Phase 1 — finish open R11 Phase-A work

Merged in this order, each with a merge commit, CI green on the exact head, and the one Codex
review acted on in one fix commit. Full detail is in each PR description.

| PR                                                        | Item                                                      | Merge   | Codex (head reviewed) → fix           | Notes                                                                |
| --------------------------------------------------------- | --------------------------------------------------------- | ------- | ------------------------------------- | -------------------------------------------------------------------- |
| [#349](https://github.com/Mhoseinshah1/nexa-bot/pull/349) | A4 files-only delivery + RickPanel QR kind (0294, 0295)   | c26ff7e | 1×P2 (4d29f067) → ee59f1ef            | CI fix 4fcbf1b: A9's fixture lacked `qrKinds`                        |
| [#351](https://github.com/Mhoseinshah1/nexa-bot/pull/351) | A10 TonPays paced client per key                          | a8daa8b | 1×P2 (9225e6bd) → 63599631            | main merged twice                                                    |
| [#355](https://github.com/Mhoseinshah1/nexa-bot/pull/355) | main red: schedule test waits for the row's own first ask | 7105aa2 | none (cf54de4)                        | test file only; mutations M-A/M-B                                    |
| [#354](https://github.com/Mhoseinshah1/nexa-bot/pull/354) | A11 ended order answered on its own payment message       | 76921ca | 5 comments = 3×P2 (c0cdff4) → a4f30b4 | M1–M8 + 3 fix mutations                                              |
| [#356](https://github.com/Mhoseinshah1/nexa-bot/pull/356) | A8 TonPays cancel retry                                   | e93baa4 | 1×P2 (05b37c9) → 2815266              | lead review found a HELD-cancel bug (eac8225, 5e00268); 19 mutations |

## Decisions taken

1. "Rebase A11/A8 on the green main" was done as `git merge origin/main`. Those branches were
   already pushed, and CLAUDE.md and the master plan forbid force-push.
2. My first diagnosis of main's red (#355), that A10's per-key bucket outlived a test, was
   wrong. This suite's fixture has no limiter. The cause was the 15 s ±10 % first-ask jitter
   against a fixed 16 s advance. The PR says so.
3. A11 Codex fix 2: only the sweep's EXPIRED state makes an awaiting order "ended". Up to one
   minute after the deadline, a tap gets the pre-A11 refusal (OQ-R11-A11-04: that refusal's
   text «… لطفاً دوباره سفارش دهید.» is left for the owner).
4. A8: a customer cancel HELD by the local limiter is requeued, not spent, and only while it
   would be due inside the customer window. A delayed retry that would end after the window
   writes no row (Codex #356).

5. Owner, 2026-10-31: OQ-R11-A11-04 is a bug text (same class as R12 F3.6). A customer with a
   still-live payment must not be told to "order again". New wording: the payment is still being
   checked, do NOT pay again, the result will come in the bot, with a button to the order/payment
   status. Added to F3 as a NEW key for that case. `bot.order.expired` stays correct for a draft
   past its hold.
6. Owner, 2026-10-31: the A8 rate-limited cancel gets a NEW key with an accurate sentence (the
   cancel request is queued and will be retried automatically; nothing to do; do not pay again).
   Added to F3.

## Follow-ups (not done)

- A8: `cancelOffered` (the button read) does not apply the deadline bound. In the last ≤ 30 s
  after a rate-limited cancel, the button can show; the tap only redraws. No money moves.
- A8: `gateway_cancel_unknown` says the answer "was not received", which is only approximate for
  a readable `RATE_LIMIT_EXCEEDED`. A new sentence would be a new key (owner's call).
- Local sandbox: `createdb` hangs (password prompt). Use `psql postgres://nexa:nexa@…/postgres -c
'create database …'`. The backup 7-Zip unit tests need `7zz` (CI installs it; green there).

## Usage

| PRs | Agents                       | Model per agent                             | CI cycles                              | CLI usage                                  |
| --- | ---------------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| 5   | 4 (A4 CI fix, A11, A8, lead) | A4 fix: default; A11, A8: money; lead: lead | #349 1, #351 2, #355 1, #354 2, #356 2 | A11 ≈ 260k tokens, A8 ≈ 284k, A4 fix ≈ 77k |
