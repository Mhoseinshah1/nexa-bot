# WP10 and Payment File 02 — payments falsification record

Two passes over one package. The first is WP10 §10-A's; the rules it held that Payment
File 02 keeps (D8: P2, P3 and P4) are below as they were recorded. The second is Payment
File 02's own (`docs/payments-file02-design.md`), at the end.

## Withdrawn with the late-review lane

Payment File 02 §9 (D1) removed the §10-A late-review lane — a submitted receipt no longer
expires, so there is no expired transfer to decide late — and its rows went with it:
WP10-01 to WP10-12 and WP10-24 (`LateTransferService`, its decision table, its ledger key
and the expiry sentence), and WP10S-01 to WP10S-05 and WP10S-09 to WP10S-18 (its Web card
and its Telegram lane). The code and the tests they cited no longer exist. Their numbers
are not reused.

## §10-A — the rules that stand (P2, P3, P4)

Each rule below was reverted alone, in a separate worktree (`wp10/mut`, removed afterwards)
against its own database (`nexa_wp10_mut`). Only the named tests were run, with vitest's
`-t` anchored on each title, and the tree was restored before the next mutation.
`docs/wp10-payments-audit.md` P2–P4 is the design these rows hold.

The driver ran every named test on the unmutated tree first and counted a mutation only
after that run passed with every named test executed. It then ran the same tests against
the mutation and required vitest's JSON report to list at least one of them FAILED. A run
that executed no tests did not count. Every failure was read. Most died on an assertion;
the exceptions are explained below the table. No mutation in this record touched
`packages/contracts`.

| #       | rule                                                                 | mutation                                                                       | tests that die                                                                                                                                                                                                                    | result |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WP10-13 | a wallet payment is refused while a signalled transfer waits         | the `hasClaimedPendingForOrder` refusal in `settleFromWallet` made unreachable | `payments.test.ts` › refuses with ORDER_TRANSFER_UNDER_REVIEW while a signalled transfer waits, and debits nothing; `financial-concurrency.test.ts` › keeps a signal that took the transfer first, and refuses the wallet payment | KILLED |
| WP10-14 | a wallet payment withdraws the order's unsignalled transfers         | `cancelPendingForOrder` in `settleFromWallet` replaced by an empty list        | `payments.test.ts` › withdraws an unsignalled pending transfer and settles from the wallet                                                                                                                                        | KILLED |
| WP10-15 | no operator refund while the purchase operation is undecided         | the `purchaseInProgress` refusal in `refusalFor` made unreachable              | `refunds.test.ts` › refuses a refund while the purchase operation is planned or UNKNOWN, and allows it once delivered                                                                                                             | KILLED |
| WP10-16 | an UNKNOWN purchase operation is undecided                           | `hasUnresolvedForOrder` counts only PLANNED and IN_FLIGHT                      | `refunds.test.ts` › refuses a refund while the purchase operation is planned or UNKNOWN, and allows it once delivered                                                                                                             | KILLED |
| WP10-17 | the refund that completes the payment moves the order REFUNDED       | the full-amount comparison in `completed` made always to return                | `refunds.test.ts` › moves the order REFUNDED at once when a wallet refund returns the whole payment; › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                    | KILLED |
| WP10-18 | a partial refund leaves the order PAID                               | the full-amount comparison in `completed` made never to return                 | `refunds.test.ts` › keeps the order PAID after a partial refund and tells the customer REFUND_COMPLETED; › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                | KILLED |
| WP10-19 | every completed refund tells the customer REFUND_COMPLETED           | the `REFUND_COMPLETED` enqueue removed from `completed`                        | `refunds.test.ts` › keeps the order PAID after a partial refund and tells the customer REFUND_COMPLETED                                                                                                                           | KILLED |
| WP10-20 | a refund AWAITING_EXTERNAL tells nobody and moves nothing            | `completed` called for every requested refund, not only one born COMPLETED     | `refunds.test.ts` › moves the order REFUNDED with one OrderRefunded when the last external refund completes                                                                                                                       | KILLED |
| WP10-21 | the automatic refund does not run an operator refund's consequences  | `completed` called from `refundUndeliverable` after its credit                 | `automatic-refund.test.ts` › neither re-transitions nor re-announces: no REFUND_COMPLETED, one OrderRefunded, one ledger event                                                                                                    | KILLED |
| WP10-22 | a TOPUP_RECEIPT credit emits WalletEntryRecorded                     | the emission in `confirmAndCredit` made unreachable                            | `wallet-topup.test.ts` › announces the TOPUP_RECEIPT credit with one WalletEntryRecorded, and not again for a second operator                                                                                                     | KILLED |
| WP10-23 | a REFUND credit emits WalletEntryRecorded, on both refund lanes      | the emission in `creditWallet` made unreachable                                | `refunds.test.ts` › emits WalletEntryRecorded for a REFUND credit, once; `automatic-refund.test.ts` › neither re-transitions nor re-announces: no REFUND_COMPLETED, one OrderRefunded, one ledger event                           | KILLED |
| WP10-25 | a refund's payment lock does not wait on a foreign-key check         | `lockPayment` back to `FOR UPDATE` from `FOR NO KEY UPDATE`                    | `cashback.test.ts` › never misses a reversal when a refund completes while the earner is mid-credit; `referrals.test.ts` › never misses a reversal when a refund completes while the earner holds the referrer’s lock mid-credit  | KILLED |
| WP10-26 | a wallet payment takes the transfer's row before the customer's lock | `lockCustomer` taken again ahead of the P2 block                               | `financial-concurrency.test.ts` › keeps a signal that took the transfer first, and refuses the wallet payment                                                                                                                     | KILLED |

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
- **The Telegram mapping of `ORDER_TRANSFER_UNDER_REVIEW` on the wallet-pay path** to
  `bot.payment.transfer_under_review` is pinned by `bot-runtime.test.ts`'s sendable-key
  list, not by a mutation here.

## The §10-A surfaces that stand — the Web Admin's refund card

The same procedure, for the operator surface of P3: each rule reverted alone in a
separate worktree (removed afterwards), only the named tests run with vitest's `-t`
anchored on each title, the named tests first run green on the unmutated tree, a mutation
counted only when vitest's JSON report listed a named test FAILED, and the file restored
with `git checkout` before the next. The web rows need no database. Every failure was
read, and every one died on an assertion. No mutation touched `packages/contracts`. The
file they cite was `payments-late-review.test.tsx`, renamed when the lane's cases left it.

| #        | rule                                                   | mutation                                                         | tests that die                                                                                               | result |
| -------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| WP10S-06 | a refund refused for `DELIVERY_IN_PROGRESS` says so    | `refundMessageFor` on the request error replaced by `messageFor` | `payments-refund-consequences.test.tsx` › names DELIVERY_IN_PROGRESS when the server refuses a refund for it | KILLED |
| WP10S-07 | "the order is REFUNDED" is read from the order's state | `orderRefunded` made true for any order that loaded              | `payments-refund-consequences.test.tsx` › says nothing about the order while it is still PAID                | KILLED |
| WP10S-08 | the refund card reads no order without `orders.view`   | `mayViewOrders` dropped from the order query's `enabled`         | `payments-refund-consequences.test.tsx` › neither asks for nor describes the order without orders.view       | KILLED |

**What these rows do not cover:** the order page's rewritten REFUNDED banner is copy,
pinned by `products-and-orders.test.tsx`'s existing wording checks, not by a mutation here.

## Payment File 02

Each rule of `docs/payments-file02-design.md` below was reverted alone in a separate
worktree (`/home/user/nexa-wp10-mut`, detached at `f79fb59`, removed afterwards) against
its own database (`nexa_wp10_mut`, dropped afterwards). The driver ran the named tests on
the unmutated tree first and counted a mutation only after that run passed with every
named test executed; it then applied the mutation, ran the same tests with vitest's `-t`
anchored on each title, and required vitest's JSON report to list at least one of them
FAILED. A source mutation was restored with `git checkout`; a database mutation (a
dropped index, constraint or trigger, or a replaced function) was restored by re-creating
the object from its migration text, after a `TRUNCATE` of the tables the mutated schema
had let a test fill. PAY-30 is the one mutation in `packages/contracts`; the package was
rebuilt after it was applied and again after it was restored. Every failure was read.
Most died on an assertion; the exceptions are below the table. PAY-35's test was written after `f79fb59` and copied into the
worktree for its run.

| #       | rule                                                                        | mutation                                                                                  | tests that die                                                                                                                                                                                                                                                       | result                |
| ------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| PAY-01  | D1: the expiry sweep never expires a transfer with a receipt                | `noReceiptFiled()` made `TRUE OR NOT EXISTS …` in `expireDue`                             | `receipt-dispositions.test.ts` › keeps a receipted transfer and its order open through the sweep                                                                                                                                                                     | KILLED                |
| PAY-01u | D1: the sweep's UPDATE restates the no-receipt predicate                    | the UPDATE's own `noReceiptFiled()` removed, the candidate SELECT's kept                  | `receipt-dispositions.test.ts` › keeps a receipted transfer and its order open through the sweep                                                                                                                                                                     | SURVIVED (equivalent) |
| PAY-02  | D1: the username sweep keeps the hold of an order awaiting payment          | the sweep's `NOT EXISTS (… o.state = 'AWAITING_PAYMENT')` made `TRUE OR NOT EXISTS`       | `receipt-dispositions.test.ts` › keeps the username hold, and a late approval provisions under that very name                                                                                                                                                        | KILLED                |
| PAY-03  | D1: a customer cannot withdraw a transfer they sent a receipt for           | `withdrawPending`'s receipt-count threshold raised from `> 0` to `> 99`                   | `receipt-dispositions.test.ts` › refuses the customer’s withdrawal of a transfer they sent a receipt for                                                                                                                                                             | KILLED                |
| PAY-04  | D1: an order's stale transfer is reissued only if it has no receipt         | the receipt count dropped from `requestManualTransfer`'s stale test                       | `receipt-dispositions.test.ts` › hands the receipted transfer back to a customer who asks to pay by transfer again                                                                                                                                                   | KILLED                |
| PAY-05  | D1: a top-up's stale transfer is reissued only if it has no receipt         | the receipt count dropped from `requestWalletTopup`'s stale test                          | `wallet-topup.test.ts` › takes a receipt against a top-up, through the flow an order uses                                                                                                                                                                            | KILLED                |
| PAY-06  | D2: credit-to-wallet takes the payment's row lock                           | `findByIdForUpdate` replaced by `findById` in `creditToWallet`                            | `receipt-dispositions.test.ts` › races approve against credit: the approval wins, nothing is credited; › races reject against credit: the rejection wins, nothing is credited; › races credit against credit: one credit, the second is told it was already credited | KILLED                |
| PAY-07  | D2: only a transfer with a receipt can be credited                          | the no-receipt refusal made unreachable (`=== 0` to `< 0`)                                | `receipt-dispositions.test.ts` › refuses a transfer with no receipt, a wallet payment, and an amount out of bounds                                                                                                                                                   | KILLED                |
| PAY-08  | D2: credit-to-wallet also needs `users.wallet.credit`                       | the wallet permission replaced by `receipts.review`                                       | `receipt-dispositions.test.ts` › refuses a reviewer without users.wallet.credit, who can still approve                                                                                                                                                               | KILLED                |
| PAY-09  | D2: credit-to-wallet needs `receipts.review`                                | the review permission replaced by `users.wallet.credit`                                   | `receipt-dispositions.test.ts` › refuses an operator who may credit wallets but not review receipts                                                                                                                                                                  | KILLED                |
| PAY-10  | D2: the amount is part of the idempotency hash                              | `amountMinor` removed from the hashed request                                             | `receipt-dispositions.test.ts` › answers a replay with the first result, and refuses a different amount under the key                                                                                                                                                | KILLED                |
| PAY-11  | D2: the wallet is credited the amount the reviewer entered                  | the credited amount replaced by `payment.amount`                                          | `receipt-dispositions.test.ts` › credits exactly the entered amount, fails the payment, and leaves the order open                                                                                                                                                    | KILLED                |
| PAY-12  | D2: the customer is told `RECEIPT_CREDITED_TO_WALLET`                       | the enqueued kind replaced by `PAYMENT_REJECTED`                                          | `receipt-dispositions.test.ts` › credits exactly the entered amount, fails the payment, and leaves the order open                                                                                                                                                    | KILLED                |
| PAY-13  | D2: a stopped scope decides nothing, checked inside the transaction         | `assertScopeActive` removed from `creditToWallet`                                         | `receipt-dispositions.test.ts` › cannot reach another tenant’s payment, and decides nothing for a stopped tenant                                                                                                                                                     | KILLED                |
| PAY-14  | D2: a credited payment cannot then be rejected                              | the `receiptCredits.findByPayment` refusal in `rejectManualTransfer` made unreachable     | `receipt-dispositions.test.ts` › refuses a rejection and an approval after a credit, as already resolved                                                                                                                                                             | KILLED                |
| PAY-15  | D2: only a PENDING transfer can be credited                                 | `payment.state !== 'PENDING'` removed from the credit's state test                        | `receipt-dispositions.test.ts` › refuses a credit after an approval and after a rejection                                                                                                                                                                            | KILLED                |
| PAY-16  | D2 (database): one `RECEIPT_CREDIT` entry per payment                       | `wallet_entries_receipt_credit_payment_key` dropped                                       | `receipt-dispositions.test.ts` › refuses a second RECEIPT_CREDIT ledger entry for one payment, under any reference                                                                                                                                                   | KILLED                |
| PAY-17  | D2 (database): a `RECEIPT_CREDIT` entry names its payment                   | `wallet_entries_receipt_credit_payment_check` dropped                                     | `receipt-dispositions.test.ts` › refuses a RECEIPT_CREDIT that names no payment                                                                                                                                                                                      | KILLED                |
| PAY-18  | D2 (database): a disposition is append-only                                 | `receipt_credits_no_update` and `receipt_credits_no_delete` dropped                       | `receipt-dispositions.test.ts` › refuses UPDATE and DELETE on a disposition, and a second one for the payment                                                                                                                                                        | KILLED                |
| PAY-19  | D2 (database): at most one disposition per payment                          | `receipt_credits_pkey` dropped                                                            | `receipt-dispositions.test.ts` › refuses UPDATE and DELETE on a disposition, and a second one for the payment                                                                                                                                                        | KILLED                |
| PAY-20  | D2 (database): a disposition matches a FAILED transfer and its ledger entry | `receipt_credits_guard` dropped                                                           | `receipt-dispositions.test.ts` › refuses a disposition on a payment that is not a FAILED transfer, or of another amount                                                                                                                                              | KILLED                |
| PAY-21  | D2 (database): a payment is never deleted                                   | `payments_no_delete` dropped                                                              | `receipt-dispositions.test.ts` › refuses to delete a payment                                                                                                                                                                                                         | KILLED                |
| PAY-22  | D5 (database): the route snapshot is fixed when the payment is created      | `nexa_payments_confirmation_guard` replaced by its 0058 body, without the snapshot clause | `wallet-topup.test.ts` › refuses to rewrite a payment’s route snapshot, in the database, in any state                                                                                                                                                                | KILLED                |
| PAY-23  | D5: a confirmed top-up writes a separate gift entry                         | the gift block made unreachable                                                           | `wallet-topup.test.ts` › credits the principal and a SEPARATE 10% gift, and tells the customer each once                                                                                                                                                             | KILLED                |
| PAY-24  | D5: the gift percent is the gateway's at creation                           | the snapshot written at creation forced to `0`                                            | `wallet-topup.test.ts` › credits the principal and a SEPARATE 10% gift, and tells the customer each once                                                                                                                                                             | KILLED                |
| PAY-25  | D5: only the confirmation that inserted the principal computes a gift       | the `inserted` gate on `giftMinor` replaced by `true`                                     | `wallet-topup.test.ts` › writes one gift for a replayed and a second operator’s confirmation; › writes one gift when two confirmations race, the loser held on the payment row                                                                                       | SURVIVED (defence)    |
| PAY-26  | D5: the customer is told of the gift                                        | the `WALLET_TOPUP_GIFT_CREDITED` enqueue made unreachable                                 | `wallet-topup.test.ts` › credits the principal and a SEPARATE 10% gift, and tells the customer each once                                                                                                                                                             | KILLED                |
| PAY-27  | D5: a gift that rounds to nothing is not written                            | `giftMinor > 0n` made `>= 0n`                                                             | `wallet-topup.test.ts` › gives nothing, and says nothing, at 0%; › rounds the gift DOWN, and writes none when it rounds to nothing                                                                                                                                   | KILLED                |
| PAY-28  | D5 (database): one gift per payment                                         | `wallet_entries_topup_cashback_payment_key` dropped                                       | `wallet-topup.test.ts` › refuses a second gift for one payment, and a gift that names no payment, in the database                                                                                                                                                    | KILLED                |
| PAY-29  | D5 (database): a gift names its payment                                     | `wallet_entries_topup_cashback_payment_check` dropped                                     | `wallet-topup.test.ts` › refuses a second gift for one payment, and a gift that names no payment, in the database                                                                                                                                                    | KILLED                |
| PAY-30  | D4: a commercial total never falls below one minor unit                     | `clampDiscount`'s ceiling put back to the subtotal (`packages/contracts`, rebuilt)        | `pricing-discounts.test.ts` › keeps a 100% automatic discount payable: one unit, confirmed AND settled (D4); `resellers.test.ts` › keeps a 99% reseller price under a 50% promotion payable: confirmed AND settled (D4)                                              | KILLED                |
| PAY-31  | D7: the compensation list is the automatic refunds of undeliverable orders  | the `AUTOMATIC_REFUND_REASON` filter removed from `listCompensations`                     | `wallet-payments-http.test.ts` › lists the compensations: automatic wallet refunds of undeliverable orders, paged                                                                                                                                                    | KILLED                |
| PAY-32  | D7: the compensation list is read under `payments.view`                     | `COMPENSATION_VIEW_PERMISSION` replaced by `refunds.view`                                 | `wallet-payments-http.test.ts` › lists the compensations: automatic wallet refunds of undeliverable orders, paged                                                                                                                                                    | KILLED                |
| PAY-33  | D7: the diagnostics show the customer's Telegram id                         | `customerTelegramUserId` forced to `null` in the controller's summary                     | `wallet-payments-http.test.ts` › shows the payment id, Telegram id and username, gateway, external reference and times                                                                                                                                               | KILLED                |
| PAY-34  | D3: no HTTP route confirms or rejects a card-to-card payment                | a `POST payments/:id/confirm` handler added back to the payments controller               | `route-registration.test.ts` › registers no card-to-card mutation, and routes every payment read; `wallet-payments-http.test.ts` › offers no way to confirm or reject a card-to-card payment over HTTP, even to the owner                                            | KILLED                |
| PAY-35  | D3 (database): a stored caption is 1 to 1024 characters                     | `payment_receipts_caption_check` dropped                                                  | `payment-receipts.test.ts` › keeps the customer’s caption with the receipt, and the database bounds it (D3)                                                                                                                                                          | KILLED                |

**The two survivors, and why each is recorded rather than fixed:**

- **PAY-01u is an equivalent mutant today.** The sweep's candidate SELECT already applies
  `noReceiptFiled()` and takes each candidate `FOR UPDATE SKIP LOCKED`, and a receipt is
  filed under the payment's row lock, so no receipt can land between the SELECT and the
  UPDATE. The UPDATE's copy is kept for the day the candidate query stops taking the lock;
  the comment beside it says so. No test can tell the two apart while that holds.
- **PAY-25 survives because two other mechanisms hold the same rule.** A confirmation
  that did not insert the principal would compute a gift, but the gift's reference is
  derived from the payment (`topupCashbackReference`) and
  `wallet_entries_topup_cashback_payment_key` allows one per payment, so the append
  returns the existing entry, `inserted` is false, and neither the outbox event nor the
  notification is repeated. Both named tests stayed green: one gift, one notification.
  The `inserted` gate is defence in depth; PAY-28 is what fails when the index goes.

**Failures that were not an assertion:** PAY-27 died when the ledger's
`wallet_entries_amount_check` (`amount > 0`) refused the zero gift the mutation tried to
write, which aborted the confirmation the test awaited. PAY-32 died parsing the 403 body
through the compensation list's response schema. In both the named test failed because the
mutated rule no longer held.

**What these rows do not cover:**

- `withdrawPending`'s `findByIdForUpdate` has no produced race; PAY-03 pins the refusal,
  not the lock.
- D6, cashback earned on renewal, is an existing WP8 rule. Its three new tests in
  `service-management.test.ts` were added as regressions and were not mutated here.
- The receipt caption's normaliser (`normalizeReceiptCaption`: trim, empty to null, 1024
  code points) is pinned by the unit tests in `bot-runtime.test.ts`, not by a mutation;
  PAY-35 covers the column's bound.
