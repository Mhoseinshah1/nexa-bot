# WP5 — falsification record

Every rule WP5 installs, reverted one at a time, with the committed test that fails
as a result. A rule with no test is a rule the next commit reverts silently; a test
that stays green under mutation is not a test. Each mutation was applied alone to the
working tree, the named suite was run, and the file was restored and compared before
the next one.

## Provisioning and the upgrade path

| #     | rule                                                                 | mutation                                                              | tests that die                                                                                                                                                                        | result |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W5-01 | a provisioned tenant gets its first category in the same transaction | the `ensureDefault` call removed from `provision-installation.cli.ts` | `provision-installation.test.ts` › creates one, in the same transaction as the tenant; › writes no second one when the installer is rerun; › keeps a renamed category through a rerun | KILLED |
| W5-02 | 0100 re-keys every category whose id is not a UUIDv7                 | the selection `<> '7'` → `= 'x'`, so nothing is re-keyed              | `product-categories-schema.test.ts` › re-keys it to a v7, keeps every other column, and carries its products with it                                                                  | KILLED |
| W5-03 | the id 0100 builds is version 7                                      | bit 52 set twice instead of bits 52 and 53, which spells version 5    | `product-categories-schema.test.ts` › re-keys it to a v7, keeps every other column, and carries its products with it; › changes nothing when it runs a second time                    | KILLED |

W5-02 and W5-03 are the repair for a defect found while building the Telegram Admin
section: 0097 and 0099 wrote each upgraded tenant's default category with
`gen_random_uuid()`, a v4 id that every category reader refuses. The case _reproduces the
defect: the backfilled id is refused by every reader before 0100_ keeps the evidence.

## The category service

`tests/integration/product-categories.test.ts` unless another is named.

| #     | rule                                               | mutation                                                      | tests that die                                                                                                                                                                                   | result |
| ----- | -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| W5-04 | a category holding products is not deleted         | the `held > 0` refusal removed                                | `product-categories.test.ts` › refuses while products remain — a WITHDRAWN one included — and says how many; › takes the row lock BEFORE counting, so a concurrent product is counted            | KILLED |
| W5-05 | the lock is taken BEFORE the count                 | the count moved above `lock`                                  | `product-categories.test.ts` › takes the row lock BEFORE counting, so a concurrent product is counted                                                                                            | KILLED |
| W5-06 | a reassignment writes the destination              | the product's CURRENT category written back instead           | `product-categories.test.ts` › moves exactly that product, and records the category it came FROM; › keeps the name, emoji and id it was bought under through rename, move, withdrawal and delete | KILLED |
| W5-07 | an order's category is a snapshot, not a reference | the order read resolves the category through the live product | `product-categories.test.ts` › keeps the name, emoji and id it was bought under through rename, move, withdrawal and delete                                                                      | KILLED |

W5-05 is a controlled interleaving, not `Promise.all`: a raw transaction inserts a
product into the category and is held open, the delete is shown BLOCKED in `pg_locks`,
and only then does the insert commit.

The same test file found a real defect before any mutation was run: `reorder`
interpolated two bare arrays into the SQL template, which Drizzle expands into a ROW
constructor, so every reorder failed with `record::uuid[]`. Fixed with `sql.param`.

## The customer catalogue

| #     | rule                                                         | mutation                                                   | tests that die                                                                                                                                                                                                                                                                              | result |
| ----- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W5-08 | the category list carries its own tenant predicate           | the tenant term dropped from `listCustomerCategories`      | `category-browse.test.ts` › lists none of another tenant categories, whatever panels it is told are eligible                                                                                                                                                                                | KILLED |
| W5-09 | the product page carries its own tenant predicate            | the tenant term dropped from the product predicate         | `category-browse.test.ts` › opens another tenant category on an EMPTY page, whatever panels it is told are eligible                                                                                                                                                                         | KILLED |
| W5-10 | a HIDDEN category is never listed                            | the visibility term dropped from the category list         | `category-browse.test.ts` › agrees about; `telegram-order-flow.test.ts` › never lists a HIDDEN category, and still sells its product by direct reference                                                                                                                                    | KILLED |
| W5-11 | categories are ordered by `sort_order`, then id              | ordered by name                                            | `telegram-order-flow.test.ts` › orders categories by sort order, then by id, and never by name                                                                                                                                                                                              | KILLED |
| W5-12 | the list and the page apply the same product predicate       | the product predicate forgets the category's visibility    | `category-browse.test.ts` › agrees about                                                                                                                                                                                                                                                    | KILLED |
| W5-13 | an INACTIVE category sells nothing, even by direct reference | the confirmation re-check of the category's status removed | `telegram-order-flow.test.ts` › never lists an INACTIVE category, and refuses its product even by direct reference                                                                                                                                                                          | KILLED |
| W5-14 | Next is drawn only when a next page exists                   | Next always drawn                                          | `telegram-order-flow.test.ts` › lists every sellable product in the category as a button carrying its id, and nothing else; › pages a long category, drawing Next and Previous only when that page exists; › recovers a STALE page past the end to the first page, rather than an empty one | KILLED |

W5-10 and W5-12 cite the `it.each` matrix by its literal head; the row that dies is
`'a product in a HIDDEN category'`. W5-08 and W5-09 are held at the repository and not
through the service, because the service's eligible-panel list is already
tenant-scoped and would hide a missing predicate — the case hands the repository
ANOTHER tenant's panel for exactly that reason.

## The Web Admin

| #     | rule                                         | mutation                               | tests that die                                                                                 | result |
| ----- | -------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| W5-15 | hide and deactivate are two different routes | the hide button posts to `/deactivate` | `product-categories.test.tsx` › sends hide to the VISIBILITY route and never to the status one | KILLED |
| W5-16 | a reorder sends the whole list, renumbered   | two `sortOrder` values swapped instead | `product-categories.test.tsx` › sends the WHOLE new order, renumbered from zero                | KILLED |

## The Telegram Admin categories section

Mutations against `apps/api/src/surfaces/telegram/bot-runtime.ts`, run against
`tests/integration/telegram-admin-categories.test.ts` and `tests/unit/bot-runtime.test.ts`.

| #     | rule                                                       | mutation                                                | tests that die                                                                                                                                                                                              | result |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W5-17 | the Categories button is drawn only for `catalog.view`     | the permission half of the menu gate removed            | `telegram-admin-categories.test.ts` › draws no Categories button for an administrator without catalog.view                                                                                                  | KILLED |
| W5-18 | no write button is drawn without `catalog.edit`            | the detail builder draws writes for every administrator | `telegram-admin-categories.test.ts` › shows one category with its real product count and no write button to a viewer                                                                                        | KILLED |
| W5-19 | a flag button carries the TARGET state                     | the activate and deactivate codes swapped               | `telegram-admin-categories.test.ts` › deactivates through the service, and a second tap writes nothing more                                                                                                 | KILLED |
| W5-20 | a move renumbers the whole order                           | only the two neighbours' sort values swapped            | `telegram-admin-categories.test.ts` › moves categories that share a sort order, which a two-value swap would not                                                                                            | KILLED |
| W5-21 | a redelivered move is recognised, not refused              | the payload-mismatch branch removed                     | `telegram-admin-categories.test.ts` › moves a category one place down, and a redelivered tap does not move it twice                                                                                         | KILLED |
| W5-22 | no delete confirm is drawn for a category holding products | the non-empty branch made unreachable                   | `telegram-admin-categories.test.ts` › offers no confirm for a category holding products, and says how many                                                                                                  | KILLED |
| W5-23 | the picker never offers the product's current category     | the filter removed                                      | `telegram-admin-categories.test.ts` › offers every category except the current one, and moves the product on the tap; › says there is nowhere to move a product when its category is the only one           | KILLED |
| W5-24 | a move's pair is product first, category second            | the pair encoded category first                         | `telegram-admin-categories.test.ts` › offers every category except the current one, and moves the product on the tap                                                                                        | KILLED |
| W5-25 | `x` asks and only `X` deletes                              | `x` routed to the delete intent                         | `telegram-admin-categories.test.ts` › asks before deleting an empty category, and deletes it on the confirm; `bot-runtime.test.ts` › routes each of the nine category codes to its own intent, and no other | KILLED |
| W5-26 | a rename changes only the name                             | the rename writes a null emoji                          | `telegram-admin-categories.test.ts` › renames one field and leaves the emoji and description as they were                                                                                                   | KILLED |
| W5-27 | a redelivered create makes one category and is not refused | the payload-mismatch branch removed from create         | `telegram-admin-categories.test.ts` › creates ONE category when the same update is delivered twice                                                                                                          | KILLED |

W5-21 and W5-27 exist because a Telegram update is redelivered whenever its 200 was
not seen, and the runtime acts on every delivery. A move or a create recomputes its
input from the state the first delivery left, which no longer hashes the same under the
same idempotency key; the store's refusal therefore means "this already ran", and is
answered with the current list rather than with a refusal for a write that happened.
