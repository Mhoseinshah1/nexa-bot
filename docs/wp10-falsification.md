# WP10 §10-A — payments falsification record

Each rule below was reverted alone, in a separate worktree (`wp10/mut`, removed afterwards)
against its own database (`nexa_wp10_mut`). Only the named tests were run, with vitest's
`-t` anchored on each title, and the tree — or, for a database rule, the schema — was
restored before the next mutation. `docs/wp10-payments-audit.md` P1–P4 is the design these
rows hold.

The driver ran every named test on the unmutated tree first and counted a mutation only
after that run passed with every named test executed. It then ran the same tests against
the mutation and required vitest's JSON report to list at least one of them FAILED. A run
that executed no tests did not count. Every failure was read. Most died on an assertion;
the exceptions are explained below the table. WP10-03 to WP10-06 mutate the DATABASE, not
the source: the constraint or trigger was dropped on `nexa_wp10_mut`, the test run, and the
object re-created from the migration's own text. No mutation in this record touched
`packages/contracts`.

| #       | rule                                                                          | mutation                                                                       | tests that die                                                                                                                                                                                                                    | result |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WP10-01 | only a transfer the customer vouched for is in the late-review lane           | the `NOT_VOUCHED_FOR` refusal removed from `lateReviewRefusal`                 | `late-transfers.test.ts` › refuses an expired transfer nobody vouched for                                                                                                                                                         | KILLED |
| WP10-02 | a receipt alone is vouching, in the lane and in the expiry sentence           | `customerVouchedFor` reduced to the signal                                     | `late-transfers.test.ts` › admits an expired transfer that carries only a receipt; › tells a customer who only sent a receipt PAYMENT_EXPIRED_UNDER_REVIEW                                                                        | KILLED |
| WP10-03 | one decision per payment, at the database                                     | `late_transfer_decisions_pkey` dropped                                         | `late-transfers.test.ts` › refuses a second decision row for one payment                                                                                                                                                          | KILLED |
| WP10-04 | one LATE_TRANSFER credit per payment, at the database, under any reference    | `wallet_entries_late_transfer_payment_key` dropped                             | `late-transfers.test.ts` › refuses a second LATE_TRANSFER ledger entry for one payment, under any reference                                                                                                                       | KILLED |
| WP10-05 | a decision is never edited or deleted                                         | `late_transfer_decisions_no_update` and `_no_delete` dropped                   | `late-transfers.test.ts` › refuses UPDATE and DELETE on a decision                                                                                                                                                                | KILLED |
| WP10-06 | a decision is about an expired transfer, and a credit is the payment's amount | `late_transfer_decisions_guard` dropped                                        | `late-transfers.test.ts` › refuses a decision about a payment that is not an expired transfer; › refuses a credit decision whose amount is not the payment’s                                                                      | KILLED |
| WP10-07 | a late credit is the payment's exact amount                                   | the ledger entry's amount made one minor unit less than the payment's          | `late-transfers.test.ts` › credits exactly the payment’s amount once and leaves the payment EXPIRED and the order closed                                                                                                          | KILLED |
| WP10-08 | a decision is taken under the payment's row lock                              | `findByIdForUpdate` in `lockEligible` replaced by an unlocked `findById`       | `late-transfers.test.ts` › serialises two concurrent credits on the payment lock: one credit, one refusal; › lets a credit racing a dismissal produce one decision                                                                | KILLED |
| WP10-09 | a decided payment is refused as ALREADY_DECIDED                               | the standing-decision refusal in `lockEligible` made unreachable               | `late-transfers.test.ts` › refuses a dismissal after a credit, and a credit after a dismissal                                                                                                                                     | KILLED |
| WP10-10 | the lane is decided under `receipts.review`                                   | `LATE_TRANSFER_PERMISSION` set to `receipts.view`                              | `late-transfers.test.ts` › refuses an actor without receipts.review, writes nothing, and records the denial                                                                                                                       | KILLED |
| WP10-11 | `lateReview` lists only UNDECIDED payments                                    | the `NOT EXISTS` over `late_transfer_decisions` removed from `lateReviewLane`  | `late-transfers.test.ts` › lists the lane and nothing else under lateReview, and drops a row once decided                                                                                                                         | KILLED |
| WP10-12 | a vouched transfer is told PAYMENT_EXPIRED_UNDER_REVIEW at expiry             | the sweep always sends `PAYMENT_EXPIRED`                                       | `late-transfers.test.ts` › tells a customer who signalled PAYMENT_EXPIRED_UNDER_REVIEW instead of PAYMENT_EXPIRED                                                                                                                 | KILLED |
| WP10-13 | a wallet payment is refused while a signalled transfer waits                  | the `hasClaimedPendingForOrder` refusal in `settleFromWallet` made unreachable | `payments.test.ts` › refuses with ORDER_TRANSFER_UNDER_REVIEW while a signalled transfer waits, and debits nothing; `financial-concurrency.test.ts` › keeps a signal that took the transfer first, and refuses the wallet payment | KILLED |
| WP10-14 | a wallet payment withdraws the order's unsignalled transfers                  | `cancelPendingForOrder` in `settleFromWallet` replaced by an empty list        | `payments.test.ts` › withdraws an unsignalled pending transfer and settles from the wallet                                                                                                                                        | KILLED |
| WP10-15 | no operator refund while the purchase operation is undecided                  | the `purchaseInProgress` refusal in `refusalFor` made unreachable              | `refunds.test.ts` › refuses a refund while the purchase operation is planned or UNKNOWN, and allows it once delivered                                                                                                             | KILLED |
| WP10-16 | an UNKNOWN purchase operation is undecided                                    | `hasUnresolvedForOrder` counts only PLANNED and IN_FLIGHT                      | `refunds.test.ts` › refuses a refund while the purchase operation is planned or UNKNOWN, and allows it once delivered                                                                                                             | KILLED |
| WP10-17 | the refund that completes the payment moves the order REFUNDED                | the full-amount comparison in `completed` made always to return                | `refunds.test.ts` › moves the order REFUNDED at once when a wallet refund returns the whole payment; › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                    | KILLED |
| WP10-18 | a partial refund leaves the order PAID                                        | the full-amount comparison in `completed` made never to return                 | `refunds.test.ts` › keeps the order PAID after a partial refund and tells the customer REFUND_COMPLETED; › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                | KILLED |
| WP10-19 | every completed refund tells the customer REFUND_COMPLETED                    | the `REFUND_COMPLETED` enqueue removed from `completed`                        | `refunds.test.ts` › keeps the order PAID after a partial refund and tells the customer REFUND_COMPLETED                                                                                                                           | KILLED |
| WP10-20 | a refund AWAITING_EXTERNAL tells nobody and moves nothing                     | `completed` called for every requested refund, not only one born COMPLETED     | `refunds.test.ts` › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                                                                                                       | KILLED |
| WP10-21 | the automatic refund does not run an operator refund's consequences           | `completed` called from `refundUndeliverable` after its credit                 | `automatic-refund.test.ts` › neither re-transitions nor re-announces: no REFUND_COMPLETED, one OrderRefunded, one ledger event                                                                                                    | KILLED |
| WP10-22 | a TOPUP_RECEIPT credit emits WalletEntryRecorded                              | the emission in `confirmAndCredit` made unreachable                            | `wallet-topup.test.ts` › announces the TOPUP_RECEIPT credit with one WalletEntryRecorded, and not again for a second operator                                                                                                     | KILLED |
| WP10-23 | a REFUND credit emits WalletEntryRecorded, on both refund lanes               | the emission in `creditWallet` made unreachable                                | `refunds.test.ts` › emits WalletEntryRecorded for a REFUND credit, once; `automatic-refund.test.ts` › neither re-transitions nor re-announces: no REFUND_COMPLETED, one OrderRefunded, one ledger event                           | KILLED |
| WP10-24 | a stopped tenant decides no late transfer                                     | `assertScopeActive` removed from `lockEligible`                                | `late-transfers.test.ts` › decides nothing for a tenant that has stopped accepting work                                                                                                                                           | KILLED |
| WP10-25 | a refund's payment lock does not wait on a foreign-key check                  | `lockPayment` back to `FOR UPDATE` from `FOR NO KEY UPDATE`                    | `cashback.test.ts` › never misses a reversal when a refund completes while the earner is mid-credit; `referrals.test.ts` › never misses a reversal when a refund completes while the earner holds the referrer’s lock mid-credit  | KILLED |
| WP10-26 | a wallet payment takes the transfer's row before the customer's lock          | `lockCustomer` taken again ahead of the P2 block                               | `financial-concurrency.test.ts` › keeps a signal that took the transfer first, and refuses the wallet payment                                                                                                                     | KILLED |

**WP10-07 dies on the database, not on an assertion.** With the ledger entry one unit short,
the service goes on to record the decision with the payment's amount, and 0111's insert
guard refuses it because the decision no longer names a LATE_TRANSFER entry of that
amount. The credit rolls back and the test fails on that error. That is the guard doing
its job as the backstop; the service rule is still falsified, because with the guard also
gone (WP10-06) the customer would be credited one unit less than they sent.

**WP10-08 dies on the race's witness.** Without the payment's lock the second decision is
never seen waiting, and `pg_stat_activity` times out. What the witness guards is real: past
it, the loser of a credit-vs-dismissal race reaches the decision INSERT and dies on
`late_transfer_decisions_pkey` (WP10-03's constraint), so the money stays right but the
reviewer is answered with a raw error rather than `LATE_TRANSFER_ALREADY_DECIDED`.

**WP10-09 dies on a raw error, not on a wrong outcome.** A second decision reaches the
INSERT and the primary key refuses it; the test asserts the NAMED refusal, so it fails.
Nothing was credited twice: that is WP10-03 and WP10-04 holding underneath.

**WP10-25 and WP10-26 die on `40P01`.** Both are lock-order rules, and what each prevents
is a deadlock. WP10-25: a completion holding the payment `FOR UPDATE` and waiting for the
customer, beside an earner holding the customer and inserting a ledger entry whose FK check
waits for the payment. WP10-26: a wallet payment holding the customer and waiting for the
transfer's row, beside a signal holding that row and inserting a receipt window whose FK
check waits for the customer. The two race tests fail with `deadlock detected`.

**WP10-14 is cited against one test only.** Its race twin in `financial-concurrency.test.ts`
also fails under the mutation, but because the held method is never called and the
interleaving never forms — a harness failure, not a verdict — so it is not cited.

**What these rows do not cover:**

- **Two completions of the last two parts of one payment at once.** `complete` now takes
  the payment's lock before the refund row so that the second sees the first's COMPLETED
  row and moves the order. No produced race pins it yet; the sum itself is WP10-17/18.
- **The `lateReview=false` half of the list filter** is asserted in the lane listing
  case, but no mutation targets the negation alone.
- **The Telegram mapping of `ORDER_TRANSFER_UNDER_REVIEW` on the wallet-pay path** to
  `bot.payment.transfer_under_review` is pinned by `bot-runtime.test.ts`'s sendable-key
  list, not by a mutation here.
