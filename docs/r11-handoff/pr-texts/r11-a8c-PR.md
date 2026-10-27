# R11 A8 — TonPays Telegram: a cancel whose answer was lost may be asked again

## What changed

**Owner bug.** When a TonPays Telegram cancel request ended with a lost answer (a timeout, a 5xx,
a 429 with no readable code), the customer saw the unknown-outcome notice
(`bot.payment.gateway_cancel_unknown`), and once the next inquiry answered `pending` the invoice
came back with its copy-amount / copy-card buttons but **without «❌ لغو فاکتور»**, so the customer
could not retry. The cause was a deliberate Round 6 rule in `cancelAvailable` ("a cancel whose
answer was lost is never repeated by a tap", audit §19.2 (4)). The owner replaces it: **a lost
cancel answer does not count as cancelled.**

1. **The button stays** — `cancelAvailable` (`payments/domain/tonpays-telegram.ts`). An `UNKNOWN`
   previous cancel (and, as before, a `RATE_LIMITED` one) no longer hides the button. Two guards
   are now explicit: an `APPLIED` cancel (nothing left to cancel) and an invoice the provider
   reported paid (`providerPaid === true`, whatever its status field says). It stays hidden as
   before while a cancel is in flight (`REQUESTED`/`SENT`), for a status other than `pending`,
   with a receipt on its way, and outside the customer window.
2. **The unknown notice offers the retry** — `cardTransferScreen` (`runtime/payment-screens.ts`).
   `bot.payment.gateway_cancel_unknown` (copy unchanged) now carries «❌ لغو فاکتور» (`gq:`) beside
   «🔎» while rule 1 allows it. The tap asks first, then confirms (`gz:`), re-deciding under the
   payment's lock. Once an inquiry has answered, the normal card invoice is drawn with its copies
   AND the cancel button — the owner's screen.
3. **The retry is a NEW request row** — `GatewayReceiptCaptureService.requestCancel`. Written
   under the payment's `FOR UPDATE` lock; the existing in-flight unique index
   (`gateway_provider_requests_in_flight_key`) keeps one open cancel per payment, so a double tap
   writes one row and TonPays is asked once. The lost row stays `UNKNOWN`: Nexa never resends it
   by itself, and its own sibling-before-create and expiry cancels keep "at most once, never after
   a lost answer". The audit row of a customer cancel now names the request it follows
   (`after.retryOf`).
4. **Spacing, not a limiter** — `cancelRetryNotBefore`, `CANCEL_RETRY_BACKOFF_SECONDS = 30`. A
   retry after an `UNKNOWN` or `RATE_LIMITED` cancel is written with `claimed_until` = that row's
   decision time + 30 s, so the worker's `claim` leaves it until then and it is not sent into the
   same trouble a second later. Per-credential pacing and 429/Retry-After back-off belong to the
   TonPays client (sibling PR `fix/r11-tonpays-rate-limit`); the lane still takes its call budget
   before the send stamp. The sibling's typed `RATE_LIMITED` outcome (a provider 429 with its
   code, or `HELD` by the local limiter: `nexa.rate_limited_locally`, nothing sent) maps to the
   lane's existing `RATE_LIMITED` decision, which leaves the button available; a 429 with no
   readable code stays `UNKNOWN` (the sibling kept that rule), equally retryable.
   4b. **Rate limited reads as undetermined** — `cancelNoticeKey`. The customer's rate-limited cancel
   now shows the same `gateway_cancel_unknown` notice (with the retry button) as a lost answer,
   until an inquiry answers — before, it showed nothing and the invoice silently came back. Nexa's
   own rate-limited cancel (before a new create, re-asked by Nexa) shows nothing, as before.
5. **«فاکتور قبلاً لغو شده»** — new contract key `bot.payment.gateway_cancel_already_cancelled`
   (own commit), `cancelTapRefusal` + `refusedCancelTap` (`runtime/card-receipt-flow.ts`). A refused
   `gq:`/`gz:` tap on an invoice Nexa KNOWS was cancelled — an `APPLIED` cancel, an inquiry that
   read `canceled`, or a payment `FAILED` with note `…:canceled_by_customer` / `…:canceled_by_nexa` /
   `…:canceled` — answers the new sentence. A lost answer is never read as cancelled.
6. **Cancel after PAID is refused** — same function. A `CONFIRMED` payment, or an invoice the
   provider reported paid, answers `bot.payment.gateway_not_pending` (existing copy) with «🔎».
   Before, such a tap answered `gateway_closed` ("closed — you may pay again"), wrong after paying.
   Nothing is written or sent; no money moves.
7. **"Cancelled", not "failed"** — `failedCardScreen`. The customer's lost cancel that DID cancel
   the invoice (the inquiry read `canceled`; the retry met `NOT_PENDING`) reads
   `bot.payment.gateway_cancelled`, as an applied one does. Nexa's own cancels and a provider-side
   `canceled` with no customer request keep `gateway_failed`. (Consistent with the ops-log rule in
   `paymentFailureOutcome`, which already counts such a failure as cancelled by the customer.)
8. **Card change** — unchanged code: a lost change already stays offered after its cooldown
   (`decideCardChange`). Now pinned, with the cancel button beside it on the "card not confirmed"
   screen, and a lost change followed by a lost cancel still cancels.
9. **Mini app** — it has no cancel (a TonPays Telegram invoice is paid in the bot). Pinned: a lost
   cancel leaves the payment `PENDING` there (`attemptWire`: in-chat, invoice ready, no URL), and
   the applied retry closes it.
10. **Docs** — audit §21 (what changed + decisions) with a pointer from §19.2 (4);
    `docs/project-status.md` (the owner decision); `OQ-TPTG-30`; falsification table R11A8-01..11.

## Tests

- `tests/unit/r11-tonpays-cancel-retry.test.ts` (new, 6): UNKNOWN and RATE_LIMITED leave the button
  available; never in flight / applied / paid / not pending / receipt on its way; retry spacing;
  refused-tap classification (PAID, ALREADY_CANCELLED, lost ≠ cancelled); lost card change still
  offered after cooldown; the Persian sentence.
- `tests/unit/tonpays-telegram-screen.test.ts` (+3): lost (or rate-limited / held) cancel keeps the button on its notice and
  on the invoice (copies present), not when processing / paid / window closed / in flight; lost
  card change keeps change + cancel; customer cancel found `canceled` reads "cancelled".
- `tests/unit/tonpays-telegram-round6.test.ts`: the Round 6 "UNKNOWN never retried by a tap"
  assertion flipped by the owner's decision (title updated).
- `tests/unit/bot-runtime.test.ts`: the new key added to the reviewed customer-copy list.
- `tests/integration/tonpays-telegram-round6.test.ts` (+7, "R11 A8"): a 429 `RATE_LIMIT_EXCEEDED`
  cancel → undetermined notice + button → spaced retry → cancelled; cancel → unknown → button →
  retry (held for the spacing, sent once) → cancelled, then «فاکتور قبلاً لغو شده» with nothing
  sent; the lost cancel had cancelled it → retry `NOT_PENDING` → inquiry `canceled` → "cancelled" +
  «فاکتور قبلاً لغو شده»; two concurrent confirms → one row, one provider call, one `PaymentFailed`;
  cancel after PAID refused, no call, wallet unchanged; card change lost → change + cancel stay,
  both retried; mini-app projection.

| #        | Mutation                                             | Killed by                                                                 |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| R11A8-01 | `cancelAvailable` refuses after UNKNOWN again        | unit ×4 (r11, round6, screen ×2) + integration ×5                         |
| R11A8-02 | `providerPaid` guard removed                         | r11 › never while…; screen › lost cancel keeps…                           |
| R11A8-03 | `APPLIED` guard removed                              | r11 › never while…                                                        |
| R11A8-04 | retry written with `claimed_until` null              | integration › lost cancel keeps… held for the spacing                     |
| R11A8-05 | unknown notice without the cancel button             | screen › lost cancel keeps… on its notice                                 |
| R11A8-06 | refused `gq:` answered by the generic refusal        | integration × 3 (retry, had-cancelled, after PAID)                        |
| R11A8-07 | `cancelTapRefusal` never answers PAID                | r11 › a refused tap…                                                      |
| R11A8-08 | customer cancel read `canceled` shows "failed"       | screen › reads "cancelled"                                                |
| R11A8-09 | UNKNOWN counted as already cancelled                 | r11 › a refused tap…                                                      |
| R11A8-10 | in-flight check AND `ON CONFLICT DO NOTHING` removed | integration › two confirm taps at once                                    |
| R11A8-11 | in-flight check removed from `cancelAvailable`       | r11 › never while…; round6 (unit) › cancel: only a pending invoice        |
| R11A8-12 | customer's rate-limited cancel leaves no notice      | screen › lost cancel keeps…; integration › a cancel TonPays rate-limited… |
| R11A8-13 | Nexa's own rate-limited cancel shows the notice too  | screen › lost cancel keeps…                                               |

## Decisions

1. The provider's answer to a second cancel is not read as "cancelled": the document names no such
   answer (`OQ-TPTG-30`). A 2xx is applied as for any cancel; a refusal (`NOT_PENDING`) brings the
   inquiry forward and only the inquiry's `canceled` closes the payment.
2. Nexa's own cancels (before a new create, on expiry) are not retried — the owner's rule is about
   the customer's explicit request; an automatic repeat is what gateway rule three forbids.
3. No feature flag: this restores a button the owner expects, moves no money and sends no new
   message by itself. No new mini-app cancel (out of scope; the mini app sends TonPays Telegram
   payments to the bot).
4. Spacing is a fixed 30 s local constant (not a contract setting); pacing stays the client's.

## Merge

`origin/fix/r11-tonpays-rate-limit` is merged in (merge commit; two additive conflicts — imports in
`domain/tonpays-telegram.ts` and the reviewed copy list in `bot-runtime.test.ts` — both sides kept).
This PR must merge AFTER that one.

## Migrations

None. The in-flight index and `claimed_until` already exist.

## Local gate

`pnpm verify` stage by stage through `run-gate.sh`: typecheck, lint, format:check, boundaries,
check:i18n, check:citations (2855 resolve), check:shell — green; `pnpm test` 10130 passed / 5 failed,
the 5 being `backup-cli.test.ts`, which needs `apps/api/dist` (a fresh worktree had none) — 22/22
after `pnpm build`; `pnpm test:web` 3353 passed / 1 timeout (`settings-presentation.test.tsx`,
under round-wide load) — 30/30 on rerun; `pnpm test:deploy` and `pnpm build` green.
Integration guard set (10 files): 273 passed / 4 failed, all four in
`gateway-inquiry-schedule.test.ts` (website TonPays inquiry pacing/budget — the sibling
rate-limit branch's area, head `5acde472`; this diff touches no inquiry or website code). Every
TonPays Telegram suite, `tonpays-gateway`, `payment-money-truth`, `late-gateway-credit` and
`gateway-payment-ops-events` green.

## Open problems

- `gateway-inquiry-schedule.test.ts` (4 cases) red on the merged sibling head `5acde472`; to be
  fixed on `fix/r11-tonpays-rate-limit`, then re-merged here.
- Pre-existing edge, widened by at most 30 s: a customer cancel still `REQUESTED` when Nexa's
  deadline expires the attempt blocks the expiry cancel (one cancel at a time) and is then
  refused `nexa.attempt_closed`, so TonPays' invoice may stay `pending`. Unchanged in kind; the
  spacing makes the window up to 30 s longer.
