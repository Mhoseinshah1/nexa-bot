# Legacy migration — staging rehearsal (Item 11)

**Status: harness aligned with the P7 CLI as built (`importer.md`); no staging rehearsal
has run.** No staging server, real legacy dump or RickPanel credentials exist here, so no
staging rehearsal result exists anywhere in this repository. Synthetic runs exercise the
harness and P7's code only; the ones run for WP-D1–D8 are listed, labelled synthetic, in
[`readiness-record.md`](readiness-record.md) § Synthetic evidence — never as a result here.

`scripts/legacy-rehearsal.sh` runs the whole migration against copies, times it, checks it
and rolls it back:

```
legacy dump or backup_*.zip ──► scripts/legacy-archive-inspect.mjs (blockers stop here)
            ──► throwaway MariaDB or MySQL 8.0 (started by the script, 127.0.0.1, SELECT-only reader)
NEXA backup ──► nexa_rehearsal_<stamp> (real `backup restore`, then migrate forward)
                  │ or: fresh migrate + provision --tenant
                  ▼
per cycle:  PRE snapshot + pg_dump ─► P7 audit ─► P7 dry-run ─► (no business row changed?)
            ─► P7 import, kill -9 once the run has checkpointed N rows ─► (run left RUNNING?)
            ─► P7 resume (same run id) ─► P7 reconcile ─► P7 report --format json
            ─► the report: schema-valid? evidence class right? P7's own equations?
            ─► POST snapshot ─► reconciliation checks (C, W, R, S, P of reconciliation.md)
            ─► rollback: restore PRE into a candidate, validate, two renames, keep displaced
            ─► restored = PRE exactly?
cycle 2:    the same from the clean restore; its POST must equal cycle 1's
once (cycle 9, Mirza PR6), from the clean restore:
  snapshot A (as loaded): audit ─► inventory ─► products-read (digest, approve, ingest)
            ─► invoices-read (digest, approve, ingest) ─► gated import refused
               (TABLES_UNCLASSIFIED on the fixture) ─► the historical import, ungated
  snapshot B (newer, made from A on the throwaway engine): freeze proof ─► "dump" ─►
            "restore" ─► PR1's freeze checker EQUAL ─► audit, inventory (COMPLETE), reads
            ─► gated import refused APPROVAL_MISSING ─► owner approval (synthetic)
            ─► refused SOURCE_SUPERSEDED ─► re-run acknowledgement ─► gated import:
               one new customer, one new opening, nothing else ─► again: nothing
            ─► reconcile RECONCILED ─► report v2 (schema-valid, holds) ─► stop sales
            ─► cutover-gate CUTOVER_READY ─► with a wrong dump digest, and with an
               edited dump file under the approved digest: REFUSED (FINAL_DUMP_VERIFIED)
```

## Run it

Locally, on the synthetic fixture (proves code and harness; **never evidence**):

```bash
pnpm build
scripts/legacy-rehearsal.sh \
  --evidence-class synthetic \
  --legacy-dump tests/fixtures/legacy/synthetic-legacy.sql \
  --tenant rehearsal \
  --synthetic-panels \
  --nexa-env <a shell-sourceable env file: SECRETS_KEYS, REDIS_URL, …> \
  --pg-url postgres://nexa@127.0.0.1:5432 \
  --fresh-migrate \
  --out /tmp/rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
```

Or, asserted (WP-D6) — the same synthetic rehearsal through the fixture's AES-256 zip, then
`scripts/legacy-rehearsal-synthetic-assert.mjs`, which requires 0 FAIL and EXACTLY the
fixture's known PENDING checks in every cycle (one more PENDING is a regression as much as
one FAIL):

```bash
PGPASSWORD=… pnpm rehearsal:synthetic [--engine mariadb|mysql8] [--mysql-bin-dir DIR] [--out DIR]
```

CI runs exactly that on MySQL 8.0 in the job `legacy-rehearsal` (about two minutes; part
of the `test` gate), and keeps `summary.json`, `checks.tsv`, `durations.tsv`,
`reconciliation.md`, `archive.json` and the logs as an artifact. The known PENDING checks
are the fixture's deliberate owner-decision cases: `invoice_keys_outside_evidenced_shape`
(S2, OQ-P4-01), `report_equation_C3` (a user id that is not a Telegram id) and
`legacy_balance_fractional_users` (W8) — 3 per cycle.

`--synthetic-panels` (synthetic only) runs `tests/support/legacy-rehearsal-synthetic-panels.ts`:
it stands up the two fake RickPanels the fixture assumes on 127.0.0.2/3, registers them in
the rehearsal database through the ordinary panel write path and the operator's connection
test, adds the public 30 GB / 30 d tariff the fixture's shapes resolve to, writes the panel
map, and on stop reports every request the fakes received after setup — so "provider
writes = 0" is also checked on the wire (`wire_provider_writes_zero`). Loopback panel
addresses are allowed for that run only.

On a staging host (isolated PostgreSQL 16, and MySQL 8.0 or MariaDB binaries for the
throwaway legacy engine; never the installation's own database — the script refuses the
compose service names and any URL naming a database):

(For a plain dump, replace the two `--legacy-archive*` flags with
`--legacy-dump <fresh oldbot dump, .sql or .sql.gz>`.)

```bash
export LEGACY_ZIP_PASSWORD=…   # only for a MirzaBot zip; typed into the environment, never argv
scripts/legacy-rehearsal.sh \
  --evidence-class staging \
  --legacy-archive <MirzaBot backup_YYYY-MM-DD.zip> --legacy-archive-password-env LEGACY_ZIP_PASSWORD \
  --legacy-engine mysql8 [--mysql-bin-dir <dir with MySQL 8.0 mysqld, mysql, mysqladmin>] \
  --tenant <tenant-slug> \
  --panel-map <the reviewed panel-map.json> \
  --nexa-env <staging config with the production keyring able to open the archive> \
  --pg-url postgres://<user>@127.0.0.1:5432 \
  --nexa-archive <fresh production-like .nxb> \
  --installed-host-is-not-production \
  --out <results dir>
```

`--pg-url` carries no password — one is refused, because argv is readable by every local
user. Put it in `PGPASSWORD` or a `PGPASSFILE`; psql, pg_dump, pg_restore and the NEXA CLIs
(node-postgres) all read them. The throwaway MariaDB's passwords are generated, kept in 0600
files and fed to `mariadb` on stdin, never as `-e` arguments.

On INT/TERM the harness stops the running stage's whole process group (each stage runs in
its own) before its cleanup, so no importer or helper is left running.

### The legacy input and engine (WP-D1a/D1b)

Before the throwaway engine is even started, `scripts/legacy-archive-inspect.mjs` inspects
the input (`--legacy-dump` or `--legacy-archive`, exactly one) with
`--engine <the --legacy-engine> --require-class <the evidence class>`. A blocker stops the
rehearsal with its code: a dump that is truncated, lacks `user`/`invoice`/`product` or a
required column, carries a stored object, selects another database than `--legacy-schema`,
or needs another engine (`COLLATION_REQUIRES_MYSQL8`, `ENGINE_MISMATCH`). A zip is decrypted
into the harness's private scratch directory — removed on exit with the engine's data, never
under `--out` — and its report is kept as `archive.json` (hashes and shapes, no row
content). `summary.json` records `legacyArchiveSha256` (the file as given),
`legacyDumpSha256` (the inner dump: for a `.sql` they are equal; for a `.sql.gz` or a zip
they are not), `legacyEngine` and `legacyInput`.

`--legacy-engine mysql8` starts MySQL's own `mysqld` 8.0 (`--initialize-insecure` on a
scratch data directory, `--mysqlx=OFF`, `--secure-file-priv=NULL`, bound to 127.0.0.1);
`mysqld --version` must say `Ver 8.0.x` and not MariaDB — on many hosts `mysqld` is a
MariaDB symlink, so pass `--mysql-bin-dir`. MirzaBot's tables declare no collation, so a
MySQL 8 dump carries `utf8mb4_0900_ai_ci`, which MariaDB does not have: such a dump is
refused on `mariadb`, never rewritten.

`--check-only` runs every guard and prints the plan without touching anything. `--help`
lists the rest (`--cycles`, `--kill-after-rows`, `--importer-arg`, `--keep-legacy-copy`).

### How it calls P7

```
node apps/api/dist/legacy-import.cli.js MODE --tenant T \
  --source mysql://legacy_ro@127.0.0.1:<port>/<schema> \
  --source-password-env NEXA_REHEARSAL_LEGACY_PASSWORD \
  --target nexa_rehearsal_<stamp> --panel-map <file> --evidence-class <class>
```

The password is set in that variable for the one child process (P7 refuses one on argv).
Import and resume also get `--expected-fingerprint` and `--expected-panel-map-fingerprint`
with the values of the cycle's own `audit --format json` (`source.fingerprint`,
`panelMapping.fingerprint`), so the approved-source binding is exercised on every run; a
P7 whose `--help` lacks either flag is refused. P7's stderr goes to
`logs/c<N>-<stage>.stderr.log`, apart from the JSON documents on stdout.
`--evidence-class` is the harness's own class, passed to every mode (P7 requires it for
import, resume and report and checks it against the source). The target is the bare
database name, equal to the `DATABASE_URL` the harness sets; its
`rehearsal` token keeps P7's production guard from refusing it, and the harness never
passes `--allow-production-target`.

### The migration program (Mirza PR6): cycle 9

After its cycles the harness runs the whole program once, recorded as cycle 9 in
`checks.tsv` (diagram above). It keeps `final-report-v2.json` and `cutover-gate.json` under
`--out`. The cycles' own report checks read version 1 (`--report-schema 1`); cycle 9 reads
version 2.

- **Snapshot A** is the loaded dump as it is. On the synthetic fixture its inventory is
  `UNCLASSIFIED_TABLES` (`nexa_synthetic_unclassified`, deliberately), so the gated import of
  A is refused `TABLES_UNCLASSIFIED` with nothing written, and A is imported the staging way.
- **Snapshot B** is a NEWER snapshot the harness makes from A on its own throwaway engine:
  the unclassified table removed (as a reviewed classification would make it COMPLETE), the
  non-Telegram id gone, one user, one product and one archived (not live) invoice added. Its
  "final dump" is a stand-in — a byte-exact TSV export of every table, because the CI's MySQL
  client packages carry no dump binary — and its "restore" a table-by-table copy into a third
  schema; PR1's checker must find the frozen and restored proofs EQUAL. The owner's approvals
  are recorded by `tests/support/legacy-rehearsal-cutover-approval.ts` as the rehearsal's
  synthetic owner, through the service the Web Admin uses (it refuses any database that is
  not a rehearsal's).
- A changed existing balance is deliberately NOT part of B: a re-run never applies a balance
  delta (OQ-LWD-02), so it leaves a SOURCE_CHANGED user the owner must decide, which is
  pinned by the integration suites (PR4's `legacy-wallet-debts`, PR6's `legacy-cutover`), not
  by a rehearsal that must end CUTOVER_READY.
- **On staging** (`--evidence-class staging`) cycle 9 stops after A's reads: the inventory
  verdict is recorded (PENDING unless COMPLETE) and the owner's approval is PENDING — it is a
  person's act in the Web Admin, never the harness's. **NOT RUN on real data.**

### The table inventory by hand

Against the rehearsal's restored legacy copy, after the cycle's `audit`, the operator can
also run it by hand, with the same source and target the harness uses and the cycle's own
`source.fingerprint`:

```
NEXA_REHEARSAL_LEGACY_PASSWORD=… node apps/api/dist/legacy-import.cli.js inventory --tenant T \
  --source mysql://legacy_ro@127.0.0.1:<port>/<schema> \
  --source-password-env NEXA_REHEARSAL_LEGACY_PASSWORD \
  --target nexa_rehearsal_<stamp> --expected-fingerprint <audit source.fingerprint> > inventory.md
```

It is read-only on the legacy copy. On the target it writes only the
`legacy_read_set_runs` row for the bound observation. Exit 0 means every table is classified
(`COMPLETE`). Exit 3 means at least one table is not, or the run is unbound; the synthetic
fixture is deliberately in that state, with `nexa_synthetic_unclassified`. Exit 65 means
the copy is not the audited source.

Copy the table into `table-inventory.md`, and open an `OQ-MZ-INV` entry for every
UNCLASSIFIED table. The freeze statement it prints is the one
`scripts/legacy-freeze-checksum.sql` runs, and the cutover compares it at steps 7 and 9
with `scripts/legacy-freeze-checksum-verify.sh`, which refuses an empty or partial output
file (a failed client) instead of letting two of them compare equal.
**NOT RUN on real data.**

### Exit codes

P7: `0` done; `3` done but a person must decide; `4` interrupted; `64`/`65` refused; `73`
report computed but its `--out` not written (the harness captures stdout and passes no P7
`--out`); `1` other. The harness accepts `0` and `3` from P7 and records every `3` as a **PENDING**
check; anything else stops it.

The harness itself: **`0`** every check PASSED; **`3`** nothing FAILED but some checks are
PENDING — the import is done and waits on a person (user ids that are not Telegram ids,
live invoices whose key is outside the evidenced shape; `ADOPTION_PENDING_P6` only from an
importer built without P6). That is reported as
`DONE_PENDING_DECISIONS (not passed)` and is **never** a passed rehearsal; **`1`** a check
failed or a stage broke.

The restored NEXA copy is real customer data and holds real panel credentials: P7 reads
RickPanel through them (read-only — the importer holds only the inventory surface of #169).
P7 walks each panel with **200-row pages** unless `--importer-arg --inventory-page-size --importer-arg N`
says otherwise — leave it at the default for a real rehearsal: the real Mirza rehearsal
was BLOCKED (`TOTAL_CHANGED`, ~500 reads) at the old 50-row default and READY at 200 (~130
reads); `importer.md` §1.1.
The harness never runs the worker, so nothing is delivered from the copy; it also never
runs `backup run` on it, because a restored database's operations group would receive the
archive.

## What it refuses

Before anything is touched: a missing `--evidence-class`; a dump under `tests/fixtures/`
called `staging`; `NODE_ENV=production`; a PostgreSQL host named `postgres`/`redis` (an
installation's own network) or any non-loopback host not named by `--allow-pg-host`; a
server URL that names a database; an importer argument containing "production"; a host with
`/etc/nexa/deploy.env` unless `--installed-host-is-not-production`; an existing `--out`.
Then: an absent P7 CLI or one whose `--help` lacks a mode. The legacy side is always a
MariaDB the script started — there is no flag to aim it at an existing server — and every
database it creates or renames is asserted to be `nexa_rehearsal_<stamp>[_suffix]`. It drops
nothing; it prints the databases it left for a human to remove.

Pinned by `tests/unit/legacy-rehearsal-guards.test.ts`.

## What it records (`--out`)

| file                                 | what                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `summary.json`                       | evidence class (and `notEvidence: true` for synthetic), verdict, every check, every duration; `pendingDecisions[]` (below) |
| `checks.tsv`                         | cycle, check, PASS/FAIL/PENDING, expected, actual                                                                          |
| `durations.tsv`                      | cycle, stage, seconds, exit, load average before/after                                                                     |
| `snapshots/*.tsv`                    | the NEXA and legacy aggregate snapshots (the reconciliation inputs)                                                        |
| `snapshots/c<N>-pre-import.pgcustom` | the pre-import `pg_dump` the rollback restores (customer data: 0600)                                                       |
| `c<N>-report.json`                   | P7's machine-readable report, and `c<N>-report.schema-violations.txt` (empty when valid)                                   |
| `synthetic-panel-requests.json`      | synthetic only: requests the fake panels received after setup                                                              |
| `reconciliation.md`                  | the reconciliation result table, generated from the checks (WP-D5)                                                         |
| `archive.json`                       | the archive inspector's report: both sha256 values, format, engine, collations, blockers                                   |
| `snapshots/c<N>-tables-*.tsv`        | the exact per-table fingerprints (rows and row hashes) the rollback checks compare (WP-D8)                                 |
| `snapshots/c<N>-panel-state-*.json`  | P4: per production panel, account count and hashes; per-account digests under a deleted key                                |
| `logs/`                              | one log per stage                                                                                                          |

`summary.json.pendingDecisions[]` lists every PENDING check as `{cycle, check, expected,
actual, decision: null, decidedBy: null, decidedAt: null}` — the shape G11 accepts one by
name (`production-gate.md`, `readiness-record.md`). The harness never fills a decision; a
run whose PENDING checks have not each been accepted by the owner is not a passed
rehearsal.

The checks, by name: `dry_run_no_business_mutation`, `interrupted_run_left_running`,
`no_run_left_running`, `one_apply_run_resumed`, `apply_run_completed`,
`source_fingerprint_stable`, `apply_fingerprint_equals_audit`, `apply_verdict` (only
`COMPLETED` passes; `COMPLETED_WITH_FAILURES` FAILS with the report's `attention` counts),
`customer_closure`,
`interrupted_import_stopped_writing`, `blocked_equals_invalid_ids`,
`report_candidates_equal_source`, `service_closure_map_plus_invalid_keys`,
`invoice_keys_outside_evidenced_shape` (PENDING), `adopted_equals_eligible`,
`adopted_services_appeared`, `adoption_orders_shape`, `reminder_seed_sent_no_messages`,
`adopted_services_link_stored`, `link_never_in_artifacts`,
`link_never_in_audit_outbox_events`, `report_schema_valid`,
`report_evidence_class`, `report_provider_writes_zero`, `report_run_is_this_run`,
`report_resumes_counted`, `report_equation_{C1,C3,W1,W4,W5,S3,P3}` (C3 false is PENDING: an
owner decision about ids that are not Telegram ids), `wire_provider_writes_zero`,
`wallet_moved_only_by_openings`, `wallet_entries_only_openings`, `no_duplicate_openings`,
`opening_reference_matches_customer`, `opening_links_no_money`,
`wallet_equation_imported_balance`, `openings_one_per_nonzero_user`, `unchanged_*` (sales,
revenue, payments, top-ups), `adoption_orders_zero_total`, `one_service_per_adoption`,
`provider_writes_zero`, `adopted_services_without_operations`, `no_customer_messages`,
`rollback_restores_pre_import`, `repeat_reproduces_cycle_1`, `panel_map_complete` (G10:
every live real `code_panel` accounted for, WP-D2), `panel_state_unchanged` and
`panel_state_walk_reads_only` (P4: the production panels walked read-only before the audit
and after the resume, WP-D4), `customers_created_le_imported` (C2),
`fractional_balances_never_imported` and `legacy_balance_{fractional,null}_users` (W8; the
latter PENDING when non-zero), `revenue_view_standard_unchanged`,
`revenue_view_adoption_zero`, `wallet_window_openings_only` (R3, machine half),
`orphans_in_customer_missing` (S4), `no_trial_grants` (WP-D5),
`rollback_restores_pre_import_exact`, `rollback_displaced_exists`,
`rollback_displaced_preserved` (WP-D8). Each maps to an equation in
[`reconciliation.md`](reconciliation.md).

## What it does not cover

- The **Web Admin recovery lane**: the harness rehearses the database mechanism (candidate,
  validate, two renames, displaced kept); the lane itself is rehearsed by hand on staging
  (`rollback-runbook.md` § Rehearse it, gate G13).
- **Telegram and RickPanel UI checks**: `manual-acceptance.md`.
- **Real-data evidence** from a synthetic run: none, ever.

## What a synthetic run proves about P6

With `--synthetic-panels`, two of the fake accounts sit past reminder thresholds (one
expires in two days, one has used 29 of its 30 GB), so the adoption's reminder seed has
something to seed. The P6 checks: `adopted_equals_eligible` (P7's dry-run
`ADOPTION_ELIGIBLE` = the report's `services.adopted`), `adopted_services_appeared`,
`adoption_orders_shape` (NEW_SERVICE, LEGACY_ADOPTION, PAID, zero totals) with the
`unchanged_sale_*` checks proving revenue did not move, `reminder_seed_sent_no_messages`,
`adopted_services_link_stored`, `link_never_in_artifacts` (no file this rehearsal wrote
contains any adopted service's link — the links go from psql to grep on a pipe) and
`link_never_in_audit_outbox_events`. All of it is code-level proof; none of it is evidence
about RickPanel or the legacy archive.
