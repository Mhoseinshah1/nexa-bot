# Pre-support copy fixes A11, A3 and E4: falsification

Copy-only change to the Persian defaults in `packages/i18n/src/catalogue.fa.ts`
(pre-support remaining-fixes audit §2, items "A11", "A3", "E3 and E4"). No contract,
placeholder, payment logic or inquiry backoff changed. Tenant overrides are not rewritten.

| Item | Key(s)                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A11  | `bot.payment.gateway_invoice`, `_order_fee`, `_topup_fee` | The closing instruction «پس از پرداخت، دکمهٔ «بررسی وضعیت پرداخت» را بزنید» is replaced: the payment is checked automatically, the result is announced in this chat, and the button is only for when no result has arrived a few minutes after paying. The brief gives no exact wording for A11, so this text is ours. It promises no speed, because detection can lag up to the 300 s inquiry backoff cap. The required sentence "a payment counts only once the gateway confirms it" is kept. |
| A3   | `bot.wallet.summary`                                      | «آی دی عددی» becomes «شناسه کاربری» (the brief's wording). The service-transfer confirmation (`bot.service.transfer_confirm`) still reads «آی دی عددی کاربر مقصد» (PO default: wallet screen only).                                                                                                                                                                                                                                                                                             |
| E4   | `bot.discount.ask`                                        | «کد تخفیف خود را ارسال کنید», exactly as the brief has it (no trailing period). No sticker; that needs a PO-supplied sticker and a send path. E3 (a separate «روش‌های پرداخت دیگر» key) is a contracts change and is not part of this PR.                                                                                                                                                                                                                                                       |

Tests: `tests/unit/presupport-copy.test.ts` pins each body and checks that the placeholders
it uses are exactly the ones the contract declares. `tests/unit/customer-screens.test.ts` and
`tests/integration/customer-ux-payments.test.ts` now expect «شناسه کاربری».

## Mutations

`python3 scripts/mutate-presupport-copy.py` reverts each change inside its own catalogue entry,
rebuilds `@nexa/i18n`, runs the named test, then restores the file.

| Id      | Reverts                                      | Result |
| ------- | -------------------------------------------- | ------ |
| COPY-01 | A11, `bot.payment.gateway_invoice`           | KILLED |
| COPY-02 | A11, `bot.payment.gateway_invoice_order_fee` | KILLED |
| COPY-03 | A11, `bot.payment.gateway_invoice_topup_fee` | KILLED |
| COPY-04 | A3, `bot.wallet.summary`                     | KILLED |
| COPY-05 | E4, `bot.discount.ask`                       | KILLED |

5 of 5 killed.
