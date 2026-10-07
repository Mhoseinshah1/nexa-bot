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
  [--evidence-class synthetic|staging|production] \
  [--expected-fingerprint HEX] [--expected-panel-map-fingerprint HEX] \
  [--expected-inventory-fingerprint HEX] [--expected-products-fingerprint HEX] \
  [--expected-invoice-archive-fingerprint HEX] [--expected-freeze-proof-sha256 HEX] \
  [--expected-final-dump-sha256 HEX] [--cutover-gate] [--report-schema 1|2]
pnpm legacy-import cutover-gate …   # the final cutover gate, §2.2 (read-only)
# --evidence-class: required for import, resume, report
# --expected-*-fingerprint: import and resume; --expected-fingerprint is required on a production-like target
# from source: pnpm legacy-import:dev …   (MODE may also be given as --mode MODE)
```

| argument                                                                                                                                                                          | meaning                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                                                                                                                                                                            | `audit`, `dry-run`, `import`, `resume`, `reconcile`, `report`. Required.                                                                                         |
| `--tenant`                                                                                                                                                                        | tenant uuid or slug. Required; resolved in the target, refused when it matches nothing.                                                                          |
| `--source`                                                                                                                                                                        | `env:NAME` (a `mysql://` DSN in that variable), `mysql://USER@HOST:PORT/DB[?socket=…]` (no password), or `fixture:PATH` (a SYNTHETIC dataset). Required.         |
| `--source-password-env`                                                                                                                                                           | the variable holding the password for a literal `mysql://` source.                                                                                               |
| `--target`                                                                                                                                                                        | `env:NAME`, `postgres://USER@HOST:PORT/DB` (no password; `PGPASSWORD` honoured), or a bare database NAME that must equal the one `DATABASE_URL` names. Required. |
| `--panel-map`                                                                                                                                                                     | the explicit panel mapping file (§4). Required.                                                                                                                  |
| `--format`                                                                                                                                                                        | `md` (default) or `json`. `report --format json` prints exactly the Item 16 document (§7) on stdout.                                                             |
| `--out`                                                                                                                                                                           | also write `<mode>-<time>.{json,md}` there (mode 0600), AFTER the report is printed. A failure to write is exit 73 (§1.2), never an audit failure.               |
| `--inventory-page-size`                                                                                                                                                           | rows per RickPanel list page, 1–200. **Default here: 200**, the reader's maximum (`INVENTORY_MAX_PAGE_SIZE`); see §1.1. The library default (50) is unchanged.   |
| `--abort-running`                                                                                                                                                                 | with `resume`: finish the tenant's RUNNING run as ABORTED instead (the exit from a stuck run).                                                                   |
| `--expected-fingerprint`                                                                                                                                                          | `import`/`resume`: the source fingerprint the owner approved (64 lowercase hex, as `audit` prints it). **Required against a production-like target** (§2.1).     |
| `--expected-panel-map-fingerprint`                                                                                                                                                | `import`/`resume`: the same, for the panel mapping file's fingerprint (as `audit` prints it). Optional.                                                          |
| `--expected-inventory-fingerprint`, `--expected-products-fingerprint`, `--expected-invoice-archive-fingerprint`, `--expected-freeze-proof-sha256`, `--expected-final-dump-sha256` | `import`/`resume` (Mirza PR6): the other five values a cutover approval binds. Required, with the two above, wherever the cutover gate applies (§2.2).           |
| `--cutover-gate`                                                                                                                                                                  | `import`/`resume`: apply the cutover gate on a target that is not production-like (a staging rehearsal of it). A production-like target is always gated.         |
| `--report-schema`                                                                                                                                                                 | `report`: `2` (default) prints the final report version 2 with `--format json`; `1` prints the closed v1 document alone (§7).                                    |

Nothing that decides what is imported defaults (the page size is a walk-length knob, §1.1). **No password is accepted on the command line** — argv is world-readable
in `/proc` and lands in shell history; a DSN with a password is refused, and so is any
`--…password` flag — in the `review` subcommand too (`legacy-import-argv.ts`, one rule).
Exit codes: 0 done; 3 done but a person must decide (audit BLOCKED, reconcile DISCREPANCY,
import/resume `COMPLETED_WITH_FAILURES` — anything unapplied, failed or in conflict, §6 —,
import with adoption pending — only an importer built without P6 —, report with a failed
equation); 4 an
import interrupted (the run stays RUNNING: use `resume`); 64 usage/guard refusal; 65 the
mapping or the source refused; 73 the report was computed and printed but `--out` could not
be written (§1.2); 1 anything else (printed as a code, never a driver message
that could quote a row). The process exits in ONE place, after stdout and stderr have
drained (`exitAfterDrain`): `main` returns its code, so the container is always shut down,
and a large report piped to a slow reader arrives whole (tested; a bare `process.exit()`
cut it at 64 KiB).

### 1.1 Inventory page size (hardening 2026-10-07)

Every production panel is read with TWO consecutive full walks that must agree
(`RickpanelInventoryReader.listAll`); a walk during which the panel's reported total moves
is `TOTAL_CHANGED`, the inventory is incomplete, and audit is **BLOCKED** (exit 3). That
fail-closed rule is unchanged, and nothing retries it: the walk stops at the first
inconsistency and the operator re-runs deliberately.

What changed is how long the walk takes. On a large LIVE panel, a long walk is likelier to
see a change. The real Mirza rehearsal (staging copy, real RickPanel, read-only) measured:

| `--inventory-page-size` | provider reads | audit verdict               |
| ----------------------- | -------------- | --------------------------- |
| 50 (old default)        | ~500           | `BLOCKED` (`TOTAL_CHANGED`) |
| 200                     | ~130           | `READY_FOR_DRY_RUN`         |

So the CLI now asks for **200 rows per page when the flag is omitted** — the reader's own
maximum, imported as `INVENTORY_MAX_PAGE_SIZE`, so the default and the bound cannot drift.
An explicit `--inventory-page-size N` (digits only, 1–200) still overrides; anything else is
a usage error (exit 64). The generic reader's default (50) is unchanged for every other
caller (discovery, the rehearsal's panel-state walk).

The size walked is recorded in every mode's report: `sections.provider.inventoryPageSize`
(what the walk asked for, from the adapter), and `invocation.inventoryPageSize` with
`invocation.inventoryPageSizeSource` = `CLI_DEFAULT` | `OPERATOR` (also a row in the
markdown header). It is deliberately NOT a run input and NOT in any fingerprint: a complete
inventory is the same index at any page size, so a resume after a different page size is
not a different import. The `report` mode's Item 16 document (§7) has a closed schema and is
unchanged.

**For a real rehearsal or cutover, use 200** (omit the flag). A smaller value is only for
diagnosing a panel that refuses large pages (`PAGE_TOO_LONG`, or a response over the
client's cap).

### 1.2 Writing reports from a container

The report is printed to stdout FIRST; `--out` is attempted only afterwards. If writing
there fails (EACCES, EPERM, EROFS, ENOENT, ENOSPC …), the CLI prints `REPORT NOT WRITTEN
(exit 73)` with the mode, the verdict that WAS computed, the path, the errno code (never the
driver's message), any file already written, and the remedy — and exits **73**, distinct
from a source, mapping or audit failure. The verdict stands; only the file is missing.

The image runs as `node` (**uid 1000**, `Dockerfile` `USER node`) and must not be run as
root to get around this. Two container-safe patterns:

```bash
# 1. Preferred: no --out at all; capture stdout ON THE HOST (the shell redirect runs as you).
docker run --rm … IMAGE node /app/dist/legacy-import.cli.js audit … --format json \
  > /host/writable/path/audit.json
# (the cutover runbook's `p7 audit | tee audit.txt` is the same pattern)

# 2. A host directory owned by uid 1000, mounted, and named with --out.
sudo install -d -o 1000 -g 1000 -m 700 /srv/nexa-legacy-reports
docker run --rm … -v /srv/nexa-legacy-reports:/results IMAGE \
  node /app/dist/legacy-import.cli.js audit … --format json --out /results
```

A plain `-v /some/root-owned/dir:/results` fails with EACCES: the directory is owned by
root and the process is uid 1000.

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

### 2.1 The approved source (`--expected-fingerprint`)

The owner approves ONE source: the fingerprint `audit` prints (`source.fingerprint`, and
`panelMapping.fingerprint` for the mapping). `import` and `resume` take it back as
`--expected-fingerprint HEX` (and optionally `--expected-panel-map-fingerprint HEX`), and
compare it with the snapshot actually read — in the same READ ONLY session the import uses —
before any write. A mismatch is refused with **exit 65** and a message naming both values,
and nothing is written (tested: zero runs, map rows, customers, wallet entries or shapes;
mutation-checked). The mapping comparison happens before the source is even opened.

Against a **production-like target** the flag is **required**: an import without it is a
usage error (64) before the source is opened, so the owner's approval is enforced
technically, not by the runbook alone. On staging and synthetic runs it is optional but
**strongly encouraged**: pass the fingerprint from the audit you reviewed, so a source
that changed between audit and import is refused rather than imported.

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

### 3.1 The v1 import read set is frozen; everything else is a versioned read set (Mirza PR1)

Everything that feeds v1 lives in ONE deep-frozen object, `IMPORT_READ_SET_V1`
(`source-port.ts`): the version string, tables, primary keys, required and optional columns,
and the not-fingerprinted column. `LEGACY_SOURCE_TABLES` and the other old names are its
members. `tests/unit/legacy-import-read-set-v1.test.ts` pins the following literally:

- the synthetic v1 fingerprint, its schema hash, every table digest and the unmarked form;
- the object itself.

So adding a column or a table to the import read set fails CI. It cannot silently void an
approval. If v1 must ever change, it becomes `legacy-source-fingerprint:v2` with an owner
decision.

Any other read of the legacy database is a **versioned read set** (`read-set.ts`):

- `defineLegacyReadSet({ name, version, tables })` defines it; each table entry is
  `{ table, primaryKey, columns, optionalColumns }`. Every table must be one the catalogue
  lets a read set read: `SUPPORTED` or `ARCHIVE`
  (`packages/contracts/src/legacy-inventory.ts`). The adapter refuses rows of any other
  table as well (`SOURCE_TABLE_NOT_READABLE`).
- Its fingerprint, `legacy-read-set:<name>:v<n>`, is
  `sha256(JSON{v, [synthetic], schema, tables:{…}})`. `schema` covers every column of the
  read set's tables, and each digest is v1's `TableDigest` over the allowlisted columns,
  read in v1's `ORDER BY CAST(pk AS BINARY)` order.
- `readLegacyReadSet(session, def)` is the digest-only read: one pass, no row delivered,
  the read set fingerprint to approve. With `{ expectedFingerprint }` it also refuses
  (`READ_SET_FINGERPRINT_MISMATCH`) unless the result equals it.
- `readLegacyReadSet(session, def, { expectedFingerprint, onBatch, batchSize })` delivers
  rows, and verification precedes every side effect. `expectedFingerprint` (the operator's
  `--expected-<set>-fingerprint`) is REQUIRED with `onBatch`; without it the call is
  refused before any read. In the same session (the same READ ONLY snapshot) it:
  1. runs a digest-only pass and compares it with `expectedFingerprint`; a mismatch is
     refused with `READ_SET_FINGERPRINT_MISMATCH` and `onBatch` is never called;
  2. runs the delivery pass, streaming rows to `onBatch` at most `batchSize` at a time
     (default 1000, maximum 5000), and recomputes the digest as it goes. If the result
     differs from pass 1, the call fails with `READ_SET_SNAPSHOT_DIVERGED` after the last
     batch. So a consumer that writes must do it in a transaction that this error rolls
     back.

  Each pass awaits each batch before reading on and keeps no rows itself. A test proves
  that no row is read ahead of the batch being handed over. The v1 binding below does not
  cover a read set's own tables and columns, which is why delivery needs the read set's
  own approved value as well.

- `withBoundReadSetSession(connector, approvedV1, work)` opens one READ ONLY session and
  recomputes the v1 fingerprint in it (`readImportV1Identity`, the same walk as
  `readFromSession`, with no row kept). It refuses with `SOURCE_FINGERPRINT_MISMATCH` unless
  the result equals the approved value, and only then hands that same snapshot to `work`.
  Approval stays one value for the source; each read set prints its own fingerprint for its
  own `--expected-<set>-fingerprint`.
- An observation is recorded in `legacy_read_set_runs` (migrations 0219 and 0220):
  - append-only;
  - one row per (tenant, read set, version, read-set fingerprint, source fingerprint);
  - read set names pinned by `LEGACY_READ_SET_NAMES`;
  - never in `legacy_import_run_inputs`, which is per APPLY run and compared on resume.

The first read set is `inventory` (below). The second is `products` (Mirza PR2,
`legacy-read-set:products:v1`, below). `invoice-archive` (PR3) adds its definition, its name
in `LEGACY_READ_SET_NAMES` (a contract change) and the CHECK's widening the same way.

## 4. The panel mapping file (Item 6)

```json
{
  "format": "nexa-legacy-panel-map/v1",
  "tenantId": "<tenant uuid>",
  "panels": [{ "codePanel": "bac6", "panelId": "<NEXA RickPanel uuid>" }],
  "testPanels": ["<code>"],
  "missingPanels": [
    "<a code the operator DECLARES missing: searched by username across productionPanels>"
  ],
  "unresolvedPanels": [{ "codePanel": "<code>", "reason": "OWNER_DECIDES_LATER" }],
  "productionPanels": ["<every NEXA RickPanel uuid a declared-missing code is searched across>"],
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
in none of the lists is `PANEL_UNMAPPED` and listed with its count in the report — as a
key only if a mapping file could name it (the file's own code rule); any other source value
is counted under `(invalid code_panel)` and never echoed. A code listed in `missingPanels`
goes through P5's cross-panel search (exact lowercase username, complete inventories only,
case collision → review). **An empty or NULL `code_panel` is never searched** (owner
decision 8, Mirza PR5): it is `NO_PANEL` — map `MANUAL_REVIEW / PANEL_UNMAPPED` — and only an
operator's explicit ADOPT approval naming a mapped panel may adopt it
([`service-review.md`](service-review.md)). Panel 8255, or any code nobody has decided, is
never guessed: declare it in `unresolvedPanels` (`OWNER_DECIDES_LATER`) until the owner maps it
explicitly in `panels` (service-review.md §1). Example: `tests/fixtures/legacy/synthetic-support.ts`.

**Completeness (WP-D2, G10).** `unresolvedPanels` (optional) is how a live `code_panel`
nobody has decided yet is _declared_ rather than forgotten: `{codePanel, reason}`, with the
reason one of `OWNER_DECIDES_LATER`, `DECOMMISSIONED_PANEL`, `UNKNOWN_ORIGIN` and no other
key. A declared code is in no list the matcher reads, so its invoices stay `PANEL_UNMAPPED`
manual review exactly as before; it is exclusive with the other lists, and it enters the
fingerprint only when non-empty — every v1 map written before it keeps its fingerprint
(pinned by a unit test). `audit` reports `sections.panelMapping.completeness`:

- `unmapped` — live REAL invoices' codes in no list, with counts. **Non-empty makes the
  audit `BLOCKED`**, with a blocker naming each code and count. Source values no file could
  name are counted under `(invalid code_panel)`, and that exact key may be declared.
- `declaredUnresolved` — each declared code, its reason, and its live real invoices.
- `stale` — codes the map names that no live invoice carries (a typo, a retired panel).
- `productionPanelsUnreferenced` — production panels no mapped code with a live real
  invoice points at (they may still serve the missing-panel search).

The rehearsal turns `complete` into the check `panel_map_complete`.

## 5. Decisions (one pure plan; `plan.ts`, `decisions.ts`)

Customers: `user.id` not a Telegram id → `blocked` (no customer, no key: C3). Balance not a
whole number, or beyond `PAYMENT_AMOUNT_MAX_MINOR` → manual review `INVALID_SOURCE_ROW`,
nothing written. Otherwise imported: an existing `(tenant, telegram_user_id)` customer is
matched and never modified (map reason `EXISTING_CUSTOMER`), else created through the
SYSTEM_JOB insert-or-nothing (`first_bot_instance_id` NULL — they arrived through no bot —,
username kept only when it is a Telegram username, event `CustomerImported`, no consumer).
**The phone is never written**: `customers.phone_number` means "verified by an operator",
which a legacy column is not; it is classified ABSENT/VALID/INVALID for the report only.

Duplicate source ids (Mirza PR4): a Telegram id on more than one `user` row is
`DUPLICATE_SOURCE_ID` — which row's balance is the customer's is unknowable, so none is
imported: no customer, no opening, no debt, and ONE manual-review row (`INVALID_SOURCE_ROW`)
whose checksum is order-free over every row of that id, so a rerun with the rows in another
order writes nothing. The legacy `user.id` PK makes this impossible in a sane dump; the plan
fails closed anyway. The final report's C1 adds the extra rows back (`duplicateSourceIds`).

Legacy agents (`user.agent`): counted (`plan.customers.agents`, `usersWallets.users.agents`)
and imported as ORDINARY customers — never a reseller row, a tier or credit (there is no
reseller credit). Whether a legacy agent becomes a NEXA reseller is the owner's
(`OQ-LWD-03`). The agent value itself is not persisted per customer (it is in the source
dump and the v1 user digest); the v1 read set is frozen, so no other `user` column is read.

Openings: `MigrationOpeningBalanceService.post` — positive (one CREDIT), zero (no entry),
negative: **a legacy debt, never a ledger entry** (owner decision 6, Mirza PR4;
`docs/migration-opening-balance.md` §Negative balances). The importer passes the run, the
v1 fingerprint, the row checksum and the synthetic flag as the debt's provenance. The plan
reads both the openings and the debts already recorded: `POST`, `ALREADY_POSTED`,
`ZERO_NO_ENTRY`, `RECORD_DEBT`, `DEBT_ALREADY_RECORDED`, `PRIOR_DEBIT_OPENING` (a DEBIT
the code before the decision wrote — never rewritten, never doubled; counted in
`attention.priorDebitOpening`, so the verdict is `COMPLETED_WITH_FAILURES`) or `CONFLICT`
(a figure other than the recorded one, in amount, sign or evidence class). Trials: `LegacyTrialEligibilityService.preserveForImport`. Products: the hidden
legacy product of each distinct shape among live real invoices that are productless, name
a product the legacy table lacks, or are custom — `ensureShapeForImport` then
`resolveTariffMatchForImport` (MATCH only; stating a tariff is an operator's decision).
Every run resolves every shape again (the key is per run), so a public tariff that changed
since the last run refreshes the hidden product's price. The #177 rules are the shape
service's: purchasable tariffs only, and no tariff or several leave a RESOLVED shape as it
is (reported in `products.tariff`, never withdrawn here). A tariff an operator STATED is
never overwritten by a match (`OPERATOR_STATED_KEPT`).

Service candidates (live invoices) fall in exactly one category, in this order:
`INVOICE_KEY_INVALID`, `TEST_INVOICE_SKIPPED`, `INVALID_SOURCE_ROW`, `ORPHAN`,
`CUSTOMER_NOT_IMPORTED`, the matcher's outcomes (`TEST_PANEL_SKIPPED`, `INVALID_USERNAME`,
`INVENTORY_INCOMPLETE`, `NO_PANEL`, `PROVIDER_MISSING`, `AMBIGUOUS_PANEL`, `PANEL_UNMAPPED`,
`USERNAME_CASE_COLLISION`), `UNSUPPORTED_SHAPE`, `PRODUCT_UNRESOLVED`, `ADOPTION_ELIGIBLE` —
then the ownership rule (Mirza PR5): eligible invoices of different legacy owners claiming one
account are all `AMBIGUOUS_OWNERSHIP` (map `CONFLICTING_EXISTING_ENTITY`). `NO_PANEL` is
recorded as `MANUAL_REVIEW / PANEL_UNMAPPED`. Each live invoice's ONE outcome, its evidence and
its review are on `legacy_service_candidates` ([`service-review.md`](service-review.md)).
`is_custom` is read before the product, by the shape key's own parser (`legacyCustomFlag`):
a value outside 0/1 is `UNSUPPORTED_SHAPE / IS_CUSTOM_INVALID` on every path, never a named
product decided on a flag nobody read.
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

### Service outcomes and the operator's review (Mirza PR5)

Every APPLY run records each live invoice's ONE outcome (`LEGACY_SERVICE_OUTCOMES`) with its
evidence on `legacy_service_candidates`, linked to the invoice archive revision (run
`invoices-read` first). The Web Admin page `/legacy-services` (`legacy.services.view` MEDIUM;
decisions `legacy.services.decide` HIGH, owner-only by default) lists them by outcome, review
state, panel and product, and records ACKNOWLEDGE, KEEP_AS_HISTORY, reopen and the explicit
ADOPT approval. No CLI flag was added: an approval is executed by the next `import` or
`resume` against the inventory that run walks — gate (synthetic on a production-like target is
left untouched), claim, every adoption check again, P6, settle. A candidate kept as history is
never handed to P6 (P6 also re-reads it under the invoice lock). Details, the report section and
the NOT RUN list: [`service-review.md`](service-review.md).

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

### Inventory subcommand (read-only)

```bash
pnpm legacy-import inventory --tenant T --source SOURCE --target TARGET \
     [--expected-fingerprint HEX] [--format md|json] [--source-password-env NAME] [--allow-production-target]
```

It lists every table of the legacy database: name, class from the reviewed catalogue,
column count, a hash of its sorted `name:data_type` lines, the exact `COUNT(*)` inside the
snapshot (never `TABLE_ROWS`), storage engine, charset, collation and text-column charsets.
It never prints a row value. It also prints the `legacy-read-set:inventory:v1` fingerprint,
the v1 import fingerprint check, and the freeze-proof statement (`CHECKSUM TABLE` over
every base table). See `docs/legacy-migration/table-inventory.md`.

`--panel-map` and `--out` are refused, and so is any password on argv; capture stdout
instead.

What it writes depends on the fingerprint:

- With `--expected-fingerprint` equal to the v1 fingerprint the same session recomputes,
  the inventory's fingerprint is recorded in `legacy_read_set_runs`. The write is
  insert-or-nothing, audited as `legacy_import.read_set.record`, under `maintenance.run`,
  and refused for a stopped tenant. That row and its audit row are the only writes, tested
  over every table.
- Without the flag nothing is written and the verdict is `FINGERPRINT_UNBOUND`.
- A mismatch is refused before any table is counted (exit 65).

A SYNTHETIC-marked source is never recorded against a production-like target.

The verdict fails closed. Exit 0 means `COMPLETE`. Exit 3 means `UNCLASSIFIED_TABLES`,
`BLOCKED` (a view, or a name no statement can carry) or `FINGERPRINT_UNBOUND`.

### Products subcommands (the legacy product review, Mirza PR2)

```bash
pnpm legacy-import products-read --tenant T --source SOURCE --target TARGET \
     --expected-fingerprint HEX [--expected-products-fingerprint HEX] [--batch-size N] \
     [--format md|json] [--source-password-env NAME] [--allow-production-target]
pnpm legacy-import products-export --tenant T --target TARGET \
     --expected-products-fingerprint HEX [--panel-map FILE] [--allow-production-target]
```

`products-read` reads the legacy `product` table through the `products` read set
(`products-read-set.ts`: `id`, `code_product` required; the public MirzaBot and `mirza_pro`
product columns optional and kept verbatim; never `inbounds` or `proxies`) into
`legacy_product_reviews` (`docs/legacy-product-review-design.md` §13):

- `--expected-fingerprint` (the approved v1 value) is always required: the session that
  reads the products recomputes v1 and refuses a mismatch before reading a product row.
  Reading products never changes v1 (unit test against the pinned synthetic value).
- Without `--expected-products-fingerprint` it prints the products fingerprint for the
  owner to approve and writes NOTHING (exit 3).
- With it, under the importer's per-tenant claim, PR1's verified delivery refuses a
  different products fingerprint before any row is delivered; the rows are written only
  after the delivery pass reproduced it, in batched transactions (`maintenance.run`,
  scope activity read inside, audited). Codes absent from the read are marked; the run is
  recorded in `legacy_read_set_runs`. Re-reading the same source writes no review row.
- A decided row whose facts changed — or whose code vanished — becomes `SOURCE_CHANGED` and
  stops exporting until an operator decides again. Nothing is ever re-approved silently.
- A SYNTHETIC source is refused against a production-like target before any write.

Decisions are made in the Web Admin (`/legacy-products`, `legacy.products.view` /
`legacy.products.decide`; approve-as-new also `catalog.edit`) — never through the importer's
terminal-only review queue, which stays unreachable from every surface.

`products-export` is read-only. It prints the `products` section of the panel map from rows
approved against the facts the APPROVED products read saw (`--expected-products-fingerprint`),
and refuses (`legacy_product_review.not_in_state`, exit 1) when the review does not reflect
that read. With `--panel-map FILE` it prints the whole map with `products` replaced
(hand-written entries for codes the review has no row for are kept) and the map's NEW
fingerprint on stderr; a hand-written entry that contradicts a review row is refused (65).
The importer still reads only the map file, bound by `--expected-panel-map-fingerprint`:
the owner approves the new map exactly as before. An approved-as-new draft is INACTIVE and
unpriced, so P6 leaves its services `PRODUCT_MAPPING_UNRESOLVED` until the owner prices and
activates it — the intended order.

### Invoice archive (`invoices-read`, Mirza PR3)

```bash
pnpm legacy-import invoices-read --tenant T --source SOURCE --target TARGET \
     --expected-fingerprint HEX [--expected-invoice-archive-fingerprint HEX] \
     [--batch-size N] [--format md|json] [--source-password-env NAME] [--allow-production-target]
```

Every legacy `invoice` row — every status, every key shape — is kept as read-only HISTORY in
the append-only `legacy_invoice_archive` (migrations 0223–0225). Nothing archived ever
becomes an order, a payment, a wallet entry, a service, a provisioning operation or
revenue, and no report reads the archive (`tests/unit/legacy-invoice-archive-boundary.test.ts`,
and the integration test's every-table fingerprint: an approved read changes only
`legacy_invoice_archive`, `legacy_invoice_archive_runs`, `legacy_read_set_runs` and
`audit_logs`).

**The read set** — `legacy-read-set:invoice-archive:v1` (`invoice-archive-read-set.ts`):

- `invoice`: the v1 import read set's twelve required columns, plus, when present,
  `Service_location`, `time_sell`, `name_product`, `note`, `refral`, `time_cron`,
  `notifctions` (named by `mahdiMGF2/botmirzapanel` @ 92c0ed06 `table.php` and
  `mahdiMGF2/mirza_pro` @ 8e551ecf `db/tables/invoice.php`);
- **never read**: `user_info` (the fork writes the panel's `subscription_url` into it),
  `uuid` (an account UUID), `bottype` (the fork stores a reseller sub-bot's BOT TOKEN in it),
  nor any other column. The excluded values never reach PostgreSQL, a report, a log or an
  audit row (integration + engine tests seed recognisable markers in them);
- `user`: `id` only (owner detection); `product`: `id`, `code_product` only.

Reading it never changes the v1 fingerprint (unit test against the pinned synthetic value).
An absent optional column is simply not read.

**Approval and refusal.** `--expected-fingerprint` is always required: the session that
reads the archive recomputes v1 first. Without `--expected-invoice-archive-fingerprint` the
command prints that fingerprint for the owner and writes NOTHING (exit 3). With it, PR1's
verified delivery refuses another fingerprint before any row is delivered (exit 65, nothing
written — not even a run row). A SYNTHETIC source is refused against a production-like
target before any write — and so is a SYNTHETIC run left open in the target (a restored or
promoted staging database): it would otherwise be resumed from what it stored, without the
source. It is neither promoted nor discarded there (`SYNTHETIC_RUN_ON_PRODUCTION_TARGET`,
exit 65, nothing written, the source not opened); a person investigates how it got there.
The report lists the `invoice` columns the read actually delivered (its table evidence),
never the allowlist; a run finished without reading claims none.

**All-or-nothing without one transaction, in bounded memory (the STAGING design).** The
MySQL source refuses to run inside a PostgreSQL transaction, and a read may still fail after
its last batch (`READ_SET_SNAPSHOT_DIVERGED`). PR2 holds a delivered read in memory until it
has been verified; that is right for 64-ish products and wrong for 10^5+ invoices. Here:

1. The run row (`legacy_invoice_archive_runs`, state `STAGING`) is created by the FIRST
   delivered batch — pass 1's verification precedes it, so a mismatch writes nothing.
2. Each delivered batch is ONE transaction into `legacy_invoice_archive_staging` (scratch
   rows keyed by run, table and key; memory is one batch). A key staged twice is
   `SOURCE_KEY_DUPLICATED`; a NUL character, or an indexed cell over 1000 characters, is
   `CELL_UNREPRESENTABLE`.
3. Any error during the read (divergence, a refused batch, a lost claim, a stopped tenant)
   FAILS the run and deletes its staging. A process that dies leaves `STAGING`; the next
   invocation fails it as `ABANDONED` first. Nothing of either read is ever archived.
4. After the read returned, `verifyRun` requires the staged counts to equal the read's
   exact counts per table AND the v1 identity's invoice count (`STAGED_COUNT_MISMATCH`
   otherwise) → `VERIFIED`.
5. Promotion: batches of at most 1000 staged invoices, each ONE transaction that classifies,
   normalises, decides each revision and advances `promoted_through` conditionally on where it
   was. A crash resumes at the cursor; the next invocation finishes a `VERIFIED` run FIRST,
   from staging, without the source — and when it is the approved read, without reading the
   source again.
6. `completeRun` asserts the closure (below), marks `COMPLETED` — only now are the run's
   revisions visible — and deletes the staging.

A resumed read is a fresh read (the approval has to be proven over the whole snapshot in the
new session), but staging writes are cheap and promotion is resumable. Measured on the
synthetic fixture with 130,024 invoices (batch 500, local PostgreSQL 16): one approved
ingest end to end in about 56 s. A dated, synthetic figure — not an expectation.

**Revisions, never updates.** Keyed by (tenant, `id_invoice` exactly as read, revision), with
no key-shape CHECK: an id the import map refuses (`INVOICE_KEY_INVALID`) is archived with
`key_shape_evidenced = false`. A newer snapshot appends revision n+1 only when
`archive_checksum` (the cells AND their source-derived context: owner present, product
named) differs — `ROW_CHANGED` or `CONTEXT_CHANGED` — and writes nothing for an identical
invoice. An invoice the newer snapshot no longer has stays archived and is counted
(`missing_in_snapshot`). UPDATE and DELETE are refused by triggers for every role (0224).

**Each revision** keeps the raw cells verbatim (`raw_row`), the validated normalised fields —
legacy user id, username, `panel_code` (trimmed; blank is NULL), `product_code` (trimmed) and
its reference to the legacy product table, `Status` and `live` (exact compare with the
importer's live statuses), `is_test` (1/0 only), the historical price as raw text AND whole
Toman as IRT minor units (owner decision 7; the product review's one grammar; anything else
NULL with a closed note), `time_sell` raw AND parsed only as unix seconds within
[2015, 2100) — the public sources write `time()`; any other format is `FORMAT_UNKNOWN` — and
its provenance: the v1 source fingerprint, the read-set fingerprint, the run.

**Classification** (source-derived only; first match wins; the archive's CHECK restates the
order so a row whose class disagrees with its facts cannot be written):

| Class                    | Rule                                                                              | Importer equivalent                                     |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `KEY_SHAPE_UNRECOGNISED` | `id_invoice` outside `LEGACY_ID_PATTERNS.invoice`                                 | `INVOICE_KEY_INVALID` (no map row)                      |
| `TEST`                   | `is_test` = 1                                                                     | `TEST_INVOICE_SKIPPED` / `SKIPPED HISTORY_NOT_IMPORTED` |
| `TEST_FLAG_INVALID`      | `is_test` neither 0 nor 1                                                         | `INVALID_SOURCE_ROW`                                    |
| `ORPHAN_OWNER`           | `id_user` NULL or not in the snapshot's `user` table — kept, never given an owner | `ORPHAN` / `CUSTOMER_MISSING`                           |
| `NOT_LIVE`               | `Status` not a live status                                                        | — (the importer never decides it)                       |
| `NO_PANEL`               | live, `code_panel` NULL or blank — owner decision 8: never adopted automatically  | — (see OQ-LIA-02)                                       |
| `LIVE_CANDIDATE`         | every source-derived check holds                                                  | the importer's adoption outcome (PR5)                   |

For a live invoice the first four are exactly `decideServiceCandidate`'s source-only steps,
in its order (`tests/unit/legacy-invoice-archive-domain.test.ts` cross-checks every live
synthetic invoice). Outcomes that need the panel map or the live inventory —
`PANEL_UNMAPPED`, `PROVIDER_MISSING`, `PRODUCT_UNRESOLVED`, `AMBIGUOUS_PANEL`,
`ADOPTION_ELIGIBLE`, `CUSTOMER_NOT_IMPORTED` — are NOT stored here; they are the importer's,
and PR5's review workflows. The archive's detail view shows the importer's map row for the
key (status, reason, review state: codes only) when one exists.

**Reconciliation — every source invoice accounted for.** Per COMPLETED run, enforced by the
run's CHECK and printed by the command:

    inserted_new + inserted_revision + unchanged = promoted_rows = source_invoice_rows
    archive_invoices_after = source_invoice_rows + missing_in_snapshot

and `source_invoice_rows` is both the read set's and the v1 identity's exact `invoice` count
in the same snapshot. Check a run by hand:

```sql
SELECT id, state, source_invoice_rows, inserted_new, inserted_revision, unchanged,
       missing_in_snapshot, archive_invoices_after, read_set_fingerprint, source_fingerprint
  FROM legacy_invoice_archive_runs WHERE tenant_id = :tenant ORDER BY started_at;
SELECT count(DISTINCT invoice_key) FROM legacy_invoice_archive WHERE tenant_id = :tenant;
```

**Web Admin** `/legacy-invoices` (under Sales, beside the legacy product review), read-only:
keyset pages of the latest visible revision per invoice; filters for invoice id (prefix),
legacy user id, username (prefix, case-insensitive), status, panel code, product code,
class and test flag, each served by a tenant-led index (`legacy-invoice-archive-plan.test.ts`
asks the planner at 200,000 synthetic rows); a detail with the raw cells, every revision,
the importer outcome and the provenance; a summary of counts by class and the recent runs
(no id or username). `legacy.invoices.view` (MEDIUM; never an observer's) redacts
`id_user`, `username`, `refral` and `note`; `legacy.invoices.pii.view` (HIGH) shows them and
is required to SEARCH by them. Every reveal is audited (`legacy.invoice_archive.pii_view`):
an unredacted detail, and every unredacted LIST page (its row ids, count and filter NAMES —
never a value); a search by personal data is also audited (`pii_search`, filter names), and a
refused one `DENIED`. Owner-only by default (0225). The invoice id, owner id, username and
status filters compare exactly as typed (a legacy id `padded` keeps its spaces); the panel
and product codes, stored trimmed, are trimmed. The keyset cursor is sized for the longest
archivable key (1000 code points).

### 2.2 The cutover gate: the owner's approval in the database (Mirza PR6)

Owner constraint 3: the final cutover needs a fresh source fingerprint, explicit owner
approval bound to it, financial reconciliation and a controlled write freeze. The approval
is a ROW (`legacy_cutover_approvals`, migrations 0232–0234), recorded by the authenticated
owner in the Web Admin (`/legacy-cutover`; `legacy.cutover.view` MEDIUM to read,
`legacy.cutover.approve` CRITICAL and owner-only to record or revoke). Why the Web Admin and
not a CLI flag: the production-target acknowledgement (§2) is a statement about WHERE the
CLI writes, so an env/flag pair fits it; an approval is a statement about WHO consented, and
the CLI's `SYSTEM_JOB` actor could only type a name. PR5's ADOPT approval set the pattern:
the owner records it in the Web Admin; the importer reads it under `maintenance.run`.

An approval binds SEVEN exact values — source, panel map, the inventory, products and
invoice-archive read sets, the freeze proof file's SHA-256 and the final dump's SHA-256 —
and is refused unless each read set is RECORDED in `legacy_read_set_runs` for that source
(their evidence class becomes the approval's `synthetic`). It is append-only (no UPDATE,
no DELETE, any role) and is withdrawn by an append-only revocation. Idempotent: a replay
returns the original answer; an identical unrevoked approval is `ALREADY_APPROVED`. Audited,
DENIED too; fingerprints only.

**Where the gate applies** — `import`/`resume` against a production-like target, always
(`cutoverGateOf`: an explicit `productionLikeTarget: true` with no expectation is refused as
incomplete, never skipped), and anywhere with `--cutover-gate`. There, before any write:

1. every one of the seven `--expected-*` values was given (`EXPECTATION_INCOMPLETE`, checked
   before the source is opened);
2. the inventory, products and invoice-archive read sets are re-read by sessions bound to
   the source: no table is UNCLASSIFIED (`TABLES_UNCLASSIFIED`) and each fingerprint is the
   expected one (`APPROVAL_MISSING`);
3. inside the run's START transaction, the one evaluator (`decideCutoverImport`): an
   unrevoked CUTOVER approval matches all seven values (`APPROVAL_MISSING`); a synthetic
   approval never opens a production-like target, and on any target its evidence class is
   the snapshot's (`APPROVAL_SYNTHETIC`); each read set it names is still recorded for the
   source;
4. **`SOURCE_SUPERSEDED`** — every DIFFERENT source fingerprint of a finished (COMPLETED,
   ABORTED or FAILED — a failed run may have written customers and openings) APPLY run of
   the tenant needs an unrevoked `RERUN_OVER_PRIOR_IMPORT` acknowledgement with the same
   seven values and that prior source. Even acknowledged it is a re-run, never a merge:
   unchanged rows SKIP, a changed row is `SOURCE_CHANGED` and reported, nothing is applied
   twice, no balance delta is ever applied (OQ-LWD-02 stays open).

Each refusal is a `LegacyCutoverRefused`, exit **65**, nothing written. The run-start audit
row names the approval (and re-run acknowledgements) it ran under.

**`legacy-import cutover-gate`** proves the cutover checklist IN ORDER and stops at the first
failure (`LEGACY_CUTOVER_GATE_STEPS`): `STOP_SALES_ACTIVE` (an ACTIVE MAINTENANCE incident
with `stop_sales`; every ACTIVE panel drained; every gateway disabled — the existing
incident mechanism, not a new flag) → `FREEZE_PROOF_VERIFIED` (PR1's
`scripts/legacy-freeze-checksum-verify.sh`, pinned by its SHA-256, run with `bash` over the
frozen and the restored proof: exit 0 and `EQUAL`; and the frozen file's SHA-256 is the
approved one) → `FRESH_FINGERPRINTS` → `TABLES_CLASSIFIED` → `APPROVAL_MATCHES` →
`SOURCE_NOT_SUPERSEDED` → `IMPORT_COMPLETED` → `RECONCILED` → `REPORT_V2_HOLDS`. It is
read-only on every database; exit 0 `CUTOVER_READY`, 3 `REFUSED`.

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
  by keys derived from the legacy identity, so… The verdict is `COMPLETED` only when
  nothing was left undone: the report's `attention` section counts customer source changes
  and entity mismatches, opening and trial conflicts, refused invoice map rows, FAILED
  adoptions and adopted services whose source changed, and any of them makes the verdict
  `COMPLETED_WITH_FAILURES` (exit 3). A row a person closed, or recorded for review, is a
  decision, not a failure.
- **resume** — continues the RUNNING run (same id: one APPLY run per cycle), requires the
  same fingerprint and mapping, and re-walks every phase; nothing is duplicated (tested:
  a crash after the openings phase, then resume: 6 openings, not 12). An error inside a
  phase leaves the run RUNNING, as a killed process does — one recovery for both.
- **One applying process per tenant (WP-D3).** `import` and `resume` first take a
  per-tenant claim — a PostgreSQL session advisory lock (class `0x4c49`) on a connection
  of their own, never a pooled one — and hold it until the run ends. A second `import` or
  `resume` while a live process holds it is refused with `RUN_CONFLICT` ("Another
  importer process…") before it reads or writes anything. Before this, two resumes of one
  interrupted run both proceeded, walked the same rows and deadlocked (40P01). A process
  that dies — `kill -9`, a lost host — loses its connection and so its claim, at once: a
  resume after a crash is never refused by a dead holder, and needs no operator step.
  If that session ends while the import runs (the backend terminated, the server
  restarted, a network cut — noticed by TCP keepalive), the claim is LOST: the import
  stops before its next phase as an interruption, the run stays RUNNING, and `resume`
  finishes it. **The claim needs a direct PostgreSQL connection.** A session advisory lock
  lives on one server session; behind a transaction-pooling proxy (PgBouncer in
  `transaction` or `statement` mode) the lock and the session that should hold it come
  apart, and two importers could both believe they hold the tenant. Point `DATABASE_URL`
  of the importer at PostgreSQL itself, or at a pooler in `session` mode. (NEXA's own
  deployment has no pooler: `deploy/` connects to PostgreSQL directly.)
- **G10 at apply.** `import` and `resume` re-decide the panel-map completeness with the
  audit's own predicate before any write, and refuse (exit 65, mapping refused) while a
  live real `code_panel` is in no list and not declared in `unresolvedPanels` — whatever
  an earlier audit said.
- **reconcile** — the latest APPLY run, which must be **COMPLETED** (RUNNING: resume or
  abort it first; ABORTED: there is no finished import), against a fresh snapshot of the
  SAME source fingerprint and the SAME mapping fingerprint (both refused otherwise):
  wallet equation (positive balances only), openings sum/count/no duplicate, no DEBIT
  opening, legacy debts sum/count, customers present, trial decisions, category closure,
  provider writes = 0, inventories complete, and the `usersWallets` section
  (`reconciliation.md` §6: every source user accounted for, the money per user, changed
  users since the imported snapshot). `RECONCILED`/`DISCREPANCY`.
  Wallet movement is the non-opening total now minus the recorded pre-import non-opening
  total — one predicate, one boundary, so an entry committed between that measurement and
  the run start is movement, never in neither figure.
- **report** — Item 16 (§7), for the latest APPLY run, refused unless the snapshot and the
  mapping are the ones that run was made from (it may describe a RUNNING or ABORTED run,
  and its verdict says which). The markdown also renders the `usersWallets` section after
  the v1 document; `--format json` prints the final report version 2 (§7; `--report-schema
1` prints the closed v1 document exactly, as before). The verdict reads the section too: any failed
  U-check (U8 — a synthetic debt beside a real snapshot — among them) makes it
  `<status>_WITH_DISCREPANCY`, exit 3, as a failed v1 equation does. `reconcile` already
  carries it as the `users_wallets.section` check.

### Legacy wallet debts (Mirza PR4)

A negative legacy balance is a row of `legacy_wallet_debts`, held for the owner. No CLI
flag was added: owner decision 6 holds every negative for review, so there is nothing for
an operator to accept at import time (the audit's earlier proposal of an
`--accept-negative-openings` binding is superseded). The Web Admin page `/legacy-debts`
(`legacy.debts.view` MEDIUM; decisions `legacy.debts.decide` HIGH, owner-only by default)
lists them with an aggregate and records the per-customer decision (`ACKNOWLEDGED`,
`WAIVED`, reopen). No decision moves money and nothing collects a debt.

## 7. The report

**Version 2 (Mirza PR6, the default of `report --format json`).**
[`final-report-v2.schema.json`](final-report-v2.schema.json) carries the closed v1 document
UNCHANGED as `core` (validated by v1's own schema, whose bytes a unit test pins) and folds
in every later section with its own version: `inventory` (`nexa-legacy-inventory/v1`, a
FRESH inventory the report's own session — bound to this snapshot's source — read; without
one the section says `read: false` and does not hold), `products`
(`nexa-legacy-products/v1`: PR2 defined no section, so this PII-free one counts review rows
by state, present/absent, codes missing from the review or not in the source, and export
readiness, with the products read set fingerprint), `invoiceArchive`
(`nexa-legacy-invoice-archive/v1`: PR3's closure equations A1–A6 for the latest COMPLETED
archive run of THIS source), `usersWallets` and `serviceOutcomes` (PR4/PR5, unchanged),
`cutover` (`nexa-legacy-cutover/v1`: this source's approvals, every APPLY run and its
source, each superseded source and whether it was acknowledged, the duplicate-effect
counters) and `applyRun` (`nexa-legacy-apply-run/v1`: what the reported run left for a
person, read back from its finish audit row — PR5's approval counters, `withdrawnDuringRun`
and `unconfirmed` among them, and every attention count, `approvalUnconfirmed`
(ADOPTION_UNCONFIRMED) among them; it holds only when recorded and no adoption is
unconfirmed). The seven invariants (`USERS_ACCOUNTED`, `INVOICES_ACCOUNTED`,
`PRODUCTS_ACCOUNTED`, `WALLETS_RECONCILED`, `SERVICES_ONE_OUTCOME`, `UNRESOLVED_RETAINED`,
`RERUN_NO_DUPLICATES`) each name the checks they AND; the verdict is the AND of every section
and every invariant, `failedSections` and `failedInvariants` say what failed, and the report's
own verdict is `<status>_WITH_DISCREPANCY` (exit 3) unless it holds. Each section lists only
facts that were READ. A unit test flips the verdict through every invariant and section.

**Version 1:**

Every mode prints a markdown report (aggregates only; `SYNTHETIC SOURCE — NOT EVIDENCE`
first when the source is a fixture). `report --format json` prints the document of
`docs/legacy-migration/final-report.schema.json` (schemaVersion 1, REHEARSE's): run (with
resumes counted from `legacy_import.run.resume` audit rows), source (fingerprint, digests,
server version, `Balance` type), customers, wallet, services, products, trials,
`provider.reads` / `provider.writes` (requests the read guard refused — 0 by construction),
manual review by closed reason (every `MANUAL_REVIEW` map row, user and invoice, plus
`INVOICE_KEY_INVALID` and `ADOPTION_PENDING_P6`), and the C1/C3/W1/W4/W5/S3/P3 equations.
v1 is closed, so Mirza PR5's two new categories are folded into its existing fields: `NO_PANEL`
into `services.mappingMissing`, `AMBIGUOUS_OWNERSHIP` into `services.ambiguous` (S3 still
closes). The `serviceOutcomes` section (`nexa-legacy-service-outcomes/v1`) is printed beside it
by `report` and inside `sections` by `reconcile` (service-review.md §6).
`wallet.preImportTotalMinor` is the NEXA-native total (every entry but the openings), so
`pre + imported = expected = actual` holds even with activity after the import. Every
key, value, column header and heading in the markdown is made inert (`markdownText`): a
source value cannot add a line, a row, a heading, a link, code or HTML.

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
  writes 0); permissions; stopped tenant; the CLI glue. WP-D3 tightened it: `audit`
  is compared over EVERY table (row count and an md5 of every row,
  `tests/support/database-fingerprint.ts`), not four; a drifted source refuses resume
  with `RUN_CONFLICT` and the database unchanged (any error used to pass); a crash after
  EACH phase (`customers`, `openings`, `trials`, `products`, `adoption`), and a crash
  INSIDE adoption after two services were committed, each resume to exactly the state a
  clean uninterrupted import leaves (a digest over stable keys: legacy ids, Telegram ids,
  usernames, panel names — one order and one service per adopted invoice); and two
  concurrent resumes: exactly one completes, the other is refused cleanly.
- **MySQL engine: `pnpm test:legacy-mysql`** (`tests/legacy-mysql/`) — read-only proof, a
  write refused even with a grant that allows it, consistent snapshot, fingerprint parity,
  every evidence query and its cross-checks, on a real MariaDB. Its own CI job
  (`legacy-mysql`, a `mariadb:10.11` service) rather than a fails-not-skips opt-in: unlike
  a real panel, a database server is something CI can provide on every pull request.
  Without `NEXA_LEGACY_MYSQL_ADMIN_DSN` it FAILS, never skips.
- Mirza PR1: the following tests cover the frozen v1, the versioned read sets, the
  inventory and its CLI, and the catalogue:
  - `tests/unit/legacy-import-read-set-v1.test.ts`
  - `tests/unit/legacy-read-set.test.ts`
  - `tests/unit/legacy-inventory.test.ts`
  - `tests/unit/legacy-table-classification.test.ts`

  `tests/integration/legacy-read-set-runs.test.ts` covers the following:
  - only `legacy_read_set_runs` and `audit_logs` change, over every table;
  - unbound and mismatched runs write nothing;
  - idempotency and tenant isolation;
  - a stopped tenant;
  - append-only rows and the CHECKs.

  `tests/legacy-mysql/legacy-mysql-inventory.test.ts` runs on both CI engines and covers
  the following:
  - `tables()` and exact counts;
  - a commit after the session opened is not counted;
  - engine and fixture inventories agree, and so do read-set fingerprints;
  - the adapter refuses unclassified rows;
  - `scripts/legacy-freeze-checksum.sql` covers every base table and notices a write to
    `product` and to the unclassified table;
  - a read set's delivery pass on the engine delivers every row only after the verifying
    pass matched, and a mismatch delivers none.

  `tests/unit/legacy-inventory.test.ts` runs `scripts/legacy-freeze-checksum-verify.sh`
  over a well-formed file, an empty one, a header-only one, a short one, a NULL checksum
  and a duplicated table, and pins that the runbooks capture the client's own exit status
  and compare through the checker.

- Mirza PR3 (the invoice archive):
  - `tests/unit/legacy-invoice-archive-domain.test.ts` — classification order (and its
    agreement with `decideServiceCandidate` on every live synthetic invoice),
    normalisation, price and time grammars, checksums, revisions, redaction;
  - `tests/unit/legacy-invoice-archive-read-set.test.ts` — the allowlist, v1 unmoved, the
    excluded columns' values never in the fingerprint, the command line, the report;
  - `tests/unit/legacy-invoice-archive-boundary.test.ts` — no business module or table;
  - `tests/integration/legacy-invoice-archive.test.ts` — digest-only and mismatches write
    nothing; an approved read changes exactly four tables; secrets never stored; every
    class; idempotent rerun; one changed invoice = one revision; snapshot B (revisions,
    new, missing kept); crash mid-staging and mid-promotion; a lost batch; divergence;
    duplicate keys; an unrepresentable cell; a stopped tenant; append-only and class
    CHECK; foreign keys; the grants backfill; keyset and every filter; PII redaction,
    refusal and audit; operator/observer denied; tenant isolation; the HTTP surface;
  - `tests/integration/legacy-invoice-archive-plan.test.ts` — every filter on its index at
    200,000 rows (`NEXA_LEGACY_ARCHIVE_PLAN_ROWS`);
  - `tests/legacy-mysql/legacy-mysql-invoice-archive.test.ts` — engine and fixture agree
    (odd keys' byte order included), no secret column delivered, a mismatch delivers none;
  - `tests/web/legacy-invoices.test.tsx`;
  - `scripts/mutate-mirza-pr3.py` — the mutation driver.
- Mutation-checked: the acknowledgement requirement, the READ ONLY transaction, the
  resume's mapping check, the rerun keeping a created customer's own map reason, the
  insert never touching an existing customer, an unmapped named product held for review.

Fixture: `tests/fixtures/legacy/synthetic-legacy.{ts,json,sql}` — SYNTHETIC, derived from
the public MirzaBot source (`mahdiMGF2/botmirzapanel` @ 92c0ed0676c1d0c9540bae257092104744bab1fd,
`table.php`) and the runbook's columns; `write-fixtures.ts` regenerates the committed files
and a unit test holds them equal.

## 10. Manual acceptance (needs the real archive, panels and staging)

0. Inspect the archive BEFORE anything loads it (WP-D1a, `scripts/legacy-archive-inspect.mjs`):

   ```bash
   export LEGACY_ZIP_PASSWORD=…        # typed into the environment; NEVER on argv
   node scripts/legacy-archive-inspect.mjs --archive backup_YYYY-MM-DD.zip \
     --password-env LEGACY_ZIP_PASSWORD --engine mysql8 --require-class staging \
     --out <new dir> --extract
   ```

   It accepts only the evidenced shapes: a `mysqldump`/`mariadb-dump` `.sql` or `.sql.gz`,
   MirzaBot's PDO-fallback `.sql` (`SET NAMES utf8mb4;` / `SET FOREIGN_KEY_CHECKS=0;` /
   `SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';`), and `backup_YYYY-MM-DD.zip` with exactly one
   entry `backup_YYYY-MM-DD.sql`, unencrypted or WinZip AES-256 — what MirzaBot revision
   `e4966ff` writes with `ZipArchive::EM_AES_256`. ZipCrypto, AES-128/192, zip64, two
   entries or another entry name are refused. It reports, with no row content: the SHA-256
   of the archive AND of the inner dump, the header (client, server version, engine),
   whether the dump ends the way its writer ends one (a truncated dump is refused), the
   tables and whether `user`/`invoice`/`product` carry the importer's required columns
   (pinned equal to `LEGACY_REQUIRED_COLUMNS`), character sets and collations, stored
   objects / `DEFINER` (refused: MirzaBot has none), `USE`/`CREATE DATABASE`, and
   `blockers[]`. Exit 0 ACCEPTED, 2 BLOCKED, 64 usage.

   **Decryption needs no external tool.** WinZip AES (PBKDF2-HMAC-SHA1 → AES-256-CTR with a
   little-endian counter, 10-byte HMAC-SHA1) is implemented on `node:crypto`; the operator
   dependency is Node ≥ 22.11 with OpenSSL (the tool fails with a precise message if
   `aes-256-ecb` or `zlib.crc32` is missing). Info-ZIP `unzip` and Python's `zipfile`
   cannot open these entries; `7z x` can, but is not needed. The HMAC is verified over the
   whole entry and an extracted dump whose HMAC does not verify is deleted. The tests run
   against zips written by PHP's libzip — MirzaBot's own encoder — with a TEST-ONLY
   password (`tests/fixtures/legacy/archive/make-fixtures.php`); MirzaBot's real hardcoded
   password is deliberately not in this repository.

   `--engine mariadb` refuses a dump carrying `utf8mb4_0900_*` collations
   (`COLLATION_REQUIRES_MYSQL8`) or taken from a MySQL ≥ 8 server (`ENGINE_MISMATCH`):
   the collation is never rewritten — MySQL 8 is the engine for it.

   Add `--columns` to list each table's column NAMES from the dump (Mirza PR1). This is the
   input for `docs/legacy-migration/table-inventory.md` before anything is loaded.

1. Restore the archive into MySQL 8 (the CI covers MariaDB 10.11 and MySQL 8.0 with the
   SYNTHETIC dataset — `legacy-mysql` job, OQ-P7-03; the real dump's first MySQL 8 load
   is this step), create `oldbot_ro` (SELECT only).
2. `audit` against staging with the real mapping file: record the evidence and the
   cross-checks into `sql-evidence.md` in their own commit — those, not the synthetic
   figures, are Item 1's result.
   Then run `inventory --expected-fingerprint <audit's source.fingerprint>` and fill
   `table-inventory.md` from it (Mirza PR1). This step is NOT RUN: no real data has been
   inventoried.
3. `dry-run`, `import`, kill it, `resume`, `reconcile`, `report --format json` — the
   REHEARSE runbook (`docs/legacy-migration/rehearsal.md`).
