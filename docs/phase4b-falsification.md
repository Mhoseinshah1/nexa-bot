# Phase 4B — falsification record

Every production rule this branch added, reverted one at a time against the
working tree, with the test that dies named. A rule with no test is a rule that
will be silently reverted; a claim about testing that leaves no test behind is
worse than no claim.

The harness is `scripts/falsify.sh`, and every row below was produced by running
it — label, file, the exact text replaced, the replacement, the test file, the
vitest project. It refuses a file with uncommitted changes, restores by
`git checkout --`, and fails the run if the tree is not byte-identical
afterwards.

## What this round found

**One test could not fail, and it was the concurrency one.** M05 removes
`WHERE state = from` from the order transition — the single mechanism that makes
a replay, a double-click and two replicas produce one transition — and
`two concurrent confirmations produce one transition and one event` stayed
GREEN. Two `Promise.allSettled` calls are not guaranteed to interleave:
whichever runs second usually reads the already-committed `AWAITING_PAYMENT`
and takes the early-return branch, so the case never reaches the code it is
named after.

Two deterministic cases replace the guarantee it was claiming, and both are in
the table below:

- `moves an order only from the state the caller NAMES` calls `transition`
  twice itself and asserts `true` then `false`. No timing in it at all.
- `writes NO event when its own UPDATE moved nothing` PRODUCES the interleaving
  instead of hoping for it: a transaction is held open having already moved the
  row, the service is called and reads DRAFT, its UPDATE blocks on the row lock,
  and the holder then commits.

The original race case stays, relabelled as the opportunistic smoke test it is.

**Two rows first reported SURVIVED against the wrong test.** M02 and M08 were
run with `-t <one test name>` in an ad-hoc harness before `scripts/falsify.sh`
was used, and both were aimed at a case that does not exercise the rule — M02 at
a path that returns before the gate, M08 at a refusal that another predicate
already produces. Recorded here because a SURVIVED that turns out to be the
harness's aim is exactly as misleading as one that is real, and the fix was to
use the repo's harness, which runs the whole FILE.

## The rules

| #   | Rule                                                                             | Mutation                                                | Test that dies                                                                                             | Result |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| M01 | A draft past its own deadline cannot be confirmed                                | the expiry comparison → `if (false)`                    | `orders.test.ts` › refuses a draft whose own deadline has passed                                           | KILLED |
| M02 | `OrderConfirmed` follows the ROW CHANGING, not the command succeeding            | `if (changed)` → `if (true)`                            | `orders.test.ts` › writes NO event when its own UPDATE moved nothing                                       | KILLED |
| M03 | Orderability asks `isPurchasable`, so a HIDDEN product is orderable and unlisted | `isPurchasable(status)` → `isListed(status, audience)`  | `catalog.test.ts` › keeps a HIDDEN product OUT of the catalogue while leaving it orderable                 | KILLED |
| M04 | Confirmation RE-CHECKS orderability                                              | `this.assertOrderable(product)` → `void product`        | `orders.test.ts` › re-checks ORDERABILITY at confirmation: a withdrawn product does not sell               | KILLED |
| M05 | The transition is a conditional UPDATE naming the state it expects               | drop `eq(orders.state, from)` from the WHERE clause     | `orders.test.ts` › moves an order only from the state the caller NAMES                                     | KILLED |
| M06 | A product is created INACTIVE, never publishable by one call                     | `status: 'INACTIVE'` → `'ACTIVE'` in the insert         | `products-http.test.ts` › creates every product INACTIVE, whatever the caller asks for                     | KILLED |
| M07 | The customer catalogue requires a bound panel                                    | drop `isNotNull(products.panelId)` from `listCatalog`   | `catalog.test.ts` › agrees with isCustomerVisible over every status, audience, price and panel             | KILLED |
| M08 | Every order lookup carries its tenant                                            | drop `eq(orders.tenantId, …)` from `findById`           | `orders-http.test.ts` › cannot reach another tenant’s order, and says only that it is unknown              | KILLED |
| M09 | `callback_data` is client text and its id is VALIDATED                           | drop the `uuidV7Schema` parse from `callbackCommand`    | `bot-runtime.test.ts` › reads a tapped button, and VALIDATES the id it carries                             | KILLED |
| M10 | The human who tapped is `callback_query.from`, not the bot beside it             | `telegramFromOf` reads `message.from` only              | `bot-runtime.test.ts` › takes the sender identity strictly, and refuses a bot as a customer                | KILLED |
| M11 | A tapped button's chat is the message it hangs off                               | `privateChatIdOf` ignores `callback_query.message.chat` | `telegram-order-flow.test.ts` › turns a tap into a DRAFT and answers with the order summary                | KILLED |
| M12 | An expired draft gets its OWN message, not "unavailable"                         | `ORDER_EXPIRED` → `'bot.order.unavailable'`             | `telegram-order-flow.test.ts` › tells the customer when the draft outlived its own hold                    | KILLED |
| M13 | The Web Admin's catalogue badge agrees with the server's two copies              | drop the `HIDDEN` branch from `catalogueGap`            | `products-and-orders.test.tsx` › agrees with the server for every combination of the four predicates       | KILLED |
| M14 | A quote carries exactly the steps that fired — one                               | `trace: [step]` → `trace: [step, step]`                 | `orders.test.ts` › creates a DRAFT carrying the whole snapshot and a priced, traced total                  | KILLED |
| M15 | A blocked customer is refused at CONFIRMATION, not only at creation              | drop `assertCustomerMayOrder` from `confirm`            | `orders.test.ts` › refuses a blocked customer at confirmation too, not only at creation                    | KILLED |
| M16 | A catalogue button carries its price, through the shared money renderer          | drop the `formatMoney` half of the label                | `telegram-order-flow.test.ts` › lists every sellable product as a button carrying its id, and nothing else | KILLED |
| M17 | A reply with buttons sends `reply_markup`                                        | the `buttons.length > 0` guard → `if (false)`           | `telegram-order-flow.test.ts` › lists every sellable product as a button carrying its id, and nothing else | KILLED |
| M18 | `/orders` renders the SNAPSHOT title, byte for byte                              | `record.line.title` → `` `${record.line.title} ` ``     | `orders-http.test.ts` › renders the SNAPSHOT, not the product as it reads now                              | KILLED |

18 mutations, 18 killed. Nothing on this branch is asserted only by a comment.

## What is deliberately NOT falsified

The boundary itself. There is no mutation that makes an order reach `PAID`,
because there is no code that could: `SETTLE` is guarded by `settlementIsFunded`
and this release has no payment and no wallet to satisfy it with. The way that
absence is asserted is by asking for it — `orders-http.test.ts` POSTs to
`/orders/:id/settle`, `/cancel`, `/refund` and `/mark-paid` and requires a 404
from each, and `products-and-orders.test.tsx` presses every button the orders
page draws and requires every request to be a GET. A comment saying "we did not
build these" cannot notice the commit that does.
