# ADR-0028 — Restoring this installation from the Web Admin

**Status:** Accepted. Written for the Web Admin Disaster Recovery phase, on the
branch that implements it. Extends ADR-0025 (the backup pipeline) and ADR-0011
(backup delivery and its compensating controls); supersedes nothing.

## The problem

ADR-0025 gave this installation an artifact it can trust: every archive it calls
successful has been decrypted through the operator's own restore path and
restored into a real, empty PostgreSQL database that then had tables in it.

What it did not give anybody is a way to _use_ one. The only restore path is
`backup restore --archive PATH --target DB` on the host, which requires shell
access, a target database somebody created by hand, and the operator remembering
that `botctl rollback` never touches the database. Every one of those is a thing
that has to be true at the worst moment somebody will ever have on this system.

And the failure this phase must avoid is not "the restore did not work". It is
**"the restore half worked"** — a production database that is neither the old one
nor the new one, which is the state the legacy system's `pg_restore`-into-a-live
database would have produced and which no backup can get you out of, because the
thing you would restore is the thing that is now damaged.

## Decision

### 1. The production database changes only after a restored candidate has been fully validated

The whole design follows from this sentence. A restore does not write into the
database serving the request; it builds a NEW database beside it, proves the new
one, and then swaps which name points at which.

```
upload → verify → restore-test → confirm → PRE-RESTORE BACKUP → quiesce
       → create candidate → restore into it → validate → CUT OVER → readiness
```

At every arrow before `CUT OVER`, a failure leaves production exactly as it was.
That is not a hope about error handling — it is a property of never having
written to production at all.

### 2. Cutover is a database RENAME

```sql
REVOKE CONNECT ON DATABASE <live> FROM PUBLIC, <role>;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = '<live>' AND pid <> pg_backend_pid();
ALTER DATABASE "<live>"      RENAME TO "nexa_pre_restore_<recoveryId>";
ALTER DATABASE "<candidate>" RENAME TO "<live>";
GRANT CONNECT ON DATABASE "<live>" TO PUBLIC, <role>;
```

The alternative was to rewrite `DATABASE_URL` and restart, which requires writing
to the host's environment file — that belongs to `botctl` and the installer, and
a process serving HTTP should not be editing the configuration it was started
with.

Three properties make the rename the right primitive:

- **No configuration changes.** Every process keeps the connection string it
  booted with, and that string resolves to the restored database afterwards.
- **The outgoing database survives**, under a name recorded on the recovery row.
  A rollback is two more renames, not a restore — which matters because the
  thing you would otherwise restore from is a backup taken minutes ago of a
  database you have just decided was wrong.
- **The renames are metadata-only**, so the irreversible moment is milliseconds
  rather than the length of a restore.

### 3. The cutover is survivable only because of the pool error listener

Terminating every backend on the live database is precisely the event
Architecture Hardening finding 2 was about: `pg` delivers a connection death as
an `'error'` event, `EventEmitter` throws for an unlistened `'error'`, and before
that fix the API, the worker and the monitor all died past their shutdown hooks.

With `pool.on('error')` and the per-client listener in place they survive, `pg`
opens fresh connections, and those connections resolve the same database name —
which is now the restored one.

This is stated in an ADR because the dependency is invisible from either file.
**Reverting that listener turns this feature from a cutover into an outage**, and
nothing in `database.ts` mentions recovery, nor should it.

### 4. Durable progress is written in two places, deliberately

The recovery request lives in the live database, which is what makes it survive a
browser close, a refresh, an API restart and an executor restart. But the live
database is renamed away at cutover, and the restored candidate's own
`recovery_requests` table holds the rows that were in the _backup_, not this
recovery's row.

So the executor writes a **cutover journal** file under the recovery root (mode
0600; ids, names, timestamps and a stage — no secrets) before and after the
renames, which is what makes the rename itself crash-recoverable; and after the
rename it **re-asserts its own row** into the now-live restored database, so the
recovery that produced this database is recorded in it.

Neither half is sufficient alone. Saying so is better than a design that silently
loses its own audit trail at the one moment it matters.

### 5. Quiesce is derived from the recovery's state, and enforced where it cannot be forgotten

There is no separate maintenance flag. A second flag is a thing that can disagree
with the first, and the one it would disagree with is the one that decides
whether a database is about to be renamed.

Enforcement is at the chokepoints every durable write passes through, rather than
at each of the ten call sites that consult `ScopeActivityReader` — any one of
which a later commit could forget. The recovery lane writes under a distinguished
system scope, so its exception is a property of the caller rather than an option
somebody could pass by accident.

`PRE_RESTORE_BACKUP` is deliberately outside the quiesce window: that stage takes
a backup of the live installation, which writes to `backup_runs`,
`operational_events` and the outbox. An installation that refused writes during it
could not take the backup that makes the rest of the operation recoverable.

### 6. Readiness stays READY during a quiesce

`/health/ready` is what the container healthcheck polls and what `botctl update`
reads. Reporting NOT READY during a planned recovery would invite an orchestrator
to restart or roll back the installation in the middle of one. The quiesce is
reported as its own field on the authenticated status and rendered as a banner.

### 7. Migration compatibility uses the predicate readiness already uses

`compareMigrations` compares the candidate's `__drizzle_migrations` against this
release's own journal by `when` and file sha256 — the same function, against a
different database.

- `current` → cut over.
- `ahead` → cut over. This is not a loosening: `ReadinessService.checkSchema`
  already rules that a database carrying migrations newer than this release is
  READY, because a release's migrations only add (ADR-0022) and that is the shape
  a rollback leaves. A cutover that refused `ahead` would refuse a database the
  very next readiness check would accept — two predicates for one question, which
  is exactly how the retention exclusion came to disagree with `lastSucceededAt`.
- `behind` → migrate the CANDIDATE forward with the release's own migrator, then
  re-compare and require `current`. Production is untouched throughout, so a
  migration that fails costs a candidate database and nothing else.
- `none`, `diverged` → refuse.

### 8. The confirmation binds to the artifact's checksum

The typed phrase (`RESTORE NEXA`) is a constant, so storing it would prove
nothing. What is durable is the BINDING: the request, the SHA-256 of the
plaintext dump, the acting administrator, their session, and an expiry. The
checksum recorded at confirmation is re-compared at execution, which is what
makes a confirmation for backup A unable to restore backup B. A replay finds the
state already advanced, because the transition is a conditional UPDATE.

### 9. The emergency pre-restore backup is mandatory and is a trigger value

`BACKUP_TRIGGERS` gains `PRE_RESTORE`. It runs through `BackupService.run`
unchanged — same lock, same six stages, same mandatory verification — because the
rule that `trigger` is recorded and never branched on is what keeps the
unattended backup and the watched one the same backup.

It must reach `SUCCEEDED` with a non-null `verified_at`. Anything else aborts the
recovery before anything destructive happens. There is no override, no
force flag and no break-glass: an operator who cannot take a backup of their
current database is an operator who must not replace it.

### 10. Foreign-installation archives are refused

Restoring an archive from another installation means holding another
installation's KEK. The two ways to do that are a web form that accepts a key —
which is forbidden, and rightly, because it puts a KEK in a browser, a request
body, a proxy log and probably a password manager — or an out-of-band key import,
which is its own feature with its own storage, rotation, audit and revocation.

V1 supports same-installation archives through the server-side keyring. An
archive naming a `keyId` this installation does not hold is refused with
«پشتیبانی نمی‌شود», and the limitation is recorded in `docs/open-questions.md`.

## Consequences

**A restore is now reachable by an administrator with a browser**, which is the
point, and it is gated by a CRITICAL permission plus a typed confirmation bound
to the artifact.

**Two databases are left on the server after a successful recovery**: the
restored one, serving; and the displaced one, named on the row. Nothing removes
the displaced database automatically, and that is deliberate — it is the fastest
rollback that exists, and an automatic drop would remove it at the exact moment
somebody was deciding whether they needed it. Removing it is an operator's
decision, made with `psql`, and `docs/backup.md` says so.

**The recovery executor is a fourth process role.** It is not the worker: a
restore must not share an event loop with the outbox relay and the notification
dispatcher, both of which it is about to quiesce.

**This has never been run against a real server.** Like the deployment
checkpoint before it, the evidence here is a real PostgreSQL in the integration
suite — real `pg_dump`, real `pg_restore`, real `CREATE DATABASE`, real renames —
and not a production incident. `docs/vps-acceptance.md` gains the section that
decides that.

## What was considered and rejected

**`pg_restore --clean` into the live database.** This is what the legacy system
would have done, and it is the failure mode this ADR exists to prevent: it drops
and recreates objects one at a time in a live database, so an interruption leaves
production half-restored with no way back.

**A second "maintenance mode" table or setting.** Rejected under decision 5: a
second source of truth for whether the installation is quiesced is a second
source of truth about whether a database is about to be renamed.

**Stopping the sibling containers before the cutover.** The application cannot
orchestrate its own deployment, and a design that pretended to would be a design
that worked in a test and not on a host. The cutover works _because_ the siblings
survive a connection reset — which is a property they were given for an unrelated
reason and which this ADR now depends on (decision 3).

**Dropping the displaced database at the end.** See Consequences.
