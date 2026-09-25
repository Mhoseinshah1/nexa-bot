# WP11A — TonPays external payment gateway: audit and design

The owner's WP11A package brief is the product authority here. The attached copy of
`https://doc.tonpays.online/` (one page, fetched 2026-09-25) is the only provider
documentation used. This document was written before the production code; §7 records
what was built and where it differs in detail.

It keeps three things apart throughout:

- **A — documented TonPays behaviour**, which is what the page says and nothing more;
- **B — Nexa product decisions**, which are the owner's and are final for this package;
- **C — undocumented TonPays behaviour**, which is deliberately NOT invented.

Starting point: `main` at `4e6fb39` (PR #73 merged). This branch is not based on the
unmerged WP10G branch.

## 1. What exists (the audit)

| Concern                  | Where                                                                                          | What it does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway persistence      | `payment_gateways`, `(tenant, provider)` PK; `contracts/payment-gateways.ts`                   | A closed roster `PAYMENT_GATEWAY_PROVIDERS = ['MANUAL_TRANSFER']`. Each route has status, display name, bounds, eligibility, sort, `topup_cashback_percent`, and per-purpose switches. `PAYMENT_GATEWAY_DESCRIPTORS` says how a route settles (`settlesVia`) and whether it needs credentials. No credential column exists — the file says one arrives with the first route that needs it.                                                                                           |
| Route selection          | `PaymentGatewayService.routesFor` / `offer` / `methodIsOffered`; `domain/gateway-selection.ts` | Pure, descriptor-driven. `externalRoutes()` already exists and answers `[]`; the pre-invoice already draws a `g:` "pay with gateway" button when an external route allows the purchase, and the `PAY_GATEWAY` intent answers `bot.payment.unconfigured`.                                                                                                                                                                                                                             |
| Payment attempt          | `payments`; `contracts/payment.ts`                                                             | One row per attempt. States PENDING/CONFIRMED/FAILED/CANCELLED/EXPIRED/UNKNOWN; methods WALLET/MANUAL_TRANSFER/GATEWAY. `GATEWAY` is refused by `assertMethodAvailable`. `external_reference` has no writer. `expires_at` is the attempt's own deadline. Every edge is a conditional UPDATE naming `PENDING`. `payments_order_confirmed_key` allows one CONFIRMED payment per order. `gateway_provider` and `topup_cashback_percent` are snapshotted at creation and frozen by 0114. |
| Order settlement         | `PaymentService.confirmAndSettle` (private)                                                    | Conditional confirm, order lock, customer lock, fulfilment/commercial planning, the automatic undeliverable refund to the wallet, `PaymentConfirmed` / `OrderSettled` in the outbox. `onIneligible` is `REFUSE` for a wallet debit and `REFUND` for money that already moved.                                                                                                                                                                                                        |
| Wallet top-up settlement | `PaymentService.confirmAndCredit` (private)                                                    | Conditional confirm, `TOPUP_RECEIPT` credit under `<paymentId>:topup`, the gift `CASHBACK_TOPUP` under `<paymentId>:topup-cashback` from the payment's snapshot, `WalletEntryRecorded`, `WALLET_TOPUP_CREDITED` / `WALLET_TOPUP_GIFT_CREDITED`. Once-only by partial unique indexes on the ledger.                                                                                                                                                                                   |
| Top-up gift              | `payment_gateways.topup_cashback_percent`, snapshotted onto the payment                        | Per route; any future route inherits the column.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Web Admin gateways       | `payment-gateways.controller.ts`, `pages/payment-gateways.tsx`                                 | List, configure, enable/disable. No credential field.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Telegram top-up          | `WalletTopupFlowService` (typed amount → route chooser `tp:<capture>.<provider>`)              | `choose` always calls `requestWalletTopupTyped`, which issues a MANUAL_TRANSFER.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Expiry                   | `PaymentExpiryService` (worker, 60 s)                                                          | Expires every PENDING payment at `expires_at` (except a receipted manual transfer), then the orders whose deadline passed and that have no PENDING payment. Sends `PAYMENT_EXPIRED`.                                                                                                                                                                                                                                                                                                 |
| Reconciliation           | none                                                                                           | `UNKNOWN` and the `RECONCILE_*` edges have no producer. There is no gateway queue or worker (`OQ-WP10-01`).                                                                                                                                                                                                                                                                                                                                                                          |
| Outbox / idempotency     | `OutboxWriter`, `IdempotencyStore` + `rememberOnce`                                            | Events in the business transaction; customer commands keyed per surface namespace.                                                                                                                                                                                                                                                                                                                                                                                                   |
| HTTP callbacks           | `TelegramWebhookController`                                                                    | The one public inbound route. Rules: authenticate before parsing ids; answer unknown/stopped the same way; a small body limit; **no handler dials a payment gateway or a panel inline**. Caddy proxies only `/api/*`, `/health/*` and `/telegram/webhook/*`.                                                                                                                                                                                                                         |
| Secrets                  | Secret Envelope v2 (`SecretCipher`), `SECRET_PURPOSES`, `secret-registry.ts`                   | AEAD-bound to `(purpose, tenant, entity)`. Every `*_ciphertext` column must be registered, and every purpose must have a producer (unit test). Panels hold the pattern: projections select a set-at timestamp and never a ciphertext, and never a masked stand-in.                                                                                                                                                                                                                   |
| Customer notifications   | `customer_notifications`, closed kinds, no payload                                             | A fact about an entity, rendered from one frozen template. Credit sentences read their figure from the payment's own ledger entry (`PAYMENT_CREDIT_FIGURES`), one reason per kind.                                                                                                                                                                                                                                                                                                   |
| Operational log          | `OperationalEventRecorder`, codes declared beside the producer                                 | Deduped conditions an operator acts on.                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Three things in the existing code would have been wrong for an external route, and are
fixed in this package:

1. `ensureDefaults` creates every catalogue route `ACTIVE`. A route that needs a
   credential must start `DISABLED`, and enabling it must require the credential.
2. `offer` (the preset top-up) takes the first eligible route whatever it settles by,
   and `requestWalletTopupTyped` accepts any offered provider. Both issue a
   MANUAL_TRANSFER, so an external route sorted first would have produced a card-to-card
   top-up snapshotting the external route's name and gift. Both are narrowed to routes
   that settle by manual transfer.
3. `PAYMENT_CREDIT_FIGURES` reads the top-up sentence's figure from `TOPUP_RECEIPT`
   only. A gateway top-up credits `TOPUP_GATEWAY` (below), so the sentence would have
   been spent unsent.

## 2. A — documented TonPays behaviour

- Base URL `https://tonpays.online`. Authentication `X-API-Key: <key>`.
- `POST /api/v1/invoices/create` with `amount` (int, **Toman**, required), `order_id`
  (string, required, unique, **at most 20**), `callback_url` (optional), `buyer_chat_id`
  (int, optional). Response 201: `invoice_id`, `order_id`, `request_amount`,
  `final_amount`, `status`, `invoice_url`, `web_invoice_url`, `callback_url`.
- Links: without a buyer id only `invoice_url`; with one, `invoice_url` and
  `web_invoice_url`.
- `GET /api/v1/invoices/check/{invoice_id}` or `POST /api/v1/invoices/check`
  `{ "invoice_id": … }`. Response: `invoice_id`, `order_id`, `request_amount`,
  `final_amount`, `status`, `paid`.
- Statuses: `pending`, `processing`, `completed`, `need_action`, `rejected`, `expired`,
  `canceled`.
- A webhook is POSTed on status changes when `callback_url` was supplied, with headers
  `X-API-Key`, `X-TonPays-Delivery-Id`, `X-TonPays-Event`, `X-TonPays-Signature` and a
  body carrying `invoice_id`, `order_id`, the three amounts, `status`, `paid`,
  `delivery_id`, `event`, `occurred_at`, `api_version`.
- Errors: `{ "detail": { "code", "message" } }` with the eighteen codes listed in §6.
- Limits: 60 create/inquiry requests per minute; 120 requests per IP per minute.

## 3. B — Nexa product decisions (final for this package)

1. TonPays answers ONE question: was this payment approved. Order state, wallet rules,
   delivery, cashback, pricing, expiry and lifecycle stay Nexa's.
2. The only provider result with a business effect is `status == "completed"` AND
   `paid == true`, observed through the **inquiry** endpoint. A webhook is a hint.
3. Each attempt has a hard Nexa-owned lifetime of **70 minutes** from the creation of the
   internal attempt, with no grace. After it nothing settles automatically; a later
   provider completion is recorded for diagnostics and moves no money.
4. Amounts: the provider's `request_amount`, `final_amount` and `credit_amount` are
   stored as non-authoritative metadata and never decide approval or the credited
   figure. The amount is the payment's own frozen snapshot.
5. A failed attempt never cancels the order. A retry is a new attempt, a new provider
   `order_id` and a new invoice.
6. `buyer_chat_id` is sent when the customer's Telegram id is known.
7. The customer's primary link is `web_invoice_url`, else `invoice_url`.
8. Order payment and wallet top-up both; the top-up gift applies exactly once.
9. Tenant-scoped configuration: enable/disable, API key (never returned), the existing
   route settings. The callback URL is generated, never typed.
10. No refund, no cancel, no fee, no sandbox, no force-success.

**The 70-minute lifetime and the owner's one-hour ceiling.** `PAYMENT_WINDOW_MINUTES_MAX`
(60) bounds `sales.payment_window_minutes`, the window of a MANUAL transfer. The TonPays
lifetime is a different, fixed rule the owner stated for this gateway in this package, so
it is its own constant (`TONPAYS_ATTEMPT_LIFETIME_MINUTES`) and does not read or widen
the setting.

## 4. C — undocumented behaviour deliberately NOT invented

| Gap                                                                  | What Nexa does instead                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How to verify `X-TonPays-Signature`                                  | Never verified, never logged, never trusted. The webhook only schedules an inquiry.                                                                                                   |
| What `X-API-Key` on a webhook contains                               | Ignored and never logged.                                                                                                                                                             |
| Webhook retry schedule                                               | Nothing depends on it. A background inquiry with bounded backoff covers a lost webhook.                                                                                               |
| Refund API                                                           | None. No provider refund, no partial refund, no claim that TonPays refunded. An undeliverable order is refunded to the **wallet** by the existing one credit path, as for every rail. |
| Cancel API                                                           | None. Nexa's expiry closes the Nexa attempt; the provider invoice is not cancelled and Nexa never says it was.                                                                        |
| The meaning of `request_amount` vs `final_amount` vs `credit_amount` | Stored as metadata only.                                                                                                                                                              |
| Inquiry by `order_id`                                                | None. A create whose answer was lost cannot be looked up; see §5.4.                                                                                                                   |
| Whether `DUPLICATE_ORDER_ID` returns the existing invoice            | Not assumed: it is recorded as "an invoice may exist under this order id".                                                                                                            |
| HTTP status of each error                                            | The documented `detail.code` is what is classified; a status with no readable code is classified by status class, and an ambiguous one is UNKNOWN.                                    |
| Whether the rate limit is per key, per store or per account          | Nexa stays below 60/min per tenant across every replica (§5.7).                                                                                                                       |
| A sandbox                                                            | None configured; the production URL is the only one.                                                                                                                                  |

## 5. Design

### 5.1 Shape

```
PaymentService (the one settlement path)          Order != Payment != Wallet entry
   requestGatewayPayment / requestGatewayTopup     -> payment row PENDING, method GATEWAY
   confirmGatewayPayment                           -> confirmAndSettle / confirmAndCredit
   failGatewayPayment                              -> PENDING -> FAILED, no admin
        ^
GatewayPaymentService (orchestration, no HTTP of its own)
   worker pass: create invoices, run inquiries, apply outcomes
   webhook: locate, dedupe, schedule an inquiry
        |
ExternalGatewayAdapter port  <-- TonPaysAdapter (the only HTTP to tonpays.online)
```

Nothing TonPays-specific reaches `OrderService`, `WalletService` or the ledger. The order
and wallet code is unchanged except for the reason a gateway top-up credits under.

### 5.2 Contracts

- `PAYMENT_GATEWAY_PROVIDERS` gains `TONPAYS`, with the descriptor
  `{ settlesVia: 'GATEWAY', requiresCredentials: true }`.
- `PAYMENT_EVIDENCE_KINDS` gains `GATEWAY_INQUIRY`: "the gateway's own inquiry endpoint,
  asked server to server with this installation's credential, answered paid".
  `GATEWAY_CALLBACK` names a _verified_ callback, which this is not, and
  `RECONCILIATION` names an operator.
- `SECRET_PURPOSES` gains `payment_gateway.api_key`.
- `CUSTOMER_NOTIFICATION_KINDS` gains `GATEWAY_PAYMENT_FAILED` (subject: the payment),
  for an attempt the provider definitively did not approve.
- `contracts/gateway-invoices.ts`: the generic invoice creation states and the attempt
  view; `contracts/tonpays.ts`: the documented URL, paths, statuses, error codes, the
  20-character order id and the 70-minute lifetime.
- Templates for the customer replies and the Web Admin labels.

### 5.3 Persistence (migration 0121)

- `payment_gateway_credentials` — `id`, `(tenant_id, provider)` unique, the API key's
  ciphertext, key id and set-at. Registered in `secret-registry.ts`. No plaintext
  column; no projection selects the ciphertext.
- `gateway_invoices` — one row per GATEWAY payment: provider, the provider `order_id`
  (unique per tenant and provider), the provider `invoice_id` (unique when known), the
  creation state (`CREATING`, `CREATED`, `CREATE_FAILED`, `CREATE_UNKNOWN`), the two
  URLs, the last inquiry's status/paid/amounts, the last webhook hint, inquiry scheduling
  and leases, the outcome, and the late-completion marker. Provider columns live here and
  never on `orders`, `payments` or `wallet_entries`.
- `payment_gateway_call_budgets` — one row per tenant and provider, a one-minute window
  and a counter, taken by a conditional upsert.
- `wallet_entries`: `TOPUP_GATEWAY` requires a payment and is once per payment, the
  same two constraints `TOPUP_RECEIPT` has.
- CHECKs regenerated from the widened enums.

### 5.4 Creating an invoice

1. **The customer's tap** (Telegram, no external call — the webhook rule): one
   transaction locks the customer, refuses a blocked one, re-reads the order (or decides
   the top-up amount and route), requires the TONPAYS route to be ACTIVE for the purpose
   and the amount to be expressible in whole Toman, and writes the `payments` row
   (`GATEWAY`, `TONPAYS`, the frozen amount, `expires_at = now + 70 min`) and its
   `gateway_invoices` row (`CREATING`, a fresh `order_id`). An open attempt for the same
   order or top-up that is `CREATING` or `CREATED` and inside its deadline is handed back
   instead of creating a second one.
2. **The worker** claims the `CREATING` row, stamps `creation_sent_at` and commits, then
   calls `create` outside any transaction, and records one of:
   - **CREATED** — the invoice id, the URLs, the provider status and amounts.
     `payments.external_reference` is set to the invoice id.
   - **CREATE_FAILED** — a documented refusal (`detail.code`). The payment moves
     `PENDING → FAILED` with no administrator; a configuration code also opens an
     operational condition; the customer is told `GATEWAY_PAYMENT_FAILED`.
   - **RATE_LIMITED** — `RATE_LIMIT_EXCEEDED`: the invoice was definitely not created,
     so the same `order_id` is retried after backoff, at most three times.
   - **CREATE_UNKNOWN** — a timeout, a network error, a 5xx, an unreadable 2xx, a 429
     with no readable code, or `DUPLICATE_ORDER_ID`. Never retried and never re-keyed.
     The payment stays `PENDING` until its deadline and then expires; if a webhook
     later names this `order_id`, its `invoice_id` is inquired and adopted only if the
     inquiry returns this attempt's `order_id`.
     A claim found with `creation_sent_at` already stamped (a crashed worker) is
     `CREATE_UNKNOWN`, never re-sent.
3. `order_id` is `NX` + 18 characters of Crockford base32 from 90 random bits: 20
   characters, not derived from anything the customer typed or from any internal id.

### 5.5 Approval, settlement and the deadline

- Only the inquiry decides. `completed` + `paid === true` is APPROVED; `pending`,
  `processing`, `need_action`, and `completed` without `paid === true` are still open;
  `rejected`, `expired`, `canceled` are UNSUCCESSFUL; anything else is recorded and
  treated as open.
- APPROVED → `PaymentService.confirmGatewayPayment`, one transaction: the payment row
  `FOR UPDATE`; refused `NOT_ELIGIBLE` unless it is a PENDING `GATEWAY` payment and
  `now < expires_at`; then `confirmAndSettle` (order) or `confirmAndCredit` (top-up)
  with evidence `GATEWAY_INQUIRY`. The order's own deadline is not re-applied (the
  attempt's deadline is the stricter, owner-set rule); an undeliverable order is
  refunded to the wallet by the one credit path, because the money moved.
- A top-up credits `TOPUP_GATEWAY` under `<paymentId>:topup` and the gift
  `CASHBACK_TOPUP` from the payment's snapshot — the existing code, with the reason
  chosen by method.
- UNSUCCESSFUL → `PENDING → FAILED`, no administrator, note `tonpays:<status>`; the
  customer is told `GATEWAY_PAYMENT_FAILED`. The order is untouched.
- APPROVED after the deadline, or against a payment no longer PENDING →
  `late_completion_observed_at`, an audit row and the operational condition
  `payments.gateway_late_completion`. Nothing else.

Exactly once: the payment's conditional `PENDING → CONFIRMED`,
`payments_order_confirmed_key`, the ledger's per-payment unique indexes, and the
notification subject key. The webhook dedupe and inquiry leases only reduce work.

### 5.6 Webhook

`POST /payments/webhook/tonpays/:tenantId`, 16 KiB body limit, always answered
`{ ok: true }` once the body parses. It resolves the attempt by `(tenant, TONPAYS,
order_id)` and never globally; checks a known `invoice_id` agrees; dedupes on the
delivery id; records the hint; and moves `next_inquiry_at` to now (no sooner than 5 s
after the last inquiry). An unknown tenant, attempt or mismatch writes nothing that could
cause work. Headers other than the delivery id and event are not read. Caddy gains a
`/payments/webhook/*` route.

The URL is `<origin>/payments/webhook/tonpays/<tenantId>`, the origin taken from the
tenant's registered Telegram webhook (the one public origin the installation already
proved). No registered webhook means no `callback_url` is sent and reconciliation alone
decides.

### 5.7 Reconciliation

A `gateway-payments` loop in the `worker` role, every 3 s, with readiness like every
other loop. Inquiries run for PENDING attempts inside their deadline at 20 s, 40 s, 80 s,
160 s, then every 300 s; a webhook or the customer's "check" tap brings the next one
forward. After the deadline only a webhook-triggered diagnostic inquiry runs, at most
three per attempt, with no business effect. Every call first takes the tenant's budget:
creates up to 50 per minute, inquiries up to 40, across every replica.

### 5.8 Surfaces

- **Telegram.** The pre-invoice's existing gateway button (`g:`) requests a TonPays
  attempt; the top-up chooser dispatches on the route's descriptor. The reply is
  "preparing" with a check button until the worker has the invoice, then the invoice
  with a URL button (`web_invoice_url` else `invoice_url`), the check button and the
  main menu. Nothing says paid until the payment is CONFIRMED.
- **Web Admin.** The gateway list shows TonPays with the credential state (configured,
  set-at) and the generated callback URL; a separate form replaces the API key; enabling
  is refused without one. The payment detail shows the gateway invoice.

## 6. TonPays error mapping

| Code                                                                                                                                               | Class         | Create                                                      | Inquiry                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `MISSING_API_KEY`, `INVALID_API_KEY`, `INACTIVE_API_KEY`, `ACCOUNT_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `STORE_INACTIVE`, `ACCESS_DENIED`           | configuration | FAILED + condition; customer told the method is unavailable | backoff + condition                                |
| `RATE_LIMIT_EXCEEDED`                                                                                                                              | rate limit    | retry same `order_id`, ≤ 3                                  | backoff                                            |
| `DUPLICATE_ORDER_ID`                                                                                                                               | ambiguous     | CREATE_UNKNOWN                                              | —                                                  |
| `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `INVALID_BUYER_CHAT_ID`, `BUYER_IS_MERCHANT`, `BUYER_SUSPENDED`, `PAYER_RESERVE_FAILED`, `WEB_PAY_URL_FAILED` | invoice       | FAILED                                                      | —                                                  |
| `INVALID_CALLBACK_URL`                                                                                                                             | configuration | FAILED + condition                                          | —                                                  |
| `INVOICE_NOT_FOUND`                                                                                                                                | not found     | —                                                           | recorded, backoff; never treated as failed or paid |
| anything else with a 4xx                                                                                                                           | refused       | FAILED                                                      | backoff                                            |
| 5xx, timeout, network, unreadable                                                                                                                  | unknown       | CREATE_UNKNOWN                                              | backoff                                            |

## 7. Implementation notes

What was built, where it differs in detail from §5, and why.

### 7.1 Where things live

| Concern                                                       | Code                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Pure rules (verdict, Toman, order id, error classes, backoff) | `payments/domain/tonpays.ts`                                                                                  |
| Adapter port, invoice repository, credential store, budget    | `payments/application/gateway-invoice-ports.ts`                                                               |
| The only TonPays HTTP                                         | `payments/infrastructure/tonpays-adapter.ts` (a listed transaction-guarded sink in `check-boundaries.sh`)     |
| Attempts and settlement                                       | `PaymentService.requestGatewayPayment`, `requestGatewayTopup`, `confirmGatewayPayment`, `failGatewayPayment`  |
| Orchestration, webhook, customer reads                        | `payments/application/gateway-payment.service.ts`                                                             |
| Worker loop (3 s, health-checked)                             | `payments/application/gateway-payment-loop.ts`, `main.worker.ts`                                              |
| Route config, key, enable gate                                | `PaymentGatewayService.setCredential`, `setStatus`, `factsFor`                                                |
| Webhook route                                                 | `surfaces/gateway/webhook.controller.ts`, `deploy/caddy/routes.caddy`                                         |
| Telegram                                                      | `bot-runtime.ts`: `g:` pays, `gc:` checks; the top-up chooser dispatches in `WalletTopupFlowService.choose`   |
| Web Admin                                                     | `pages/payment-gateways.tsx` (key state, key form, callback URL), `pages/payments.tsx` (gateway invoice card) |

### 7.2 Details that differ from, or add to, §5

- **The first answer is "preparing".** The Telegram webhook rule forbids dialling a
  gateway while Telegram waits, so the tap writes the attempt and replies with a check
  button; the worker creates the invoice within seconds and the check tap shows the link.
  A check also brings the next inquiry forward (no sooner than five seconds after the
  last). No proactive "your link is ready" message is sent: the customer notification lane
  carries no buttons and no payload (ADR-0030), and a link is state, not a fact.
- **Customer sentences.** A create the provider refused (any code) is shown as
  `gateway_unavailable`; an invoice the provider did not approve is `gateway_failed` and is
  also sent as `GATEWAY_PAYMENT_FAILED` — except for configuration and rate-limit refusals,
  which are never presented as the customer's payment failing. `PAYMENT_EXPIRED` is sent by
  the existing sweep when an attempt reaches its deadline.
- **Evidence and audit.** A confirmed payment carries `GATEWAY_INQUIRY` and the note
  `tonpays:completed:paid`; a failed one has no administrator and the note
  `tonpays:<status or code>`. Audit actions: `payment.gateway_request`,
  `payment.gateway_confirm`, `payment.gateway_fail`, `gateway_invoice.created`,
  `gateway_invoice.create_failed`, `gateway_invoice.create_unknown`,
  `gateway_invoice.late_completion`, `payment_gateway.set_credential` (records only that a
  key was stored and when). Operational codes: `payments.gateway_misconfigured` /
  `payments.gateway_configured`, `payments.gateway_create_unknown`,
  `payments.gateway_late_completion`, `payments.gateway_identity_mismatch`.
- **Rate limit and budget.** A create is granted while the tenant's minute holds fewer than
  50 calls, an inquiry fewer than 40. A pass that is refused stops and the next pass (3 s)
  retries; nothing is dropped.
- **Webhook dedupe.** One `last_webhook_delivery_id` per attempt: a repeat of the last
  delivery changes nothing. The settlement's own exactly-once does not depend on it.
- **One attempt at a time.** An order (or a customer's gateway top-up) has at most one
  OPEN attempt per provider — PENDING, inside its deadline, invoice `CREATING` or `CREATED`
  — which a second tap is handed back. It is enforced under the customer's row lock, not by
  an index. A `CREATE_UNKNOWN` attempt is not open: the customer never received its link.
- **Seed and defaults.** A route that needs a credential is created and seeded
  `DISABLED`. `offer()` (the preset top-up) and `requestWalletTopupTyped` only ever use a
  route that settles by manual transfer.
- **Callback origin.** The origin is the tenant's ACTIVE bot's registered Telegram webhook
  URL, https only.

### 7.3 Known limits, stated rather than hidden

- **Not yet proven against the real provider** (`OQ-WP10-01`, `CLAUDE.md`'s provider
  rule). Every test uses a fake written from the documentation.
- **A closed attempt can still be paid at TonPays.** Nexa has no cancel API to call. Late
  money is recorded (`LATE_COMPLETION`) and never settled automatically (`OQ-WP11A-03`).
- **Migration number.** The unmerged WP10G branch also adds a `0121`, with an earlier
  journal `when`. Whichever of the two merges second must be renumbered and re-stamped
  with the current time, or the migrator's watermark will skip it
  (`nexa-migrations` skill).

### 7.4 Targeted tests

- `tests/unit/tonpays-adapter.test.ts` — request shape and headers, key never in any
  outcome, link preference and https-only links, outcome classes, every status's verdict,
  order id, Toman, budget and backoff.
- `tests/integration/tonpays-gateway.test.ts` — the whole lane against PostgreSQL and the
  container's own services, including the brief's §24 list.
- `tests/integration/tonpays-http.test.ts` — the Web Admin key route, the enable gate and
  the webhook route's answers.
- `tests/web/payment-gateways.test.tsx` — the key's state and the write-only form.
