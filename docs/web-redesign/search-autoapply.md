# Search applies itself on every list (FIX-01, 2026-10-09)

The owner's request: on every Web Admin page with a data search, the results
update by themselves after typing or pasting, with no Enter and no button,
the way `/users` already did. "Fixing two pages is not enough."

## One debounce

There is one implementation, `useDebouncedApply` in
`apps/web/src/ui/list-search.tsx`. `ListSearchBox` (the shared `q` box of
`/users`, `/orders`, `/services` and `/payments`) uses it, and so does every
page whose search is not that box. A second copy would be a second answer to
"when does typing search", and the two would drift.

| Rule                                                                                                                                                  | Where it is kept                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 ms of stillness (`LIST_SEARCH_DEBOUNCE_MS`, unchanged from #242); a burst of keystrokes is one navigation, so one request                         | the hook's timer, restarted only when `wanted`, `applied`, readiness, composition or the route change, and not on every render: a list re-renders while it fetches          |
| Typing, pasting and deleting all apply; Enter and the button still apply at once and cancel the pending apply                                         | the hook compares `wanted` with `applied`; an Enter changes `applied`                                                                                                       |
| IME composition (Persian) never searches a half-composed word                                                                                         | `composition` handlers on each input                                                                                                                                        |
| A navigation the box did not make (sidebar link, chip, Breadcrumb) cancels a pending apply instead of carrying half-typed text into the new list      | `edited()` records the route the text was typed under; the timer runs only while the route is still that one                                                                |
| An invalid draft (incomplete id, non-code action, reversed dates, entity id without type) is never applied by itself; its error stays under the field | the page's `ready` gate                                                                                                                                                     |
| No stale answer: a slower response to an older term never replaces a newer one                                                                        | unchanged, and now tested on every list: the applied term is part of every list's query key                                                                                 |
| A new term starts at the first page                                                                                                                   | unchanged: the cursor is either a `resetKeys` URL key (`/payments`, `/services`) or a trail keyed by the filter signature (every other list)                                |
| The URL stays the source of truth; a search adds no history entry                                                                                     | `setQuery`/`setQueries` navigate with `replace`                                                                                                                             |
| Focus, and a trailing space typed before a pause, stay in the box                                                                                     | the box is never remounted; an automatic apply records the trimmed value as the draft's own applied value, so the URL catching up does not rewrite the text under the caret |

Load: every server search is bounded by a page size and keyset paging, and the
debounce is what turns a typed Telegram id into one request rather than ten.
None of the newly auto-applied searches is more expensive than `/users`'
(`/payments` goes through the same `list-search` persistence helper as
`/orders` and `/services`). The audit log, tickets and referrals apply only a
draft their own validation accepts. No minimum length was added because none
of these searches had one, and adding one would change what Enter does.

The search buttons stay, for keyboard and screen-reader users, and are no
longer needed.

## Route matrix

"Before" is `main` at eb139bef. Tests are in
`tests/web/search-autoapply.test.tsx` unless named otherwise. Every route in
the first table runs the same six cases (`$name: the search applies itself
(FIX-01)`): **typing** (one request after the debounce, none before, no extra
history, focus kept), **paste** (trimmed), **clear** (unfiltered list
restored), **rapid change** (a held, older answer released after the newer
one does not replace it), **cursor** (a new term after "next page" sends no
cursor), **navigation** (a half-typed term is not carried into a list reached
another way).

### Data searches: changed

| Route                      | Input                                                                         | Before                      | After                                                                                 | Tests                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/payments`                | `ListSearchBox` `#payments-search` (`q`)                                      | Enter or button only        | auto-apply; the URL `cursor` is dropped with the term                                 | `/payments: …` (6)                                                             |
| `/products`                | title search `#products-title` (`title`)                                      | Enter or button only        | auto-apply, trimmed; trail keyed by the title                                         | `/products: …` (6), `/products: Enter still applies at once…`                  |
| `/resellers`               | search `#resellers-search` (`search`)                                         | Enter or button only        | auto-apply, trimmed; trail keyed by the search                                        | `/resellers: …` (6), `/resellers: a pause after a trailing space…`             |
| `/tickets`                 | customer `#tickets-customer` (`customer`), and the two dates in the same form | Enter or «اعمال» only       | the form applies itself while its range is valid; the trail is keyed by the filters   | `/tickets: …` (6), `/tickets: a reversed date range sends nothing…`            |
| `/audit-log`               | actor, action, entity id, customer id, dates (`#audit-*`)                     | Enter or «اعمال فیلتر» only | the form applies itself while it has no problem; the trail is keyed by the filters    | `/audit-log: …` (6), `/audit-log: an action that is not a code sends nothing…` |
| `/referrals`               | referrer id `#referrals-referrer` (`referrerId`)                              | Enter or «اعمال» only       | a complete id (or an emptied box) applies itself; both lists' trails are keyed by it  | `/referrals: …` (6), `/referrals: a half-typed referrer id sends nothing`      |
| `/resellers` register form | customer picker (`GET /users?q=`, in state, not the URL)                      | Enter or button only        | auto-search; emptying the box withdraws the results (a picker has no unfiltered list) | `the customer picker searches by itself` (2)                                   |

### Data searches: already applied themselves, not rebuilt

| Route                           | Input                               | Behaviour                                                                                                             | Tests                                                             |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/users`                        | `ListSearchBox` `#users-search`     | debounced since UX batch 02 (#242); now through the shared hook                                                       | `customer-search.test.tsx`                                        |
| `/orders`                       | `ListSearchBox` `#orders-search`    | debounced since #242; now through the shared hook                                                                     | `list-polish.test.tsx` (`the order search applies itself`)        |
| `/services`                     | `ListSearchBox` `#services-search`  | debounced since #242 (`588357ff`, 2026-10-07 — after the staging build the owner tested); now through the shared hook | `list-polish.test.tsx` (`the service search applies itself (N3)`) |
| `/content`                      | template search `#templates-search` | filters loaded rows in the browser on every keystroke; no request                                                     | unchanged                                                         |
| `/roles`                        | permission search `#rbac-search`    | filters the matrix in the browser; no request                                                                         | unchanged                                                         |
| `/bot-buttons` (inline buttons) | button filter                       | filters in the browser; no request                                                                                    | unchanged                                                         |

### Out of scope by rule, recorded

| Route                | Input                   | Behaviour                                      | Why unchanged                                       |
| -------------------- | ----------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `/legacy-products`   | `#lpr-search`           | applies on every keystroke, undebounced        | Mirza (`legacy-*`) is out of scope for this program |
| `/legacy-debts`      | `#lwd-user`             | applies on every keystroke once it is a number | same                                                |
| `/legacy-invoices`   | archive filters         | apply on every change                          | same                                                |
| `/legacy-services`   | panel, product, invoice | apply on every change                          | same                                                |
| `/support-knowledge` | source select only      | no text search                                 | support AI is out of scope                          |

The legacy pages already search without Enter, but each keystroke is a
request. If they come back into scope, the change is `useDebouncedApply`
with the page's existing state.

### Not searches: left alone

| Route                                                                                                                                     | Input                                          | What it is                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| every page                                                                                                                                | command palette (`shell.tsx`)                  | navigation, not data                                      |
| `/discounts`, `/campaigns`, `/broadcasts`, `/audience-builder`, `/bulk-operations`                                                        | codes, labels, ids, dates                      | form fields of a record being edited                      |
| `/customers/:id`                                                                                                                          | transfer destination, phone, username, amounts | form fields of an action (the transfer preview is a POST) |
| `/category-icons`, `/settings`, `/panels`, `/trials`, `/service-refund-requests`, `/client-apps`, `/extra-devices`, `/system`, `/support` | settings and form fields                       | not a search                                              |
| `/campaigns`, `/discounts`, `/reseller-plans`, `/notification-center`, `/alerts`, `/incidents`                                            | chips and selects                              | discrete filters that already apply on press              |

## Mutations

Each rule below was reverted on its own, the three search suites
(`search-autoapply`, `customer-search`, `list-polish`) were run, and the rule
was restored. Every mutant was killed.

| Reverted rule                                                                          | Killed by                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/payments` box without `autoApply`                                                    | `/payments`: typing, paste, clear, rapid change, cursor                                                                                                                       |
| `/payments` without `resetKeys={['cursor']}`                                           | `/payments`: cursor                                                                                                                                                           |
| `/products` debounce never ready                                                       | `/products`: typing, paste, clear, rapid change, cursor                                                                                                                       |
| `/products` query key without the title                                                | `/products`: typing, paste, clear, rapid change, Enter                                                                                                                        |
| `/resellers` debounce never ready                                                      | `/resellers`: all five, and the trailing-space case                                                                                                                           |
| `/resellers` automatic apply without recording its value as the draft's                | `/resellers: a pause after a trailing space…`                                                                                                                                 |
| `/tickets` applies a reversed date range                                               | `/tickets: a reversed date range sends nothing…`                                                                                                                              |
| `/audit-log` applies a draft with a problem                                            | `/audit-log: an action that is not a code sends nothing…`                                                                                                                     |
| `/referrals` applies a half-typed id                                                   | `/referrals: a half-typed referrer id sends nothing`                                                                                                                          |
| customer picker debounce never ready                                                   | `the customer picker searches by itself`                                                                                                                                      |
| hook ignores composition                                                               | `useDebouncedApply: waits while composing…`, `customer-search: waits for an input method…`                                                                                    |
| hook ignores a route the box did not make                                              | every route's `navigation` case, `useDebouncedApply: cancels when the route moves…`, `customer-search: does not carry a half-typed term…`                                     |
| hook re-arms a cancelled draft when the route returns to the same key (Codex P2, #249) | `useDebouncedApply: does not revive a cancelled draft…`, `/products: a status chip inside the wait…`, `/products: another list inside the wait, then the browser Back button` |
| hook re-applies an applied draft                                                       | `useDebouncedApply: never applies a draft that is already the applied one`                                                                                                    |
| hook timer restarted by every render                                                   | `useDebouncedApply: is not restarted by a re-render…`                                                                                                                         |
| hook calls the first render's `apply`                                                  | 48 cases across every route                                                                                                                                                   |
