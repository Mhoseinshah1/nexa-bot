# Legacy migration — production cutover runbook (Item 14)

**Status: written, NOT RUN.** Production cutover is **not allowed** until the Product Owner
has approved it in writing at step 13. Nothing in this repository runs any step of it; an
operator runs it, on the production host, in this order. The readiness gate that must be
green before step 1 is even scheduled is [`production-gate.md`](production-gate.md).

Companion documents: [`rollback-runbook.md`](rollback-runbook.md) (keep it open from step
6 onward), [`reconciliation.md`](reconciliation.md), [`manual-acceptance.md`](manual-acceptance.md),
[`final-report-template.md`](final-report-template.md).

## Conventions — read before copying anything

- **Every `<PLACEHOLDER>` fails if it is left unedited.** Unquoted — `export NEXA_TENANT=<tenant-slug>`,
  `docker stop <ID>` — it parses as a redirect and is a shell syntax error, so the line runs
  nothing. Inside quotes or SQL it names an id, file or time that does not exist, so the
  command errors or matches nothing instead of acting. Replace each one by hand; never by a
  global search-and-replace across the page, and never wrap one in quotes to "make it work".
- **Session variables are set once, at step 0, with `set -o nounset`**, so a forgotten
  variable fails the command instead of expanding to nothing.
- **Aggregates only leave the host.** Nothing pasted into a chat, ticket or the report may
  contain a Telegram id, phone, username, subscription link, panel credential, token or
  card. Every command here prints counts or identifiers of NEXA rows (run ids, backup
  ids). A single legacy record is inspected locally, redacted, and never pasted.
- **The legacy database is source and archive.** It is read through a SELECT-only account
  inside `START TRANSACTION READ ONLY`, from a restored copy of the final dump. RickPanel
  is read-only throughout (provider mutation count = 0).
- **Record as you go** in a copy of `final-report-template.md`: every id, checksum, count,
  start and end time (UTC) the steps below name.

### The P7 CLI — as built (`docs/legacy-migration/importer.md`)

```
legacy-import MODE --tenant T --source SOURCE --target TARGET --panel-map FILE
              [--format md|json] [--out DIR] [--inventory-page-size N] [--abort-running]
              [--source-password-env NAME] [--allow-production-target]
```

| Flag / exit                                                   | Meaning here                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                                                        | `audit`, `dry-run`, `import`, `resume`, `reconcile`, `report` (first word, or `--mode`)                                                                                                                                                                                                                       |
| `--source env:LEGACY_SOURCE_DSN`                              | the `mysql://` DSN in that variable. A password on argv — in a DSN or a `--…password` flag — is **refused**                                                                                                                                                                                                   |
| `--target nexa`                                               | a bare name must equal the database `DATABASE_URL` names (the api container's own)                                                                                                                                                                                                                            |
| `--panel-map`                                                 | `nexa-legacy-panel-map/v1` JSON (step 10); unknown keys refused                                                                                                                                                                                                                                               |
| `--evidence-class production`                                 | required for import, resume and report (passed to every mode by `p7`); checked against the source — a SYNTHETIC-marked source can only be `synthetic`                                                                                                                                                         |
| `--allow-production-target`                                   | with `NEXA_LEGACY_IMPORT_TARGET_ACK=<16 hex>`: the hard guard. `nexa` is production-like, so **every mode** needs both here; the ack is bound to host, port, database and tenant                                                                                                                              |
| `--inventory-page-size`                                       | omitted = **200** rows per RickPanel list page (the maximum; `importer.md` §1.1). Leave it omitted: the real rehearsal BLOCKED with `TOTAL_CHANGED` at 50 (~500 reads) and passed at 200 (~130)                                                                                                               |
| `--abort-running`                                             | `resume` only: finish a stuck RUNNING run as ABORTED. An owner decision, never a reflex                                                                                                                                                                                                                       |
| exit `0`                                                      | done                                                                                                                                                                                                                                                                                                          |
| exit `3`                                                      | done, but a person must decide: audit `BLOCKED`, import/resume `COMPLETED_WITH_FAILURES` (see its `attention` counts), reconcile `DISCREPANCY`, report with a failed equation                                                                                                                                 |
| exit `4`                                                      | import interrupted; the run stays RUNNING — use `resume`                                                                                                                                                                                                                                                      |
| `--expected-fingerprint` / `--expected-panel-map-fingerprint` | import/resume only: the source and panel-map fingerprints the owner approved (audit's `source.fingerprint`, `panelMapping.fingerprint`). A mismatch is refused before any write, exit `65`. Against a production-like target `--expected-fingerprint` is **required** (without it: exit `64`, nothing opened) |
| exit `64` / `65`                                              | usage or guard refusal / mapping or source refused — nothing was written                                                                                                                                                                                                                                      |
| exit `73`                                                     | the report was computed and printed to stdout, but `--out` could not be written (path and errno printed). Not an audit failure; the verdict stands. This runbook captures stdout on the host (`tee`), so it uses no `--out`                                                                                   |
| exit `1`                                                      | anything else, printed as a code                                                                                                                                                                                                                                                                              |

`scripts/legacy-rehearsal.sh` calls the same interface; its contract block names the same
flags and exit codes.

## Step 0 — session setup (on the production host)

```bash
set -o nounset
export NEXA_TENANT=<tenant-slug>                   # the PRIMARY tenant's slug
export APPROVED_VERSION=<vX.Y.Z>                    # the release the owner approved, with P6 + P7
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt

# The one way this runbook calls the importer. The two variables travel through
# --preserve-env (they must not appear on any command line: the DSN holds a password),
# which needs a sudo policy that allows it — an operator with full sudo has it.
p7() {
  sudo --preserve-env=LEGACY_SOURCE_DSN,NEXA_LEGACY_IMPORT_TARGET_ACK $DC run --rm --no-deps -T \
    -e LEGACY_SOURCE_DSN -e NEXA_LEGACY_IMPORT_TARGET_ACK \
    -v /etc/nexa/legacy/panel-map.json:/legacy/panel-map.json:ro \
    --entrypoint node api dist/legacy-import.cli.js "$1" \
    --tenant "$NEXA_TENANT" --source env:LEGACY_SOURCE_DSN --target nexa \
    --panel-map /legacy/panel-map.json --evidence-class production --allow-production-target "${@:2}"
}
```

Have the operator's checkout of the APPROVED release's commit available for the two SQL
files (`scripts/legacy-rehearsal-checks.sql`, `scripts/legacy-rehearsal-source.sql`):

```bash
git -C <checkout> rev-parse HEAD   # must equal the commit `botctl version` reports at step 2
```

## Step 1 — maintenance announcement

**T − 24 h** (and again at T − 1 h):

1. MirzaBot: the owner announces the move and the window through the legacy bot's own
   broadcast. (Owner-operated; outside this repository.)
2. NEXA Web Admin → incidents: create a **MAINTENANCE** incident, `SCHEDULED` for the
   window, with:
   - `stop_sales` on, targeting **every panel and every payment gateway** — so no sale and
     no top-up can land in the import window (the wallet equation W2 depends on it,
     `reconciliation.md` §2);
   - `admin_banner` on;
   - the customer message (Persian), naming the window.
     It starts by itself at the scheduled time (`docs/incidents.md`). Record its id.

Check: the incident is `SCHEDULED`; at T − 0 it is `ACTIVE` and its effects list shows a
drain per panel and a disable per gateway.

## Step 2 — the approved release is deployed

```bash
sudo botctl update "$APPROVED_VERSION"      # skip if already current; it says so
sudo botctl version | tee release.txt       # version, commit, image digest, rollback target
```

Check: `version` is `$APPROVED_VERSION`; `commit` is the commit the owner approved and the
one your checkout is at; no `DIVERGENCE`. Record all three lines and the `previous` line
(the application rollback target).

## Step 3 — health and readiness

```bash
sudo botctl status | tee status-pre.txt
curl -fsS "https://<nexa-domain>/health/ready" && echo READY
```

Check: api, worker, monitor, provisioner and **recovery** are all healthy (the recovery
role is the only thing that can perform the rollback restore — `docs/vps-acceptance.md`
§12b); `/health/ready` answers 200. Any unhealthy role: stop here.

## Step 4 — migrations

`botctl update` migrated with the target release's own migrator. Confirm, read-only:

```bash
sudo $DC run --rm --no-deps -T --entrypoint node api \
  dist/infrastructure/persistence/migrate.js --preflight
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c \
  "SELECT count(*) FROM drizzle.__drizzle_migrations"
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c \
  "SELECT to_regclass('public.legacy_import_runs') IS NOT NULL,
          to_regclass('public.legacy_import_map') IS NOT NULL,
          pg_get_constraintdef(oid) LIKE '%invoice%'
     FROM pg_constraint WHERE conname = 'legacy_import_map_legacy_key_check'"
```

Check: preflight passes; the migration count equals the number of `.sql` files in the
release's `apps/api/drizzle/` (record both); the last line is `t|t|t` (the metadata tables
exist and the map accepts `invoice` keys).

## Step 5 — the backup system

```bash
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js list --limit 5
```

Check:

- the most recent runs are `SUCCEEDED  verified`; any `CLEANUP-INCOMPLETE` is dealt with first;
- a **Recovery Kit** exported after the last key rotation exists off this host, with its
  passphrase stored separately (`docs/backup.md` § The Recovery Kit). Without it, a
  rollback onto a rebuilt host cannot open the archive;
- the operations group's backups topic (or the fallback chat) received the last archive,
  or you know it was retained on the server only.

## Step 6 — full pre-import NEXA backup

The maintenance incident must be **ACTIVE** from here on: every write between this backup
and a rollback is lost by the rollback (`rollback-runbook.md` § What a rollback loses).

```bash
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js run | tee backup-pre-import.txt
echo "backup exit ${PIPESTATUS[0]}"   # the CLI's own exit code, not tee's
```

The command exits `0` only for a verified, cleaned-up run (`1` failed, `2` another backup
holds the lock — wait and rerun, `3` cleanup incomplete — fix before continuing). Capture:

```bash
export PRE_IMPORT_BACKUP_ID="$(awk '$1 == "backup" { print $2 }' backup-pre-import.txt)"
export PRE_IMPORT_BACKUP_SHA256="$(awk '$1 == "sha256" { print $2 }' backup-pre-import.txt)"
printf 'backup %s\nsha256 %s\n' "$PRE_IMPORT_BACKUP_ID" "$PRE_IMPORT_BACKUP_SHA256" | tee backup-id.txt
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js verify \
  --archive "/var/lib/nexa/backups/$PRE_IMPORT_BACKUP_ID/archive.nxb"
```

Check: `state SUCCEEDED`, `verified <time>`, `cleanup ok`; `verify` succeeds. Then, in the Web
Admin (owner, `backup.download`), download this run's **encrypted** archive and store it off
the host beside the Recovery Kit. **This backup id is the rollback point.** Write it into
the report now; the rollback runbook refers to it as `PRE_IMPORT_BACKUP_ID`.

Take the NEXA `PRE` snapshot immediately after, while nothing else is writing:

```bash
date -u +%FT%TZ | tee pre-snapshot-time.txt
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" \
  -v tenant="$NEXA_TENANT" -f - < <checkout>/scripts/legacy-rehearsal-checks.sql | tee nexa-PRE.tsv
```

## Step 7 — freeze Legacy / MirzaBot

Owner-operated on the legacy host (its commands are outside this repository):

1. Stop the MirzaBot process(es) and its cron/webhook, so no customer action reaches it.
2. Make the legacy MySQL refuse writes (for example `SET GLOBAL read_only = ON`, and
   `super_read_only` where the server supports it). This is a server setting, not a data
   change.
3. Record a read-only content checksum of EVERY table, as the SELECT-only account, with
   the repository's script (copy it to the legacy host; it is plain SQL):

```bash
mysql --user=oldbot_ro --password --batch oldbot \
  < legacy-freeze-checksum.sql | tee freeze-checksum-step7.tsv   # read-only; record the time (UTC)
```

`scripts/legacy-freeze-checksum.sql` builds one `CHECKSUM TABLE` over every base table of
the database, in name byte order. That covers `user`, `invoice` and `product`, and every
table any read set reads or will read (products, the invoice archive), plus the ones
nothing reads, so a write to any of them between the freeze and the switch is noticed.
(Before Mirza PR1 this step covered `user, invoice` only.) It needs SELECT and nothing else,
and runs under `read_only`/`super_read_only`. `legacy-import inventory` prints the same
table list.

Check: a customer pressing a button in MirzaBot gets no response; a test write as an
ordinary account fails with a read-only error. MirzaBot stays frozen from here on — it is
never unfrozen for writes (step 17).

## Step 8 — final legacy dump

On the legacy host, as the SELECT-only account (it needs no `LOCK TABLES` with
`--single-transaction`):

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mysqldump --user=oldbot_ro --password --single-transaction --quick --no-tablespaces \
          --skip-triggers oldbot > "oldbot-final-$STAMP.sql"
sha256sum "oldbot-final-$STAMP.sql" | tee "oldbot-final-$STAMP.sql.sha256"
```

Copy the dump and its `.sha256` to the NEXA host into a `0700` directory; verify the
checksum on arrival. Record the file name, size and SHA-256. The dump holds customer data:
never place it in a shared location.

## Step 9 — source fingerprint

Restore the final dump into a **throwaway** MariaDB that the api container can reach, and
read it only through a SELECT-only account. One way, on the NEXA host's `data` network (the
container image must be pullable; use the same major version as the legacy server):

```bash
sudo docker volume create nexa-legacy-src
sudo docker run -d --name nexa-legacy-src --network nexa_data --restart no \
  -e MARIADB_RANDOM_ROOT_PASSWORD=1 -v nexa-legacy-src:/var/lib/mysql mariadb:<legacy-major-version>
sudo docker logs nexa-legacy-src 2>&1 | grep -m1 'GENERATED ROOT PASSWORD'   # read it; never paste it
read -rs LEGACY_ROOT_PW                      # type the generated root password
read -rs LEGACY_RO_PW                        # choose the SELECT-only account's password
# No password ever reaches a command line (argv is readable by every local user): MYSQL_PWD
# is set for the one sudo invocation, passed through --preserve-env, and handed to the
# container by NAME (`-e MYSQL_PWD`, no value). Not `-p` either: a prompt inside
# `docker exec -i` would read the password from the stdin that carries the dump.
legacy_root() { MYSQL_PWD="$LEGACY_ROOT_PW" sudo --preserve-env=MYSQL_PWD docker exec -i -e MYSQL_PWD nexa-legacy-src mariadb -uroot "$@"; }
legacy_ro() { MYSQL_PWD="$LEGACY_RO_PW" sudo --preserve-env=MYSQL_PWD docker exec -i -e MYSQL_PWD nexa-legacy-src mariadb -uoldbot_ro "$@"; }
legacy_root -e "CREATE DATABASE oldbot CHARACTER SET utf8mb4"
legacy_root oldbot < "oldbot-final-<STAMP>.sql"
# The reader's password is in this statement, so the statement goes on stdin, not -e.
legacy_root <<SQL
CREATE USER 'oldbot_ro'@'%' IDENTIFIED BY '$LEGACY_RO_PW';
GRANT SELECT ON oldbot.* TO 'oldbot_ro'@'%';
SQL
# P7 reads the DSN from this variable (--source env:LEGACY_SOURCE_DSN); it refuses a
# password anywhere on its command line.
export LEGACY_SOURCE_DSN="mysql://oldbot_ro:${LEGACY_RO_PW}@nexa-legacy-src:3306/oldbot"
```

Then confirm the restored copy IS the frozen source, and record the fingerprint:

```bash
legacy_ro oldbot --batch < <checkout>/scripts/legacy-freeze-checksum.sql | tee freeze-checksum-step9.tsv
legacy_ro oldbot --batch --skip-column-names --safe-updates \
  < <checkout>/scripts/legacy-rehearsal-source.sql | tee legacy-source.tsv
```

Check: `diff freeze-checksum-step7.tsv freeze-checksum-step9.tsv` is empty: the same tables,
each with the same value as step 7's. The `Table` column carries the database name; if the
restored copy's database is named differently from the legacy host's, compare after
removing that `<db>.` prefix. Compare values only
between servers of the same engine and major version; that is why the throwaway server
uses the legacy major version. All values equal step 7's (the copy is the frozen database,
byte for byte at the row level). P7 `audit` (next step) prints the **source fingerprint**
(SHA-256 of the snapshot's identity) — record it; every later P7 run must report the same
one, and `resume` refuses a different one. (P7's report carries its own per-table digests
in `source.checksumTable`; those are P7's hashes, not these `CHECKSUM TABLE` values — record
both.)

## Step 10 — production audit

Read-only: source aggregates, destination state, RickPanel inventory (two consecutive
walks per panel), the Item 1 evidence and the plan. Audit writes nothing — not even a run
row.

The panel map is explicit and strict (`importer.md` §4; unknown keys, an inbound id above
all, are refused; every panel named must be an ACTIVE RickPanel of this tenant):

```json
{
  "format": "nexa-legacy-panel-map/v1",
  "tenantId": "<tenant uuid>",
  "panels": [{ "codePanel": "<legacy code_panel>", "panelId": "<NEXA RickPanel uuid>" }],
  "testPanels": ["<code>"],
  "missingPanels": ["<code searched by exact username across productionPanels>"],
  "productionPanels": ["<every NEXA RickPanel uuid a missing code_panel is searched across>"],
  "products": [{ "codeProduct": "<legacy code_product>", "productId": "<NEXA product uuid>" }]
}
```

`products` is the owner's explicit map from a legacy `code_product` to the NEXA product an
adopted service of that product renews as. It is never inferred: a live invoice naming a
legacy product that is not listed is `PRODUCT_MAPPING_UNRESOLVED` manual review. Every target
must be a product of this tenant before any run, and the map is part of the run's
fingerprint, so a resume under a different product map is refused. Productless, custom and
unknown-product invoices need no entry — they adopt as their shape's hidden legacy product.

```bash
sudo install -d -m 0700 /etc/nexa/legacy
# The api image runs as `node` (uid 1000, Dockerfile `USER node`): a root-owned 0600 file
# would be unreadable inside the container. Owned by 1000, mode 0600, directory root 0700.
sudo install -o 1000 -g 1000 -m 0600 <reviewed-panel-map.json> /etc/nexa/legacy/panel-map.json
```

**The target acknowledgement.** `nexa` is a production-like database name, so P7 refuses
every mode until `--allow-production-target` (in `p7`) AND `NEXA_LEGACY_IMPORT_TARGET_ACK`
are both present. The first call is refused (exit 64) and prints the acknowledgement for
THIS host, port, database and tenant. Read the refusal — it must name the production
database and this tenant — then export the value it printed:

```bash
p7 audit; echo "exit $?"                                # refused, exit 64; prints the ack
export NEXA_LEGACY_IMPORT_TARGET_ACK=<16-hex-from-the-refusal>
p7 audit | tee audit.txt; echo "exit ${PIPESTATUS[0]}"
```

The acknowledgement arms the guard for this database and tenant. **It is not the owner's
approval** — that is step 13, and nothing past step 12 runs without it.

Check: exit `0` with verdict `READY_FOR_DRY_RUN`, and the report's
`sections.provider.inventoryPageSize` is `200`. Exit `3` (`BLOCKED`: an incomplete
inventory, a currency other than IRT) stops the cutover here — never proceed on a partial
walk. A `TOTAL_CHANGED` blocker means the live panel changed during the walk: confirm the
MAINTENANCE incident's `stop_sales` is active (step 1), then re-run `p7 audit`
deliberately. A repeat with sales stopped is a finding (something else is writing to the
panel) to investigate, never a reason to proceed; and never lower the page size to "get
through" (a smaller page means a longer walk). Reports are captured on the host by `tee`; do not add `--out` inside the
container (it runs as uid 1000 and cannot write a root-owned host directory — exit 73,
`importer.md` §1.2). The fingerprint is printed and recorded; the plan's totals equal `legacy-source.tsv`;
provider writes 0. The audit's Item 1 evidence and its cross-checks (Q1b, Q2b, Q6, Q7
against the importer's own decisions) agree, or the disagreement is explained.

Then take the table inventory of the same copy, bound to the fingerprint the audit printed.
It is read-only on the copy and writes only its `legacy_read_set_runs` row
(`table-inventory.md`):

```bash
# Not through p7(): inventory takes no --panel-map and no --evidence-class.
sudo --preserve-env=LEGACY_SOURCE_DSN,NEXA_LEGACY_IMPORT_TARGET_ACK $DC run --rm --no-deps -T \
  -e LEGACY_SOURCE_DSN -e NEXA_LEGACY_IMPORT_TARGET_ACK \
  --entrypoint node api dist/legacy-import.cli.js inventory \
  --tenant "$NEXA_TENANT" --source env:LEGACY_SOURCE_DSN --target nexa --allow-production-target \
  --expected-fingerprint <audit source.fingerprint> | tee inventory.md
```

Check: every table is classified (verdict `COMPLETE`, exit 0). An `UNCLASSIFIED_TABLES`
verdict stops the cutover until a reviewed commit classifies the table. The freeze
statement it prints lists the same tables as `freeze-checksum-step7.tsv`.

## Step 11 — production dry-run

```bash
p7 dry-run | tee dry-run.txt; echo "exit ${PIPESTATUS[0]}"
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" \
  -v tenant="$NEXA_TENANT" -f - < <checkout>/scripts/legacy-rehearsal-checks.sql | tee nexa-after-dry-run.tsv
# Excluded: the dry run's own run row, and two figures the WORKER may move during any
# window (a reminder sweep, a notification) — expected noise, compared separately below.
NOISE='^(legacy_import_runs|customer_notifications|service_reminders)'
diff <(grep -Ev "$NOISE" nexa-PRE.tsv) <(grep -Ev "$NOISE" nexa-after-dry-run.tsv) \
  && echo "dry-run wrote no business row"
grep -E '^(customer_notifications|service_reminders)' nexa-PRE.tsv nexa-after-dry-run.tsv   # record the drift
```

Check: the diff is empty (a dry run decides and counts; only its own run row differs, and
the two worker-driven figures are recorded, not diffed — a dry run writes neither, so any
drift there is the worker's ordinary work); the
dry-run's counts by category and by manual-review reason are recorded for step 12–13.

## Step 12 — compare with staging

Put the production dry-run beside the last successful staging rehearsal (Item 11, its
`summary.json` and P7 report):

| figure                                   | staging rehearsal | production dry-run | difference explained by |
| ---------------------------------------- | ----------------- | ------------------ | ----------------------- |
| legacy users                             |                   |                    |                         |
| new / existing customers                 |                   |                    |                         |
| Σ legacy Balance; positive/zero/negative |                   |                    |                         |
| service candidates (live invoices)       |                   |                    |                         |
| adoptable                                |                   |                    |                         |
| manual review, per reason                |                   |                    |                         |
| hidden shapes new / reused / unresolved  |                   |                    |                         |
| trial decisions per branch               |                   |                    |                         |
| provider reads / writes                  |                   | — / 0              |                         |

Every difference must be explained by the data that changed between the staging dump and
the final dump (new users, new invoices, balance movement), in the same direction and of a
plausible size. An unexplained difference — a category that appears only in production, a
manual-review reason that jumps — stops the cutover here.

## Step 13 — OWNER APPROVAL GATE — STOP

**Nothing past this line runs without the Product Owner's explicit, written approval of
THIS run.** "Approved in principle" earlier is not approval of this run. The operator sends
the owner exactly this packet, aggregates only, and waits:

| The owner reviews                                                                                                                                                                                     | Where it comes from     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| the dry-run report: counts per customer, wallet, service, product and trial category                                                                                                                  | step 11, `dry-run.txt`  |
| the manual-review count, **per closed reason**, and what happens to those rows (they are NOT imported; their balances and services wait for resolution)                                               | step 11                 |
| the staging comparison and every explained difference                                                                                                                                                 | step 12                 |
| the pre-import backup id, its SHA-256, `verified`, and that the encrypted archive and Recovery Kit are off-host                                                                                       | step 6, `backup-id.txt` |
| the legacy freeze proof: `CHECKSUM TABLE` before and on the restored copy, dump SHA-256, the audit's source fingerprint (`source.fingerprint`) and panel-map fingerprint (`panelMapping.fingerprint`) | steps 7–10              |
| the release: version, commit, digest                                                                                                                                                                  | step 2                  |
| the readiness gate is green, with its evidence                                                                                                                                                        | `production-gate.md`    |
| the rollback plan, its trigger list and who decides                                                                                                                                                   | `rollback-runbook.md`   |
| the expected duration (from the staging rehearsal's `durations.tsv`) and the window remaining                                                                                                         | Item 11                 |

The approval is recorded in the report as: who, when (UTC), and the **backup id and source
fingerprint it names**. An approval that does not name both is not an approval of this run.
If the source fingerprint changes after approval (somebody re-dumped), approval is void.

## Step 14 — production import

Only after step 13. The import is bound to what the owner approved, technically
(`importer.md` §2.1): with `--expected-fingerprint` and `--expected-panel-map-fingerprint`,
import and resume compare the source snapshot and the panel map they actually read with the
approved values **before any write**, and refuse a mismatch with exit `65`. Against `nexa`
(production-like) P7 refuses an import without `--expected-fingerprint` (exit `64`).

```bash
export APPROVED_FINGERPRINT=<the source fingerprint named in the owner's approval>
export APPROVED_PANEL_MAP_FINGERPRINT=<the panel-map fingerprint named in the owner's approval>
export APPROVED_BACKUP_ID=<the backup id named in the owner's approval>
date -u +%FT%TZ | tee import-start.txt
p7 import --expected-fingerprint "$APPROVED_FINGERPRINT" \
  --expected-panel-map-fingerprint "$APPROVED_PANEL_MAP_FINGERPRINT" | tee import.txt; echo "exit ${PIPESTATUS[0]}"
date -u +%FT%TZ | tee import-end.txt
```

**After the import, before anything else — the approval check.** What ran must be what was
approved; a mismatch is a rollback trigger (T3), whatever the import's exit code:

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -v ON_ERROR_STOP=1 -c "
  SELECT r.source_fingerprint FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id
   WHERE t.slug = '$NEXA_TENANT' AND r.mode = 'APPLY' ORDER BY r.started_at DESC LIMIT 1" \
  | tee applied-fingerprint.txt
[ "$(cat applied-fingerprint.txt)" = "$APPROVED_FINGERPRINT" ] && echo "fingerprint = approved" \
  || echo "STOP: the imported source is not the approved one"
[ "$(awk '$1 == "backup" { print $2 }' backup-id.txt)" = "$APPROVED_BACKUP_ID" ] && echo "backup = approved" \
  || echo "STOP: the rollback point is not the approved backup"
```

Exit `0`: `COMPLETED`. Exit `65`: the source or the panel map is not the approved one —
**STOP**: nothing was written; the approval is void (cutover step 13), and nothing is
re-run against a different source without a new approval. Exit `4`: interrupted — `resume`
below. Exit `3`: read the verdict at the top of `import.txt`:

- **`COMPLETED_WITH_FAILURES` — STOP and decide, with the owner, before step 15.** The run
  finished but left money, a trial or a service undone; the report's `attention` section
  counts each kind: `customerSourceChanged`, `customerEntityMismatch`, `openingConflict`,
  `trialConflict`, `invoiceMapRefused`, `adoptionFailed` (`PROVIDER_READ_FAILED` —
  retried by `resume`), `adoptedSourceChanged`. Record the counts in the report. The owner
  decides between a `resume` (for retryable adoption failures), a documented follow-up for
  each counted row, or a rollback (trigger T1). It is never treated as a finished import.
- `COMPLETED_ADOPTION_PENDING_P6` — an importer built without P6: the wrong release; roll
  back.

**P6 adoption happens inside the import** for every `ADOPTION_ELIGIBLE` candidate: a
zero-total `NEW_SERVICE` + `LEGACY_ADOPTION` order and a service for the existing RickPanel
account, with its runtime state, usage and expiry from the same complete inventory walk, its
passed reminder thresholds seeded (nothing sent), and its subscription link read from the
panel's own list row. No provider write. Outcomes per candidate: `ADOPTED`,
`ALREADY_ADOPTED` (a rerun), `MANUAL_REVIEW` (a closed reason), `SKIPPED`, `FAILED`
(`PROVIDER_READ_FAILED`, retried by `resume` or a rerun) and `REVIEW_CLOSED` (a person closed
it in the review queue). `ADOPTION_PENDING_P6` appears only from an importer built without
P6 and is never a finished migration. **The link is a credential**: it is stored on the
service and appears in no report, audit row, event or map row — never paste one.

Progress, from a second terminal (read-only):

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c "
  SELECT r.id, r.status, r.rows_seen, r.rows_imported, r.rows_skipped, r.rows_manual_review,
         r.rows_failed, r.last_progress_at
    FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id
   WHERE t.slug = '$NEXA_TENANT' AND r.mode = 'APPLY' ORDER BY r.started_at DESC LIMIT 1"
```

**If the import is interrupted** (process killed, host restarted, connection lost): the
run stays `RUNNING`. Run `p7 resume --expected-fingerprint "$APPROVED_FINGERPRINT"
--expected-panel-map-fingerprint "$APPROVED_PANEL_MAP_FINGERPRINT"` — it continues the same run (same run id) for the
same source fingerprint and the same panel map and skips what was already imported (no duplicate
customer, opening, order, service or product; the map and the unique indexes enforce it).
Never start a second `import`; never edit run or map rows by hand. A resume that refuses
(`legacy_import.run_conflict`, fingerprint or mapping mismatch) is a stop-and-decide, usually
a rollback trigger. `p7 resume --abort-running` ends a stuck run as ABORTED; it is an owner
decision, normally followed by a rollback rather than a fresh import.

Check: the verdict is `COMPLETED` (not `COMPLETED_WITH_FAILURES`), the `APPLY` run is
`COMPLETED`, `rows_failed = 0`. Record the run id and duration. `reconcile` (next step)
requires a COMPLETED run and refuses a different panel map; `report` refuses a snapshot or
mapping the run was not made from.

## Step 15 — reconcile

```bash
p7 reconcile | tee reconcile.txt; echo "exit ${PIPESTATUS[0]}"   # 0 RECONCILED, 3 DISCREPANCY
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" \
  -v tenant="$NEXA_TENANT" -f - < <checkout>/scripts/legacy-rehearsal-checks.sql | tee nexa-POST.tsv
```

Then evaluate every equation in [`reconciliation.md`](reconciliation.md) (C1–C3, W1–W8,
R1–R3, S1–S5, P1–P4) with `nexa-PRE.tsv`, `nexa-POST.tsv` and `legacy-source.tsv`, and the
imported-balance join of §2. **Every one must hold exactly.** Any failure is a rollback
trigger to be decided now, before customers return (rollback runbook § Triggers).

## Step 16 — manual acceptance

Run [`manual-acceptance.md`](manual-acceptance.md) on production: every sample, one record
at a time, Legacy → decision → NEXA DB → Web Admin → Telegram → RickPanel read. A failed
sample is a rollback trigger unless it is a documented manual-review item.

## Step 17 — unfreeze

"Unfreeze" means **NEXA** returns to service. MirzaBot is never unfrozen for writes: its
database is now the archive, and a MirzaBot that took a payment after the import would be a
second wallet.

1. NEXA Web Admin: resolve the maintenance incident — sales and top-ups resume on every
   target it withdrew (`docs/incidents.md`).
2. The owner points customers at the NEXA bot (MirzaBot's last message, channel post).
   Old MirzaBot callbacks reaching NEXA keep their graceful stale behaviour (#174).
3. Keep the throwaway legacy source (`nexa-legacy-src`) until the final report is accepted;
   then remove it deliberately (`docker rm -f nexa-legacy-src && docker volume rm nexa-legacy-src`).
   The final dump and its checksum are kept as the archive.

```bash
date -u +%FT%TZ | tee unfreeze.txt
```

## Step 18 — observe

At T + 15 min, T + 1 h, T + 24 h (read-only):

```bash
sudo botctl status
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c "
  SELECT 'outbox_unpublished', count(*) FROM outbox_messages WHERE published_at IS NULL AND exhausted_at IS NULL
  UNION ALL SELECT 'outbox_exhausted', count(*) FROM outbox_messages WHERE exhausted_at IS NOT NULL
  UNION ALL SELECT 'customer_notifications_pending', count(*) FROM customer_notifications WHERE state = 'PENDING'
  UNION ALL SELECT 'customer_notifications_since_unfreeze', count(*) FROM customer_notifications
             WHERE created_at >= '<unfreeze time from unfreeze.txt>'
  UNION ALL SELECT 'ops_events_open', count(*) FROM operational_events WHERE resolved_at IS NULL
  UNION ALL SELECT 'payments_since_unfreeze', count(*) FROM payments
             WHERE created_at >= '<unfreeze time from unfreeze.txt>'
  UNION ALL SELECT 'provisioning_ops_since_unfreeze', count(*) FROM provisioning_operations
             WHERE created_at >= '<unfreeze time from unfreeze.txt>'"
```

What to look for:

- **queues**: the outbox drains; nothing newly exhausted;
- **reminders**: after the first reminder sweep, customer notifications since unfreeze look
  like an ordinary day's volume, not a burst — adopted services had their passed thresholds
  seeded (Item 8). A burst is an incident: switch the reminder feature flags off, then
  investigate;
- **errors**: no new open operational event caused by the import; `botctl logs` free of
  repeated errors;
- **payments**: new payments arrive and settle as before;
- **services**: adopted services render in the bot and the Web Admin; renewals of adopted
  services quote the CURRENT tariff (never the legacy `price_product`); provisioning
  operations since unfreeze are only the ones customers and operators asked for.

## Step 19 — final report

Fill [`final-report-template.md`](final-report-template.md) and attach P7's machine-readable
report (validated against [`final-report.schema.json`](final-report.schema.json)):

```bash
p7 report --format json > final-report.json; echo "exit ${PIPESTATUS[0]}"   # 3 = an equation failed
node <checkout>/scripts/legacy-rehearsal-report-check.mjs validate \
  <checkout>/docs/legacy-migration/final-report.schema.json final-report.json && echo "schema-valid"
```

The report is aggregates only. Its `evidenceClass` is `production` (the `--evidence-class`
P7 was given and checked against the source); its `reconciliation` array holds P7's own C1,
C3, W1, W4, W5, S3 and P3.

### The review queue, after the import (terminal only)

Rows the import routed to manual review are worked from the review subcommand. It prints
legacy ids — a `user` row's id IS a Telegram id — so it writes to the terminal only (`--out`
and `--format` are refused): **never paste its `list` output** into a ticket, chat or the
report. Counts are aggregates and may be reported.

```bash
p7r() {   # the review subcommand: same target and guard, no source, no panel map
  sudo --preserve-env=NEXA_LEGACY_IMPORT_TARGET_ACK $DC run --rm --no-deps -T \
    -e NEXA_LEGACY_IMPORT_TARGET_ACK --entrypoint node api dist/legacy-import.cli.js review "$1" \
    --tenant "$NEXA_TENANT" --target nexa --allow-production-target "${@:2}"
}
p7r counts                                       # aggregates, by table and reason
p7r list --table invoice --reason PROVIDER_MISSING --state OPEN --limit 50   # terminal only
p7r resolve --table invoice --legacy-id <ID> --expected-reason <REASON> \
    --resolution <RETRY_AFTER_FIX|HANDLED_OUTSIDE_IMPORT|WILL_NOT_IMPORT|TEST_OR_INVALID_DATA|DUPLICATE_RECORD>
p7r reopen --table invoice --legacy-id <ID>
```

`RETRY_AFTER_FIX` invites the next `import`/`resume` to decide the row again (after the
mapping or the panel is fixed); every other resolution closes it: the importer then counts
it `REVIEW_CLOSED` and never retries or overwrites it. Verify the subcommand's flags against
`docs/legacy-migration/importer.md` § Review subcommand before use.
