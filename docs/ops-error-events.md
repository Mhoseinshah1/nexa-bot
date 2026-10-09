# Operational error events — FIX-04 / FIX-05 (2026-10-09)

The owner's instruction (FIX-05): _«هر خطایی روبات داره، هرجا خطایی بود توی گروه لاگ با
اطلاعات کامل ثبت بشه»_. FIX-04 is the payment-link part of it: a gateway create-invoice /
payment-link request that produced no usable link must reach the log group with enough
for an operator to act.

This page is the coverage matrix and the honest inventory behind that. The source of truth
for every code's classification is `packages/contracts/src/ops-error-events.ts`
(`OPS_ERROR_EVENTS`); `tests/unit/ops-error-events.test.ts` scans the API source for every
code it records and fails when one is not classified there.

## No parallel architecture

Nothing new carries an event. Every report goes through the pieces that already existed:

| Piece                                                    | What it already owned                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DrizzleOperationalEventRecorder` (`operational_events`) | the durable log: code, severity, dedupe key, occurrence counter, recovery (`recoversCode`)              |
| `NotifyingOperationalEventRecorder` (the projector)      | one notification per NEW or REOPENED row, in the same transaction; keeps the event when the queue fails |
| `NotificationDispatcher` + `OpsGroupRouter`              | per-tenant routing to the group's topic, retries, Telegram 429 ceiling, preserved (dead-letter) state   |
| `opsLogTopicForCode` (`OPS_LOG_TOPIC_ROUTES`)            | which topic a code goes to, by prefix                                                                   |
| `infrastructure/redaction.ts`                            | the one redactor (extended here, not copied)                                                            |
| audit log                                                | the per-attempt evidence (`gateway_invoice.create_failed`, `customer.block`, …)                         |

What this fix adds is the taxonomy (one table), one mapping for payment-link failures, one
presentation for them, a quiet recorder helper, and wiring at five existing chokepoints.

## Severity policy

`OPS_ERROR_CLASSES` — what the group reads. `SECURITY` is a presented **class**, stored at
`WARN`: `operational_events.severity` is CHECK-pinned to `DEBUG…CRITICAL` and every reader
ranks by that list, so a sixth stored value would be a vocabulary an older replica cannot
read after `botctl rollback`. The class is printed in the message, and the code's prefix
already routes it to the SECURITY topic.

| Class    | Stored as  | When                                                                                        |
| -------- | ---------- | ------------------------------------------------------------------------------------------- |
| SECURITY | `WARN`     | refused, locked out, blocked for abuse, privileged identity changed. Never a customer typo. |
| CRITICAL | `CRITICAL` | money or data at risk, or the installation as a whole stopped doing its job                 |
| ERROR    | `ERROR`    | an operation failed and will not succeed on its own; an operator must look                  |
| WARN     | `WARN`     | degraded or ambiguous: UNKNOWN outcome, fallback in use, retried automatically              |
| INFO     | `INFO`     | a recovery, or a fact an operator asked to be told                                          |

Expected validation and user-input errors (a 4xx the API answers, a discount code refused,
an amount below the minimum the customer typed) are **not** events: they are answered to the
person who made them, and turning them into group messages would bury the real ones.

## Dedupe, aggregation and rate limits

`OPS_ERROR_DEDUPE_POLICIES`, per code:

- **CONDITION** — one row per subject, open until its recovery code closes it; announced
  when it opens and again when it reopens.
- **PER_SUBJECT** — one row per subject (a payment, a message); each subject is its own fact.
- **WINDOW** — one row per subject per hour (`opsAggregationKey`, `OPS_AGGREGATION_WINDOW_MS`).
  A storm is one message per hour with its counter; the next hour announces again if it is
  still happening. Every occurrence still increments the row, and the per-attempt audit row
  is written regardless — nothing is lost by not posting it.
- **PER_OCCURRENCE** — no key; rare, bounded facts.

Telegram 429 on the log group itself is the dispatcher's existing rate ceiling and
`retry_after` handling: a refused send is retried later and never counted against the
message's allowance; a message that spends its allowance on group-side failures is
**preserved**, not dropped, and re-queued when the group is healthy again (HF-A4).

## Routing and resilience

- **Per tenant and bot**: the event is recorded in the tenant's scope; the dispatcher sends
  it to that tenant's connected group (or the manual chat-id fallback), to the topic its
  code routes to (payment-link failures → PAYMENTS, anti-spam → SECURITY, `internal.` →
  ERRORS, `job.` → SYSTEM).
- **The operations lane must be switched on** (`ops_notifications`, off by default — "a
  destination has to be configured and tested first"). With it off, every event is still
  recorded in `operational_events` and visible on the Web Admin alerts page; nothing is
  queued for Telegram. This is existing product behaviour and was not changed.
- **A missing group, a missing permission or a failed send never blocks business.** Every
  new reporting site records **after** its own outcome committed, through `recordQuietly`
  (never throws, never joins the caller's transaction); the projector keeps the event when
  only its notification fails; the dispatcher keeps a message it cannot deliver.
- **A delivery failure is itself visible**: the intent's attempts and their error codes
  (`notification_delivery_attempts`), the group's health panel, and the preserved state.
- **No log-of-log loop**: a failed delivery of an operations-group message records **no**
  operational event (the dispatcher records attempts, never events, for it), so a broken
  group cannot generate messages to the broken group. Tested.

## Redaction and PII

- The group message for a payment-link failure is built from an **allow-list** of context
  keys (`payment-link-presentation.ts`), each re-checked: ids against the id alphabet, the
  Telegram id as digits, the error code as its first token through `redactOperatorText`.
- `redactOperatorText` (in `infrastructure/redaction.ts`, the one implementation) composes
  the existing secret-text rules with two new ones: **every URL** (a signed or payment link,
  a callback URL) and **every Luhn-valid card number** (13–19 digits, grouped or not).
- Never included: credentials, API keys, bot tokens, signed or payment links, PAN, the
  provider's raw response or message, the customer's name, username or phone, another
  tenant's ids. The customer is identified by their **numeric Telegram id** only.
- Generic events keep the existing `DETAIL_KEYS` allow-list (`event-details.ts`).

## FIX-04 — payment link creation

One chokepoint: `GatewayPaymentService.processCreation`, which every provider's create
passes through (TonPays, TonPays Telegram, NOWPayments, CentralPay, Telegram Stars). Every
exit that leaves the customer without a usable invoice calls `reportLinkFailure` once,
after its own outcome committed. `paymentLinkFailureOf` classifies the adapter's outcome
into `PAYMENT_LINK_FAILURE_KINDS`; `paymentLinkFailureEvent` builds the ONE event.

| Case                 | Adapter outcome                                | Kind             | Code                                   | Classification | Retryable | Payment             |
| -------------------- | ---------------------------------------------- | ---------------- | -------------------------------------- | -------------- | --------- | ------------------- |
| no link              | `CREATED`, both links null                     | `NO_LINK`        | `payments.gateway_link_create_failed`  | FINAL          | no        | PENDING, unpayable  |
| malformed link       | `CREATED`, `linkRejected` (not https)          | `MALFORMED_LINK` | `payments.gateway_link_create_failed`  | FINAL          | no        | PENDING, unpayable  |
| no card (card route) | `CREATED`, no card                             | `NO_CARD`        | `payments.gateway_link_create_failed`  | FINAL          | no        | PENDING, unpayable  |
| 400 / other 4xx      | `REFUSED`, `httpStatus`                        | `BAD_REQUEST`    | `payments.gateway_link_create_failed`  | FINAL          | no        | FAILED              |
| 401                  | `REFUSED`                                      | `UNAUTHORIZED`   | `payments.gateway_link_create_failed`¹ | FINAL          | no        | FAILED              |
| 403                  | `REFUSED`                                      | `FORBIDDEN`      | `payments.gateway_link_create_failed`¹ | FINAL          | no        | FAILED              |
| 429 (last attempt)   | `RATE_LIMITED` × `TONPAYS_CREATE_MAX_ATTEMPTS` | `RATE_LIMITED`   | `payments.gateway_link_create_failed`  | FINAL          | yes       | FAILED              |
| 5xx                  | `UNKNOWN` `http.5xx`                           | `PROVIDER_ERROR` | `payments.gateway_create_unknown`      | UNKNOWN        | yes       | PENDING, never sent |
| HTML/garbled answer  | `UNKNOWN` `http.N.unreadable.*`                | `BAD_RESPONSE`   | `payments.gateway_create_unknown`      | UNKNOWN        | yes       | PENDING             |
| timeout              | `UNKNOWN` `http.timeout`                       | `TIMEOUT`        | `payments.gateway_create_unknown`      | UNKNOWN        | yes       | PENDING             |
| provider unreachable | `UNKNOWN` `http.network.*`                     | `UNREACHABLE`    | `payments.gateway_create_unknown`      | UNKNOWN        | yes       | PENDING             |
| unknown result       | `AMBIGUOUS` (duplicate order) / order mismatch | `UNKNOWN`        | `payments.gateway_create_unknown`      | UNKNOWN        | no        | PENDING             |
| worker died mid-call | stamped, never answered                        | `UNKNOWN`        | `payments.gateway_create_unknown`      | UNKNOWN        | no        | PENDING             |
| key missing          | no credential                                  | `CONFIGURATION`  | `payments.gateway_link_create_failed`¹ | FINAL          | no        | FAILED              |

¹ A refusal of the installation's own configuration ALSO opens (once per gateway) the
existing `payments.gateway_misconfigured` condition, closed by `payments.gateway_configured`
on the next successful create — the gateway-health dashboard reads it. That is a state of
the gateway; the link failure is the attempt. Two different facts, two rows.

A 429 that will be asked again is **not** reported: a retry in progress is nothing an
operator can act on. `retryable` means "a later attempt may succeed with nobody changing
anything"; it never means Nexa re-sends: a create whose answer was lost is never re-sent
(CLAUDE.md, TonPays rules).

`payments.gateway_create_unknown` keeps its code and its per-payment dedupe, so an
operator's existing filter still finds it; it now carries the full context. FINAL failures
use the new code, aggregated per gateway and kind per hour.

**Fields** (event context, and the message): category `PAYMENTS`, phase
`PAYMENT_LINK_CREATE`, timestamp, tenant, bot (when the attempt names one), gateway,
method `GATEWAY`, internal payment id, order id, the order id sent to the provider, the
provider's invoice id when one exists, the public tracking code, the customer's numeric
Telegram id, the sanitized error code, the remote HTTP status when there was one,
retryability, FINAL/UNKNOWN, the creation state, and the elapsed time. Correlation: the
event id is printed (`شناسه رخداد`) and is the row's primary key.

**Tracking code (coordination with FIX-02).** Until FIX-02's exported public-tracking-code
function merges, the code is the payment's own `reference`, read at ONE call site
(`GatewayPaymentService.reportLinkFailure`, comment `FIX-02 owns…`). Switching it is a
one-line change there.

### Example (synthetic data)

What the group receives for a TonPays 502 (rendered by the real template and renderer in
`tests/unit/ops-error-events.test.ts`):

```
🚨 خطای ساخت لینک پرداخت
درگاه: TONPAYS
روش پرداخت: GATEWAY
کاربر: 123456789
کد پیگیری پرداخت: 7d433a363380f69e
شناسه پرداخت: 01900000-0000-7000-8000-00000000fa11
سفارش: 01900000-0000-7000-8000-00000000fa12
شناسه سفارش نزد درگاه: nx7d433a363380f69e
مرحله: ایجاد پیش‌فاکتور (PAYMENT_LINK_CREATE)
علت: پاسخ نامعتبر درگاه؛ خطای سمت درگاه (http.502)
وضعیت HTTP درگاه: 502
تکرار: ممکن است تلاش بعدی بدون تغییر موفق شود
وضعیت: نیازمند بررسی؛ نتیجه نامشخص است و ممکن است پیش‌فاکتور نزد درگاه ساخته شده باشد (CREATE_UNKNOWN)
تعداد رخداد در این بازه: 1
شناسه رخداد: evt_…
🏢 مستأجر: …
🤖 ربات: …
🕒 زمان: …
```

The text comes from the template `ops.notification.payment_link_failed` (catalogue
`packages/i18n/src/catalogue.fa.ts`, editable per tenant in the Web Admin). Exactly one
`علت` line survives — the renderer drops every line whose placeholders are all absent.

## Coverage matrix

Visibility: **L** = `operational_events` (Web Admin alerts / ops log), **A** = audit log,
**G** = the Telegram log group (when `ops_notifications` is on). Generic messages use
`ops.notification.operational_event`: Persian labels, the class, the code, the recorded
message (English), the allow-listed details.

Sample generic message shape:

```
ERROR — telegram.turn_failed
A Telegram update could not be handled.

botInstanceId: …
updateId: 7001
error: RangeError
🏢 مستأجر: …
🤖 ربات: …
🔁 تعداد رخداد: 2
```

| Area / source                                   | Class           | Code                                                                                                              | Group message (fa)                        | Correlation key                           | PII                                       | Visibility | Test                                                                  |
| ----------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Payments — link create, FINAL                   | ERROR           | `payments.gateway_link_create_failed` (new)                                                                       | 🚨 خطای ساخت لینک پرداخت … وضعیت: نهایی   | event id; payment id; provider order id   | Telegram id only                          | L A G      | `ops-error-events.test.ts` (integration) per case; unit `FIX-04: …`   |
| Payments — link create, UNKNOWN                 | WARN            | `payments.gateway_create_unknown`                                                                                 | 🚨 خطای ساخت لینک پرداخت … نیازمند بررسی  | as above                                  | Telegram id only                          | L A G      | same                                                                  |
| Payments — gateway configuration                | ERROR           | `payments.gateway_misconfigured` / `_configured`                                                                  | generic                                   | provider                                  | none                                      | L G        | existing `tonpays-gateway.test.ts`                                    |
| Payments — late approval                        | WARN            | `payments.gateway_late_completion` (+ financial log)                                                              | generic + `ops.financial.late_completion` | payment id                                | none                                      | L A G      | existing                                                              |
| Payments — identity mismatch, webhook, charge   | WARN / SECURITY | `payments.gateway_identity_mismatch`, `_webhook_unverified`, `_charge_unmatched`                                  | generic                                   | payment id / provider                     | none                                      | L G        | existing                                                              |
| Payments — receipt / card change unknown        | WARN            | `payments.gateway_receipt_unknown`, `_card_change_unknown`                                                        | generic                                   | payment id                                | none                                      | L A G      | existing                                                              |
| Payments — review unresolved / reconciled       | WARN / INFO     | `payments.gateway_review_unresolved` / `_reconciled`                                                              | generic + `ops.financial.outcome_unknown` | payment id                                | none                                      | L A G      | existing                                                              |
| Payments — receipt push to admins               | ERROR           | `payments.receipt_push_failed` / `_ok`, `refund_request_push_*`                                                   | generic                                   | bot                                       | none                                      | L G        | existing                                                              |
| Payments — FX                                   | WARN / ERROR    | `fx.quote_unavailable`, `fx.quote_rejected`, `fx.source_unavailable`, `fx.fallback_in_use`, `fx.stale_quote_used` | generic                                   | source                                    | none                                      | L G        | existing `fx` tests                                                   |
| Payments — confirm / reject / refund (facts)    | —               | financial log `ops.financial.*` (WP18)                                                                            | ✅/❌/↩️ … (financial templates)          | payment / refund id                       | name, username, Telegram id (WP18 policy) | A G        | existing `financial-log` tests                                        |
| Wallet — undeliverable order refunded           | INFO            | `order.refunded_undeliverable`                                                                                    | generic                                   | order id                                  | none                                      | L A G      | existing                                                              |
| Delivery — provisioning stalled / delivered     | ERROR / INFO    | `provisioning.stalled` / `provisioning.delivered`                                                                 | generic                                   | service id                                | none                                      | L A G      | existing provisioner tests                                            |
| Delivery — panels                               | ERROR / WARN    | `panel.health.*`, `panel.capacity.*`, `panel.monitor.*`, `panel.probe.*`                                          | generic                                   | panel id                                  | none                                      | L G        | existing                                                              |
| Telegram — customer send                        | ERROR           | `telegram.customer_send_failed` / `_ok`                                                                           | generic                                   | bot                                       | none                                      | L G        | existing                                                              |
| Telegram — turn failed (webhook)                | ERROR           | `telegram.turn_failed` (now WINDOW, quiet)                                                                        | generic                                   | bot, update id                            | none (no message text)                    | L G        | `ops-error-events-surfaces.test.ts` "a Telegram turn that throws…"    |
| Telegram — ops-group update failed              | ERROR           | `telegram.ops_group_update_failed` (now WINDOW, quiet)                                                            | generic                                   | bot, update id                            | none                                      | L G        | not separately tested (same helper as above)                          |
| Telegram — decoration, retention, channels      | WARN / ERROR    | `telegram.appearance_decoration_*`, `telegram.message_retention_*`, `channels.membership_*`                       | generic                                   | bot                                       | none                                      | L G        | existing                                                              |
| Telegram — business chats                       | ERROR / WARN    | `support.business_update_failed`, `support.business_connection.*`, `support.handoff_*`                            | generic                                   | connection                                | none                                      | L G        | existing                                                              |
| Users — anti-spam block                         | SECURITY        | `antispam.customer_blocked` (new)                                                                                 | generic, class SECURITY, SECURITY topic   | customer id, Telegram id                  | Telegram id only                          | L A G      | `ops-error-events-surfaces.test.ts` "an anti-spam block…"             |
| Users — anti-spam store down                    | SECURITY        | `antispam.unavailable` / `antispam.recovered`                                                                     | generic                                   | bot                                       | none                                      | L G        | existing                                                              |
| Bot setup — token, commands, menu               | ERROR           | `bot.token_replacement_incomplete`, `bot.command_sync_failing`, `bot_menu.published_unreadable` (+ recoveries)    | generic                                   | bot                                       | none                                      | L A G      | existing                                                              |
| Security — permission denied                    | SECURITY        | `access.permission_denied`                                                                                        | generic, class SECURITY                   | actor, permission                         | admin id                                  | L G        | existing; class printing: unit "presents a security code as SECURITY" |
| Security — lock-out, admin changes              | SECURITY        | `auth.login_locked_out`, `admin.*`                                                                                | generic, class SECURITY                   | subject                                   | admin id                                  | L A G      | existing                                                              |
| Notifications — outbox exhausted                | ERROR           | `outbox.message_exhausted`                                                                                        | generic                                   | event id                                  | none                                      | L G        | existing                                                              |
| Notifications — sweep withdrawn                 | WARN            | `notification.sweep_withdrawn`                                                                                    | generic                                   | notification id                           | none                                      | L G        | existing                                                              |
| Jobs — worker loop stalled / recovered          | ERROR / INFO    | `job.loop_stalled` / `job.loop_recovered` (new)                                                                   | generic                                   | loop name                                 | none                                      | L G        | unit "a stalled worker loop is a condition…"                          |
| System — unhandled API failure                  | ERROR           | `internal.unhandled` (new as an event)                                                                            | generic, ERRORS topic                     | route pattern, error name, correlation id | none (no message, no URL)                 | L G        | `ops-error-events-surfaces.test.ts` "an unhandled API failure…"       |
| System — settings, incidents, backups, recovery | as recorded     | `settings.stored_value_*`, `incident.*`/`maintenance.*`, `backup.*`, `recovery.*`                                 | generic (backups topic)                   | subject                                   | none                                      | L A G      | existing                                                              |

## Exception inventory

Every failure point found in the audit, and what reports it. "Covered" means a row in the
matrix above records it; "via X" names the chokepoint that catches it when it is not
recorded at its own site.

| #   | Failure point                                                            | Status                  | How / why                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gateway create: refused (4xx), rate-limited (final), configuration       | **Covered (new)**       | `payments.gateway_link_create_failed`                                                                                                                                                                                           |
| 2   | Gateway create: created without a usable link / card                     | **Covered (new)**       | was a log line and a row note only                                                                                                                                                                                              |
| 3   | Gateway create: timeout, 5xx, network, unreadable, ambiguous             | **Covered (enriched)**  | `payments.gateway_create_unknown` existed with paymentId/provider/reason only                                                                                                                                                   |
| 4   | Gateway create: worker died mid-call (`nexa.send_interrupted`)           | **Covered (new)**       | had no event at all                                                                                                                                                                                                             |
| 5   | Gateway create: credential missing                                       | **Covered**             | misconfigured condition (existing) + link failure (new)                                                                                                                                                                         |
| 6   | Gateway create: 429 that will be retried                                 | Not reported, by design | a retry in progress; reported when the last attempt is refused                                                                                                                                                                  |
| 7   | Gateway create: attempt closed before sending                            | Not reported, by design | the payment already ended (deadline/withdrawn); no provider call happened                                                                                                                                                       |
| 8   | Gateway inquiry: CONFIGURATION                                           | Covered                 | `payments.gateway_misconfigured`                                                                                                                                                                                                |
| 9   | Gateway inquiry: FAILED / NOT_FOUND / RATE_LIMITED (transient, retried)  | **Partial**             | recorded on the attempt (`last_inquiry_error_code`) and on the gateway-health dashboard; no group message. A persistent inquiry outage surfaces as `payments.gateway_review_unresolved` / late completion. Candidate follow-up. |
| 10  | Webhook: unverified signature, identity mismatch, unmatched Stars charge | Covered                 | existing codes                                                                                                                                                                                                                  |
| 11  | Receipt upload / card change: unknown outcome                            | Covered                 | existing codes                                                                                                                                                                                                                  |
| 12  | Receipt push to administrators fails                                     | Covered                 | `payments.receipt_push_failed`                                                                                                                                                                                                  |
| 13  | Payment confirm / reject / expire / refund outcomes                      | Covered (financial log) | `ops.financial.*` (WP18) to the PAYMENTS topic; FIX-03 owns confirmation latency                                                                                                                                                |
| 14  | FX quote / source failures                                               | Covered                 | `fx.*`                                                                                                                                                                                                                          |
| 15  | Wallet / ledger write failure inside a request                           | Covered via chokepoint  | the transaction rolls back; the Web Admin answer is a 5xx → `internal.unhandled` (new); a Telegram turn → `telegram.turn_failed`. Domain refusals (insufficient balance) are user errors, not events.                           |
| 16  | Undeliverable order refunded                                             | Covered                 | `order.refunded_undeliverable`                                                                                                                                                                                                  |
| 17  | Provisioning: create/renew/add-traffic/time failed, UNKNOWN, stalled     | Covered                 | `provisioning.stalled` (+ refund event); UNKNOWN goes UNRECONCILED and opens the stalled condition                                                                                                                              |
| 18  | Subscription / QR delivery message to the customer fails                 | Covered                 | `telegram.customer_send_failed` (per bot condition)                                                                                                                                                                             |
| 19  | Panels: health, capacity, probe budget                                   | Covered                 | `panel.*`                                                                                                                                                                                                                       |
| 20  | Telegram send / edit refused or rate-limited (customer)                  | Covered                 | `telegram.customer_send_failed` (reason `RATE_LIMITED`, `TOKEN_REJECTED`, …)                                                                                                                                                    |
| 21  | Telegram webhook turn throws                                             | **Covered (fixed)**     | `telegram.turn_failed` existed but (a) its key never reopened, so only the first failure ever reached the group, and (b) a failing recorder turned the 2xx into a 5xx — a redelivery loop. Now WINDOW + `recordQuietly`.        |
| 22  | Ops-group update handling throws                                         | **Covered (fixed)**     | same two fixes                                                                                                                                                                                                                  |
| 23  | Anti-spam blocks a customer                                              | **Covered (new)**       | was audit + outbox event only                                                                                                                                                                                                   |
| 24  | Anti-spam store unavailable                                              | Covered                 | `antispam.unavailable`                                                                                                                                                                                                          |
| 25  | Expected user-input errors (validation, refused codes, minimums)         | Not reported, by design | answered to the user; would be spam                                                                                                                                                                                             |
| 26  | Bot token replacement, command sync, menu publish                        | Covered                 | `bot.*`, `bot_menu.*`                                                                                                                                                                                                           |
| 27  | Bot registration / webhook registration at install                       | **Not covered**         | `botctl`/bootstrap CLI output only; runs before a tenant's log group can exist. Out of reach of an in-app event by construction.                                                                                                |
| 28  | Permission denials                                                       | Covered                 | `access.permission_denied` (class SECURITY)                                                                                                                                                                                     |
| 29  | Login lock-out, administrator changes                                    | Covered                 | `auth.login_locked_out`, `admin.*`                                                                                                                                                                                              |
| 30  | Outbox message exhausted                                                 | Covered                 | `outbox.message_exhausted`                                                                                                                                                                                                      |
| 31  | Notification delivery fails (operations group)                           | Covered as visibility   | attempts + group health + preserved state; deliberately no event (no log-of-log)                                                                                                                                                |
| 32  | Worker loop: every pass throws / stops                                   | **Covered (new)**       | `job.loop_stalled` from the heartbeat's `stalledLoops`                                                                                                                                                                          |
| 33  | Worker loop: an occasional pass throws, then recovers                    | **Partial**             | process log only (`… pass failed`); not stale, so not reported. Each loop catches its own pass; a central per-pass hook would need every loop edited (the "scattered catch" the brief forbids). Candidate follow-up.            |
| 34  | API: unhandled 5xx                                                       | **Covered (new)**       | `internal.unhandled`, aggregated per route pattern and error name                                                                                                                                                               |
| 35  | Monitor / provisioner / recovery process roles' own loops                | **Partial**             | their failures surface through their domain events (`panel.*`, `provisioning.stalled`, `recovery.*`); the stall reporter is wired in the worker only                                                                            |
| 36  | Backups, recovery, settings, incidents                                   | Covered                 | existing codes                                                                                                                                                                                                                  |
| 37  | Trials, orders, service actions refused by rules                         | Not reported, by design | user-facing refusals; an unexpected failure is #15                                                                                                                                                                              |
| 38  | Support AI, legacy importer / Mirza                                      | Out of scope            | excluded by the owner's brief; their codes are not classified here and the inventory test skips their directories                                                                                                               |

So: **not 100%.** Rows 9, 27, 33 and 35 are known partial or uncovered sources, each with
its reason. Every code the source records today is classified (the inventory test), and
every source above is either reported, deliberately silent with a reason, or listed as a gap.

## Tests

| Rule                                                                  | Test                                                                                                   | Mutation (killed)                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every FIX-04 case → one detailed event + one message                  | `tests/integration/ops-error-events.test.ts` (no link … unknown result, interrupted, key missing, 429) | M1 reportLinkFailure no-op                                                                                                                               |
| a deferred 429 is not reported                                        | integration "429: reported once…", unit "reports nothing…"                                             | M2 (unit kills it; the integration test survives it because the service's deferred branch never calls the reporter — an equivalent mutant at that level) |
| a storm is one row, one message, counted                              | integration "aggregates a storm…", unit "is ONE event…"                                                | M3                                                                                                                                                       |
| no secret / signed URL / PAN in event or message                      | unit "drops a fact…", "never prints a secret…", integration `expectNoSecret` in every case             | M4, M5, M12, M16                                                                                                                                         |
| payment-link layout only for the FIX-04 shape                         | unit "queues the FIX-04 template…", "leaves an event of the same code in another shape…"               | M6, M11                                                                                                                                                  |
| the class (SECURITY) is printed, stored as WARN                       | unit "queues the FIX-04 template…", surfaces "an anti-spam block…"                                     | M7                                                                                                                                                       |
| a failing recorder fails nothing                                      | unit "recordQuietly never throws…", integration "a recorder that cannot write…"                        | M8                                                                                                                                                       |
| log group down: event kept, failure visible, no loop                  | integration "a log group that will not take the message…"                                              | —                                                                                                                                                        |
| tenant isolation                                                      | integration "keeps tenants apart…"                                                                     | —                                                                                                                                                        |
| loop stalls open once, re-record slowly, close; inherited closed once | unit "a stalled worker loop…"                                                                          | M9a, M9b                                                                                                                                                 |
| malformed link is told apart from no link                             | unit `tonpays-adapter.test.ts` "refuses a link that is not https…", integration "malformed link"       | M10                                                                                                                                                      |
| anti-spam reports only a block that changed something                 | surfaces "an anti-spam block…"                                                                         | M13                                                                                                                                                      |
| unhandled API failure reported                                        | surfaces "an unhandled API failure…"                                                                   | M14                                                                                                                                                      |
| turn failures windowed; a down log still answers 2xx                  | surfaces "a Telegram turn that throws…"                                                                | M15 (key not windowed), M17 (recorded without `recordQuietly`)                                                                                           |
| every recorded code is classified                                     | unit "finds the codes the source records…"                                                             | removing any entry fails it                                                                                                                              |
