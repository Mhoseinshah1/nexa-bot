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

All of it is environment configuration in `/etc/nexa/nexa.env`, not tenant
settings: a dump is of the whole database, and the restore CLI has to work when
the database is what is broken.

| Variable                     | Default                 | Notes                                                            |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `BACKUP_SCHEDULE_ENABLED`    | `false`                 | Off until you turn it on.                                        |
| `BACKUP_INTERVAL_MS`         | 24 h                    | Measured from the last **verified** run, not from process start. |
| `BACKUP_TICK_MS`             | 5 min                   | How often the worker asks whether one is due.                    |
| `BACKUP_WORK_DIR`            | `/var/lib/nexa/backups` | On the data volume. Never `/tmp`.                                |
| `BACKUP_TELEGRAM_CHAT_ID`    | empty                   | Set with the token, or not at all.                               |
| `BACKUP_TELEGRAM_BOT_TOKEN`  | empty                   | Its own bot, not the customer-facing one.                        |
| `BACKUP_DUMP_TIMEOUT_MS`     | 2 h                     | A dump that never ends holds the lock until its lease expires.   |
| `BACKUP_RESTORE_TIMEOUT_MS`  | 2 h                     |                                                                  |
| `BACKUP_DELIVERY_TIMEOUT_MS` | 10 min                  |                                                                  |
| `BACKUP_PG_BIN_DIR`          | empty                   | Where `pg_dump`/`pg_restore`/`psql` live, if not on `PATH`.      |

The chat id and the bot token are refused unless BOTH are set or NEITHER is.
Neither set is a real configuration: the archive is verified and kept on the
server, which is a backup. One alone is an installation whose operator believes
their backups are leaving the host when they are not.

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

**No enforcement of who can read the channel.** Give the backup bot its own
dedicated channel, review its membership, and write down who is in it. Nothing
in this codebase can check that, and anyone in that channel holding the KEK has
your whole database.

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
