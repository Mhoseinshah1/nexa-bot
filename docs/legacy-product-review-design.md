# Legacy product review — design (hardening batch 2026-10-07, §5)

**Status: DESIGN ONLY. Nothing here is built.** The hardening batch asked whether an
operator review queue for named legacy (Mirza) products could be built cleanly inside the
hotfix. It cannot: it needs a contract change, a migration, a new source read with its own
fingerprint, a service, a Web Admin surface and importer wiring. Built inside a hotfix it
would change the source fingerprint the owner already approved and widen the catalogue's
invariants without review. This document is the proposal; the work packages are at §11.

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
