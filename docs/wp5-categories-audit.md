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

## 6. The three decisions, as the owner settled them

These were recorded as open when this audit was first written, because the brief says
not to guess a dangerous default silently. The owner answered all three. Their answers
are reproduced here as the specification the implementation is built against; where an
answer differs from what this audit proposed, that is called out, because a proposal
that quietly became a decision is how a guess gets laundered into a requirement.

### 6.1 Emoji — OPTIONAL, unicode text, no icon system

- nullable and optional; **absence must be valid**, everywhere, on every surface;
- unicode text is sufficient — no separate icon library or icon system in WP5;
- editable from **both** Web Admin and Telegram Admin;
- the customer catalogue **displays it when present**.

Matches what this audit proposed. The "no icon system" clause is the load-bearing part:
it forecloses a validated-enum-of-known-icons design, which would have been the
defensible-looking way to get this wrong and would have made every operator's emoji a
contract change.

### 6.2 Category snapshot — YES for new orders, and NEVER backfilled

New orders snapshot the category used at purchase time, durably. The snapshot must not
change if the product is later reassigned, the category renamed, the category
hidden or inactivated, or the category deleted where deletion is allowed. It must carry
enough authoritative category identity and display information to show truthfully what
the order was bought from.

**And the part this audit did not anticipate, stated by the owner in terms:**

> Existing historical orders created before WP5 must NOT be backfilled with the
> Product's current Category and presented as historical truth. For pre-WP5 orders:
> category snapshot may remain NULL / unknown; do not invent historical data.

Three consequences that bind the implementation:

1. the snapshot columns are **NULLABLE**, and no CHECK may require them;
2. migration 0097 **must not** populate them from `products.category_id`. A backfill
   would be fabricated provenance — the product's category TODAY is not evidence of
   what the customer browsed months ago, and writing it into an order row makes a guess
   indistinguishable from a record;
3. every surface that renders an order must handle a NULL category **as unknown**, not
   as an error and not by falling back to the product's current category. A fallback
   join is the same fabrication performed at read time instead of write time.

This is the same rule `orders.product_id`'s own comment already states for the rest of
the line — "navigation only, the snapshot below is the truth" — extended to the one
field that has no history to draw on.

### 6.3 Hidden, inactive and empty — three different rules, one implementation

| state    | listed to customers?                            | orderable by direct reference?                                     |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| HIDDEN   | no — not discoverable through category browsing | **YES**, if the product itself is otherwise eligible               |
| INACTIVE | no                                              | **NO** — unavailable for new purchases, direct references included |
| EMPTY    | never shown                                     | n/a — it has nothing to order                                      |

The owner confirmed the reading this audit proposed from `catalog.ts`: hidden alone does
not make an otherwise valid product unorderable, and existing product-level eligibility
rules still apply on top. That keeps "unlist this group" distinct from "stop selling
this group", which is the distinction §1.3 says must not collapse.

**The authoritative confirmation transaction must re-check the INACTIVE rule.** A
catalogue filter is a courtesy — a product id travels in a screenshot, and a category
can be deactivated between a customer's tap and their confirmation. This is the same
discipline `PanelSalesGate` already has: filter for the shop, re-decide under lock for
the money.

**One rule, four callers**, stated by the owner as a requirement rather than a
preference:

> The same rule must be used by: catalog browsing; Telegram customer flow;
> Web/application queries; authoritative order confirmation. Do not create separate
> interpretations per surface.

That is the shape §1.5 already describes — one evaluator plus its SQL twin, with a
matrix test asserting the two agree — and it is what the implementation extends rather
than duplicates.

**Emptiness is structural, not a second check.** A category is empty exactly when no
product in it passes the customer-visibility predicate. Deriving the customer's category
list from the visible products, rather than listing categories and then asking each one
whether it has any, means an empty category cannot be shown by an oversight: there is no
code path that could.

## 6.4 Pagination — the owner's resolution of OQ-4B-01

OQ-4B-01 is closed by this package, explicitly rather than by implication, and the
shape is the owner's:

> Category -> paginated Products within that Category. Do NOT treat Categories as a
> substitute for Product pagination.

That sentence forecloses the cheap reading of this whole package. Categories make a
long catalogue _navigable_; they do not make it _bounded_. A tenant with forty products
in one category still needs pages, and a design that quietly relied on "well, each
category is small" would have reproduced `CATALOG_PAGE_SIZE`'s silent truncation one
level down.

**Offset pagination, ordered `sort_order ASC, id ASC`.** The owner ruled out a keyset
cursor, and the reason is the one `ports.ts` and migration 0026 already record from the
other side: `sort_order` is what an operator drags, so a cursor built on it is a cursor
over a mutable column. Rather than key on something immutable and lose the operator's
ordering, WP5 takes the offset and accepts what an offset costs.

**What that costs, stated rather than glossed.** An operator reordering products while a
customer is paging can change page membership — a product can be missed or repeated
across a page boundary. The owner has accepted that for WP5. So this package does not
claim snapshot-stable pagination anywhere, and a future immutable ranking scheme may
replace the offset if scale requires it.

**Every predicate goes in the SQL, before `LIMIT`/`OFFSET`.** Tenant, category,
category visibility and activity, product status and audience, panel eligibility, price
and panel presence. This is §1.4's rule applied to a second query, and the failure it
prevents is the same one that has now been found three times: a page filtered in memory
after a bounded fetch is a page that silently empties when enough ineligible rows
precede an eligible one. **Never fetch a bounded page and then filter in memory.**

**Next and Previous appear only when they are true.** `hasNext` comes from reading
`limit + 1` rows and discarding the extra — the shape `listCatalog` already uses — so it
is a fact about the data rather than an assumption; `hasPrevious` is simply page > 1. No
`COUNT(*)`, because a total is not needed to answer either question truthfully.

**Category lists page too**, on the same terms, once they exceed the keyboard bound.

**A stale page or callback fails or recovers truthfully.** It must never silently select
a different product — which is exactly what an offset into a changed list does if the
surface trusts the position instead of the identity. The callback carries the product
id, and the id is what is acted on.

**The Web Admin keeps its own pagination conventions** and consumes the same eligibility
rules. The rule is shared; the paging mechanism need not be.

## 7. Migration

Next number is **0097** (`apps/api/drizzle/` ends at
`0096_provider_refused_failure_kind.sql`). Forward-only; never edit an applied one.

**0098 follows it, and the reason is worth recording.** 0097's indexes lead
`(tenant_id, category_id, sort_order, created_at, id)`, which was right for the ordering
this audit assumed. The owner then specified `sort_order ASC, id ASC` — no `created_at`
— so the index no longer matches the sort it exists to serve. The fix is a NEW migration
adding the matching indexes, not an edit to 0097, even though 0097 has been applied
nowhere but a development database. `nexa-migrations` is explicit that the rule does not
get an exception because the case looks harmless, and `0002_drop_callback_refs.sql` is
the worked example of exactly this restraint.

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
- **No backfill of historical orders.** §6.2. Migration 0097 adds the snapshot columns
  and leaves every pre-existing order's category NULL, and no surface may fill that NULL
  by joining to the product's current category at read time.
- **No icon system.** §6.1. An optional unicode text field, and nothing that would make
  an operator's choice of emoji a contract change.
