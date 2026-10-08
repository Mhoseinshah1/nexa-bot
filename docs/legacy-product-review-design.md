# Legacy product review — design (hardening batch 2026-10-07, §5)

**Status: IMPLEMENTED (Mirza migration PR2, 2026-10-07)** — work packages A–F. §13 says what
was built and every place the build departs from this design, with the reason. WP G (manual
acceptance against the real Mirza dump) is NOT RUN. The sections below are the original
proposal (written for the hardening batch, which could not build it inside a hotfix) and are
kept as written; where they disagree with §13, §13 is what the code does.

What the hotfix did NOT change: a named `code_product` that the owner's map does not list
is still `PRODUCT_UNRESOLVED` → `PRODUCT_MAPPING_UNRESOLVED` manual review, and nothing maps
it to a NEXA product by itself.

## 1. The owner's request

> Bring the legacy plans/products into NEXA first so I can inspect them one by one in
> NEXA, then decide what stays/changes/activates, rather than manually pre-mapping every
> historical code before I can see them.

Real rehearsal facts — from the HISTORICAL staging snapshot, dated baselines and never
expected values (the cutover snapshot is newer, owner constraint 2026-10-07): NEXA sells two
public products (30 GB / 30 d / 145 000 IRT and 30 GB / 60 d / 175 000 IRT); the legacy
`product` table had 64 rows and many historical `code_product` values.

## 2. What exists today (file references)

| Piece                                                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/modules/platform/legacy-importer/application/source-port.ts`                                                                          | `LEGACY_REQUIRED_COLUMNS.product = ['id', 'code_product']`, optional `agent`. **The importer reads no product name, price, volume or duration today.**                                                                                                                                                                               |
| `.../legacy-importer/application/source-snapshot.ts`                                                                                                | the source fingerprint is SHA-256 over the schema hash and the per-table digests of the columns READ (`tables.product` included). Reading more product columns changes the fingerprint of the same source.                                                                                                                           |
| `.../legacy-importer/application/decisions.ts` (`decideServiceCandidate`)                                                                           | a live invoice whose `code_product` is a row of the legacy `product` table is `NAMED_PRODUCT`: it adopts only if the owner's map lists that code (`productMap`), else `PRODUCT_UNRESOLVED`. "No mapping is PRODUCT_MAPPING_UNRESOLVED, never a product picked by shape." A missing/empty/custom product takes the hidden-shape path. |
| `.../legacy-importer/application/panel-mapping.ts`                                                                                                  | the `products: [{codeProduct, productId}]` section of `nexa-legacy-panel-map/v1`; part of the panel-map fingerprint; every target must be a product of the tenant (`validateProductMappingAgainstTenant`).                                                                                                                           |
| `apps/api/src/modules/commerce/legacy-adoption/application/legacy-adoption.service.ts`                                                              | P6: a named product adopts only when its mapped product is `ACTIVE`, priced in the sales currency, and duration-compatible with the account; otherwise `PRODUCT_MAPPING_UNRESOLVED`.                                                                                                                                                 |
| `apps/api/src/modules/commerce/catalog/application/legacy-product.service.ts`, `legacy-shape.ts`, `docs/legacy-migration/hidden-legacy-products.md` | the hidden-shape mechanism: one `HIDDEN`, uncategorised, panel-less product per `(code_panel, traffic, days, custom)` shape, a DB trigger (`nexa_legacy_shape_product_hidden`) that forbids a category or a spec change, tariff by `MATCH` to the current public product or an operator `STATED` price.                              |
| `products` (`schema.ts`), `packages/contracts/src/catalog.ts`                                                                                       | `status` ACTIVE/INACTIVE; `audience` EVERYONE/RESELLERS_ONLY/HIDDEN; nullable `panel_id`, `category_id`, `price_*`. A product with no category or no panel cannot be ordered (`unorderableReason`). There is no "review-only" product state.                                                                                         |
| `apps/api/src/modules/platform/legacy-import/application/legacy-review-queue.service.ts`                                                            | the importer's Manual Review Queue: terminal-only (`legacy-import review …`) because its rows carry legacy ids that ARE Telegram ids.                                                                                                                                                                                                |

## 3. Why the hidden-shape mechanism must not carry named products

1. **It forgets the identity the owner wants to review.** A shape key is
   `(code_panel, traffic, days, custom)` and deliberately ignores price and title. Several
   of the 64 named products share a shape; folding them would collapse distinct
   `code_product`s into one row and lose the stable link the review needs.
2. **It is "a product picked by shape"** — exactly what `decideServiceCandidate` refuses for
   a named product. Routing named products through it would silently resolve them.
3. **Its invariants are wrong for a reviewed product.** The trigger forbids a category and
   any change of duration/traffic; the owner's "change, then activate" needs both.
4. **Its price is the CURRENT tariff** (`MATCH`/`STATED`); a named legacy product carries a
   historical price that must stay metadata, never a tariff.
5. **Its adoption gate differs.** `legacyShapeAdoptable` vs the named-product gate in P6; a
   shape row pointing at a named product would make P6 take the shape branch.

## 4. Proposed data model (one additive migration)

A staging table, **not** product rows. A review row is not a product: it cannot be listed,
ordered, priced or renewed, and nothing in the catalogue has to learn a new state.

`legacy_product_reviews`

| column                                                                             | notes                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` uuid PK, `tenant_id` uuid FK                                                  | tenant-scoped; every query filters by tenant                                                                                                                                       |
| `code_product` text                                                                | exactly as the legacy row holds it (same refinement as the mapping file: trimmed, no control characters, ≤ 200). `UNIQUE (tenant_id, code_product)` — the stable link              |
| `legacy_product_id` text                                                           | the legacy `product.id`, as read                                                                                                                                                   |
| `legacy_facts` jsonb                                                               | the raw cells read (`name_product`, `price_product`, `Volume_constraint`, `Service_time`, `Location`, `Category`, `agent` where present), strings as read. Never rendered as HTML. |
| `facts_checksum` text                                                              | SHA-256 of the canonical `legacy_facts`; an approval binds to it                                                                                                                   |
| `title` text null                                                                  | `name_product` trimmed, when it is non-empty text                                                                                                                                  |
| `traffic_bytes` bigint null                                                        | parsed deterministically (`parseTrafficGb`, 1 GB = 1 GiB) or null with `parse_notes`                                                                                               |
| `duration_days` int null                                                           | parsed deterministically or null                                                                                                                                                   |
| `historical_price_minor` bigint null, `historical_price_currency` text null        | **metadata only** — only when the unit is evidenced (§12 OQ-3); never copied to `products.price_*`                                                                                 |
| `parse_notes` jsonb                                                                | closed reason codes per field (`EMPTY`, `NOT_A_NUMBER`, `UNIT_UNKNOWN`, `ZERO_MEANING_UNKNOWN`) — never a guess                                                                    |
| `live_invoice_count` int                                                           | aggregate from the read (how many live invoices name this code) — for prioritising, no PII                                                                                         |
| `state` text CHECK                                                                 | §5                                                                                                                                                                                 |
| `approved_product_id` uuid null                                                    | composite FK `(tenant_id, approved_product_id)` → `products`                                                                                                                       |
| `approved_facts_checksum` text null                                                | the checksum the approval was made against                                                                                                                                         |
| `decision_reason` text null, `decided_by` uuid null, `decided_at` timestamptz null | who decided, why                                                                                                                                                                   |
| `read_fingerprint` text                                                            | the product-read fingerprint (§7) of the read that last wrote the facts                                                                                                            |
| `version` int, `created_at`, `updated_at`                                          | optimistic concurrency; timestamps from `Clock`                                                                                                                                    |

CHECKs: `approved_product_id` non-null iff state ∈ {`APPROVED_EXISTING`, `APPROVED_NEW`};
`approved_facts_checksum` non-null iff approved. No balance, no price column on `products`
is touched. No trigger on `products`.

## 5. States

```
PENDING_REVIEW ──approve-existing──▶ APPROVED_EXISTING ─┐
      │        ──create-draft+approve▶ APPROVED_NEW ─────┤──reopen──▶ PENDING_REVIEW
      │        ──reject────────────▶ REJECTED ───────────┘
      ▼ (a re-read finds different facts for a decided row)
  SOURCE_CHANGED ──(the operator re-decides)──▶ any of the three above
```

- `PENDING_REVIEW` — read, not decided. Its invoices stay `PRODUCT_MAPPING_UNRESOLVED`.
- `APPROVED_EXISTING` — mapped to an existing NEXA product the operator picked.
- `APPROVED_NEW` — the operator created a NEW NEXA product from the reviewed facts (§8) and
  mapped to it.
- `REJECTED` — the operator decided NOT to map it; its invoices stay in manual review with
  `PRODUCT_MAPPING_UNRESOLVED` (a person then decides per service, as today).
- `SOURCE_CHANGED` — a later read saw different facts than the approval was bound to. The
  approval no longer exports (§9) until re-decided. Never silently re-approved.

Every transition is a conditional UPDATE naming its `from` states (the ADR-0028 rule).

## 6. Permissions, audit, idempotency

- Two new permissions (a contract change, its own commit): `legacy.products.view` and
  `legacy.products.decide`, granted to `owner` by default. Creating a draft product ALSO
  requires `catalog.edit` (checked through the guard, by the product service itself).
- Every write takes `ScopeContext` + `ActorContext`, reads `ScopeActivityReader` inside its
  transaction, carries an idempotency key, and records an audit row with before/after as
  values (`legacy.product_review.read`, `.approve_existing`, `.approve_new`, `.reject`,
  `.reopen`), DENIED on refusal. No outbox event (nothing consumes one, as for shapes).
- The read upserts by `(tenant_id, code_product)`; re-running it with the same source is a
  no-op (same checksum); a decided row whose checksum changes moves to `SOURCE_CHANGED`.

## 7. Reading the legacy product table without breaking the approved fingerprint

The import snapshot's fingerprint covers the columns it reads. Adding product columns to
`LEGACY_REQUIRED_COLUMNS` would change the fingerprint of the SAME source and invalidate
the fingerprint the owner approved (`685a9d52…` in the historical staging rehearsal — that
snapshot's value, not the cutover's). The import read set is now FROZEN as
`IMPORT_READ_SET_V1` and pinned by a golden test, and a later read is a versioned read set
(`docs/legacy-migration/importer.md` §3.1). So:

- a NEW CLI mode, `legacy-import products-read`, reads the `product` table (and the
  per-code live-invoice count) in its own `START TRANSACTION READ ONLY` session, with its
  own **product-read fingerprint** (SHA-256 over the columns it read). It writes only
  `legacy_product_reviews` rows, through the service, as `SYSTEM_JOB`, and touches no
  provider at all (no inventory walk);
- the import's snapshot, columns and fingerprint are unchanged;
- the product-read refuses a production-like target behind the same guard as every mode.

## 8. Admin flow (Web Admin)

Review rows carry no Telegram id, username or balance, so — unlike the importer's Manual
Review Queue — they may be shown in the Web Admin. A new section under Catalogue,
"Legacy products (review)":

1. **List** — filter by state; columns: `code_product`, title, traffic, days, historical
   price (labelled historical), live invoice count, state. Sorted by live invoice count.
2. **Detail** — the raw legacy facts beside the parsed fields and their `parse_notes`.
3. **Approve → existing product** — a picker of this tenant's products. The screen shows a
   compatibility check (duration and traffic equal? duration > 0 matches the accounts'
   expiry?) as INFORMATION; the operator decides. It does not activate or edit the product.
4. **Create draft product, then approve** — creates a product through
   `ProductService.create` with title/traffic/days prefilled from the review (editable):
   **`INACTIVE`, `HIDDEN`, no category, no panel, no price.** It is unsellable by every
   existing rule (`NOT_CATEGORISED`, `NOT_FULFILLABLE`, inactive). The operator later edits
   it in Products like any other product: sets the current price, and decides whether it is
   a renew-only product (`ACTIVE` + `HIDDEN`) or a public one (category, panel, `EVERYONE`).
5. **Reject**, **Reopen** — with a reason.

## 9. Importer integration (approval → explicit mapping)

The panel-map file stays the ONE approved input the importer reads, bound by its
fingerprint (`--expected-panel-map-fingerprint`). The importer never reads review rows to
decide a mapping:

- `legacy-import products-export --tenant T` prints the `products` array from rows in
  `APPROVED_EXISTING`/`APPROVED_NEW` whose `approved_facts_checksum` equals the current
  `facts_checksum`, sorted by `code_product`. `REJECTED`, `PENDING_REVIEW` and
  `SOURCE_CHANGED` rows are not exported.
- The operator puts it into the panel-map file; the map's fingerprint changes, and the
  owner approves the new one as today.
- `audit` additionally reports, per `code_product` (aggregate only), how many live
  invoices are `PRODUCT_UNRESOLVED` and the review state of the code — so the owner sees
  what is left.
- Optional consistency check at `prepare`: a map entry for a code whose review row exists
  but is not approved for that product is a `PanelMappingRefused` (exit 65). Off when no
  review rows exist, so maps written by hand keep working.

P6 is unchanged: a mapped product adopts only when `ACTIVE`, priced in the sales currency
and duration-compatible. An approved-but-still-draft product therefore leaves its services
in `PRODUCT_MAPPING_UNRESOLVED` until the operator activates and prices it — which is the
intended order of events.

## 10. What never happens automatically

- No `code_product` is mapped to any product without an operator's decision.
- No panel is attached to a created product; `Location` is shown, never resolved to a panel.
- No price is set on a product; the historical price is never a tariff, and no tariff is
  matched or stated by this flow.
- No product becomes sellable or `ACTIVE` through this flow.
- No category is assigned.
- No provider is contacted.
- A changed legacy row never keeps its old approval.

## 11. Work packages

| WP  | Scope                                                                                                                                                                                    | Size   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A   | Contracts (own commit): review states, parse-note codes, two permissions, audit action names, error codes                                                                                | S      |
| B   | Migration + Drizzle schema + repository (table, CHECKs, composite FK, unique), `pnpm db:check`                                                                                           | S–M    |
| C   | Source: product-read session, canonical facts, deterministic parsers, product-read fingerprint; `products-read` mode                                                                     | M      |
| D   | Service: upsert-by-code, transitions as conditional UPDATEs, approve-existing, create-draft (via `ProductService`), reject, reopen, `SOURCE_CHANGED`; audit, idempotency, scope activity | M      |
| E   | Web API (controller, guard permissions) + Admin page + Persian i18n keys + web tests                                                                                                     | M–L    |
| F   | `products-export`, audit per-code aggregates, optional prepare consistency check, docs (`importer.md`, runbook)                                                                          | S–M    |
| G   | Manual acceptance against the real Mirza dump (staging only): units, columns, row count                                                                                                  | manual |

Order: A → B → C/D (parallel) → F → E → G. Integration tests per WP; mutation-check each
rule (unapproved code never exported; `SOURCE_CHANGED` drops the export; draft product is
INACTIVE/HIDDEN/uncategorised/panel-less/unpriced; no provider request; tenant isolation).

## 12. Open questions (none may be resolved by guessing)

- **OQ-LPR-01** The real backup's `product` columns. The public MirzaBot schema
  (`mahdiMGF2/botmirzapanel` @ 92c0ed06, `table.php`) has `id, code_product, name_product,
price_product, Volume_constraint, Location, Service_time, Category`; the importer already
  treats `agent` as optional, so the real fork differs. Read from the real dump first.
- **OQ-LPR-02** Units: is `Volume_constraint` GB, and `Service_time` days, for every row?
  What does `0` mean (unlimited?) — the same unknown the shape key refuses.
- **OQ-LPR-03** `price_product` unit: Toman or Rial, and is it ever non-numeric? Until
  evidenced the historical price stays raw text only.
- **OQ-LPR-04** `Location`: a panel NAME, a `code_panel`, or free text? Shown only.
- **OQ-LPR-05** Duplicate `code_product` rows in the real table: refuse the read, or one
  review row with a conflict note?
- **OQ-LPR-06** Should an approved legacy product default to renew-only (`ACTIVE` +
  `HIDDEN`, current price) or be offered for sale? Owner decision; the flow never decides.
- **OQ-LPR-07** Reseller (`agent`) products: in scope for review, or out (resellers were
  out of Phase 1 of the migration)?

## 13. As implemented (Mirza PR2)

### What exists

| Piece                   | Where                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (own commits) | `LEGACY_READ_SET_NAMES` gains `products` (`packages/contracts/src/legacy-inventory.ts`); `legacy.products.view` (MEDIUM) and `legacy.products.decide` (HIGH, requires view) in `permissions.ts`; states, parse notes, source conflicts, error codes, audit actions, routes and HTTP schemas in `packages/contracts/src/legacy-product-review.ts`                                         |
| Table                   | `legacy_product_reviews`, migration `0221` (and the `legacy_read_set_runs` CHECK widened to `products`); `0222` backfills both keys to existing system `owner` roles only                                                                                                                                                                                                                |
| Read set                | `PRODUCTS_READ_SET` (`legacy-read-set:products:v1`), `apps/api/src/modules/platform/legacy-importer/application/products-read-set.ts`                                                                                                                                                                                                                                                    |
| Ingest                  | `products-ingest.ts` (`LegacyImporterService.readProducts`), CLI `legacy-import products-read`                                                                                                                                                                                                                                                                                           |
| Service                 | `apps/api/src/modules/commerce/legacy-product-review/` (domain: facts, parsers, transitions; application: `LegacyProductReviewService`; infrastructure: the Drizzle repository)                                                                                                                                                                                                          |
| Draft creation          | `ProductService.createWithin` — the product service's own create body inside the decision's transaction                                                                                                                                                                                                                                                                                  |
| Export                  | `LegacyProductReviewService.exportMapping`, CLI `legacy-import products-export [--panel-map FILE]`                                                                                                                                                                                                                                                                                       |
| Web                     | `LegacyProductsController` (`/api/v1/legacy-products…`), page `/legacy-products` in the sales/catalogue nav group                                                                                                                                                                                                                                                                        |
| Tests                   | `tests/unit/legacy-product-review-domain.test.ts`, `legacy-products-read-set.test.ts`, `legacy-import-products-cli.test.ts`, `legacy-products-boundary.test.ts` (extended); `tests/integration/legacy-product-review.test.ts`; `tests/legacy-mysql/legacy-mysql-products.test.ts`; `tests/web/legacy-products.test.tsx`; mutation driver `scripts/mutate-mirza-pr2.py` (29 of 29 killed) |

### Commands, routes and permissions (for later PRs and the runbook)

```bash
# 1. Digest only: prints the products read set fingerprint for approval. Writes nothing. Exit 3.
legacy-import products-read --tenant T --source SOURCE --target TARGET \
    --expected-fingerprint <approved v1 fingerprint> [--format md|json]
# 2. With the approval: both fingerprints checked before any write; ingests; exit 0.
legacy-import products-read … --expected-fingerprint <v1> --expected-products-fingerprint <products>
    [--batch-size N]   # 1-5000, default 1000
# 3. The panel map's `products` section from approved rows; read-only; never writes the file.
legacy-import products-export --tenant T --target TARGET --expected-products-fingerprint <products> \
    [--panel-map FILE]  # prints the merged map; its NEW fingerprint goes to stderr
```

Exit codes: 0 done; 3 digest only (not approved, nothing written); 64 usage; 65 a refused
source (`SOURCE_FINGERPRINT_MISMATCH`, `READ_SET_FINGERPRINT_MISMATCH`,
`READ_SET_SNAPSHOT_DIVERGED`, a synthetic source against a production-like target) or a
refused map (`PanelMappingRefused`); 1 anything else (a `legacy_product_review.*` refusal
included).

| Route (`/api/v1`)                                                                                                                             | Permission                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `GET /legacy-products?state=&attention=true&q=&after=&limit=`                                                                                 | `legacy.products.view`                    |
| `GET /legacy-products/:id`                                                                                                                    | `legacy.products.view`                    |
| `POST /legacy-products/:id/approve-existing` `{idempotencyKey, expectedFactsChecksum, expectedVersion, productId, reason}`                    | `legacy.products.decide`                  |
| `POST /legacy-products/:id/approve-new` `{idempotencyKey, expectedFactsChecksum, expectedVersion, title, durationDays, trafficBytes, reason}` | `legacy.products.decide` + `catalog.edit` |
| `POST /legacy-products/:id/reject` `{idempotencyKey, expectedFactsChecksum, expectedVersion, reason}`                                         | `legacy.products.decide`                  |
| `POST /legacy-products/:id/reopen` `{idempotencyKey, expectedVersion, reason}`                                                                | `legacy.products.decide`                  |

The CLI ingest and export run as `SYSTEM_JOB` under `maintenance.run`. Audit actions:
`legacy.product_review.read`, `.source_changed`, `.approve_existing`, `.approve_new`,
`.reject`, `.reopen` (and the product service's own `product.create` for a draft); every
refusal of a decision is a `DENIED` row.

### Departures from the design, and why

1. **The products read set reads `product` only.** The live-invoice count (§4) is computed
   in the same bound session from the v1 `invoice` columns (`code_product`, `Status`,
   `is_test`, `is_custom` — live statuses, real, not custom, trimmed code), which the
   approved v1 fingerprint already binds. Putting `invoice` into the products read set
   would change the products fingerprint with every invoice and void a products approval
   for no product change.
2. **The column allowlist** is the public `botmirzapanel` product columns plus the public
   `mirza_pro` fork's `agent`, `note`, `data_limit_reset`, `one_buy_status`, `category`,
   `hide_panel` — all optional, kept verbatim, never interpreted. `inbounds` and `proxies`
   are deliberately NOT read (panel configuration; OQ-MZ-INV-02). The real columns are
   still OQ-LPR-01. There is no "status" or "test" column in either public source: a
   disabled or test product is a review row like any other, its `hide_panel`,
   `one_buy_status`, `note` and name kept as cells (OQ-LPR-08).
3. **Two approvals, and nothing written before the read is proven.** `products-read` writes
   only with `--expected-products-fingerprint`, through PR1's verified delivery
   (`readLegacyReadSet` with `expectedFingerprint`). One transaction cannot span the
   delivery — the MySQL source refuses to run inside a database transaction — so the rows
   are gathered per code (bounded by the legacy plan catalogue) and written in batched
   transactions only after the delivery pass has reproduced the verified fingerprint. A
   refused or diverged read writes nothing (integration test).
4. **`legacy_facts` is an array** — one object per legacy row naming the code. A code on
   two rows (OQ-LPR-05) is ONE review row with `source_conflict = CODE_DUPLICATED`, nothing
   parsed, and it can only be rejected. This is the fail-closed interim answer; the owner's
   answer to OQ-LPR-05 is still open.
5. **Absent codes.** A complete read that no longer has a code sets
   `missing_since_read_fingerprint` to ITS fingerprint; a decided row also moves to
   `SOURCE_CHANGED` at its first absence. Every later read that still lacks the code
   re-acknowledges it (the column is the LATEST read without the code; the first one is in
   the audit trail), so the export of that later read is not blocked by an earlier one
   (Codex review of #231). An absent code cannot be approved, only rejected.
6. **`SOURCE_CHANGED` remembers the decision it invalidated**: `prior_state` (CHECK: set
   iff `SOURCE_CHANGED`), and an approved row keeps its `approved_product_id` and
   `approved_facts_checksum` for the operator to see. It still never exports: an export
   needs an APPROVED state bound to the current checksum. §4's CHECK is relaxed accordingly
   (only PENDING_REVIEW and REJECTED must have no product).
7. **The historical price unit**: the owner decided Mirza prices are Toman (decision 7,
   2026-10-07). So `historical_price_minor` is whole Toman as IRT minor units (exponent 0)
   when the raw text is ASCII digits; anything else (`150000.5`, `150,000`, Persian
   digits, negative) is `NOT_A_NUMBER` and stays raw only. `historical_price_raw` keeps
   the cell verbatim. It is metadata: nothing reads it into a product, a tariff or a quote
   (boundary test).
8. **Approve-as-new is one transaction.** The draft is created by
   `ProductService.createWithin` inside the decision's transaction (same checks, same
   `product.create` audit, `catalog.edit` checked there and early with its DENIED audit), so
   a lost race leaves no orphan product. The request carries title, days and traffic (the
   page prefills them from the parsed proposal); there is no price, panel, category,
   audience or status field, and the strict schema refuses one. Device limit is null.
9. **Export consistency check at export time — and, since the final audit, at `prepare` and
   in the final report.** `products-export --panel-map FILE` refuses (65) a hand-written map
   entry for a reviewed code that contradicts the review, keeps entries for codes the review
   has no row for, and prints the merged map and its new fingerprint. This departure first
   deferred the import-time check to PR5/PR6; neither built it (aud5 F5 = aud6 F1), so a
   decision changed after export, or a hand-edited map, was imported as it stood. It now
   lives in ONE place, `legacy-importer/application/product-map-review.ts`
   (`productMapAgainstReview`, over this PR's own `isExportable` — never a copy), with two
   callers:
   - **PR5, `LegacyImporterService.prepare` for APPLY** (import and resume): every
     `mapping.products` entry must name a code whose review row is exportable under the
     CURRENT products read of the source being imported (the latest `products` read set
     recorded against its v1 fingerprint) and must name exactly the product that row
     approved. Otherwise the run is refused before any provider read or write
     (`PanelMappingRefused`, exit 65), naming each code with `NO_PRODUCTS_READ`,
     `NO_REVIEW_ROW` (so an entry `products-export` kept for an unreviewed code is refused
     here), `NOT_EXPORTABLE` or `TARGET_DIFFERS`. Audit and dry-run do not refuse on it.
   - **PR6, report v2's products section**, check `PR5` (see `final-report-v2.ts`), so
     `REPORT_V2_HOLDS` and the cutover gate carry it.
     The per-code `PRODUCT_UNRESOLVED` audit aggregates (§9) are still not built.
10. **The list is ordered by code** (keyset on the immutable code), not by live-invoice
    count: a keyset over a count that changes on every read skips or repeats rows. The count
    is a column. The default view is the rows that want a decision (PENDING_REVIEW and
    SOURCE_CHANGED).
11. **A decision binds to the facts checksum AND the version the operator saw**
    (`expectedFactsChecksum`, `expectedVersion`), checked under the row lock; so does a
    reopen (version). A different checksum is `legacy_product_review.facts_changed`; a
    different version is `legacy_product_review.version_conflict`. The checksum alone is
    not enough: a reopen and a new decision on unchanged facts leave it as it was, and a
    stale decision or reopen would overwrite the newer one (Codex review of #231).
12. **A retried key answers its FIRST response.** The idempotency store keeps the decision's
    response (the row and the approved product's title, as the deciding transaction saw
    them), and a replay returns it unchanged and writes nothing — never the row as it is
    after a later decision or reopen. A replayed approve-as-new creates no second draft.

### Not run (needs the real dump; WP G)

- `products-read` against the staging copy of the real archive: the real columns
  (OQ-LPR-01), units (OQ-LPR-02), price shapes, duplicate codes (OQ-LPR-05).
- The owner's review of the real rows in the Web Admin, and the export into the final map.
- MySQL 8.0 for `tests/legacy-mysql/legacy-mysql-products.test.ts` (run here on MariaDB
  10.11 only; CI's matrix has MySQL 8.0).
