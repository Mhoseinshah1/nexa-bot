# ADR-0018 — Notifications: intent, delivery attempts and transports

**Status:** Accepted. Implemented in Phase 2 for operational notifications.

## The problem

The legacy system has one notification destination — a single numeric Telegram
group id — and no delivery model at all behind it.

- The destination has **no fallback, no per-notification routing, no test-send
  and no way to clear it** (GSR-001/002/003). Forum topics are required but no
  topic id was ever captured anywhere (`UNK-GS-002`).
- There is **no delivery status field**. Whether the notification report records
  notifications that were _sent_ or conditions that merely _matched_ is
  `UNK-LGR-015`, and it is open. That is precisely the intent-versus-attempt
  question, and the corpus cannot answer it.
- There is **no evidence of any rate-limit handling** anywhere: no 429, no send
  queue, no batching, no back-off, in any phase. Every phase was UI-only, so
  this is `NOT_EXPOSED` rather than proven absent — but a mass top-up can
  broadcast to every account, "a one-account run and a 197,000-account run are
  visually identical", against a base of roughly 13,700 customers.
- Errors are **not deduplicated and never resolved**: the same expired-TLS error
  was posted 36 + 15 + 8 + 1 times in one day (BUG-LGR-028), and no error is
  ever followed by a recovery message (BUG-LGR-029).

## Decision

### A notification is an intent. A delivery attempt is a fact.

Two tables, and the distinction is the point of the design rather than a detail
of it.

**`notifications`** — one row per thing that should be communicated. It carries
the tenant, the kind, the destination reference, a typed payload, a status, and
a `dedupe_key` that is unique per tenant. It is created **inside the business
transaction** that produced it, alongside the audit row and the outbox row.

**`notification_delivery_attempts`** — append-only, one row per attempt. Attempt
number, transport, start and finish, outcome, and — when the transport says so —
the error and the `retry_after` it asked for.

A notification that failed four times has one row in the first table and four in
the second. Reading the first tells you what the system meant to say; reading
the second tells you what actually happened on the wire. The legacy system has
one field that is quietly both, which is why `UNK-LGR-015` cannot be answered.

**A retry never creates a second notification.** Retries append attempts. The
dedupe key is the intent's identity, the job id is the notification's id, and
both are enforced by unique constraints rather than by the queue behaving well.

### No network call inside a transaction

The business transaction writes the intent and commits. A dispatcher in the
worker process then claims due intents with `FOR UPDATE SKIP LOCKED`, commits
the claim, calls the transport **outside any transaction**, and records the
attempt and the outcome in a second short transaction.

This is not a style preference. A send holds a socket open for as long as
Telegram feels like taking, and a transaction that waits on it holds its locks
for the same duration — which is how a slow third party becomes a database
incident.

**The dispatcher is a poller and not an outbox consumer, and that was a
correction.** The first version of this ADR routed notifications through a
`NotificationQueued` domain event, on the reasoning that the outbox is already
the durable hand-off. Reading `OutboxRelay` showed why that does not work:
consumers run INSIDE the relay's claim transaction, by design — that transaction
is what makes `processed_messages` an effectively-once claim. A consumer that
sent would therefore hold a database transaction open across a Telegram call,
which is the exact thing this section forbids.

The event was removed rather than the rule bent. It would in any case have been
a second durable copy of a fact the intent row already records, with no consumer
other than "wake the sender up".

The dispatcher's claim moves `next_attempt_at` forward by a lease before the
send, so an intent whose sender dies mid-flight becomes eligible again rather
than staying claimed forever, and the row's attempt history says how many times
that happened.

### Transports are a port, and the real one is real

`NotificationTransport` is a port with two implementations:

- **`TelegramNotificationTransport`** — a genuine sender. It resolves the
  tenant's bot instance, decrypts the token through the existing cipher, posts
  to the configured chat and message thread, and classifies the response into
  `SUCCEEDED`, `FAILED_PERMANENT` or `FAILED_RETRYABLE`. A 429 is retryable and
  its `retry_after` is honoured; a 400 naming a bad chat id is permanent and
  retrying it forever would only make the log noisier.
- **`RecordingTransport`** — deterministic, in-memory, used by tests. It is a
  test double, not a production fallback: selecting it in a non-test environment
  is a configuration error that fails at boot rather than silently swallowing
  every notification.

Phase 2's notifications are **operational** — addressed to the people running
the installation, about the installation. Customer-facing notifications
(expiry warnings, delivery messages, receipt outcomes) are not in this phase,
because the things they would notify about do not exist yet. The seam is the
same one they will use; what is missing is their triggers, not their plumbing.

### The destination is configuration, and it is testable

The chat id and the optional message thread id are settings (ADR-0017), so they
are readable, versioned and audited. A **test-send** is an explicit operation:
`UNK-GS-002` records that the legacy log group requires forum topics but that no
topic id was ever captured, and a destination that cannot be tested is a
destination that is discovered to be wrong during an incident.

`UNK-WEB-001` — the legacy system has two independent notification destinations
for one concept and it is unknown which is authoritative — is answered by not
reproducing the ambiguity: one destination per tenant, configured once, named in
one setting.

### Rate limiting is built, not inherited — and it is a fixed window per process

Because the corpus shows none, and because absence of evidence here is not
evidence of absence, the transport treats Telegram's limits as real: attempts
are bounded, back-off is exponential with jitter, and a `retry_after` from the
API overrides the computed delay.

What the ceiling actually is, stated plainly rather than flatteringly: a fixed
one-minute window counted **in the dispatcher's own memory**. Two worker
processes therefore allow twice the configured rate, and a restart resets the
window. Sends are sequential within a tick, not concurrent.

That is adequate for one worker sending operational messages to one group, and
it is not a distributed rate limiter. Making it one means moving the counter
into Redis or Postgres, and it is the change to make when a second worker is
deployed rather than a thing to claim now.

### A message can be sent twice, and the design bounds how often

The lease is longer than any plausible send, so a slow Telegram does not
normally produce a second dispatcher sending the same message. "Normally" is the
honest word: there is no ownership token, so a send that outlives
`NOTIFICATION_CLAIM_LEASE_MS` can be claimed and sent again.

Two things bound it. The attempt ceiling caps how many times that can happen,
and the terminal-status predicate on `recordAttempt` stops the slow sender
resurrecting an intent a second dispatcher has already completed — so the late
writer cannot restart the cycle. What remains is one duplicate operational
message in a case where Telegram took longer than two minutes to answer, which
is a better failure than the alternative (a stalled sender holding its work
forever, so the alert never arrives at all).

An ownership token — claim with a nonce, record only if the nonce still matches
— would close it, and is the change to make if duplicates are ever observed.

### The exhaustion sweep does not ask whether the tenant is active

`claimDue` refuses an inactive tenant, and the dispatcher asks again on the
line before each send. `failExhausted` deliberately does neither, and the
asymmetry is the decision rather than an oversight.

Those two govern SENDING, and a stopped installation must not send. This
governs bookkeeping about sends that have already been attempted. An intent
only reaches `attempt_count = max_attempts` by being claimed, which a stopped
tenant cannot be, so its attempts were genuinely spent while it was active.
Withholding that verdict until the tenant returns would leave the row PENDING
for the length of the pause — the "reported as pending for ever" state this
sweep exists to end.

A pause is still not a verdict, and nothing here makes it one. A late
SUCCEEDED can move a swept row from FAILED to SENT whenever it arrives, and a
claim handed back by `releaseClaim` has its attempt returned, so a paused
tenant's queued work never reaches this predicate at all.

### There is no retention or archive for notifications, and that is a decision

Phase 2 never deletes, archives or summarises a notification intent, a delivery
attempt or a **released claim**. All three tables grow monotonically, and on a
sufficiently long-lived installation they grow without bound. That is an
acknowledged tradeoff, recorded here rather than discovered later.

`notification_released_claims` is the newest of the three and the one most
easily missed. It carries a foreign key to `notifications` and no-update /
no-delete triggers of its own, so a notification row can no longer be deleted
at all while a claim of its has been returned — the retention decision does not
merely include this table, it is constrained by it.

The reasoning is the same one that leaves the operational log unswept. Delivery
attempts are **append-only evidence**: the question a stuck notification
provokes is "what did the third attempt fail with", and a row deleted on a
schedule is a row that cannot answer it. Intents are what attempts hang off, so
deleting an intent while keeping its attempts either orphans the evidence or
takes it along.

No retention duration is invented here. A number chosen without an operator's
requirement is not a policy, it is a default that quietly becomes one — and the
legacy system's answer to log volume was "no retention at all, no dedup, no
severity" (LGR-BR-080/081), which is the failure this ADR already exists to fix
at the other end.

Whoever adds retention must decide, explicitly and in an ADR, all of:

- **Archival, not just deletion** — where the rows go, or an argument for why
  losing them is acceptable.
- **Duration**, from a stated operational requirement rather than a round number.
- **Evidence and history** — whether attempts may be removed at all, given they
  are the delivery record.
- **Referential integrity** — what happens to attempts whose intent is gone, and
  to the `(tenant_id, notification_id, attempt_number)` unique index.
- **Released claims**, which are accounting as well as history: spend is
  `attempt_count` minus these rows, so removing one silently spends an attempt
  that was handed back. Any policy has to say whether they go with their intent,
  and how the arithmetic stays correct for whatever survives — which also means
  deciding what happens to the `nexa_reject_mutation` and exclusivity triggers
  that currently refuse every delete on both this table and the attempts.
- **Storage bounds** — what the policy actually guarantees, so the claim can be
  checked.
- **Any change to the append-only policy**, which is a contract change and
  belongs in its own commit.

Until then, an operator who needs the space reclaims it deliberately, knowing
what they are discarding.

## Rejected

**One table with a `status` column and an attempt counter.** It cannot answer
"what did the third attempt fail with", which is the only question worth asking
when something is not arriving.

**Sending inline from the request that caused the event.** It makes an
administrator's HTTP call fail because Telegram is slow, and it puts the send
inside the transaction.

**A "production sender" that logs instead of sending.** The Phase 2 brief allows
a deterministic test transport where real delivery would require building future
functionality. It does not require one here, because delivering an operational
message to an administrators' group needs nothing from the customer-facing
product. A fake sender would be the placeholder pattern this codebase exists to
avoid, and it would report success for something that did not happen.

**Retrying every failure.** A permanently wrong chat id retried with back-off
forever is a slow-motion version of the legacy log group's 60 identical errors.

## Revisit when

- Customer-facing notifications arrive (Phase 6/7). They add kinds, a recipient
  resolver and per-customer rate accounting; the intent/attempt split and the
  transport port do not change.
- A second transport exists (email, webhook). The port is already the seam;
  routing by kind becomes a registry rather than a setting.
