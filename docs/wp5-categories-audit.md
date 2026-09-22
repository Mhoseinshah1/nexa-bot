# WP5 — product categories: what the repository already does, and what it does not

Written before any implementation, as the package's first commit. Everything below
is read from the merged `main` at `794ea10`, with file and line references, so that
the implementation can be judged against measurements rather than against a plan.

The short version: **five of the things the brief asks for already exist and must be
reused rather than rebuilt**, one of them is a recorded open question that this
package is explicitly named as the trigger to resolve, and exactly three decisions
are genuinely undetermined. Those three are set out in §6 with their risks, because
the brief says not to guess a dangerous default silently.

## 1. What already exists

### 1.1 The permissions already say "categories"

`packages/contracts/src/permissions.ts:165-166`:

```
p('catalog.view', 'View products and categories', 'LOW'),
p('catalog.edit', 'Create or edit products and categories'),
```

The frozen catalogue already describes these two keys as covering categories. **No
new permission is needed and none should be added.** A `categories.view` would be a
second answer to a question `catalog.view` already answers, and `PERMISSIONS` is a
contract: adding a key is a contract change that this package does not need to make.

### 1.2 Products already have ordering, activation and visibility

`apps/api/src/infrastructure/persistence/schema.ts:2589`:

| column       | meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `status`     | `ACTIVE` / `INACTIVE`, CHECK-constrained to `PRODUCT_STATUSES` |
| `audience`   | `EVERYONE` / `RESELLERS_ONLY` / `HIDDEN`, CHECK-constrained    |
| `sort_order` | `integer NOT NULL DEFAULT 0`, what an operator drags           |

So the brief's "active/inactive", "visible/hidden" and "display order" are shapes this
repository already has a vocabulary for. The new fields belong to the CATEGORY and
must mirror that vocabulary rather than invent a parallel one — see §5.

### 1.3 A product's status and audience mean two different things, and collapsing them is a named defect

`packages/contracts/src/catalog.ts:96-111` states it directly: an `INACTIVE` product
cannot be bought by anyone, including through a link an operator pasted into a
conversation; a `HIDDEN` product is live and merely unlisted, "which is how a tenant
sells something to one customer without publishing it".

That distinction is why there are two evaluators, not one
(`apps/api/src/modules/commerce/catalog/application/catalog-visibility.ts`):

- `isCustomerVisible` — may this be SHOWN? Uses `isListed`, so `HIDDEN` is excluded.
- `unorderableReason` — may this be BOUGHT? Uses `isPurchasable`, so `HIDDEN` is
  deliberately still orderable, and the docblock says using `isListed` here "would
  collapse `HIDDEN` into `INACTIVE` and delete the whole distinction the contract
  exists to draw".

**This is the single most load-bearing fact for WP5.** The brief says hidden
categories must not appear to customers. It does not say what a hidden category does
to a product reached by a direct reference, and the answer is not obvious — see §6.3.

### 1.4 The customer catalogue filters BEFORE the bound, and the alternative is a thrice-found bug

`ProductService.browse` (`product.service.ts:147`) computes `eligiblePanelIds` from
`PanelSalesGate` and hands them to `repository.listCatalog` as a WHERE clause. Its
docblock records why, and it is worth quoting because the same mistake is available
to WP5:

> Filtering what a bounded query returned is the shape this was twice, and each time
> it left a number at which the catalogue silently emptied: with the bound applied
> first, twenty ineligible products hid an eligible twenty-first; scanning
> `PRODUCT_PAGE_MAX` moved that to a hundred; widening to `PRODUCT_PAGE_MAX * 5`
> moved it to five hundred.

`listCatalog` (`drizzle-product.repository.ts:208-268`) therefore carries every
predicate in SQL: tenant, `status = 'ACTIVE'`, panel eligibility as a single bound
`uuid[]`, `audience NOT IN ('HIDDEN','RESELLERS_ONLY')`, price present, panel present
— then `ORDER BY sort_order, created_at, id` and `LIMIT n+1`.

**Category filtering joins that WHERE clause.** A category predicate applied to what
`listCatalog` returned reintroduces the identical defect, with "enough products in
hidden categories" as the new way to empty a shop.

### 1.5 The visibility rule is stated twice on purpose, and a test asserts the two agree

`catalog-visibility.ts` says so explicitly: the rule exists as a function AND as a SQL
predicate, "a duplication with a reason", and `catalog.test.ts` runs both over the same
matrix and asserts they agree "so the pair cannot drift silently". Any category
predicate must be added to **both** halves and to that matrix test, or the pair starts
disagreeing the moment categories exist.

### 1.6 Historical orders are already snapshot-protected

`schema.ts:2806-2823`. `orders.product_id` carries the comment _"Navigation only. The
snapshot below is the truth about this purchase"_, and the snapshot is
`line_title`, `line_duration_days`, `line_traffic_bytes`, `line_device_limit`,
`line_unit_price_amount`, `line_quantity`, plus `subtotal/discount/total/currency` and
the full `quote` jsonb.

**So the brief's requirement that reassignment leave historical orders unchanged is
already satisfied for product identity and pricing, and requires no work.** Nothing
about moving a product between categories can reach those columns.

What is NOT satisfied is a category snapshot, because there is no category. That is a
decision, not an oversight — §6.2.

## 2. The open question this package is named to close

`docs/open-questions.md`, **OQ-4B-01** — "how a customer reaches a catalogue longer
than one Telegram message". `/catalog` shows one button per product bounded at
`CATALOG_PAGE_SIZE = 20`, `listCatalog` reports `hasMore`, and
`bot-runtime.ts:5970` drops it: a tenant with twenty-one sellable products shows
twenty and says nothing about the twenty-first.

The entry names three candidate answers — a next-page button, **categories**, or a
search — and records its own trigger:

> **Trigger to resolve:** the first tenant with more than twenty sellable products, or
> the phase that adds categories — whichever comes first. Whoever does it decides the
> ordering key at the same time, because a cursor over `sort_order` is the part that
> is not obvious.

WP5 is that phase. Two consequences:

1. The audit closes OQ-4B-01 or it explains why it remains open. Silently leaving a
   `hasMore` on the floor in a package that adds the feature the entry names would be
   the worst of both.
2. **The ordering key must be decided deliberately.** `ports.ts:49-62` and
   `drizzle-product.repository.ts:87-96` both record the reason the admin list's cursor
   is `(created_at, id)` and NOT `sort_order`: a keyset over a mutable column skips or
   repeats rows when an operator drags something mid-traversal, which is the defect
   migration 0026 retired for panels. The customer catalogue reads in `sort_order`
   order precisely BECAUSE it is a bounded single page rather than a traversal.

   A category listing has the same property and needs the same treatment: ordered by
   the category's display order for reading, keyed on something immutable for any
   traversal.

## 3. Tenancy, idempotency and audit — the shapes to copy, not invent

- Every tenant-owned table carries `tenant_id uuid NOT NULL` and composite indexes lead
  with it (`nexa-migrations`). `products_tenant_sort_idx` is the worked example.
- Cross-table foreign keys are COMPOSITE — `products_tenant_panel_fk` references
  `(panels.tenant_id, panels.id)` rather than `panels(id)` alone, because a single-column
  reference constrains a product to SOME panel rather than to one of ITS OWN tenant's.
  A `products.category_id` must use the same composite shape.
- Every write path goes through `runAuthorizedMutation`, which opens the unit of work
  and only then checks the session, the permission and scope activity. Every state
  change takes an idempotency key. Every mutation writes an audit row.

None of this is new work; it is the shape every service in `modules/commerce` already
has, and `ProductService` is the nearest template.

## 4. What is genuinely missing

| #   | gap                                                          | evidence                                                                     |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| G1  | no `product_categories` table                                | `schema.ts` has none; `grep -i categor` over the schema returns nothing      |
| G2  | no category column on `products`                             | `schema.ts:2589-2622`                                                        |
| G3  | no category vocabulary in contracts                          | `catalog.ts` has `PRODUCT_STATUSES`/`PRODUCT_AUDIENCES` and no category type |
| G4  | the customer catalogue is flat                               | `bot-runtime.ts:5970` — one button per product, no grouping                  |
| G5  | the Web Admin products page has no category column or filter | `apps/web/src/pages/products.tsx`                                            |
| G6  | `hasMore` is dropped by the bot surface                      | `bot-runtime.ts:5970`, and OQ-4B-01                                          |

## 5. The mapping this package will use

A category's fields mirror the product vocabulary rather than inventing a parallel one:

| brief's field     | maps to                                                             | reason                                       |
| ----------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| active / inactive | a CHECK-constrained status, same shape as `PRODUCT_STATUSES`        | an operator saying "stop selling this group" |
| visible / hidden  | a CHECK-constrained visibility, same shape as the `HIDDEN` audience | an operator saying "do not list this group"  |
| display order     | `sort_order integer NOT NULL DEFAULT 0`                             | identical to products                        |
| name              | tenant text                                                         | the operator's own words                     |
| description       | nullable tenant text                                                | identical to products                        |
| emoji icon        | nullable, validated                                                 | see §6.1                                     |
| stable identifier | `uuid` primary key, generated in-app                                | every other table                            |

## 6. The three decisions that are NOT determined by the repository

Recorded here with their risk rather than chosen silently, as the brief requires.

### 6.1 UNKNOWN — what an "emoji icon" is allowed to be

The brief asks for an emoji icon. The repository has no precedent: no column anywhere
stores a grapheme for display, and `docs/research/` does not establish what the legacy
bot accepted. The risk of guessing is a category whose "icon" is an arbitrary string
that a Telegram button label renders as mojibake, or a length that breaks a 64-byte
`callback_data` neighbour.

**Proposal, to be stated in the implementation rather than assumed here:** a nullable
short text column with an explicit maximum, validated at the contract, with the
validation stating what it does and does not enforce. Recorded as an open question if
the validation turns out to need evidence the corpus does not have.

### 6.2 DECISION REQUIRED — does an order snapshot its category?

Product identity and pricing are already snapshotted (§1.6). A category is not, because
there is no category.

- **If an order should ever display the category it was bought from**, the snapshot
  columns must land in the same migration that adds categories. Adding them later means
  every order written in between has no category and can never be given one truthfully.
- **If it should not**, the audit must say so explicitly, so the absence is a decision a
  reader can find rather than a gap they discover.

The brief's wording — "historical Orders preserve product/category/pricing snapshots
unchanged after reassignment" — reads as requiring the snapshot. The implementation
will add it, and this section is where that reading is recorded so it can be corrected
if it is wrong.

### 6.3 DECISION REQUIRED — what a hidden or inactive category does to a DIRECT product reference

The brief says empty, inactive and hidden categories must not appear to customers. It
does not say what happens when a customer holds a product id — from a screenshot, or
from an operator who pasted it deliberately — whose category is hidden or inactive.

The repository has a strong precedent and it points in two different directions at once
(§1.3):

- `HIDDEN` on a product means unlisted but **still orderable**, and `catalog.ts` says
  that is the whole point of the state existing.
- `INACTIVE` on a product means **not orderable by anyone**, link or no link.
- `RESELLERS_ONLY` is the one audience that is hidden AND refused, and
  `catalog-visibility.ts` explains why: "Hiding it from the catalogue while leaving it
  orderable would make the exclusion above cosmetic … the whole point of failing closed
  is that both halves close."

**Proposal:** a hidden category hides its products from the listing but leaves them
orderable, exactly like a `HIDDEN` product; an inactive category makes its products
unorderable, exactly like an `INACTIVE` product. That is the reading that keeps one
vocabulary rather than two, and it keeps the operator's "unlist this group" distinct
from "stop selling this group" — the distinction `catalog.ts` says must not collapse.

This is a business rule, so it is recorded as a proposal with its reasoning. If the
owner wants a hidden category to also refuse orders, that is the `RESELLERS_ONLY` shape
instead, and it is a one-predicate change in `unorderableReason`.

## 7. Migration

Next number is **0097** (`apps/api/drizzle/` ends at
`0096_provider_refused_failure_kind.sql`). Forward-only; never edit an applied one.

**The backfill is the dangerous part.** `products.tenant_id` is `NOT NULL`, so a
`NOT NULL` `category_id` needs a value for every existing product in every tenant.

| option                                                                                  | cost                                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| nullable `category_id`, no default category                                             | cheap migration, permanent ambiguity: "uncategorised" becomes a state every read must decide about, for ever |
| `NOT NULL` + one tenant-scoped default category created and backfilled by the migration | matches the brief's "every sellable Product belongs to exactly ONE Category"; costs a naming decision        |

The second is what the brief asks for and is what the implementation will do. Two
constraints on it, both from `CLAUDE.md`:

- the default category is **tenant-scoped** — one per tenant, created for every tenant
  that has products, never a shared row;
- its name must come from a **template key**, not a Persian string literal in SQL.
  "Customer-facing text comes from a template key. No string literals in surfaces" is a
  non-negotiable, and a name baked into a migration is the least renameable string in
  the system. The operator must be able to rename it, and the migration must not be the
  thing that decides what it is called.

## 8. What this package will NOT do

- **No new permission.** §1.1.
- **No second visibility evaluator.** The category predicate joins `isCustomerVisible`
  and `unorderableReason` and the SQL in `listCatalog`, and the existing matrix test is
  extended to cover the pair. §1.5.
- **No filtering after the bound.** §1.4.
- **No Phase 7.** Discounts, referral, cashback, affiliate, resellers and promotions
  stay unbuilt; `CLAUDE.md` forbids them without an explicit instruction, and a category
  is not a pricing rule.
- **No weakening of the hotfix.** `decideEligibility` and the payment-before-provisioning
  order are untouched; a category is a filter in front of them, never a replacement.
