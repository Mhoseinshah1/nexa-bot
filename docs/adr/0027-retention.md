# ADR-0027 — What this installation keeps, and for how long

**Status:** Accepted. Written during the Architecture Hardening pass (items I and
the `backup_runs` decision the owner required). Extends ADR-0020, which decided
retention for `operational_events`; supersedes nothing.

## The problem

The legacy system's answer to retention was that there was no answer. Every table
grew for ever, and the one deletion path that existed — "optimisation", a single
button that removed six order classes — had no dry run, no count, no confirmation
and no undo.

This codebase went the other way and then stopped halfway. Nothing deletes
business or audit state, and that is structural rather than conventional: six
tables carry `BEFORE DELETE` triggers, and when a retention sweep for
`operational_events` was drafted the trigger refused it — so the setting was
removed rather than the guard weakened. But eight tables grow without bound, and
four of them had no recorded decision of any kind: `outbox_messages`,
`processed_messages`, `request_idempotency` and `backup_runs`.

"No decision" is the defect. A table nobody chose to keep is not the same as a
table somebody chose to keep, even when the rows are identical, because the first
one gets swept by whoever next notices it is large.

## Decision

Every table that grows is in one of two classes, and the class is written down.

### Kept for ever, deliberately

| Table                                | Why it is never deleted                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `audit_logs`                         | The record of who changed what. Append-only by trigger; ADR-0007.                  |
| `operational_events`                 | Conditions and their recovery. Resolution is a column, never a deletion; ADR-0020. |
| `tenants`, `bot_instances`, `admins` | Identity. A deleted admin is a status change, never a row removal.                 |
| `panels`, `panel_credentials`        | Operable state; a credential's removal is an overwrite with a new ciphertext.      |
| `processed_messages`                 | See below. Kept for ever, and the reason is NOT its size.                          |
| `request_idempotency`                | See below. Kept for ever, and the reason is correctness.                           |

### Bounded, with an age

| Table                  | Age                                | Sweeper          |
| ---------------------- | ---------------------------------- | ---------------- |
| `admin_login_throttle` | window + lockout + 1h              | `login-throttle` |
| `admin_sessions`       | `SESSION_RETENTION_SECONDS` (30d)  | `admin-sessions` |
| `outbox_messages`      | **not swept; see below**           | —                |
| `backup_runs`          | `BACKUP_RUN_RETENTION_DAYS` (365d) | `backup-runs`    |

## `request_idempotency` — kept for ever

This is the table that makes "every state-changing command takes an idempotency
key" mean something. A row is the authority that says a command has already been
executed and what it answered.

Deleting a row does not free an obligation, it LOSES one: the key becomes
unknown again, so the same command replayed after the deletion executes a second
time. There is no age at which that becomes safe, because the client that holds
the key is not a party to our retention policy — `apps/web/src/submission-key.ts`
deliberately keeps a key across a 5xx and retires it only on a 4xx, and a browser
tab left open over a weekend is not an exotic case.

It is also not a growth problem in the shape people expect. A row is written per
successful state-changing command, by an authenticated administrator or a bot
update, and is a few hundred bytes. An installation doing a thousand admin
mutations a day accumulates about 70 MB a year.

**If this is ever bounded**, the bound must be derived from the longest retry a
client can make, not from a size target, and the surfaces must stop keeping keys
for longer than that. That is a protocol change, not a sweep.

## `processed_messages` — kept for ever

The awkward one, and the audit was right to name it. It is pure bookkeeping — one
row per `(consumer, message_id)` — and it is guarded as append-only evidence. A
retention sweep would need a migration to weaken that guard.

It stays, and the guard stays, because of what the row does: it is what makes the
outbox pipeline at-least-once delivery with effectively-once EFFECTS. The relay
claims a message and runs the consumer in one transaction, and this row is the
proof the effect already happened. Delete it and a redelivered message — which is
the normal case after a crash, not an exotic one — runs its effect twice.

Its size is bounded by `outbox_messages` in practice, since a row is written per
message per consumer.

## `outbox_messages` — kept, and this is the one to revisit first

Not swept today, and the decision is deliberate rather than inherited.

A dispatched outbox row is the causal record of a domain event: which event, in
which transaction, with which correlation id, delivered when. It is the only place
the `correlation_id` survives the queue boundary, which is what ADR-0006 says the
column is for.

But unlike the two above, nothing about CORRECTNESS needs an old dispatched row.
`processed_messages` is what prevents a double effect; this is history. So this is
the table whose retention is a reporting question rather than a correctness one,
and it is the one to bound first if any of them needs bounding.

**Why not now:** the row carries the event payload, and the reporting projections
Phase 4 will add are not designed yet. Choosing an age before knowing what reads
it would be choosing it from the one fact available — how large it is — which is
how the legacy system's "optimisation" button came to exist. Recorded in
`docs/open-questions.md`.

## `backup_runs` — a year, with four exclusions

A row per backup run: trigger, state, stage, the three sizes, the checksum, when a
real restore verified it, what Telegram said, and what failed. At a daily schedule
that is about 365 rows a year of a few hundred bytes each, so **this is not a size
control**. What it replaces is a table with no policy, and the case where the
bound does real work is a scripted manual-backup loop.

`BACKUP_RUN_RETENTION_DAYS` defaults to 365. A year because the question this
table answers — "when did this installation last have a provably restorable
backup" — is asked after an incident rather than during one, and an annual cycle
covers the audit window an operator is most likely to be asked about. The floor is
a week: anything shorter deletes the history a diagnosis needs while the diagnosis
is still going on.

Four classes of row are never removed, whatever the age says. They are in the
QUERY (`purgeFinishedBefore`) and not in the caller, because a predicate a caller
has to remember is a predicate some caller will not:

1. **`state = 'RUNNING'`.** That row IS the installation's backup lock — the
   partial unique index is over it. Deleting one releases a lock a process may
   still be holding, and two concurrent dumps then write the same paths, which is
   how two partial dumps become one plausible-looking corrupt archive. A run whose
   process died does not stay RUNNING: `reclaimStale` closes it by FAILING it,
   which is a different mechanism with its own timeout, and retention must not
   become a slower, less careful second copy of it.
2. **`delivery_state = 'OUTCOME_UNKNOWN'`.** Telegram may have accepted an upload
   whose answer was lost. Nothing resends and nothing resolves it automatically,
   so the row is the only record that an encrypted archive may be sitting in a
   chat — which is a recovery asset, and if the chat is wrong, an exposure.
   Retained **indefinitely**, not merely longer: there is no age at which an
   unresolved external side effect becomes safe to forget.
3. **The most recent SUCCEEDED run.** `lastSucceededAt()` reads exactly that row
   and the scheduler reads that to decide whether a backup is due. Remove it and
   the installation believes no backup has ever succeeded, takes one immediately,
   and then settles onto a schedule derived from the deletion. An installation
   that has not succeeded in over a year is in trouble; deleting the evidence is
   the worst available response.
4. **The most recent run of any state.** The one an operator is looking at when
   something has just gone wrong. A `backup.run_failed` condition is deduped on
   one installation-wide key and names the run that failed; with that run gone the
   alert names an id nothing can resolve.

### Mechanics

- **Batch size** 500, **ceiling** 100 batches per tick, **interval** 24 hours.
  Smaller batches than the identity sweepers because the eligible set is small by
  construction and each batch carries two "most recent row" subqueries. Daily
  rather than hourly because this table gains a row per backup, so hourly would be
  a thousand no-op passes per row removed.
- **Ordering** oldest first (`finished_at ASC, id ASC`). Without an order a
  bounded batch takes an arbitrary subset, so a backlog larger than one pass could
  leave the oldest row alive indefinitely while the table stayed the same size.
- **Multi-replica safety** needs nothing. `ctid IN (SELECT … LIMIT n)`, and a
  DELETE of a row another transaction already deleted matches nothing — so the
  worst case is a batch that removes fewer rows than it asked for, and the sweeper
  drains until a batch comes back short. No lock, no advisory anything, and no
  assumption that one replica is running. Two worker replicas is the normal case on
  every rolling update.
- **Failure semantics.** A purge that throws propagates to the sweeper's tick,
  which catches and logs — and does NOT record progress, so `LoopProgress` goes
  stale and the worker's readiness reports `backup-run-sweeper` as stalled. A
  sweeper whose every tick fails is therefore visible rather than silent, which is
  the defect item H existed to close.
- **Observation.** The sweeper names itself `backup-runs` in every log line, warns
  when it hits its per-tick ceiling with work remaining, and is one of the loops
  `main.worker.ts` consults. Not gated on `BACKUP_SCHEDULE_ENABLED`: an
  installation with the schedule off still accumulates rows from manual runs, and a
  table whose policy depends on a feature flag has no policy on half the
  installations.

## Consequences

- Four tables that had no recorded decision now have one each, and two of those
  decisions are "kept for ever" with a reason that is about correctness rather
  than about nobody having got round to it.
- `backup_runs` is bounded, and the four rows that must never go are enforced by
  the query rather than by a caller's memory. Ten integration cases against a real
  database cover each exclusion, the batch bound, the ordering, the drain, and two
  sweepers at once.
- `outbox_messages` is named as the one to bound first, with the reason it is not
  bounded yet, in `docs/open-questions.md`.
- No trigger was weakened, and no business or audit table became deletable.

## What was considered and rejected

- **A single `RETENTION_DAYS` for everything.** Rejected: the four tables differ in
  kind, not in degree. One number would either delete an idempotency row that a
  client can still replay, or keep a login-throttle counter for a year.
- **Bounding `processed_messages` alongside `outbox_messages`.** Rejected: they
  look like a pair and are not. One is history; the other is what stops a
  redelivered message running its effect twice.
- **Deleting `backup_runs` rows by count rather than by age** (keep the last N).
  Rejected: a count cannot express "the most recent successful one", which is the
  row the scheduler needs, and an installation that backs up hourly for a week
  would keep less history than one that backs up monthly for a year.
- **Retaining `OUTCOME_UNKNOWN` rows for a longer age instead of indefinitely.**
  Rejected: an age implies the evidence stops mattering, and it does not. What ends
  the retention is RESOLUTION, and the reconciliation that would provide it does
  not exist yet — which is itself worth stating rather than approximating with a
  number.
