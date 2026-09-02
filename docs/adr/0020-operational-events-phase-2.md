# ADR-0020 — Operational events in Phase 2: reading, resolution, retention

**Status:** Accepted. Extends ADR-0007; implemented in Phase 2.

## The problem

Phase 0 built `operational_events` with severity, per-scope dedupe, an
occurrence counter and a `recovers_code` column, and nothing that reads them. An
operator cannot see an operational event without opening a database client.

The legacy system's equivalent is a Telegram forum group: append-only, routed by
topic rather than by severity, with "no ids, no correlation, no dedup, no
severity, no retention" (LGR-BR-080/081). Its `/admin/logs` is separately a
different thing again — actor, a free-text Persian sentence, one customer id, a
timestamp and an IP, with "no before/after values and no entity id — an activity
feed, not an audit trail" (WEB-BR-024), 1,700 rows and no filter or export.

## Decision

### Extend the existing model. Do not build a second log.

There is no new events table, no new severity vocabulary and no parallel
recorder. Phase 2 adds a read model, a resolution link, a retention sweep and a
severity-driven notification projection to the table that already exists.

The three-way separation of ADR-0007 is unchanged and is worth restating,
because Phase 2 is the first phase in which all three are populated by the same
operation:

| Thing                 | Answers                                   | Table                |
| --------------------- | ----------------------------------------- | -------------------- |
| **Domain event**      | what happened, for other modules          | `outbox_messages`    |
| **Audit log**         | who changed what, before → after          | `audit_logs`         |
| **Operational event** | what the system did                       | `operational_events` |
| **Notification**      | who should be told, and whether they were | `notifications`      |

A failing template render is an operational event. An administrator editing that
template is an audit row. Telling somebody about the failure is a notification.
None of the four is derivable from the others.

### The read model

`opslog.view` gates a paginated, filtered list: by severity, by code, by time
window (half-open `[start, end)`), and by whether the condition is currently
open. Ordering is by `last_seen_at` descending, which is what the existing
`(tenant_id, last_seen_at)` index serves. The list is tenant-scoped through the
repository like every other read.

Filters exist because the legacy log has none and 1,700 unpaginated rows is the
result.

### Resolution links; it never deletes

A recovery event carries `recovers_code`. When one is recorded, the open rows it
recovers get `resolved_at` and `resolved_by_event_id` set. **Nothing is
deleted and nothing is overwritten**: the failure row keeps its message, its
occurrence count and its first-seen time, and the recovery row stands on its own
beside it.

If the condition recurs, the dedupe upsert increments the counter and clears
`resolved_at` — the row is open again, and the recovery event that preceded it
is still in the table saying when it was briefly fixed. History is the sequence
of events; resolution is a derived marker on top of it.

The append-only guard installed in migration 0001 is extended to permit exactly
these two columns to change, and nothing else. Immutability is enforced by the
database rather than by reviewers remembering.

### No acknowledgement

Monitoring products usually have one. This one does not, because there is no
evidence any operator here wants to hand-mark events as seen, and an
acknowledgement flag that nobody sets is a column that makes "open" mean two
different things. If an operator asks for it, it is a column and a permission
away.

### Severity routes; topics do not

A notification is emitted for operational events at or above a configured
severity threshold (ADR-0018), which is the corpus's own recommendation:
"carry `severity` on the event so routing is a rule, not a topic choice"
(point 10 of the log-group rebuild recommendation). Dedupe means a condition
that fires sixty times produces one row, one counter and one notification —
which is what BUG-LGR-028 asks for.

### Retention is a policy, not an absence

Operational events are swept by the existing `RetentionSweeper` mechanism, on a
window that is a setting. Unresolved events are never swept while open. The
legacy system has no retention at all, and "Telegram keeps everything"
(`UNK-LGR-011`) is not a policy.

## Rejected

**A separate `incidents` table.** An incident is an open operational event; a
table would be a second copy of one with a different name and its own drift.

**Deleting a failure row on recovery.** Named because it is the tidy-looking
option. It destroys the only record that the problem occurred, which is the
question an operator asks the morning after.

**Routing by code prefix into channels.** That is the legacy topic model with
different words. Severity is the routing key; the code is what you filter by.

## Revisit when

- Volume makes `(tenant_id, last_seen_at)` insufficient for the filters actually
  used. Then the index follows the measured query, not the anticipated one.
- An operator asks for acknowledgement, or for per-code routing.
