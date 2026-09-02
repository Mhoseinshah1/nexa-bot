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

The transaction writes the intent. The outbox row relays it. A worker consumer
picks the job up, loads the intent, calls the transport **outside any
transaction**, and records the attempt in a short transaction of its own.

This is not a style preference. A send holds a socket open for as long as
Telegram feels like taking, and a transaction that waits on it holds its locks
for the same duration — which is how a slow third party becomes a database
incident.

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

### Rate limiting is built, not inherited

Because the corpus shows none, and because absence of evidence here is not
evidence of absence, the transport treats Telegram's limits as real: attempts
are bounded, back-off is exponential with jitter, and a `retry_after` from the
API overrides the computed delay. Notification sending is a queue with a
concurrency ceiling rather than a loop.

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
