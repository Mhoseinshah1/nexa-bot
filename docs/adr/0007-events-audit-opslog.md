# ADR-0007 — Domain events, audit and operational events are three different things

**Status:** Accepted. Matches the architecture review's ADR-010.

## Decision

Three models, deliberately not merged:

|                       | Question it answers         | Table                | Mutability                                  |
| --------------------- | --------------------------- | -------------------- | ------------------------------------------- |
| **Domain event**      | What changed                | `outbox_messages`    | content immutable; delivery fields writable |
| **Audit log**         | Who changed it, and to what | `audit_logs`         | append-only                                 |
| **Operational event** | What the system did         | `operational_events` | counter and last-seen only                  |

A fourth, **notification** (intent to inform, separate from delivery attempts),
arrives in Phase 2.

The database is the log. Telegram, webhooks and any ops channel are
**projections** of `operational_events`, filtered by severity.

## Why not one table

Their retention, access control, query patterns and consumers all differ. An
audit row is evidence and must be immutable for years. An operational event is
diagnostics and needs deduplication. A domain event is an integration mechanism
and gets deleted once archived.

## Phase 0 ships two of them

`operational_events` and `audit_logs` both exist and both have real producers:
the write path writes an audit row on success **and on denial**, and the guard
records every denial as a `WARN` operational event. There is no notification
model yet, because nothing sends anything.

## Enforcement is in the database

Triggers, not conventions:

- `audit_logs` refuses UPDATE and DELETE for every role, including the owner.
- `operational_events` refuses DELETE, refuses changes to identity fields, and
  refuses a decreasing occurrence counter — but permits the counter and
  `last_seen_at` to advance, which is the whole point of the dedupe key.
- `outbox_messages` refuses changes to its content while permitting
  `published_at`, `attempts` and `last_error`.

Production should additionally run the application as a non-owner role without
UPDATE or DELETE grants on those tables. The triggers are the floor.

## What this prevents

The legacy `/admin/logs` records an actor, a free-text Persian sentence, one
customer id and a timestamp — no entity type, no entity id, no before or after
values. It is an activity feed, not an audit trail. Its Telegram log group holds
38 hand-written templates with no event ids, no correlation, no severity, no
dedupe and no recovery events; 60 identical TLS errors landed there in a single
day with no way to suppress or resolve them.
