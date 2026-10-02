# Backup and restore

The design and its reasoning are ADR-0025. This is the operational half: what to
configure, what the commands do, and what this system does **not** do for you.

## What a backup is here

Six stages, in order, and the order is the guarantee:

```
DUMP  →  CHECKSUM  →  ENCRYPT  →  VERIFY_RESTORE  →  DELIVER  →  CLEANUP
```

`DELIVER` is reachable only from a `VERIFY_RESTORE` that passed. Every backup
this system reports as successful has been decrypted through the real restore
path and restored into a real, empty PostgreSQL database, and the restore
produced tables. A run that fails verification deletes its archive instead of
delivering it.

The dump is the whole database. Nothing is excluded — not by table name, not by
prefix, not because a table looks transient.

## Configuration

Most of it is environment configuration in `/etc/nexa/nexa.env`: a dump is of the
whole database, and the restore CLI has to work when the database is what is broken.
The two things an operator changes in normal operation — whether automatic backups
run, and how often — are also in the Web Admin (see **The automatic schedule** below),
and the environment values are then only their defaults.

| Variable                     | Default                 | Notes                                                                          |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `BACKUP_SCHEDULE_ENABLED`    | `false`                 | The DEFAULT; a value set in the Web Admin wins.                                |
| `BACKUP_INTERVAL_MS`         | 24 h                    | The DEFAULT; measured from the last **verified** run, not from process start.  |
| `BACKUP_TICK_MS`             | 5 min                   | How often the worker asks whether one is due. Not a readiness knob.            |
| `BACKUP_WORK_DIR`            | `/var/lib/nexa/backups` | On the data volume. Never `/tmp`.                                              |
| `BACKUP_TELEGRAM_CHAT_ID`    | empty                   | The FALLBACK destination, used only with no operations group connected.        |
| `BACKUP_TELEGRAM_BOT_TOKEN`  | empty                   | Set with the chat id, or not at all. Its own bot, not the customer-facing one. |
| `BACKUP_DUMP_TIMEOUT_MS`     | 2 h                     | A dump that never ends holds the lock until its lease expires.                 |
| `BACKUP_RESTORE_TIMEOUT_MS`  | 2 h                     |                                                                                |
| `BACKUP_DELIVERY_TIMEOUT_MS` | 10 min                  |                                                                                |
| `BACKUP_PG_BIN_DIR`          | empty                   | Where `pg_dump`/`pg_restore`/`psql` live, if not on `PATH`.                    |

The chat id and the bot token are refused unless BOTH are set or NEITHER is.
Neither set is a real configuration: the archive is verified and kept on the
server, which is a backup. One alone is an installation whose operator believes
their backups are leaving the host when they are not.

## Where the archive goes

Decided per run, at `DELIVER`, in this order (`RoutedBackupDelivery`):

1. **The operations log group's «💾 بکاپ‌ها» topic**, when a group is connected
   («گروه گزارش‌های مدیریتی» in the Web Admin). This is the canonical destination:
   scheduled runs, «تهیه بکاپ جدید» and the recovery's pre-restore backup all post
   there. Nexa creates the topic itself, through the same conditional claim as every
   other topic it owns, so two worker replicas delivering at once create it once. A
   topic an operator deleted is recreated — once per stale thread — and the archive is
   sent once more, which is safe only because Telegram's "thread not found" is a
   definitive refusal: nothing was posted.
2. **The dedicated chat** (`BACKUP_TELEGRAM_CHAT_ID` + `BACKUP_TELEGRAM_BOT_TOKEN`),
   only when no group is connected, or when a connected group's topic could not be
   made ready before anything was sent. It is the explicit fallback, kept so an
   installation configured that way keeps working unchanged.
3. **Nowhere**: the run is `NOT_ATTEMPTED` with nothing configured, or
   `FAILED_DEFINITIVE` naming why when a group is connected and unusable with no
   fallback. The archive is verified and on disk either way.

**Why the group's own bot, and not `BACKUP_TELEGRAM_BOT_TOKEN`.** Only a member of a
chat can post in it, and the group's bot is the one Nexa has verified is an
administrator there with the topic right. A second token is therefore not needed for
the group; the environment token is read only for the fallback chat. ADR-0011's
control that the backup chat is DEDICATED now applies to the operations group: its
membership is who can read the encrypted archives, so review it as such (an archive is
useless without the KEK, which never reaches Telegram).

A fallback is taken only when nothing was sent to the group. Once a send to the group
has been attempted its answer is the run's answer: an `OUTCOME_UNKNOWN` is never
followed by a copy anywhere else, and nothing resends automatically.

**Delivery never fails the backup.** A destination that cannot be resolved, a group
that is unusable, a channel that throws — each is recorded on the run's delivery
columns, and the run stays `SUCCEEDED` with its verified archive retained on the
server.

**Above Telegram's 50 MiB bot ceiling** the topic receives a notice instead — Persian
first, naming the backup, its checksum and where on the server it is retained — and
the run's delivery detail says the archive was retained. Nothing pretends a document
was delivered.

## The automatic schedule

«بکاپ و بازیابی» → «زمان‌بندی بکاپ خودکار» in the Web Admin: a switch, and an interval
chosen from presets (1, 3, 6, 12, 24 hours) or typed as a number with a unit (minutes,
hours, days). Bounds: 15 minutes to 30 days, the same as `BACKUP_INTERVAL_MS`. Saving
needs `settings.edit`; it is the ordinary settings write — versioned, idempotent and
audited — of two registry keys read on the installation tenant,
`backup.schedule_enabled` and `backup.interval_minutes`.

Each is NULL until somebody sets it, and NULL means the environment value. So:

- an installation configured through `nexa.env` keeps exactly its schedule, with no edit;
- a value set in the Web Admin wins over the environment, half by half;
- «بازگشت به پیش‌فرض نصب» writes NULL back.

The worker reads the schedule on **every tick**, so a change applies within one tick
and needs no restart. That is also why the scheduler is always started now: with the
schedule off, a tick decides nothing is due. `botctl status` reads the configuration,
not the database, so it reports the environment default only, and says so.

## Scheduler health

The worker's health check includes the backup scheduler. Before this release the
scheduler reported "stalled" from start until its first tick, which arrived one whole
`BACKUP_TICK_MS` (five minutes) later — longer than the container health check waits —
so a fresh deploy with backups on was reported unhealthy, and `BACKUP_TICK_MS=30000`
was used in production to hide it. Now:

- `start()` runs the first check immediately (safe: one tick at a time in a process,
  one backup at a time in the installation by the partial unique index);
- the scheduler is healthy from `start()` for three tick intervals before any tick
  has completed, after which health is purely progress-based (`LoopProgress`, the
  same rule every other worker loop uses);
- a backup this process is running counts as progress for as long as a run can
  legitimately take (the dump, restore and delivery ceilings plus the lease), so a
  two-hour dump does not make the worker unhealthy at minute sixteen.

**`BACKUP_TICK_MS=30000` is no longer needed.** It is harmless if left set; remove it
at your convenience.

**The client tools must be version-compatible with the server.** `pg_restore`
cannot read a dump from a newer `pg_dump`. The manifest records both versions
so a restore years from now can tell which way round it is.

## Commands

```bash
pnpm backup run                                  # take one now, trigger MANUAL
pnpm backup list [--limit N]                     # recent runs and their delivery state
pnpm backup verify --archive PATH                # decrypt and checksum; touches no database
pnpm backup restore --archive PATH --target DB   # restore into an explicit, empty database
```

In a deployed installation these run inside the api container; `backup:dev` is
the `tsx` variant for a development checkout.

`run` exits `0` on success, `1` on a failed run, `2` when another backup already
holds the lock, and `3` when the backup succeeded but cleanup did not — which
means plaintext dump bytes or a scratch database are still on the host.

`verify` deliberately builds no container and opens no database connection. It
is the command for the situation everyone verifies an archive in: the database
is gone.

`restore` has **no default target**. `--target` is required, the live database is
refused even when named explicitly, and a target that already holds tables is
refused — `pg_restore` into a populated database produces a half-merged result
that looks like it nearly worked.

```bash
createdb nexa_restore_test
pnpm backup restore --archive /var/lib/nexa/backups/<id>/archive.nxb \
                    --target nexa_restore_test
```

## Concurrency

One backup runs at a time, per installation, enforced by a partial unique index
in PostgreSQL rather than by any process. Two worker replicas is normal during a
rolling update; the second is told BUSY by the database.

A run that dies takes its lock with it until the lease expires (15 minutes
without a heartbeat), after which the next run closes the abandoned one as
`FAILED` and proceeds. The abandoned run's files are left in place and named on
its row — a process that has stopped reporting may still be writing them.

## Encryption

AES-256-GCM, with a fresh random data key per archive wrapped under a key from
the installation's keyring — the same keyring the rest of the secrets use. One
key encrypts, every held key decrypts, so a rotation is an overlap: an archive
taken before a rotation still opens afterwards, provided the retired key stays
in `SECRETS_KEYS`.

**Do not retire a key while an archive you might need still names it.** The
archive header records which key it needs and the error names it, but a key you
have deleted is not recoverable from that message.

Nothing about the key reaches the Telegram caption, the manifest, the run row,
the log, or an error message.

## What this does NOT do

Stated because ADR-0011 required these and V1 does not have them.

**No off-server copy.** The archive lives on the same server as the database it
protects, plus whatever Telegram holds. A host that is lost loses both. Getting
the artifact somewhere else is manual, today.

**No retention, anywhere.** Nothing deletes an old archive from
`BACKUP_WORK_DIR`, and nothing deletes an old document from the Telegram
channel. The directory grows until you prune it. This is the most operationally
significant gap in V1.

**No automatic resend of an ambiguous delivery.** A delivery whose outcome was
never observed is recorded as `OUTCOME_UNKNOWN` and left alone. Check for them
with `pnpm backup list`; the archive is on disk either way.

**No enforcement of who can read the channel.** The archives go to the operations
log group's backups topic (or the fallback chat): review that group's membership and
write down who is in it. Nothing in this codebase can check that, and anyone in that
group holding the KEK has your whole database.

## Restore drill

Do this before you need it, and after any change to the keyring:

```bash
pnpm backup run                       # take one; note the id
pnpm backup verify --archive /var/lib/nexa/backups/<id>/archive.nxb
createdb nexa_drill
pnpm backup restore --archive /var/lib/nexa/backups/<id>/archive.nxb --target nexa_drill
psql nexa_drill -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
dropdb nexa_drill
```

Every run already verifies by restoring, so this drill is testing the part the
pipeline cannot test for you: that YOU can do it, with the keys you actually
hold, on the day it matters.

## Restoring from the Web Admin

The CLI above is one way in. The other is **بکاپ و بازیابی** under **سامانه و
عملیات** in the Web Admin, which exists because the CLI requires a shell on a
host — and the day you need a restore most is the day you may not have one.

Four permissions, and they are four on purpose:

| Permission         | Severity | What it buys                                                   |
| ------------------ | -------- | -------------------------------------------------------------- |
| `backup.view`      | LOW      | the status, the history, a run's detail, the recovery requests |
| `backup.run`       | HIGH     | «تهیه بکاپ جدید» — the same pipeline, `trigger: MANUAL`        |
| `backup.download`  | CRITICAL | the ENCRYPTED archive. Never a plaintext dump                  |
| `recovery.restore` | CRITICAL | the confirmation that begins a destructive restore             |

Which seeded roles hold them: `owner` all four; `operator` and `observer`
`backup.view`; `technical` `backup.view` and `backup.run`. Download and restore
reach the owner alone.

**Upgrading an installation that predates this release.** Seeded roles are
written when a role is CREATED and never reasserted — deliberately, so that a
restart cannot restore a permission an operator withdrew — so these four
permissions do not reach a role that already exists. Migration
`0031_backup_recovery_role_backfill.sql` inserts exactly the eight
(role, permission) pairs above into existing SYSTEM roles, in every tenant,
conflict-free, and touches nothing else: no custom role, no role assignment, no
permission override, no other permission. It runs as part of the ordinary
`botctl update`, and a DENY override still beats what it grants. Without it the
Recovery section renders and every card in it answers access denied — which is
what a deployed installation did, and the defect that migration exists for.

### What a restore actually does

Nothing restores into the database serving the request. The sequence is, in
order, and every step is durable state on a `recovery_requests` row so the
operation survives a closed browser, a refreshed page, an API restart and the
executor's own restart:

1. **Upload.** A raw `application/octet-stream` body, streamed to a 0700
   directory with a random name, counted against `RECOVERY_UPLOAD_MAX_BYTES` as
   it is written. The declared filename is a label; it never becomes a path.
2. **Verify.** The container is parsed, the header validated, the key resolved
   from the server's own keyring, the payload authenticated-decrypted, the
   SHA-256 compared against the manifest, and the payload checked to BE a
   `pg_dump` custom archive. The browser never sees a key.
3. **Restore-test.** A real `pg_restore` into a real, randomly named, freshly
   created EMPTY database, which is then inspected for tables and a readable
   migration state and dropped. The plaintext dump is removed.
4. **Confirm.** `recovery.restore`, plus the phrase `RESTORE NEXA` typed exactly,
   bound to the artifact's SHA-256 and valid for ten minutes. A confirmation for
   one archive cannot restore another, and it cannot be replayed.
5. **Pre-restore backup.** A full backup with `trigger: PRE_RESTORE`, through the
   unmodified pipeline — dump, encrypt, and verify BY RESTORING. If it does not
   reach a verified success the recovery aborts here, before anything
   destructive. There is no break-glass path past this.
6. **Quiesce.** Durable writes across the installation are refused while the
   candidate is built, so the restored database cannot be stale on arrival.
   Reads keep working: an operator supervising a restore is reading.
7. **Restore the candidate, validate, cut over.** The archive is restored into a
   NEW database, validated (tables present, migration state readable and
   compatible, migrated forward if it is merely behind), and only then does
   production change — by two `ALTER DATABASE ... RENAME TO` statements.
8. **Readiness.** The same readiness computation the load balancer gets. A
   recovery is not successful because `pg_restore` exited zero.

### The displaced database, and why nothing drops it

The cutover renames the outgoing database to `nexa_pre_restore_<id>` and renames
the candidate into its place. **Nothing ever drops the displaced database.** It
is the rollback: two more renames put it back, with no restore and no archive
involved, and it is the only copy of the state the restore replaced.

That means disk does not come back by itself. After a recovery you have the
displaced database, the candidate (now live), and the pre-restore backup's
archive, and removing the first is a deliberate act taken once you are satisfied:

```bash
psql -c "SELECT datname FROM pg_database WHERE datname LIKE 'nexa_pre_restore_%'"
dropdb nexa_pre_restore_<id>        # only when you are sure
```

### Foreign archives are not supported

An archive from ANOTHER installation cannot be restored here, and the Web Admin
says so — «پشتیبانی نمی‌شود» — rather than omitting the option. Its data key is
wrapped under that installation's KEK, which this one does not hold, and the two
ways to change that are a form that accepts a pasted key (refused: see ADR-0028)
and a key-import feature that does not exist. Move the KEK into `SECRETS_KEYS`
deliberately, out of band, and the archive becomes an ordinary one.

### What the Web path does NOT do

**It does not restart anything.** The cutover needs no configuration change —
the connection string resolves to the renamed database — but the worker, the
monitor and the recovery executor are separate processes holding their own
pools, and their own pool error listeners are what let them survive it. A
`botctl` restart afterwards is still the tidier operational choice.

**It does not delete a displaced database, a candidate left by a refusal, or an
uploaded archive's workspace after success.** Debris is reported on the row and
in the operational log rather than cleaned up silently; a recovery that removed
its own evidence would be a recovery nobody could audit.

## Relationship to `botctl backup`

`deploy/bin/botctl backup` is the deployment tool's own dump — a `pg_dump` taken
before an update so `botctl rollback` has something behind it. It is
unencrypted, undelivered, unverified, and local, and that is appropriate for
what it is: an update's safety net, taken and used minutes apart by the same
operator on the same host.

It is not a disaster-recovery backup and this pipeline does not replace it.
`botctl rollback` still never restores the database — the backup predates the
migration, so restoring it would discard every write made since.
