# Legacy migration — rollback runbook (Item 15)

**Status: written, NOT RUN on production.** The database half of the mechanism is
exercised by `scripts/legacy-rehearsal.sh` on every rehearsal cycle; the Web Admin recovery
lane below must be rehearsed by hand on the staging copy before the production gate opens
([`production-gate.md`](production-gate.md), gate G13).

## The rule

**A rollback restores the full pre-import NEXA backup through the existing recovery lane
(ADR-0028). It never deletes rows.**

Not "delete what the import wrote", for reasons each of which is sufficient:

- the wallet is an **append-only ledger** — an opening entry is never deleted, only
  reversed, and a reversal is a new movement the legacy balance never had;
- `orders.origin` is immutable by trigger, and an adoption order is `PAID` by CHECK — there
  is no state to move it to;
- the audit log and `operational_events` are append-only by trigger;
- the outbox has already relayed `CustomerImported` / `WalletEntryRecorded` / … events to
  their consumers; a deleted row leaves its effects;
- the import touched customers, wallet entries, orders, services, username reservations,
  hidden products and shapes, trial overrides and their records, reminder rows and the
  import metadata — a hand-written delete list is a list somebody will get wrong, in
  production, under pressure.

The pre-import backup is a verified, encrypted, whole-database archive taken while nothing
else was writing (cutover step 6). Restoring it is exact by construction, and the recovery
lane keeps the post-import database as `nexa_pre_restore_<id>` — nothing is lost, and the
rollback is itself reversible by two renames.

The legacy product review (`legacy_product_reviews`, its `legacy_read_set_runs` rows and any
draft products approve-as-new created, all INACTIVE and unpriced) lives in the same
database: written at cutover step 10, which is after the step 6 backup, so a restore
removes it with everything else, and `nexa_pre_restore_<id>` keeps it. Nothing drops it on
its own — there is no separate delete path.

The legacy invoice archive (`legacy_invoice_archive`, its runs and staging, Mirza PR3) is
the same: written at cutover step 10, after the step 6 backup, so a restore removes it and
`nexa_pre_restore_<id>` keeps it. Its rows are append-only (UPDATE and DELETE refused by
trigger) and nothing else drops them; a later re-read appends revisions, never rewrites.

## When — triggers

Roll back when any of these holds and the owner (or the operator the owner named for the
window) decides so. Decide **before step 17 (unfreeze)** whenever possible: see "the point
of no easy return" below.

| #   | Trigger                                                                                                                             | Found at        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| T1  | any reconciliation equation fails (`reconciliation.md` C, W, R, S, P) and the cause is not a documented manual-review item          | cutover step 15 |
| T2  | **any provider write** attributable to the import (P1–P4 non-zero) — also a P0 incident, see "Provider expectations"                | step 15, 18     |
| T3  | the import cannot complete: `resume` refuses (fingerprint mismatch, run conflict), or `rows_failed > 0` that a rerun does not clear | step 14         |
| T4  | a manual-acceptance sample fails and is not a documented manual-review item                                                         | step 16         |
| T5  | a reminder or notification burst, or customer-facing errors caused by imported data                                                 | step 18         |
| T6  | duplicate money: an opening or adoption counted twice anywhere (W5, S5)                                                             | step 15         |
| T7  | the window runs out before step 16 has passed                                                                                       | any             |
| T8  | the owner decides                                                                                                                   | any             |

### The point of no easy return: unfreeze

Before step 17, NEXA's maintenance incident has stopped every sale and top-up and MirzaBot
is frozen, so the only writes since the backup are the import's own and an operator's.
Rolling back loses nothing anyone needs.

After step 17, customers act in NEXA: payments, top-ups, renewals — and a renewal of an
adopted service is a legitimate **RickPanel write**. A restore then discards real money
movements and leaves provider changes NEXA no longer remembers and MirzaBot never knew.
After unfreeze, prefer a forward fix; a rollback needs the owner's explicit decision and the
"what a rollback loses" list below produced FIRST, from the displaced database, for manual
settlement.

## Step R0 — stop traffic

```bash
set -o nounset
export NEXA_TENANT=<tenant-slug>
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
date -u +%FT%TZ | tee ~/cutover/rollback-start.txt
```

1. If P7 is still running, stop it — find its one-off container and stop that, nothing
   else:

   ```bash
   sudo docker ps --filter "label=com.docker.compose.oneoff=True" --format '{{.ID}} {{.Command}}'
   sudo docker stop <ID-of-the-legacy-import.cli.js-container>
   ```

2. If the cutover's maintenance incident was resolved (after unfreeze), start a new
   MAINTENANCE incident with `stop_sales` on every panel and gateway, admin banner and a
   customer message. Before unfreeze it is still active — leave it.
3. MirzaBot stays frozen until R5.

The recovery lane quiesces durable writes itself while it builds the candidate (ADR-0028);
the incident is what keeps customers from starting things in the minutes around it.

## Step R1 — the exact backup id

The rollback point is `PRE_IMPORT_BACKUP_ID`, recorded at cutover step 6 and named in the
owner's approval. **Never "the latest backup"**: every scheduled backup after step 6, and the
recovery lane's own pre-restore backup, contain the import.

```bash
cat ~/cutover/backup-id.txt
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js list --limit 50 \
  | grep "<PRE_IMPORT_BACKUP_ID>"
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js verify \
  --archive "/var/lib/nexa/backups/<PRE_IMPORT_BACKUP_ID>/archive.nxb"
```

Check: the row is `MANUAL  SUCCEEDED  verified`; its start time is before
`import-start.txt`; `verify` decrypts and checksums it. If the server copy is gone, use the
off-host encrypted copy downloaded at step 6 (and the Recovery Kit if this is a rebuilt
host).

## Step R2 — restore through the recovery lane (the supported path)

In the Web Admin, as the owner (`backup.download`, `recovery.restore`), **بکاپ و بازیابی**
under **سامانه و عملیات**. Every step is durable state on a `recovery_requests` row, so a
closed browser does not lose it (`docs/backup.md` § What a restore actually does):

1. Download the encrypted archive of `<PRE_IMPORT_BACKUP_ID>` («دریافت آرشیو رمزشده»), or take
   the off-host copy.
2. Upload it as a recovery. (Ceiling `RECOVERY_UPLOAD_MAX_BYTES`, 2 GiB by default; a larger
   archive needs that setting raised and a `botctl restart` first.)
3. Verify. **Read the verified manifest: its backup id must be `<PRE_IMPORT_BACKUP_ID>`** and
   its time the step-6 time. A different id: stop — wrong archive.
4. The restore test passes (a real `pg_restore` into a scratch database).
5. Type `RESTORE NEXA` and confirm. The confirmation is bound to this archive's SHA-256 and
   expires in ten minutes.
6. Watch the stages: `PRE_RESTORE_BACKUP` → `QUIESCING` → `RESTORING` → `VALIDATING` →
   `CUTTING_OVER` → `RESTARTING` → `SUCCEEDED`.
   - The **pre-restore backup** is a full verified backup of the post-import state. Record
     its id: it is the forensic copy of what the import did. If it fails, the recovery
     aborts before anything destructive — there is no path past it.
   - The cutover is two `ALTER DATABASE … RENAME`; the post-import database survives as
     **`nexa_pre_restore_<id>`**. Record its name.
7. `sudo botctl restart` afterwards is the tidier choice (the roles survive the rename, but a
   restart gives every pool a fresh connection).

### Break-glass only: the CLI, if the Web Admin cannot be reached

With the owner's explicit decision, the same shape by hand — restore into a NEW database,
validate, then two renames with the stack stopped. Never `pg_restore` into the live
database, and never drop the displaced one.

Paste it in **two blocks**. Each is a function that stops at the first failed check
(`return 1`), and every `psql` runs with `ON_ERROR_STOP=1`. Do not paste block 2 until
block 1 printed `CANDIDATE OK`.

Block 1 — build and validate the candidate (nothing in production changes):

```bash
STAMP="$(date -u +%Y%m%d%H%M%S)"
rb_candidate() {
  sudo $DC exec -T postgres createdb -U nexa "nexa_candidate_$STAMP" || return 1
  sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js restore \
    --archive "/var/lib/nexa/backups/<PRE_IMPORT_BACKUP_ID>/archive.nxb" --target "nexa_candidate_$STAMP" || return 1
  sudo $DC exec -T postgres psql -U nexa -d "nexa_candidate_$STAMP" -X -q -At -v ON_ERROR_STOP=1 \
    -F "$(printf '\t')" -v tenant="$NEXA_TENANT" -f - < <checkout>/scripts/legacy-rehearsal-checks.sql > candidate.tsv || return 1
  # The two worker-driven figures are recorded, not diffed (see R4).
  local noise='^(customer_notifications|service_reminders)'
  diff <(grep -Ev "$noise" ~/cutover/nexa-PRE.tsv) <(grep -Ev "$noise" candidate.tsv) \
    || { echo "STOP: the candidate is not the pre-import state"; return 1; }
  echo "CANDIDATE OK — block 2 may be pasted"
}
rb_candidate
```

Block 2 — only after `CANDIDATE OK`: stop the roles, move production aside, PROVE the first
rename happened, and only then give the candidate production's name:

```bash
rb_cutover() {
  local q="SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname IN ('nexa', 'nexa_pre_restore_manual_$STAMP', 'nexa_candidate_$STAMP')"
  sudo $DC stop api worker monitor provisioner recovery || return 1
  sudo $DC exec -T postgres psql -U nexa -d postgres -X -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE nexa RENAME TO nexa_pre_restore_manual_$STAMP" \
    || { echo "STOP: rename 1 failed; production is untouched (restart the roles)"; return 1; }
  [ "$(sudo $DC exec -T postgres psql -U nexa -d postgres -X -At -v ON_ERROR_STOP=1 -c "$q")" \
    = "nexa_candidate_$STAMP,nexa_pre_restore_manual_$STAMP" ] \
    || { echo "STOP: after rename 1 the databases are not as expected; do not continue"; return 1; }
  sudo $DC exec -T postgres psql -U nexa -d postgres -X -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE nexa_candidate_$STAMP RENAME TO nexa" \
    || { echo "STOP: rename 2 failed; no database is named nexa — rename nexa_pre_restore_manual_$STAMP back"; return 1; }
  sudo botctl restart
}
rb_cutover
```

If rename 2 fails, production has no database named `nexa`: put the original back with
`ALTER DATABASE nexa_pre_restore_manual_$STAMP RENAME TO nexa` and restart, then decide.

(`ALTER DATABASE … RENAME` refuses while sessions are connected to the database being
renamed; that is why the application roles are stopped first.)

## Step R3 — application compatibility

The pre-import backup was taken AFTER the approved release was deployed (cutover step 6
follows step 2), so the restored database is at the **same migration level** as the running
release: no application change is needed, and the recovery's validation confirms the
migration state is compatible.

`botctl rollback` is a different tool and **never restores the database** — it returns the
application to the previous release's image only. The two combine in one order:

1. **Database first**: restore `<PRE_IMPORT_BACKUP_ID>` as above. The running release reads it.
2. **Then, only if the release itself must go** (a defect in the release, not in the data):
   `sudo botctl rollback`. Valid because migrations are expand-only within a release
   (`docs/deployment.md` § Migration compatibility): release N's schema runs release N−1's
   code. Read the deployment doc's "what a rollback strands" sections for the releases
   involved.

Never the other way round: an application rolled back first would be handed a restored
database whose schema is ahead of it. And never restore the `botctl backup`
(`/var/backups/nexa/*.sql.gz`) for this purpose — it predates the update and would discard
everything since.

## Step R4 — post-restore validation

```bash
sudo botctl status
curl -fsS "https://<nexa-domain>/health/ready" && echo READY
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" \
  -v tenant="$NEXA_TENANT" -f - < <checkout>/scripts/legacy-rehearsal-checks.sql > nexa-RESTORED.tsv
# The worker starts again with the stack and may raise a reminder or a notification at
# once: those two figures are recorded, not diffed.
NOISE='^(customer_notifications|service_reminders)'
diff <(grep -Ev "$NOISE" ~/cutover/nexa-PRE.tsv) <(grep -Ev "$NOISE" nexa-RESTORED.tsv) \
  && echo "restored = pre-import, exactly" || echo "STOP: the restored database is not the pre-import state"
grep -E "$NOISE" ~/cutover/nexa-PRE.tsv nexa-RESTORED.tsv
sudo $DC exec -T postgres psql -U nexa -d postgres -X -At -c \
  "SELECT datname FROM pg_database WHERE datname LIKE 'nexa_pre_restore_%' ORDER BY 1"
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c "
  SELECT r.id, r.status, r.started_at FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id
   WHERE t.slug = '$NEXA_TENANT' ORDER BY r.started_at"
```

Check, every one:

- all roles healthy, `/health/ready` 200;
- `nexa-RESTORED.tsv` is **identical** to `nexa-PRE.tsv` — customers, wallet total and
  entries, openings (the pre-import count, normally 0), adoption orders, services,
  provisioning operations, hidden products, trial overrides, reminders, import runs and map;
- the production import's `APPLY` run is **absent** from `legacy_import_runs` (it lives only
  in the displaced database); no run is `RUNNING`;
- `nexa_pre_restore_<id>` exists — keep it until the incident review is closed;
- in the Web Admin: a customer imported by the run is unknown to NEXA again (or, for an
  existing customer, shows the pre-import balance); the recovery request is `SUCCEEDED`;
- the operations group received the recovery's own event.

### What a rollback loses

Everything written after `<PRE_IMPORT_BACKUP_ID>` was taken. Before unfreeze that is the
import plus any operator action in the window. After unfreeze, produce the list from the
displaced database BEFORE deciding, for manual settlement (read-only, aggregates first):

```bash
sudo $DC exec -T postgres psql -U nexa -d "<nexa_pre_restore_id>" -X -At -c "
  SELECT 'payments', count(*), COALESCE(SUM(amount), 0) FROM payments WHERE created_at >= '<step-6 time>'
  UNION ALL SELECT 'wallet_entries_non_opening', count(*), COALESCE(SUM(amount), 0) FROM wallet_entries
             WHERE created_at >= '<step-6 time>' AND reason <> 'MIGRATION_OPENING_BALANCE'
  UNION ALL SELECT 'provisioning_operations', count(*), 0 FROM provisioning_operations
             WHERE created_at >= '<step-6 time>'"
```

Each payment and each provisioning operation there is a real-world fact NEXA will no
longer hold; the owner settles them one by one.

## Step R5 — resume Legacy / MirzaBot

Only after R4 passes and the owner decides to give customers back to MirzaBot:

1. Confirm the legacy database is unchanged since the freeze — the same SELECT-only
   `scripts/legacy-freeze-checksum.sql` (every table) as cutover step 7, equal to the
   recorded values. (It was read-only; this proves it.) Capture the client's own exit
   status and let the checker compare, never a bare `diff`:

   ```bash
   mysql --user=oldbot_ro --password --batch oldbot \
     < legacy-freeze-checksum.sql | tee freeze-checksum-R5.tsv; echo "exit ${PIPESTATUS[0]}"
   bash legacy-freeze-checksum-verify.sh freeze-checksum-step7.tsv freeze-checksum-R5.tsv; echo "verify exit $?"
   ```

   Both `exit 0`, and `EQUAL`. An empty or partial file (a failed client) is refused by the
   checker; it is no proof.

2. Owner-operated on the legacy host: lift `read_only` / `super_read_only`, restart MirzaBot
   and its cron/webhook.
3. Announce to customers that the old bot is back; resolve or update NEXA's maintenance
   incident according to what NEXA will serve meanwhile.
4. Remove the throwaway legacy source container only after the incident review.

## Provider expectations

**Zero provider mutations ⇒ no provider-side reversal.** Adoption is not provisioning: P6
stores local NEXA metadata for an account that already exists on RickPanel and never
creates, renews, adds traffic or time to, enables, disables, renames, rotates or deletes it.
So after a rollback, every RickPanel account is exactly as MirzaBot left it, and MirzaBot can
resume managing it with nothing to undo on any panel.

That statement holds only while P1–P3 (`reconciliation.md` §4) hold. Check them against the
**displaced** database:

```bash
sudo $DC exec -T postgres psql -U nexa -d "<nexa_pre_restore_id>" -X -At -c "
  SELECT count(*) FROM provisioning_operations WHERE created_at >= '<import-start>' AND created_at < '<rollback-start>'"
```

- `0` before unfreeze: nothing to reverse. Record it.
- Non-zero before unfreeze: a provider write the import should have made impossible — a
  **P0 incident**. The database restore does NOT undo it. List the affected services from the
  displaced database (service ids and operation types only), compare each account in the
  RickPanel UI with MirzaBot's record of it, and correct by hand with the owner, one account
  at a time.
- After unfreeze, customer-initiated operations are legitimate writes that the rollback will
  not undo; they are on the "what a rollback loses" list.

## Rehearse it in staging

The production gate requires a successful rollback rehearsal (G13). Two parts:

1. **Mechanism, every rehearsal**: `scripts/legacy-rehearsal.sh` restores the pre-import
   snapshot into a candidate, validates it against the pre-import aggregates, cuts over by
   two renames, keeps the displaced database, and requires the post-restore snapshot to equal
   the pre-import one exactly (`rollback_restores_pre_import`), then repeats the import from
   that clean restore (`repeat_reproduces_cycle_1`). Since WP-D8 "exactly" is exact: every
   table of `public` and `drizzle` is fingerprinted (rows, and two 64-bit sums over
   `md5(row::text)`, `scripts/legacy-rehearsal-table-hashes.sql`) before the import and after
   the rollback, and must be identical (`rollback_restores_pre_import_exact`); and the
   displaced database must exist (`rollback_displaced_exists`) and be, table by table, the
   post-import state (`rollback_displaced_preserved`). The harness's mechanism is
   `pg_dump`/`pg_restore` and two renames — NOT the `.nxb` archive and the recovery executor
   production uses, so it never satisfies part 2.
2. **The lane, by hand, once per release candidate**: on the staging installation, after a
   staging import, run R0–R4 above with the staging pre-import backup id — download,
   upload, verify, `RESTORE NEXA`, watch the stages, validate with the same `diff`. Record the
   duration of each stage and the recovery request id. A rehearsal that skipped the Web
   Admin lane does not satisfy G13.

### Recording the lane (G13 part b)

**Status: NOT RUN.** No staging import exists yet, so the lane has not been rehearsed on
it. Fill one table per rehearsal, in the readiness record, from the Web Admin and the R4
commands; every row starts `NOT RUN` and is `PASS` only with its value recorded.

| step | what is recorded                                                                                                           | value | result  |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ----- | ------- |
| R0   | release candidate (version and image digest) and the time traffic stopped                                                  | —     | NOT RUN |
| R1   | `PRE_IMPORT_BACKUP_ID`; `backup list` row `MANUAL SUCCEEDED verified`; `verify` OK                                         | —     | NOT RUN |
| R2.1 | the archive's SHA-256 (download or off-host copy)                                                                          | —     | NOT RUN |
| R2.3 | the verified manifest's backup id — must equal `PRE_IMPORT_BACKUP_ID`                                                      | —     | NOT RUN |
| R2.4 | the restore test (scratch `pg_restore`) passed                                                                             | —     | NOT RUN |
| R2.5 | the recovery request id                                                                                                    | —     | NOT RUN |
| R2.6 | stage durations: `PRE_RESTORE_BACKUP`, `QUIESCING`, `RESTORING`, `VALIDATING`, `CUTTING_OVER`, `RESTARTING` (seconds each) | —     | NOT RUN |
| R2.6 | the pre-restore backup id (the forensic copy of the post-import state)                                                     | —     | NOT RUN |
| R2.6 | the displaced database `nexa_pre_restore_<id>` — exists after the cutover                                                  | —     | NOT RUN |
| R3   | the running release's migration level equals the restored database's                                                       | —     | NOT RUN |
| R4   | `/health/ready` 200 and every role healthy                                                                                 | —     | NOT RUN |
| R4   | `diff` of `nexa-PRE.tsv` and `nexa-RESTORED.tsv` (noise lines excluded): empty                                             | —     | NOT RUN |
| R4   | the import's `APPLY` run absent from `legacy_import_runs`; none `RUNNING`                                                  | —     | NOT RUN |
| R4   | an imported customer unknown again (or an existing one at its pre-import balance)                                          | —     | NOT RUN |
| R4   | the recovery request `SUCCEEDED`; the operations group got the recovery event                                              | —     | NOT RUN |

Optional and stronger than the R4 `diff`: run `scripts/legacy-rehearsal-table-hashes.sql`
against the staging database before the import and after the lane, and record whether the
two outputs are identical (`cmp`). The runbook's `diff` compares the aggregate figures; the
table hashes compare every row.
