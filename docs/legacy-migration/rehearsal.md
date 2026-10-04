# Legacy migration — staging rehearsal (Item 11)

**Status: harness aligned with the P7 CLI as built (`importer.md`); no staging rehearsal
has run.** No staging server, real legacy dump or RickPanel credentials exist here, so no
staging rehearsal result exists anywhere in this repository. Synthetic runs exercise the
harness and P7's code only and are never recorded here as results.

`scripts/legacy-rehearsal.sh` runs the whole migration against copies, times it, checks it
and rolls it back:

```
legacy dump ──► throwaway MariaDB (started by the script, 127.0.0.1, SELECT-only reader)
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
  --pg-url postgres://nexa:nexa@127.0.0.1:5432 \
  --fresh-migrate \
  --out /tmp/rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
```

`--synthetic-panels` (synthetic only) runs `tests/support/legacy-rehearsal-synthetic-panels.ts`:
it stands up the two fake RickPanels the fixture assumes on 127.0.0.2/3, registers them in
the rehearsal database through the ordinary panel write path and the operator's connection
test, adds the public 30 GB / 30 d tariff the fixture's shapes resolve to, writes the panel
map, and on stop reports every request the fakes received after setup — so "provider
writes = 0" is also checked on the wire (`wire_provider_writes_zero`). Loopback panel
addresses are allowed for that run only.

On a staging host (isolated PostgreSQL 16 and MariaDB; never the installation's own
database — the script refuses the compose service names and any URL naming a database):

```bash
scripts/legacy-rehearsal.sh \
  --evidence-class staging \
  --legacy-dump <fresh oldbot dump, .sql or .sql.gz> \
  --tenant <tenant-slug> \
  --panel-map <the reviewed panel-map.json> \
  --nexa-env <staging config with the production keyring able to open the archive> \
  --pg-url postgres://<user>:<pass>@127.0.0.1:5432 \
  --nexa-archive <fresh production-like .nxb> \
  --installed-host-is-not-production \
  --out <results dir>
```

`--check-only` runs every guard and prints the plan without touching anything. `--help`
lists the rest (`--cycles`, `--kill-after-rows`, `--importer-arg`, `--keep-legacy-copy`).

### How it calls P7

```
node apps/api/dist/legacy-import.cli.js MODE --tenant T \
  --source mysql://legacy_ro@127.0.0.1:<port>/<schema> \
  --source-password-env NEXA_REHEARSAL_LEGACY_PASSWORD \
  --target nexa_rehearsal_<stamp> --panel-map <file>
```

The password is set in that variable for the one child process (P7 refuses one on argv).
The target is the bare database name, equal to the `DATABASE_URL` the harness sets; its
`rehearsal` token keeps P7's production guard from refusing it, and the harness never
passes `--allow-production-target`.

### Exit codes

P7: `0` done; `3` done but a person must decide; `4` interrupted; `64`/`65` refused; `1`
other. The harness accepts `0` and `3` from P7 and records every `3` as a **PENDING**
check; anything else stops it.

The harness itself: **`0`** every check PASSED; **`3`** nothing FAILED but some checks are
PENDING — the import is done and waits on a person (eligible services
`ADOPTION_PENDING_P6` until P6 is wired, user ids that are not Telegram ids, invoice
decisions P7 counts but cannot record yet). That is reported as
`DONE_PENDING_DECISIONS (not passed)` and is **never** a passed rehearsal; **`1`** a check
failed or a stage broke.

The restored NEXA copy is real customer data and holds real panel credentials: P7 reads
RickPanel through them (read-only — the importer holds only the inventory surface of #169).
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

| file                                 | what                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `summary.json`                       | evidence class (and `notEvidence: true` for synthetic), verdict, every check, every duration |
| `checks.tsv`                         | cycle, check, PASS/FAIL/PENDING, expected, actual                                            |
| `durations.tsv`                      | cycle, stage, seconds, exit, load average before/after                                       |
| `snapshots/*.tsv`                    | the NEXA and legacy aggregate snapshots (the reconciliation inputs)                          |
| `snapshots/c<N>-pre-import.pgcustom` | the pre-import `pg_dump` the rollback restores (customer data: 0600)                         |
| `c<N>-report.json`                   | P7's machine-readable report, and `c<N>-report.schema-violations.txt` (empty when valid)     |
| `synthetic-panel-requests.json`      | synthetic only: requests the fake panels received after setup                                |
| `logs/`                              | one log per stage                                                                            |

The checks, by name: `dry_run_no_business_mutation`, `interrupted_run_left_running`,
`no_run_left_running`, `one_apply_run_resumed`, `apply_run_completed`,
`source_fingerprint_stable`, `customer_closure`, `service_candidate_closure`,
`interrupted_import_stopped_writing`, `blocked_equals_invalid_ids`,
`report_candidates_equal_source`, `service_map_rows` (PENDING while P7 counts decisions it
cannot record yet), `adoption_pending_p6` (PENDING), `report_schema_valid`,
`report_evidence_class`, `report_provider_writes_zero`, `report_run_is_this_run`,
`report_resumes_counted`, `report_equation_{C1,C3,W1,W4,W5,S3,P3}` (C3 false is PENDING: an
owner decision about ids that are not Telegram ids), `wire_provider_writes_zero`,
`wallet_moved_only_by_openings`, `wallet_entries_only_openings`, `no_duplicate_openings`,
`opening_reference_matches_customer`, `opening_links_no_money`,
`wallet_equation_imported_balance`, `openings_one_per_nonzero_user`, `unchanged_*` (sales,
revenue, payments, top-ups), `adoption_orders_zero_total`, `one_service_per_adoption`,
`provider_writes_zero`, `adopted_services_without_operations`, `no_customer_messages`,
`rollback_restores_pre_import`, `repeat_reproduces_cycle_1`. Each maps to an equation in
[`reconciliation.md`](reconciliation.md).

## What it does not cover

- The **Web Admin recovery lane**: the harness rehearses the database mechanism (candidate,
  validate, two renames, displaced kept); the lane itself is rehearsed by hand on staging
  (`rollback-runbook.md` § Rehearse it, gate G13).
- **Telegram and RickPanel UI checks**: `manual-acceptance.md`.
- **Real-data evidence** from a synthetic run: none, ever.

## Known: the report's evidence class for a SQL-loaded synthetic dump

P7 classes its report `synthetic` only for a `fixture:` source; for a MariaDB source it
reports the target's class (`staging` for a rehearsal database). Loaded from the synthetic
SQL fixture, the harness's run is synthetic all the same, so `report_evidence_class` FAILS
on every synthetic run until P7 can be told the class. That failure is deliberate: a
document that calls synthetic data `staging` must not pass.
