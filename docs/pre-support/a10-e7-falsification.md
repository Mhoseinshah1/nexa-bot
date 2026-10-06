# A10 + E7 — receipt flow: falsification record

Branch `presupport/a10-e7-receipt-flow`. Driver: `scripts/mutate-a10-e7.py` (reverts one rule,
runs the named test with `-t`, restores the file byte-for-byte; i18n mutants rebuild
`@nexa/i18n` before and after). Integration mutants ran against a private database
(`TEST_DATABASE_URL=…/nexa_test_w1c`).

## What changed

- On the FIRST receipt filed for a payment the invoice is edited into its final, button-less
  state (`bot.payment.received_for_review`) and ONE new message is sent
  (`bot.payment.receipt_received`, the brief's exact copy with a blank line between the two
  sentences). Supersedes owner spec §2.4 "state 3" (an edit only), per the pre-support brief §10.
- Exactly once is keyed on durable state: `ReceiptService.submit` returns `first: true` only for
  the call whose transaction inserted the payment's first `payment_receipts` row (under the
  capture lock) and `first: false` on an idempotent replay.
- The invoice finalisation is best effort: a throw after the receipt committed is logged
  through the process logger and the one new message still goes (review round, PR #208).
- E7: `bot.payment.receipt_prompt` and the invoice's `bot.payment.transfer_instructions` ask
  for an image only (brief §10: "Receipt instruction can say image only"). Document receipts stay accepted
  (`PAYMENT_RECEIPT_KINDS` is a contract; refusing them would be a contract change).

## Results — 17 of 17 killed

| Id     | Rule reverted                                             | Killing test                                                                            |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A10-01 | `first` ignores the count (`filed !== null`)              | sends NO further message for a second receipt, or the same file sent again              |
| A10-02 | a replay answers `first` from the stored answer           | sends NO second message when Telegram redelivers the receipt update                     |
| A10-03 | the surface no longer keys the message on `first`         | sends NO further message for a second receipt, or the same file sent again              |
| A10-04 | the invoice is not finalised                              | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-05 | the invoice's final text is the new message's text        | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-06 | the new message carries the invoice's text                | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-07 | the released prompt ends in the old final text            | never leaves the receipt prompt on the invoice when the receipt beat the tap            |
| A10-08 | the window's expiry is not checked                        | answers a receipt after the window closed with receipt_expired, and files nothing       |
| E7-01  | prompt says «تصویر یا فایل رسید» again (unit)             | asks for an image of the receipt, and no longer advertises a file                       |
| E7-02  | same, through the bot (integration)                       | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-09 | single newline between the two sentences (unit)           | answers the first receipt with the brief’s two sentences, a blank line between them     |
| A10-10 | same, through the bot (integration)                       | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-11 | the invoice's final text is the receipt prompt            | edits the invoice up to the receipt, then ends it button-less and sends ONE new message |
| A10-12 | a throw while finalising the invoice fails the turn       | still sends the one new message when finalising the invoice throws                      |
| A10-13 | `first` for the first TWO rows (`already <= 1`)           | answers first: true to exactly one of two concurrent first receipts                     |
| A10-14 | a replay answers `first` from the stored answer (service) | answers a redelivered update without writing a second row                               |
| E7-03  | the invoice instructions say «تصویر یا فایل رسید» again   | tells the invoice to send an image of the receipt, not a file                           |

Integration tests live in `tests/integration/telegram-payment-flow.test.ts` and (A10-13, A10-14)
`tests/integration/payment-receipts.test.ts`; unit tests in
`tests/unit/telegram-customer-ux.test.ts`. The driver counts a mutant KILLED only when a named
test failed (a `×` line), never on a bare non-zero exit.

## Known limit

`sendMessage` has no idempotency key, so "exactly once" is at most once by design: a crash
after the receipt commits and before the message is sent leaves the customer with the edited
invoice and no new message, and a redelivery will not send it (the PO's instruction is that a
replay sends nothing new).

## A refused final edit: the cancel button it leaves is accepted

When Telegram refuses, rate-limits or loses the final edit, the invoice keeps the receipt
prompt and its cancel button. That button is not dead: `x:`/`z:` are not wizard-gated, and the
withdrawal itself refuses a payment whose receipt is under review, answering
`bot.payment.withdraw_under_review` — pinned by _answers the cancel button left by a refused
final edit with withdraw_under_review_. A later receipt re-asserts the final state (the anchor
includes `RECEIPT_REVIEW`), so `finaliseReview`'s move-back is not needed here. The refused
edit is never re-sent as a second new message.
