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

## Relationship to `botctl backup`

`deploy/bin/botctl backup` is the deployment tool's own dump — a `pg_dump` taken
before an update so `botctl rollback` has something behind it. It is
unencrypted, undelivered, unverified, and local, and that is appropriate for
what it is: an update's safety net, taken and used minutes apart by the same
operator on the same host.

It is not a disaster-recovery backup and this pipeline does not replace it.
`botctl rollback` still never restores the database — the backup predates the
migration, so restoring it would discard every write made since.
