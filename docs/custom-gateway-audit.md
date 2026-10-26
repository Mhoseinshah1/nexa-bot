# The custom gateway — implementation audit (Round 10 C1)

The protocol is `docs/protocols/custom-gateway.md` (v1). This file records how Nexa implements its
side, which decisions were taken and why, and where each rule lives. The mutation checks are in
`docs/custom-gateway-falsification.md`; the open owner questions are `OQ-CG-01..06` in
`docs/open-questions.md`. **Built, NOT yet accepted against a real bridge (`OQ-CG-01`); the route
ships DISABLED.**

## 1. What it is

ONE code-backed gateway type, `CUSTOM` (`packages/contracts/src/payment-gateways.ts`), that speaks
only Nexa's own JSON-over-HTTPS protocol. A third party writes a bridge between that protocol and
a payment service Nexa has no adapter for; the operator points the route at the bridge. An
operator can never define a provider: the roster is still code (ADR-0023's rule), and every
answer a bridge gives is judged by the same code for every bridge. It is NOT MirzaBot-compatible.

## 2. Decisions (lead, Round 10)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| D1  | ONE per-route secret (the owner's "a per-gateway secret"), used for both directions with domain separation: Nexa's requests sign `NEXA-CGW-V1-REQUEST…`, the bridge's 2xx responses `NEXA-CGW-V1-RESPONSE\n<t>\n<request nonce>\n` + body, its callbacks `NEXA-CGW-V1-CALLBACK\n<t>\n` + body. Stored in the existing API-key slot (`payment_gateway.api_key`), which the enable check already requires; no second secret column, no `webhookSecret` on the descriptor. A new descriptor field `webhookSignedByCredential` tells the webhook path to verify against that slot. 32–512 characters.            | `custom-gateway-signature.ts`, `GatewayPaymentService.verifyWebhook`, `PaymentGatewayService.setCredential` |
| D2  | One `CUSTOM` route per tenant in v1 (routes are keyed `(tenant, provider)`); the operator's display name is the route's name. Several bridges per tenant: `OQ-CG-02`.                                                                                                                                                                                                                                                                                                                                                                                                                                        | contracts roster                                                                                            |
| D3  | UNDERPAID, OVERPAID and every `PAID` with a mismatch (invoice id, reference, amount, amount paid) → the existing mismatch hold: the payment goes UNKNOWN for an operator, nothing credited. Approve only `PAID` with an exact match of all four. `FAILED` / `EXPIRED` fail the attempt — unless the same answer reports money captured, which contradicts the status and is held instead. `PENDING` and unknown statuses stay open.                                                                                                                                                                          | `domain/custom-gateway.ts` `customJudgement`                                                                |
| D4  | Late credit: `payments.late_credit.custom_enabled`, OFF by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `settings.ts`                                                                                               |
| D5  | Base URL https-only (contract shape check + adapter refusal), every call through `SafeHttpClient` with the installation's URL policy (`panelUrlPolicy`: loopback, link-local and Nexa's own networks refused, DNS pinned, no redirect); also checked against the policy when SET. Frozen on each attempt (`gateway_invoices.endpoint_base_url`, written once by trigger). Changeable only while the route is DISABLED (the UPDATE's own WHERE), every change audited (`payment_gateway.set_endpoint`). No security-topic ops event exists for gateway configuration changes, so none is raised (`OQ-CG-05`). | `PaymentGatewayService.setEndpoint`, migration 0282                                                         |
| D6  | Cancel: NOT called in v1. The existing pipeline cancels on expiry only on the card-transfer route (TonPays Telegram), through a lane built for that provider; no link gateway is cancelled on expiry. The protocol keeps cancel as optional for a bridge; `expires_at` binds the bridge (`OQ-CG-04`).                                                                                                                                                                                                                                                                                                        | protocol §3.5                                                                                               |
| D7  | The wire unit is the RIAL: IRT x10 by TetraPay's `rialOfToman` (the one place the factor lives); an IRR sale is sent as it is (divisibility is the bridge's `AMOUNT_NOT_PAYABLE`, never a rounding here).                                                                                                                                                                                                                                                                                                                                                                                                    | `customAmountOf`                                                                                            |
| D8  | The customer is named by an opaque, stable, random 10-digit number (`customer_ref`), CentralPay's `gateway_customer_numbers` reused through `numericIdentity` — never a Telegram id. The invoice id is `cg_` + 26 Crockford base32 (130 random bits), unique across the installation (tenants may share one bridge).                                                                                                                                                                                                                                                                                         | `numericIdentity`, `customOrderId`                                                                          |
| D9  | A lost create is never re-sent (the skill's rule, whatever the bridge's idempotency promises). A verified callback that names only the invoice id brings an inquiry BY invoice id (`reference: null`, descriptor `inquiresByOrderId`), and the bridge's reference from that signed answer is adopted.                                                                                                                                                                                                                                                                                                        | `GatewayPaymentService.processInquiry`, `inquiryClaimable`                                                  |
| D10 | A callback answers 401 on a bad/missing/stale signature (so the bridge retries after fixing its secret or clock), 403 when the sender is outside the optional allow-list (checked first, `request.ip` behind `TRUSTED_PROXY_IPS`, `matchesTrustedEntry`), 400 when header and body delivery ids differ, 200 otherwise — also for an unknown invoice or a stopped store.                                                                                                                                                                                                                                      | `webhook.controller.ts`                                                                                     |
| D11 | The ping (`GET /v1/ping`) is the Web Admin's «تست اتصال»; a bridge clock more than 60 s off fails it (`CLOCK_SKEW`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CustomGatewayAdapter.checkCredential`                                                                      |

## 3. Where each money rule lives

| Rule                                                            | Code                                                                                                                    | Test                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A callback never credits: only a signed inquiry answer approves | `GatewayPaymentService.applyWebhookHint` records a hint and schedules; `processInquiry` judges `outcome.verdict`        | `integration/custom-gateway.test.ts` › a callback that says PAID credits nothing while the inquiry says PENDING                       |
| An unsigned (or wrong-request) 2xx is never evidence            | `CustomGatewayAdapter.exchange` (`signed`), create → UNKNOWN, inquiry → FAILED                                          | `unit/custom-gateway-adapter.test.ts`, `integration/custom-gateway.test.ts` › an unsigned inquiry answer saying PAID approves nothing |
| Callback signature, window, rotation, domain separation         | `verifyBridgeSignature`                                                                                                 | `unit/custom-gateway-signature.test.ts`                                                                                               |
| Replay / dedupe                                                 | the existing `gateway_invoices.last_webhook_delivery_id`; the adapter's `deliveryId` from the body, equal to the header | `integration/custom-gateway.test.ts` › a verified callback brings the inquiry forward, and the same delivery id twice is a replay     |
| Amount mismatch, under/overpayment held                         | `customJudgement` → MISMATCH → `holdMismatch`                                                                           | `integration/custom-gateway.test.ts` (one case per status)                                                                            |
| Exact rial                                                      | `customAmountOf`                                                                                                        | `unit/custom-gateway-rules.test.ts`, the integration payable case                                                                     |
| Lost create never re-sent                                       | the lane's send stamp (unchanged); `nothingSent` vs UNKNOWN in the adapter                                              | `unit/custom-gateway-adapter.test.ts`, `integration/custom-gateway.test.ts` › a lost create is never re-sent…                         |
| Disabled by default; enable needs secret and base URL           | `ensureDefaults` (requiresCredentials), `setStatus` (`ENDPOINT_MISSING`)                                                | `integration/custom-gateway.test.ts`, `integration/custom-gateway-http.test.ts`                                                       |
| URL frozen per attempt; change only while DISABLED              | `gatewayInvoices.open`, trigger `nexa_gateway_invoices_endpoint_guard`, `setEndpoint`                                   | `integration/custom-gateway.test.ts`                                                                                                  |
| Write path reads scope activity in its transaction              | `setEndpoint` → `assertScopeActive(scope, tx)`                                                                          | `integration/custom-gateway.test.ts` › refuses the endpoint write once the scope has stopped…                                         |
| The secret leaks nowhere                                        | adapter never sends it; projections set-at only                                                                         | `integration/custom-gateway.test.ts` › the secret leaks nowhere…                                                                      |

## 4. Same pipeline as every online gateway

Ledger (`TOPUP_GATEWAY`, `GATEWAY_LATE_CREDIT`), the customer fee snapshot (the payable is sent,
the principal credited), late credit, the mismatch hold and the Payment Operations Center's
reconciliation (`RECONCILIATION_EVIDENCE.CUSTOM`: `PAID` confirms; `FAILED`, `EXPIRED`,
`UNDERPAID`, `OVERPAID` and an unpaid `PAID` may be failed by an operator), the payment timeline
(invoice created, webhook hint, inquiry, confirmation), the operations log (the existing
`payments.gateway_*` codes; a refused sender or signature on `payments.gateway_webhook_unverified`
with its `reason`), the financial log's provider line (rial captured vs asked), Gateway Health
(the `ENDPOINT_MISSING` gap, the ping as the credential check), Persian text for every
`custom.*` code (`apps/web/src/ops-code-labels.ts`, `packages/i18n/src/ops-log.fa.ts`). Customer
screens are the generic `bot.payment.gateway_*` ones; only the fallback route name is new.

No new event type, ledger reason, permission, notification kind or ops code.

## 5. Contract changes (each its own commit)

1. Roster: `CUSTOM`, its descriptor, three new descriptor fields (`operatorEndpoint`,
   `inquiresByOrderId`, `webhookSignedByCredential` — false on every other route), the slug, the
   late-credit switch, `bot.payment.route_name_custom`.
2. `custom-gateway.ts`: the protocol's constants and the base-URL / allow-list shape checks.
3. `PAYMENT_GATEWAY_ROUTES.endpoint`, `setPaymentGatewayEndpointRequestSchema`, the view's
   `endpoint`, the `ENDPOINT_MISSING` gap.

Migration `0282_custom_gateway.sql` (to be renumbered at merge): the roster on six tables, the
route's `endpoint_base_url` / `webhook_ip_allowlist`, the attempt's frozen `endpoint_base_url` and
its write-once trigger, `gateway_invoices_custom_check`, `provider_user_id` widened to CUSTOM.

## 6. Tests

- `tests/support/mock-custom-bridge.ts` — the reference bridge, written from the protocol document
  (tests only; nothing under `apps/` imports it): verifies Nexa's signature, window and nonce,
  idempotent create, signed answers, signed callbacks, every misbehaviour as a switch; served
  in-process or over real TLS.
- Unit: `custom-gateway-rules`, `custom-gateway-signature`, `custom-gateway-adapter`,
  `custom-gateway-tls` (real TLS through the container's own `SafeHttpClient`), plus the roster
  pins (`gateway-eligibility`, `gateway-selector`, `late-credit-rules`, `telegram-stars`).
- Integration: `custom-gateway` (the pipeline and the contract cases), `custom-gateway-http`
  (routes and the callback's status codes).
- Web: `tests/web/payment-gateways.test.tsx` › the custom gateway page.
