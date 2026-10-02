# NOWPayments hosted crypto invoice (`NOWPAYMENTS`): audit, design and what was built

Spec §16 (NOWPayments) and §18 (gateway consistency). The owner's requirement: NEXA creates
the invoice, the customer opens NOWPayments' hosted page and **chooses the coin there**; NEXA
never forces an asset. This document keeps the WP11A separation (`docs/tonpays-gateway-audit.md`):

- **A — documented NOWPayments behaviour**, read off the provider's own API reference;
- **B — Nexa product decisions**;
- **C — undocumented behaviour, deliberately NOT invented** (each with an open question).

**Not accepted against the real provider** (`OQ-NP-01`). Every test uses a fake written from
the documented shapes; CLAUDE.md's provider rule applies — a fake this repository wrote and an
adapter this repository wrote can only prove they agree with each other.

## 1. What exists, and what NOWPayments reuses (the audit)

NOWPayments is a fourth `settlesVia: 'GATEWAY'` route. It adds **no** second payment system:
every piece below is the TonPays (WP11A) / TonPays Telegram machinery, reused.

| Concern                 | Existing mechanism (unchanged unless noted)                                                                                      | NOWPayments                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Provider roster, CHECKs | `PAYMENT_GATEWAY_PROVIDERS`; five CHECKs generated from it                                                                       | One member; migration 0158 regenerates the five CHECKs and the review-window CHECK                                                        |
| Descriptor              | `PAYMENT_GATEWAY_DESCRIPTORS` (`settlesVia`, `approval`, `invoiceForm`, `conversion`, `providerReview`, …)                       | `GATEWAY / GATEWAY_KEY / INQUIRY / LINK / providerReview`; new field `webhookSecret: true` (every other route `false`)                    |
| Adapter port            | `ExternalGatewayAdapter` (`gateway-invoice-ports.ts`)                                                                            | `NowPaymentsAdapter`; the port gains an optional inquiry context, `verifyWebhook?` and `checkCredential?` — TonPays and Stars ignore them |
| Credentials             | `payment_gateway_credentials`, Secret Envelope v2, write-only, set-at only in projections                                        | The same row gains the IPN secret (`payment_gateway.webhook_secret`, its own AEAD purpose) and the last credential check                  |
| Attempt + invoice row   | `payments` (GATEWAY) + `gateway_invoices`; `PaymentService.requestGatewayPayment/Topup`, `openGatewayAttempt`                    | Reused; `gateway_invoices.hinted_payment_id` added (NOWPayments' `payment_id`)                                                            |
| FX                      | Central quote (package FX), `CENTRAL_FX` conversion, snapshot on the invoice row                                                 | Reused; the unit ratio is a FIXED 100 cents per USDT (`fixedUnitRatio`), no setting                                                       |
| Settlement              | `PaymentService.confirmGatewayPayment` — payment `FOR UPDATE`, effective deadline under the lock, the one settlement path        | Reused unchanged; evidence `GATEWAY_INQUIRY`, note `nowpayments:finished:paid`                                                            |
| Review window           | `payments.provider_review_*` (TonPays Telegram), 24 h, `loseTrackOfReviewed` → `UNKNOWN`                                         | Reused: coins seen on chain open it (`recordProviderFundsDetected`)                                                                       |
| Mismatch / review       | `UNKNOWN` + `payments.reconcile` (`reconcileGatewayPayment`, `reinquireGatewayPayment`), `payments.gateway_review_unresolved`    | Reused: a partial payment (or `finished` for another price) moves the payment to `UNKNOWN`                                                |
| Late completion         | `gateway_invoices.outcome = LATE_COMPLETION`, `payments.gateway_late_completion`, `PaymentLateCompletionObserved`                | Reused unchanged                                                                                                                          |
| Worker lane             | `GatewayPaymentService.runOnce` (3 s loop), per-tenant call budget, claim/stamp/call/record                                      | Reused; one new branch per verdict                                                                                                        |
| Webhook route           | `POST /payments/webhook/<provider>/<tenant>`, 16 KiB, `{ ok: true }` for everything well-formed                                  | Reused; reads `x-nowpayments-sig` only for a signed route, verified before the body is read                                               |
| Telegram                | pre-invoice `gp:<order>.<provider>` / `pm:` selector, top-up `tp:`, `gatewayAttemptScreen`, edit-in-place worker refresh         | Reused; route name, pay-button label and review sentences per provider                                                                    |
| Web Admin               | `pages/payment-gateways.tsx` (enable, display name, min/max, order, gift, fee, key), `pages/payments.tsx` (gateway invoice card) | IPN secret field, credential check + last result, provider label, provider payment id                                                     |

## 2. A — documented NOWPayments behaviour

Source: NOWPayments' API reference (Postman collection `7907941`), read through its OpenAPI
mirror (`APIs-guru/openapi-directory`, `nowpayments.io/1.0.0`) because the documenter host is
not reachable from the build session, plus NOWPayments' own `nowpayments-api-js` client
(`create-invoice/index.ts`).

- Base URL `https://api.nowpayments.io`; header `x-api-key`.
- `POST /v1/invoice` — `price_amount`, `price_currency` (`usd`, …), optional `pay_currency`,
  `ipn_callback_url`, `order_id`, `order_description`, `success_url`, `cancel_url`. Answers
  `id`, `order_id`, `price_amount`, `price_currency`, `pay_currency` (null when not set),
  `invoice_url`, … The customer is sent to `invoice_url`.
- `GET /v1/payment/{payment_id}` — the payment's status with the same key; fields include
  `payment_id`, `payment_status`, `price_amount`, `price_currency`, `pay_amount`,
  `actually_paid`, `pay_currency`, `order_id`, `outcome_amount`, and `invoice_id` ("the
  invoice ID from which the payment was created").
- `GET /v1/payment/` — the list of payments, paged (`limit` ≤ 500, `page`, `sortBy`,
  `orderBy`, `dateFrom`, `dateTo`); the current reference adds an `invoiceId` filter and shows
  a JWT `Authorization` header beside the key.
- Statuses: `waiting`, `confirming`, `confirmed`, `sending`, `partially_paid`, `finished`,
  `failed`, `refunded`, `expired`.
- IPN: POSTed to `ipn_callback_url` on status changes, body "similar to a get payment status
  response", header `x-nowpayments-sig` = HMAC-SHA512 (hex) keyed by the store's **IPN
  secret** over the body with its keys sorted and serialised as JavaScript's `JSON.stringify`
  does. The reference gives the recursive `sortObject` form and, originally,
  `JSON.stringify(params, Object.keys(params).sort())`.
- Recurrent notifications: on a delivery error, the same notification is repeated.
- `GET /v1/estimate` — an estimated crypto price for a fiat amount; requires the key.
- A hosted invoice can carry SEVERAL payments: the customer may pick one coin, let it lapse,
  and pick another under the same invoice.

## 3. B — Nexa decisions

1. **Only the authoritative read decides** — TonPays' first rule. A webhook (verified or not)
   never reaches `confirmGatewayPayment`; it records a hint and brings the next inquiry forward.
2. **`finished` for exactly the invoiced price is the one approval.** The adapter's pure
   mapping requires `payment_status === 'finished'`, `price_amount` equal to the attempt's
   frozen `sent_amount` in cents, and `price_currency === 'usd'`. The provider's crypto
   amounts (`pay_amount`, `actually_paid`, `outcome_amount`) are never read as a decision.
3. **The IPN is verified before anything in it is read** (HMAC-SHA512, constant-time over
   equal-length digests, both documented canonical forms), and an unverified one is dropped.
4. **Price from the central FX only.** `price_amount` is US dollars: the payable in the
   sales currency divided by the central USDT quote (best bid, package FX), with one USDT
   pegged at one dollar — a fixed denomination, `100 cents per USDT`, not an operator rate.
   `ceil` to the cent by the contract's `providerUnitsByCentralFx`. The quote is snapshotted
   on the invoice row exactly as for Stars; a stale-beyond-limit or absent quote refuses the
   NEW attempt (`FX_UNAVAILABLE`) and never touches an open one.
5. **`pay_currency` is never sent**; neither is a description. Nothing about the customer
   leaves the installation but the order id Nexa generated (`NP` + 18 Crockford characters).
6. **Seventy-minute attempt**, the TonPays rule, so a late completion means the same thing on
   every inquiry route. Coins seen on chain (`confirming`, `confirmed`, `sending`) inside it
   open the existing 24-hour provider review window, under the payment's lock, strictly
   before its deadline, once — so a slow chain can finish.
7. **Partial payment never fulfils.** `partially_paid`, and `finished` for another price or
   currency, are the new verdict `MISMATCH`: the payment goes `PENDING → UNKNOWN`
   (`LOSE_TRACK`) with an audit row, `PaymentOutcomeUnknown` and the operator condition
   `payments.gateway_review_unresolved` (`reason: PROVIDER_AMOUNT_MISMATCH`) — the existing
   review/reconcile mechanism. Nothing is credited; nothing is failed automatically.
8. **One payment's `failed`/`expired`/`refunded` does not fail the attempt.** The hosted
   invoice can take another coin; failing the Nexa attempt would turn a second, successful
   payment into a late completion nobody settles. The attempt closes at its own deadline
   (`PAYMENT_EXPIRED`, the existing sweep), or — once coins were seen — at the end of the
   review window (`UNKNOWN`, operator).
9. **Webhook dedupe**: NOWPayments sends no delivery id; `<payment_id>:<status>:<updated_at>`
   from the VERIFIED body is the delivery id. A duplicate is `DUPLICATE` and changes nothing;
   settlement's own exactly-once never depends on it.
10. **Bounded reconciliation**: the existing schedule — 20 s, 40 s, 80 s, 160 s, then every
    5 minutes, one last read 15 s before the deadline, none after it except at most three
    webhook-triggered diagnostic reads; in review, the review cadence. Each read takes the
    tenant's call budget (50/min, 40 for inquiries). The integration suite pins "stops at the
    deadline, at most twenty calls".
11. **Credentials**: API key and IPN secret, both write-only and encrypted; enabling the
    route requires both (`CREDENTIAL_MISSING`, `WEBHOOK_SECRET_MISSING`); the secret can only
    be set once a key exists (it is bound to that row's id).
12. **Credential check**: `GET /v1/estimate` (documented, read-only, requires the key), made
    by the API outside any transaction, its machine result (`ok` or the classified code)
    recorded on the route as "last check" with an audit row.
13. **Min/max**: the existing per-route bounds (`minAmountMinor`/`maxAmountMinor`, in the
    sales currency) apply; NOWPayments' own per-coin minimums are the provider's, enforced on
    its page after the customer picks a coin (`OQ-NP-05`).

## 4. C — undocumented, NOT invented

| Gap                                                                      | What Nexa does                                                                                                                                                                      | Question |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Whether the payment list answers the key alone (the reference shows JWT) | Sends the key only; never stores the account e-mail/password. A 401/403 on the LIST is `nowpayments.list_refused.<status>` — recorded, never "misconfigured"; the IPN then decides. | OQ-NP-02 |
| How long a hosted invoice stays payable                                  | Nexa's 70-minute attempt; a payment after it is `LATE_COMPLETION` (recorded, operator), as TonPays.                                                                                 | OQ-NP-03 |
| Rate limits                                                              | Stays under 50 calls/min/tenant across replicas, 40 for inquiries.                                                                                                                  | OQ-NP-04 |
| Error body shape and codes                                               | A readable `code` is kept (bounded); 401/403 = configuration; 429 = rate limit (same order id retried ≤ 3 on a create); 5xx/timeout/unreadable = UNKNOWN on a create.               | OQ-NP-01 |
| Whether a payment record always carries `order_id`                       | The record is bound by `invoice_id` (compared with the attempt's); an `order_id` naming ANOTHER order is a mismatch; an absent one is accepted on the invoice id alone.             | OQ-NP-01 |
| Whether nested IPN objects are signed recursively sorted                 | Both documented canonical forms verify; each needs the secret.                                                                                                                      | OQ-NP-01 |
| A refund or cancel API for a merchant                                    | None used. An undeliverable order is refunded to the WALLET by the one credit path; a partial payment is resolved by the operator.                                                  | —        |

## 5. Design as built

### 5.1 Where things live

| Concern                                                  | Code                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Documented constants, Nexa decisions                     | `packages/contracts/src/nowpayments.ts`                                                        |
| Descriptor, `webhookSecret`, fixed unit ratio            | `packages/contracts/src/payment-gateways.ts`, `fx.ts`                                          |
| Pure rules (verdict, cents, strongest payment, order id) | `payments/domain/nowpayments.ts`                                                               |
| Reconciliation evidence per provider vocabulary          | `payments/domain/gateway-reconciliation.ts`                                                    |
| IPN signature                                            | `payments/infrastructure/nowpayments-signature.ts`                                             |
| The only NOWPayments HTTP (transaction-guarded sink)     | `payments/infrastructure/nowpayments-adapter.ts` (listed in `scripts/check-boundaries.sh`)     |
| Lane: verify, hint, inquire, review, hold, settle        | `payments/application/gateway-payment.service.ts`                                              |
| Funds-detected review, reconcile evidence, fixed ratio   | `payments/application/payment.service.ts`                                                      |
| IPN secret, credential check, enable gate                | `payments/application/payment-gateway.service.ts`, `drizzle-gateway-credentials.ts`            |
| Webhook route (signature header)                         | `surfaces/gateway/webhook.controller.ts`                                                       |
| Web Admin routes                                         | `surfaces/web/payment-gateways.controller.ts` (`webhook-secret`, `check`)                      |
| Telegram screens                                         | `surfaces/telegram/bot-runtime.ts` (`PROVIDER_PAY_BUTTON_KEYS`, `PROVIDER_REVIEW_SCREEN_KEYS`) |
| Migration                                                | `apps/api/drizzle/0158_nowpayments_gateway.sql` (number to be reassigned at integration)       |

### 5.2 Creating the invoice

The customer's tap writes the `payments` row (`GATEWAY`, `NOWPAYMENTS`, 70-minute deadline,
fee snapshot) and its `gateway_invoices` row (`CREATING`, `provider_unit = USD`,
`conversion_policy = CENTRAL_FX`, the quote snapshot, `sent_amount` in cents) in one
transaction — no provider call while Telegram waits. The worker stamps the send, calls
`POST /v1/invoice` outside any transaction and records `CREATED` (invoice id, `invoice_url`),
`CREATE_FAILED`, a deferred rate limit, or `CREATE_UNKNOWN` (never retried, never re-keyed)
exactly as for TonPays. A CHECK pins every NOWPayments row to USD, central FX and no bot.

### 5.3 The authoritative read

`inquire(key, invoiceId, { providerOrderId, sentAmount, hintedPaymentId })` (revised after the
Codex review of #141 — a hint never narrows what can be found):

1. When a VERIFIED IPN (or an earlier read) named a payment (digits only — it goes in a URL
   path), `GET /v1/payment/{id}`. If that payment is decisive — APPROVED (`finished` for the
   exact price) or MISMATCH — it is the answer, in one call.
2. Otherwise — no hint, or a hinted payment that is waiting, confirming, expired, failed or
   refunded, or that names another invoice — the invoice-wide list is read too:
   `GET /v1/payment/?invoiceId=<id>&limit=100&page=0&sortBy=created_at&orderBy=desc`, keeping
   only records whose `invoice_id` is this invoice and whose `order_id` (when present) is this
   attempt's, and reporting the strongest of the list and the hinted record (approval >
   mismatch > coins on their way > waiting/ended). An expired hinted payment therefore never
   hides a second coin's `finished` whose IPN was lost.
3. When the list is refused (`OQ-NP-02`) or empty, the hinted read's own answer stands.

The hint itself stays on the strongest payment: a verified IPN about ANOTHER payment moves the
hint only when its status ranks at least as high as what the hinted payment last showed (its
last read and its last IPN: `finished` 4, `partially_paid` 3, coins on their way 2, `waiting`
1, ended 0), and an IPN that does not move it leaves the hint's status untouched — so a later
`waiting` can never displace a `finished` before the worker reads it. Worst case, an inquiry
makes two calls; both run under the same per-tenant budget the inquiry took.

The orchestrator compares the answer's invoice and order ids with the attempt's (an answer
about another attempt is recorded as `nexa.identity_mismatch` and never acted on) and records
status, `provider_paid` (true only for APPROVED) and the payment id it described.

### 5.4 Verdicts and their effects

| Provider status                                   | Verdict      | Effect (inside the deadline)                                                 | After the deadline                         |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `finished`, exact price, `usd`                    | APPROVED     | `confirmGatewayPayment` → settle order / credit wallet once                  | `LATE_COMPLETION`, nothing moves           |
| `finished` other price/currency, `partially_paid` | MISMATCH     | `PENDING → UNKNOWN`, condition, `PaymentOutcomeUnknown`; operator reconciles | `LATE_COMPLETION` (unless already UNKNOWN) |
| `confirming`, `confirmed`, `sending`              | OPEN + funds | Opens the 24 h review window once (the deadline becomes the window's end)    | —                                          |
| `waiting`, `failed`, `expired`, `refunded`, other | OPEN         | Recorded; the next read per schedule                                         | —                                          |

The deadline is the EFFECTIVE one (`provider_review_until ?? expires_at`) and is decided
again under the payment's lock in `confirmGatewayPayment`, whatever the lane believed — the
integration suite drives a lane whose clock is ten minutes behind and shows the lock refusing.

### 5.5 Reconciliation by an operator

`reconcileGatewayPayment` now asks one table (`gateway-reconciliation.ts`) per provider:
NOWPayments CONFIRMED needs a recorded `finished` with `provider_paid = true`; FAILED accepts
`failed`, `expired`, `refunded`, `partially_paid`, and a `finished` recorded unpaid (another
price). TonPays' vocabulary is unchanged (a `completed` without `paid` is still never failable).
"Ask the provider again" (`reinquireGatewayPayment`) works unchanged.

### 5.6 The IPN

`POST /payments/webhook/nowpayments/<tenant>` with `x-nowpayments-sig`. In order: the tenant
must be active; its IPN secret is decrypted; the signature is verified over the parsed body;
only then is the body parsed (`payment_id`, `invoice_id`, `order_id`, `payment_status`,
`updated_at`). An unverified notification is answered `{ ok: true }`, dropped unread, and
raises `payments.gateway_webhook_unverified` (one per provider, recovered by
`payments.gateway_webhook_verified`). A verified one is located inside the tenant by the
provider order id, checked against a known invoice id, deduplicated, recorded with its
payment id as the hint, and brings the next inquiry forward (no sooner than 5 s after the
last). It never settles anything.

### 5.7 Web Admin

`/payment-gateways`: enable/disable, display title, instructions, min/max, sort order,
top-up gift, customer fee — the existing route settings. NOWPayments adds the IPN secret
(write-only, its own route `POST /payment-gateways/NOWPAYMENTS/webhook-secret`), the
credential check (`POST …/check`) and the last check's time and result, and an explanatory
banner. The callback URL is generated and shown read-only, as for TonPays. `/payments`
shows the provider name and the provider payment id on the gateway card.

### 5.8 Telegram

The route's default name, used in the payment-method selector when the operator set no
display title, is «💳 پرداخت با ارز دیجیتال» (`bot.payment.route_name_nowpayments`). The ready
invoice's URL button carries the same label under its OWN key,
`bot.payment.nowpayments_pay_button`, isolated in `PROVIDER_PAY_BUTTON_KEYS` so the central
inline-button registry (Agent A/C) can route it as **`payment.nowpayments.open`** without
touching any other route. In review: `bot.payment.nowpayments_in_review` (no pay link); held or
lapsed: `bot.payment.nowpayments_review_unresolved`. Everything else (preparing, check,
confirmed, closed, edit-in-place by the worker) is the existing screen.

### 5.9 Spec §18 consistency

Existing registry and port; provider attempt identifiers on `gateway_invoices` (order id,
invoice id, hinted payment id); no business identity on a label (the route is the closed
enum, the button is a template key); idempotency on every command; `bigint` cents and Toman,
no float in a decision (`price_amount` is written from and read back to exact cents);
settlement only in `PaymentService`; audit on every state change; tenant-scoped everything;
provider errors reduced to bounded machine codes — never a body, a message, a URL or the key.

## 6. Tests

- `tests/unit/nowpayments-adapter.test.ts` — signature (valid, tampered value, tampered nested
  value, key-order independence at every depth, missing/empty/short/non-hex header, wrong or
  empty secret, non-object body, uppercase hex, the replacer form); the full status table; a
  `finished` for another price/currency/unreadable price; cents in and out; central-FX pricing
  and its ceiling; the create request (no `pay_currency`, key only in its header) and every
  answer class with the key in no outcome; payment-by-id vs list, list filtering and ranking,
  list refusal not being configuration; the webhook hint and dedupe id; the credential check;
  reconciliation evidence for NOWPayments and TonPays unchanged.
- `tests/unit/nowpayments-screen.test.ts` — the pay button's own key; review and needs-review
  sentences; no pay link while in review or held.
- `tests/integration/nowpayments-gateway.test.ts` — against PostgreSQL with the container's
  services: enable gates; secrets never in views, audit, ops log or logs; USD cents from the
  central quote; `FX_UNAVAILABLE` when stale; settlement only after the read; duplicate IPN;
  unverified IPN dropped unread; partial payment → `UNKNOWN`, not confirmable, failable;
  `finished` for another price never fulfils; coins seen → review → finish after the 70 minutes
  settles; finish after the deadline is a late completion decided under the lock; one expired
  payment does not fail the attempt; a lost IPN found through the list; reconciliation bounded.
- `tests/integration/nowpayments-http.test.ts` — write-only key and secret over HTTP, the
  enable gate, the check refusals, and the signature header reaching verification.
- `tests/web/payment-gateways.test.tsx` — the IPN secret's state and write-only field, the
  last check, the check button only for NOWPayments.

Mutation (each rule reverted, its test watched to fail, restored): signature verification
skipped; `partially_paid` approving; the price not compared; `expired` failing the attempt;
no review on coins seen; a refused list read as configuration; `pay_currency` sent; enabling
without the secret.

## 7. Rollback (Codex review of #141)

The release seeds a `DISABLED` NOWPAYMENTS route row per tenant at boot, as every earlier
provider did. The previous binary indexes `PAYMENT_GATEWAY_DESCRIPTORS` by every row's provider
(admin list, active-route evaluator, gateway worker claim), so a rollback needs the procedure
in `docs/deployment.md`, "Before rolling back past NOWPayments (0158)": disable, drain, delete
the NOWPAYMENTS budget, credential and route rows. This release, in turn, lists and claims
only providers it knows (`DrizzlePaymentGatewayRepository.list`, `claimCreating`,
`claimInquiries`, and an adapter resolver that answers `null`, never `undefined`), so a later
release's provider cannot break it the same way (`tests/integration/payment-gateways.test.ts`).

## 8. Live acceptance still owed (`OQ-NP-01`)

With real NOWPayments credentials on staging: set the key and IPN secret, run the credential
check (expect `ok`), enable the route, pay a small top-up in one coin and an order in another;
read on the payment's gateway card the invoice id, the provider payment id, `finished`, and
`provider_paid`; confirm the IPN verified (no `payments.gateway_webhook_unverified`); confirm
whether the payment list answered (`last_inquiry_error_code` not `nowpayments.list_refused.*`,
`OQ-NP-02`); pay deliberately short once and reconcile the resulting `UNKNOWN`. Record every
real response shape that differs from §2 and correct the fake in the same commit.
