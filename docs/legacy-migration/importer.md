# The legacy importer (Migration P7, Items 10, 6 and 1-tooling)

**Status: built and tested against a SYNTHETIC source.** Nothing here has read the real
`oldbot` archive or a real RickPanel: those runs are manual acceptance (§10). P6 adoption
is wired by default: the container hands every eligible candidate to
`container.legacyAdoption.adoptCandidate` (§5, Adoption). Only an importer built without it
(`adoption: null`, a test seam) reports eligible candidates `ADOPTION_PENDING_P6` — never
adopted and never dropped. Production import is an owner-approval step of the cutover
runbook.

Code: `apps/api/src/legacy-import.cli.ts` and
`apps/api/src/modules/platform/legacy-importer/{application,infrastructure}/`.

## 1. CLI

```bash
pnpm legacy-import MODE --tenant TENANT --source SOURCE --target TARGET --panel-map FILE \
  [--format md|json] [--out DIR] [--inventory-page-size N] [--abort-running] \
  [--source-password-env NAME] [--allow-production-target] \
  [--evidence-class synthetic|staging|production]   # required for import, resume, report
# from source: pnpm legacy-import:dev …   (MODE may also be given as --mode MODE)
```

| argument                | meaning                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                  | `audit`, `dry-run`, `import`, `resume`, `reconcile`, `report`. Required.                                                                                         |
| `--tenant`              | tenant uuid or slug. Required; resolved in the target, refused when it matches nothing.                                                                          |
| `--source`              | `env:NAME` (a `mysql://` DSN in that variable), `mysql://USER@HOST:PORT/DB[?socket=…]` (no password), or `fixture:PATH` (a SYNTHETIC dataset). Required.         |
| `--source-password-env` | the variable holding the password for a literal `mysql://` source.                                                                                               |
| `--target`              | `env:NAME`, `postgres://USER@HOST:PORT/DB` (no password; `PGPASSWORD` honoured), or a bare database NAME that must equal the one `DATABASE_URL` names. Required. |
| `--panel-map`           | the explicit panel mapping file (§4). Required.                                                                                                                  |
| `--format`              | `md` (default) or `json`. `report --format json` prints exactly the Item 16 document (§7) on stdout.                                                             |
| `--out`                 | also write `<mode>-<time>.{json,md}` there (mode 0600).                                                                                                          |
| `--abort-running`       | with `resume`: finish the tenant's RUNNING run as ABORTED instead (the exit from a stuck run).                                                                   |

Nothing defaults. **No password is accepted on the command line** — argv is world-readable
in `/proc` and lands in shell history; a DSN with a password is refused, and so is any
`--…password` flag. Exit codes: 0 done; 3 done but a person must decide (audit BLOCKED,
reconcile DISCREPANCY, import with adoption pending — only an importer built without P6 —,
report with a failed equation); 4 an
import interrupted (the run stays RUNNING: use `resume`); 64 usage/guard refusal; 65 the
mapping or the source refused; 1 anything else (printed as a code, never a driver message
that could quote a row).

## 2. The hard production guard

Every mode is refused against a target that **looks like production** unless BOTH:

1. the flag `--allow-production-target`, and
2. `NEXA_LEGACY_IMPORT_TARGET_ACK=<16 hex>` in the environment — the acknowledgement of
   THIS host, port, database and `--tenant` value, printed by the refusal itself.

"Looks like production" = `NODE_ENV=production`, or a database name with none of the
words `staging stage rehearsal test dev scratch sandbox p4` as a whole `_`/`-` token
(`nexa` is production-like, `nexa_staging` is not). Conservative by construction: refused
unless every sign says otherwise. The acknowledgement is bound like ADR-0028's restore
confirmation, so one exported for a rehearsal cannot arm a production run and one left in
a shell profile cannot arm another tenant. A `fixture:` source is refused against a
production-like target whatever is acknowledged. The guard runs before any connection
(`production-guard.ts`, `tests/unit/legacy-importer-guard.test.ts`, mutation-checked).

### Evidence class (a mislabel is impossible)

`--evidence-class synthetic|staging|production` is required for `import`, `resume` and
`report`, and decided against the SOURCE, not against how it was named: every synthetic
dataset loads a `nexa_synthetic_fixture` table beside its rows (the fixture's own SQL, and
the `fixture:` source), which the snapshot reads in the same READ ONLY session. A source
carrying the marker is `synthetic` — a claim of `staging`/`production` is refused, and a
production-like target is refused outright, in every mode; a source without it can never
be called `synthetic`; `production` needs a production-like target. The service checks the
label again, so no caller but the CLI can bypass it. The marker also enters the fingerprint
(only when present), so a synthetic copy never fingerprints as the real rows.

`--help` / `-h` prints the usage on stdout and exits 0; a usage error exits 64 on stderr.

## 3. The source (read-only) and the fingerprint

`MysqlLegacySourceConnector` (`mysql2`, a runtime dependency of `@nexa/api`):
`SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`,
then a **probe** — `UPDATE user SET id = id WHERE 1 = 0`, which could change nothing even
if it ran — that MUST be refused (`ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`, or the
grant's own refusal); a session where it is accepted is closed (`SOURCE_NOT_READ_ONLY`).
`multipleStatements` is off; rows come from a closed table/column vocabulary; the evidence
catalogue is the only SQL passed to `aggregate`. Use the runbook's `SELECT`-only account.

Everything a run decides comes from ONE session: each table streamed once, in primary-key
byte order (`ORDER BY CAST(pk AS BINARY)`), the same order the fixture source uses.

**Fingerprint v1** = `sha256(JSON{v, schema, tables:{user,invoice,product:{rows, columns, digest}}})`:
`schema` hashes the sorted `table.column:data_type` lines; each `digest` hashes the column
header and one JSON line per row of the columns the importer READS, minus `user.number`.
Digests over whole tables reveal no row; the report prints counts and hashes only. MariaDB
and the in-memory fixture produce the same fingerprint for the same data (tested). It is
`legacy_import_runs.source_fingerprint`; a resume of a different snapshot is refused.

Row checksums (`legacy_import_map.checksum`): `user:v1` over id, Balance, limit, had-trial,
username; `invoice:v1` over the invoice's decision columns.

## 4. The panel mapping file (Item 6)

```json
{
  "format": "nexa-legacy-panel-map/v1",
  "tenantId": "<tenant uuid>",
  "panels": [{ "codePanel": "bac6", "panelId": "<NEXA RickPanel uuid>" }],
  "testPanels": ["<code>"],
  "missingPanels": ["<code searched by username across productionPanels>"],
  "productionPanels": ["<every NEXA RickPanel uuid a missing code_panel is searched across>"],
  "products": [{ "codeProduct": "<legacy code_product>", "productId": "<NEXA product uuid>" }]
}
```

`products` (optional, default `[]`) is the owner's explicit map from a legacy
`code_product` to the NEXA product an adopted service of that product renews as. It is
never inferred: a live real invoice naming a legacy product that is not listed is
`PRODUCT_UNRESOLVED` (map `MANUAL_REVIEW / PRODUCT_MAPPING_UNRESOLVED`). Codes are exact
and listed once; every target must be a product **of this tenant** before any run, and the
map is part of the fingerprint, so a resume under a different product map is refused.
Whether the target is adoptable (live, priced in the sales currency, renewal-compatible
with the account) is P6's decision, per service. Productless, custom and
unknown-product invoices need no entry: they adopt as their shape's hidden legacy product.

Strict: unknown keys (an inbound id above all) are refused; codes are exact, trimmed, no
control characters; a code is in at most one list; every mapped panel is a production
panel. Before any run every named panel must exist **in this tenant**, be `rickpanel`,
`ACTIVE` and not archived. The fingerprint is over the canonical (sorted) content, recorded
in `legacy_import_run_inputs`; a resume under a different mapping is refused. A `code_panel`
in none of the lists is `PANEL_UNMAPPED` and listed with its count in the report. Missing
`code_panel` goes through P5's matcher (exact lowercase username, complete inventories
only, case collision → review). Example: `tests/fixtures/legacy/synthetic-support.ts`.

## 5. Decisions (one pure plan; `plan.ts`, `decisions.ts`)

Customers: `user.id` not a Telegram id → `blocked` (no customer, no key: C3). Balance not a
whole number, or beyond `PAYMENT_AMOUNT_MAX_MINOR` → manual review `INVALID_SOURCE_ROW`,
nothing written. Otherwise imported: an existing `(tenant, telegram_user_id)` customer is
matched and never modified (map reason `EXISTING_CUSTOMER`), else created through the
SYSTEM_JOB insert-or-nothing (`first_bot_instance_id` NULL — they arrived through no bot —,
username kept only when it is a Telegram username, event `CustomerImported`, no consumer).
**The phone is never written**: `customers.phone_number` means "verified by an operator",
which a legacy column is not; it is classified ABSENT/VALID/INVALID for the report only.

Openings: `MigrationOpeningBalanceService.post` — positive, zero (no entry), negative
(debt). Trials: `LegacyTrialEligibilityService.preserveForImport`. Products: the hidden
legacy product of each distinct shape among live real invoices that are productless, name
a product the legacy table lacks, or are custom — `ensureShapeForImport` then
`resolveTariffMatchForImport` (MATCH only; stating a tariff is an operator's decision).

Service candidates (live invoices) fall in exactly one category, in this order:
`INVOICE_KEY_INVALID`, `TEST_INVOICE_SKIPPED`, `INVALID_SOURCE_ROW`, `ORPHAN`,
`CUSTOMER_NOT_IMPORTED`, the matcher's outcomes (`TEST_PANEL_SKIPPED`, `INVALID_USERNAME`,
`INVENTORY_INCOMPLETE`, `PROVIDER_MISSING`, `AMBIGUOUS_PANEL`, `PANEL_UNMAPPED`,
`USERNAME_CASE_COLLISION`), `UNSUPPORTED_SHAPE`, `PRODUCT_UNRESOLVED`, `ADOPTION_ELIGIBLE`.
Every decided category is recorded on the invoice's map row, as the Manual Review Queue
(Item 9) expects it: the matcher's outcomes through the queue's own translation,
`decisionForLegacyMatch` (test panel → `SKIPPED/TEST_PANEL`, invalid username →
`INVALID_SOURCE_ROW`, incomplete inventory → `INVENTORY_INCOMPLETE`, the rest by their
reason); the others by `INVOICE_MAP_DECISIONS` — live trial `SKIPPED/HISTORY_NOT_IMPORTED`,
`INVALID_SOURCE_ROW`, orphan and customer-not-imported `CUSTOMER_MISSING`,
`UNSUPPORTED_SHAPE`, `PRODUCT_MAPPING_UNRESOLVED`. Every `MANUAL_REVIEW` row carries a
closed review reason and enters review `OPEN`. **`INVOICE_KEY_INVALID` is not a row**: the
map's key CHECK cannot hold its id, so it stays a counted category, reported under that
name in the manual-review total. Eligible rows are P6's, written with the adoption.

### Adoption (P6)

Each `ADOPTION_ELIGIBLE` candidate goes to P6 with the customer, panel, exact provider
username, the product (the shape's hidden product, or the mapped `productId`), and the
account's **runtime facts from the same complete inventory walk** the match came from:
state, used/total bytes, expiry, and the time of the read. Never a second read, which
could describe a different moment. The same walk supplies the **subscription link**: the
inventory's opt-in `subscriptionLinks`, which is the shared `subscriptionFrom` (moved
from the adapter to `rickpanel-protocol.ts`, re-exported unchanged) applied to the same
list row, with no request of its own. It equals what the adapter's `lookupUser` delivers
(tested). A row with no recognisable link gives `null`, which P6 adopts safely (C3). The link is a
credential: it reaches P6 and nothing else, and the integration suite asserts it in no
report, audit row, outbox event, map, run or run-input row. If RickPanel's list route
(`OQ-P5-01`, unevidenced) turns out to carry no link fields, every link is `null`,
never a guess. P6 writes the invoice's
map row for every eligible candidate, so P7 records none of them. Outcomes are P6's union:
`ADOPTED`, `ALREADY_ADOPTED`, `MANUAL_REVIEW` (by reason, in
`services.adoption.reviewReasons`), `SKIPPED`, `FAILED` (`PROVIDER_READ_FAILED`, retried by
a rerun) and `REVIEW_CLOSED`. The final report reads the eligible invoices' map rows:
`IMPORTED` is adopted, `FAILED` is failed, `SKIPPED` and `MANUAL_REVIEW` are added to
those totals, and only an invoice with no row counts as `ADOPTION_PENDING_P6`.

**A row a person closed** (DISMISSED, or RESOLVED other than `RETRY_AFTER_FIX`) is
`REVIEW_CLOSED` to the importer: decided BEFORE any write (`resumeDecision`), counted
(`customers.reviewClosed`, `services.map.reviewClosed`, `services.adoption.REVIEW_CLOSED`),
never retried and never overwritten — even when the source row changed. A user so closed
gets no customer, opening or trial; an eligible invoice so closed is not handed to P6.
`RETRY_AFTER_FIX` invites the next run to decide again (tested both ways).

### Review subcommand (terminal only)

```bash
pnpm legacy-import review counts  --tenant T --target TARGET [--run RUN_ID]
pnpm legacy-import review list    --tenant T --target TARGET [--table user|invoice] \
     [--reason R] [--state OPEN|RESOLVED|DISMISSED] [--run RUN_ID] [--after TABLE:ID] [--limit 1..500]
pnpm legacy-import review resolve --tenant T --target TARGET --table T --legacy-id ID \
     --expected-reason R --resolution RETRY_AFTER_FIX|HANDLED_OUTSIDE_IMPORT|WILL_NOT_IMPORT|TEST_OR_INVALID_DATA|DUPLICATE_RECORD
pnpm legacy-import review reopen  --tenant T --target TARGET --table T --legacy-id ID
```

Over `LegacyReviewQueueService` (`maintenance.run`, as `SYSTEM_JOB`). `list` prints legacy
ids — a `user` row's id is a Telegram id — so the subcommand writes to stdout ONLY: `--out`
and `--format` are refused, and nothing it prints reaches a report, an audit row or an event
(the queue audits a row by its uuid). The production guard applies to its target as to
every mode. Each `resolve`/`reopen` invocation uses a fresh idempotency key.

### Actors

The CLI acts as `SYSTEM_JOB` (`legacy-import:<mode>`), which holds `maintenance.run` only.
The two services that are charged to operator permissions gained an import entry point
charged to `maintenance.run` (`preserveForImport`, `ensureShapeForImport`,
`resolveTariffMatchForImport`) — chosen by the METHOD, never by the actor's type, like
`RESOLVE_CUSTOMER_PERMISSION`. Every importer write runs `runAuthorizedMutation` with scope
activity read inside the transaction and an audit row.

## 6. Modes

- **audit** — writes nothing, not even a run row. Source + NEXA + provider (read-only
  inventory, two identical walks per panel) + the Item 1 evidence (§8) + blockers
  (currency not IRT, an incomplete inventory). Verdict `READY_FOR_DRY_RUN` / `BLOCKED`.
- **dry-run** — the whole plan on a `DRY_RUN` run row, counted by `recordDryRunDecision`
  in batched transactions; no business write.
- **import** — a new `APPLY` run; refused while one of this source is RUNNING. Phases:
  run metadata (+ inputs: schema hash, mapping fingerprint, NEXA-native wallet total) →
  customers (customer + map row in one transaction per batch, checkpointed) → openings →
  trials → products → invoice map rows → P6 adoption → finish. Every phase is idempotent
  by keys derived from the legacy identity, so…
- **resume** — continues the RUNNING run (same id: one APPLY run per cycle), requires the
  same fingerprint and mapping, and re-walks every phase; nothing is duplicated (tested:
  a crash after the openings phase, then resume: 6 openings, not 12). An error inside a
  phase leaves the run RUNNING, as a killed process does — one recovery for both.
- **reconcile** — the latest APPLY run against a fresh snapshot of the SAME fingerprint:
  wallet equation, openings sum/count/no duplicate, customers present, trial decisions,
  category closure, provider writes = 0, inventories complete. `RECONCILED`/`DISCREPANCY`.
- **report** — Item 16 (§7).

## 7. The report

Every mode prints a markdown report (aggregates only; `SYNTHETIC SOURCE — NOT EVIDENCE`
first when the source is a fixture). `report --format json` prints the document of
`docs/legacy-migration/final-report.schema.json` (schemaVersion 1, REHEARSE's): run (with
resumes counted from `legacy_import.run.resume` audit rows), source (fingerprint, digests,
server version, `Balance` type), customers, wallet, services, products, trials,
`provider.reads` / `provider.writes` (requests the read guard refused — 0 by construction),
manual review by closed reason (every `MANUAL_REVIEW` map row, user and invoice, plus
`INVOICE_KEY_INVALID` and `ADOPTION_PENDING_P6`), and the C1/C3/W1/W4/W5/S3/P3 equations.
`wallet.preImportTotalMinor` is the NEXA-native total (every entry but the openings), so
`pre + imported = expected = actual` holds even with activity after the import.

## 8. SQL evidence runner (Item 1)

`sql-evidence.ts` is a VERBATIM copy of the runbook's Q1, Q1b, Q1c (two statements), Q2,
Q2b, Q3–Q7; a unit test fails if one differs from `sql-evidence.md` by a character. `audit`
runs them inside the same snapshot as the rows, bounds every cell (64 chars, control
characters escaped), records a failed query by its engine code only, and cross-checks Q7,
Q6, Q1b (MAPPABLE rows = distinct productless shapes) and Q2b (= `decideLegacyTrial` over
every user) against the importer's own decisions. A disagreement is reported, not resolved.

## 9. Tests

- Unit: `tests/unit/legacy-importer-{decisions,guard,mapping,source}.test.ts`.
- Integration: `tests/integration/legacy-importer.test.ts` — every mode against PostgreSQL,
  two fake RickPanels on real sockets (every request a GET or the token exchange), the
  synthetic dataset; interrupted + resume; rerun; drift; discrepancy; P6 port; **real P6
  adoption** (the container default: every eligible candidate adopted, zero-total
  `LEGACY_ADOPTION` orders, no provisioning operation, a rerun `ALREADY_ADOPTED`, provider
  writes 0); permissions; stopped tenant; the CLI glue.
- **MySQL engine: `pnpm test:legacy-mysql`** (`tests/legacy-mysql/`) — read-only proof, a
  write refused even with a grant that allows it, consistent snapshot, fingerprint parity,
  every evidence query and its cross-checks, on a real MariaDB. Its own CI job
  (`legacy-mysql`, a `mariadb:10.11` service) rather than a fails-not-skips opt-in: unlike
  a real panel, a database server is something CI can provide on every pull request.
  Without `NEXA_LEGACY_MYSQL_ADMIN_DSN` it FAILS, never skips.
- Mutation-checked: the acknowledgement requirement, the READ ONLY transaction, the
  resume's mapping check, the rerun keeping a created customer's own map reason, the
  insert never touching an existing customer, an unmapped named product held for review.

Fixture: `tests/fixtures/legacy/synthetic-legacy.{ts,json,sql}` — SYNTHETIC, derived from
the public MirzaBot source (`mahdiMGF2/botmirzapanel` @ 92c0ed0676c1d0c9540bae257092104744bab1fd,
`table.php`) and the runbook's columns; `write-fixtures.ts` regenerates the committed files
and a unit test holds them equal.

## 10. Manual acceptance (needs the real archive, panels and staging)

1. Restore the archive into MySQL 8 (the CI covers MariaDB 10.11; MySQL 8 is the production
   engine and its first run is this step), create `oldbot_ro` (SELECT only).
2. `audit` against staging with the real mapping file: record the evidence and the
   cross-checks into `sql-evidence.md` in their own commit — those, not the synthetic
   figures, are Item 1's result.
3. `dry-run`, `import`, kill it, `resume`, `reconcile`, `report --format json` — the
   REHEARSE runbook (`docs/legacy-migration/rehearsal.md`).
