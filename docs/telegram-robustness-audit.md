# Telegram robustness — roadmap D1–D5 audit

Workstream D of the parallel roadmap (items 2–7, 2026-10-07): 429 and retry (D1), several
bots (D2), token and bootstrap resilience (D3), premium buttons and icons (D4) and media
(D5). Audit first: every send path was read before anything changed, and what was already
right is pinned by a test rather than rewritten.

Branch `roadmap/telegram-hardening`. No contract change, no migration.

## The rule, and where it lives

`CLAUDE.md` already states it: a 429 is not an unknown outcome and a timeout is not a rate
limit, and an UNKNOWN outcome is never retried and never queued again. Every Bot API call
of the product's send lanes goes through ONE call core, `telegramCall` in
`apps/api/src/infrastructure/telegram/send-message.ts`. Two other files call `fetch`
themselves, deliberately: the backup delivery (`telegram-backup-delivery.ts`, its own
three-way `SUCCEEDED / FAILED_DEFINITIVE / OUTCOME_UNKNOWN`, ADR-0025) and the file download
(`fetch-file.ts`, a read whose second leg is bytes, not a Bot API envelope). The backup copy
had the same unreadable-2xx defect and is fixed in this branch (PR #238 review N4). The call
core produces three things:

| Telegram's answer                                                                                         | call core                                                                      | meaning                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| a readable 4xx, or a 2xx whose body SAYS `ok: false`                                                      | `FAILED_PERMANENT`, `telegram.rejected.<code>`                                 | **definite refusal** — nothing delivered                |
| HTTP 429                                                                                                  | `FAILED_RETRYABLE`, `telegram.rate_limited`, `retryAfterMs` only when definite | **explicit 429** — declined, nothing delivered          |
| a 5xx, a timeout, a dropped connection, a 2xx that does not parse **or is not a Bot API answer** (D1 fix) | `FAILED_RETRYABLE`, any other code                                             | **unknown** — may have been delivered; never sent again |

Every lane recognises the 429 by its CODE (never by the presence of `retry_after`) and
reads every other retryable answer as unknown.

## D1 — 429 and retry

### Two defects fixed in the call core

1. **A 2xx that is not a Bot API answer was a definite refusal.** A 2xx whose body parsed
   but carried no `ok` (or was `null`, or a bare value) fell through to
   `telegram.rejected.200`. The one caller that retries a definite refusal — the
   messenger's single icon-less retry (`deliverDecorated`) — therefore sent the same
   message twice whenever a proxy or a truncation produced such a body. It is now
   `telegram.unreadable_response`, the unknown outcome. A 2xx that explicitly says
   `ok: false` is still a refusal.
2. **`retry_after` was trusted.** `retry_after * 1000` turned a string into `NaN` (and
   `null` into 0); `Math.max(NaN, floor)` is `NaN`; and the lanes' `new Date(NaN)` failed
   the very write meant to defer the message. `telegramRetryAfterMs` (exported) now carries
   a wait only when it is a finite, non-negative number, rounds a fraction UP (never
   shorter than asked), and holds it to `TELEGRAM_RETRY_AFTER_MAX_MS` (24 h): an early ask
   of a rate-limited request is safe — Telegram declines it again — and the ceiling keeps
   the lanes' `integer` `retry_after_ms` columns and date arithmetic valid. An indefinite
   429 is still a 429; the lane waits its own floor.

### Every send path, audited

| path                                                                | definite refusal                                          | 429                                                            | unknown                                    | evidence                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| customer messenger `send` / `sendFile` / `sendMediaGroup` / `edit*` | REFUSED; the ONE plain retry only for a decorated message | RATE_LIMITED + wait, never retried                             | UNKNOWN, never retried; a split body stops | `telegram-send-robustness`, `telegram-messenger-appearance`, `telegram-multi-bot` |
| customer notification lane (ADR-0030)                               | attempt spent, bounded                                    | `deferUntil` max(wait, floor), no attempt spent                | UNCONFIRMED, never re-claimed              | `customer-notification.service.ts`                                                |
| provisioning delivery / operation card                              | per lane                                                  | `recordRateLimited` / `holdAfterRateLimit`, no attempt spent   | UNCONFIRMED / `UNKNOWN`, not retried       | `delivery.service.ts`, `operation-card.ts`                                        |
| receipt push / refund push                                          | text fallback for a refused FILE only                     | requeued                                                       | not retried, no fallback                   | `receipt-review-push.service.ts`                                                  |
| interactive turn (`bot-runtime`)                                    | nothing queued                                            | the FACT is queued on the lane with Telegram's wait            | nothing queued (`OQ-4H-01`)                | `bot-runtime.ts` §fallback                                                        |
| business lane (TB2) and the **support AI** auto-reply               | FAILED + connection re-read                               | requeued at the wait                                           | UNCONFIRMED + hand-off                     | `business-transport.test.ts`, `telegram-send-robustness`                          |
| broadcast send / pin                                                | FAILED / UNREACHABLE / BOT_UNAVAILABLE                    | DEFER + the bot held, no attempt spent                         | UNCONFIRMED; an unknown pin is UNKNOWN     | `broadcast-transport.test.ts`, `telegram-send-robustness`                         |
| Stars invoice                                                       | REFUSED                                                   | RATE_LIMITED                                                   | UNKNOWN, never re-created                  | `telegram-stars.test.ts`, `telegram-send-robustness`                              |
| ops notifications (operators' group)                                | FAILED                                                    | throughput: allowance extended, dispatcher paused for the wait | **counted retry** — see below              | `telegram-transport.test.ts`, `telegram-send-robustness`                          |
| bootstrap / register / replacement / command sync                   | named error                                               | command sync backs off by max(wait, own)                       | fails with nothing changed, or read back   | `bot-bootstrap.test.ts`, `bot-token-replacement.test.ts`                          |

**Accepted, not changed:** the operators' notification lane retries an unknown outcome as an
ordinary counted attempt. It is documented as at-least-once (`docs/open-questions.md`, the
notification "delivered twice" DECISION): a duplicate alert in the operators' own group is
the price of never losing one, and it never reaches a customer.

**Open:** `OQ-TG-06` — a network error that certainly sent nothing (DNS, refused before
connect) is still filed UNKNOWN. Conservative on purpose; deciding otherwise needs a
real-network acceptance per cause.

## D2 — several bots

The token is always the bot the customer wrote to: `tokenForBotInstance(scope, id)` filters
by tenant, id AND `status = 'ACTIVE'`, and decrypts with a context bound to that row. No
token is cached, so a replacement is used by the very next send. Pinned against the real
database and a fake Bot API that answers each bot by its own token
(`tests/integration/telegram-multi-bot.test.ts`):

- customers of two bots of one tenant are answered by their own bot, never the other;
- a STOPPED bot sends nothing at all (no request) and opens the operator condition `NO_BOT`;
- a bot id from another tenant resolves to nothing;
- a `file_id` one bot received is sent by that bot; the other bot's attempt is refused once
  and never retried (tutorial videos and receipts are already stored per bot);
- a broadcast copy from a source chat only one bot can read: that bot sends, the other's
  recipient is terminal after one request;
- an ops message that names a bot goes through it; one that names none through the tenant's
  first active bot;
- a revoked token is REFUSED and named `TOKEN_REJECTED`; after replacement the new token is
  used immediately;
- a business connection re-made through another bot sends through THAT bot (unit).

**Finding for the campaign workstream (D2-F1), not changed here:** `classify` in
`telegram-broadcast.transport.ts` files a 400 "chat not found" as `UNREACHABLE` — the
RECIPIENT. For a COPY/FORWARD broadcast that sentence can be about the SOURCE chat the
recipient's bot cannot read, so every recipient of that bot is reported unreachable when the
source is the problem. Terminal either way and never retried; the misattribution is in the
report. The broadcast lane is owned by the campaign workstream.

## D3 — token and bootstrap resilience

Already in place (PR #229, not duplicated): `status` asks Telegram and decides from both
halves; `register` reads first, never drops the queue and reads back; every failed Web Admin
replacement is audited with its stage; `botctl update`/`rollback` warn on `unavailable`.

Added:

- **BotFather rename (`OQ-TG-02`, now resolved).** `getMe` naming the SAME bot id under a new
  username used to leave `bot_instances.username` stale for ever — and that copy is what the
  ops-group connect command (`/connect@<username>`), the Web Admin `t.me/…` links and every
  listing print. `register` / an installer rerun now records it
  (`BotBootstrapRepository.reconcileUsername`: same `telegram_bot_id`, row lock, a
  conditional UPDATE that refuses a name another row holds), audited
  `bot_instance.username_reconciled` SUCCESS, or FAILED with nothing changed. Never fatal to
  the registration: a `23505` from a concurrent writer of the same name (another tenant's
  lock does not serialise with this one) is the same TAKEN, and any other failure is
  UNRESOLVED and logged (review N2). The run's result carries `usernameReconcile`
  (`UPDATED` / `TAKEN` / `UNRESOLVED`) and the STORED username, so the CLI says "the stored
  username is now …" or warns that the name was kept — never "Nothing was changed" after a
  change (Codex P2, review N1). `status` shows the drift read-only as a `username` line on
  stderr (`usernameDrift`), and when another bot row holds the new name it says so instead of
  prescribing `register`, which could not help.
- **A revoked token in the customer lane** is now named: a refusal with Telegram's 401 (or
  404, a token path Telegram does not recognise — `OQ-TG-07`) opens the condition
  `telegram.customer_send_failed` under its OWN key, `…:<bot>:token`, whose sentence points
  at the Web Admin replacement. Its own row because the recorder rewrites `context` but
  never `message` on a repeat, and `message` is what the dashboard shows: on the shared row
  the remedy was either never shown or stuck to every later refusal (review B1, both orders
  pinned against the real recorder). A delivered send recovers both rows. Same code, a new
  key — no code was split or renamed.
- **The failure record is best effort** (Codex P1): a condition write that throws used to
  replace an UNKNOWN with an exception, and a lane that had stamped `markSendStarted` would
  reclaim and resend. Telegram's outcome now always reaches the caller.
- **`getMe` answered by a JSON 2xx with no `ok`** is `NOT_TELEGRAM` (wrong
  `TELEGRAM_API_BASE_URL`), not UNREACHABLE; a body that did not parse at all stays
  UNREACHABLE (review N5). The call core marks the first with `notBotApiAnswer`.
- Webhook state, the command menu refresh (`bot-command-sync`, max(wait, own back-off)) and
  connection status were audited and are unchanged.

## D4 — premium buttons and icons

Audited; the gates were already in place and are pinned by existing tests
(`telegram-inline-button-icons`, `telegram-reply-keyboard-wire`, `telegram-category-icons`,
`telegram-messenger-appearance`, integration `telegram-reply-keyboard`, `appearance-http`):

- an icon is drawn only for the SENDING bot's recorded eligibility (`mayCarryCustomEmoji`);
  an untested bot draws the label alone;
- the text and the route of a button are never altered by an icon (a separate field);
- a definite refusal of an iconed message is answered by the SAME message without icons,
  every label and style kept — exactly once; D1 adds that an unknown or a 2xx-without-`ok`
  answer never earns that retry (it used to, for the latter);
- an operator-typed inline icon never switches the bot off.

Added (D4, "icon eligibility never breaks a critical flow"): the decoration, icon, style and
category-colour READS before a send fall back to none when they fail (styles and colours:
Codex P2), and the bookkeeping AFTER a delivered send (recording the refusal, the recovery)
is best effort — a delivered message is never turned into an exception by the ops log or the
eligibility store. The eligibility write runs FIRST and on its own, so an ops log that cannot
be written does not leave the bot decorating (review N3); a swallowed failure is logged with
the bot id and its SQLSTATE.

## D5 — media

Audited, unchanged, pinned by existing suites: business photos for the support model
(`telegram-support-image-source.ts`: per-conversation bot token, declared-size and streamed
byte bound, magic-byte sniffing, nothing stored or logged), tutorial videos (per bot,
`file_id` only), receipts (`file_id` of the receiving bot; a refused file falls back to text,
an unknown one does not), albums (`planMediaBatches`, 2–10 per album, a run stops at the first
batch not certainly delivered), broadcast copy/forward (single request per recipient).
Size bounds and magic-byte rules are untouched.

## Transport API changes (backward compatible)

- `telegramRetryAfterMs(value)` and `TELEGRAM_RETRY_AFTER_MAX_MS` are exported from
  `send-message.ts`. `TelegramSendOutcome` is unchanged; `retryAfterMs` is now present only
  when definite and is always a whole number of milliseconds ≤ 24 h.
- A 2xx without `ok` is now `FAILED_RETRYABLE` / `telegram.unreadable_response` instead of
  `FAILED_PERMANENT` / `telegram.rejected.200`. Every lane already reads that code as unknown.
- The fake Bot API (`tests/support/fake-telegram-bot-api.ts`) gained `sendPhoto`/`sendVideo`/
  `sendDocument` by `file_id`, `copyMessage`/`forwardMessage`, `giveFile`, `letRead`,
  `sentMedia` and `rename`; existing behaviour is unchanged.

## Mutation checks

`scripts/mutate-telegram-robustness.py` — each mutation reverts one rule, runs the named
suite and restores the file. Results on `nexa_test_tg2` (25/25 KILLED, including the PR #238
review fixes B1, P1, N1–N5):

| #   | reverted rule                                                               | suite       | result |
| --- | --------------------------------------------------------------------------- | ----------- | ------ |
| M1  | 2xx without ok is a definite refusal again                                  | unit        | KILLED |
| M2  | retry_after read unchecked (NaN reaches the lanes)                          | unit        | KILLED |
| M3  | retry_after ceiling removed                                                 | unit        | KILLED |
| M4  | retry_after rounded down (shorter than asked)                               | unit        | KILLED |
| M5  | negative retry_after accepted                                               | unit        | KILLED |
| M6  | decorated retry on ANY failure (blind retry of an unknown)                  | unit        | KILLED |
| M7  | 429 collapsed into UNKNOWN                                                  | unit        | KILLED |
| M8  | 401 not named TOKEN_REJECTED                                                | unit        | KILLED |
| M9  | a STOPPED bot still sends                                                   | integration | KILLED |
| M10 | another tenant's bot resolves                                               | integration | KILLED |
| M11 | customer reply from the tenant's first bot, not the one written to          | integration | KILLED |
| M12 | ops message ignores the bot it names                                        | integration | KILLED |
| M13 | rename never reconciled                                                     | unit        | KILLED |
| M14 | rename overwrites a name another row holds                                  | integration | KILLED |
| M15 | status reports no drift                                                     | unit        | KILLED |
| M16 | N1: status never says the name is held elsewhere                            | unit        | KILLED |
| M17 | best-effort bookkeeping rethrows (a delivered message becomes an exception) | unit        | KILLED |
| M18 | B1: the token condition shares the generic row (its sentence goes stale)    | unit        | KILLED |
| M19 | B1 (integration): the token condition shares the generic row                | integration | KILLED |
| M20 | P1: the failure record can throw over an UNKNOWN                            | unit        | KILLED |
| M21 | N3: the eligibility write is skipped                                        | unit        | KILLED |
| M22 | N4: backup delivery files a 2xx without ok as definitive                    | unit        | KILLED |
| M23 | N2: a 23505 during the rename is UNRESOLVED, not TAKEN                      | unit        | KILLED |
| M24 | N5: a not-Bot-API 2xx from getMe is UNREACHABLE                             | unit        | KILLED |
| M25 | an unreadable decoration fails the send                                     | unit        | KILLED |

## Manual acceptance — NOT RUN

Each needs a real bot on real Telegram and is NOT RUN here. Use a staging bot, never the
production bot, and never a broadcast to real customers.

1. **429 honoured (NOT RUN).** Send a burst of 40+ customer messages to one private chat
   through the staging bot (e.g. a looped `/start`). Expect: at least one
   `telegram.rate_limited` with `retry_after`; the lane's row deferred to `now + retry_after`
   (≥ floor); the message delivered once after the wait; no duplicate in the chat.
2. **Unknown outcome not retried (NOT RUN).** Point `TELEGRAM_API_BASE_URL` of a staging
   process through a proxy that drops the connection after forwarding one `sendMessage`.
   Expect: the message arrives once in the chat; the row is `UNCONFIRMED`; the operator
   condition `telegram.customer_send_failed` reason `UNCERTAIN`; no second request.
3. **Two bots (NOT RUN).** With two ACTIVE staging bots on one tenant, write to each from a
   different account. Expect: each account is answered only by the bot it wrote to. Stop one
   bot in the Web Admin; write to it; expect no reply and the `NO_BOT` condition.
4. **Revoked token (NOT RUN).** `/revoke` the staging bot's token in BotFather; write to the
   bot. Expect: condition reason `TOKEN_REJECTED`; `botctl telegram status` → `unavailable`,
   `TOKEN_REJECTED`. Replace the token in the Web Admin; expect `ready` and replies again.
5. **BotFather rename (NOT RUN).** Rename the staging bot's username in BotFather. Expect
   `botctl telegram status` to stay `ready` and print the `username` drift line; run
   `botctl telegram register`; expect `ALREADY_COMPLETE`, the new name in the Web Admin bot
   list and in the ops-group connect command, and one `bot_instance.username_reconciled`
   audit row. Pending updates must be unchanged.
6. **Premium icons (NOT RUN).** On a bot WITHOUT custom-emoji rights, configure an inline
   button icon and send the menu. Expect the menu with plain labels (one refused request,
   one plain resend, no duplicate) and a `telegram.appearance_decoration_failed` condition naming the
   buttons.
7. **Source accessible to one bot (NOT RUN, staging broadcast to test accounts only).** A
   COPY broadcast from a channel where only bot A is a member, to test accounts of bots A and
   B. Expect A's recipients SENT, B's terminal after one request (see D2-F1 for its label).
