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
   only when no group is connected, when the group's latest check found a PROBLEM (bot
   removed, cannot send, no topic right) or its bot has no token, or when its topic
   could not be made ready — an answer or a thrown error — before anything was sent. It is the explicit fallback, kept so an
   installation configured that way keeps working unchanged.
3. **Nowhere**: the run is `NOT_ATTEMPTED` with nothing configured, or
   `FAILED_DEFINITIVE` naming why when a group is connected and unusable with no
   fallback. The archive is verified and on disk either way.

The status card's «مقصد ارسال فایل بکاپ» is computed by the same decision from the
database, so it names the recipient the next run would actually pick.

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
- a backup this process is running counts as progress for as long as its LEASE
  heartbeat is alive (refreshed every minute; silent for `BACKUP_LEASE_STALE_AFTER_MS`,
  15 minutes, means abandoned) — the same rule another process uses to reclaim it. There
  is no run-length budget, because the checksum, encrypt and decrypt stages stream the
  whole database with no timeout of their own, so a large legitimate run is never
  reported stalled and a run whose heartbeat stops always is.

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

# Another installation's archive (ADR-0032): add --kit; the passphrase comes on stdin.
read -rs P; printf %s "$P" | pnpm backup verify --archive PATH --kit old.nxkit
```

`backup:dev` is the `tsx` variant for a development checkout. In a deployed
installation the same commands run inside the running **api** container, which
has the backup volume, the keyring and the database configuration. Exactly:

```bash
C='sudo docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml'

$C exec -T api node dist/backup.cli.js run;  echo "exit=$?"
$C exec -T api node dist/backup.cli.js list --limit 10
$C exec -T api node dist/backup.cli.js verify --archive /var/lib/nexa/backups/<id>/archive.nxb

# A restore needs an EMPTY target you created first; never the live database.
$C exec -T postgres createdb -U nexa nexa_restore_test
$C exec -T api node dist/backup.cli.js restore \
    --archive /var/lib/nexa/backups/<id>/archive.nxb --target nexa_restore_test

# Another installation's archive, with its Recovery Kit. Copy both IN, pipe the
# passphrase on stdin (never an argument), and remove the copies afterwards.
$C cp old.nxb api:/var/lib/nexa/backups/old.nxb
$C cp old.nxkit api:/var/lib/nexa/backups/old.nxkit
$C exec -T -u root api chown node:node /var/lib/nexa/backups/old.nxb /var/lib/nexa/backups/old.nxkit
read -rs P; printf %s "$P" | $C exec -T api node dist/backup.cli.js verify \
    --archive /var/lib/nexa/backups/old.nxb --kit /var/lib/nexa/backups/old.nxkit; unset P
$C exec -T api rm /var/lib/nexa/backups/old.nxb /var/lib/nexa/backups/old.nxkit
```

`exec` into the RUNNING api container, which already has the backup volume
mounted, the keyring and the database configuration — the same process role
whose Web button runs this pipeline. `nexa` is the installer's
`POSTGRES_USER`/`POSTGRES_DB` (`/etc/nexa/postgres.env`).

`run` exits `0` on success, `1` on a failed run, `2` when another backup already
holds the lock, `3` when the backup succeeded but cleanup did not — which
means plaintext dump bytes or a scratch database are still on the host — and
`4` when a recovery is restoring the installation (QUIESCING through
RESTARTING). The CLI asks the SAME predicate the scheduler and the Web button
ask (`Container.recoveryQuiesced`), before it does anything else, so a refused
`run` writes nothing. A backup taken during a restore would dump a database that
is about to be renamed away; the recovery takes its own pre-restore backup.

`verify` and `restore` decrypt into a private `0700` directory
`BACKUP_WORK_DIR/.cli-<verb>-XXXXXX` and remove it when they finish, success or
not — never `/tmp`, which in the container is outside the backup volume. If the
command is killed before it can clean up, the backup housekeeping removes the
directory once nothing has written it for the plaintext grace window (below).

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

**No off-host copy above Telegram's 50 MiB bot ceiling — an OPEN DECISION.**
Once the archive outgrows what a bot may send, the group gets a notice and the
archive stays on this server only. An S3-compatible (or other off-host) object
storage destination behind the same `RoutedBackupDelivery` is the obvious fix and
is deliberately NOT built: it needs an ADR (ADR-0011's control 2 says "not in
V1"), a decision about who holds the bucket credentials and how they are sealed,
and real credentials to accept it against. Until then, copying the archive off
the host is manual (`$C cp api:/var/lib/nexa/backups/<id>/archive.nxb .`, or the
Web Admin's «دریافت آرشیو رمزشده»).

**No retention of the Telegram copies.** The Bot API can delete only messages
younger than 48 hours, so pruning the group's old documents is manual. Archive
FILES on the server do have a retention policy now — see below.

**No automatic resend of an ambiguous delivery.** A delivery whose outcome was
never observed is recorded as `OUTCOME_UNKNOWN` and left alone. Check for them
with `pnpm backup list`; the archive is on disk either way.

**No enforcement of who can read the channel.** The archives go to the operations
log group's backups topic (or the fallback chat): review that group's membership and
write down who is in it. Nothing in this codebase can check that, and anyone in that
group holding the KEK has your whole database.

## Archive retention and housekeeping

The worker runs a housekeeping pass every 15 minutes (first pass 90 seconds after
start), beside the scheduler. It does nothing while a recovery holds the
installation — it asks the same quiesce predicate as every backup trigger.

**Archive files.** Two settings, on the generic settings page under the
operations group:

| Key                         | Default | Range  | Meaning                                                            |
| --------------------------- | ------- | ------ | ------------------------------------------------------------------ |
| `backup.archive_keep_count` | 14      | 1–1000 | the newest N **verified** archives always stay                     |
| `backup.archive_keep_days`  | 30      | 1–3650 | every archive stays at least this many days after its run finished |

A run's directory is removed only when it fails BOTH — outside the newest N
verified AND older than the days. Whatever the settings say, these are never
removed: the newest verified archive (its own clause, independent of the count),
a run still in flight, a run whose delivery outcome is `OUTCOME_UNKNOWN`, and any
backup an unfinished recovery names (its pre-restore backup, or the archive it is
restoring). FAILED runs' directories (normally already empty) are handled the
same way.

**The two retentions are coherent.** The directory goes first, then the run row
is stamped `archive_pruned_at`; the run-ROW purge (ADR-0027, 365 days) removes
only rows that carry that stamp. So a purged row can never orphan an archive. A
directory that NO row names (for example the pre-restore archive of a recovery
that cut over — its row lives in the displaced database) is never removed
automatically; delete it by hand once you are sure.

Removing an archive also removes it from the Recovery Kit's dependency count: a
key only that archive needed becomes removable. Copies elsewhere (Telegram, a
laptop) are not counted, as before.

**Plaintext debris.** A run abandoned mid-dump keeps its plaintext by design (its
process may still be writing), and a killed CLI `verify`/`restore` leaves a
`.cli-*` directory (judged by the newest mtime of the directory and its files; a
running CLI command also touches its directory every minute). Both are removed
once nothing has written them for the grace
window: the longer of 24 hours and `BACKUP_DUMP_TIMEOUT_MS +
BACKUP_RESTORE_TIMEOUT_MS + 15 minutes`. The directory of a RUNNING run is never
touched, and an archive is never touched by this sweep. Leaked scratch
DATABASES (`nexa_verify_*`, `nexa_rtest_*`) are still reported and not swept.

## Alerts

Every backup condition goes through the operational-event recorder, so it lands in
the notification centre (category BACKUPS) and the ops group's backups topic (the
`backup.` prefix route). Each is deduped installation-wide onto one open row and
closed by its `_ok` twin only when open — a healthy installation records nothing.

| Opens                            | Severity | When                                                                                                                     | Closes with                                                                                                                   |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `backup.run_failed`              | ERROR    | a run failed, or an abandoned run was reclaimed                                                                          | `backup.run_ok`, the next successful run                                                                                      |
| `backup.delivery_failed`         | WARN     | a verified run's archive did not leave the host (`FAILED_DEFINITIVE` or `OUTCOME_UNKNOWN`)                               | `backup.delivery_ok`, a later run that delivered (or had no destination configured)                                           |
| `backup.cleanup_failed`          | ERROR    | a run, the debris sweep, or archive retention left plaintext, a scratch database or a directory behind                   | `backup.cleanup_ok`, when no plaintext is left on disk and EVERY leftover any run recorded (paths, scratch databases) is gone |
| `backup.disk_threshold_exceeded` | WARN     | free space on `BACKUP_WORK_DIR`'s volume is below max(1 GiB, 1.5 × (2 × last dump + last archive))                       | `backup.disk_threshold_ok`                                                                                                    |
| `backup.interval_exceeded`       | ERROR    | **overdue**: the schedule is on and the last verified backup is older than the interval × 2 (`BACKUP_OVERDUE_TOLERANCE`) | `backup.interval_ok`, when a verified backup lands or the schedule is switched off                                            |

The overdue alert is evaluated in the WORKER, so it catches a scheduler that is
running and not producing verified backups. A worker that is not running at all
is caught by `botctl status` (the worker is a required readiness service), not
by this alert. An installation that has never had a verified backup is measured
from the moment the worker started watching.

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
hold, on the day it matters. On a deployed server, use the `$C exec -T api node
dist/backup.cli.js …` forms from § Commands, and `docs/vps-acceptance.md` § 7b
for the full checklist.

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

**Rolling back** — the two renames back, the stop/start order, and the
half-renamed state where nothing bears the live name — is
[`docs/recovery-rollback.md`](recovery-rollback.md), with the exact SQL.

### When the recovery container restarts mid-restore

The executor's lease owner is `recovery:<container hostname>`, and `docker
restart` keeps the hostname, so a restarted executor finds its OWN in-flight
recovery at once instead of waiting out the 15-minute stale-lease window:

- **Already cut over, waiting only on readiness** (`RESTARTING` with the cutover
  time and both database names on the row): it asks readiness again — up to six
  times, 5 s doubling to 30 s apart, because after a whole-stack restart Redis or
  the database may still be starting — and records
  `SUCCEEDED` (or `FAILED` with `recovery.readiness_failed`). Nothing destructive
  is left at that point, so finishing it renames, restores and drops nothing; the
  displaced database stays where it is. The audit row for keys that arrived by
  restore may be missing (that list lived in the dead process's memory).
- **Anything before the cutover**: recorded `FAILED`, never continued — a
  half-finished restore is not resumed by a process that did not watch it start.
  The quiesce is released and the candidate database is named on the row.

A container REPLACED (new hostname) or down for more than 15 minutes goes through
the stale-lease path instead: `FAILED` with `recovery.lease_expired`, cutover
facts kept on the row.

### Another installation's archive: the Recovery Kit

An archive from ANOTHER installation — the usual case after a server is rebuilt
from scratch — is sealed under that installation's key, which a fresh install
does not have. Without its **Recovery Kit** the upload fails as
`recovery.archive_foreign_key` and the Web Admin says what to do. With it:

1. On the fresh install, sign in as the owner and open **بکاپ و بازیابی**.
2. Under **کیت بازیابی**, import the old server's `.nxkit` with its passphrase.
   Its keys are added **decrypt-only**: this server's own key stays the one every
   new secret and backup is sealed with.
3. Upload the old `.nxb`, verify, confirm — the ordinary restore above.

The restore-test also checks the secrets INSIDE the backup (bot tokens, panel
credentials): if any is sealed under a key neither this server nor the kit
holds, it refuses with `recovery.candidate_keys_missing` before anything is
confirmed. The executor carries the imported keys into the restored database
before the cutover, so they survive it. Details: ADR-0032 and
`docs/recovery-kit-format.md`.

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

## The Recovery Kit — keep one, apart from the backups

**A `.nxb` alone is not enough to restore on a new server.** Export a Recovery
Kit from the Web Admin (owner, account password, a passphrase of at least 12
characters typed twice), and keep it somewhere that is neither this server nor
the place the backups go; keep the passphrase somewhere else again. Kit +
passphrase + any backup is the whole database, so treat the kit like the KEK it
contains. Export a new kit after every key rotation: a kit holds the keys that
existed when it was made.

Imported keys are listed with what still depends on each. An imported key can be
removed only when no stored secret, other imported key, archive on this server's
disk (sealed under it, or taken while it was held) or unfinished recovery needs
it. Copies elsewhere (Telegram, a laptop) cannot be counted — and that includes
this server's own older backups taken before a `secrets rewrap`, which may hold
credentials still sealed under the key — so remove one only when you are sure.
A removed key leaves a tombstone, so restoring an older backup does not bring it
back; importing its kit again does. Import, like export, asks for your account
password. Configured keys are never
removed from the Web Admin; `botctl secrets retire-check --key ID` is the gate for
those, and it counts imported keys wrapped under the key as dependencies.
`botctl secrets rewrap` re-wraps imported keys under the active key along with
everything else.

## Relationship to `botctl backup`

`deploy/bin/botctl backup` is the deployment tool's own dump — a `pg_dump` taken
before an update so `botctl rollback` has something behind it. It is
unencrypted, undelivered, unverified, and local, and that is appropriate for
what it is: an update's safety net, taken and used minutes apart by the same
operator on the same host.

It is not a disaster-recovery backup and this pipeline does not replace it.
`botctl rollback` still never restores the database — the backup predates the
migration, so restoring it would discard every write made since.
