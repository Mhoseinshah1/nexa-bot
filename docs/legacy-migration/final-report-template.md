# Legacy migration — final report (template, Item 16)

Copy this file per run (`final-report-<staging|production>-<YYYYMMDD>.md`), fill every
field, and attach P7's machine-readable report — schema version 2 since Mirza PR6, which
must validate against [`final-report-v2.schema.json`](final-report-v2.schema.json) (it
carries the closed version 1 document unchanged as `core`, validated by
[`final-report.schema.json`](final-report.schema.json)) — and the cutover gate's output. The
two say the same thing: this one for the owner, the JSON for a reviewer and a diff.

**Counts are dated baselines.** The staging snapshot is historical (owner constraints 1–4):
a figure from it explains a difference at cutover step 12; it is never a limit or an
expected value for the final snapshot.

**Aggregates only.** No Telegram id, username, phone, subscription link, config, panel
credential, token, `secret_code` or card may appear here — not in a table, a note or a
pasted log. NEXA row ids (uuids), run ids, backup ids, checksums and counts are fine.

> **Evidence class: `<synthetic | staging | production>`**
>
> A `synthetic` report proves the importer's code and the rehearsal harness on the fixture
> under `tests/fixtures/legacy/`. It is **never** legacy evidence, never a Q1–Q7, C1 or C3
> result, and never a rehearsal on real data. Delete this paragraph only for `staging` or
> `production`.

## 1. Run

| field                                                                                             | value |
| ------------------------------------------------------------------------------------------------- | ----- |
| tenant (slug)                                                                                     |       |
| APPLY run id                                                                                      |       |
| run status / failure code                                                                         |       |
| code version (release, commit, image digest)                                                      |       |
| started / finished (UTC)                                                                          |       |
| duration                                                                                          |       |
| resumes (interruptions)                                                                           |       |
| map rows FAILED at the end                                                                        |       |
| pre-import backup id + SHA-256 + verified at                                                      |       |
| owner approval: id, approving admin id, time (UTC), kind (`/legacy-cutover`; seven values in § 2) |       |
| re-run acknowledgements and the prior sources they name (must be none at a clean cutover)         |       |
| prior APPLY runs of this tenant and their source fingerprints (report v2 `sections.cutover`)      |       |
| operator(s)                                                                                       |       |

## 2. Source

| field                                                                                                                                                                                                                   | value |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| final dump file name, size, SHA-256 (= the approval's `finalDumpSha256`)                                                                                                                                                |       |
| panel-map fingerprint (= the approval's)                                                                                                                                                                                |       |
| read-set fingerprints: inventory / products / invoice-archive (= the approval's; `legacy_read_set_runs`)                                                                                                                | / /   |
| freeze proof file (step 7) SHA-256 (= the approval's `freezeProofSha256`)                                                                                                                                               |       |
| table inventory: tables by class, UNCLASSIFIED (must be 0), SECRETS_MANUAL tables listed for manual reconfiguration                                                                                                     |       |
| dump taken at (UTC)                                                                                                                                                                                                     |       |
| source fingerprint (P7)                                                                                                                                                                                                 |       |
| `scripts/legacy-freeze-checksum.sql` (every table) at freeze / on restored copy: files and SHA-256, client exit status (`PIPESTATUS[0]`) of each, `legacy-freeze-checksum-verify.sh` result (`EQUAL`, base table count) | /     |
| legacy server version                                                                                                                                                                                                   |       |
| `user.Balance` column type                                                                                                                                                                                              |       |
| tables read                                                                                                                                                                                                             |       |
| SQL evidence Q1–Q7 recorded in `sql-evidence.md` (commit)                                                                                                                                                               |       |

## 3. Customers

Closure: `source = existing + created + blocked + skipped + manual review + errors`
(`reconciliation.md` C1–C3).

| source | existing | created | blocked | skipped | manual review | errors | closure holds |
| ------ | -------- | ------- | ------- | ------- | ------------- | ------ | ------------- |
|        |          |         |         |         |               |        |               |

## 4. Wallet

Equation (`reconciliation.md` W1–W8): `pre-import NEXA total + Σ legacy Balance of imported
users = post-import NEXA total`, negatives included; one opening per imported user with a
non-zero balance; no duplicate openings. **Opening balance is not revenue** (R1–R3).

| field                                          | value (minor units, currency) |
| ---------------------------------------------- | ----------------------------- |
| currency                                       |                               |
| Σ legacy Balance (all users)                   |                               |
| Σ imported / Σ not imported (skipped + review) | /                             |
| positive: count / sum                          | /                             |
| zero: count                                    |                               |
| negative: count / sum                          | /                             |
| opening entries written                        |                               |
| duplicates prevented (ALREADY_POSTED)          |                               |
| duplicate openings found (must be 0)           |                               |
| pre-import NEXA total                          |                               |
| expected post-import total                     |                               |
| actual post-import total                       |                               |
| equation holds exactly                         |                               |
| sales / revenue / payments / top-ups unchanged |                               |

## 5. Services

Closure: `candidates = adopted + already mapped + test skipped + provider missing +
ambiguous + mapping missing + product unresolved + unsupported + manual review + failed`
(`reconciliation.md` S1–S5). Adoption is not provisioning and not revenue.

| candidates | adopted | already mapped | test skipped | provider missing | ambiguous | mapping missing | product unresolved | unsupported | manual review | failed |
| ---------- | ------- | -------------- | ------------ | ---------------- | --------- | --------------- | ------------------ | ----------- | ------------- | ------ |
|            |         |                |              |                  |           |                 |                    |             |               |        |

Live invoices whose key is outside the evidenced shape (must be 0): `____`

## 6. Products

| hidden created | hidden reused | custom | unresolved (blocking adoption) |
| -------------- | ------------- | ------ | ------------------------------ |
|                |               |        |                                |

## 7. Trials

| eligible (inherit NEXA policy) | ineligible (unreadable limit) | used (consumed) | no trial | existing override kept | trial grants created by import (must be 0) |
| ------------------------------ | ----------------------------- | --------------- | -------- | ---------------------- | ------------------------------------------ |
|                                |                               |                 |          |                        |                                            |

## 8. Provider

| reads | **writes (expected 0)** | inventories complete (two identical walks) | provisioning operations in import window (must be 0) |
| ----- | ----------------------- | ------------------------------------------ | ---------------------------------------------------- |
|       |                         |                                            |                                                      |

## 9. Manual review

| reason (closed code) | user rows | invoice rows | resolution owner / plan |
| -------------------- | --------- | ------------ | ----------------------- |
|                      |           |              |                         |
| **total**            |           |              |                         |

## 10. Reconciliation

The result table of [`reconciliation.md`](reconciliation.md), every equation with its
expected and actual figure. Any `holds = no` must name its cause and its decision.

### 10a. Final report v2 — sections and invariants (Mirza PR6)

| section / invariant                                                 | version / checks                        | holds |
| ------------------------------------------------------------------- | --------------------------------------- | ----- |
| `core` (v1: C1, C3, W1, W4, W5, S3, P3)                             | schemaVersion 1                         |       |
| `inventory` (fresh, bound; UNCLASSIFIED = 0)                        | `nexa-legacy-inventory/v1` I1–I4        |       |
| `products` (rows by state, export readiness)                        | `nexa-legacy-products/v1` PR1–PR4       |       |
| `invoiceArchive` (archived = source rows + missing)                 | `nexa-legacy-invoice-archive/v1` A1–A6  |       |
| `usersWallets` (debts, conflicts, source changes reported)          | `nexa-legacy-users-wallets/v1` U1–U8    |       |
| `serviceOutcomes` (one outcome per candidate)                       | `nexa-legacy-service-outcomes/v1`       |       |
| `cutover` (approvals, prior APPLY runs, superseded sources)         | `nexa-legacy-cutover/v1` X1             |       |
| `applyRun` (`withdrawnDuringRun`, `approvalUnconfirmed`, attention) | `nexa-legacy-apply-run/v1` R1–R2        |       |
| USERS_ACCOUNTED                                                     | C1, U1                                  |       |
| INVOICES_ACCOUNTED                                                  | A1, A2, A3                              |       |
| PRODUCTS_ACCOUNTED                                                  | PR1, PR2, PR3                           |       |
| WALLETS_RECONCILED (debts and conflicts: count / Σ)                 | W1, W4, W5, U2–U8                       |       |
| SERVICES_ONE_OUTCOME                                                | serviceOutcomes, S3                     |       |
| UNRESOLVED_RETAINED                                                 | A5, history linked, debts recorded      |       |
| RERUN_NO_DUPLICATES                                                 | openings, debts, customers, services, A |       |
| **verdict** (`verdict.holds`; `failedSections`, `failedInvariants`) | AND of everything above                 |       |

### 10b. Cutover gate (`legacy-import cutover-gate`)

| step                  | result | detail (no PII) |
| --------------------- | ------ | --------------- |
| STOP_SALES_ACTIVE     |        |                 |
| FREEZE_PROOF_VERIFIED |        |                 |
| FRESH_FINGERPRINTS    |        |                 |
| TABLES_CLASSIFIED     |        |                 |
| APPROVAL_MATCHES      |        |                 |
| SOURCE_NOT_SUPERSEDED |        |                 |
| IMPORT_COMPLETED      |        |                 |
| RECONCILED            |        |                 |
| REPORT_V2_HOLDS       |        |                 |
| **verdict**           |        |                 |

## 11. Manual acceptance

The recording table of [`manual-acceptance.md`](manual-acceptance.md) § Recording, copied
with its columns (sample, seed, source ref, NEXA customer and service uuids, map decision,
customer, balance, service, panel / runtime read, Web Admin, Telegram, result, notes) and
its status vocabulary: `PASS` (only with the evidence filled in), `FAIL`, `N/A (reason)`,
`NOT RUN`, `POPULATION 0`. One row per sample; F1 once per manual-review reason; R3 and P4
are the reconciliation's manual halves.

## 12. Durations and load (staging rehearsal and production)

| stage                        | staging seconds | production seconds | notes (load) |
| ---------------------------- | --------------- | ------------------ | ------------ |
| final dump                   |                 |                    |              |
| pre-import backup            |                 |                    |              |
| audit                        |                 |                    |              |
| dry-run                      |                 |                    |              |
| import (incl. resumes)       |                 |                    |              |
| reconcile                    |                 |                    |              |
| rollback restore (rehearsal) |                 |                    |              |

## 13. Rollback

Not needed / performed. If performed: trigger, recovery request id, pre-restore backup id,
displaced database name, post-restore `diff` result, legacy resumed (yes/no), provider writes
found in the displaced database.

## 14. Errors and incidents

Every error, interruption and incident during the window, with its operational-event code
and resolution. No stack traces.

## 15. Sign-off

| role          | name | decision | time (UTC) |
| ------------- | ---- | -------- | ---------- |
| operator      |      |          |            |
| Product Owner |      |          |            |
