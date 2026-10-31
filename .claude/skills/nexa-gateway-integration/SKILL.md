---
name: nexa-gateway-integration
description: Checklist for adding or changing a NEXA payment gateway, derived from the TonPays, TonPays-Telegram, TetraPay, NOWPayments and CentralPay implementations — IRR/IRT conversion at the adapter, amountToTransfer vs principal, inquiry-only approval, webhook signatures and dedupe, lost-create (UNKNOWN) handling, late credit, cancel/refund request rows, Persian error codes, secrets, ops codes, templates, registration points and the required tests. Use before writing a new gateway adapter, a provider migration, a webhook route, or changing how any gateway settles, credits or refunds.
---

# Adding a payment gateway

Every line below holds for the existing gateways; `references/evidence.md`
cites the file for each. If your provider breaks one, it is an owner question
(`docs/open-questions.md`), not a design choice. Read `nexa-conventions` →
Domain invariants (Payments, Money) first. Paths: `PAY` =
`apps/api/src/modules/commerce/payments`.

## Money and amounts

- [ ] Rial/toman conversion happens **only in the adapter/domain file** of the
      provider (`providerAmountOf`), never in orders or wallet. An IRR amount
      not divisible by 10 is refused, not rounded.
- [ ] Money stays `bigint` minor units with a currency; prices come from the
      pricing boundary, never recomputed by the gateway.
- [ ] The customer transfers `amountToTransfer`, which is
      `customerFee.payable ?? payment.amount`; top-up, late credit and refund
      use `payment.amount`, the principal. A fee is never credited or refunded.
- [ ] Provider amounts are metadata unless the provider's verify contract makes
      them a condition (TetraPay: a mismatch is held for an operator).

## Verifying payments

- [ ] **Only the inquiry/verify decides.** A webhook or browser return only
      brings an inquiry forward; the webhook controller never dials the
      provider, never reaches `PaymentService.confirmGatewayPayment`.
- [ ] Settlement under the payment's lock, scope checked in the transaction,
      the 70-minute `*_ATTEMPT_LIFETIME_MINUTES` deadline checked there; a later
      approval is `LATE_COMPLETION` and settles nothing.
- [ ] Verify the webhook exactly as the provider signs it. A provider with a
      `t=<unix>,v1=<hex>` header over the raw body (TonPays, TetraPay) uses the
      shared timestamped HMAC core (300 s window, raw bytes from `raw-body.ts`);
      one with another scheme keeps its own verifier (NOWPayments: HMAC-SHA512
      over key-sorted JSON, `nowpayments-signature.ts`) — never force it onto
      the shared core. A timestamp is never a dedupe key. Dedupe is
      `gateway_invoices.last_webhook_delivery_id`, and settlement is
      exactly-once without it. Secret required or optional is a descriptor field.
- [ ] Provider idempotency is a unique per-attempt provider order id; a retry by
      the customer is a new attempt with a new id.
- [ ] **A create whose answer was lost is never retried and never re-keyed**:
      stamp `creation_sent_at` and commit before the call; a found stamp is
      `CREATE_UNKNOWN`. Only the provider's own rate-limit code clears it. 429,
      timeout and unknown stay three different outcomes. **UNKNOWN is never
      refunded** or auto-settled — reconcile by READ.

## After payment

- [ ] Late approval → wallet credit with reference `<paymentId>:late-credit`,
      ledger reason `GATEWAY_LATE_CREDIT`, behind the provider's late-credit
      setting (or `lateCreditSetting: null` = none). Money confirmed for a
      CANCELLED attempt, or for an order another payment already settled, is
      RETURNED through the same credit whatever the setting (R12 F1); a
      cancelled attempt is still asked about until its own deadline.
- [ ] Cancel/refund via the provider exists only as request rows
      (`gateway_provider_requests`): conditional-UPDATE state machine, in-flight
      unique index, send stamped before the call, sealed refund card whose AAD
      is the request id, wiped by the send stamp. Without a provider API, an
      undeliverable order goes through `RefundService.refundUndeliverable`.

## Text, secrets and logs

- [ ] Every provider error code mapped in the adapter **and** to Persian
      (`apps/web/src/error-text.ts` / `ops-code-labels.ts`, `web.fa.ts`).
- [ ] Credentials reuse the `payment_gateway.*` secret purposes through
      `SecretCipher` and the secret registry; projections expose set-at
      timestamps only, never a masked value.
- [ ] Ops codes `payments.gateway_*` beside the producer, listed in
      `GATEWAY_HEALTH_OPERATIONAL_CODES`, routed by `ops-log-group.ts`; never
      rename one. Financial L-messages come from the outbox consumer.
- [ ] Customer text is template keys / notification kinds only — a new key or
      kind is a contract change, its own commit.

## Registration points and tests

The full list (contracts descriptor, provider constants, adapter, container
switch, the six provider CHECK constraints, settings, web pages, boundary sink
list, audit doc) and the test matrix are in `references/evidence.md` § 12–13.
Tests use fakes and fixtures written from the vendor's docs — no real
credentials, no recorded production traffic, no vendor documents committed.
The gateway is "built, not accepted" until it is verified against the real
provider (`docs/project-status.md` § Real-panel acceptance; the `OQ-WP10-01`
pattern).
