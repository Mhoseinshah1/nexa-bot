# Legacy migration — staging rehearsal (Item 11)

**Status: harness written; no rehearsal has run.** The P7 importer CLI and its synthetic
fixture were being built when this was written; until they land, the harness stops with a
precise message naming the missing CLI. No staging server, real legacy dump or RickPanel
credentials exist here, so no staging rehearsal result exists anywhere in this repository.

`scripts/legacy-rehearsal.sh` runs the whole migration against copies, times it, checks it
and rolls it back:

```
legacy dump ──► throwaway MariaDB (started by the script, 127.0.0.1, SELECT-only reader)
NEXA backup ──► nexa_rehearsal_<stamp> (real `backup restore`, then migrate forward)
                  │ or: fresh migrate + provision --tenant
                  ▼
per cycle:  PRE snapshot + pg_dump ─► P7 audit ─► P7 dry-run ─► (no business row changed?)
            ─► P7 import, kill -9 once the run has checkpointed N rows ─► (run left RUNNING?)
            ─► P7 resume ─► P7 reconcile ─► P7 report (provider.writes = 0?)
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
  --legacy-dump tests/fixtures/legacy/<fixture dump written by the IMPORTER> \
  --tenant rehearsal \
  --panel-map tests/fixtures/legacy/<fixture panel map> \
  --nexa-env <a shell-sourceable env file: SECRETS_KEYS, REDIS_URL, …> \
  --pg-url postgres://nexa:nexa@127.0.0.1:5432 \
  --fresh-migrate \
  --out /tmp/rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
```

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

| file                                 | what                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `summary.json`                       | evidence class (and `notEvidence: true` for synthetic), every check, every duration |
| `checks.tsv`                         | cycle, check, PASS/FAIL, expected, actual                                           |
| `durations.tsv`                      | cycle, stage, seconds, exit, load average before/after                              |
| `snapshots/*.tsv`                    | the NEXA and legacy aggregate snapshots (the reconciliation inputs)                 |
| `snapshots/c<N>-pre-import.pgcustom` | the pre-import `pg_dump` the rollback restores (customer data: 0600)                |
| `c<N>-report.json`                   | P7's machine-readable report                                                        |
| `logs/`                              | one log per stage                                                                   |

The checks, by name: `dry_run_no_business_mutation`, `interrupted_run_left_running`,
`no_run_left_running`, `one_apply_run_resumed`, `apply_run_completed`,
`source_fingerprint_stable`, `customer_closure`, `service_candidate_closure`,
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

## Reconciling with P7

Every assumption about the P7 CLI is in the "P7 CLI contract" block at the top of the
script, overridable by environment (`LEGACY_IMPORT_CLI`, `P7_FLAG_*`, `P7_REPORT_ARGS`). When
the importer lands, compare with its `--help`, correct that block and the table in
`cutover-runbook.md` in one reviewed commit.
