# The Mirza full migration — PR1 to PR6, and the ordered path from staging to cutover

**Production was not modified.** No deploy, no tag, no release, no production migration,
no production import, no write to any legacy database and no provider write was made by
any of these six PRs or by the agents that built them. Every real-data step below is
**NOT RUN**: there is no real Mirza dump, staging server, RickPanel or production host in
the environment they were built in. Synthetic runs prove the code and the harness only and
are never evidence about the legacy archive.

**The staging snapshot is HISTORICAL** (owner constraints 1–4). Every count it produced —
users, invoices, products, RickPanel accounts, dry-run categories, negatives, orphans — is a
dated baseline for explaining differences, never a limit, an expected value or a test
oracle. The cutover imports a NEW frozen snapshot, with a fresh fingerprint, under the
owner's approval recorded in the database and bound to that snapshot.

## What each PR delivers

| PR  | branch                                | delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `mirza/pr1-table-inventory-read-sets` | The v1 import read set frozen and its synthetic fingerprint pinned; versioned read sets with their own fingerprints (`legacy_read_set_runs`, 0219–0220); the table classification catalogue (UNCLASSIFIED fails closed); `legacy-import inventory`; the freeze proof over EVERY table and its checker `scripts/legacy-freeze-checksum-verify.sh`.                                                                                                                                                                |
| PR2 | `mirza/pr2-product-review`            | The `products` read set; `legacy-import products-read` (digest, approve, ingest) and `products-export`; the legacy product review (`legacy_product_reviews`, 0221–0222) with `SOURCE_CHANGED`, decisions bound to the row version, replay returns the original; Web Admin `/legacy-products`.                                                                                                                                                                                                                    |
| PR3 | `mirza/pr3-invoice-archive` (#232)    | The `invoice-archive` read set; `legacy-import invoices-read`; the append-only, revisioned invoice archive (0223–0225) with its closure `archived = source rows + missing`; Web Admin `/legacy-invoices` (personal data behind its own HIGH key).                                                                                                                                                                                                                                                                |
| PR4 | `mirza/pr4-users-wallets` (#233)      | Owner decision 6: a negative legacy balance is a legacy DEBT held for review (`legacy_wallet_debts`, 0226–0228), never a ledger entry, never collected; the `usersWallets` section (U1–U8); Web Admin `/legacy-debts`.                                                                                                                                                                                                                                                                                           |
| PR5 | `mirza/pr5-service-review` (#234)     | Owner decision 8: one outcome per live invoice (`legacy_service_candidates`, 0229–0231); `NO_PANEL` never adopted automatically; the operator's explicit ADOPT approval executed by the next run through P6; every claim settled by its run (`approval_released`, `withdrawnDuringRun`, ADOPTION_UNCONFIRMED attention); the `serviceOutcomes` section; Web Admin `/legacy-services`.                                                                                                                            |
| PR6 | `mirza/pr6-report-cutover`            | The owner's cutover approval recorded in the database (`legacy_cutover_approvals` and revocations, 0232–0234, append-only), bound to seven exact values; the gated import (EXPECTATION_INCOMPLETE, TABLES_UNCLASSIFIED, APPROVAL_MISSING, APPROVAL_SYNTHETIC, SOURCE_SUPERSEDED); `legacy-import cutover-gate`; the final report schema v2 (every section, seven invariants, v1 unchanged as `core`); Web Admin `/legacy-cutover`; the whole program in the synthetic rehearsal (cycle 9); the runbooks aligned. |

## The ordered path (staging first, then the cutover)

Every command is the operator's, on the host named, through the runbook's helpers
(`cutover-runbook.md` step 0: `p7`, `$DC`, the target acknowledgement). Each captures its
output with `tee`; every value carried forward is pasted, never retyped. On STAGING the
target database is the staging installation's; the same commands run at cutover against
production with `--evidence-class production`.

### A. Staging (NOT RUN)

1. **Restore the staging dump** into a throwaway engine of the legacy major version, read
   through a SELECT-only account (`cutover-runbook.md` step 9). Record the dump's SHA-256.
   Or run the whole rehearsal: `scripts/legacy-rehearsal.sh --evidence-class staging
--legacy-dump <dump> --nexa-archive <staging backup> …` (`rehearsal.md`), which stops its
   program phase after the reads and records the owner's approval as PENDING.
2. **Audit**, bound to nothing yet, to learn the source fingerprint:
   `p7 audit --format json | tee audit.json` → `sections.source.fingerprint`,
   `sections.panelMapping.fingerprint`.
3. **Inventory** (`legacy-import inventory --expected-fingerprint <source fp>`), then **Area
   E**: fill `table-inventory.md`, classify EVERY table in a reviewed commit
   (SUPPORTED / ARCHIVE / SECRETS_MANUAL / OWNER_DECISION), list secrets for manual
   reconfiguration — never imported. Re-run until the verdict is `COMPLETE` (exit 0).
4. **Products**: `products-read --expected-fingerprint <fp>` (digest, exit 3) → the owner
   approves the products fingerprint → `products-read … --expected-products-fingerprint <pfp>`
   (INGESTED) → decide every row in `/legacy-products` → `products-export` → install the map
   and re-audit if its fingerprint changed.
5. **Invoices**: `invoices-read --expected-fingerprint <fp>` (digest, exit 3) → approve →
   `invoices-read … --expected-invoice-archive-fingerprint <afp>` (ARCHIVED; closure lines hold).
6. **Audit again** (the map may have changed): `p7 audit | tee audit.txt`, verdict
   `READY_FOR_DRY_RUN`.
7. **Dry-run**: `p7 dry-run | tee dry-run.txt`; no business row changes.
8. **Import** (historical snapshot, staging): `p7 import --expected-fingerprint <fp>
--expected-panel-map-fingerprint <mfp> | tee import.txt`. To rehearse the gate on staging
   too: record a CUTOVER approval in `/legacy-cutover` with the seven values and add
   `--cutover-gate` and the five other `--expected-*` flags.
9. **Review queues in the Web Admin**: `/legacy-products`, `/legacy-invoices`,
   `/legacy-debts`, `/legacy-services` (manual-acceptance W1–W4).
10. **Reconcile**: `p7 reconcile | tee reconcile.txt` → `RECONCILED`.
11. **Report v2**: `p7 report --format json > final-report.json`; validate with
    `node scripts/legacy-rehearsal-report-check.mjs validate docs/legacy-migration/final-report-v2.schema.json final-report.json`;
    read `verdict`, `failedSections`, `failedInvariants`.
12. **Manual acceptance** (`manual-acceptance.md`, the sample matrix and W1–W8).
13. **Rollback rehearsal** (`rollback-runbook.md` § Rehearse it): the recovery lane restores
    the pre-import backup; the approvals and every legacy table go with it.

### B. The cutover (NOT RUN; `cutover-runbook.md` is authoritative)

1. Maintenance incident with `stop_sales` on every panel and gateway (step 1).
2. Release, health, migrations, backups (steps 2–6).
3. **Freeze** MirzaBot; freeze proof over every table; its file's SHA-256 (step 7).
4. **Final dump** and its SHA-256 (step 8).
5. **Restore** into the throwaway engine; freeze proof on the copy; PR1's checker `EQUAL` (step 9).
6. **Audit**, **inventory** (`COMPLETE`), **products** and **invoices** reads, each bound to
   the fresh source fingerprint (step 10).
7. **Dry-run** and the comparison with staging — differences explained by changed data,
   never by a limit (steps 11–12).
8. **Owner approval** in `/legacy-cutover`: kind CUTOVER, the seven values (step 13). If the
   tenant already holds an import of another snapshot, the default is to roll it back; a
   RERUN_OVER_PRIOR_IMPORT acknowledgement is the owner's explicit alternative.
9. **Gated import**: `p7 import "${APPROVED_ARGS[@]}"` — all seven `--expected-*` values
   (step 14). Refusals exit 65 and write nothing.
10. **Reconcile** → `RECONCILED` (step 15).
11. **Cutover gate**: `legacy-import cutover-gate … --freeze-proof … --freeze-proof-restored …
--freeze-checker … --final-dump …` → `CUTOVER_READY`, eleven steps PASS (step 15b).
12. Manual acceptance, unfreeze NEXA (MirzaBot never), observe (steps 16–18).
13. **Report v2** and the final report (step 19).
14. **Rollback** if a trigger fires (`rollback-runbook.md`, T1–T9); never a drop path.

## The ordered command list (operator, copy in order)

```bash
# --- staging (and again at cutover, with --evidence-class production) ---------------------
p7 audit --format json | tee audit.json                                   # source + map fingerprints
legacy-import inventory --tenant T --source env:LEGACY_SOURCE_DSN --target nexa \
  --allow-production-target --expected-fingerprint <fp> | tee inventory.md    # COMPLETE, exit 0
legacy-import products-read … --expected-fingerprint <fp> | tee products-read-digest.md
legacy-import products-read … --expected-fingerprint <fp> --expected-products-fingerprint <pfp> | tee products-read.md
legacy-import products-export … --expected-products-fingerprint <pfp> --panel-map <map> > panel-map.next.json
legacy-import invoices-read … --expected-fingerprint <fp> | tee invoices-read-digest.md
legacy-import invoices-read … --expected-fingerprint <fp> --expected-invoice-archive-fingerprint <afp> | tee invoices-read.md
p7 audit | tee audit.txt                                                   # READY_FOR_DRY_RUN
p7 dry-run | tee dry-run.txt
#   owner: /legacy-cutover → CUTOVER approval with the seven values
p7 import --expected-fingerprint <fp> --expected-panel-map-fingerprint <mfp> \
  --expected-inventory-fingerprint <ifp> --expected-products-fingerprint <pfp> \
  --expected-invoice-archive-fingerprint <afp> --expected-freeze-proof-sha256 <freeze> \
  --expected-final-dump-sha256 <dump> | tee import.txt                     # gated (production-like)
#   Web Admin: /legacy-products /legacy-invoices /legacy-debts /legacy-services
p7 reconcile | tee reconcile.txt                                           # RECONCILED
legacy-import cutover-gate … <the seven values> --freeze-proof step7.tsv \
  --freeze-proof-restored step9.tsv --freeze-checker legacy-freeze-checksum-verify.sh \
  --final-dump oldbot-final.sql | tee cutover-gate.md
p7 report --format json > final-report.json
node scripts/legacy-rehearsal-report-check.mjs validate docs/legacy-migration/final-report-v2.schema.json final-report.json
# rollback, only on a trigger: rollback-runbook.md R0–R5 (the recovery lane; two renames; nothing dropped)
```

## Remaining blockers and open questions (all PRs)

Nothing below is guessed; each is in `docs/open-questions.md` and blocks the production
gate (`production-gate.md`) until settled:

- **No real-data evidence at all**: SQL evidence Q1–Q7, the RickPanel inventory acceptance,
  C3 subscription_ref, the staging rehearsal (G5–G7, G10–G15, G18–G20) — NOT RUN.
- **Area E**: the real table list is UNKNOWN (OQ-MZ-INV, OQ-LCO-06); every unknown table is
  UNCLASSIFIED and the cutover refuses until a reviewed commit classifies it.
- **The legacy freeze** commands (OQ-REH-02, OQ-LCO-04).
- **Products**: the real product columns and duplicates (OQ-LPR-*).
- **Invoice archive**: `time_sell` format and the invoice key shape (OQ-LIA-*, OQ-P4-01).
- **Wallets**: a changed balance in a newer snapshot is never applied (OQ-LWD-02); a re-run
  reports it for the owner.
- **Services**: panel 8255 stays unmapped unless mapped explicitly (OQ-LSR-*).
- **Cutover**: the approver role, FAILED runs superseding, rollback as the default answer to
  SOURCE_SUPERSEDED, the coverage of `stop_sales` (OQ-LCO-01–05).
- **Secrets**: none imported; their manual reconfiguration list is NOT RUN
  (`table-inventory.md` § Manual reconfiguration).

## Synthetic evidence (code and harness only — NOT evidence)

`scripts/legacy-rehearsal-synthetic.sh` (CI job `legacy-rehearsal`, MySQL 8.0): two cycles
and the program phase (cycle 9). Recorded in `readiness-record.md` § Synthetic evidence.
