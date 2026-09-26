# Work Package 2 — falsification record

Every production rule this package added or changed, reverted one at a time
against the committed test that names it. A rule with no test is a rule the next
commit reverts silently; a test that stays green under mutation is not a test.

Run as: revert the single rule, run the named suite filtered to the named test,
restore the file, confirm green again. Nothing here was run and thrown away —
every row names a test that exists on this branch, and
`scripts/check-falsification-citations.mjs` resolves each one against the test
sources rather than taking this table's word for it.

WP2 has two halves and they fail differently. The Web Admin half is about
TRUTHFULNESS — a list that shows the wrong rows, or claims an ordering it does
not have, or draws a card a permission would refuse. The Telegram half is about
AUTHORITY — a callback anybody can craft reaching a write, a code table wired to
the wrong intent, or a refusal rendered as a fact about somebody else's data.

## The Web Admin: a customer's orders and services

`tests/web/users.test.tsx`, seven mutations.

| #    | Rule                                                     | Mutation                                                  | Named test                                                                     | Result   |
| ---- | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| W-01 | the orders pager is labelled for an ASCENDING traversal  | `nextLabel`/`previousLabel` dropped, leaving the defaults | _labels the orders pager for an ascending traversal and sends its cursor_      | KILLED   |
| W-02 | each embedded list asks only for THIS customer           | `customerId` dropped from the `fetchOrders` query         | _asks for THIS customer, with the embedded bound, on both lists_               | KILLED   |
| W-03 | a withheld card issues no request                        | `enabled: mayView` replaced with `enabled: true`          | _names the missing permission and asks for nothing when services are withheld_ | KILLED   |
| W-04 | a service's two state axes are drawn separately          | the delivery column deleted                               | _draws a delivered failure as ACTIVE and FAILED, never as one merged state_    | KILLED   |
| W-05 | the route derives the orders card from `orders.view`     | `may('orders.view')` replaced with `may('users.view')`    | _withholds both commerce cards from an actor holding only users.view_          | KILLED\* |
| W-06 | the route derives the services card from `services.view` | `may('services.view')` replaced with `may('users.view')`  | _withholds both commerce cards from an actor holding only users.view_          | KILLED   |
| W-07 | the services pager sends the cursor the server minted    | `onNext` reset to the first page                          | _labels the services pager for a descending traversal and sends its cursor_    | KILLED   |

\* W-05 SURVIVED its first run, and the gap is the one worth naming. The positive
case granted `users.view` AND `orders.view`, so deriving the prop from the wrong
key still drew the card — exactly how a derived-from-the-wrong-permission bug
survives a green suite. The negative case, an actor holding `users.view` alone,
is what can tell them apart, and it was written before the row was recorded.

## The Telegram administrator customer section

`tests/integration/telegram-admin-customers.test.ts`, eight mutations.

| #    | Rule                                                             | Mutation                                    | Named test                                                                                | Result |
| ---- | ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| T-01 | one list decides which sections open the panel                   | `CUSTOMERS_VIEW_PERMISSION` removed from it | _opens the panel for an administrator whose ONLY section is Customers_                    | KILLED |
| T-02 | the detail path catches "no such customer" and nothing else      | `isCustomerMiss` made unconditionally true  | _answers an administrator with no users permission with the refusal, never customer_gone_ | KILLED |
| T-03 | the `9:` code table maps `b` to the blocking intent              | `b` pointed at `ADMIN_CUSTOMER` instead     | _the block button asks first and writes nothing_         | KILLED |
| T-04 | the status button carries the TARGET status, not the current one | the two codes transposed                    | _blocks a customer through ask → reason → confirm, and the reply offers the unblock_         | KILLED |
| T-05 | the status button is drawn only with `users.block`               | the permission test replaced with `true`    | _draws no status button for an administrator who may view and not block_                  | KILLED |
| T-06 | the next-page button is appended when the cursor encodes         | the append deleted                          | _offers a further page only when the server says there is one, and that page works_       | KILLED |
| T-07 | the lookup refuses an argument that is not a Telegram id         | the shape guard made unreachable            | _answers the lookup with the syntax for anything that is not a Telegram id_               | KILLED |
| T-08 | the lookup filters on the EXACT `telegramUserId`                 | the search narrowed to `{}`                 | _never finds another tenant’s customer by their Telegram id_                              | KILLED |

T-01 and T-02 are the two rows this file exists for, because each names a defect
that was already in `main` rather than one this work introduced.

T-01: `isAdmin` and `adminTurn` gated the management panel on two hand-kept
copies of the same permission list, and they had diverged. The reminders section
was added with `settings.view` and only `adminTurn` learned about it, so an
administrator whose only section was the reminders received no panel row on their
keyboard — invisible until somebody holding exactly that role typed `/start`.
`isAdmin`'s own comment named the failure, "a missing arm here", while being the
arm that was missing. There is now one `PANEL_SECTION_PERMISSIONS` and both read
it, which is why reverting one entry kills a test about a different section
entirely.

T-02: the detail path's first version caught everything and answered
`bot.admin.customer_gone`, so an administrator who merely lacks `users.view` was
told the person does not exist. An operator acts on that by telling the customer
there is no account, and the fact they were really told is about themselves
rather than anybody's data — so there is nothing protected by blurring it. The
catch is now narrow and a denial falls through to the panel's single refusal.

## Rules held by a mechanism rather than by a mutation

| Rule                                                                     | What holds it                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| no subscription URL, client id or provider secret reaches either surface | `serviceSummarySchema` does not carry them, so there is no field to render and no edit to this code could start rendering one           |
| no wallet balance, order or service on the Telegram detail               | the template's placeholder set is frozen in `packages/contracts/src/templates.ts`; `validateTemplateValues` refuses an undeclared token |
| `/customer` is never advertised to a customer                            | `tests/unit/telegram-command-menu.test.ts` asserts it is parsed AND absent from `BOT_COMMANDS`                                          |
| the eleven new template keys were each reviewed as customer-facing copy  | `tests/unit/bot-runtime.test.ts` pins the exact SET of `bot.admin.*` keys the runtime can send                                          |
| a callback uuid that is not a UUIDv7 never reaches a query               | `callbackCommand` validates at the boundary; a malformed id answers `bot.unknown_command` before an intent exists                       |
| every read and write is tenant-scoped                                    | `DrizzleCustomerRepository` puts `eq(customers.tenantId, …)` in every WHERE, including the primary-key lookup                           |

## Round 2 — the one authorized Codex review

One review round on PR #56, two findings, both validated against the code and
both real. Each fix carries a mutation; one of the two mutations is recorded as
SURVIVED because the rule it reverts is unreachable through the UI, which is a
fact about the rule rather than a gap in the suite.

| #     | Rule                                                                   | Mutation                                              | Named test                                                                  | Result   |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| R-01  | the lookup validates against `telegramUserIdSchema`, not a local regex | the schema check replaced with the old `/^\d{1,32}$/` | _answers the lookup with the syntax for anything that is not a Telegram id_ | KILLED   |
| R-02  | Previous returns to the page before, not to the first page             | `back` empties the trail instead of popping one       | _steps the orders pager back one page, not all the way to the first_        | KILLED   |
| R-02b | `forward` pushes nothing for a null cursor                             | a null cursor pushes an empty-string placeholder      | _labels the services pager for a descending traversal and sends its cursor_ | SURVIVED |

R-01 is the one worth reading. `/^\d{1,32}$/` accepted a leading zero and up to
thirty-two digits, neither of which any Telegram account has, and
`CustomerService.list` trusts its `CustomerSearch` and validates nothing — so
those reached the database, spent `users.search` on a value that cannot match,
and came back `bot.admin.customer_gone`. That sentence says the person does not
exist, for a string that is not an identifier at all, and an operator acts on it
by telling a customer there is no account. One schema means the Telegram lookup
and the HTTP one agree about what an id is.

R-02b SURVIVED and stays SURVIVED. `CursorPager` disables Next when the page
reports no next cursor, so a null can only reach `forward` from a caller this
file does not have; the guard is there for the one it might gain. Writing a test
that pressed a disabled button would be a test of `fireEvent`, not of the rule —
and recording the row as killed on that basis is the thing this record exists to
refuse.
