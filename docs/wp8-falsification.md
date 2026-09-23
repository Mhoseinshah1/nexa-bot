# WP8 — pricing, discounts and cashback falsification record

Each rule below was reverted alone, in a separate worktree against its own database. Only
the named test was run, and the file was restored before the next mutation.
`docs/wp8-pricing-audit.md` is the design these rows hold.

The driver counted a mutation only after the same test passed on the unmutated tree. It
rebuilt `@nexa/contracts` around a mutation in that package, because the tests read it
from its built output. The first pass did neither: every run executed no tests, and
every row read as killed. That pass was discarded and is not recorded here.

| #      | rule                                                                       | mutation                                                               | tests that die                                                                                                           | result |
| ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| WP8-01 | confirmation locks the applied rules `FOR UPDATE`                          | `.for('update')` removed from `lockForRedemption`                      | `pricing-discounts.test.ts` › serialises two confirmations on the rule’s row lock, so a limit of one sells once          | KILLED |
| WP8-02 | confirmation re-checks that the rule is still `ACTIVE`                     | the `INACTIVE` check removed from `redemptionRefusal`                  | `pricing-discounts.test.ts` › refuses a confirmation whose rule was withdrawn, and leaves the draft as it was            | KILLED |
| WP8-03 | confirmation re-checks the total limit                                     | the `TOTAL_LIMIT` check removed from `redemptionRefusal`               | `pricing-discounts.test.ts` › serialises two confirmations on the rule’s row lock, so a limit of one sells once          | KILLED |
| WP8-04 | a first-purchase confirmation takes the customer's advisory lock           | the `pg_advisory_xact_lock` call made unreachable                      | `pricing-discounts.test.ts` › serialises first purchases through DIFFERENT rules on the customer’s first-purchase lock   | KILLED |
| WP8-05 | a percentage discount rounds up, in the customer's favour                  | `discountAmountMinor` truncates                                        | `pricing-engine.test.ts` › never goes below zero, and rounds a percentage up for the customer                            | KILLED |
| WP8-06 | a priority tie goes to the older rule                                      | the id comparison in `byPrecedence` reversed                           | `pricing-engine.test.ts` › orders by priority descending, then by the older id                                           | KILLED |
| WP8-07 | a later rule stacks only if every applied rule is stackable                | `stackOpen` ignored                                                    | `pricing-engine.test.ts` › applies one rule when the first is not stackable                                              | KILLED |
| WP8-08 | an undecided code is given no stand-in reason                              | a `CUSTOMER_DEPENDENT` code answered `INACTIVE`                        | `pricing-engine.test.ts` › is undecided — refused with no reason — when its answer depends on an absent customer         | KILLED |
| WP8-09 | a discount's kind and code never change                                    | the kind and code comparison in `DiscountAdminService.update` disabled | `pricing-discounts.test.ts` › refuses to change a rule’s kind or code                                                    | KILLED |
| WP8-10 | a fixed amount must be in the currency the tenant sells in                 | the currency comparison in `assertReferences` disabled                 | `pricing-discounts.test.ts` › refuses a fixed amount in a currency the tenant does not sell in                           | KILLED |
| WP8-11 | delivery means the operation `SUCCEEDED`                                   | `PLANNED` and `IN_FLIGHT` counted as delivered                         | `cashback.test.ts` › earns nothing before delivery, then credits exactly once                                            | KILLED |
| WP8-12 | delivery means an operation of the order's `PURCHASED_AS` type             | the operation-type predicate removed                                   | `cashback.test.ts` › counts only an operation of the type the order BOUGHT as delivery                                   | KILLED |
| WP8-13 | an order that ends undelivered voids its promise                           | the `!answer.delivered` branch disabled                                | `cashback.test.ts` › voids the promise of a paid order refunded because it could not be delivered                        | KILLED |
| WP8-14 | a reversal subtracts what earlier reversals already took                   | prior dues ignored                                                     | `cashback.test.ts` › reverses exactly what one full refund would, across partial refunds that do not divide evenly       | KILLED |
| WP8-15 | a reversal takes no more than the balance holds                            | `recovered` set to the whole due                                       | `cashback.test.ts` › records what a spent balance cannot cover, and never takes the wallet below zero                    | KILLED |
| WP8-16 | the reversal judges the promise only under the customer's lock             | the unlocked `PENDING` early return restored                           | `cashback.test.ts` › never misses a reversal when a refund completes while the earner is mid-credit                      | KILLED |
| WP8-17 | the Telegram summary variant is chosen from the quote                      | the key fixed to `bot.order.summary`                                   | `telegram-order-flow.test.ts` › takes a typed discount code into the window it opened, prices it, and takes it off again | KILLED |
| WP8-18 | a plain message the username window declines is offered to the code window | the message answered with the fallback instead                         | `telegram-order-flow.test.ts` › takes a typed discount code into the window it opened, prices it, and takes it off again | KILLED |
| WP8-19 | a typed code whose draft has moved on closes its window, committed         | the not-`DRAFT` check in `submitTypedDiscountCode` removed             | `telegram-order-flow.test.ts` › closes a code window whose draft was confirmed from the summary still on screen          | KILLED |

**WP8-01 survived its first run, and that was a test defect.** Both contenders were on
one panel, so the panel's row lock queued them before either reached the rule. Taking
the rule lock away changed nothing the test could see. The case now puts them on two
panels. With nothing else in common, only the rule's row lock orders them, and the
mutation is killed. WP8-04's case was built on two panels for the same reason from the
start.

**WP8-16 is the race the reversal was changed for.** The earner is held at its ledger
insert by an outside transaction that inserted the same unique reference and has not
committed. A refund completes meanwhile. Under the old order the reversal read the
promise unlocked, saw `PENDING` and returned. The earner then credited the full amount,
and nothing took the refunded half back.

**WP8-19 came from the PR's Codex review.** A customer could open the code prompt and
then confirm from the summary still above it. Every plain message after that reached the
window, was refused because the order was no longer a draft, and rolled back the close
along with the refusal. So the window caught messages until its own ten-minute expiry.
The mutation was run by reverting the fix; the test then failed on the refusal text.

**What these rows do not cover:**

- **Earned exactly once.** This is not falsified by a single mutation, and is not
  claimed to be. Three independent guards each make a second credit impossible:
  - the conditional `PENDING -> EARNED` update;
  - the ledger's unique `${orderId}:cashback` reference;
  - the customer's wallet lock.

  Removing any one leaves the other two. `cashback.test.ts` › serialises two earners on
  the customer’s wallet lock, so one credit is written proves the combination holds
  under a real race.

- **The database guards** on redemptions, reversals and `order_cashback`. These are
  triggers in migration `0106`. The tests assert the database refuses each write
  directly; they are not mutated here.
- **Which figure a customer sees on a renewal or add-on quote** (`docs/wp8-pricing-audit.md`
  §7). It shows the discounted total without a breakdown, and no test claims otherwise.
