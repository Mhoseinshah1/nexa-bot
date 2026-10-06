# Rolling back a Web Admin restore (the two renames back)

A Web Admin restore (ADR-0028, `docs/backup.md` § Restoring from the Web Admin)
replaces production by **two renames**:

```sql
ALTER DATABASE nexa RENAME TO nexa_pre_restore_<sid>;   -- the outgoing database, kept
ALTER DATABASE nexa_candidate_<sid> RENAME TO nexa;     -- the restored candidate, now live
```

`<sid>` is the recovery id with its hyphens removed, first 20 characters. Nothing
in this codebase ever drops `nexa_pre_restore_<sid>`: it is the rollback, and
this document is how to use it. **Nothing here has been run on a real server**
(`docs/vps-acceptance.md` § 12b, the rollback rehearsal row, is NOT RUN).

Rolling back DISCARDS every write the restored database took since the cutover.
Nothing below drops anything: the restored database is renamed aside, not removed,
so a rollback can itself be rolled back by the same two renames in reverse.

## 0. Set up the commands

On the host, as the operator who installed Nexa:

```bash
C='sudo docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml'
# psql against the MAINTENANCE database `postgres`, never the one being renamed.
PSQL="$C exec -T postgres psql -U nexa -d postgres -v ON_ERROR_STOP=1"
```

`nexa` is the installer's `POSTGRES_USER` and `POSTGRES_DB`
(`/etc/nexa/postgres.env`); if yours differ, substitute them everywhere below —
"the live name" means `POSTGRES_DB`.

## 1. Find out which state you are in

The recovery row is inside a database, and which database depends on how far the
cutover got, so start from the databases themselves and the journal on disk:

```bash
$PSQL -Atc "SELECT datname FROM pg_database
             WHERE datname = 'nexa' OR datname LIKE 'nexa_pre_restore_%'
                OR datname LIKE 'nexa_candidate_%' OR datname LIKE 'nexa_restored_%'
             ORDER BY 1"
$C exec -T recovery sh -c 'ls -la /var/lib/nexa/recovery/cutover-*.json 2>/dev/null; cat /var/lib/nexa/recovery/cutover-*.json 2>/dev/null'
```

The journal (`cutover-<recovery id>.json`) names `liveDatabase`,
`candidateDatabase`, `displacedDatabase` and the `phase` it reached. Match what
you see:

| `nexa` | `nexa_pre_restore_<sid>` | `nexa_candidate_<sid>` | Journal phase          | State                                                                                                                                                                   | Go to |
| ------ | ------------------------ | ---------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| exists | exists                   | absent                 | `RENAMED` (or cleared) | **Cutover complete.** Production is the restored data; the original is the displaced database.                                                                          | § 2   |
| ABSENT | exists                   | exists                 | `RENAMED_OUT`          | **Half-renamed.** The first rename happened, the second did not. Nothing bears the live name, and every process is failing with `3D000 database "nexa" does not exist`. | § 3   |
| exists | absent                   | exists                 | `ABOUT_TO_RENAME`      | **Nothing was renamed.** Production is untouched; the candidate is debris.                                                                                              | § 4   |
| exists | absent                   | absent                 | none                   | No cutover happened. Nothing to roll back.                                                                                                                              | —     |

If what you see matches no row, **stop** and do not rename anything: write down
the output and ask. Renaming on a guess is how a recovery tool destroys the
database it was asked to protect.

When the database is reachable, the row says the same thing in words:

```bash
$C exec -T postgres psql -U nexa -d nexa -Atc \
  "SELECT id, state, stage, cutover_at, candidate_database, displaced_database, failure_code
     FROM recovery_requests WHERE candidate_database IS NOT NULL ORDER BY created_at DESC LIMIT 5"
```

## 2. Roll back a completed cutover

Production is `nexa` (restored). The original is `nexa_pre_restore_<sid>`.

1. **Optional but recommended: keep a backup of the restored state** before you
   take it out of service. It is still renamed aside rather than dropped, but an
   archive is portable:

   ```bash
   $C exec -T api node dist/backup.cli.js run; echo "exit=$?"
   ```

2. **Stop every application role** so nothing holds a connection to either
   database. PostgreSQL, Redis and Caddy stay up:

   ```bash
   $C stop api worker monitor provisioner assistant recovery
   ```

3. **The two renames back**, in this order, from the maintenance database. The
   terminate is needed only if a connection survived step 2 (a `psql` you left
   open, for example); it never touches anything outside the two names:

   ```bash
   $PSQL <<'SQL'
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname IN ('nexa', 'nexa_pre_restore_<sid>') AND pid <> pg_backend_pid();
   ALTER DATABASE nexa RENAME TO nexa_restored_<sid>;
   ALTER DATABASE nexa_pre_restore_<sid> RENAME TO nexa;
   SQL
   ```

   `ALTER DATABASE` cannot run inside a transaction, so these are two statements
   with a window between them, exactly as in the forward cutover. If the second
   fails, you are in the half-renamed state of § 3 with the names swapped: the
   original is still `nexa_pre_restore_<sid>`, and the fix is to retry the
   second statement.

4. **Start the roles again**:

   ```bash
   $C start api worker monitor provisioner assistant recovery
   sudo botctl status
   curl -s https://<admin host>/health/ready
   ```

5. **Close the recovery row in the original database, if the executor does not.**
   The original database was renamed away while its own copy of the recovery row
   said `CUTTING_OVER`, which is a quiescing state: until that row is closed the
   installation refuses durable writes. The executor closes it by itself — at its
   next tick if its container kept its hostname (it reclaims its own row and the
   first transition fails), otherwise after the 15-minute stale-lease window as
   `recovery.lease_expired`. If writes are still refused after 15 minutes, close
   it by hand with the same conditional shape every state change uses — naming
   its `from` states, never a bare `SET state`:

   ```bash
   $C exec -T postgres psql -U nexa -d nexa -c \
     "UPDATE recovery_requests
         SET state = 'FAILED', failure_code = 'recovery.internal',
             finished_at = now(), updated_at = now()
       WHERE id = '<recovery id>'
         AND state IN ('CUTTING_OVER', 'RESTARTING')"
   ```

6. **Check the content**, not an exit code: the thing you changed after the
   backup was taken (a template text, for example) is back.

`nexa_restored_<sid>` stays on the server. Drop it only once you are sure you do
not want the restored data: `$PSQL -c 'DROP DATABASE "nexa_restored_<sid>"'`.

## 3. Recover from a half-renamed cutover (`RENAMED_OUT`)

`nexa` does not exist. `nexa_pre_restore_<sid>` is the ORIGINAL production data
(the first rename moved it), and `nexa_candidate_<sid>` is the restored candidate
that was never renamed into place. The recovery row in the original database says
`CUTTING_OVER`; if the executor survived, it wrote a FAILED row nowhere it can
read now.

To put production back exactly as it was — **one** rename:

```bash
$C stop api worker monitor provisioner assistant recovery
$PSQL -c 'ALTER DATABASE "nexa_pre_restore_<sid>" RENAME TO nexa'
$C start api worker monitor provisioner assistant recovery
sudo botctl status
```

Then § 2 step 5 (close the row) and step 6 (check the content). The candidate is
debris: drop it once you are sure, with
`$PSQL -c 'DROP DATABASE "nexa_candidate_<sid>"'`.

Completing the cutover FORWARD instead (`ALTER DATABASE "nexa_candidate_<sid>"
RENAME TO nexa`) is possible but is a decision this runbook does not make for
you: the candidate was validated, but the readiness check after it never ran.

## 4. Nothing was renamed

Production is untouched. The executor records the recovery as FAILED with the
candidate named on the row. Drop the candidate when you are sure:
`$PSQL -c 'DROP DATABASE "nexa_candidate_<sid>"'`.

## What this runbook never does

- It never drops `nexa_pre_restore_<sid>` or `nexa_restored_<sid>`. Both are a
  complete database, and one of them is always the only copy of something.
- It never restores from an archive: that is a NEW recovery through the Web
  Admin, with its own pre-restore backup.
- It never runs `botctl rollback`, which rolls back the IMAGE and never the
  database (ADR-0022).
