# ADR-0006 — Transactional outbox, at-least-once delivery, durable idempotency

**Status:** Accepted. Matches the architecture review's ADR-009.

## Decision

**Outbox for events, BullMQ for work.** State changes emit events; work runs as
jobs. Conflating them loses one guarantee or the other.

- A domain event is written to `outbox_messages` in the **same transaction** as
  the state change, so it exists if and only if that change committed.
- The relay claims rows with `FOR UPDATE SKIP LOCKED`, so multiple relay
  instances are safe.
- Ordering is guaranteed per `(aggregate_type, aggregate_id, sequence)` and
  nowhere else. Nothing in the design needs global ordering.
- Delivery is **at-least-once**. Effects are **effectively-once**, because each
  consumer claims a row in `processed_messages` keyed by
  `(consumer, message_id)` before handling. One half without the other is not a
  guarantee.
- `correlation_id` is a **column**, not only an ambient value, so a business
  transaction can be followed across the queue boundary.

## No dead-letter queue on the relay

An event that cannot be delivered is a bug to fix, not a message to discard. The
relay retries indefinitely, records `attempts` and `last_error`, and reports lag
so a stall is visible: readiness fails when the oldest unpublished message
exceeds `OUTBOX_RELAY_MAX_LAG_MS`. Work queues added later will have DLQs; the
relay will not.

## Idempotency

Every state-changing command takes a key. `request_idempotency` stores
`(scope_ref, key)` uniquely with the request hash and the first result. A replay
returns that result. **A key reused with a different payload is rejected** —
that combination is always a caller bug, and returning the stale result would
hide it.

`scope_ref` is text, not a nullable `tenant_id`, because Postgres treats NULLs
as distinct in a unique index, which would silently permit duplicate keys for
system-scoped work.

## What this prevents

The legacy system has no idempotency, no payment record, no status enum, no
dedupe, no expiry and no webhook log. A duplicate gateway callback there is
indistinguishable from a second purchase, and its operational log is
append-only with no ids, no correlation, no dedupe and no recovery events — the
signature of notifications emitted inline rather than through an event pipeline.

## Tested by

Rollback leaves no outbox row; commit publishes exactly once; a forced
redelivery is received twice and applied once; a failing consumer increments
attempts and records the error without losing the message; a replayed command
produces one state change, one audit row and one outbox row.
