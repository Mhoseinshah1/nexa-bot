# Phase 5R falsification record

Each rule mutated in the working tree, with the committed test that died. Every mutation
was reverted and the suite re-run green.

| #      | Rule                                                        | Mutation                                                    | Named test                                                                                               | Result |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| F5R-01 | The invoice renders the owner's row order                   | Restore the bank-first destination line order               | `payment-invoice.test.ts` › renders the owner layout in order: heading, invoice id, amount, card, holder | dies   |
| F5R-02 | The invoice body puts the id above the amount               | Swap شناسه فاکتور with مبلغ قابل پرداخت in the body         | `payment-invoice.test.ts` › renders the owner layout in order: heading, invoice id, amount, card, holder | dies   |
| F5R-03 | The receipt card is gated on `receipts.view`                | Delete the `mayViewReceipts` gate                           | `payments.test.tsx` › draws nothing at all without receipts.view                                         | dies   |
| F5R-04 | A DOCUMENT is never rendered inline                         | Derive renderable from the mime type alone, ignoring `kind` | `payments.test.tsx` › never renders a DOCUMENT inline, whatever mime type it claims                      | dies   |
| F5R-05 | The window closes at the CAP, not on the first file         | Close at `held >= 1`                                        | `payment-receipts.test.ts` › keeps the window open while the payment can still hold more                 | dies   |
| F5R-06 | The payment's state is re-read inside the write             | Delete the `state !== 'PENDING'` refusal                    | `payment-receipts.test.ts` › refuses a receipt for a payment an operator already confirmed               | dies   |
| F5R-07 | The window deadline is compared to the clock                | Delete the `expiresAt <= now` refusal                       | `payment-receipts.test.ts` › refuses a file sent after the window closed                                 | dies   |
| F5R-08 | A block committed after the tap is re-checked               | Drop `status === 'BLOCKED'` from the guard                  | `payment-receipts.test.ts` › refuses a receipt from a customer blocked after the tap                     | dies   |
| F5R-09 | The bytes are served opaque, never as the declared type     | Echo `receipt.mimeType` as the content type                 | `wallet-payments-http.test.ts` › serves the bytes as an opaque attachment, never as the declared type    | dies   |
| F5R-10 | A receipt must belong to the payment in the path            | Delete the `receipt.paymentId !== paymentId` refusal        | `wallet-payments-http.test.ts` › refuses a receipt paired with a payment it does not belong to           | dies   |
| F5R-11 | A photo renders inline from `kind` alone, with no mime type | Require `mimeType.startsWith('image/')` again               | `payments.test.tsx` › fetches a photo through the API and renders it as an image                         | dies   |
| F5R-12 | `minutes` reaches the resolver as a NUMBER                  | Pass `String(receiptWindow.minutes)`                        | `telegram-payment-flow.test.ts` › never queues a fallback for a customer whose reply went out            | dies   |

Two notes, because a reader should not have to re-derive them:

- F5R-01 and F5R-02 kill the same test. It asserts a RELATIVE order over five markers,
  so either end of the layout breaks it; there is no single-line mutation that separates
  the two.
- F5R-05 also kills two neighbouring cases, because a window closed on the first file
  answers every later file with `RECEIPT_NOT_EXPECTED`.
- F5R-12 is the worst defect on this branch, and only the integration suite caught it.
  `minutes` is declared `type: 'NUMBER'` and the resolver VALIDATES values against the
  declaration, so a string refused the entire render; the webhook swallows a reply
  failure by design (a non-200 makes Telegram redeliver for ever), so the claim
  committed and the customer was told NOTHING after tapping the button. The unit suite
  passed throughout: it asserts which key the handler returns, not that the key can be
  rendered with the values it returns.
- F5R-11 is a defect this branch introduced and the self-review caught. A photo carries
  NO mime type — Telegram re-encodes it and declares none — so requiring `image/` made
  every real photo a download. The web fixture claiming `image/jpeg` was the only thing
  saying otherwise, which is `docs/real-panel-acceptance.md`'s rule in the small: a
  fixture this repository wrote and code this repository wrote can only prove they agree
  with each other. The fixture now carries null, as production does.

F5R-03 needed its test strengthened before it bit: the case waited on the page heading,
which renders before the query settles, so it passed with the gate deleted. It now waits
on the confirm form, which exists only once the detail has arrived.
