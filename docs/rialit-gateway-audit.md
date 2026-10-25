# Rialit gateway — Round 9 item C4

Source of truth: the **owner-provided Rialit API doc, version 1** (an OpenAPI document given to
the round in session; it is deliberately NOT in the repository). Section names below are that
document's own: "Quick reference", "How a payment works", "Authentication", "The payment page",
"Payment statuses", "Webhooks", "Errors", "Rate limits", "Implementation guide for AI agents",
and the operations "Create a payment" (`POST /send`) and "Get a payment" (`GET /status/{token}`).

The route is built on the existing gateway lane (`GatewayPaymentService`, `ExternalGatewayAdapter`)
exactly as TetraPay and CentralPay are, and inherits its rules: only the provider's own
server-to-server answer approves, exactly once through the ledger key, under the payment's lock,
inside the attempt's deadline, with the late-credit decision for a payment that closed. **Built,
not accepted** against the real provider (`OQ-RL-01`). The route starts `DISABLED` and cannot be
enabled without its API key.

Code: `packages/contracts/src/rialit.ts` (constants), `PAY/domain/rialit.ts` (the rules, pure),
`PAY/infrastructure/rialit-adapter.ts` (the only code that speaks Rialit), migration `0277`
(the provider roster and `gateway_invoices_rialit_check`). `PAY` =
`apps/api/src/modules/commerce/payments`.

## 1. What the document says and what Nexa does with it

| Document                                                                                                   | Nexa                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quick reference: base `https://api.rialit.io/api/v1`, Bearer key, JSON, amounts in Toman                   | `RIALIT_BASE_URL`; the key in `Authorization` only, stored with `SecretCipher` (`payment_gateway.api_key`), the projection shows its set-at time only                                                             |
| Create a payment: `amount` (Toman, 50,000–10,000,000), `order_id` (≤ 64 bytes), `payer_id`                 | exactly those three fields, as JSON numbers; `payer_id` is the customer's Telegram user id (descriptor `requiresBuyerChatId`); no other field is ever sent (the schema refuses unknown fields)                    |
| Create: the same body again answers 200 with the first payment; different values are 409                   | read like a 201; Nexa never re-sends on its own (§3 D4); a 409 is AMBIGUOUS `rialit.ORDER_CONFLICT`, never re-keyed                                                                                               |
| Create: `payer_fee` and `payer_amount` from the merchant settings                                          | the one-fee rule (§3 D2)                                                                                                                                                                                          |
| The payment page `https://pay.rialit.io/v1/{token}`, open 30 minutes                                       | a URL button in the bot; the invoice shows the LINK's deadline (30 min), and the pay button is withdrawn when it passes; the attempt itself keeps Nexa's 70 minutes                                               |
| Payment statuses: `pending`, `paid` (final), `expired`, `cancelled` — the last two can still become `paid` | `paid` (with the checks in §2) approves; `pending`, `expired`, `cancelled` and anything unnamed are OPEN — Nexa's own deadline expires the payment (§3 D3)                                                        |
| Webhooks: unsigned; `event_id` = `X-Rialit-Delivery`; answer 2xx in 10 s; `webhook.test`                   | an unauthenticated hint deduplicated on `last_webhook_delivery_id`; it only brings `GET /status` forward; `webhook.test` is answered 2xx and nothing else happens (`isWebhookProbe`)                              |
| Webhooks: "process only the requests from the dashboard's IPs"                                             | not enforced (§3 D6)                                                                                                                                                                                              |
| Errors: one English `error` string, no code                                                                | classified by HTTP status and, where the document gives it, the exact text; Nexa stores its own `rialit.*` code; the English is never stored, logged or shown; Persian in `web.provcode_rialit_*` and the ops log |
| Rate limits: 10/s create, 5/s status per merchant; 429 has no `Retry-After`                                | budgets 60/min per tenant (40 for inquiries); a 429 waits the documented second (`RIALIT_RATE_LIMIT_WAIT_MS`)                                                                                                     |
| Implementation guide: timeout ~30 s                                                                        | 15 s, like TetraPay: the lane's row bound is built on one provider timeout, and a slower call is a lost answer, never a resend                                                                                    |

## 2. What approves a payment

`rialitJudgement` (pure, `PAY/domain/rialit.ts`): `GET /status/{token}` answering `paid`, for
THIS attempt's `order_id`, with `amount` exactly the Toman Nexa sent and `payer_amount` exactly
`amount + payer_fee`. A `paid` answer that fails any of these is a MISMATCH: held UNKNOWN for an
operator (`bot.payment.rialit_review_unresolved`), never settled, never failed. What is credited
is always the payment's own principal — never `amount`, never `payer_amount`.

Error mapping (create / status read):

| HTTP                                  | create                                                                     | status read                      |
| ------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| 201, 200                              | CREATED (after the fee rule)                                               | OBSERVED                         |
| 400 `amount…`                         | REFUSED `rialit.AMOUNT_OUT_OF_RANGE:50000:10000000` (customer screen)      | —                                |
| 400 `order_id…` / `payer_id…` / other | REFUSED `rialit.INVALID_ORDER_ID` / `INVALID_PAYER_ID` / `BAD_REQUEST`     | —                                |
| 401                                   | REFUSED `rialit.UNAUTHORIZED`, configuration alert                         | CONFIGURATION, alert             |
| 403 `IP not allowed`                  | REFUSED `rialit.IP_NOT_ALLOWED`, configuration alert                       | CONFIGURATION, alert             |
| 403 `merchant is not active`          | REFUSED `rialit.MERCHANT_INACTIVE`, configuration alert                    | (the read keeps working)         |
| 404                                   | REFUSED `rialit.NOT_FOUND` (a changed API)                                 | NOT_FOUND (the deadline decides) |
| 409                                   | AMBIGUOUS `rialit.ORDER_CONFLICT`: CREATE_UNKNOWN, never re-keyed          | —                                |
| 429                                   | RATE_LIMITED, same order id after 1 s — the ONE code that clears the stamp | RATE_LIMITED, asked again later  |
| 5xx, timeout, unreadable              | UNKNOWN: CREATE_UNKNOWN, never re-sent                                     | FAILED, asked again later        |

## 3. Decisions taken

- **D1 — Toman and the range on the payable.** Rialit is Toman; IRR → Toman happens only in the
  domain/adapter (`rialitAmountOf` = TonPays' `tomanAmountOf`), and an IRR payable that is not a
  whole Toman is refused, never rounded. The 50,000–10,000,000 range applies to what Nexa SENDS —
  the payable, principal plus Nexa's customer fee — and is checked locally before any call; an
  amount outside it fails the attempt with `bot.payment.rialit_amount_out_of_range`, which shows
  the bounds.
- **D2 — only ONE side charges a fee, never both (owner decision, Round 9, replacing the lead's
  first rule "refuse any payer fee").** The owner keeps Rialit's payer fee (dashboard → merchant
  settings) at **zero when Nexa's gateway fee for Rialit is set, or Nexa's fee at zero when
  Rialit's payer fee is set — never both**. Nexa checks each create answer (`rialitPayerCheck`):
  - Nexa fee > 0 and `payer_fee` = 0 → normal;
  - Nexa fee = 0 and `payer_fee` = 0 → normal;
  - Nexa fee = 0 and `payer_fee` > 0 → allowed: the invoice shows Rialit's `payer_amount` (the
    amount sent, Rialit's fee, what the page asks for, in Toman) — display only; the payment
    settles and credits its principal, and Rialit's fee is never credited or refunded;
  - Nexa fee > 0 and `payer_fee` > 0 → **both would charge**: the link is NOT handed to the
    customer; the attempt fails as configuration (`rialit.DOUBLE_FEE`), the
    `payments.gateway_misconfigured` alert opens, the customer sees
    `bot.payment.rialit_misconfigured`, and the token Rialit created is kept on the audit row
    (`refusedProviderInvoiceId`) — nobody ever has its link, so it expires unpaid at Rialit;
  - always: `payer_amount` must equal `amount + payer_fee` and `amount` must be what Nexa sent,
    else the same refusal (`rialit.PAYER_AMOUNT_MISMATCH`; unreadable figures
    `rialit.PAYER_AMOUNT_UNREADABLE`).
    Whether Nexa charged comes from the payment's frozen fee snapshot, read before the send stamp;
    if it cannot be read, the adapter takes the refusing side.
- **D3 — `expired` and `cancelled` are not failures.** The document says either can still become
  `paid` and must then be accepted. Both are OPEN: the attempt stays `PENDING` until Nexa's own
  70-minute deadline expires it, and an EXPIRED payment is one the late-credit path can still
  credit (a FAILED one is closed for good). The cost, accepted: a payer who cancels on Rialit's
  page is not shown a failure until the deadline. A `paid` read after the deadline is
  `LATE_COMPLETION`, credited to the wallet once (`<paymentId>:late-credit`,
  `GATEWAY_LATE_CREDIT`) only with `payments.late_credit.rialit_enabled` ON — OFF by default. An
  OPERATOR reconciling an UNKNOWN payment may close it on `expired`/`cancelled` (the document's
  own words: they "end the payment"); that is an audited human decision that moves no money.
- **D4 — a lost create is never re-sent and never re-keyed.** The document says a repeat of
  `POST /send` with the same body is safe. Nexa's rule stands anyway: the send is stamped before
  the call; a timeout, 5xx or unreadable answer is CREATE_UNKNOWN (`payments.gateway_create_unknown`)
  and nothing re-sends it; only a 429 clears the stamp. The per-attempt `order_id` (payment code +
  40 random bits, `[A-Za-z0-9_.:-]`, ≤ 64 bytes, `gateway_invoices_rialit_check`) is the
  provider-side idempotency key. The vendor's idempotency is unproven against the real provider
  (`OQ-RL-03`); the customer never saw a link for an unknown create, so no money can be stranded.
- **D5 — `payer_id` is a JSON number.** The customer's Telegram user id, refused before any row is
  written when it is not a positive safe integer (descriptor `requiresBuyerChatId`), and refused
  again locally by the adapter.
- **D6 — no IP allow-list on the webhook.** The document asks the merchant to accept webhooks only
  from the addresses its dashboard shows. Nexa has no per-route client-address machinery, and those
  addresses are known only in Rialit's dashboard, so none is enforced. This is safe by
  construction: a webhook only locates the attempt and brings a rate-limited, budgeted
  `GET /status` forward; nothing in it can settle, fail or credit anything. Recorded as
  `OQ-RL-02`.
- **D7 — the pay button is a URL button.** The document recommends a Telegram Mini App
  (`web_app`) button. The bot's button machinery has no `web_app` kind (`CustomerButton` is
  callback / copy / URL), so v1 uses the URL button; a Mini App button is `OQ-RL-05`.
- **D8 — the link's 30 minutes vs the attempt's 70.** Kept at 70 (owner): the invoice shows the
  link's deadline honestly and withdraws the pay button once it passes; the check button stays,
  since Rialit can still report a payment made in time.
- **D9 — `reference`, `paid_at`, `payer_card`** are not read: diagnostics Nexa does not need,
  and a card fragment is a personal datum Nexa need not hold.

## 4. Registration points

`packages/contracts`: `PAYMENT_GATEWAY_PROVIDERS`, `PAYMENT_METHOD_SLUGS` (`rialit`),
`LATE_CREDIT_SETTING_KEYS.RIALIT` and its `settings.ts` entry, the descriptor, `rialit.ts`, four
template keys and their place in `payment-situations.ts`. Migration `0277` (six provider CHECKs +
`gateway_invoices_rialit_check`). `container.ts` (adapter + switch case),
`surfaces/gateway/webhook.controller.ts` (`X-Rialit-Delivery`), the lane's `isWebhookProbe`
answer and `customerFeeCharged` fact, `gateway-reconciliation.ts`, `financial-log.consumer.ts`,
`customer-screens.ts`, the bot's `payment-screens.ts` (refusal screens, payer-amount invoice,
link deadline), `scripts/check-boundaries.sh` (sink list). Web: `payment-gateways.tsx` (name, hint,
webhook URL to paste into Rialit), `gateway-health.tsx`, `payment-labels.ts`, `payments.tsx`,
`settings-presentation.ts`, `ops-code-labels.ts`, `web.fa.ts`; ops-log words in
`packages/i18n/src/ops-log.fa.ts`.

## 5. Tests

`tests/unit/rialit-rules.test.ts` (unit, the range, the four fee cases, the verdict, ids, the link
deadline), `tests/unit/rialit-adapter.test.ts` (fixtures from the document's examples: create
201/200, 400/401/403/409/429/502/503, status pending/paid/expired/cancelled, 404/401/403/429/5xx,
each webhook event and `webhook.test`), `tests/integration/rialit-gateway.test.ts` (real database:
disabled by default, key never leaks, create + paid, the range on the payable, 429, lost create
never re-sent, 409/401/403, the four fee cases, expired/cancelled stay open, late paid ON/OFF,
webhook hint, duplicate `event_id`, `webhook.test`, timeline), `tests/web/payment-gateways.test.tsx`.

## 6. Open questions

`docs/open-questions.md`, "Rialit": OQ-RL-01..06.
