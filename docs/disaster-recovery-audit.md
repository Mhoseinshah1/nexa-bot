# Web Admin Disaster Recovery — the audit that came first

This document was written **before any code changed on this branch**, and it is
the first commit on it. Its purpose is the one the Architecture Hardening audit
served: to classify what already exists, so the phase cannot quietly
reimplement a primitive it should have reused, and cannot quietly build around
a primitive that is missing without saying so.

The instruction was explicit: _audit existing Backup V1 first; reuse the
streaming encrypted archive, keyring, manifest format, checksum semantics,
pg_dump/pg_restore tooling, real restore verification, backup run persistence,
backup lock, Telegram delivery semantics, retention, operational conditions and
the transaction boundary guard; do not duplicate these mechanisms; document any
missing primitive before implementing around it._

Every file named below was read in full at `8789b7c` — the merge of PR #17 —
which is this branch's base.

---

## Part 1 — what exists and is reused verbatim

| Primitive                                                      | Where                                                                                                              | How this phase uses it                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming encrypted archive**                                | `backup/infrastructure/archive.ts` — `sealArchive`, `openArchive`, `readArchiveHeader`, `checksumFile`             | Unchanged. The upload verification decrypts through **`openArchive`**, which is the same function the operator's `backup restore` uses and the same one the pipeline's own `VERIFY_RESTORE` uses. There is still exactly one decrypt path.                                                                                                                                               |
| **Keyring**                                                    | `infrastructure/crypto/keyring.ts`, `resolve-keyring.ts`, bound by `KeyringBackupArchiver`                         | Unchanged. The browser never receives a key; the server resolves its own keyring. An archive naming a `keyId` this installation does not hold fails at `keyFor` with `SECRET_KEY_UNKNOWN` — which is how foreign-installation archives are refused (Part 4).                                                                                                                             |
| **Manifest format and its schema**                             | `packages/contracts/src/backup.ts` — `backupManifestSchema`                                                        | Unchanged. Validated by the same `safeParse`. `exclusions` being empty is still asserted.                                                                                                                                                                                                                                                                                                |
| **Checksum semantics**                                         | `BACKUP_CHECKSUM_ALGORITHM`, documented as SHA-256 over the **plaintext** dump                                     | Unchanged, and it is the artifact identity the restore confirmation binds to (Part 3, decision D-6).                                                                                                                                                                                                                                                                                     |
| **`pg_dump` / `pg_restore` / `psql` invocation**               | `backup/infrastructure/pg-tools.ts` — `run()`, `env()`, `parseConnection`, `quoteIdent`                            | Extended, never copied. `run()` already takes an argv array, sets `PGPASSWORD` only in the child environment, never puts a credential on a command line, bounds captured output and enforces a timeout with a SIGKILL backstop — and it already calls `assertOutsideTransaction`. Every new subprocess this phase spawns goes through that same `run()`.                                 |
| **Real restore verification**                                  | `PostgresDatabaseTools.verifyRestore`                                                                              | Reused for the _pipeline's_ own verification, unchanged. The uploaded-artifact restore-test needs a **longer-lived** candidate and **more checks**, so it is built from the same pieces rather than from a second `run()` — see MISSING-4.                                                                                                                                               |
| **Live-target refusal**                                        | `assertNotLiveTarget(target, liveDatabase)`                                                                        | Reused at every new place a database name is chosen, including the cutover.                                                                                                                                                                                                                                                                                                              |
| **Empty-target refusal**                                       | inside `restoreInto`                                                                                               | Reused, and factored so the executor can check emptiness without also performing a restore (MISSING-4).                                                                                                                                                                                                                                                                                  |
| **Backup run persistence**                                     | `backup_runs`, `DrizzleBackupRunRepository`                                                                        | Reused. The Web history reads this table. No second run table.                                                                                                                                                                                                                                                                                                                           |
| **Backup lock**                                                | `backup_runs_single_active_idx`, a partial unique index over a constant where `state = 'RUNNING'`                  | Reused, unchanged. The Web "run backup now" button takes the same lock and reports the same truthful `BUSY`.                                                                                                                                                                                                                                                                             |
| **Lease + stale reclaim**                                      | `leaseOwner`, `leaseHeartbeatAt`, `reclaimStale`                                                                   | Reused as the **pattern** for the recovery lease. A stale recovery is FAILED, never adopted — same reasoning: its candidate database and its workspace belong to a process that may still be writing them.                                                                                                                                                                               |
| **Telegram delivery semantics**                                | `BACKUP_DELIVERY_STATES`, `DeliveryAttempt`, `TelegramBackupDelivery`                                              | Read-only here. The Web history renders `SUCCEEDED` / `FAILED_DEFINITIVE` / `OUTCOME_UNKNOWN` / `NOT_ATTEMPTED` as four distinct facts. Nothing on this branch resends anything.                                                                                                                                                                                                         |
| **Retention**                                                  | `purgeFinishedBefore`, `RetentionSweeper`, ADR-0027                                                                | Extended with the same shape for `recovery_requests`: exclusions in the QUERY, not in the caller.                                                                                                                                                                                                                                                                                        |
| **Operational conditions**                                     | `opsLog.record`, `BACKUP_CONDITION_KEY`, `MANAGEMENT_CONDITION_FAILURE_CODES` / `..._RECOVERY_CODES`               | Reused. New codes are added to the same frozen lists, in the contracts commit, with their recovery pairings — the lists are asserted disjoint and totally paired by `tests/unit/web-money-and-scope.test.ts`.                                                                                                                                                                            |
| **Transaction boundary guard**                                 | `infrastructure/transaction-boundary.ts`, `assertOutsideTransaction`, `withinTransaction`                          | Reused. Every `pg_dump`, `pg_restore`, `psql`, file write and HTTP call this phase adds is outside a transaction, and the guard is what proves it rather than a comment.                                                                                                                                                                                                                 |
| **Migration identity and verdict**                             | `infrastructure/persistence/migration-state.ts` — `expectedMigrations`, `compareMigrations`, `MigrationVerdict`    | **This is the migration-compatibility primitive the instruction asks for, and it already exists.** `current` / `ahead` / `none` / `behind` / `diverged`, compared by journal `when` and file sha256 rather than by count. Reused against a _restored candidate_ instead of against the live database.                                                                                    |
| **Readiness policy**                                           | `ReadinessService`, `SchemaReadiness`, `blocksReadiness`                                                           | Reused. Post-cutover readiness is the **same** computation the load balancer gets, not a second one. Two readiness computations would eventually disagree, and the disagreement would be an outage nobody could explain.                                                                                                                                                                 |
| **Pool error listener**                                        | `infrastructure/persistence/database.ts` — `pool.on('error')` plus the per-client listener                         | Load-bearing here in a way it was not before. The cutover terminates every backend on the live database; without the listener added by Architecture Hardening finding 2, **`pg` delivers that as an unlistened `'error'` event and every process dies.** With it they survive and reconnect — which is what makes an in-place cutover possible at all. This is recorded as decision D-3. |
| **Authorization**                                              | `PermissionGuard`, `runAuthorizedMutation`, `recordMutationDenial`                                                 | Reused unchanged. Every new write path takes `ScopeContext` + `ActorContext` and checks a permission through the guard.                                                                                                                                                                                                                                                                  |
| **Append-only guards / CHECK constraints from contract enums** | `enumCheck`, `0001_append_only_guards.sql`                                                                         | Reused. Every new status column gets a CHECK built from the contract enum.                                                                                                                                                                                                                                                                                                               |
| **State machine as data**                                      | `packages/contracts/src/state-machine.ts` — `validateStateMachine`, `canTransition`, `nextState`, `STATE_MACHINES` | Declared in Phase 0 and **never used**: `STATE_MACHINES` is an empty array whose comment says "the business machines arrive with their modules". The recovery machine is the first one. Declaring it here means "no arbitrary state jumps" is a validated property of a declared graph rather than a switch statement nobody checks.                                                     |

### Two Backup V1 facts that shape everything below

**A backup is installation-wide, not tenant-scoped.** `backup_runs` has no
`tenant_id`, and that is correct: `pg_dump` dumps the whole database, every
tenant in it. One install serves one customer (ADR-0001). So "tenant isolation"
for this feature cannot mean "each tenant sees its own backups" — there is one
set. It means what Part 3 decision D-1 says it means.

**`BACKUP_TRIGGERS` is `['MANUAL', 'SCHEDULED']`, and the trigger is recorded
and never branched on.** That rule is load-bearing and this phase keeps it: the
emergency pre-restore backup is a third trigger VALUE, not a third code path
(decision D-5).

---

## Part 2 — MISSING primitives, named before they are built around

Each of these is something the instruction's workflow needs and Backup V1 does
not have. Naming them here is the point of the audit: the alternative is
discovering one half-built later and reaching for a shortcut.

**MISSING-1 — a paginated backup history.** `BackupRunRepository` has
`latest(limit)` and `byId(id)`. `latest` is a `LIMIT` with no cursor, so a Web
list cannot page, and `byId` takes an id from anywhere. Needed: keyset
pagination on the same `(started_at DESC, id DESC)` order the existing index
already supports, with the cursor validated the way the panels and ops-log
cursors are (`storableInstantOrNull` plus a UUID test — three cursors were
almost-right in three different ways before that rule was centralised).

**MISSING-2 — any durable recovery entity.** Nothing in the codebase records
that a restore was requested, confirmed, attempted or finished. The instruction
is explicit that this must not live on `backup_runs`, and it must not: a backup
run is an artifact's history, a recovery request is an operation against the
installation, and the backup lock is a partial unique index over `state =
'RUNNING'` that a recovery row would contend with for no reason.

**MISSING-3 — an uploaded-artifact workspace.** `FilesystemBackupWorkspaces`
names its directory by `backupId` and is created by the pipeline for its own
run. An upload arrives before anything knows what it is, so its directory
cannot be named after its contents; it needs a random name, mode 0700, files
mode 0600, a dedicated root, and cleanup on every exit path including the
failure paths.

**MISSING-4 — a restore-test that keeps its candidate and inspects it
properly.** `verifyRestore` creates a scratch database, restores, counts tables
in `public`, and **drops it** — correct for the pipeline, wrong twice over here.
The restore-test for an uploaded artifact must additionally read the candidate's
`__drizzle_migrations` so `compareMigrations` can speak, and the _real_ restore
must keep the candidate alive because the candidate is what gets cut over to.
So `DatabaseTools` needs `createDatabase`, `dropDatabase`, `restoreIntoEmpty`
and `inspectDatabase` as separable operations — with `verifyRestore` rebuilt on
top of them rather than left as a parallel implementation.

**MISSING-5 — installation-wide quiesce.** `ScopeActivityReader.scopeIsActive`
reads one tenant's status and is consulted inside every write path's
transaction. It is per-tenant and says nothing about the installation, and it
cannot be made to: a recovery is not a tenant being stopped. Nothing today can
prevent new durable writes installation-wide, and nothing can quiesce the
worker loops — `OutboxRelay.processBatch` opens its transaction on the database
handle directly and never consults any activity reader.

**MISSING-6 — a recovery executor.** There is no process role, and no durable
single-owner execution model for anything except a backup. `ProcessRole` is
`'api' | 'worker' | 'monitor'`.

**MISSING-7 — a request-scoped streaming upload.** Fastify is configured with
`bodyLimit: 1_048_576` and there is no multipart plugin and no raw-body parser.
Nothing in the codebase accepts a file.

**MISSING-8 — a binary download response.** Every existing endpoint returns
JSON. Nothing streams a file out, and nothing maps a caller-supplied id to a
path.

**MISSING-9 — a `PRE_RESTORE` backup trigger.** See decision D-5.

**MISSING-10 — recovery permissions.** `PERMISSIONS` has `maintenance.run`
(CRITICAL) and nothing about backups. The instruction asks for four distinct
keys at four distinct risk levels.

---

## Part 3 — the decisions this phase takes, and why

These are written down because each one had a plausible alternative that is
wrong in a way a reader would not see from the code.

**D-1 — Scope is the installation's PRIMARY tenant, and a non-primary tenant
gets `NOT_FOUND`.** A backup contains every tenant's rows, so the question
"which tenant may see it" has one defensible answer: the tenant that _is_ the
installation. `recovery_requests` therefore carries `tenant_id NOT NULL` (the
tenancy non-negotiable, and it makes the isolation test a row-level one), and
every backup and recovery lookup refuses a scope that is not the primary
tenant — **by returning not-found, not permission-denied**, because a
permission-denied for an id that exists in another scope is itself a disclosure.
A guessed id reveals nothing and mutates nothing, and there is a test that
guesses.

**D-2 — Cutover is a database RENAME, not a connection-string change.** The
alternative — rewrite `DATABASE_URL` and restart — requires writing to the
host's environment file, which belongs to `botctl` and the installer, not to a
process serving HTTP. A rename needs no configuration change at all:

```
REVOKE CONNECT ON DATABASE <live> FROM PUBLIC, <role>   -- no new sessions
pg_terminate_backend(...) for every other session on <live>
ALTER DATABASE <live>     RENAME TO <live>_pre_restore_<recoveryId>
ALTER DATABASE <candidate> RENAME TO <live>
GRANT CONNECT ON DATABASE <live> TO PUBLIC, <role>      -- restored exactly
```

The two renames are the only irreversible moment in the whole operation, they
are metadata-only, and **the outgoing database survives under a new name** — so
rollback is two more renames rather than a restore. `assertNotLiveTarget` guards
every name chosen along the way except the deliberate final one.

**D-3 — the cutover is survivable only because of the pool error listener.**
Terminating every backend on the live database is exactly the event Architecture
Hardening finding 2 was about: `pg` delivers a connection death as an `'error'`
event, `EventEmitter` throws for an unlistened `'error'`, and before that fix
the API, worker and monitor died past their shutdown hooks. With both listeners
in place they survive, `pg` opens fresh connections, and those connections
resolve the same database name — which is now the restored one. This is stated
here because it means **a revert of that listener turns this feature from a
cutover into an outage**, and that relationship is invisible from either file.

**D-4 — durable progress survives the cutover by being written in two places,
deliberately.** The recovery request lives in the live database, which is what
makes it survive a browser close, a refresh, an API restart and an executor
restart — the four things the instruction names. But the live database is
renamed away at cutover, and the restored candidate's own `recovery_requests`
table contains the _backup's_ rows, not this recovery's. So:

- before the rename the executor writes a **cutover journal** file under the
  recovery root (mode 0600, no secrets — ids, names, timestamps and a stage),
  which is what makes the rename itself crash-recoverable;
- after the rename the executor **re-asserts its own row** into the now-live
  restored database, so the recovery that produced this database is recorded
  _in_ it.

Neither half is sufficient alone, and saying so is better than a design that
silently loses its own audit trail at the one moment it matters.

**D-5 — the emergency pre-restore backup is a new TRIGGER value, not a new code
path.** `BACKUP_TRIGGERS` gains `PRE_RESTORE` (a contract change, with a
migration widening `backup_runs_trigger_check`). It goes through
`BackupService.run` unchanged, takes the same lock, runs the same six stages and
the same mandatory verification. The rule that `trigger` is recorded and never
branched on is preserved, and the alternative — calling it `MANUAL` — would put
a false statement in the one table an operator reads after a disaster. A
`PRE_RESTORE` backup that does not reach `SUCCEEDED` with a non-null
`verified_at` **aborts the recovery**; no silent break-glass.

**D-6 — the confirmation binds to the artifact's CHECKSUM, not to its
filename or its row id.** The typed phrase is constant, so storing the phrase
proves nothing; what must be bound is the tuple the instruction names, and the
artifact's identity inside that tuple has to be the thing that cannot be
swapped. The SHA-256 of the plaintext dump is exactly that, it is already in the
manifest and on the run row, and it is not a secret. A confirmation for backup A
cannot restore backup B because the checksum recorded at confirmation is
re-compared at execution.

**D-7 — `AHEAD` is a permitted cutover verdict, and that is not a loosening.**
`ReadinessService.checkSchema` already rules that a database carrying
migrations newer than this release is READY — it is the shape a rollback leaves,
because a release's migrations only add (ADR-0022). A cutover that refused
`AHEAD` would be refusing a database the very next readiness check would call
ready: two predicates for one question, which is the precise defect class this
repository already has a named regression for (the retention exclusion that
disagreed with `lastSucceededAt`). So the cutover asks `compareMigrations` and
then applies the SAME policy readiness applies. `behind` is migrated forward
with the release's own migrator **against the candidate** and must then compare
`current`; `none` and `diverged` are refused. Production is untouched in every
refusal.

**D-8 — quiesce is enforced where it cannot be forgotten, with named
exceptions.** The source of truth is the recovery row's own state: there is no
second maintenance flag, because a second flag is a thing that can disagree with
the first. Enforcement is at the two chokepoints every durable write actually
passes through — `DrizzleUnitOfWork.run`, and `OutboxRelay.processBatch`, which
does not use the unit of work — rather than at ten call sites, any one of which
a later commit could forget. The recovery lane's own writes are permitted by an
explicit scope, not by an option a caller might pass by accident, and the
exceptions are listed in the implementation with their reasons.

**D-9 — readiness stays READY during a quiesce.** The instruction says reads and
status may remain. It also matters that they do: `/health/ready` is what the
container healthcheck polls and what `botctl update` reads, so reporting NOT
READY during a planned recovery would invite an orchestrator to restart or roll
back the installation in the middle of it. The quiesce is reported as its own
field on the authenticated status, and the Web Admin shows it as a banner.

**D-10 — foreign-installation archives are refused, in words, and recorded.**
Supporting them means one of: a web form that accepts a KEK (explicitly
forbidden, and correctly), or an out-of-band key import that is its own feature
with its own storage, rotation and audit. V1 supports same-installation
archives through the server-side keyring. An archive whose `keyId` the
installation does not hold is refused with «پشتیبانی نمی‌شود» and the limitation
is recorded in `docs/open-questions.md` rather than worked around.

---

## Part 4 — what this phase does NOT do, stated now

- No Phase 4 commerce. No products, orders, wallet, payments, provisioning,
  service management or reseller functionality. The nine planned Web Admin
  surfaces stay planned.
- No automatic resend of an `OUTCOME_UNKNOWN` delivery.
- No off-server backup copy and no pruning of `BACKUP_WORK_DIR` — ADR-0011
  controls 4 and 5 are still not in V1, and this branch does not change that.
  The download button therefore shows «فایل محلی دیگر موجود نیست» when the
  local artifact is gone rather than retaining every archive for ever to keep a
  button lit.
- No foreign-installation recovery (D-10).
- No container orchestration. The executor cannot stop its sibling processes,
  and it does not pretend to: the cutover works _because_ the siblings survive
  a connection reset, not because anything stopped them.
