# WP9-B — reseller falsification record

Each rule below was reverted alone, in a separate worktree on its own branch, against its
own database (`nexa_wp9b_mut`). Only the named tests were run, and the file was restored
before the next mutation. `docs/wp9-reseller-audit.md` is the design these rows hold.
The tree was HEAD `dbddc89`.

The driver ran every named test on the unmutated tree first and counted a mutation only
after that run passed. It then ran the same tests against the mutation and required vitest
to report each cited test FAILED. A run that executed no tests did not count. The driver
checked `git diff --quiet` after every restore. Every failure was read. Most died on an
assertion. WP9B-04 and WP9B-10 died on the database's `order_reseller_terms_amounts_check`,
and WP9B-05 died on the test's lock witness rather than on money; all three are explained
below the table. WP9B-17 to WP9B-19 revert the three fixes that `dbddc89` made to defects
this suite found. WP9B-20 and WP9B-21 revert the reseller row's half of the first fix on
its own, against the two tests added to close the gap it left. WP9B-22 to WP9B-28 revert
the four fixes made for the PR #69 review, on HEAD `4c90aa7`. WP9B-25 and WP9B-26 are the
only rows that mutate `packages/contracts`. For those two, the worktree's workspace links
pointed at its own packages, and the contracts `dist` was rebuilt after each mutation and
again after each restore.

| #       | rule                                                                                     | mutation                                                                                                                       | tests that die                                                                                                                                                                                                                                                                                                        | result |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WP9B-01 | a request through no bot passes the BOT dimension only if the tier grants every bot      | `decideEntitlement`'s null-bot branch answers `true`                                                                           | `resellers.test.ts` › names each missing dimension in a fixed order: OPERATION, CATALOGUE, PANEL, BOT                                                                                                                                                                                                                 | KILLED |
| WP9B-02 | a credit limit in another currency grants nothing                                        | the currency comparison removed from `creditAllowance`                                                                         | `resellers.test.ts` › grants nothing for a purchase in a currency other than the limit’s                                                                                                                                                                                                                              | KILLED |
| WP9B-03 | the reseller's own limit overrides the tier's, zero included                             | `creditAllowance` reads the tier's limit only                                                                                  | `resellers.test.ts` › prefers the reseller’s own limit to the tier’s, in both directions                                                                                                                                                                                                                              | KILLED |
| WP9B-04 | a quote whose reseller layer no longer matches the live terms is refused, not re-priced  | the `termsChanged()` throw in `recordPurchase` removed                                                                         | `resellers.test.ts` › refuses to confirm a draft whose tier changed since the quote, and writes nothing                                                                                                                                                                                                               | KILLED |
| WP9B-05 | two purchases on credit serialise on the customer's wallet lock                          | `.for('update')` removed from `lockCustomer`                                                                                   | `resellers.test.ts` › serialises two concurrent 0.6·L purchases on the wallet lock: exactly one fits                                                                                                                                                                                                                  | KILLED |
| WP9B-06 | a SUSPENDED reseller is an ordinary customer                                             | the `status !== 'ACTIVE'` term removed from `standing`                                                                         | `resellers.test.ts` › lists at list price, is refused reseller-only products, has no credit and no grant constraints; › refuses to confirm a draft quoted while ACTIVE once the reseller is suspended                                                                                                                 | KILLED |
| WP9B-07 | a reseller override's step names the reseller row, not the tier                          | `applyResellerLayer`'s `ruleId` always the tier id                                                                             | `resellers.test.ts` › lets the reseller’s own percentage REPLACE the tier’s, as a USER_OVERRIDE step on the reseller row                                                                                                                                                                                              | KILLED |
| WP9B-08 | a grant names only a subject of the tier's own tenant                                    | the `assertSubjectsExist` call removed from `replaceGrants`                                                                    | `resellers.test.ts` › keeps a tier and a reseller of tenant A invisible and unusable from tenant B (R2, R11); › rejects grants naming a subject this tenant does not have, and changes nothing                                                                                                                        | KILLED |
| WP9B-09 | the reseller cost IS the order's subtotal; the margin is never kept inside it            | `applyResellerLayer` keeps the list subtotal and lowers only the total                                                         | `resellers.test.ts` › prices a TIER percentage off the list subtotal, rounding the reduction up, as a TIER_PRICE step; › applies a promotion to the reseller cost, and the order’s discount is only the promotion; › writes list, cost, promotion, sale and margin at confirmation, and the pricing read exposes them | KILLED |
| WP9B-10 | the snapshot's margin is list minus cost, and never includes the promotion               | `marginAmount` written as `list - cost + promotion`                                                                            | `resellers.test.ts` › writes list, cost, promotion, sale and margin at confirmation, and the pricing read exposes them                                                                                                                                                                                                | KILLED |
| WP9B-11 | the reseller catalogue shows nothing through a bot the tier does not grant               | `catalogueScope().shows` reduced to the operation alone                                                                        | `resellers.test.ts` › shows a reseller only what their tier grants, through the granted bot only                                                                                                                                                                                                                      | KILLED |
| WP9B-12 | an operator write reads scope activity inside its transaction                            | `assertScopeActive`'s refusal made unreachable                                                                                 | `resellers.test.ts` › refuses an operator write once the tenant has stopped accepting work                                                                                                                                                                                                                            | KILLED |
| WP9B-13 | every reseller write is audited under its own action                                     | the registration's audit action renamed `reseller.registered`                                                                  | `resellers.test.ts` › audits every write with its before and after                                                                                                                                                                                                                                                    | KILLED |
| WP9B-14 | a commercial action is refused before the order exists when the tier does not grant it   | the `assertEntitled` call in `CommercialActionService.draft` made unreachable                                                  | `resellers.test.ts` › refuses a renewal the tier does not grant, before an order exists                                                                                                                                                                                                                               | KILLED |
| WP9B-15 | the wallet settlement passes the credit allowance to `canCover`                          | `canCover` given `0n` instead of `allowance` in `settleFromWallet`                                                             | `resellers.test.ts` › lets the wallet reach exactly −L and not −L−1; › serialises two concurrent 0.6·L purchases on the wallet lock: exactly one fits                                                                                                                                                                 | KILLED |
| WP9B-16 | every reseller write needs `resellers.edit`, which finance and observer do not hold      | `RESELLERS_EDIT_PERMISSION` set to `resellers.view`                                                                            | `resellers-http.test.ts` › lets finance and observer read (resellers.view) and refuses them every write (resellers.edit)                                                                                                                                                                                              | KILLED |
| WP9B-17 | a confirmation reads the reseller and the tier FOR SHARE, so a grants write waits for it | `standing`'s `shareByCustomer` and `shareTier` reverted to `findByCustomer` and `findTier`                                     | `resellers.test.ts` › makes the withdrawal wait for a confirmation that decided on the old grants                                                                                                                                                                                                                     | KILLED |
| WP9B-18 | a tier's `resellerCount` counts its resellers                                            | the count's outer columns reverted to `${resellerTiers.tenantId}` / `${resellerTiers.id}`                                      | `resellers-http.test.ts` › counts the resellers on each tier                                                                                                                                                                                                                                                          | KILLED |
| WP9B-19 | the reseller list's cursor is one its own decoder accepts                                | `next.createdAt` reverted to `createdAt.toISOString()`                                                                         | `resellers-http.test.ts` › serves the second page with the cursor the first page returned                                                                                                                                                                                                                             | KILLED |
| WP9B-20 | a suspension waits for a confirmation that read the reseller as ACTIVE                   | `standing`'s `shareByCustomer` alone reverted to `findByCustomer`                                                              | `resellers.test.ts` › a suspension serialises with a confirmation that read the reseller as ACTIVE                                                                                                                                                                                                                    | KILLED |
| WP9B-21 | a suspension waits for a settlement that is spending the reseller's credit               | `standing`'s `shareByCustomer` alone reverted to `findByCustomer`                                                              | `resellers.test.ts` › a suspension waits for a wallet settlement that is spending credit                                                                                                                                                                                                                              | KILLED |
| WP9B-22 | a reseller refused an entitlement over Telegram is answered, never silent                | the `RESELLER_NOT_ENTITLED` entry removed from `REFUSAL_REPLIES`                                                               | `telegram-order-flow.test.ts` › answers a reseller following a product button their tier does not grant; `refusal-coverage.test.ts` › answers every code a customer-facing service can throw                                                                                                                          | KILLED |
| WP9B-23 | a reseller whose price changed is told to start again, never silence                     | the `RESELLER_TERMS_CHANGED` entry removed from `REFUSAL_REPLIES`                                                              | `telegram-order-flow.test.ts` › tells a reseller whose price changed between the summary and the tap to start again; `refusal-coverage.test.ts` › answers every code a customer-facing service can throw                                                                                                              | KILLED |
| WP9B-24 | an operator update reads its before-image under the row's `FOR UPDATE`                   | `update`'s `lockByCustomer` reverted to `findByCustomer`                                                                       | `resellers.test.ts` › makes the second update wait, and audits the first’s after-image as its before                                                                                                                                                                                                                  | KILLED |
| WP9B-25 | a reseller reduction leaves a positive subtotal at least one minor unit                  | the `subtotal − 1` cap removed from `resellerReductionMinor`                                                                   | `reseller-entitlement.test.ts` › never takes a positive subtotal below one minor unit; › keeps that unit through the pricing layer, as a step with a positive cost; `resellers.test.ts` › keeps a 99% reseller price payable: one minor unit, confirmed and settled from the wallet                                   | KILLED |
| WP9B-26 | a reseller rate is written as 1–99, never 100                                            | `percentSchema`'s maximum put back to 100                                                                                      | `reseller-entitlement.test.ts` › refuses a 100% rate in every reseller write schema, and accepts 99                                                                                                                                                                                                                   | KILLED |
| WP9B-27 | a list-priced standing change confirms; only a different layer refuses                   | the rule the old docs stated implemented: a customer with any reseller row but no standing is refused `RESELLER_TERMS_CHANGED` | `resellers.test.ts` › confirms a list-priced change under the standing in force at confirmation, audience and grants included                                                                                                                                                                                         | KILLED |
| WP9B-28 | a standing that changed since the quote is still held to its own grants at confirmation  | the `assertEntitled` call removed from `recordPurchase`                                                                        | `resellers.test.ts` › confirms a list-priced change under the standing in force at confirmation, audience and grants included                                                                                                                                                                                         | KILLED |

**The one mutation that survived, and why it is equivalent.** `applyResellerLayer`
returning `discount: money(reduction, currency)` instead of zero was run against the three
tests WP9B-09 cites, and all three stayed green. The mutation cannot change an outcome.
`applyResellerLayer`'s only caller is `PricingService.price`, which passes the result
straight to `applyAdjustments`. That function never reads `base.discount`. It takes the
subtotal and the running total from the base and derives the order's discount as
`subtotal − running`, which is the promotions alone. The layer's `discount` field is
overwritten before anything stores it, so no test can see it. WP9B-09 is the mutation that
does move the margin into the discount, and three tests kill it. The survivor is recorded
here, not as a row, and is not counted as KILLED.

**WP9B-04 and WP9B-10 die on the database, not on the service.** With the `termsChanged()`
throw removed, the confirmation goes on to write its terms. It writes the live cost (70 000
at the new 30%) beside the quote's sale amount (72 000 at the old 20%, less the promotion).
`order_reseller_terms_amounts_check` requires `sale_amount = cost_amount − promotion_amount`
and refuses the row with `23514`. The test asserts `RESELLER_TERMS_CHANGED`, so it fails
on that code. The service rule is still falsified, because the customer would get a raw
database error instead of the "start again" sentence. But the CHECK is a second guard for
any change of rate between quote and confirmation. WP9B-10 is refused by the same CHECK,
which also requires `margin_amount = list_amount − cost_amount`. For the margin arithmetic,
the CHECK is the primary guard and the test is the witness.

**WP9B-05 dies on the test's lock witness, not on money.** Without the row lock, the second
settlement never waits. The test's premise, a lock waiter visible in `pg_stat_activity`
within 5 s, fails first with "the second settlement never waited". A probe run with that
witness relaxed failed on the next premise instead: "the second has read nothing yet:
expected 2 to be 1". The second settlement had read the allowance while the first was still
held. That probe was a local edit in the mutation worktree and was thrown away. The rule is
a lock, so the witnesses that the lock exists are what die. The balance assertion is never
reached under this mutation.

**WP9B-20 and WP9B-21 were added to close a gap.** The first version of this record
showed that WP9B-17's test only covered the tier row, and both tests were written for
that. Under the shared mutation they fail the same way: `pg_stat_activity` shows no lock
waiter, and the suspension finishes first. What the missing lock costs is different in the
two cases.

- **The confirmation (WP9B-20)** is refused `RESELLER_TERMS_CHANGED`, because
  `recordPurchase` reads the reseller again and sees the suspension. Nothing is sold under
  the withdrawn status. But the operator's suspension and the customer's confirmation no
  longer have a defined order. The test also held only the first of the two reads, so a
  suspension that landed after the second read would not be caught this way.
- **The settlement (WP9B-21)** commits a credit debit AFTER the suspension that withdrew
  the credit line had committed and been reported done. That is the money-moving case.

**WP9B-22 to WP9B-28 cover the four PR #69 review fixes.** In both Telegram rows the
test fails on the reply count, not the text: the reseller's tap sends no message at all,
which is the silence the finding described. `refusal-coverage.test.ts` fails too, because
it now reads `reseller.service.ts` as a customer-facing source.

**WP9B-24 was first killed for the wrong reason.** The first version of the case held
update A inside `lockByCustomer` itself. With the fix reverted, `lockByCustomer` is never
called, so the hold was never reached and the case failed on a 60-second timeout rather
than on its assertions. Commit `4c90aa7` moved the hold to the next read in A's
transaction. The case now dies on its own assertion: "update B must wait on the reseller
row until update A has committed".

**WP9B-27 mutates in the old documentation's rule.** Before the F1 fix, the comment on
`recordPurchase`, R9 and `CLAUDE.md` all said that any change of standing refuses. The
code never did that, and the new case pins what the code does. WP9B-27 writes the
documented rule into the code: refuse whenever the customer has a reseller row but no
ACTIVE standing. The case then dies on the suspended list-priced reseller's confirmation.
So the test tells the true rule apart from the one the docs used to state.

**What these rows do not cover:**

- **A concurrent limit change, and a tier's.** An operator's change to a reseller's own
  credit limit is the same UPDATE of the reseller row that WP9B-21 holds for a suspension,
  so the lock covers it. A change to the tier's limit takes the tier's `FOR UPDATE`
  against `standing`'s `shareTier`. Neither is exercised concurrently by a test.
- **The database guards** on `order_reseller_terms`: the UPDATE and DELETE triggers from
  migration `0111` and the CHECKs from `0110`. `resellers.test.ts` › refuses UPDATE and
  DELETE on order_reseller_terms asserts the database refuses them directly; they are not
  mutated here.
- **The upward rounding.** WP9B-25 mutates only the one-unit floor in
  `resellerReductionMinor`. The rounding it inherits from `discountAmountMinor` is not
  mutated here. `resellers.test.ts` › prices a TIER percentage off the list subtotal,
  rounding the reduction up, as a TIER_PRICE step pins its output (99 999 at 15% costs
  84 999).
- **A zero total through a promotion.** The floor keeps the reseller COST at one unit.
  A percentage promotion on top of that cost rounds its own reduction up to that unit, so
  the order can still total zero and fail settlement on `payments_amount_check`. An
  ordinary customer reaches the same failure with a 100% discount, so this is the WP8
  zero-total path, not a reseller rule, and it is recorded for §10, not fixed here.
