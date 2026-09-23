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
the service goes on to record the decision with the payment's amount, and 0114's insert
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

## The §10-A surfaces — the Web Admin and the Telegram panel

The same procedure, for the operator surfaces of P1 and P3: each rule reverted alone in a
separate worktree (detached at the telegram commit, removed afterwards) against its own
database (`nexa_wp10s_mut`), only the named tests run with vitest's `-t` anchored on each
title, the named tests first run green on the unmutated tree, a mutation counted only when
vitest's JSON report listed a named test FAILED, and the file restored with
`git checkout` before the next. The web rows need no database; the Telegram rows run
against it through the real runtime. Every failure was read, and every one died on an
assertion. No mutation touched `packages/contracts`.

| #        | rule                                                              | mutation                                                                   | tests that die                                                                                                                                                            | result |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WP10S-01 | the Web draws the two late decisions only for `receipts.review`   | `!mayReview` in `LateReviewCard` replaced by `false`                       | `payments-late-review.test.tsx` › names receipts.review instead of drawing either decision without it; › draws the decisions from receipts.review, not from payments.view | KILLED |
| WP10S-02 | the Web cannot send a dismissal without a reason                  | `reason === ''` dropped from the dismiss button's `disabled`               | `payments-late-review.test.tsx` › cannot dismiss without a reason                                                                                                         | KILLED |
| WP10S-03 | the Web credit asks first, naming the exact amount                | the credit button's `setAsking(true)` replaced by `credit.mutate()`        | `payments-late-review.test.tsx` › asks before crediting, naming the exact amount and that payment and order stay expired                                                  | KILLED |
| WP10S-04 | the Web lane is the server's `lateReview` filter                  | `lateReview: true` no longer sent in the lane                              | `payments-late-review.test.tsx` › asks the server for the lane, and nothing that would contradict it                                                                      | KILLED |
| WP10S-05 | the Web lane sends no state that would empty it                   | the state filter sent in the lane as well                                  | `payments-late-review.test.tsx` › asks the server for the lane, and nothing that would contradict it                                                                      | KILLED |
| WP10S-06 | a refund refused for `DELIVERY_IN_PROGRESS` says so               | `refundMessageFor` on the request error replaced by `messageFor`           | `payments-late-review.test.tsx` › names DELIVERY_IN_PROGRESS when the server refuses a refund for it                                                                      | KILLED |
| WP10S-07 | "the order is REFUNDED" is read from the order's state            | `orderRefunded` made true for any order that loaded                        | `payments-late-review.test.tsx` › says nothing about the order while it is still PAID                                                                                     | KILLED |
| WP10S-08 | the refund card reads no order without `orders.view`              | `mayViewOrders` dropped from the order query's `enabled`                   | `payments-late-review.test.tsx` › neither asks for nor describes the order without orders.view                                                                            | KILLED |
| WP10S-09 | the Web late card is drawn from the server's `lateReviewEligible` | the card's gate recomputed as `state !== 'EXPIRED'`                        | `payments-late-review.test.tsx` › draws nothing for an expired transfer the server says is not in the lane                                                                | KILLED |
| WP10S-10 | Telegram draws the late decisions only for `receipts.review`      | `mayDecide` in `adminLateItem`'s buttons replaced by `true`                | `telegram-admin-late-review.test.ts` › draws no decision for a reader without receipts.review, and refuses one sent anyway                                                | KILLED |
| WP10S-11 | Telegram draws the lane's door only for `payments.view`           | `permissions.has(PAYMENTS_VIEW_PERMISSION)` dropped from `adminReceipts`   | `telegram-admin-late-review.test.ts` › draws no door for a receipts reader without payments.view, and the lane refuses them                                               | KILLED |
| WP10S-12 | a Telegram dismissal cannot be OTHER                              | `x: 'OTHER'` added to `ADMIN_LATE_REASON_CODES`                            | `bot-runtime.test.ts` › refuses a dismissal as OTHER, the reason whose note this surface cannot take                                                                      | KILLED |
| WP10S-13 | a second Telegram decision is told it was already decided         | the `LATE_TRANSFER_ALREADY_DECIDED` row removed from `ADMIN_LATE_REFUSALS` | `telegram-admin-late-review.test.ts` › answers a second tap with already-decided and credits nothing more                                                                 | KILLED |
| WP10S-14 | a Telegram dismissal carries the reason that was tapped           | the reason looked up from the code replaced by `'NOT_RECEIVED'`            | `telegram-admin-late-review.test.ts` › dismisses with the tapped reason and no note, and moves nothing                                                                    | KILLED |
| WP10S-15 | Telegram's reasons screen is refused without `receipts.review`    | the `!mayDecide` refusal removed from `adminLateDismissAsk`                | `telegram-admin-late-review.test.ts` › draws no decision for a reader without receipts.review, and refuses one sent anyway                                                | KILLED |
| WP10S-16 | a Telegram item outside the lane offers no decision               | `!view.eligible` dropped from `lateLaneMember`                             | `telegram-admin-late-review.test.ts` › answers an item that is not in the lane, and one another tenant owns, as gone                                                      | KILLED |
| WP10S-17 | the Telegram lane is the server's `lateReview` filter             | `lateReview: true` removed from `adminLateReview`'s search                 | `telegram-admin-late-review.test.ts` › lists the vouched-for expired transfers and nothing else                                                                           | KILLED |
| WP10S-18 | a Telegram decision outside the lane is told it is not eligible   | the `LATE_TRANSFER_NOT_ELIGIBLE` row removed from `ADMIN_LATE_REFUSALS`    | `telegram-admin-late-review.test.ts` › answers a decision on a payment nobody vouched for as not eligible                                                                 | KILLED |

**WP10S-10 and WP10S-15 cite one test.** It asserts the item draws neither button for a
reader and that the reasons screen, the credit and the dismissal sent anyway are each
refused; each mutation fails a different one of those assertions (the drawn `lb:c:`, then
the reasons screen answered instead of refused).

**What these rows do not cover:**

- **The authorization itself.** Every refusal a crafted Telegram callback or a Web request
  meets is `LateTransferService`'s guard, falsified as WP10-10 above; these rows are the
  surfaces not PROMISING what the guard refuses.
- **The Web's ALREADY_DECIDED re-read, the in-flight disabling of both decisions and the
  exact request bodies** are asserted in `payments-late-review.test.tsx` but no mutation
  here targets them alone.
- **The order page's rewritten REFUNDED banner** is copy, pinned by
  `products-and-orders.test.tsx`'s existing wording checks, not by a mutation here.
