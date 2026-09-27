# WP20 — Messaging reliability and anti-spam: audit and design

The owner's brief (§3) asks for four things:

1. A poison background message must not delay the whole bot.
2. Customer interactions must stay responsive.
3. Telegram retry and rate-limit failures must not hot-loop.
4. An abusive user must not be able to flood the bot.

This document records what the code did before this package, what the owner decided and
where each decision landed, and what was chosen on technical grounds.

## 1. What already existed

| Piece                                                         | Before WP20                                                                                                                                                                                                                                              | Consequence                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox relay (`outbox-relay.ts`)                              | Claimed the oldest unpublished rows (`FOR UPDATE SKIP LOCKED`). On failure it recorded `attempts + 1` and `last_error`. It had no `next_attempt_at`, no cap and no evidence state. Its own comment recorded the gap: "needs a `next_attempt_at` column". | `batchSize` poison messages at the head took every batch slot on every poll. Everything behind them waited, and nothing ever stopped retrying them. |
| Ops notification lane (`notifications`)                       | Per-row `next_attempt_at`, a configurable attempt cap and exponential back-off. A `retry_after` replaced the back-off outright.                                                                                                                          | A `retry_after` of 0, or a small one, could undercut the local back-off.                                                                            |
| Customer notifications, receipt pushes, refund-request pushes | Per-row scheduling and a small cap (3). On RATE_LIMITED: `retry_after ?? backoff`.                                                                                                                                                                       | The same undercut.                                                                                                                                  |
| Interactive webhook turn                                      | Runs in the `api` process. It never waits on the relay or the lanes, which run in `worker` and `provisioner`.                                                                                                                                            | Already independent. What they share is Postgres and Telegram's per-bot limits.                                                                     |
| Customer block                                                | A conditional UPDATE (`WHERE status = 'ACTIVE'`), an audit row and a `CustomerBlocked` event. Charged `users.block`.                                                                                                                                     | Race-safe. The webhook's actor is `SYSTEM_JOB`, which holds only `maintenance.run`.                                                                 |
| Redis                                                         | Connected and health-checked, nothing more. The shared client waits for ever while disconnected (`maxRetriesPerRequest: null`).                                                                                                                          | Usable for a counter, but only on a connection that fails fast.                                                                                     |
| Diagnostics (#80, WP16)                                       | Outbox pending, failing, and a sample of failing messages.                                                                                                                                                                                               | No notion of a message that has stopped being retried.                                                                                              |

## 2. Owner decisions (brief §3), and where each lands

| Decision                                                                                                                                                                                                                                                         | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.1 Per-message retry schedule: 5 s, 15 s, 60 s, 5 min, 15 min, then an hour. Claim only due messages. No 0 ms loop.                                                                                                                                            | `deliveryRetryDelayMs` in `@nexa/contracts`. Migration 0126 adds `outbox_messages.next_attempt_at` (NULL = due, so every existing row is claimable exactly as before). The relay claims only due rows and reschedules the failed row alone.                                                                                                                                                                                                                                                                                                                                                            |
| §3.1 A provider `retry_after` is a floor: use the later of it and the local back-off.                                                                                                                                                                            | `deliveryRetryDelayMs(n, retryAfter)`. The ops lane's `notificationBackoffMs` uses `max(local, retryAfter)`. The customer, receipt, refund-request and service-delivery lanes use `max(retryAfter, backoff)` on RATE_LIMITED.                                                                                                                                                                                                                                                                                                                                                                          |
| §3.2 After 12 real failures: stop, keep the evidence, show it in diagnostics, announce it once, never delete, no force-success control.                                                                                                                          | `DELIVERY_MAX_FAILED_ATTEMPTS = 12`. At the 12th failure the row keeps `published_at` NULL and `next_attempt_at` NULL, is stamped `exhausted_at` (migration 0126), and is excluded from the claim by that mark. One `outbox.message_exhausted` operational event is recorded per message (dedupe key = the event id), in the relay's transaction and through a transaction scope, so the operator notification it projects is written with it. Diagnostics gain `exhausted`, and a per-row `nextAttemptAt` and `exhausted`. The Web Admin shows a count, a banner and a badge per row. No new control. |
| §3.3 Responsiveness. Per-chat ordering where required, no in-memory source of truth. Background traffic must not starve customers.                                                                                                                               | See T3–T5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §3.4 More than 20 interactions in a rolling 10 s blocks. Deduplicate by `update_id`. Scope: tenant, bot, user. An atomic Redis counter, no row per message. Fail open.                                                                                           | `RedisInteractionCounter`: one Lua script over a sorted set, with a `SET NX` per `update_id`. `AntiSpamService` fails open and records `antispam.unavailable` at most once a minute per process and bot, keyed by the bot, recovered by `antispam.recovered` for that bot alone.                                                                                                                                                                                                                                                                                                                       |
| §3.5 Block exactly once as SYSTEM, with the owner's reason and sentence. The triggering update does no business work. Later ones are refused cheaply. Answer callbacks. No automatic unblock. Admin sees and unblocks as before. Never overwrite a manual block. | `CustomerService.blockForSpam`: the one `setStatus` path, conditional on ACTIVE, with the reason `ANTI_SPAM_BLOCK_REASON`. The runtime routes the turn to the BLOCKED branch, so `act` never runs. The reply is `bot.blocked_spam`. From the 22nd interaction on, only the callback query is answered.                                                                                                                                                                                                                                                                                                 |

## 3. Technical choices

- **T1 — the schedule is for the outbox, the one lane that had none.** The four Telegram
  lanes already had per-row scheduling and caps of 3 (customer, receipt and refund-request
  lanes) or at most 10 (ops). The owner's 12 is a ceiling, so a stricter existing cap stays.
  What they lacked was the `retry_after` floor. It is added to all four, and to the
  service-delivery lane, which had the same `retryAfterMs ?? BACKOFF` shape.

  This changes one old behaviour on purpose: a `retry_after` of 0 used to mean "retry on
  the next tick". Two tests in `notification-delivery.test.ts` relied on that; they now
  bring the intent due explicitly, and the floor itself is pinned by the WP20 tests.

- **T2 — ordering is per aggregate, as `outbox_messages` promises, without costing
  throughput.** A message is not claimed while an earlier message of its own aggregate has
  failed and is backing off. Within one batch, a failure holds back the rest of its
  aggregate in that batch. An earlier message that has never failed holds nothing back at
  the claim: it is in the same batch, ahead of its successors by the batch's order. An
  aggregate with several queued events therefore drains in one batch, as it did before
  WP20.

  The first version held a message behind ANY unpublished predecessor. That took one batch
  per queued event of an aggregate, and the full suite caught it: tests that relayed once
  and expected everything published.

  Other aggregates are not held. An exhausted message stops holding its successors: waiting
  on evidence would be waiting for ever. Two relay replicas can still take one aggregate's
  never-failed messages in parallel under `SKIP LOCKED`. That was true before WP20, and
  closing it needs a per-aggregate lock this package does not add.

- **T3 — the interactive turn already runs apart.** The webhook is served by the `api`
  process. The relay and every notification lane run in `worker` or `provisioner`. Nothing
  interactive awaits them, so a poison message cannot slow a reply. This package adds no
  queue and no in-memory state that could become a second source of truth.
- **T4 — log-topic traffic cannot starve customers.** It is the ops lane's: its own
  per-minute ceiling, its own back-off and its own process. The per-bot Telegram limit is
  shared. The lanes all honour `retry_after` as a floor, so a burst backs off instead of
  competing with interactive replies.
- **T5 — lag excludes exhausted messages.** An exhausted message is in the diagnostics.
  Counted as lag, it would keep the worker unhealthy for good.
- **T6 — anti-spam counts every interaction, and exempts administrators by binding.** An
  intent is only what an update says. Exempting admin-shaped callbacks would let any
  customer flood with `C:<uuid>` taps uncounted. The binding is asked only once the count
  crosses 20, so an ordinary turn pays for no extra lookup.
- **T7 — the counter's connection fails fast.** It has its own ioredis client: offline
  queue off, a 250 ms command timeout, one retry. A connection still being made is waited
  for as long as one command would be, and no longer. Without that wait, every turn right
  after a start would read as an outage.
- **T8 — `maintenance.run`, not `users.block`, authorises the anti-spam block.**
  `SYSTEM_JOB` holds only `maintenance.run`. Widening that grant would let every background
  job block anybody. `blockForSpam` is the single entry point it authorises, and the reason
  is fixed.
- **T9 — the amplification bound.** Interactions after the 21st are not answered while the
  flood lasts. A message counted within the first twenty but processed after the block
  commits is still answered with the blocked sentence. So 31 interactions produce at most
  21 messages. Every callback query is answered, so no spinner hangs.
- **T10 — the identity upsert still runs for a flooding customer.** It is what says who the
  customer is and whether they are blocked. It is idempotent and bounded. Nothing after it
  runs: no commerce, no captures, no send.
- **T11 — `/ping` is counted too.** The webhook answers `/ping` before the runtime runs,
  and each one it records writes an audit row, an outbox event and an idempotency row. It
  is counted by the same `AntiSpamService`. Past the limit it is answered and writes
  nothing; the block itself stays the runtime's, taken on the flooder's next message.
- **T12 — exhaustion is a mark, not a count.** The release before WP20 retried a failing
  message on every poll, so a row can arrive with `attempts` past 12 that nothing ever
  decided or announced. Inferring exhaustion from the count would drop such a row in
  silence. `exhausted_at` is written by the failure that announces it; a row without it is
  claimed, fails once more, and is exhausted and announced then. After a rollback the
  previous release ignores the column and retries as it always did.
- **T13 — per-bot degradation.** The recorder dedupes a condition on its key alone. One key
  for every bot let one bot's outage hide another's, and one bot's good turn resolve
  another's outage while it still failed open. The key and the in-process throttle are per
  bot, and the recovery is written under its own key naming the outage's.

## 4. Deliberately not done

- **Per-consumer isolation in the relay.** One consumer that throws still rolls back the
  other consumers' effects for that message. The outbox's four consumers are idempotent
  and order-independent, and splitting the savepoint per consumer would change the
  effectively-once contract, a design change beyond "retry scheduling". It is recorded here.
- **A cross-process Telegram limiter.** Each lane honours `retry_after`. A shared token
  bucket in Redis would be a new mechanism the brief does not ask for.
- **Clearing the anti-spam window on a manual unblock.** The window is 10 s. An unblock
  given within 10 s of the flood could be followed at once by a re-block, which is the
  truth about that flood.

## 5. Evidence

- `tests/integration/wp20-outbox-retry.test.ts`:
  - the schedule;
  - a failure not claimed before it is due;
  - head-of-line freedom with a batch of one;
  - per-aggregate holding, and an aggregate's never-failed queue drained in one batch;
  - exhaustion at 12: kept, not claimed, announced once to an operator, shown in
    diagnostics, excluded from lag;
  - a count grown under the release before: claimed once more, then exhausted and
    announced.
- `tests/integration/wp20-anti-spam.test.ts`: every item in brief §3.6, plus:
  - the admin binding exemption;
  - admin-shaped callbacks from a customer;
  - the manual-block race;
  - the flood's silence;
  - `/ping` counted, and nothing written past the limit.
- `tests/integration/wp20-interaction-counter.test.ts`: the rolling window against Redis,
  the dedupe, and the fail-fast on a dead Redis.
- The later-of rule on every Telegram lane, each against a `retry_after` shorter than the
  lane's own back-off: `customer-notifications.test.ts`, `receipt-review-push.test.ts`,
  `service-refund-requests.test.ts` and `provisioning-delivery.test.ts`.
- `tests/unit/wp20-retry-schedule.test.ts`: the schedule, the floor and the verdict.
- `tests/unit/wp20-anti-spam-conditions.test.ts`: the degradation condition per bot.
- `tests/web/system-diagnostics.test.tsx`: the exhausted count, banner and badge.
- `docs/wp20-falsification.md`.

## 6. The independent review of #84

Codex's review of #84 hit its usage limit, so the branch was also reviewed independently,
read-only, against CLAUDE.md. It found one tenant-isolation defect and four smaller ones.
All five are fixed, each with a named test and a killed mutation (W20-46..55).

- **The per-aggregate hold crossed tenants.** The claim's sibling rule and the batch's
  `held` set matched on `(aggregate_type, aggregate_id)` alone. That pair is not unique
  across tenants: every tenant's `SystemPinged` is `System:system`, and its sequence is
  shared. The claim never takes a stopped tenant's message, so a stopped tenant's failed
  ping was never retried or exhausted. It then held every other tenant's pings behind it
  for ever, and counted them as lag, which is a blocking readiness check. Both now match
  the tenant too (`IS NOT DISTINCT FROM`, so platform events still order among
  themselves).
- **An announcement that threw rolled back the batch.** The exhaustion mark and its
  announcement now share one savepoint. If the announcement fails, the failure is still
  counted and rescheduled but not marked, and its next failure exhausts and announces it.
  Before, the throw rolled back the whole batch, and the same message was claimed first on
  every poll, stalling the relay for every tenant.
- **The sibling rule walked published history.** Published outbox rows are never deleted,
  and the only index the rule could use was the unique `(aggregate_type, aggregate_id,
sequence)` one. So each claim walked every earlier sequence of the aggregate, one per
  ping ever sent for `System:system`. A partial index of live failures,
  `outbox_messages_live_failure_idx`, now answers it. It is built concurrently in
  `online-indexes.ts`, not in migration 0126, because every business transaction writes
  `outbox_messages` and a blocking build would hold them all during `botctl update`.
- **The spam block was not always explained.** The silence rule keyed on the FLOODING
  verdict, so a block that landed on a FLOODING turn was never explained. That happens
  when the 21st interaction is a `/ping`, which the webhook answers without blocking, or
  when the 21st failed before its block committed. Past the limit, the turn that took the
  block is now the one told why, whatever its verdict. Every other turn past the limit
  sends nothing, including a 21st that lost the block to a later turn under concurrency,
  so the customer is never told twice.
- **An outage recorded by another process stayed open.** `antispam.unavailable` was
  resolved only by the process whose memory held it. On a good count, a process now looks
  the bot's outage up in the operations log, at most once a minute per bot and only while
  the bot has traffic, and resolves it if it is open.
- **The diagnostics sample was crowded out.** Exhausted rows are kept for ever and are
  always the oldest, so twenty of them hid every failure still in flight. The sample now
  lists the ones still being retried first.

Two test gaps the review named stay as recorded: W20-31 is an equivalent mutant, and
W20-37 is one of two guards.
