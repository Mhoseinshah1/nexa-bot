# ADR-0021 — Concurrency in the control plane

**Status:** Accepted. Implemented in Phase 2.

## The problem

Every Phase 2 write is a read-modify-write on a row an administrator is looking
at: a template body, a setting value, a feature flag. Two administrators with
the same screen open is the normal case, not the exotic one, and the legacy
system's answer is that the second write silently wins — with no version, no
conflict and no before-value on the screen to notice it with.

Phase 1 already has the more dangerous version of this problem solved (the login
throttle's reserve-then-verify), and the lesson from those rounds was that a
check followed by a write is not a guarantee unless the database is doing the
checking.

## Decision

### Optimistic concurrency on the narrowest row that owns the value

`template_overrides`, `setting_values` and `feature_flag_states` each carry an
integer `version`. A write states the version it read; the UPDATE matches on
`(tenant_id, key, version)` and increments. Zero rows updated is a conflict —
`409`, naming the current version — never a retry and never a silent overwrite.

A create is `INSERT … ON CONFLICT DO NOTHING` with the same treatment: zero rows
inserted means somebody else created it first, which is the same conflict.

The check is the write. There is no `SELECT` that decides whether the `UPDATE` is
safe, because between those two statements is exactly where the Phase 1 findings
lived.

### The tenant row is not a lock

Serialising Phase 2 writes on the tenant row would make one global bottleneck
out of three unrelated resources, and would put every template edit behind every
setting edit. The version column is per key, so two administrators editing two
different templates never contend at all, and two editing the same one get a
conflict that names what happened.

The tenant row is still read — `scopeIsActive` inside the transaction, as every
write path does — but it is read, not locked.

### Nothing expensive happens inside a transaction

Rendering a preview, hashing, and every network call happen outside. The
transactions here are short: one UPDATE, one revision insert, one audit row, one
outbox row. The database timeouts configured in Phase 1 (`lock_timeout`,
`statement_timeout`, `idle_in_transaction_session_timeout`) bound the rest.

### Idempotency is unchanged and still per surface

Every command takes an idempotency key, namespaced by the acting surface. A
replayed key returns the first result. Version conflict and idempotent replay
are different answers to different questions: a replay is the same request
arriving twice, a conflict is a different request built on stale state.

## Rejected

**`SELECT … FOR UPDATE` on the row.** It works, and it costs a held lock for the
duration of the request rather than for the duration of one statement. Where the
whole transaction is one UPDATE, the version column gives the same guarantee
without the lock.

**Last-writer-wins.** It is what the legacy system does, and the reason the
corpus can say "an admin cannot read the current configuration without
overwriting it" without anyone having noticed the writes colliding.

**A single `updated_at` comparison instead of a version.** Two writes inside the
same clock tick compare equal, and the clock is a port that tests control.

## Revisit when

- A write needs to span two of these rows atomically. Then the transaction
  covers both versions, and the conflict is on either — still no lock on the
  tenant.
