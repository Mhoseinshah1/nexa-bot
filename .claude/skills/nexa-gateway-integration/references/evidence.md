# Gateway facts, with sources (collected 2026-10-24 from `main` at 54518005)

`PAY` = `apps/api/src/modules/commerce/payments`; `PGC` =
`packages/contracts/src/payment-gateways.ts`; `GPS` =
`PAY/application/gateway-payment.service.ts`; `PS` =
`PAY/application/payment.service.ts`. Line numbers drift — grep the symbol.

Roster: `TONPAYS` (migration 0122), `TONPAYS_TELEGRAM` (cancel/refund in 0274),
`NOWPAYMENTS` (0158), `CENTRALPAY` (0164), `TETRAPAY` (0275), plus
`TELEGRAM_STARS`. TonPays-Telegram is TonPays' Custom Telegram API: own key,
descriptor `invoiceForm: CARD_TRANSFER`, bound to a bot, needs the buyer chat
id, provider review (`docs/tonpays-telegram-gateway-audit.md`).

## 1. Conversion

- TonPays: `PAY/domain/tonpays.ts` `tomanAmountOf` — IRT as is, IRR only when
  divisible by 10, otherwise refused. CentralPay the same rule
  (`packages/contracts/src/centralpay.ts`).
- TetraPay is rial on the wire: `PAY/domain/tetrapay.ts` — `RIAL_PER_TOMAN`
  (used nowhere else), `rialOfToman` (applies the factor for the wire),
  `tomanOfRial`, `parseRialAmount`.
- NOWPayments: USDT through central FX (descriptor `conversion: CENTRAL_FX`).
- Port: `ExternalGatewayAdapter.providerAmountOf` in
  `PAY/application/gateway-invoice-ports.ts`.

## 2. Fees

`PAY/domain/amount-to-transfer.ts` `amountToTransfer`;
`packages/contracts/src/payment-amounts.ts` `paymentAmountsOf`;
`docs/payment-fees-fx.md`. Provider amounts non-authoritative:
`docs/tonpays-gateway-audit.md` §3.4. TetraPay exception (amount equality and
`received_amount >= payable_amount`, else MISMATCH held):
`docs/tetrapay-gateway-audit.md` §1, `PAY/domain/tetrapay.ts`.

## 3. Approval and deadline

Verdicts: `tonpaysVerdict` (`completed` AND `paid === true`), TetraPay
`POST /payments/{token}/verify`, `PAY/domain/nowpayments.ts`,
`PAY/domain/centralpay.ts`. Settlement: `PS.confirmGatewayPayment` (payment
`FOR UPDATE`, `assertScopeActive`, clock read after the lock,
`gatewaySettlementDeadline` in `PAY/domain/settlement.ts`). Lifetimes:
`*_ATTEMPT_LIFETIME_MINUTES = 70` in `packages/contracts/src/{tonpays,tetrapay,nowpayments,centralpay,telegram-stars}.ts`.
Late: `GPS` `markLateCompletion` → outcome `LATE_COMPLETION`, audit
`gateway_invoice.late_completion`, ops `payments.gateway_late_completion`.

## 4. Webhooks

Shared core `PAY/infrastructure/timestamped-webhook-signature.ts`, wrappers
`tonpays-signature.ts`, `tetrapay-signature.ts` (`t=<unix>,v1=<hex>`,
HMAC-SHA256 over `t.rawbody`, `TONPAYS_WEBHOOK_TOLERANCE_SECONDS` = 300).
NOWPayments: `nowpayments-signature.ts` (HMAC-SHA512, sorted JSON, secret
required). CentralPay: no webhook, browser return
(`apps/api/src/surfaces/gateway/return.controller.ts`). Controller
`apps/api/src/surfaces/gateway/webhook.controller.ts` (16 KiB cap, `{ok:true}`
once parsed, 401 on a bad signature when a secret is stored); raw bytes
`apps/api/src/surfaces/gateway/raw-body.ts`. Dedupe column
`gateway_invoices.last_webhook_delivery_id`. Ops: `tonpays.webhook.signature_rejected`,
`payments.gateway_webhook_unverified` (SECURITY topic by prefix,
`packages/contracts/src/ops-log-group.ts`).

## 5. Create and idempotency

Per-attempt provider order id, unique per tenant + provider in
`gateway_invoices` (TonPays `NX` + 18 Crockford base32; TetraPay code + random,
`gateway_invoices_tetrapay_check`; CentralPay integer + `gateway_customer_numbers`).
`GPS.processCreation`: claim, stamp `creation_sent_at`, commit, call outside the
transaction; found stamp → `CREATE_UNKNOWN` `nexa.send_interrupted`; only
`RATE_LIMIT(ED)` clears it, bounded by `TONPAYS_CREATE_MAX_ATTEMPTS`;
duplicate id, 5xx, timeout, unreadable 2xx → `CREATE_UNKNOWN`
(`payments.gateway_create_unknown`). Budgets `payment_gateway_call_budgets`
(`DrizzleGatewayCallBudget`, `PAY/infrastructure/drizzle-gateway-credentials.ts`).
Reconcile: `payments.reconcile` (`reconcileGatewayPayment`, `reinquireGatewayPayment`).

## 6. Late credit

`PAY/domain/late-credit.ts` `lateCreditReference` → `${paymentId}:late-credit`;
ledger reason `GATEWAY_LATE_CREDIT`; unique partial index
`wallet_entries_gateway_late_credit_payment_key`; `PS.creditLateGatewayApproval`
(audit `payment.gateway_late_credit`, event `PaymentLateCredited`, notice
`GATEWAY_LATE_PAYMENT_CREDITED`, outcome `LATE_CREDITED`). Settings
`LATE_CREDIT_SETTING_KEYS` in `PGC`, registered in
`packages/contracts/src/settings.ts`, shown in
`apps/web/src/settings-presentation.ts`; window `payments.late_credit.window_hours`.
NOWPayments and CentralPay: `lateCreditSetting: null`. `docs/tonpays-gateway-audit.md` §8.

## 7. Cancel and refund requests (TonPays-Telegram only)

Table `gateway_provider_requests` (migration `0274_tonpays_telegram_cancel_refund.sql`),
kinds in `packages/contracts/src/tonpays-telegram.ts`, indexes
`gateway_provider_requests_in_flight_key` (state `REQUESTED`, `SENT`) and
`gateway_provider_requests_idempotency_key`, checks `..._sealed_card_check`,
`..._refund_card_check`. Lane `PAY/application/gateway-provider-request.lane.ts`
(`payments.gateway_request_unknown`). Sealed card: purpose
`payment_gateway.refund_card`, AAD = request row id, wiped by the send stamp,
stored form `refund_card_masked`. Others have no refund API:
`PAY/application/refund.service.ts` `refundUndeliverable`.

## 8. Persian error codes

`TONPAYS_ERROR_CODES`, `TONPAYS_TELEGRAM_ERROR_CODES` → `apps/web/src/error-text.ts`;
others via `PROVIDER_CODE_LABELS` in `apps/web/src/ops-code-labels.ts`
(`errorCodeLabel`), text in `apps/web/src/i18n/web.fa.ts`; ops-event labels
`operationalEventLabelFa` in `packages/i18n`.

## 9. Secrets

`SECRET_PURPOSES` (`packages/contracts/src/secrets.ts`): `payment_gateway.api_key`,
`.webhook_secret`, `.verify_key`, `.refund_card`. Registry
`apps/api/src/infrastructure/crypto/secret-registry.ts` (a unit test requires
every ciphertext column registered). Store `DrizzleGatewayCredentialStore`;
writes `PaymentGatewayService.setCredential`. Adapter is a listed sink in
`scripts/check-boundaries.sh`.

## 10. Ops codes and L-messages

`GATEWAY_HEALTH_OPERATIONAL_CODES` (`packages/contracts/src/gateway-health.ts`,
pinned to producers by a unit test), `ops-error-events.ts`,
`notification-center.ts`. Routing `docs/ops-log-topics.md`,
`packages/contracts/src/ops-log-group.ts` (`payments.gateway_webhook_` before
`payments.`). L-types `packages/contracts/src/ops-log-types.ts` (L1–L6);
producer `PAY/application/financial-log.consumer.ts`.

## 11. Customer text

Kinds `GATEWAY_PAYMENT_FAILED`, `GATEWAY_LATE_PAYMENT_CREDITED`
(`packages/contracts/src/customer-notifications.ts`). Screen keys
`bot.payment.gateway_*` and per-provider `bot.payment.<provider>_*` in
`packages/contracts/src/templates.ts` (grep, never read whole). Screens in
`apps/api/src/surfaces/telegram/wizard-invoice-screens.ts`; taps `g:` / `gc:`
in `bot-runtime.ts`.

## 12. Registration points (TetraPay as the worked example)

1. `PGC`: `PAYMENT_GATEWAY_PROVIDERS`, `PAYMENT_GATEWAY_DESCRIPTORS` (settlesVia,
   invoiceCredential, approval `INQUIRY`, conversion, invoiceForm,
   webhookSecret/Optional, returnToBot, verifyKey, browserReturn,
   numericIdentity, lateCreditSetting), `PAYMENT_METHOD_SLUGS`. Contract commit.
2. `packages/contracts/src/<name>.ts` constants (URL, statuses, error codes,
   lifetime, tolerance), exported from the index.
3. `PAY/domain/<name>.ts`; `PAY/infrastructure/<name>-adapter.ts` implementing
   `ExternalGatewayAdapter` (`createInvoice`, `inquire`, `parseWebhook`,
   `providerAmountOf`, `newOrderId`; optional `verifyWebhook`, `checkCredential`).
4. `apps/api/src/container.ts`: instantiate, add the `gatewayAdapters` case.
5. Migration regenerating the provider CHECK on six tables —
   `gateway_customer_numbers`, `gateway_invoices`, `payment_gateway_call_budgets`,
   `payment_gateway_credentials`, `payment_gateways`, `payments` — plus any
   per-provider CHECK; `online-indexes.ts`; `pnpm db:check` (`nexa-migrations`).
6. Late-credit setting in `settings.ts`.
7. Route created DISABLED; enabling needs a credential
   (`PAY/application/payment-gateway.service.ts` `setCredential`, `setStatus`,
   `readinessFacts`).
8. Web: `apps/web/src/pages/payment-gateways.tsx`, `payment-labels.ts`,
   `error-text.ts` / `ops-code-labels.ts`, `web.fa.ts`, `pages/gateway-health.tsx`;
   `apps/api/src/surfaces/web/payment-gateways.controller.ts` (required-secret rule).
9. `scripts/check-boundaries.sh` sink list.
10. `docs/<name>-gateway-audit.md`, a falsification doc, and the provider's
    `OQ-*` entries in `docs/open-questions.md`.

Also consistent across all: inquiry loop `gateway-payments` in
`apps/api/src/main.worker.ts`, schedule in `PAY/domain/inquiry-schedule.ts`;
inquiry health `PAY/application/gateway-inquiry-health.ts`
(`payments.gateway_inquiry_failing`); gateway health `docs/gateway-health.md`
(a credential check only if the provider documents a safe one); outbox events
in the settling transaction; a failed attempt never cancels the order; codes
and logs never carry a body, header, URL or key (`docs/tonpays-gateway-audit.md` §8.2).

## 13. Tests each gateway has

- Unit: `tests/unit/<name>-adapter.test.ts`, `<name>-signature.test.ts`,
  `<name>-screen.test.ts`, rules/domain tests (`tetrapay-rules`, `late-credit-rules`).
- Integration: `tests/integration/<name>-gateway.test.ts`; an `<name>-http.test.ts`
  (HTTP against a local fake) exists for TonPays, NOWPayments and CentralPay,
  not TetraPay; plus the shared `gateway-inquiry-schedule`,
  `gateway-payment-ops-events`, `late-gateway-credit`, `payment-gateways`.
- Web: `tests/web/payment-gateways.test.tsx`, `tests/web/gateway-health.test.tsx`.
- Falsification: `docs/<name>-falsification.md` (e.g. `docs/tonpays-falsification.md`).
- There are no recorded vendor fixtures: every test uses a fake written from
  the vendor's docs (TetraPay uses the doc's own examples). The TonPays-Telegram
  screenshot is deliberately not in the repository; only transcribed facts are.
