# R11 A8 — pace every TonPays call per API key; a 429 only delays

Owner report: TonPays answered **HTTP 429 on invoice CREATE twice within one minute**. TonPays is
built and NOT yet accepted against the real provider; nothing here changes the three TonPays
rules (only the inquiry decides; the 70-minute deadline is checked under the payment's lock; a
create whose answer was lost is never retried or re-keyed).

## 1. Measured: how often Nexa calls TonPays (before this PR, `origin/main` @ 20be9734)

Every TonPays call is made by the **worker**, never by a Telegram/mini-app request:

| Call path                                                       | Trigger and cadence                                                                                                                                                                                   | Cite                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoice create                                                  | 1 per attempt, made by the worker after the customer's tap commits. A re-tap, a double-submit, the bot AND the mini app, or an idempotent replay are handed the SAME open attempt (no second create). | `payment.service.ts:3614` (tap writes rows only), `payment.service.ts:5080` (`findOpenAttempt` hand-back), `gateway-payment.service.ts:1467` |
| Create retry                                                    | Only on a readable `RATE_LIMIT_EXCEEDED`: same order id, ≤ 3 sends per attempt, 15 s apart. A bare 429 / 5xx / timeout = `CREATE_UNKNOWN`, never re-sent.                                             | `domain/tonpays.ts:170-171`, `gateway-payment.service.ts:1609-1630`                                                                          |
| Worker pass                                                     | Every 3 s; per pass up to 5 creates + 10 hinted + 10 scheduled inquiries (+ TonPays Telegram 5 card changes, 5 cancel/refund, 3 receipts), all back to back                                           | `gateway-payment-loop.ts:15`, `gateway-payment.service.ts:257-267`, `gateway-provider-request.lane.ts:41`                                    |
| Scheduled inquiry (website)                                     | First at 10 s, every 10 s to 2 min (6/min), 30 s to 5 min, 60 s to 15, 120 s to 30, 300 s to 70 min: ≈ 44 per attempt                                                                                 | `domain/inquiry-schedule.ts:57-67`                                                                                                           |
| Scheduled inquiry (Telegram route)                              | 20/40/80/160/300 s; in review every 30 s for 10 min                                                                                                                                                   | `domain/inquiry-schedule.ts` BACKOFF, `TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE`                                                              |
| Hinted inquiry                                                  | webhook, the bot's «بررسی پرداخت» (`gc:`) and the mini app's check: a DB write that brings the next ask forward, ≥ 5 s after the last (60 s in review) → ≤ 12/min per attempt while tapped            | `gateway-payment.service.ts:4147-4170`, `:3900`, `domain/tonpays.ts:174`, `tonpays-telegram.ts:215`                                          |
| After the deadline                                              | ≤ 3 webhook-triggered diagnostics; late-credit poll 5 min, 15 min, then hourly for 48 h                                                                                                               | `domain/tonpays.ts:177`, `domain/late-credit.ts`                                                                                             |
| Cancel / refund (Telegram route only; the website API has none) | 1 per customer request row, + a sibling cancel before a new create                                                                                                                                    | `gateway-provider-request.lane.ts:299`                                                                                                       |
| Startup / health                                                | **none** — TonPays has no credential check; gateway health reads the database                                                                                                                         | `payment-gateway.service.ts:597`, `gateway-health.service.ts:38`                                                                             |
| Bound                                                           | Per tenant+provider FIXED 60 s window: 50 calls (inquiries 40, scheduled 30); Telegram route 25 (15)                                                                                                  | `drizzle-gateway-credentials.ts:385-395`, `contracts/tonpays.ts:121`, `tonpays-telegram.ts:174-175`                                          |

### Call rate: before → after (calls/min to TonPays, one worker)

| Situation                                                       | Before                                                                                                                    | After                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 fresh open attempt, no taps (first 2 min)                     | 6 inquiries/min                                                                                                           | 3/min (15 s, then 20 s)                                                                              |
| N fresh attempts (first 2 min)                                  | 6N/min, capped 30 scheduled (N = 5 saturates)                                                                             | 3N/min, N = 10 fits the 30 scheduled share; and ≤ 30/min per key regardless                          |
| Per attempt over 70 min (scheduled)                             | ≈ 44                                                                                                                      | ≈ 38                                                                                                 |
| Customer hammering «بررسی پرداخت»                               | ≤ 12/min per attempt                                                                                                      | same, but inside the key's 30/min; after a 429 not before ≥ 60 s                                     |
| Volley inside one 3 s pass                                      | up to 25 calls back to back                                                                                               | burst 3, then one token per 2 s (Telegram key: 4 s)                                                  |
| Website key, worst rolling 60 s                                 | **up to ~99** (fixed window: 50 at a window's end + 50 at the next start) vs documented 60                                | **≤ 33** (30/min + burst 3)                                                                          |
| Both routes, worst rolling 60 s (if TonPays counts one account) | up to ~150 (50 + 25 per window, ×2 at an edge)                                                                            | ≤ 51 (33 + 18)                                                                                       |
| After a 429                                                     | only that ROW waits (60 s); the next row in the same pass asks again; with no Retry-After a tap/webhook may re-ask in 5 s | the whole KEY pauses: Retry-After, else 5 s → 10 → 20 … ≤ 5 min (±20 %); every endpoint HELD, unsent |
| Create during a pause                                           | sent                                                                                                                      | HELD (never sent), deferred, no retry spent                                                          |

## 2. What changed

**Contracts (own commit 6864571d).** `payments.tonpays.calls_per_minute` (default 30),
`payments.tonpays_telegram.calls_per_minute` (15), `payments.tonpays.burst` (3), bounded 1..60
(the documented ceiling) and 1..10; back-off constants; template `bot.payment.gateway_busy`
(listed under `INVOICE_NOT_ISSUED`).

**`TonPaysRateLimiter`** (`payments/infrastructure/tonpays-rate-limiter.ts`). One token bucket
per API key (SHA-256 fingerprint, in memory only, never logged), on the injected `Clock`. A call
waits up to 5 s for its token, else it is **HELD**: not sent, with the ms until it could be. A 429
(readable or not) pauses every call on that key for `Retry-After` (seconds or HTTP date, ≤ 1 h),
else 5 s doubling per consecutive 429 to 5 min, ±20 % jitter; after a pause the bucket restarts
with one token (no burst). Any non-429 answer resets the back-off. Pace read from the
installation tenant's settings at most once a minute, clamped; a failed read keeps the last /
default pace. Rolled-up warning: at most one line a minute per route with the count of 429s and
held calls since the last line.

**The TonPays HTTP client.** `tonpaysRequest` — the one function both TonPays adapters dial
through — takes the limiter and a `route`. So **every endpoint of both routes** (website create +
check; Telegram create, check, change card, receipt upload, **cancel**, refund) is paced and
paused; the sibling cancel-retry PR gets this by calling the adapter. A held call returns
`{ kind: 'HELD' }` (`TonPaysRaw`); a 429 carries `retryAfterMs` (the pause applied). The other
gateways' shared `Raw` type is unchanged.

**Typed outcome.** `RATE_LIMITED` carries `retryAfterMs` and, only for a held call,
`notSent: true` with code `nexa.rate_limited_locally` (`TONPAYS_HELD_CODE`). Card change,
receipt, cancel and refund share `GatewayRateLimitedOutcome`.

**Create.** Held → deferred to when the key frees up, send stamp cleared and the attempt **not
counted** (`deferCreation(..., { notSent: true })` gives back `creation_attempts`), same order id.
Readable `RATE_LIMIT_EXCEEDED` → the existing same-order-id retry (≤ 3), now waiting
`max(15 s, pause)`; on the last refusal: no invoice, payment FAILED without a "payment failed"
notice, and the screen shows **`bot.payment.gateway_busy`** — «درگاه پرداخت در این لحظه شلوغ است
و فاکتوری برای شما ساخته نشد؛ هیچ مبلغی از شما کسر یا ثبت نشده است. لطفاً یک دقیقه دیگر دوباره
پرداخت را آغاز کنید.» — whose retry opens a NEW attempt with a new order id (so never two
invoices). A bare 429 stays `CREATE_UNKNOWN` (OQ-R11-A8-01) and also pauses the key.

**Inquiry: a 429 only delays.** `inquiry_not_before` is now ALWAYS set on a rate limit (≥ 60 s
for a provider 429, the limiter's time for a held call), binding the tap, the webhook and the
worker; a provider 429 waits `max(next step, 60 s, pause)`, a held one is due as soon as the
limiter allows. A rate-limited inquiry no longer increments `post_deadline_inquiries` (it
asked nothing) and no longer clears an operator's `reconcile_inquiry_requested_at` (re-asked at
`not_before`). No state change, no failure, no deadline moved. A held inquiry is not counted
toward `payments.gateway_inquiry_failing`.

**Receipt.** A held upload is re-queued without spending an attempt; a rate-limited one waits
`max(60 s, pause)`.

**Cadence.** TonPays website scheduled inquiries grow with the invoice's age to a cap: 15 s,
then 20 s to 2 min, 30 s to 5, 60 s to 15, 120 s to 30, 300 s after (was 10 s / 10 s …).

**Web Admin.** The three settings in «فروش», Persian titles and hints. **Container.** One shared
limiter for both adapters; row and pass bounds include the 5 s token wait.

**Docs.** `docs/tonpays-gateway-audit.md` §7.2 "Pacing and 429"; `docs/open-questions.md`
OQ-R11-A8-01 (does a bare 429 mean not created? — check the owner's two 429s:
`RATE_LIMIT_EXCEEDED` deferral vs `CREATE_UNKNOWN http.429`), OQ-R11-A8-02 (real limit, scope,
`Retry-After`; the DB budget's fixed window remains the cross-replica bound).

## 3. Tests

- `tests/unit/tonpays-rate-limiter.test.ts` (11, fake Clock + sleep): burst then pace; never >
  rate+burst in any rolling minute; HELD past the max wait; one bucket per key; settings clamped
  and default on a failed read; Retry-After honoured (seconds, HTTP date, bound, past ignored);
  exponential back-off with jitter and cap; reset on a non-429; a 429 during a wait holds the
  waiter; rolled-up log ≤ 1/min with counts and no key.
- `tests/unit/tonpays-rate-limit-adapter.test.ts` (7): create 429 → RATE_LIMITED with
  Retry-After, next create HELD and not sent (1 fetch); bare 429 stays UNKNOWN and pauses the
  key; inquiry back-off grows 5/10/20 s; non-429 resets; a 429 holds every TonPays Telegram
  endpoint incl. cancel and refund (1 fetch); the two routes' keys are independent; a volley is
  paced (0, 0, 0, 2 s).
- `tests/integration/tonpays-gateway.test.ts` › "R11 A8 — the provider's rate limit" (4): a held
  create is never sent, spends no retry (4 holds > 3 retries), keeps its order id, ONE invoice;
  three readable rate limits → no invoice, FAILED, no customer failure notice, Persian "busy"
  screen, retry = new order id, one invoice; an inquiry 429 keeps PENDING and binds tap +
  webhook for ≥ 60 s, then settles; a post-deadline 429 spends no allowance and keeps the
  operator's request.
- Updated: `tests/unit/inquiry-schedule.test.ts` (cadence: ≤ 4 asks/min, ≈ 38/attempt, interval
  grows), `tests/integration/gateway-inquiry-schedule.test.ts` (15 s first ask, 20 s step),
  `tests/unit/bot-runtime.test.ts` (reviewed customer copy list).

### Mutation checks

Each rule broken alone in the source, the named test(s) went red, the source restored
(`git diff` clean). M6–M9 were broken together in one integration run; each failed at its own
rule's assertion (line given).

| #   | Rule broken                                                  | Test(s) that went red                                                                                                                                                                  | Result |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | no pacing (`tokens >= 1` → always)                           | rate-limiter › burst then pace; never > rate+burst a minute; HELD past max wait; one bucket per key; settings clamped; Retry-After held; 429-during-wait; adapter › paces a volley (8) | KILLED |
| M2  | Retry-After ignored (back-off only)                          | rate-limiter › honours Retry-After; 429-during-wait; adapter › create 429 then HELD; every Telegram endpoint held (4)                                                                  | KILLED |
| M3  | streak never grows                                           | rate-limiter › exponential back-off; adapter › inquiry back-off grows 5/10/20 s                                                                                                        | KILLED |
| M4  | `tonpaysRequest` ignores a HELD gate                         | adapter › create during pause never sent; bare 429 pauses key; all Telegram endpoints held                                                                                             | KILLED |
| M5  | no back-off reset on a non-429 answer                        | adapter › an answer that is not a 429 starts the back-off over                                                                                                                         | KILLED |
| M6  | held create counted (`notSent` dropped from `deferCreation`) | integration › held create spends no retry (`creation_attempts` 1 ≠ 0, :3353)                                                                                                           | KILLED |
| M7  | `inquiry_not_before` only with a Retry-After (old rule)      | integration › inquiry 429 binds tap + webhook (:3414)                                                                                                                                  | KILLED |
| M8  | busy screen off (`createEndedRateLimited` → false)           | integration › “busy” in Persian (:3393, showed «در دسترس نیست»)                                                                                                                        | KILLED |
| M9  | rate-limited inquiry spends post-deadline allowance          | integration › post-deadline 429 (:3446)                                                                                                                                                | KILLED |
| M10 | rate-limited inquiry clears the operator's request           | integration › post-deadline 429 (:3447)                                                                                                                                                | KILLED |
| M11 | cadence back to 10 s / 10 s                                  | inquiry-schedule › first ask 15 s; ≤ 4 asks a minute (2)                                                                                                                               | KILLED |
| M12 | bucket refilled to full burst after a pause                  | rate-limiter › honours Retry-After (pace after the pause)                                                                                                                              | KILLED |

## 4. Decisions

- Limiter at the HTTP-client layer (lead's note), in-process per worker; the DB per-minute budget
  stays the cross-replica bound (its fixed-window 2× edge is recorded, OQ-R11-A8-02).
- Per API key, not per provider; defaults 30 + 15 so both routes stay under 60 even on one
  account. Pace from the installation tenant's settings (the tenant the worker serves).
- A bare 429 on create stays UNKNOWN (lost-create rule); only the documented code means "not
  created" (OQ-R11-A8-01).
- `gateway_busy` only for TonPays routes; other gateways' sentences unchanged.
- A held call still consumed its DB budget slot (harmless; never a provider call).

## 5. Migrations

None. (No schema change: the limiter is in memory; new columns were not needed.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck

## 8. Review fix (63599631)

- Codex P2: the key is paused as soon as a 429's status and `Retry-After` arrive, before the body
  is read, so a 429 whose body stalls past the timeout still pauses the key (the create stays
  UNKNOWN `http.timeout`). Test: `tonpays-rate-limit-adapter.test.ts` › "a 429 whose body never
  arrives"; mutation (pause taken after the body read) KILLED.
- Web Admin pace hints use Latin digits (A1's DOM guard). Web 3391/0; adapter units 73/0;
  tonpays-gateway + tonpays-http 97/0; typecheck, lint, format, i18n 0.
