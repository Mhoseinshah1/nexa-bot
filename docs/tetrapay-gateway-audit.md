# TetraPay (Tetra98) gateway - Round 6 item 6

Source of truth: the TetraPay API documentation (`https://tetra98.com/docs`, v1). Section numbers
below are the section numbers of the copy supplied with the brief. The route is built on the
existing gateway lane (`GatewayPaymentService`, `ExternalGatewayAdapter`) exactly as TonPays
website is, and inherits its rules: only the provider's own server-to-server answer approves,
exactly once through the ledger key, under the payment's lock, with the late-credit decision for
a payment that closed.

## 1. What is documented and what Nexa does with it

| Documentation | Nexa |
| --- | --- |
| §1 base `https://api.tetra98.com/api/v1`, no sandbox | `TETRAPAY_BASE_URL`; nothing else is ever called |
| §2 `Authorization: Bearer <api_key>` | the key travels in that header only, stored with `SecretCipher` (`payment_gateway.api_key`), never shown again |
| §3.1 `POST /payments {amount, order_id, callback_url}` | `amount` is a numeric string in RIAL; `order_id` is the payment's 8-character code plus a random 6-character suffix; `allow_partial: false` is sent; `customer_phone`, `customer_email`, `description` and `webhook_url` are never sent |
| §3.1 `callback_url` for a bot is `https://t.me/<bot>?start=<param>` | `https://t.me/<stored bot username>?start=tp-<payment id>`; the bot answers `/start tp-<id>` with that payment's status read from the payment (`GATEWAY_RETURN`); the `?token=`/`?status=` the provider appends never reach Nexa and `status` is never trusted |
| §3.2 `GET /payments/{token}` display only | never called |
| §3.3 `POST /payments/{token}/verify`, no body | the settlement authority: `paid` AND `order_id` AND `amount` (rial) equal to Nexa's record AND `received_amount` not below `payable_amount`; otherwise MISMATCH, held for an operator, never credited |
| §3.3 `verified_before` | informative only; the exactly-once ledger key decides a repeat |
| §5 every amount is rial | `domain/tetrapay.ts`: x10 out, /10 in, a non-multiple of ten refused; the only place the factor appears |
| §6 `created pending paid expired` | `created`/`pending` open; `paid` as above; `expired` unsuccessful; anything else open |
| §7 webhook `t=<unix>,v1=<hex>`, `HMAC_SHA256(whsec_ secret, t + "." + raw_body)`, constant time, 300 s, `X-TetraPay-Event-Id` | `infrastructure/tetrapay-signature.ts` over the RAW bytes (`surfaces/gateway/raw-body.ts`); dedupe on the event id; a verified webhook still only brings the verify forward |
| §9 error table | every code mapped in the adapter and to Persian (`web.provcode_tetrapay_*`, ops log); `GATEWAY_SUSPENDED` refuses a create only; `DAILY_LIMIT_REACHED` (a 429, told apart from `RATE_LIMITED` by its code) hides the route until 00:00 Tehran; `RATE_LIMITED` honours `Retry-After`, else `error.retryAfter`; `AMOUNT_OUT_OF_RANGE` shows min/max converted to Toman |
| §10 60 requests a minute per key | 50 per tenant across replicas, 40 of them inquiries |
| §8 no refund, no cancel | none; an undeliverable order is refunded to the wallet by the one refund path |

## 2. Decisions taken

- The webhook secret is OPTIONAL (descriptor `webhookSecretOptional`). With none stored a webhook is
  an unauthenticated hint; with one stored an unverified, stale or unsigned webhook is dropped and
  raises the single `payments.gateway_webhook_unverified` condition (one per burst).
- The late-credit switch `payments.late_credit.tetrapay_enabled` defaults OFF: a new route moves no
  money its owner has not chosen to move.
- The bot username is read from the stored bot and shown, not typed: a second source could
  disagree with the bot that serves the customer.
- Nexa does not send `webhook_url`: the documentation accepts it only when the panel has a
  webhook key, and a refused create would cost a customer their payment; the operator registers the
  shown URL in the panel.
- `payment_gateways.hidden_until` (migration) is the provider's daily-limit hiding. It is not
  `status`: the operator's switch is untouched and the route returns by itself.
- `gateway_invoices.provider_method` (`online` | `card`) records the provider's `method` for the
  operations log line («تتراپی (آنلاین)»); it decides nothing.

## 3. Tests

`tests/unit/tetrapay-rules.test.ts` (rial/Toman helper, verdicts, ids, Tehran midnight),
`tetrapay-signature.test.ts`, `tetrapay-adapter.test.ts` (the documentation's own examples),
`tetrapay-raw-body.test.ts`, `tetrapay-screen.test.ts`, `tests/web/payment-gateways.test.tsx`, and
`tests/integration/tetrapay-gateway.test.ts` (create and verify, duplicate webhook, mismatch,
signature cases, no-secret webhook, daily limit, `Retry-After`, `GATEWAY_SUSPENDED`, late credit).

## 4. Open questions

`docs/open-questions.md`, "TetraPay": OQ-TP-01..05 - only what the documentation does not say.
