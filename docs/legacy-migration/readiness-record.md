# Legacy migration — readiness record

> **NOT READY** — current `main` at the merge of `legacy/real-archive-readiness` (PR #224),
> 2026-10-06. (Written against `main` @ `edd13981`; the merge commit is the one to cite.)

This is the record [`production-gate.md`](production-gate.md) asks for: one row per gate,
the artifact that satisfies it or exactly what is missing. It is **not** an approval, and
nothing here may read `READY_FOR_PRODUCTION_APPROVAL` until every gate has an artifact a
reviewer can open. Production cutover has NOT been executed and is the owner's alone
(cutover step 13).

**Evidence classes.** _Real_ evidence comes from the real MirzaBot archive, a real RickPanel
or the staging installation. _Synthetic_ evidence comes from this repository's fixture
(`tests/fixtures/legacy/`) and proves code and harness only. No row below counts synthetic
evidence toward a gate that asks for real data; synthetic results are listed separately and
labelled.

States: **MET** — the artifact exists and is cited; **PARTIAL** — the code-side artifact
exists, the real-data half does not; **OPEN** — the evidence does not exist.

## Gates

| #   | Gate                             | State   | Evidence, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | `main` CI green                  | PARTIAL | CI run [37440657172](https://github.com/Mhoseinshah1/nexa-bot/actions/runs/37440657172) is green on `main` @ `edd13981`. **Missing:** a green run on the exact commit the release is built from, which must include this branch. The branch's own CI run [37465832375](https://github.com/Mhoseinshah1/nexa-bot/actions/runs/37465832375) (PR head `dcce826c`) is green, including the new `legacy-rehearsal` job and both `legacy-mysql` matrix entries (`mariadb-10.11`, `mysql-8.0`).                                                                                                                                                                                                               |
| G2  | P6 service adoption complete     | MET     | merged #181 (Item 7, P6 adoption, zero provider calls) and #180 (Item 8, reminder burst protection), on `main` @ `edd13981`. Re-cite on the release commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G3  | P7 importer complete             | PARTIAL | merged #183 (P7 importer, mapping, evidence runner). **Missing:** this branch merged — it adds the per-tenant process claim (two concurrent resumes deadlocked before it), the audit's and apply's panel-map completeness refusal, and the lost-claim stop.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G4  | Manual review queue complete     | MET     | merged #179 (Item 9, closed reasons, counts, keyset list, resolve/reopen), on `main` @ `edd13981`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| G5  | SQL evidence complete            | OPEN    | **Missing:** `sql-evidence.md` result tables and run record from the REAL archive. No real archive has been read. Needs commands 1–2 below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G6  | C1 RickPanel inventory accepted  | OPEN    | **Missing:** `rickpanel-inventory-acceptance.md` § Results from a real panel, per production panel (command 3). OQ-P5-01/02: the list route is inferred, not evidenced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| G7  | C3 subscription_ref accepted     | OPEN    | **Missing:** the C3 manual-acceptance items against a real panel (command 3 with a legacy account as the known username).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| G8  | Hidden legacy products validated | PARTIAL | code and tests merged (#166, #177). **Missing:** the Q1/Q1b-driven shape list from the real archive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| G9  | Trial eligibility validated      | PARTIAL | code and tests merged (#166, #177); OQ-I15-01 DECIDED. **Missing:** the Q2/Q2b decision split from the real archive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| G10 | Panel map complete               | OPEN    | **Missing:** a reviewed `panel-map.json` built from the real `code_panel` evidence and the staging panel uuids, and a staging `audit` whose verdict is `READY_FOR_DRY_RUN` with `sections.panelMapping.completeness.unmapped = {}` (machine-checked since WP-D2; every deliberate code in `unresolvedPanels` with its reason). Depends on G5 and G6.                                                                                                                                                                                                                                                                                                                                                   |
| G11 | Staging rehearsal successful     | OPEN    | **Missing:** a staging `summary.json` (none exists). A synthetic run is a precondition, not this gate (see below). Every PENDING check of the staging run must be accepted by name in the table below (`summary.json.pendingDecisions[]` lists them).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| G12 | Interrupted / resumed rehearsal  | OPEN    | **Missing:** the same staging run's `interrupted_run_left_running`, `interrupted_import_stopped_writing`, `one_apply_run_resumed`, `apply_run_completed` (every cycle) and `repeat_reproduces_cycle_1` (cycle 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| G13 | Rollback rehearsal successful    | OPEN    | **Missing:** (a) the staging run's `rollback_restores_pre_import`, `rollback_restores_pre_import_exact`, `rollback_displaced_exists`, `rollback_displaced_preserved` (WP-D8); (b) the Web Admin recovery lane on staging, recorded in [`rollback-runbook.md`](rollback-runbook.md) § Recording the lane (all NOT RUN): recovery request id, stage durations, `nexa_pre_restore_<id>`, empty R4 `diff`.                                                                                                                                                                                                                                                                                                 |
| G14 | Reconciliation exact             | OPEN    | **Missing:** the staging run's generated `reconciliation.md` (WP-D5) with every equation HOLDS (or its cause accepted below), and R3's and P4's manual halves done. The staging column of [`reconciliation.md`](reconciliation.md) is empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| G15 | Manual acceptance passed         | OPEN    | **Missing:** [`manual-acceptance.md`](manual-acceptance.md) § Recording from staging — every row is NOT RUN (34 rows: A1…E2, F0, F1 × 12 reasons, G1, G2, R3, P4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| G16 | No P0/P1 blocker                 | OPEN    | **Open migration questions** (each needs an answer or the owner's explicit acceptance): OQ-REH-02 (UNKNOWN: how MirzaBot is stopped and its MySQL made read-only), OQ-P5-01 and OQ-P5-02 (the RickPanel list route and its order), OQ-P7-02 (map code for a live legacy trial invoice), OQ-P7-03 (code side addressed by WP-D1b; the real archive's MySQL 8 load is still step 1), OQ-P7-04 (inventory reads and the probe budget), OQ-P4-01 (the deployed invoice-key generator is unproven: a confirming aggregate is required before APPLY), OQ-I14-01 and OQ-I14-03 (hidden-product price following; `time_unit` spellings and a zero `Volume`), OQ-C4-02 (sending the NEXA keyboard proactively). |
| G17 | Backup and runbooks ready        | OPEN    | **Missing:** production `botctl status`, a verified production backup within 24 h, a Recovery Kit exported after the last key rotation, the production restore drill — the backup/recovery program (Agent E). Not produced here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| G18 | Provider writes = 0              | OPEN    | **Missing:** the staging run's report `provider.writes = 0` and `provider_writes_zero`, `adopted_services_without_operations`, `panel_state_unchanged` (P4, WP-D4) PASS. On staging the wire check `wire_provider_writes_zero` does not exist (it needs the fake panels); P4 is its staging equivalent.                                                                                                                                                                                                                                                                                                                                                                                                |
| G19 | Every legacy table classified    | OPEN    | **Missing:** `table-inventory.md` filled from `legacy-import inventory` on the staging copy of the real dump, and the reviewed commit classifying every table (OQ-MZ-INV, OQ-LCO-06). Until then the gated import, the cutover gate and report v2 refuse (`TABLES_UNCLASSIFIED`).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| G20 | Migration program rehearsed      | PARTIAL | Code side: the synthetic rehearsal's cycle 9 (Mirza PR6) — gated import refusals, SOURCE_SUPERSEDED, the acknowledged re-run with no duplicate, report v2 holding, `cutover-gate` CUTOVER_READY — see § Synthetic evidence. **Missing:** the staging run with the owner's approval recorded in `/legacy-cutover` and manual-acceptance W1–W8.                                                                                                                                                                                                                                                                                                                                                          |

## Accepted pending checks (G11)

One line per PENDING check of the **staging** run, decided by the owner. Empty: there is
no staging run. The synthetic run's PENDING checks below are fixture cases and are never
accepted here.

| cycle | check | actual | owner decision | decided by | date (UTC) |
| ----- | ----- | ------ | -------------- | ---------- | ---------- |

## Synthetic evidence (code and harness only — NOT a gate)

Run in this session's sandbox (PostgreSQL 16, Redis, MariaDB 10.11.14 from the OS, MySQL
8.0.46 from the Ubuntu packages unpacked into a scratch directory), `--evidence-class
synthetic`, two cycles, the fake RickPanels of `--synthetic-panels`. None of it is legacy
evidence, a Q1–Q7 result, a C1/C3 result or a staging rehearsal.

| commit                              | engine           | input                                 | PASS | FAIL | PENDING | wall time |
| ----------------------------------- | ---------------- | ------------------------------------- | ---- | ---- | ------- | --------- |
| `main` `edd13981` (before any WP-D) | MariaDB 10.11.14 | plain `synthetic-legacy.sql`          | 99   | 0    | 4       | 46 s      |
| this branch `2042656c`              | MariaDB 10.11.14 | AES-256 zip (`backup_2026-01-01.zip`) | 127  | 0    | 6       | 110 s     |
| this branch `2042656c`              | MySQL 8.0.46     | AES-256 zip (`backup_2026-01-01.zip`) | 127  | 0    | 6       | 114 s     |

Both rows are the same final code, run one after the other with the asserted wrapper
(`pnpm rehearsal:synthetic`, which also checks every expected PASS check by name). An
earlier MariaDB run on this branch failed at the rollback cutover: the `rename_db` defect
fixed in `a23105a0`.

The PENDING checks are the fixture's deliberate owner-decision cases, 3 per cycle:
`invoice_keys_outside_evidenced_shape` (S2, OQ-P4-01), `report_equation_C3` (a user id that
is not a Telegram id) and `legacy_balance_fractional_users` (W8; recorded since WP-D5 — the
`main` run shows 4 because that check did not exist). Verdict
`DONE_PENDING_DECISIONS (not passed)`, as it must be. The CI job `legacy-rehearsal` runs the
same, asserted (0 FAIL, exactly these PENDING, and every expected PASS check by name), on
MySQL 8.0; it ran green in CI run
[37465832375](https://github.com/Mhoseinshah1/nexa-bot/actions/runs/37465832375).

What running on a real MySQL 8.0 found, all with the synthetic dataset:

- two defects in `scripts/legacy-rehearsal-source.sql` that MariaDB had hidden — `BINARY …
REGEXP` (ERROR 3995 under ICU) and a GROUP BY expression refused by
  `ONLY_FULL_GROUP_BY` (ERROR 1055) — fixed; the legacy aggregates are now identical on both
  engines;
- a genuine `mysqldump` 8.0 of a schema with MirzaBot's default collation fails to load
  into MariaDB (`Unknown collation: 'utf8mb4_0900_ai_ci'`). A real MySQL 8 dump will
  therefore need `--legacy-engine mysql8`; the archive inspector now refuses it on MariaDB
  before any load instead of failing mid-load;
- the importer's source suite (`pnpm test:legacy-mysql`) passes 7/7 on MySQL 8.0.46.

## What is missing, and the exact operator commands (all NOT RUN)

Each step needs a real asset this environment does not have. In order:

1. **Archive intake.** Take the latest `backup_YYYY-MM-DD.zip` from the legacy backup
   topic, or a fresh dump (`cutover-runbook.md` Step 8). Then:

   ```bash
   read -rs LEGACY_ZIP_PASSWORD && export LEGACY_ZIP_PASSWORD   # typed, never on argv
   node scripts/legacy-archive-inspect.mjs --archive backup_YYYY-MM-DD.zip \
     --password-env LEGACY_ZIP_PASSWORD --engine mysql8 --require-class staging \
     --out ~/legacy-intake --extract
   ```

   Record `archive.sha256` and `dump.sha256` from `~/legacy-intake/archive.json`.

2. **MySQL 8 restore and SQL evidence (G5).** Load `~/legacy-intake/backup_*.sql` into a
   throwaway MySQL 8.0, create `oldbot_ro` (SELECT only), then:

   ```bash
   pnpm legacy-import audit --tenant <slug> --source mysql://oldbot_ro@127.0.0.1:<port>/<db> \
     --source-password-env LEGACY_SOURCE_PASSWORD --target <staging_db> \
     --panel-map panel-map.json --format json --out <dir>
   ```

   Fill `sql-evidence.md` (tables and run record) as its own commit; re-read OQ-P4-01 and
   OQ-I14-03 against Q1c and the invoice-key aggregate.

3. **C1 and C3 (G6, G7; OQ-P5-01/02)**, once per production panel:

   ```bash
   NEXA_INVENTORY_RICKPANEL_URL=… NEXA_INVENTORY_RICKPANEL_USERNAME=… \
   NEXA_INVENTORY_RICKPANEL_PASSWORD=… NEXA_INVENTORY_KNOWN_USERNAME=<a legacy account> \
   NEXA_INVENTORY_PAGE_SIZE=50 NEXA_INVENTORY_DRIFT_TOLERANCE=0 pnpm test:acceptance:inventory
   ```

   (`NEXA_INVENTORY_SUBSCRIPTION_ORIGIN` if the subscription host differs.) Record the
   Results. Alternatively the owner supplies `rickpanel-openapi.json` to settle the route.

4. **Panel map (G10).** Write `panel-map.json` from the Q1b/Q6 `code_panel` evidence and the
   staging panel uuids (`panels`, `testPanels`, `missingPanels`, `unresolvedPanels` with a
   reason, `productionPanels`, `products`); owner review; a staging `audit` whose verdict is `READY_FOR_DRY_RUN`
   with `completeness.unmapped = {}`.

5. **Staging rehearsal (G11, G12, G13a, G14, G18)** on a staging host, MirzaBot frozen:

   ```bash
   pnpm install --frozen-lockfile && pnpm build
   export PGPASSWORD=…            # never on argv
   read -rs LEGACY_ZIP_PASSWORD && export LEGACY_ZIP_PASSWORD
   scripts/legacy-rehearsal.sh \
     --evidence-class staging \
     --legacy-archive backup_YYYY-MM-DD.zip --legacy-archive-password-env LEGACY_ZIP_PASSWORD \
     --legacy-engine mysql8 --mysql-bin-dir <dir with MySQL 8.0 mysqld, mysql, mysqladmin> \
     --tenant <slug> --panel-map <reviewed panel-map.json> \
     --nexa-env <staging env able to open the archive> \
     --pg-url postgres://<user>@127.0.0.1:5432 \
     --nexa-archive <fresh production-like .nxb> \
     --installed-host-is-not-production \
     --cycles 2 --kill-after-rows <N> --out <new results dir>
   ```

   Keep `summary.json`, `checks.tsv`, `durations.tsv`, `reconciliation.md`, `archive.json`,
   `c*-report.json` and `snapshots/`. Have the owner accept every `pendingDecisions[]` entry
   by name in the table above.

6. **Web Admin recovery lane (G13b).** On staging after the staging import:
   `rollback-runbook.md` R0–R4; fill § Recording the lane.

7. **Manual acceptance (G15).** On the staging copy, the selectors of
   `manual-acceptance.md` with a written seed; fill every row of § Recording (Telegram only
   on controlled accounts).

8. **G16.** The owner answers or accepts each open question listed in G16.

9. **G17.** The backup/recovery program's production evidence (Agent E).

10. **This record.** Update it with each artifact. Only when every gate is MET may the line
    at the top become `READY_FOR_PRODUCTION_APPROVAL — <main commit>, <release>, <date>`;
    then stop — cutover step 13 is the owner's.

## GO / NO-GO

**NO-GO for production cutover.** Missing real evidence: the archive's SQL evidence (G5),
C1/C3 on a real RickPanel (G6, G7), the Q-driven product and trial packets (G8, G9), a
reviewed panel map (G10), any staging rehearsal, interrupted/resumed run, rollback or
recovery-lane run (G11–G13), the reconciliation figures (G14), manual acceptance (G15),
the open migration questions (G16), production backup readiness (G17) and provider writes
= 0 on real data (G18). What this branch closes is code-side: the archive format the
deployed bot actually produces is now accepted and validated, MySQL 8 is a supported legacy
engine, an unmapped panel code blocks the audit, concurrent resumes are refused, every
reconciliation equation has a machine check, the rollback is compared exactly, and the
synthetic rehearsal runs in CI.
