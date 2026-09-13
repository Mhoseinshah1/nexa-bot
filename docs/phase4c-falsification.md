# Phase 4C — falsification record

Every production rule this branch adds, reverted one at a time and the test that
dies named. A rule with no test is a rule that will be silently reverted; a claim
about testing that leaves no test behind is worse than no claim.

The harness is `scripts/falsify.sh` — label, file, the exact text replaced, the
replacement, the test file, the vitest project. It refuses a file with
uncommitted changes, restores by `git checkout --`, and fails the run if the tree
is not byte-identical afterwards.

This is a BOUNDED record of the rules this phase adds, not a mutation catalogue.

## What the wallet round found

**Two rules had no test, and both were found by mutation rather than by reading.**

- **W12** — `adjust` charging `users.wallet.credit` for a DEBIT left the suite
  green. The permission test used a `support` actor, which holds NEITHER wallet
  permission, so it was refused either way: the test proved that _some_
  permission is charged, never that the direction picks which one. `finance` is
  the actor that can tell them apart — it holds `users.wallet.credit` and not
  `users.wallet.debit` — and it now credits successfully and is refused the debit
  in the same case, with both audit rows pinned in order. This is the shape
  `CLAUDE.md` records from Phase 4B as "a test that asserted the wrong half",
  found here before it reached a review.
- **W15** — removing `assertScopeActive` from inside the committing transaction
  left the suite green, and that is a stated non-negotiable: every write path
  reads `ScopeActivityReader` INSIDE its transaction, because a surface checks
  activity when the request arrives and a stop can commit in between. Panels is
  the module that skipped it and gave a stopped tenant new panels and a
  background monitor. Here it would have been new money.

**One mutation was a bad aim rather than a missing test.** W06 replaced
`.onConflictDoNothing({ target: … })` with a bare `.onConflictDoNothing()`, which
is behaviourally identical while `wallet_entries_tenant_reference_key` is the
only unique index the insert can violate — so SURVIVED said nothing about
coverage. W06b removes the conflict handling outright, which is the rule, and
kills two cases. Recorded rather than quietly replaced, because a SURVIVED whose
cause is the harness's aim is as misleading as a real one.

## The wallet ledger

| #    | Rule                                                                       | Mutation                                                    | Test that dies                                                                                      | Result |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| W01  | A DEBIT subtracts. The sign lives in `direction` and is applied once       | `signedMinor`'s `DEBIT` → `return amountMinor`              | `wallet.test.ts` › agrees with the TypeScript sign rule over every direction                        | KILLED |
| W02  | The SQL sum applies the same sign rule as the TypeScript one               | the `ELSE -amount` → `ELSE amount`                          | `wallet.test.ts` › derives a balance from the entries, and reports how many produced it             | KILLED |
| W03  | A balance is exact past 2^53                                               | `BigInt(row.balance)` → `BigInt(Number(row.balance))`       | `wallet.test.ts` › keeps a balance EXACT past the precision of a JavaScript number                  | KILLED |
| W04  | A balance is per CURRENCY and never sums across them                       | the currency predicate removed from `balanceOf`             | `wallet.test.ts` › answers per CURRENCY, and never sums across them                                 | KILLED |
| W05  | A reference lookup carries the tenant                                      | `and(tenantId, reference)` → `reference` alone              | `wallet.test.ts` › cannot see, sum or address another tenant’s entries                              | KILLED |
| W06b | A movement is idempotent at the unique index, not in a process             | the whole `.onConflictDoNothing(…)` removed                 | `wallet.test.ts` › moves money ONCE for a repeated reference, and returns the first entry           | KILLED |
| W07  | The keyset cursor is PostgreSQL microsecond text, not a `Date`             | `last.createdAtText` → `last.createdAt.toISOString()`       | `wallet.test.ts` › pages over MICROSECONDS, so two entries inside one millisecond do not straddle   | KILLED |
| W08  | An amount is greater than zero and within the ceiling, at the SERVICE      | `this.assertLedgerAmount(input.amountMinor)` removed        | `wallet.test.ts` › refuses an amount of zero or past the ceiling, as a refusal and not a 500        | KILLED |
| W09  | A wallet does not go below zero                                            | `if (!canCover(…))` → `if (false)`                          | `wallet.test.ts` › refuses a debit the balance cannot cover, and names the SHORTFALL                | KILLED |
| W10  | An amount is denominated in `sales.currency`, and nothing converts         | `if (input.currency !== selling)` → `if (false)`            | `wallet.test.ts` › refuses a currency this installation does not sell in                            | KILLED |
| W11  | The ledger reason is derived from the direction, never named by the caller | `CREDIT: 'ADMIN_CREDIT'` → `CREDIT: 'PURCHASE'`             | `wallet.test.ts` › credits once for a repeated command, and commits the audit and the event with it | KILLED |
| W12  | CREDIT and DEBIT charge their OWN permissions                              | the direction ternary → `WALLET_CREDIT_PERMISSION`          | `wallet.test.ts` › charges the direction’s OWN permission, and audits the refusal                   | KILLED |
| W13  | A refusal before the replay still leaves an audit row                      | `recordMutationDenial(…)` removed from `authorize`          | `wallet.test.ts` › charges the direction’s OWN permission, and audits the refusal                   | KILLED |
| W14  | A movement's reference is DERIVED from the idempotency key, not generated  | `operationId(key)` → `ids.uuid()`                           | `wallet.test.ts` › derives the same reference from the same key, with no lookup                     | KILLED |
| W15  | Scope activity is read INSIDE the committing transaction                   | `await this.assertScopeActive(scope, tx)` removed           | `wallet.test.ts` › refuses an installation that has stopped accepting work                          | KILLED |
| W16  | The domain event commits with the entry                                    | `eventType: 'WalletEntryRecorded'` → `'CustomerRegistered'` | `wallet.test.ts` › credits once for a repeated command, and commits the audit and the event with it | KILLED |

Sixteen mutations run, fifteen rules covered. W06 is not a row here: a table of
citations is a table of rules with tests, and W06 names none — it is the bad aim
recorded above, and W06b is the mutation that states its rule.

Two rules in this module are NOT falsifiable through this harness because they
are not in TypeScript: `wallet_entries_no_update` and `wallet_entries_no_delete`
are database triggers, and the test that proves them issues a raw `UPDATE` and
`DELETE` through the pg client rather than through the repository — the
repository has no method that could be mutated, which is the point.

## What the payments round found

**Two repository rules were shadowed by a service-level early return.** P09 (the
confirmation's `WHERE state = 'PENDING'`) and P10 (`create`'s conflict handling)
both SURVIVED, because no service-level path reaches those statements twice: a
repeated confirmation hits the already-CONFIRMED branch and a repeated settlement
hits the replay lookup, so the command returns before the statement carrying the
guarantee ever runs. That is the Phase 4B _"the helper was tested and the call
site was not"_ shape inverted — here the call site was tested and the mechanism
underneath it was not. Three repository-level cases now reach them directly.

**A third rule had no test at all.** P17: dropping the tenant from
`findByReference` left the suite green. The wallet suite proves that rule and the
payment suite did not, which for money is not a leak but a way to confirm
somebody else's payment. The case added for it asserts the row IS visible from
its own tenant, because a scoping test that cannot tell "invisible" from "absent"
passes on a repository that returns nothing to anybody.

**The rollback case had to be rewritten before it proved anything.** Its first
version cancelled the order before calling the service, so the early read refused
and no debit was ever written — it asserted that nothing happens when nothing
happens. The interleaving is now PRODUCED: a transaction is held open having
already settled the order, the service reads `AWAITING_PAYMENT`, writes the
payment and the DEBIT, blocks on the row lock, and the holder commits. The
failure then arrives AFTER the money was written, which is the only version of
that test that says anything about rollback.

## Payments and settlement

| #   | Rule                                                                     | Mutation                                       | Test that dies                                                                                      | Result |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| P01 | A payment must EQUAL the order total, not merely cover it                | `!==` → `>`                                    | `payments.test.ts` › refuses to settle an order from a payment that does not cover it               | KILLED |
| P02 | A currency mismatch is REFUSED, never converted                          | the currency check → `if (false)`              | `payments.test.ts` › refuses to settle across currencies rather than converting                     | KILLED |
| P03 | The amount comes from the order's frozen snapshot, never from the caller | `order.totals.total` → `money(1n, …)`          | `payments.test.ts` › debits EXACTLY the order total and settles the order, in one transaction       | KILLED |
| P04 | A settlement that moves no row rolls the DEBIT back                      | the `!changed` refusal → return the payment    | `payments.test.ts` › rolls the DEBIT back when its own UPDATE settles nothing                       | KILLED |
| P05 | The guard's refusal rolls the confirmation back with it                  | `settlementRefusal(order, confirmed)` → `null` | `payments.test.ts` › refuses to settle an order from a payment that does not cover it               | KILLED |
| P06 | A wallet cannot overdraw to pay for an order                             | `if (!canCover(…))` → `if (false)`             | `payments.test.ts` › refuses when the balance cannot cover the order, and moves nothing             | KILLED |
| P07 | A customer may only pay their OWN order                                  | the ownership check dropped from the lookup    | `payments.test.ts` › cannot settle another customer’s order, and says UNKNOWN rather than FORBIDDEN | KILLED |
| P08 | Only an `AWAITING_PAYMENT` order may be settled                          | the state check → `if (false)`                 | `payments.test.ts` › refuses a second settlement of an order already PAID                           | KILLED |
| P09 | The confirmation is conditional on `PENDING`                             | `WHERE state = 'PENDING'` dropped              | `payments.test.ts` › confirms only from PENDING, and tells the loser it lost                        | KILLED |
| P10 | A retried command produces ONE payment                                   | `.onConflictDoNothing({ target })` dropped     | `payments.test.ts` › creates ONE payment for a repeated reference, and returns the first            | KILLED |
| P11 | A settled order emits `OrderSettled`                                     | `'OrderSettled'` → `'OrderConfirmed'`          | `payments.test.ts` › settles ONCE for a repeated command, and writes one OrderSettled               | KILLED |
| P12 | An operator confirmation records WHO approved it                         | `adminIdOf(actor)` → `null`                    | `payments.test.ts` › confirms a transfer under receipts.review and settles the order with it        | KILLED |
| P13 | `settled_at` is stamped by the same statement as the state               | `{ settledAt: now }` → `{}`                    | `payments.test.ts` › debits EXACTLY the order total and settles the order, in one transaction       | KILLED |
| P14 | Confirming an out-of-band transfer needs `receipts.review`               | the permission → `receipts.view`               | `payments.test.ts` › refuses a confirmation from an operator without receipts.review                | KILLED |
| P15 | Scope activity is read INSIDE the settling transaction                   | `assertScopeActive` removed                    | `payments.test.ts` › refuses an installation that has stopped accepting work                        | KILLED |
| P16 | A manual request is priced from the order, not by itself                 | `order.totals.total` → `money(1n, …)`          | `payments.test.ts` › creates a PENDING payment for the order total, with a generated reference      | KILLED |
| P17 | A reference lookup carries the tenant                                    | `and(tenantId, reference)` → `reference` alone | `payments.test.ts` › cannot see or address another tenant’s payment                                 | KILLED |
| P18 | An id lookup carries the tenant                                          | `and(tenantId, id)` → `id` alone               | `payments.test.ts` › cannot see or address another tenant’s payment                                 | KILLED |

Twenty mutations run over the payment rules, eighteen rules covered; P09, P10 and
P17 each SURVIVED first and are recorded as such above rather than quietly fixed.

Two rules here are again NOT falsifiable through this harness because they are
not in TypeScript: `payments_order_confirmed_key` (at most one CONFIRMED payment
per order) and `nexa_payments_confirmation_guard` (a CONFIRMED payment's money is
frozen). Both are proved through the raw client, because the repository
deliberately has no method that could attempt either.
