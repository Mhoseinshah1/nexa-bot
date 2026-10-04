# Web Admin search — one box per list (spec §10)

Every searchable Web Admin list draws **one** free-text box. It replaced a row of
single-purpose inputs per page (a Telegram-id box and a username box on `/users`, two
internal-uuid boxes on `/orders`, three on `/payments` and on `/services`). Non-text filters
— status, state, method, receipt disposition, delivery state — stay their own controls.

The customer column on every list row is the customer's **Telegram numeric id** (and
`@username` when there is one), linking to the customer page. The internal uuid is only the
link target; no list renders it as the customer's identity any more.

## Contract

- `q` on `GET /users`, `/orders`, `/payments`, `/services`: `listSearchQuerySchema` —
  trimmed, 1–64 characters (`LIST_SEARCH_MAX_LENGTH`). Over-long is a 400, not an empty page.
- `classifyListSearch(q)` (`packages/contracts/src/list-search.ts`) decides what the text is,
  by shape alone. The shapes do not overlap:

  | kind          | shape                                      | matched as          |
  | ------------- | ------------------------------------------ | ------------------- |
  | `TELEGRAM_ID` | `telegramUserIdSchema` (digits, no lead 0) | exact               |
  | `UUID`        | a UUIDv7 (every id this product mints)     | exact, lower-cased  |
  | `USERNAME`    | leading `@`, stripped                      | prefix, case-folded |
  | `TEXT`        | anything else                              | per list, below     |

  The Web Admin shows "searched as …" under the box from the same function.

- `orderSummarySchema` and `serviceSummarySchema` gained `customerTelegramUserId` and
  `customerUsername` (nullable, defaulted on parse, like the payment summary's pair). Every
  list row carries them; they are read through ONE reader,
  `readCustomerIdentities` (`apps/api/src/infrastructure/persistence/list-search.ts`), which
  the payment list now uses too.
- The old single-purpose parameters (`telegramUserId`, `username`, `customerId`, `orderId`,
  `productId`, `panelId`, `reference`, `providerUsername`) still work — the customer detail
  page's cards page by `customerId` — but no list page sends them any more.

## What each list matches

| list        | Telegram id                                                                                 | uuid                              | `@name`           | other text                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------- | --------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `/users`    | the customer, exact                                                                         | the customer                      | username prefix   | prefix of username, display name (first + last) or last name                                  |
| `/orders`   | the customer's orders                                                                       | order, customer or product        | customer username | snapshot title prefix, OR a product whose current title contains it                           |
| `/payments` | the customer's payments, OR reference / bank reference / gateway id spelled in those digits | payment, customer or order        | customer username | reference, bank reference or a gateway's own order / invoice / charge / payment id, **exact** |
| `/services` | the customer's services, OR that provider username                                          | service, customer, order or panel | customer username | provider username, **exact** (`providerUsernameLookupSchema`); anything else matches nothing  |

`/users` still charges `users.search` for `q`, as for every other way of finding one person;
the list without `q` stays `users.view`. Exact-only on money and account names is deliberate:
a partial match over references opens somebody else's payment, and a prefix over provider
usernames enumerates a panel's accounts (`ServiceSearch.providerUsername`).

### The customer picker (UX batch 01, item 9)

The reseller register form no longer asks for the customer's internal uuid. Its customer
field is a picker (`apps/web/src/pages/customer-picker.tsx`) that sends exactly
`GET /users?limit=10&q=…` — this search, not a second one — so it matches a Telegram id
exactly, a username with or without `@` from its start (case-insensitive), and the start of
a display name or last name, scoped to the actor's tenant and charged `users.view` and
`users.search` (the Web Admin draws it only when the actor holds both).
Every result is a button and **nothing is chosen for the operator**, not even a single
match: a username prefix can match two customers. Only name, `@username`, Telegram id and a
non-active status are drawn. The chosen row's id is what the register command receives; the
command itself still takes a uuid and refuses anything else. Without both permissions the
picker sends nothing and names the key; the customer page's "register as reseller" link
still hands a customer over by id. Pinned by
`tests/integration/reseller-customer-picker.test.ts` and `tests/web/resellers.test.tsx`.

### Searching as you type (UX batch 02, issue 13)

`/users` applies its box by itself: `ListSearchBox` with `autoApply`
(`apps/web/src/ui/list-search.tsx`). The draft is applied once it has been still for
`LIST_SEARCH_DEBOUNCE_MS` (400 ms — the app had no debounce convention; the owner asked for
300–500 ms). A paste is the same single change and takes the same path.

- **One request per burst.** Each keystroke restarts the wait; nothing is scheduled while the
  draft already reads as the applied search, so Enter (or the button, which stays) applies at
  once and the pending wait does not send it again.
- **Trimmed, never empty.** The applied value is `classifyListSearch`'s reading: surrounding
  whitespace is dropped, and an empty or whitespace-only box applies "no search" — no `q` at
  all, never `q=` (a 400). The box keeps what was typed, trailing space included, so a pause
  mid-name does not eat the space under the caret.
- **No stale answer.** The applied text is in the URL and in the page's query key
  (`['customers', signature, cursor]`), so an older, slower response lands in its own cache
  entry and is never drawn under a newer search.
- **Permissions unchanged.** Without `users.search` there is no box to apply; while the list
  is refused (`users.view`) the box is hidden and applies nothing.
- `/orders`, `/payments` and `/services` keep the explicit apply; `autoApply` is opt-in per page.

Pinned by `tests/web/customer-search.test.tsx` (burst, paste, Telegram id, `@username`, empty,
Enter, a slow older response, both permissions).

### First and last activity (UX batch 02, issue 12)

The two timestamp columns on `/users` (and on the customer page) were labelled «نخستین
تماس» / «آخرین تماس» — "contact", which reads as a call or a support request. They render
`firstSeenAt` / `lastSeenAt` from `customerSummarySchema`, which are `customers.first_seen_at`
and `customers.last_seen_at`. Their writers, all of them:

| writer                                                                                                 | `first_seen_at` | `last_seen_at`                        |
| ------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------- |
| `DrizzleCustomerRepository.resolve`, via `CustomerService.resolveFromUpdate`, from `BotRuntime.handle` | set on creation | `greatest(stored, now)` on every turn |
| `DrizzleLegacyImporterRepository.insertIfAbsent`                                                       | the import time | the import time; never touches a row  |

`BotRuntime.handle` runs for every update the webhook hands it: a `message` or a
`callback_query` from a non-bot user (`telegramFromOf`) — every text, command and button
press, not only `/start`. A replayed update does not bump it (idempotency), and `/ping` is the
one stated exclusion (`webhook.controller.ts`). No operator action, payment callback or panel
usage writes either column (a service's own `last_seen_at` is a different column on
`services`).

So they ARE the customer's activity in the bot, and are now labelled «اولین فعالیت» /
«آخرین فعالیت», with a note under the list naming what counts. One precise mismatch is
stated rather than hidden: for a customer brought over by the legacy importer, «اولین فعالیت»
is the import time — the previous system's first contact is not recorded anywhere, and
inventing one would be a fabricated fact. No new tracking was added. The Telegram admin
bot's customer detail (`bot.admin.customer_detail`) shows the same two columns, so its DEFAULT
catalogue text now reads «اولین فعالیت» / «آخرین فعالیت» too, as do its placeholder labels
in the template editor; a tenant's own override of that template is untouched
(`tests/integration/telegram-admin-customers.test.ts` pins the default).

Pinned by `tests/integration/telegram-customer-turn.test.ts` ("moves last_seen_at on an
ordinary message and on a button press, never first_seen_at") and the label case in
`tests/web/customer-search.test.tsx`.

## Why prefix, not infix — and not `pg_trgm`

`pg_trgm` is available in the PostgreSQL image but **no migration installs it**, and adding an
extension to every installation (and to every restore target the recovery lane validates) is
its own decision, not a side effect of a search box. So:

- every match against a table that grows with the installation is **exact or a prefix**,
  served by a btree — `text_pattern_ops` for `lower(col) LIKE 'x%'`, which the planner turns
  into an Index Cond range (`~>=~` / `~<~`);
- the one infix match is product name on `/orders`, and it runs over `products` — the
  catalogue, tens of rows per tenant — resolving ids first
  (`DrizzleOrderRepository.productIdsTitled`); `orders` is then read by product id.
- LIKE wildcards in the needle are escaped (`escapeLike`): a Telegram username's `_` would
  otherwise match any character.

If infix name search over customers is ever wanted, the plan is a `pg_trgm` GIN index on the
same expressions, installed by its own migration with the extension, and these plan tests
extended to assert it.

## Indexes

Built `CONCURRENTLY` through `ONLINE_INDEXES` (`online-indexes.ts`), because every one of
these tables is populated and written on a live installation and `botctl update` migrates
while the outgoing release still serves. No drizzle migration is needed for them.

| index                                        | serves                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `customers_tenant_full_name_idx`             | display-name prefix                                                                                                                  |
| `customers_tenant_last_name_idx`             | last-name prefix                                                                                                                     |
| `orders_tenant_line_title_idx`               | snapshot-title prefix                                                                                                                |
| `orders_tenant_product_created_idx`          | product arm (and the old `?productId=`, which had no index)                                                                          |
| `payments_tenant_order_idx`                  | order arm (and the old `?orderId=`)                                                                                                  |
| `payments_tenant_external_reference_idx`     | bank-reference arm                                                                                                                   |
| `services_tenant_panel_idx`                  | panel arm, all states (the capacity index excludes TERMINATED)                                                                       |
| `gateway_invoices_tenant_hinted_payment_idx` | gateway payment-id arm (Payment Operations Center); the order, invoice and charge ids use the `(tenant_id, provider, …)` unique keys |
| `gateway_invoices_tenant_hinted_invoice_idx` | the invoice id a verified webhook named for a lost create (CREATE_UNKNOWN), before an inquiry adopts it                              |

An `OR` is a bounded BitmapOr only when **every** arm has an index; one unindexed arm turns
the whole predicate into a filter over a walk of the tenant's table, returning the same rows.
That is why each arm above has one, and why only a plan can tell.

## Evidence

`tests/integration/list-search-plan.test.ts` seeds 20 000 customers, orders, payments and
services in **each** of two tenants, explains the statement each repository actually sends
(`listStatement`), and asserts the index names, no sequential scan of a large table, and
fewer than 500 rows discarded by a filter. Representative plans from that run:

```
customers, q = "First9001" (TEXT)
Limit -> Sort -> Bitmap Heap Scan on customers
  -> BitmapOr
     -> Bitmap Index Scan on customers_tenant_username_idx   (lower(username)  ~>=~ 'first9001' AND ~<~ 'first9002')
     -> Bitmap Index Scan on customers_tenant_full_name_idx  (lower(first||' '||last) ~>=~ … )
     -> Bitmap Index Scan on customers_tenant_last_name_idx  (lower(last_name) ~>=~ … )

orders, q = "900009001" (TELEGRAM_ID)
Limit
  InitPlan 1 -> Index Scan using customers_tenant_telegram_key   (evaluated once)
  -> Sort -> Bitmap Heap Scan on orders
       -> Bitmap Index Scan on orders_customer_created_idx  (customer_id = ANY ($0))

orders, q = "rare plat" (TEXT; product resolved first)
Limit -> Sort -> Bitmap Heap Scan on orders       (actual rows=20)
  -> BitmapOr
     -> Bitmap Index Scan on orders_tenant_line_title_idx       (~>=~ 'rare plat' AND ~<~ 'rare plau')
     -> Bitmap Index Scan on orders_tenant_product_created_idx  (product_id = '…')

payments, q = "900009001" (TELEGRAM_ID)
  InitPlan 1 -> Index Scan using customers_tenant_telegram_key
  -> BitmapOr: payments_customer_created_idx | payments_tenant_reference_key
               | payments_tenant_external_reference_idx

services, q = <uuid>
  -> BitmapOr: services_pkey | services_customer_created_idx | services_tenant_order_key
               | services_tenant_panel_idx
```

One finding the plan test produced, recorded because it is easy to undo: the product-name
arm was first written as `product_id = ANY(ARRAY(SELECT … FROM products …))` inside the page
query. The planner cannot see an InitPlan's result when it plans, so it guessed the arm
unselective and walked `orders_tenant_created_idx`, discarding 19 980 of 20 000 rows to find
a product on one order in a thousand. Resolving the product ids as their own statement, so
the page query carries them as literals, is what makes it read the product index. The
customer arms keep the InitPlan form: they resolve at most one id (Telegram id, unique) or a
username prefix, and they are measured above to reach their index.

Behaviour — every shape on every list, LIKE escaping, `users.search`, a tenant B that shares
every searchable value with tenant A, and thirty same-instant matches paged seven at a time
coming back exactly once — is `tests/integration/list-search.test.ts`; the classifier is
`tests/unit/list-search.test.ts`; the box and the Telegram-id columns are in
`tests/web/{users,payments,products-and-orders,services}.test.tsx`.

## Pagination

Unchanged: each list keeps its keyset on `(created_at, id)` — ascending on `/users`,
`/orders` and `/payments`, descending on `/services` — and the search is part of the
cursor trail's signature, so a cursor minted under one search is never replayed under
another. A search over `TEXT` sorts its (bounded) matches; it never pages by OFFSET.

## Not covered here

- There is no tenant-wide wallet or ledger list in the Web Admin: wallet entries are paged
  per customer on the customer detail page, which another work package redesigns. Nothing
  there takes free text.
- The customer DETAIL page is untouched (spec §11 is a separate package); it still shows the
  internal id in its own place.
