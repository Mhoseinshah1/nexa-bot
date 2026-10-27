# R11 A2 — cutover rehearsal: the MirzaBot → Nexa runbook against a disposable database

## What changed

### `pnpm cutover-rehearse` / `sudo botctl cutover rehearse` (new)

One command that runs the cutover runbook's data steps (`docs/cutover/`) end to end against a
**new, disposable database** on the installation's own PostgreSQL server, and prints the
reconciliation report (wallet balances, services, reseller credit — Mirza package vs Nexa after
the import, totals and mismatches) and a go/no-go. It builds on what exists rather than beside
it: the import runs through the restore page's own `LegacyMigrationService` and the container's
own `migrationExecutor`; the balance half is `cutover-reconcile`'s `reconcileCutover` and
`readMirzaSide`; the panels are the rehearsal kit's own `deploy/rehearsal/rickpanel-standin.mjs`
(imported, not copied; it ships in the image under `/app/deploy`).

`apps/api/src/cutover-rehearse.cli.ts` (the command, args, target rules, the run, the report) and
`apps/api/src/cutover-rehearse-import.ts` (stand-ins, the import as the owner drives it, the
read-only counts). Steps, printed one line each (PASS/FAIL/SKIP, runbook page, detail):

| Step               | Runbook        | What                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`           | 02 (equiv.)    | Refusals before anything is created (exit 65): a production-like name (`cutover-reconcile`'s `classifyTarget` rule); **the database `DATABASE_URL` names, whatever word it carries**; `postgres`/`template*`; a database that **already exists** (never reused, emptied or dropped by a run that did not create it).                      |
| `messaging`        | 02 (equiv.)    | The run loads its config with `REHEARSAL_FORCED_SETTINGS` over the live env: notification dispatch, webhook, backup Telegram delivery, backup schedule, provisioner, monitor, recovery upload OFF; legacy migration ON; backup/recovery/migration work dirs under its private dir. `messagingProblems` must be empty.                     |
| (guard)            | 02 (equiv.)    | `RehearsalOutboundGuard` replaces `globalThis.fetch` for the run: every fetch refused (TypeError) and counted, Telegram apart. Telegram is reached only through fetch.                                                                                                                                                                    |
| `package`          | 03 E2          | SHA-256 of the package (= the dry run's `finalDumpSha256`); `package-unchanged` re-hashes at the end.                                                                                                                                                                                                                                     |
| `database`         | 01 / 04 I2     | `CREATE DATABASE` via the server's `postgres` maintenance DB, `runMigrations`, `checkMigrations` = `current`.                                                                                                                                                                                                                             |
| `fresh-target`     | 04 I2          | `provisionInstallation` (PRIMARY tenant `cutover-rehearsal`, IRT, Asia/Tehran), `resolveInstallationTenant`, the owner through `BootstrapOwnerService` (operator's `--owner-telegram-id`, random password never printed), then customers / wallet entries / payments / orders / bot instances = 0.                                        |
| `verify`           | 04 I3          | `beginUpload` → copy → `completeUpload` (server digest) → `setKey` → executor tick → `VERIFIED`.                                                                                                                                                                                                                                          |
| `panels`           | 01 0.3, 04 I4  | One stand-in per package panel target (`verifyReport.panelTargets`), on an address the panel URL policy itself allows (loopback .2/.3 where loopback is allowed, else the container's first private non-data-subnet IPv4), registered with `panels.create`, `testConnection`, ACTIVE. Inventory from `--panel-inventory` (default empty). |
| `dry-run`          | 04 I4–I5       | `setPanelBindings`, `requestDryRun`, ticks → `DRY_RUN_DONE`.                                                                                                                                                                                                                                                                              |
| `import`           | GO-2, 04 I6–I7 | `capabilities` → `approve` with the page's phrase and, on a production-like target, the target acknowledgement (so on the test server the full production gates run: cutover approval of the seven values, protective backup, write freeze) → ticks → `COMPLETED`. Real protective and post-import backups, into the private dir.         |
| `reconciliation`   | 05 C3–C5       | Balances: `reconcileCutover` (zero tolerance, held never matched, agent credit LISTED NOT CREDITED, `RESELLER_*` zero). Services: the new `reconcileServices` (below).                                                                                                                                                                    |
| `token-handover`   | 06             | Always `SKIP`.                                                                                                                                                                                                                                                                                                                            |
| `no-messages`      | 10             | `quietFacts`: customer_notifications, broadcast_recipients, notifications SENT, outbox published, provisioning_operations, bot_instances — all 0 in the disposable DB — plus outbound fetch attempts 0 (Telegram 0) and stand-in write attempts 0. An attempt that was stopped is still FAIL.                                             |
| `background-roles` | 07             | `SKIP` (dry): no role started; the provisioning-operation count shown.                                                                                                                                                                                                                                                                    |
| `cleanup`          | —              | `DROP DATABASE … WITH (FORCE)` only for a database this run created, unless `--keep-database`; the private work dir removed.                                                                                                                                                                                                              |

Go/no-go (`rehearsalOutcome`): GO only when every step passed and both reconciliations are exact;
GO_WITH_HELD when held rows are all that is left; NO_GO on any failed step, any difference, or a
reconciliation that did not run. Exit 0 / 2 / 3 (the `cutover-reconcile` numbers), 64 usage,
65 refused target, 1 other. Text report (steps, `cutoverReportText`, `serviceReportText`,
`go/no-go:` line) or `--json` (`nexa-cutover-rehearsal/v1`). Progress lines go to stderr.
Errors are reported by type and code only, never a message that could carry a value.

### Service reconciliation (new, pure): `legacy-cutover/application/cutover-service-reconciliation.ts`

Mirza side: `serviceCandidateInvoices(snapshot)` (the importer's own list), now also returned by
`readMirzaSide` (`serviceInvoices`). Nexa side (`readNexaServiceState`, a REPEATABLE READ READ
ONLY rolled-back transaction like `readNexaCutoverState`): `legacy_service_candidates` and every
service with its state, `source`/`source_ref` (`MIRZA`, `invoice:<id>`) and owner. Matched =
adopted, present, not terminated, alone, owned by the invoice's Mirza user. Held = not adopted,
by outcome; `heldAsHistory` counts held invoices kept as TERMINATED history services. Differences:
`SERVICE_NOT_DECIDED`, `SERVICE_ADOPTED_MISSING`, `SERVICE_DUPLICATED`, `SERVICE_LIVE_WHILE_HELD`,
`SERVICE_OWNER_DIFFERS`, `SERVICE_NOT_IN_MIRZA`, `CANDIDATE_NOT_IN_MIRZA` — named by invoice
position and Nexa service id, never a Telegram id or username.

### botctl `cutover rehearse` (`deploy/bin/botctl`)

`sudo botctl cutover rehearse PACKAGE (--key-file FILE | --passphrase) --owner-telegram-id N
[--database NAME] [--keep-database] [--panel-inventory FILE] [--json] [--list-differences]`.
Validates arguments (never echoing an unknown one), copies the package (and inventory) mode 0400
into a 0700 `mktemp -d` owned by uid 1000 (when root), mounts it read-only at `/cutover`, puts
the key text / typed passphrase into the environment of that ONE `compose run --rm --no-deps -T
-e NAME … --entrypoint node api dist/cutover-rehearse.cli.js` (exported in a subshell, never on
argv), removes the directory on exit, relays the CLI's exit code with a one-line verdict on
stderr. No lock, no `up/stop/restart/exec`, no migration of the live DB, no Telegram command, no
nexa.env edit. Listed in `botctl help`.

### Other

- `scripts/check-runtime-cli.sh`: the new CLI must load from dist.
- `package.json` / `apps/api/package.json`: `cutover-rehearse[:dev]`; `test:deploy` runs the new deploy test.
- `tests/support/legacy-migration-rig.ts`: `mirzaAgentRecords` moved here from
  `cutover-reconcile.test.ts` (both suites build the same agent records).
- `tests/deploy/harness.sh`: the fake docker models the rehearsal call (records the secret from
  its environment and the mounted directory's listing; configurable verdict/exit).

### Docs

- `docs/cutover/12-rehearsal.md` (new): **Rehearsal** — what each line means, the service
  reconciliation, R1 (command, verification, rollback, record), what it never does, limits, Persian guide.
- `docs/cutover/README.md` (page table, tools list), `01-preconditions.md` (0.5 points to it on the
  test server), `09-go-no-go.md` (GO-1 checkbox), `11-records.md` (rehearsal record table).
- `docs/deployment.md`: Operating list + "Rehearsing the MirzaBot cutover" section.
- `docs/open-questions.md`: OQ-R11-A2-01…03.

### Owner's test-server checklist (wording to add)

> **Cutover rehearsal (test server, before GO-1).** With the final (or latest real) Mirza export
> and its key in `~/cutover` (mode 0700), run
> `sudo botctl cutover rehearse ~/cutover/<package>.nxpkg --key-file ~/cutover/<key>.nxkey --owner-telegram-id <your id> | tee rehearsal.txt; echo "exit ${PIPESTATUS[0]}"`.
> Pass when: exit 0 (`GO`) or exit 2 (`GO_WITH_HELD`) with every held class — balance `held …`
> lines and service `held <OUTCOME>` lines — accepted by name; every step `PASS` or `SKIP`;
> `token-handover` and `background-roles` `SKIP`; `no-messages` `PASS` (all counts 0); every
> balance and service `difference …: 0`; the five reseller lines 0; `agent credit LISTED, NOT
CREDITED` recorded as a figure that was NOT credited; `cleanup` says the rehearsal database was
> dropped. Record `rehearsal.txt`, the exit code and the duration in `docs/cutover/11-records.md`.
> Exit 3 (`NO_GO`) stops GO-1: fix the cause and rehearse again; never repair rows.

## Tests

- `tests/integration/cutover-rehearsal.test.ts` — 4 cases, against this PostgreSQL server, the
  suite's own test database playing "live":
  1. clean package (30 users, 12 invoices of which 6 live on the stand-ins with a tariff product,
     2 agents one with a 5,000,000 cap): every step PASS/SKIP; balances RECONCILED, 30 matched,
     sum = Σ generated balances, agents 2/2, credit listed 1 row 5,000,000, every RESELLER_* 0;
     services 12/12, matched 6, held 6 PROVIDER_MISSING kept as history, no difference;
     GO_WITH_HELD exit 2; quiet all 0; forced settings in effect although the env had dispatch
     and provisioner on; database dropped; live footprint unchanged.
  2. deliberate mismatch after the import (1 Toman credited, 1 adopted service terminated) plus
     a Telegram `fetch` from inside the run: the fetch is refused with the guard's TypeError;
     BALANCE_DIFFERS 1 naming that customer, SERVICE_ADOPTED_MISSING 1, matched 5;
     telegramRefused 1; failed steps exactly reconciliation + no-messages; NO_GO with the four
     reasons; exit 3; `--keep-database` kept it; live footprint unchanged.
  3. the live database name (carries `test`, so only the equality rule refuses it): TargetRefused
     with "is the live database DATABASE_URL names"; no database created; live footprint unchanged.
  4. `nexa` refused; an existing database refused and still there afterwards.
- `tests/unit/cutover-rehearsal.test.ts` — 22 cases: args (required flags, one secret, owner id,
  plain name, no echo), inventory parsing, target rules (live name under a non-production word,
  production-like, system DBs, URL/credentials kept, maintenance URL), default name, loaded config
  with every channel off from a live env with all on + the live config's six problems + the exact
  forced set, outbound guard (refuse/count/restore), stand-in address (production / loopback),
  service reconciliation (matched/held/history, every difference kind, no Telegram id in the
  text), go/no-go and exit codes, quiet check per field.
- `tests/deploy/cutover-rehearse.test.sh` — 8 checks: the exact compose call, key only in the
  environment, private read-only copy removed afterwards, nothing changed on the installation,
  flags forwarded, exit codes 2/3/65 relayed, refusals before any container, usage.
- `tests/integration/cutover-reconcile.test.ts` — unchanged behaviour, uses the moved helper.

### Mutation checks (each: break → named test red → restore → green)

| Mutation                                                               | Red test                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remove the live-DB refusal in `rehearsalTarget`                        | unit "refuses the live database DATABASE_URL names…"; integration "refuses the live database itself…" (after adding the message assertion — before it, the existing-database wall kept it green, which is why the assertion was added) |
| `NOTIFICATION_DISPATCH_ENABLED: 'true'` in `REHEARSAL_FORCED_SETTINGS` | unit "the loaded rehearsal configuration has every messaging channel off", "forces exactly the channels…"; integration "a clean package…" (messaging step FAIL)                                                                        |
| `guard.install()` removed                                              | integration "one deliberate mismatch…" (`expected 'fetch failed' to contain 'the cutover rehearsal sends nothing'`)                                                                                                                    |
| the DROP skipped                                                       | integration "a clean package…" (database still listed)                                                                                                                                                                                 |
| adopted-but-terminated not treated as missing                          | unit "names every kind of difference…"                                                                                                                                                                                                 |
| botctl passes the key as `-e NAME=value` (argv)                        | deploy "the key travels in the environment, never on a command line"                                                                                                                                                                   |
| botctl's cleanup trap removed                                          | deploy "the package is copied into a private directory, then removed"                                                                                                                                                                  |

## Decisions

- **Entry point:** a `pnpm`/dist CLI that `botctl cutover rehearse` runs in a one-off api
  container, the pattern of `cutover-reconcile`, `backup.cli.js restore` and the preflight.
- **Disposable DB on the installation's own server**, default `nexa_cutover_rehearsal_<UTC>`,
  dropped by default; refused if it equals `DATABASE_URL`'s database, is production-like, or exists.
- **Approver** (OQ-R11-A2-03): the rehearsing owner created in the disposable DB by
  `BootstrapOwnerService`; actions as `WEB_ADMIN` with no session (the only admin actor type).
- **Panels:** the kit's read-only stand-in, in process; default empty inventory (stage A);
  `--panel-inventory` for stage B shapes. No real panel, no live-tenant panel credentials.
- **No tariff products copied** from the live tenant (OQ-R11-A2-01); the money reconciliation is
  complete without them.
- **Proof of silence** is three walls, each tested: forced config, no loop started (no relay,
  dispatcher, webhook), and a process-wide fetch refusal; plus the database facts in `no-messages`.
- Not refused on a production host (OQ-R11-A2-02); documented for the test server.
- No contract change, no migration, no feature flag (an operator CLI that writes only a database
  it creates; nothing in the product changes).

## Migrations

None.

## Local gate

- `pnpm verify` (typecheck, lint, format, boundaries, i18n, citations, shell, unit, web,
  test:deploy, build): `passed=13484 failed=0` (after `pnpm build`; `backup-cli.test.ts` runs the
  dist CLI, so a worktree that was never built fails it before verify's own build step).
- `pnpm check:runtime`: the new `dist/cutover-rehearse.cli.js` loads from a production runtime.
- Integration (selected): `cutover-rehearsal`, `cutover-reconcile`, `legacy-migration-nxpkg`,
  `cutover-snapshot-query` — `passed=23 failed=0`.
- `pnpm check:shell` clean; `tests/deploy/cutover-rehearse.test.sh` 8/8.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
