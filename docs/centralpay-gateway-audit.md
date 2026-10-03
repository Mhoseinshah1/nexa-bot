# CentralPay redirect + verify deposit (`CENTRALPAY`): audit, design and what was built

Spec §17 (CentralPay) and §18 (gateway consistency). The owner supplied the official
"CentralPay Deposit Method" guide; this document keeps the WP11A separation
(`docs/tonpays-gateway-audit.md`, `docs/nowpayments-gateway-audit.md`):

- **A — documented CentralPay behaviour**, read off the owner-supplied guide only;
- **B — Nexa product decisions**;
- **C — undocumented behaviour, deliberately NOT invented** (each with an open question).

**Not accepted against the real provider** (`OQ-CP-01`). Every test uses a fake written from
the guide's shapes; CLAUDE.md's provider rule applies — a fake this repository wrote and an
adapter this repository wrote can only prove they agree with each other.

## 1. What exists, and what CentralPay reuses (the audit)

CentralPay is a fifth `settlesVia: 'GATEWAY'` route. It adds **no** second payment system:

| Concern                 | Existing mechanism                                                                         | CentralPay                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider roster, CHECKs | `PAYMENT_GATEWAY_PROVIDERS`; five CHECKs generated from it                                 | One member; migration 0164 regenerates the five CHECKs                                                                                                   |
| Descriptor              | `PAYMENT_GATEWAY_DESCRIPTORS`                                                              | `GATEWAY / GATEWAY_KEY / INQUIRY / LINK / SAME_UNIT`; three new fields `verifyKey`, `browserReturn`, `numericIdentity`                                   |
| Adapter port            | `ExternalGatewayAdapter`                                                                   | `CentralPayAdapter`; the port gains `providerUserId` (create + inquiry context), `providerReference`/`mismatchReason` on an answer, `newCustomerNumber?` |
| Credentials             | `payment_gateway_credentials`, Secret Envelope v2, write-only                              | The same row gains the verify key (`payment_gateway.verify_key`, its own AEAD purpose)                                                                   |
| Attempt + invoice row   | `payments` (GATEWAY) + `gateway_invoices`; `openGatewayAttempt`                            | Reused; `provider_user_id` (write-once) and `gateway_customer_numbers` added                                                                             |
| Amount                  | TonPays' `tomanAmountOf` (IRT as is; IRR only when divisible by ten)                       | Reused unchanged — no float, no rounding                                                                                                                 |
| Settlement              | `PaymentService.confirmGatewayPayment` — payment `FOR UPDATE`, deadline under the lock     | Reused; additionally re-checks the bound `referenceId` under the lock                                                                                    |
| Reference uniqueness    | `gateway_invoices.provider_charge_id`, write-once, unique per (tenant, provider) (Stars)   | Reused for `referenceId`                                                                                                                                 |
| Mismatch / review       | `UNKNOWN` + `payments.reconcile`, `payments.gateway_review_unresolved`                     | Reused (amount, user or reference mismatch)                                                                                                              |
| Late completion         | `LATE_COMPLETION`, `payments.gateway_late_completion`                                      | Reused unchanged                                                                                                                                         |
| Worker lane             | `GatewayPaymentService.runOnce`, budget, claim/stamp/call/record, bounded inquiry schedule | Reused; the inquiry is authorised by the verify key                                                                                                      |
| Browser return          | none existed                                                                               | `GET /payments/return/centralpay/<tenant>?orderId=` → brings a verify forward, 302 to the bot                                                            |
| Telegram                | `gatewayAttemptScreen`, `PROVIDER_PAY_BUTTON_KEYS`, `PROVIDER_REVIEW_SCREEN_KEYS`          | Own pay-button key and needs-review sentence                                                                                                             |
| Web Admin               | `pages/payment-gateways.tsx`, `pages/payments.tsx`                                         | Verify-key field + state, provider name, provider user id                                                                                                |

## 2. A — documented CentralPay behaviour (the owner-supplied guide)

- `getLink`: POST JSON `https://centralapi.org/webservice/basic/getLink.php` with `api_key`
  (a static string), `type: "deposit"`, `amount` (integer, **Toman**), `userId` (integer),
  `orderId` (integer), `returnUrl`. Success: `{ success: true, data: { redirectUrl } }`; the
  customer is sent to `redirectUrl`.
- The return to `returnUrl` is a **GET** and carries no order data, so `orderId` must be
  placed in `returnUrl` by the merchant.
- `verify`: POST JSON `https://centralapi.org/webservice/basic/verify.php` with the verify
  `api_key` (an MD5 hash/string CentralPay supplies — a different credential from getLink's)
  and `orderId`. Success data: `referenceId`, `amount` (Toman), `userId`, `userCardNumber`.
- Repeated verify of a paid order can keep answering `success: true`.
- **No webhook is documented.**

## 3. B — Nexa decisions

1. **Only verify decides; a browser return proves nothing.** The return GET only brings the
   next verify forward (a database write); the worker makes the call under the tenant's budget.
2. **Approval is `success === true` (the boolean) AND**: the Toman `amount` equals exactly the
   attempt's frozen `sent_amount`; `userId` equals exactly the customer number sent; a
   `referenceId` is present and is bound to this attempt — never held by another payment.
   Anything else after `success: true` is `MISMATCH` (§5.4); `success` not `true` is `OPEN`.
3. **Two keys, never assumed equal.** The API key (getLink) and the verify key (verify) are
   separate write-only secrets under separate AEAD purposes; the route cannot be enabled
   without both (`CREDENTIAL_MISSING`, `VERIFY_KEY_MISSING`); the verify key needs the API
   key's row first. The lane picks the inquiry key by descriptor (`verifyKey`).
4. **Integer identities.**
   - `orderId`: a random ten-digit integer per attempt, in `[1 000 000 000, 2 147 483 647]`
     (inside a signed 32-bit integer, `OQ-CP-02`), unique across **every tenant** of the
     installation (tenants sharing one merchant account share its namespace) — a pre-check and
     the partial unique index `gateway_invoices_centralpay_order_id_key`; redrawn up to five
     times. Random rather than a sequence so staging and production on one merchant account do
     not hand out the same numbers, and ten digits so they do not collide with a small
     auto-increment another system used on the account. It also stands as the invoice id
     (getLink returns none).
   - `userId`: the customer's **stable random number** from `gateway_customer_numbers`,
     drawn on the first attempt (same range, unique per provider across tenants, immutable by
     trigger), frozen on each attempt as `provider_user_id` (write-once by trigger). Not the
     Telegram id: its width may not fit the provider's integer (`OQ-CP-02`) and the provider
     does not need the customer's Telegram identity.
5. **Exact Toman.** `tomanAmountOf`: IRT as is, IRR only when divisible by ten, otherwise the
   attempt is refused before any row (`AMOUNT_NOT_REPRESENTABLE`) — never rounded.
6. **Seventy-minute attempt**, the rule every inquiry route shares (`OQ-CP-04`). No review
   window: nothing CentralPay says before verify means the money is with it.
7. **Bounded reconciliation**: the existing schedule (20 s, 40 s, 80 s, 160 s, then every
   5 minutes, one last read 15 s before the deadline, none after it); after the deadline at
   most three diagnostic verifies, which only a browser return can trigger; an operator's
   "ask again" on an UNKNOWN payment; each read takes the tenant's call budget (50/min, 40
   for verifies). Pinned by the integration suite ("at most twenty calls", "≤ 3 after").
8. **`userCardNumber` is never read.** It is not in the adapter's schema, so it reaches no
   outcome, row, audit, ops event or log line — not even masked.
9. **No webhook.** `POST /payments/webhook/centralpay/…` is a 404 and the lane refuses one.
10. **Health / credential check: omitted.** The guide documents no read-only call; calling
    `verify` or `getLink` as a "check" would have side effects or need a real order. The
    Web Admin says so and offers no check button.

## 4. C — undocumented, NOT invented

| Gap                                                                    | What Nexa does                                                                                             | Question |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| Real response shapes, error bodies, HTTP statuses                      | Reads only `success`, `data.redirectUrl`, `data.amount/userId/referenceId/orderId`; codes are Nexa's       | OQ-CP-01 |
| Integer width of `orderId` / `userId`                                  | Ten digits inside int32                                                                                    | OQ-CP-02 |
| Meaning of `success: false` on getLink                                 | `REFUSED`, treated as configuration (`centralpay.not_success`): operator told, customer told "unavailable" | OQ-CP-03 |
| Meaning of `success: false` on verify; side effects of an early verify | `OPEN` (`unverified`), asked again until the deadline; assumed side-effect free                            | OQ-CP-03 |
| How long a link stays payable                                          | 70-minute attempt; later money is `LATE_COMPLETION`                                                        | OQ-CP-04 |
| Rate limits                                                            | 50 calls/min/tenant (40 for verify)                                                                        | OQ-CP-05 |
| Whether `referenceId` is globally unique at CentralPay                 | Unique per tenant and provider in Nexa (write-once charge id)                                              | OQ-CP-06 |
| A refund / cancel API                                                  | None used; an undeliverable order is refunded to the wallet by the one credit path                         | —        |

## 5. Design as built

### 5.1 Where things live

| Concern                                                      | Code                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Documented constants, Nexa decisions                         | `packages/contracts/src/centralpay.ts`                                              |
| Descriptor (`verifyKey`, `browserReturn`, `numericIdentity`) | `packages/contracts/src/payment-gateways.ts`                                        |
| Pure rules (integers, verdict, return URL)                   | `payments/domain/centralpay.ts`                                                     |
| Reconciliation evidence, reference-bound providers           | `payments/domain/gateway-reconciliation.ts`                                         |
| The only CentralPay HTTP (transaction-guarded sink)          | `payments/infrastructure/centralpay-adapter.ts` (listed in `check-boundaries.sh`)   |
| Lane: verify key, reference binding, hold, return            | `payments/application/gateway-payment.service.ts`                                   |
| Integer identities, reference re-check under lock            | `payments/application/payment.service.ts`                                           |
| Verify key, enable gate                                      | `payments/application/payment-gateway.service.ts`, `drizzle-gateway-credentials.ts` |
| Browser return                                               | `surfaces/gateway/return.controller.ts`                                             |
| Web Admin route                                              | `surfaces/web/payment-gateways.controller.ts` (`verify-key`)                        |
| Telegram screens                                             | `surfaces/telegram/bot-runtime.ts`                                                  |
| Migration                                                    | `apps/api/drizzle/0164_centralpay_gateway.sql`                                      |

### 5.2 Creating the link

The customer's tap writes the `payments` row and its `gateway_invoices` row (`CREATING`,
`IRT`, `SAME_UNIT`, the ten-digit order id, the customer's number) in one transaction. The
worker stamps the send, calls getLink outside any transaction with the API key and
`returnUrl = <origin>/payments/return/centralpay/<tenant>?orderId=<n>`, and records
`CREATED` (`invoice id = order id`, `invoice_url = redirectUrl`, https only), `CREATE_FAILED`,
a deferred rate limit, or `CREATE_UNKNOWN` (never retried, never re-keyed). With no public
origin there is no return URL: refused as configuration before any call. A CHECK pins every
CentralPay row to Toman, same unit, no bot and ten-digit integers.

### 5.3 The browser return

`GET /payments/return/centralpay/<tenant>?orderId=<n>` → `receiveBrowserReturn`:

- unknown tenant / route / order, or junk → nothing is written;
- payment `CONFIRMED` or attempt decided → answered from local state, **nothing asked**;
- open attempt → `requestInquiry` (no sooner than 5 s after the last verify);
- past the deadline → at most the bounded diagnostic verifies.

The browser is then redirected (302, `cache-control: no-store`) to `https://t.me/<username>`
of the tenant's first active bot, from the stored username (validated against Telegram's
username shape; no Telegram call on a public GET). The redirect depends only on the tenant,
so it reveals nothing about which orders exist. The customer's payment message is edited in
place by the worker once the verify answers. With no bot, `{ ok: true }`. No controller
settles anything.

### 5.4 Verify and its verdicts

| Verify answer                                                       | Verdict  | Effect (inside the deadline)                                  |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `success: true`, exact Toman, same userId, `referenceId` bound here | APPROVED | `confirmGatewayPayment` → settle / credit once                |
| `success: true`, other amount                                       | MISMATCH | `PENDING → UNKNOWN`, `PROVIDER_AMOUNT_MISMATCH`, condition    |
| `success: true`, other / no userId                                  | MISMATCH | `PROVIDER_USER_MISMATCH`                                      |
| `success: true`, no referenceId                                     | MISMATCH | `PROVIDER_REFERENCE_MISSING`                                  |
| `success: true`, referenceId held by another payment                | MISMATCH | `PROVIDER_REFERENCE_REUSED`, recorded unpaid                  |
| `success: true`, `data.orderId` naming another order                | —        | `nexa.identity_mismatch`, ignored                             |
| `success: false` (2xx or 4xx)                                       | OPEN     | `unverified`, asked again on schedule; the deadline closes it |
| 401/403 · 429 · 5xx/timeout/unreadable                              | —        | configuration condition · rate limit · transient              |

The reference is bound (write-once `provider_charge_id`) in the transaction that records the
answer, before anything can settle; `confirmGatewayPayment` re-reads it under the payment's
lock and refuses (`PROVIDER_REFERENCE_MISMATCH`) a CentralPay payment whose bound reference
is absent or different — whatever its caller passed. After the deadline an approval is a
`LATE_COMPLETION` decided under that lock. Once settled, the outcome is recorded and no
further verify is ever made for the attempt, so CentralPay's repeated `success: true` can
never credit twice.

### 5.5 Reconciliation by an operator

`reconcileGatewayPayment` (one table): CentralPay CONFIRMED needs a recorded `verified` with
`provider_paid = true` **and** a bound reference; FAILED accepts `unverified` or a
`verified` recorded unpaid (a mismatch). "Ask the provider again" works unchanged.

### 5.6 Web Admin

`/payment-gateways`: enable/disable, display title, instructions, min/max, sort order, gift,
fee — the existing route settings — plus the verify key (write-only, its own route
`POST /payment-gateways/CENTRALPAY/verify-key`, its state shown, never a value) and an
explanatory banner. No credential check (§3.10). The generated return URL base is shown
read-only where the webhook URL is shown for other routes. `/payments` shows the provider
name, the reference (charge id) and the provider user id.

### 5.7 Telegram

Route name «پرداخت با CentralPay» (`bot.payment.route_name_centralpay`, plain: a body never types a slotted emoji); the link button
carries the same label under its own key `bot.payment.centralpay_pay_button`, isolated in
`PROVIDER_PAY_BUTTON_KEYS` and registered in the central inline-button registry (`inline-buttons.ts`) as
**`payment.centralpay_open`**; a held payment shows `bot.payment.centralpay_review_unresolved`
(no pay link). Everything else is the existing screen, edited in place by the worker.

### 5.8 Spec §18 consistency

Existing registry and port; provider identifiers on `gateway_invoices` (order id, user id,
reference); no business identity on a label; idempotency on every command; `bigint` Toman,
no float; settlement only in `PaymentService`; audit on every state change; tenant-scoped
everything (the two installation-wide uniqueness checks are existence-only); provider
errors reduced to bounded machine codes — never a body (which carries the key), a message,
a URL, a key or a card number.

## 6. Tests

- `tests/unit/centralpay-adapter.test.ts` — descriptor; exact Toman (IRR divisible only);
  strict integers; the integer range; the return URL; every verdict branch (amount ±1 Toman,
  user, reference); getLink request (integers, link key in body only, no Telegram id) and
  every answer class with no key in any outcome; verify request with the verify key,
  mismatch outcomes, another order id, `success:false` open, failure classes, no card number
  in any outcome; no webhook; reconciliation evidence.
- `tests/unit/centralpay-screen.test.ts` — own pay-button key; needs-review sentence with no link.
- `tests/integration/centralpay-gateway.test.ts` — enable gates; keys never in views, rows,
  audit, ops log, outbox or logs, nor the card; link request; stable userId / fresh orderId and
  their write-once triggers; browser return alone never settles; junk returns ask nothing;
  duplicate return/verify single credit with no further verify; amount mismatch never
  fulfils (reconcile CONFIRMED refused, FAILED allowed); userId mismatch; referenceId reuse
  refused and the settlement path's own refusal; late completion under the lock; lost return
  found by the worker; bounded verifies and bounded post-deadline returns; no webhook.
- `tests/integration/centralpay-http.test.ts` — write-only keys over HTTP, the enable gate, no
  webhook route, the return redirect (no oracle, no-store).
- `tests/web/payment-gateways.test.tsx` — verify-key state, its empty write-only field and
  route, no check button.

Mutation (each rule reverted, its test watched to fail, restored): see the feature commit.

## 7. Live acceptance still owed (`OQ-CP-01`)

With real CentralPay credentials on staging: set the API key and the verify key, enable the
route, pay a small top-up and an order; confirm the browser returns to the bot and the
Telegram message turns confirmed; read on the payment's gateway card the order id, the
provider user id, `verified`, `provider_paid` and the reference. Verify an unpaid order once
to learn what `success: false` looks like (and that it has no side effect, `OQ-CP-03`).
Record every real shape that differs from §2 and correct the fake in the same commit.

## 8. Rollback

See `docs/deployment.md`, "Before rolling back past CentralPay (`0164`)".
