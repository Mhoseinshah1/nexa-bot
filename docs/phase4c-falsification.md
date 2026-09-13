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

## What the Telegram round found

**One mutation is invisible because a SECOND mechanism holds.** T06 gives the
wallet settlement a random idempotency key, so a redelivered update is a new
command — and the suite stays green, because by the time the replay arrives the
order is `PAID` and `orderAwaitingPayment` refuses it. That is defence in depth
working, not a coverage gap: the derived key and the order state are two
independent reasons a replay moves no money. T06b states the same rule where only
one of them exists — the MANUAL_TRANSFER path settles nothing, so a new key really
would mint a second payment — and it kills. Recorded as a pair rather than as one
KILLED row, because "the rule is covered" and "this path has two backstops" are
different claims.

## The Telegram financial flow

| #    | Rule                                                           | Mutation                                                       | Test that dies                                                                                                | Result |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| T01  | Only rails this installation can perform are offered           | a gateway button added to `paymentButtons`                     | `telegram-payment-flow.test.ts` › never offers a gateway, and refuses one tapped from an older message        | KILLED |
| T02  | A gateway tap is NAMED, not answered as an unknown command     | `'bot.payment.unconfigured'` → `'bot.unknown_command'`         | `telegram-payment-flow.test.ts` › never offers a gateway, and refuses one tapped from an older message        | KILLED |
| T03  | The settled message claims no service                          | the shipped copy reverted to «سرویس شما در حال آماده‌سازی است» | `telegram-payment-flow.test.ts` › settles from the wallet, debits exactly the order total, and says only that | KILLED |
| T04  | An insufficiency names the SHORTFALL                           | the reply key → `'bot.order.unavailable'`                      | `telegram-payment-flow.test.ts` › refuses a settlement the balance cannot cover, and names the SHORTFALL      | KILLED |
| T05  | A callback id is validated as a UUID at the boundary           | the `uuidV7Schema` parse removed                               | `telegram-payment-flow.test.ts` › ignores an AMOUNT a tampered callback tries to carry                        | KILLED |
| T06b | A transfer key is derived from the update, not minted          | `:manual-pay` suffix → a random one                            | `telegram-payment-flow.test.ts` › treats a REDELIVERED transfer tap as a replay: one pending payment          | KILLED |
| T07  | A BLOCKED customer reaches no financial command                | the blocked gate removed from `handle`                         | `telegram-payment-flow.test.ts` › lets a BLOCKED customer move no money at all                                | KILLED |
| T08  | `/wallet` answers about the RESOLVED customer, from the ledger | the derived balance replaced with a constant zero              | `telegram-payment-flow.test.ts` › answers /wallet with the balance derived from the ledger                    | KILLED |

Nine mutations over the Telegram rules, eight rules covered. T06 is not a row in
the table, for the reason W06 is not: a citation table lists rules with tests, and
T06 names none — it is the second-backstop observation recorded above, and T06b
is the mutation that states its rule where only one backstop exists.

## What the concurrency round found — a real P0

**A wallet could go negative, and the test written to attack it proved it.**
`WALLET_ALLOWS_NEGATIVE_BALANCE` is `false`, and it was not enforced: the produced
interleaving drove a balance to **-250,000**.

The cause is worth recording because it is not obvious and the code's own comment
asserted the opposite. The ledger is APPEND-ONLY, so two debits contend on **no
shared row** — there is nothing for a second `INSERT` to block on. Under
PostgreSQL's default READ COMMITTED a `SELECT SUM(...)` does not wait for another
transaction's uncommitted insert, so each debit summed a balance that omitted the
other, each decided it could cover, and both committed. The comment claiming the
second "blocks, and then sees it" described a row lock nothing was taking.

`WalletRepository.lockCustomer` — `SELECT ... FOR UPDATE` on the customer row,
taken before every sufficiency read — is what makes the check a decision. C01 and
C02 are the mutations that state it, one per caller.

## Concurrency, HTTP and the Web Admin

| #    | Rule                                                             | Mutation                                           | Test that dies                                                                                                  | Result |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| C01  | A debit locks the customer row before reading the balance        | `lockCustomer` removed from `WalletService.adjust` | `financial-concurrency.test.ts` › will not let two debits spend the same money                                  | KILLED |
| C02  | A wallet settlement locks it too                                 | `lockCustomer` removed from `settleFromWallet`     | `financial-concurrency.test.ts` › will not let an admin debit and a purchase both take the last of the money    | KILLED |
| H02  | A malformed amount is a 400, not an exception out of `safeParse` | the `superRefine` early `return` removed           | `wallet-payments-http.test.ts` › refuses an amount of zero, a negative, one past the ceiling and a bad currency | KILLED |
| W01w | The wallet card draws no control that could set a balance        | a «صفر کردن موجودی» button added to the toolbar    | `users.test.tsx` › draws NO control that could set a balance or remove an entry                                 | KILLED |
| W02w | A confirmation sends a note and NOTHING else                     | an `amount` added to the request body              | `payments.test.tsx` › sends a NOTE and nothing else when confirming                                             | KILLED |
| W03w | `/payments` resolves to the real page, not the placeholder       | the `/payments` route removed from `resolve`       | `payments.test.tsx` › resolves to the real page, not the planned placeholder                                    | KILLED |
| W04w | The order page shows WHEN the money arrived                      | `order_settled_at` → `order_expires_at`            | `products-and-orders.test.tsx` › shows when the money arrived, and claims nothing beyond it                     | KILLED |

**H01 is bounded, not untested**, and the bound is checked rather than assumed:
`PAYMENT_AMOUNT_MAX_MINOR` is 1,000,000,000,000 and 2^53 is 9,007,199,254,740,992,
so every amount the schema ACCEPTS round-trips through `Number` exactly. The
precision rule that can actually be violated is on the SUM — a balance grown past
2^53 across many entries — and that lives in the repository, where
`wallet.test.ts` appends 9,007,199,254,740,993 and proves it. Recorded as a third
instance of the shape W06 and T06 named: a mutation that is unobservable because
another rule makes it so.

Two bad aims are recorded rather than dressed up as coverage: W01w was first run
as a `data-` attribute, which leaves every button label unchanged and so cannot be
seen by an enumeration of labels; W03w was first pointed at the maturity badge,
which is not what makes a page real. Both were re-run against the rule itself.

H01 is therefore not a row in the table — the same rule W06 and T06 follow: a
citation table lists rules with tests, and a mutation nothing can observe names
none.

Eight mutations over the concurrency, HTTP and Web rules; seven rules covered.

## The self-review pass

Three findings, recorded here because two of them changed a production rule and
the third changed only a document — and the difference is the point.

| #   | Rule                                                            | Mutation                                        | Test that dies                                                                            | Result |
| --- | --------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| S2  | A command's refusal and its success carry the SAME audit action | `action` hard-coded back to `'payment.confirm'` | `payments.test.ts` › audits a wallet settlement under ONE action, refused or not          | KILLED |
| S3  | `WalletEntryRecorded` follows the MOVEMENT, not the command     | `if (inserted)` → `if (true)`                   | `wallet.test.ts` › emits no second event when a replay re-reads an entry it did not write | KILLED |

**S1 has no row, and no mutation exists that would give it one.** It was a
sentence in `docs/phase4c-audit.md` §6 claiming 4C has "exactly one layer —
`wallet.topup.minimum`", written before standalone top-up was deferred and
contradicted by §8 two sections later. A prose contradiction is not a rule a test
can hold, so it is corrected and named here rather than given a citation it cannot
support. What CAN be checked was checked: `wallet.topup.minimum` has no consumer
anywhere in the source, which is what §8 says and what §6 now agrees with.

**S3's first mutation SURVIVED, and the survivor is the finding.** Aimed at
`settleFromWallet`, reverting the gate changed nothing observable: there the entry
and the order's settlement commit together, so an existing entry implies a PAID
order and `orderAwaitingPayment` refuses before the append is ever reached. The
gate is unreachable on that path and the comment there now says so. It is reachable
on `WalletService.adjust`, whose replay branch documents the case — an idempotency
row that outlived its entry, which a restore can produce — and the regression
PRODUCES that separation deliberately, because nothing in ordinary operation does.
Recorded as a fourth instance of the shape W06, T06 and H01 named, and the only one
of the four where chasing the survivor moved the test rather than explaining it
away.

Two mutations over the self-review fixes; two rules covered, one finding that is
not a rule.
