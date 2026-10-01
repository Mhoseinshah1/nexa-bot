# TonPays Telegram gateway (`TONPAYS_TELEGRAM`): read-only audit and design

This is a READ-ONLY audit. It changes no code, no migration and no contract. It records what
exists on `main`, what a second TonPays route needs on top of it, and who builds which part.
Implementation starts only after PR #133 (Round T T1) has merged and `main`'s exact head is
green; it has its own branch, its own migration, its own independent reviewer and exactly one
Codex review. Nothing here goes into PR #133.

- **Audited `main`:** `25e717a2072a8190764c0ed01ba9c1cf64a0243b` (PR #132 merged).
- **Product authority:** the owner's brief of 2026-10-01 (D1–D5) and the owner's own
  transcription, inside it, of the TonPays Telegram API screenshot. **The screenshot image
  itself is not in this repository** and was not seen by this audit; every provider fact
  below is the transcription's, and nothing is added to it. What it does not say is marked
  UNKNOWN (§13) and never resolved by guessing.
- **Existing evidence used:** `CLAUDE.md` (the three TonPays rules, the four money rules),
  `docs/conventions.md`, `docs/tonpays-gateway-audit.md` (WP11A, the website route) and
  `docs/tonpays-falsification.md` (TP-01..TP-20).

The document keeps the WP11A separation:

- **A — documented** (the owner's transcription of the screenshot, nothing more);
- **B — Nexa decisions** (the brief's D1–D4, and proposals here marked _proposed_ that the
  implementation round must confirm);
- **C — undocumented**, which is listed and not invented.

## 1. Executive summary

1. **Reuse almost everything.** `TONPAYS_TELEGRAM` is a second `settlesVia: 'GATEWAY'`,
   `approval: 'INQUIRY'`, `invoiceCredential: 'GATEWAY_KEY'` route. The payment row, the
   `gateway_invoices` row, the worker lane, the per-tenant budget, the encrypted credential
   store, the inquiry-only approval, the 70-minute deadline under the payment's lock, the
   late-completion record, the one settlement path, the fee and top-up-gift snapshots and
   the webhook route all apply unchanged.
2. **What is new is three things the website route never had:** a payee card shown in
   Telegram instead of a link, a card change, and a receipt the customer sends to the
   PROVIDER. All three are provider calls, so — by the rule in
   `apps/api/src/surfaces/telegram/webhook.controller.ts:34-38` — none of them may be made
   while Telegram waits. Each becomes a ROW written by the customer's tap and a call made by
   the gateway worker, exactly as the invoice create already is.
3. **`ExternalGatewayAdapter` can represent it cleanly** with one optional field on the
   `CREATED` outcome and one capability sub-interface with two methods (§5). Inquiry and
   webhook parsing need no port change.
4. **Three places infer "an invoice is a link unless it is a Stars bot invoice" from
   `invoiceCredential`** (§3.2). They must be re-expressed against a new descriptor field
   before a third invoice form exists, or a card invoice is recorded as
   `nexa.no_payment_link`, never handed back as open, and drawn as `gateway_no_link`.
5. **The manual-transfer receipt workflow must not be touched** (§3.4):
   `payment_receipts` rows feed the operator review queue AND exempt a payment from expiry
   (`noReceiptFiled()`, `drizzle-payment.repository.ts:746-750`), so filing a provider receipt
   there would both queue it for a Nexa reviewer and suspend the 70-minute deadline.
6. **Persistence:** one migration, next after 0156 at implementation time: the widened
   provider CHECK on five tables, latest-card columns and a Telegram snapshot CHECK on
   `gateway_invoices`, and four new tables (card history, card-change requests, receipt
   capture windows, receipt submissions). No column on `orders`, `payments` or
   `wallet_entries`. No balance. No receipt bytes, ever.

## 2. The provider, as documented (A)

From the owner's transcription only.

| Concern        | Documented                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL, auth | `https://tonpays.online`; `X-API-Key: <Custom Telegram Gateway key from the store panel>`.                                                                                                                                                                      |
| Create         | `POST /api/custom/v1/invoices/telegram/create`: `amount` int **required** (Toman), `order_id` string **required**, unique, max 20, `buyer_chat_id` int **required**, `callback_url` optional.                                                                   |
| Create 201     | `invoice_id`, `order_id`, `request_amount`, `final_amount`, `status`, `callback_url`, `card_number`, `card_name`. Not a web-invoice-link flow: **no invoice URL**.                                                                                              |
| Inquiry        | `GET /api/custom/v1/invoices/check/{invoice_id}`: invoice and order ids, request and final amounts, `status`, `paid`. Only `status === "completed" && paid === true` approves.                                                                                  |
| Change card    | `POST /api/custom/v1/invoices/{invoice_id}/change-card`. Engine: 60 s cooldown, excludes cards already used, eventually exhausts. Response: new card info, `show_change_card`, `change_card_cooldown_seconds`, `change_card_exhausted`. Provider authoritative. |
| Receipt        | `POST /api/custom/v1/invoices/{invoice_id}/receipt`, `multipart/form-data`, field `file`, required, image, max 5 MB. Success may be `status: "processing"`, `paid: false`, `receipt_received: true` — which is NOT approval.                                    |
| Statuses       | `pending` در انتظار پرداخت; `processing` در انتظار تأیید; `completed` تأیید شده; `need_action` نیاز به اقدام; `rejected` رد شده; `expired` منقضی; `canceled` لغو.                                                                                               |
| Webhook        | Headers `X-API-Key` (the same Custom Telegram key), `X-TonPays-Delivery-Id`, `X-TonPays-Signature`, `X-TonPays-Event`. Body: invoice and order ids, request/final/credit amounts, `status`, `paid`, `delivery_id`, `event`, `occurred_at`, `api_version`.       |
| Errors         | `WRONG_API_KEY_KIND`, `GATEWAY_NOT_APPROVED`, `MISSING_API_KEY`, `INVALID_API_KEY`, `DUPLICATE_ORDER_ID`, `INVALID_RECEIPT_TYPE`, `RECEIPT_TOO_LARGE`, `RATE_LIMIT_EXCEEDED`, `INVOICE_NOT_FOUND`. `WRONG_API_KEY_KIND` means the two key kinds differ.         |

Differences from the website route that matter to the code (website: `contracts/src/tonpays.ts`):

- a different path family (`/api/custom/v1/...` against `/api/v1/...`, `tonpays.ts:15-17`);
- the inquiry is a **GET with the invoice id in the PATH**; the website adapter's `call` is
  POST-with-JSON only (`tonpays-adapter.ts:456-461`) and deliberately keeps the id in a body
  (`:383`). A provider-supplied id placed in a URL path is a new injection surface (§9.2);
- `buyer_chat_id` is **required** (website: optional and omitted when unknown,
  `gateway-payment.service.ts:384-385`);
- the create answer carries card instructions and no link;
- the error vocabulary is different: four codes here are not in `TONPAYS_ERROR_CODES`
  (`tonpays.ts:41-60`): `WRONG_API_KEY_KIND`, `GATEWAY_NOT_APPROVED`, `INVALID_RECEIPT_TYPE`,
  `RECEIPT_TOO_LARGE`;
- no rate limit is stated for the custom API (the website's 60/min is documented,
  `tonpays.ts:88`).

## 3. What exists (the audit), with evidence

### 3.1 Components and their verdict

| Component                      | Evidence                                                                                                                                                                                                                                                                                                                               | Verdict for `TONPAYS_TELEGRAM`                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider roster                | `packages/contracts/src/payment-gateways.ts:80` `['MANUAL_TRANSFER','TONPAYS','TELEGRAM_STARS']`; `:82` zod enum                                                                                                                                                                                                                       | Grows by one member. Contract change, own commit.                                                                                              |
| Descriptors                    | `payment-gateways.ts:100-163`: `settlesVia`, `requiresCredentials`, `invoiceCredential`, `approval`, `conversion`                                                                                                                                                                                                                      | New entry `{ GATEWAY, true, GATEWAY_KEY, INQUIRY, SAME_UNIT }` plus the new fields in §5.3.                                                    |
| Provider CHECKs                | `schema.ts:3910` (`payments.gateway_provider`), `:4130` (`gateway_invoices`), `:4416` (`payment_gateways`), `:4525` (`payment_gateway_credentials`), `:4559` (`payment_gateway_call_budgets`); precedent `apps/api/drizzle/0127_package_a_telegram_stars.sql:7-28`                                                                     | All five regenerate from the widened enum in one migration, Stars' shape.                                                                      |
| Tests pinning the roster       | `tests/unit/gateway-eligibility.test.ts:176`, `tests/unit/gateway-selector.test.ts:22,51`                                                                                                                                                                                                                                              | Updated in the contracts commit.                                                                                                               |
| Route row provisioning         | `drizzle-payment-gateway.repository.ts:166-211` `ensureDefaults` (conflict-ignoring insert, credential routes start `DISABLED`); called at boot, `apps/api/src/bootstrap.ts:116`                                                                                                                                                       | Reused unchanged: the row appears `DISABLED` on the first boot of the release. No SQL insert needed (Stars' precedent, 0127 inserts none).     |
| Encrypted credential           | `payment_gateway_credentials` `schema.ts:4499-4532`, unique `(tenant, provider)`, FK to the route; store `drizzle-gateway-credentials.ts:28-142`, AEAD purpose `payment_gateway.api_key` bound to the row id (`:77-80`, `:108-112`); registry `secret-registry.ts:255-256`                                                             | Reused unchanged. A second provider value IS a second, independent row and ciphertext. Nothing copies a key between routes (§6).               |
| Credential write + enable gate | `PaymentGatewayService.setCredential` `payment-gateway.service.ts:230-289`; enable refused without key `:500-512`; `factsFor` `:203-215` (set-at + generated callback URL, never the key)                                                                                                                                              | Reused unchanged; driven by `requiresCredentials`.                                                                                             |
| Payment attempt                | `PaymentService.requestGatewayPayment` `payment.service.ts:3213-3297`, `requestGatewayTopup` `:3299-3391`, `gatewayRouteFor` `:3584-3640`, `openGatewayAttempt` `:3716-3923`                                                                                                                                                           | Reused. Needs the descriptor-driven bot binding and buyer-chat requirement (§5.3); `findOpenAttempt`'s link predicate generalised.             |
| Fee snapshot                   | `gatewayCustomerFeeMinor` `payment-gateways.ts:296-306`; snapshotted `payment.service.ts:3776-3800`; frozen by 0124                                                                                                                                                                                                                    | Reused unchanged. `sent_amount` = payable (principal + fee) in Toman.                                                                          |
| Top-up gift snapshot           | `payments.topup_cashback_percent`, `requestGatewayTopup` passes `route.gateway.topupCashbackPercent` (`payment.service.ts:3380`), credited once in `confirmAndCredit` (`:2245`, reason `TOPUP_GATEWAY` at `:2324`)                                                                                                                     | Reused unchanged.                                                                                                                              |
| Toman amount                   | `tomanAmountOf` `domain/tonpays.ts:57-67` (IRT as is; IRR only when divisible by 10; else refuse)                                                                                                                                                                                                                                      | Reused unchanged.                                                                                                                              |
| Provider order id              | `tonpaysOrderId` `domain/tonpays.ts:86-104`: `NX` + 18 Crockford chars = 20                                                                                                                                                                                                                                                            | Reused with a distinct prefix (_proposed_ `NT`), still exactly 20 (§13 U-1).                                                                   |
| Invoice persistence            | `gateway_invoices` `schema.ts:3957-4170`: unique `(tenant, provider, provider_order_id)` `:4108-4112`, `(tenant, provider, provider_invoice_id)` `:4113-4115`; `bot_instance_id` `:4018`; snapshot guard trigger `0127:35-57`; Stars CHECK `:4152-4155`                                                                                | Reused; gains latest-card columns and a `TONPAYS_TELEGRAM` snapshot CHECK (§7).                                                                |
| Port                           | `ExternalGatewayAdapter` `gateway-invoice-ports.ts:132-169`; outcomes `:85-130`; repository `:237-486`; credential store `:492-505`; budget `:511-518`                                                                                                                                                                                 | Extended minimally (§5).                                                                                                                       |
| Website adapter                | `infrastructure/tonpays-adapter.ts` (the only TonPays HTTP; listed sink `scripts/check-boundaries.sh:647-653`); bounded body read `:527-554`; error-code-only diagnostics `:156-258`; `redirect: 'error'` `:483`; 5xx is UNKNOWN before any code is read `:351`                                                                        | NOT edited for the new route. Its pure helpers are factored or re-used; a SEPARATE adapter file speaks the custom API (§5.4).                  |
| Orchestration                  | `GatewayPaymentService` `gateway-payment.service.ts:202-1229`: create lane `:325-552`, inquiry lane `:554-738`, `settleApproved` `:744-788`, webhook `:928-1017`, check tap `:1048-1068`, late completion `:1116-1183`                                                                                                                 | Reused. Gains two lanes (card change, receipt upload) on the same claim/stamp/call/record shape.                                               |
| Worker loop                    | `gateway-payment-loop.ts`, started `main.worker.ts:214-216`                                                                                                                                                                                                                                                                            | Reused; the new lanes run inside `runOnce`.                                                                                                    |
| Call budget                    | `payment_gateway_call_budgets` `schema.ts:4542-4563`; `DrizzleGatewayCallBudget.take` `drizzle-gateway-credentials.ts:151-177` (one conditional upsert per call)                                                                                                                                                                       | Reused; see §9.5 for which row the new route charges.                                                                                          |
| Settlement                     | `PaymentService.confirmGatewayPayment` `payment.service.ts:3393-3484`: payment `FOR UPDATE`, `PENDING` + `GATEWAY` + `now < expires_at` under the lock (`:3434-3441`), evidence by descriptor (`:3449-3459`), `confirmAndCredit` / `confirmAndSettle`; `failGatewayPayment` `:3497-3577`                                               | Reused unchanged. TonPays Telegram never settles directly.                                                                                     |
| Expiry                         | `PaymentExpiryService` (worker, 60 s); `PaymentRepository.expireDue` `drizzle-payment.repository.ts:507-570` with `noReceiptFiled()` `:746-750`                                                                                                                                                                                        | Reused unchanged, PROVIDED provider receipts never enter `payment_receipts` (§3.4).                                                            |
| Late completion                | `GATEWAY_INVOICE_OUTCOMES` `contracts/src/gateway-invoices.ts:104-110`; `lateCompletion` `gateway-payment.service.ts:1116-1183` (audit, `payments.gateway_late_completion`, `PaymentLateCompletionObserved`)                                                                                                                           | Reused unchanged.                                                                                                                              |
| Webhook route                  | `surfaces/gateway/webhook.controller.ts:54-82`, `POST /payments/webhook/:provider/:tenantId`; provider segment is a lower-cased member with `settlesVia === 'GATEWAY'` (`:86-90`); 16 KiB body limit `:18`, applied `bootstrap.ts:198-199`; Caddy `deploy/caddy/routes.caddy:71-74`; path generator `gateway-payment.service.ts:80-98` | Reused unchanged: the route serves `/payments/webhook/tonpays_telegram/<tenant>` with no edit. §9.3.                                           |
| Telegram gateway UX            | `g:`/`gc:`/`gp:` `bot-runtime.ts:785-801`; `pm:` selector; `gatewayPayment` `:14240-14287`; `gatewayCheck` `:14294-14307`; `gatewayAttemptScreen` `:15363-15480`; top-up chooser `tp:<capture>.<provider>` `:1078`, `:11519`, dispatched in `WalletTopupFlowService.choose` (`wallet-topup-flow.service.ts:291-294`)                   | Selection and check reused. The screen gains a card-transfer branch; two new callbacks (§8).                                                   |
| Edit-in-place                  | `WizardInvoiceScreens` `surfaces/telegram/wizard-invoice-screens.ts:51-114` (one conditional `moveAll` per origin, 429 moved back, UNKNOWN left moved); steps `contracts/src/telegram-wizards.ts:49-63`                                                                                                                                | Reused unchanged for every card/receipt state change. No new wizard step is needed (§8.1).                                                     |
| Media download                 | `infrastructure/telegram/fetch-file.ts:54-68` (`getFile` then `/file/bot<token>/<path>`, path validated, `redirect: 'error'`, bound enforced while streaming `:154-161`, `:197+`); bound is `PAYMENT_RECEIPT_MAX_BYTES` = 20 MiB (`contracts/src/payment-receipts.ts:227`); bot binding `telegram-receipt-files.ts:27-31,53-81`        | Reused with a caller-supplied `maxBytes` (5 MB) — the one change outside the payments module. Bot token from the ROW's bot, never the request. |
| Inbound photo parsing          | `receiptFileOf` `bot-runtime.ts:3400-3448` (PHOTO largest size, DOCUMENT); routed as `RECEIPT_UPLOAD` `:3179-3181`; handler `:9909-9923` (ticket window first, then manual `submitReceipt`)                                                                                                                                            | Parser reused. Handler gains one branch BEFORE the manual receipt (§8.3).                                                                      |
| Manual receipt workflow        | `receipt_captures` `schema.ts:4834-4893`; `ReceiptService.submit` `receipt.service.ts:190+`; review queue `:455-480`; `payment_receipts`                                                                                                                                                                                               | **Not reused** (§3.4).                                                                                                                         |
| Web Admin gateways             | `surfaces/web/payment-gateways.controller.ts:54-235` (list/update/status/credential; credential state is set-at + callback URL `:203-235`); `apps/web/src/pages/payment-gateways.tsx` (`nameOf` `:136-146`, key form `:292-429`, `:694-703`, callback cell `:1011-1014`)                                                               | Reused; exhaustive switches gain a case; no new endpoint.                                                                                      |
| Web Admin payment detail       | `apps/web/src/pages/payments.tsx:252` (provider label), gateway invoice card; `gatewayInvoiceViewSchema` `contracts/src/gateway-invoices.ts:126-182`                                                                                                                                                                                   | View gains card / card-change / receipt-submission facts (§10).                                                                                |
| Customer route name            | `CustomerScreenComposer.routeName` `messaging/application/customer-screens.ts:384-390`; `ROUTE_NAME_KEYS` `:160-165`                                                                                                                                                                                                                   | One key added (§4).                                                                                                                            |
| Tenant / bot isolation         | Every repository method takes `TenantContext` and `requireTenantId`; webhook resolves within the URL's tenant only (`gateway-payment.service.ts:942-956`); `findOpenAttempt` matches `bot_instance_id` (`drizzle-gateway-invoice.repository.ts:735-737`); `receipt_captures_open_key` per `(tenant, bot, customer)`                    | Reused, and the new tables carry the same keys (§7).                                                                                           |
| Operational codes              | `gateway-payment.service.ts:41-58`                                                                                                                                                                                                                                                                                                     | Reused; two new codes declared beside their producer (§9.4).                                                                                   |

### 3.2 Three inferences that break on a third invoice form

The code decides "this provider's invoice is a link" as "its credential is not a bot token".
That was true while the only two external routes were a link (TonPays) and a bot-sent invoice
(Stars). A card-transfer invoice is neither:

| Site                                                                        | Code                                                                                            | What a card invoice would get                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `gateway-payment.service.ts:424-428`                                        | `unpayable = CREATED && invoiceCredential !== 'BOT_TOKEN' && no webInvoiceUrl && no invoiceUrl` | Every create recorded with `creation_error_code = nexa.no_payment_link` and logged as "produced no payable invoice".          |
| `payment.service.ts:3761` → `drizzle-gateway-invoice.repository.ts:728-734` | `requireLink: invoiceCredential !== 'BOT_TOKEN'`                                                | A created card invoice is never "open", so every tap opens a SECOND attempt and a second provider invoice for the same order. |
| `bot-runtime.ts:15452-15458`                                                | `link = webInvoiceUrl ?? invoiceUrl`; `CREATED && link === null → gateway_no_link`              | The customer is told the invoice has no link, and is never shown the card.                                                    |

Two more sites bind behaviour to `BOT_TOKEN` that the Telegram route needs too:
`payment.service.ts:3623` (route offered only inside a bot) and `:3751` (the attempt records
its bot). Both must read a descriptor field (§5.3), not the credential kind.

### 3.3 The 70-minute deadline and `LATE_COMPLETION` are unchanged

`TONPAYS_ATTEMPT_LIFETIME_MINUTES = 70` (`contracts/src/tonpays.ts:101`) is the adapter's
`attemptLifetimeMs` (`tonpays-adapter.ts:263`), written as `expires_at` at
`payment.service.ts:3843`, and checked under the payment's lock at `:3434-3441`. The Telegram
adapter declares the same lifetime. A receipt the provider is still reviewing at minute 70
does NOT extend it: an approval after the deadline is `LATE_COMPLETION` and settles nothing.
That is the existing rule, it is deliberate, and it has a product consequence the owner should
see before implementation (§13 U-9).

### 3.4 Why the manual receipt workflow is not reused for provider receipts

The brief says different domains; the code shows it would also be wrong:

- `ReceiptService.submit` files a `payment_receipts` row and is reached by
  `RECEIPT_REVIEW` pushes and `reviewItem` (`receipt.service.ts:455-480`), i.e. a Nexa
  operator's queue whose approval settles the payment. A provider receipt there is a second
  approver for a payment whose only approver is TonPays' inquiry.
- `noReceiptFiled()` (`drizzle-payment.repository.ts:746-750`) exempts any PENDING payment
  with a `payment_receipts` row from expiry. A provider receipt filed there would suspend the
  hard 70-minute deadline indefinitely.
- `receipt_captures` (`schema.ts:4834-4893`) writes `payment_receipts` and nothing else; its
  close reasons (`RECEIPT_CAPTURE_CLOSE_REASONS`, `payment-receipts.ts:80`) and 20 MiB bound
  belong to that domain.

So the Telegram route gets its own capture window and its own submission rows (§7), and the
only shared pieces are the PARSER (`receiptFileOf`) and the bounded DOWNLOADER
(`telegramFetchFile`).

## 4. Product identity and the default visible name (D1)

How a route's visible name is decided today:

1. `payment_gateways.display_name` — the tenant's own name; `NULL` means "the product's own
   name" (`contracts/src/payment-gateways.ts:197-205`, `schema.ts:4313-4321`).
2. Else the template `bot.payment.route_name_<provider>` (`customer-screens.ts:384-390`),
   whose default text is the catalogue entry `packages/i18n/src/catalogue.fa.ts:1099`
   (`'تون‌پیز (TonPays)'`) and which a tenant may override per locale in
   `template_overrides` (`schema.ts:1227-1245`).
3. The Web Admin's own label for a NULL name, `web.payment_gateway_provider_tonpays`
   (`apps/web/src/i18n/web.fa.ts:1752`, used at `payment-gateways.tsx:141-142` and
   `payments.tsx:252`).

To change the website route's DEFAULT visible name to «درگاه پرداخت تون پی وبسایت» without
touching any tenant's custom name or the persisted identity:

- change the catalogue VALUE at `packages/i18n/src/catalogue.fa.ts:1099` and the web label at
  `apps/web/src/i18n/web.fa.ts:1752`. Nothing else;
- do NOT rename the provider value `TONPAYS`, the template key `bot.payment.route_name_tonpays`
  or `web.payment_gateway_provider_tonpays` — the key is the contract, the text is not;
- a tenant whose `display_name` is set keeps it (step 1 wins); a tenant with a
  `template_overrides` row for the key keeps it (the override wins over the catalogue). No
  migration writes a name; the 0071 precedent forbids Persian copy in SQL
  (`payment-gateways.ts:199-203`);
- no test pins the old text (searched: only the two catalogue files contain it).

`TONPAYS_TELEGRAM` gets `bot.payment.route_name_tonpays_telegram` («درگاه پرداخت تون پی
تلگرام») and `web.payment_gateway_provider_tonpays_telegram`. Adding a template key is a
contract change (`packages/contracts/src/templates.ts`), so it belongs to the contracts commit.
The descriptions in `apps/web/src/i18n/templates.fa.ts:1197-1200` should say "website" for the
existing key.

## 5. The adapter port

### 5.1 Verdict

`ExternalGatewayAdapter` (`gateway-invoice-ports.ts:132-169`) **can represent the Telegram
route cleanly** with the smallest extension below, and without making either existing adapter
implement anything new:

- `createInvoice` already takes `buyerChatId` and `callbackUrl` (`:51-64`). The Telegram
  adapter refuses locally (`REFUSED`, `nexa.buyer_chat_id_missing`, not configuration) when
  `buyerChatId` is null — but §5.3 makes that unreachable by refusing the attempt earlier.
- `inquire` and `parseWebhook` are unchanged: the inquiry answer has the same fields and the
  same verdict (`tonpaysVerdict`, `domain/tonpays.ts:35-46`); the webhook body has the same
  documented fields the existing schema reads (`tonpays-adapter.ts:132-138`).
- What does not fit is a card in the create answer, and two invoice-scoped calls.

### 5.2 Smallest port extension

1. **`GatewayCreateOutcome` `CREATED` gains `instructions: GatewayCardInstructions | null`**
   (`{ cardNumber: string; cardName: string | null }`), null for every existing adapter.
   Additive to a union member; the two existing adapters return `null`.
2. **A capability sub-interface, resolved by descriptor and never by `instanceof`:**

   ```ts
   interface CardTransferGatewayAdapter extends ExternalGatewayAdapter {
     changeCard(apiKey: string, invoiceId: string): Promise<GatewayCardChangeOutcome>;
     uploadReceipt(
       apiKey: string,
       invoiceId: string,
       file: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; fileName: string },
     ): Promise<GatewayReceiptOutcome>;
   }
   ```

   with outcomes in the same five-way vocabulary the create already uses:

   - `GatewayCardChangeOutcome` = `CHANGED { instructions, showChangeCard, cooldownSeconds,
exhausted }` | `REFUSED { code, configuration }` | `RATE_LIMITED { code }` |
     `NOT_FOUND { code }` | `UNKNOWN { code }`;
   - `GatewayReceiptOutcome` = `ACCEPTED { status, paid, receiptReceived }` |
     `REFUSED { code, configuration }` | `RATE_LIMITED { code }` | `NOT_FOUND { code }` |
     `UNKNOWN { code }`. `ACCEPTED` carries `paid` as metadata only and never reaches
     settlement; it schedules an inquiry.

3. The container's `gatewayAdapters` resolver (`container.ts:2214-2215`) gains the third
   adapter; a second resolver `cardTransferAdapter(provider)` returns the sub-interface only
   for a provider whose descriptor says `invoiceForm: 'CARD_TRANSFER'`.

### 5.3 Descriptor extension (contracts)

Three fields on `PaymentGatewayDescriptor`, each replacing an inference listed in §3.2:

| Field                 | Values                                                 | Replaces                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoiceForm`         | `'NONE' \| 'LINK' \| 'BOT_INVOICE' \| 'CARD_TRANSFER'` | the three `invoiceCredential !== 'BOT_TOKEN'` link inferences (`gateway-payment.service.ts:425`, `payment.service.ts:3761`, `bot-runtime.ts:15419,15452`)                                                                                                                                                                                                           |
| `boundToBot`          | `boolean`                                              | `payment.service.ts:3623` (offered only inside a bot) and `:3751` (attempt records its bot)                                                                                                                                                                                                                                                                         |
| `requiresBuyerChatId` | `boolean`                                              | new: the attempt is refused with `PAYMENT_METHOD_UNAVAILABLE` before any row is written when the customer's `telegram_user_id` (NOT NULL text, `schema.ts:2894`) is not a safe JSON integer — the website adapter silently DROPS such a value (`tonpays-adapter.ts:306-308`), which for a required field would be a guaranteed refusal after the payment row exists |

Values: `MANUAL_TRANSFER {NONE, false, false}`, `TONPAYS {LINK, false, false}`,
`TELEGRAM_STARS {BOT_INVOICE, true, false}`, `TONPAYS_TELEGRAM {CARD_TRANSFER, true, true}`.
The existing two routes keep their behaviour exactly; a unit test pins the table.

`findOpenAttempt`'s `requireLink: boolean` becomes `payableForm: 'LINK' | 'CARD' | 'ANY'`: a
`CARD` attempt is open while `CREATING`, or `CREATED` with a current card (§7.1).

### 5.4 The Telegram adapter

A new file `payments/infrastructure/tonpays-telegram-adapter.ts`, added to `SINK_FILES` in
`scripts/check-boundaries.sh:647-653` and calling `assertOutsideTransaction`. It re-uses, by
import or by moving into a shared module in the same commit, the website adapter's bounded
reader, transport classifier, error-body reader and metadata parsers
(`tonpays-adapter.ts:84-258`, `:527-554`). It must not be a copy: two copies of the 5xx rule
(TP-14) or the streaming bound (TP-15) disagree the first time one is fixed. It needs, beyond
them: GET with no body; `multipart/form-data` (the deterministic encoder
`apps/api/src/infrastructure/telegram/multipart.ts` is the precedent and may be reused —
field name `file`); a path-segment validator for the invoice id (§9.2).

The website adapter itself is not edited.

## 6. Credential model

- **Independent.** `(tenant, TONPAYS_TELEGRAM)` is its own `payment_gateway_credentials` row,
  its own ciphertext bound to its own row id. Nothing reads one route's key for the other;
  `DrizzleGatewayCredentialStore.read` already filters by tenant AND provider
  (`drizzle-gateway-credentials.ts:67-75`). No migration, no backfill, no "copy from website"
  convenience — the brief forbids it, and an auto-copy would turn `WRONG_API_KEY_KIND` into
  the expected state.
- **Enable gate** unchanged: `setStatus` refuses `ACTIVE` without a key
  (`payment-gateway.service.ts:500-512`). Both routes may be ACTIVE at once; their
  `payment_gateways` rows, budgets, invoices and webhook URLs are separate.
- **`WRONG_API_KEY_KIND`** is classified **CONFIGURATION** (§11): the attempt is FAILED with
  `notifyCustomer: false`, the customer is told the method is unavailable, and
  `payments.gateway_misconfigured` opens with `reason: WRONG_API_KEY_KIND` under the dedupe key
  `payments.gateway_misconfigured:TONPAYS_TELEGRAM` (`gateway-payment.service.ts:1185-1199`), so
  the operator sees which route holds the wrong kind. _Proposed, owner decision:_ also add
  `WRONG_API_KEY_KIND` to the WEBSITE route's configuration codes — today an operator who
  pastes the Telegram key into the website route gets an undocumented code, classified
  `REFUSED` non-configuration (`domain/tonpays.ts:129-143`), so the customer is told their
  payment FAILED and no operator condition opens. That is a behaviour change to the website
  route and must be its own decision; it is not required for the Telegram route.
- The webhook's `X-API-Key` header carries the Custom Telegram key. It is **never read and
  never logged**, as today (`webhook.controller.ts:31-38`). Comparing it against the stored
  key would be a secret-dependent branch on an unauthenticated route for no gain: the URL
  already names the route (§9.3), and a webhook decides nothing.

## 7. Persistence additions

All tenant-scoped, all with composite FKs `(tenant_id, payment_id) → payments`, all CHECKs
generated from contract enums. No provider column on `orders`, `payments` or `wallet_entries`;
no balance column; no receipt bytes and no image hash.

### 7.1 `gateway_invoices` (columns + CHECK)

- `card_number text`, `card_name text`, `card_seq integer`, `card_received_at timestamptz` —
  the CURRENT card, latest state, the same "the row holds what the customer pays through"
  precedent as `invoice_url` (`schema.ts:3988-3989`). Bounded by CHECK (lengths only; the
  format is UNKNOWN, §13 U-6). Never projected into a log or an audit `after`.
- `card_change_shown boolean`, `card_change_cooldown_until timestamptz`,
  `card_change_exhausted boolean` — what the provider last said (authoritative).
- `gateway_invoices_tonpays_telegram_check`: `provider <> 'TONPAYS_TELEGRAM' OR
(bot_instance_id IS NOT NULL AND provider_unit = 'IRT' AND conversion_policy = 'SAME_UNIT')`
  — the Stars CHECK's shape (`schema.ts:4152-4155`). `bot_instance_id` is already frozen by
  `nexa_gateway_invoices_snapshot_guard` (`0127:35-57`).
- `(card_seq IS NULL) = (card_number IS NULL)`; `card_number IS NULL OR provider =
'TONPAYS_TELEGRAM'`.

### 7.2 `gateway_invoice_cards` (append-only history)

`(tenant_id, payment_id, seq)` PK; `card_number`, `card_name`, `source` (`CREATE` |
`CHANGE_CARD`), `received_at`. An append-only guard trigger (UPDATE/DELETE refused). Why: a
dispute ("I paid the card you showed me") is answerable only if every card shown is kept;
the latest-state columns alone would overwrite it.

### 7.3 `gateway_card_changes` (request rows)

`id`, `tenant_id`, `payment_id`, `bot_instance_id`, `customer_id`, `state` (`REQUESTED`,
`SENT`, `APPLIED`, `REFUSED`, `RATE_LIMITED`, `UNKNOWN`), `requested_at`, `claimed_until`,
`sent_at`, `decided_at`, `error_code`, `idempotency_key`. Partial unique index: at most ONE
row per payment in `REQUESTED` or `SENT`. Every transition a conditional UPDATE naming its
`from` states. `sent_at` stamped and committed before the call.

### 7.4 `gateway_receipt_captures` (the payment-scoped capture window)

`id`, `tenant_id`, `bot_instance_id`, `customer_id`, `payment_id`, `provider`
(CHECK = `TONPAYS_TELEGRAM`), `provider_invoice_id`, `opened_at`, `expires_at`, `closed_at`,
`close_reason` (`RECEIVED`, `SUPERSEDED`, `EXPIRED`, `PAYMENT_CLOSED`). Bound to exactly the
six things the brief names: tenant, BotInstance, customer, payment, provider, invoice.

- `gateway_receipt_captures_open_key`: one open window per `(tenant, bot, customer)`, partial
  on `closed_at IS NULL` — `receipt_captures_open_key`'s rule (`schema.ts:4874-4876`);
- `expires_at > opened_at` and `expires_at <= ` the payment's `expires_at` (enforced in the
  service under the payment's lock; _proposed_ window 10 minutes, capped at the deadline);
- opening one, under the customer lock, closes the customer's open MANUAL `receipt_captures`
  window in the same bot as `SUPERSEDED`, and opening a manual window closes this one. One
  photo, one meaning. That cross-close is the only touch on the manual workflow, and it is in
  the SERVICE that opens the window, never in `ReceiptService`.

### 7.5 `gateway_receipt_submissions`

`id`, `tenant_id`, `payment_id`, `provider_invoice_id`, `bot_instance_id`, `customer_id`,
`capture_id`, `telegram_file_id`, `telegram_file_unique_id`, `declared_size`, `state`
(`QUEUED`, `SENDING`, `ACCEPTED`, `REFUSED`, `UNKNOWN`, `ABANDONED`), `attempts`,
`claimed_until`, `sent_at`, `retry_at`, `decided_at`, `error_code`, `provider_status`,
`receipt_received`, `byte_length`, `created_at`.

- unique `(tenant_id, payment_id, telegram_file_unique_id)`: the same photo is one submission;
- partial unique: at most ONE row per payment in `QUEUED` or `SENDING`;
- partial unique: at most ONE row per payment in `UNKNOWN` that is not superseded by a later
  inquiry (§9.1);
- `byte_length` is a count, never content. No bytes, no hash, no caption.

### 7.6 Migration plan

One migration, **the next number after 0156 at implementation time** (PR #133 owns 0156; if
another round merges first, regenerate the number and the snapshot chain at integration, as
WP11A did for 0122 — `docs/tonpays-gateway-audit.md` §7.3, the `nexa-migrations` skill):

1. drop and re-add the five provider CHECKs (`0127:7-28` shape) with `TONPAYS_TELEGRAM`;
2. `gateway_invoices` columns and CHECKs (§7.1);
3. the four tables (§7.2-§7.5) with their indexes, CHECKs and the card-history append-only
   trigger;
4. no data writes, no Persian text, no backfill. Additive: the previous release reads a
   `TONPAYS_TELEGRAM` row as a provider with no adapter and offers nothing (Stars' rollback
   note, `0127:1-6`). `botctl rollback` never restores the database (CLAUDE.md).

`pnpm db:check` after generation; `schema.ts` and the migration in one commit.

## 8. Telegram interaction and capture model (D3)

### 8.1 Screens (edit in place)

The attempt's message is the one wizard message `WizardInvoiceScreens` already moves and edits
(`wizard-invoice-screens.ts:71-114`); every state change below calls `refresh` after its
commit, as the create lane does (`gateway-payment.service.ts:294-304`). Steps reused:
`INVOICE_LOADING` → `INVOICE_PENDING` → `INVOICE` → `NOTICE`/`CLOSED`. No new wizard step,
so no change to `TELEGRAM_WIZARD_STEPS`.

`gatewayAttemptScreen` (`bot-runtime.ts:15363`) gains one branch for `invoiceForm ===
'CARD_TRANSFER'` and `CREATED` with a current card:

- body: route name, the PAYABLE from the payment's own snapshot (principal, fee, payable as
  today `:15464-15480`), the provider's `final_amount` when it is present and differs,
  labelled as the amount TonPays asks to be transferred (§12), `card_number`, `card_name`,
  the deadline, and the provider status as a hint (pending/processing/need_action wording)
  — never "paid" unless `payment.state === 'CONFIRMED'`;
- buttons: «📤 ارسال فیش واریزی» (`gr:<paymentId>`), «🔄 تعویض کارت» (`gk:<paymentId>`, drawn
  only while `card_change_shown` is not false, not exhausted, and the cooldown has passed),
  «🔎 بررسی وضعیت» (the existing `gc:<paymentId>`), main menu.

Callback data: `gr:` and `gk:` are unused (all current prefixes are listed at
`bot-runtime.ts:766-2382`, grepped; neither shadows `g:`/`gc:`/`gp:`); each is 3 + 36 bytes, under
Telegram's 64. Each names the PAYMENT only — an identifier, never an amount or a card — and
is re-decided against the row: owner, method `GATEWAY`, provider `TONPAYS_TELEGRAM`, state
`PENDING`, inside the deadline, invoice `CREATED`, the bot equal to the invoice's
`bot_instance_id`. Anything else answers `bot.payment.gateway_closed`.

### 8.2 Card change

`gk:` writes a `gateway_card_changes` row `REQUESTED` (refused locally while one is in
flight, while the provider's cooldown runs, or once exhausted) and edits the screen to
"changing card…". The worker claims it, takes the budget, stamps `sent_at`, calls
`changeCard`, and records: `APPLIED` (new card appended to history and made current; cooldown,
show and exhausted copied from the answer), `REFUSED`, `RATE_LIMITED` or `UNKNOWN` (§9.1).
The screen is refreshed after each.

### 8.3 Receipt capture

- `gr:` opens a `gateway_receipt_captures` window (§7.4) and answers a prompt (image only,
  at most 5 MB). It is refused while a submission is `QUEUED`/`SENDING`, while an `UNKNOWN`
  one is unresolved (§9.1), once the provider status is `processing` or terminal, and after
  the deadline.
- The `RECEIPT_UPLOAD` handler (`bot-runtime.ts:9909-9923`) gains one branch AFTER the ticket
  window check and BEFORE `submitReceipt`: an open gateway window for `(tenant,
input.botInstanceId, customer)` takes the file. A window in another bot is invisible by the
  key. The window's payment, invoice and provider come from the ROW, never from the update.
- Accepted: a `PHOTO` only. A `DOCUMENT` (even `image/*`), a video, a PDF or anything else is
  answered with a template asking for a photo; nothing is stored. Declared `file_size` over
  5 MB is refused at once. Telegram re-encodes photos to JPEG; the worker still sniffs the
  magic bytes after download and refuses anything not JPEG/PNG (§13 U-7).
- The turn writes a `gateway_receipt_submissions` row `QUEUED` and closes the window
  `RECEIVED`, under the payment's row lock; the answer is "sending to TonPays…". No download
  and no upload happen in the turn.
- The worker claims the row, downloads with the INVOICE's bot token
  (`TelegramReceiptFiles.download`, `telegram-receipt-files.ts:53-81`) bounded at 5 MB while
  streaming, takes the budget, stamps `sent_at`, uploads, drops the bytes, records the
  outcome, schedules an inquiry, and refreshes the screen.
- Never the manual review queue, never `payment_receipts`, never `receipt_captures`. No bytes,
  file id, caption, card number or key in a log line, an audit row or an operational context;
  audit rows carry the submission id, state and error code.
- Windows expire by a sweep (the `receipt_captures` precedent) and are closed
  `PAYMENT_CLOSED` when the payment leaves `PENDING`.

## 9. Ambiguity, retries, webhook and inquiry

### 9.1 Ambiguity and retry, per call

| Call        | Answer lost (timeout, network, 5xx, unreadable 2xx, 4xx without a code)                                                                                                                                                                                                                                                                                 | `RATE_LIMIT_EXCEEDED` (4xx)                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create      | `CREATE_UNKNOWN`, never retried, never re-keyed (existing rule, `gateway-payment.service.ts:328-336`, `:531-551`). The customer is not shown a card; a new tap opens a NEW attempt with a NEW order id. A later webhook naming this order id is inquired and adopted only if the inquiry returns this order id (TP-05).                                 | Same order id, deferred, at most `TONPAYS_CREATE_MAX_ATTEMPTS` (existing, `:500-519`).                                                                  |
| Inquiry     | Backoff; nothing decided (existing).                                                                                                                                                                                                                                                                                                                    | Backoff ≥ 60 s (existing, `:628-633`).                                                                                                                  |
| Change card | `UNKNOWN`. Never re-sent automatically. The current card is HIDDEN (the provider may have retired it, and the inquiry does not return card data), the screen says the card could not be confirmed and offers receipt upload and check. The customer may tap change again once the local 60 s cooldown has passed: a new, explicit request, not a retry. | Not applied; the row is `RATE_LIMITED`, the current card stays, and the customer may tap again. No automatic retry.                                     |
| Receipt     | `UNKNOWN`. **Never re-uploaded blindly** — the provider documents no receipt idempotency. The next inquiry is brought forward; a later inquiry status `processing` (or terminal) resolves it as received; while it stays `pending` the customer may send a DIFFERENT photo explicitly (§13 U-8). The same `file_unique_id` is never sent twice.         | Definitely not processed: `QUEUED` again with `retry_at`, the same bytes re-downloaded, bounded (3), then `ABANDONED` and the customer asked to resend. |

A row claimed with `sent_at` already stamped is UNKNOWN and never re-sent — the existing
create rule (TP-03) applied to all three new calls. Only a readable 4xx
`RATE_LIMIT_EXCEEDED` clears a stamp; a 5xx is UNKNOWN before its body is read (TP-14).

### 9.2 Inquiry

Unchanged in meaning: `completed` AND `paid === true` (the JSON boolean) is the only approval,
judged by `tonpaysVerdict`; the inquiry's own `order_id` and `invoice_id` must equal the
attempt's (`gateway-payment.service.ts:662-685`); `APPROVED` goes to
`confirmGatewayPayment`, which re-checks the deadline under the payment's lock. A receipt
answer's `paid` and `receipt_received` are metadata. `processing` and `need_action` stay
OPEN. New: the invoice id is a provider-supplied string placed in a URL PATH. The adapter
refuses (`FAILED`, `nexa.invoice_id_unsafe`, never sent) any id outside
`^[A-Za-z0-9_-]{1,64}$` and encodes it with `encodeURIComponent` anyway; the same applies to
`change-card` and `receipt`.

### 9.3 Webhook: which route it belongs to

Both routes receive the same header and body shape, so the shape cannot tell them apart. The
URL does, by construction:

- the callback URL is generated per provider (`gatewayWebhookPath`,
  `gateway-payment.service.ts:80-82`): `/payments/webhook/tonpays/<tenant>` for the website,
  `/payments/webhook/tonpays_telegram/<tenant>` for Telegram. The controller maps the segment
  to a closed enum member (`webhook.controller.ts:86-90`) with no edit needed;
- the attempt is looked up by `(tenant, provider, order_id)` (`:952`), so a body posted to the
  wrong route's URL is `IGNORED_UNKNOWN` and writes nothing; a matching order id with another
  invoice id is `IGNORED_MISMATCH` (TP-06);
- the distinct order-id prefix (`NT`, _proposed_) makes a misrouted body recognisable to an
  operator, and nothing depends on it;
- the webhook still decides nothing: it records a hint and brings the inquiry forward
  (TP-06/07); `X-TonPays-Signature` is not verified (undocumented algorithm), and
  `X-API-Key` is not read.

### 9.4 Operational codes and audit actions

Reused: `payments.gateway_misconfigured`/`_configured`, `_create_unknown`,
`_late_completion`, `_identity_mismatch`. New, declared beside the producer, part of the
schema once shipped: `payments.gateway_receipt_unknown` and
`payments.gateway_card_change_unknown` (per payment). New audit actions:
`gateway_invoice.card_change_requested|applied|refused|unknown`,
`gateway_receipt.queued|accepted|refused|unknown|abandoned`.

### 9.5 Call budget

The custom API's rate limit is UNDOCUMENTED (§13 U-10). `payment_gateway_call_budgets` is
keyed `(tenant, provider)`. _Proposed:_ every TonPays Telegram call (create, inquiry, change
card, receipt) takes the budget with an inquiry share and a create floor as today, and the
adapter declares conservative figures (e.g. 25 total, 15 background) so that the two TonPays
routes together stay under the website's documented 60/min if the provider counts per account.
Receipt and change-card are customer-initiated and take the create floor's side.

## 10. Web Admin

- **Gateways page:** a fourth row; `nameOf` (`payment-gateways.tsx:136-146`) and
  `payments.tsx:252` gain a case (exhaustive switches; the compiler finds them); the key form,
  enable gate and generated callback URL are reused unchanged via `requiresCredentials`. The
  form says the key is the "Custom Telegram Gateway" key and differs from the website key.
- **Payment detail:** `gatewayInvoiceViewSchema` (`contracts/src/gateway-invoices.ts:126-182`)
  gains the current card's sequence and received-at (not the number — the payment detail is an
  operator diagnosis view; the card list is a separate permissioned read, _proposed_
  `payments.view`), card-change state, and the receipt submissions' states and codes.
  `final_amount` is already shown as provider metadata.
- No new endpoint; no write action for an operator on card or receipt (TonPays decides).

## 11. Error classification — the nine documented codes

| Code                   | Class           | Create                                      | Inquiry                                     | Change card                               | Receipt                                                      | Customer told                                    |
| ---------------------- | --------------- | ------------------------------------------- | ------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `WRONG_API_KEY_KIND`   | configuration   | FAILED, `notifyCustomer: false`, condition  | backoff + condition                         | `REFUSED`, condition                      | `REFUSED`, condition; may resend after the fix               | method unavailable — never "your payment failed" |
| `GATEWAY_NOT_APPROVED` | configuration   | as above                                    | as above                                    | as above                                  | as above                                                     | method unavailable                               |
| `MISSING_API_KEY`      | configuration   | as above                                    | as above                                    | as above                                  | as above                                                     | method unavailable                               |
| `INVALID_API_KEY`      | configuration   | as above                                    | as above                                    | as above                                  | as above                                                     | method unavailable                               |
| `DUPLICATE_ORDER_ID`   | ambiguous       | `CREATE_UNKNOWN`, never retried or re-keyed | — (not expected; `FAILED`, backoff)         | —                                         | —                                                            | the invoice could not be confirmed; choose again |
| `INVALID_RECEIPT_TYPE` | receipt refused | —                                           | —                                           | —                                         | `REFUSED`; the window may be reopened                        | send a photo of the receipt                      |
| `RECEIPT_TOO_LARGE`    | receipt refused | —                                           | —                                           | —                                         | `REFUSED` (should be unreachable after the local 5 MB bound) | send a smaller photo                             |
| `RATE_LIMIT_EXCEEDED`  | rate limit      | defer, same order id, ≤ 3 (only on a 4xx)   | backoff ≥ 60 s                              | not applied; customer may tap again       | re-queued, same file, ≤ 3, then `ABANDONED`                  | try again shortly — never a payment failure      |
| `INVOICE_NOT_FOUND`    | not found       | —                                           | recorded, backoff; never paid, never failed | `NOT_FOUND`, recorded, identity condition | `NOT_FOUND`, recorded, identity condition                    | check status; nothing else changes               |

Rules carried over unchanged: a 5xx is UNKNOWN whatever its body says; a 4xx without a
readable `detail.code` is UNKNOWN on a create/change/receipt and `FAILED` (backoff) on an
inquiry; an undocumented code is `REFUSED`, stored bounded and verbatim
(`tonpays-adapter.ts:156-158`). The four codes absent from `TONPAYS_ERROR_CODES` go into a
new `TONPAYS_TELEGRAM_ERROR_CODES` with their own configuration subset — the website's list
is documentation of the website API and is not widened silently.

## 12. Financial invariants (D4)

- TonPays Telegram code never settles: adapter → `GatewayPaymentService` →
  `PaymentService.confirmGatewayPayment` (`payment.service.ts:3393`), the one settlement
  path, with evidence `GATEWAY_INQUIRY` (`:3449-3459`). No new settlement method.
- The credited/settled amount is the payment's frozen `amount`; the fee and gift are the
  payment's snapshots. `request_amount`, `final_amount`, `credit_amount` are stored as
  provider metadata on `gateway_invoices` and NEVER rewrite principal, fee snapshot, order
  total, credited principal or refund ceiling. Held by construction today: no provider amount
  reaches `confirmGatewayPayment` (`docs/tonpays-falsification.md`, "held by construction");
  the implementation adds a test that a CHANGED `final_amount` changes nothing that settles.
- `final_amount` IS shown to the customer as the provider's transfer instruction (brief D4).
  If it exceeds the payable, the difference is not a Nexa fee and is never credited; if it is
  lower, Nexa still credits only the principal. Display only (§13 U-3).
- Exactly once: the conditional `PENDING → CONFIRMED`, `payments_order_confirmed_key`, the
  ledger's per-payment indexes, `recordOutcome` once. Card change and receipt rows cannot
  reach any of them.
- Undeliverable order after approval: refunded to the wallet by `refundUndeliverable` (the
  existing one credit path; the money moved). No provider refund call exists or is invented.
- Coexistence: two routes, two `payment_gateways` rows, two credential rows, two webhook
  paths, attempts keyed `(tenant, provider, order_id)`, `findOpenAttempt` per provider. An
  order may have one open attempt per provider; settlement's
  `payments_order_confirmed_key` keeps it to one CONFIRMED payment whichever route wins, and
  the loser's later approval is `LATE_COMPLETION`/`ORDER_NOT_AWAITING_PAYMENT`, settling
  nothing — the existing behaviour for the website route and Stars.

## 13. API behaviour NOT supported by the supplied documentation (C)

Each is UNKNOWN and must not be resolved by guessing. _Proposed_ `docs/open-questions.md`
entries (this audit may not edit that file; the implementation's contracts commit adds them):

| Id         | Unknown                                                                                                                                                     | What Nexa does meanwhile                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-TPTG-01 | Whether `order_id` uniqueness is shared with the website API (one namespace per account?) and its allowed charset.                                          | 20 chars, `NT` + 18 Crockford, 90 random bits: fits max 20 and Nexa's own `length 1..64` CHECK (`schema.ts:4157-4160`); collision is negligible.                         |
| OQ-TPTG-02 | Amount unit and rounding beyond "int, Toman"; minimum/maximum amounts (no `AMOUNT_TOO_LOW/HIGH` is listed for this API).                                    | `tomanAmountOf` exactly; IRR not divisible by 10 refused, never rounded. An undocumented refusal is `REFUSED`.                                                           |
| OQ-TPTG-03 | Meaning of `request_amount` vs `final_amount` vs `credit_amount`, and whether `final_amount` can change after a card change.                                | Metadata only; shown as the provider's transfer figure; latest observed value displayed; never settles.                                                                  |
| OQ-TPTG-04 | The webhook signature algorithm.                                                                                                                            | Not verified, not read, not logged. Hint only.                                                                                                                           |
| OQ-TPTG-05 | Webhook retry schedule, event names, and whether a card change or receipt emits one.                                                                        | Nothing depends on it; background inquiries cover a lost webhook.                                                                                                        |
| OQ-TPTG-06 | `card_number`/`card_name` format (16-digit PAN? IBAN? masked?) and whether either can be null.                                                              | Stored as bounded strings; a `CREATED` answer with no `card_number` is a created invoice with no instructions — shown as such, never open (`no_link` analogue).          |
| OQ-TPTG-07 | Accepted image types for `receipt` beyond "image".                                                                                                          | Photos only; JPEG/PNG by magic bytes.                                                                                                                                    |
| OQ-TPTG-08 | Receipt idempotency; how many receipts per invoice; whether a second upload replaces or adds; whether `need_action` asks for a new receipt.                 | No blind re-upload; one in flight; an `UNKNOWN` blocks new uploads until an inquiry answers; `need_action` shown as a hint only.                                         |
| OQ-TPTG-09 | Whether change-card or receipt is accepted on a non-`pending` invoice; error codes for a change during cooldown or after exhaustion.                        | Offered only while PENDING in Nexa and last-known provider status `pending`; an undocumented refusal changes nothing.                                                    |
| OQ-TPTG-10 | The custom API's rate limit, and whether it is per key, store or account (shared with the website key?).                                                    | Conservative per-route budget (§9.5).                                                                                                                                    |
| OQ-TPTG-11 | The provider invoice's own expiry, and whether a receipt under review at Nexa's 70-minute deadline is still approved later.                                 | Nexa's 70 minutes stands; a later approval is `LATE_COMPLETION`, recorded, nothing moves. Owner should confirm this is acceptable for a review-based flow.               |
| OQ-TPTG-12 | `buyer_chat_id` semantics: must the buyer have started a TonPays bot? Does it relate to the bot the customer is talking to when a tenant runs several bots? | Sent as `customers.telegram_user_id` (NOT NULL, unique per tenant, `schema.ts:2894`, `:2944`), which is the same id in every bot. The attempt is still bound to its bot. |
| OQ-TPTG-13 | Whether `DUPLICATE_ORDER_ID` returns the existing invoice; whether an inquiry by `order_id` exists for this API.                                            | Not assumed; `CREATE_UNKNOWN`.                                                                                                                                           |
| OQ-TPTG-14 | HTTP status per error code; whether error bodies keep the website's `{ detail: { code } }` shape.                                                           | Same reader; a status with no readable code is classified by class; ambiguous is UNKNOWN.                                                                                |
| OQ-TPTG-15 | Whether `X-API-Key` on the webhook is the merchant key verbatim (a secret sent to Nexa's public endpoint on every delivery).                                | Never read, never logged; Caddy and API access logs must not log request headers (verify in the deploy config at implementation).                                        |
| OQ-TPTG-16 | Sandbox or test mode.                                                                                                                                       | None assumed. Acceptance needs the real provider (`OQ-WP10-01`); every automated test uses a fake written from the transcription.                                        |

## 14. Package and file ownership for implementation

Sequential where marked; no two agents edit one file concurrently. Every phase works in its
own worktree. Round T's files are avoided entirely: the bot-menu builder module, `main-menu.ts`,
the send-message reply keyboards and the bot-buttons page are NOT touched. Shared files that
PR #133 also edits — `schema.ts`, `container.ts`, `contracts/src/errors.ts` (if a code is
needed), `contracts/src/index.ts`, `apps/web/src/api/client.ts`, `drizzle/meta/_journal.json`,
`docs/open-questions.md`, `tests/integration/harness.ts`,
`scripts/check-falsification-citations.mjs` — are edited only AFTER #133 merges, by the single
owner named below for each.

| Phase | Owner (agent)       | Files (exclusive while the phase runs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on                              |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P0    | Contracts           | `packages/contracts/src/payment-gateways.ts` (member, descriptor fields), `tonpays-telegram.ts` (new: paths, statuses, error codes, lifetime, limits), `gateway-invoices.ts` (states, view), `templates.ts` (new keys), `index.ts`; `packages/i18n/src/catalogue.fa.ts` (new keys + the website default-name VALUE); `apps/web/src/i18n/templates.fa.ts`, `web.fa.ts`; `tests/unit/gateway-eligibility.test.ts`, `gateway-selector.test.ts`; `docs/open-questions.md` (§13). ONE commit for the contract change, its own message. | #133 merged                             |
| P1    | Persistence/adapter | `schema.ts`, the new migration + snapshot + journal; `payments/infrastructure/tonpays-telegram-adapter.ts` (new), shared TonPays HTTP helpers extracted from `tonpays-adapter.ts` (behaviour-preserving); `drizzle-gateway-invoice.repository.ts`; new repositories for §7.2-§7.5; `gateway-invoice-ports.ts`; `infrastructure/telegram/fetch-file.ts` (`maxBytes` parameter, default unchanged); `scripts/check-boundaries.sh` (`SINK_FILES`); `tests/unit/tonpays-telegram-adapter.test.ts`.                                    | P0                                      |
| P2    | Orchestration       | `payment.service.ts` (descriptor-driven bot binding, buyer-chat requirement, `payableForm`), `gateway-payment.service.ts` (card fields on create, card-change and receipt lanes, codes), `gateway-payment-loop.ts`, `container.ts`; `tests/integration/tonpays-telegram-gateway.test.ts`.                                                                                                                                                                                                                                         | P1                                      |
| P3    | Telegram surface    | `surfaces/telegram/bot-runtime.ts` (`gr:`/`gk:`, `gatewayAttemptScreen` branch, `RECEIPT_UPLOAD` branch), `wizard-invoice-screens.ts` (only if needed), a new `gateway-receipt-capture.service.ts` in payments/application; `tests/unit/bot-runtime*.test.ts` additions, `tests/integration/tonpays-telegram-telegram.test.ts`.                                                                                                                                                                                                   | P2                                      |
| P4    | Web Admin           | `surfaces/web/payment-gateways.controller.ts` (view facts only), `apps/web/src/pages/payment-gateways.tsx`, `payments.tsx`, `apps/web/src/api/client.ts` (types only), `tests/web/*`; `tests/web/shots/fixtures/*` if screenshots exist for gateways.                                                                                                                                                                                                                                                                             | P0 (may run beside P3 — no shared file) |
| P5    | Docs/falsification  | `docs/tonpays-telegram-falsification.md`, `scripts/check-falsification-citations.mjs` (register it), this audit's §15 "what was built".                                                                                                                                                                                                                                                                                                                                                                                           | P2–P4                                   |

## 15. Test matrix and falsification targets

Each "TPTG" rule is reverted ALONE in a mutation worktree and the named test must die
(`CLAUDE.md`, reviewing with agents). Existing TP-01..TP-20 must stay KILLED.

| #       | Rule                                                                                                                                | Test (level)                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| TPTG-01 | Only inquiry `completed` + `paid === true` approves; a receipt answer with `paid: true` or `receipt_received: true` settles nothing | unit (verdict) + integration          |
| TPTG-02 | An approval at/after `expires_at` is `LATE_COMPLETION`, decided under the payment's lock, even with a receipt `processing`          | integration                           |
| TPTG-03 | A create with a stamped send is `CREATE_UNKNOWN` and never re-sent; `DUPLICATE_ORDER_ID` is `CREATE_UNKNOWN`                        | integration                           |
| TPTG-04 | A card-change claim with a stamped send is `UNKNOWN`, never re-sent, and hides the current card                                     | integration                           |
| TPTG-05 | A receipt claim with a stamped send is `UNKNOWN`, never re-uploaded; the same `file_unique_id` is never queued twice                | integration                           |
| TPTG-06 | Only a 4xx `RATE_LIMIT_EXCEEDED` re-queues a receipt; a 5xx with that code in its body is `UNKNOWN`                                 | unit + integration                    |
| TPTG-07 | A photo goes to the gateway window only within `(tenant, bot, customer)`; a window in bot A never takes a photo from bot B          | integration                           |
| TPTG-08 | A gateway receipt never writes `payment_receipts`, never appears in the review queue, and never exempts the payment from expiry     | integration                           |
| TPTG-09 | A `DOCUMENT`, video or >5 MB file is refused before any row is written; a download stops at 5 MB while streaming                    | unit (fetch-file bound) + integration |
| TPTG-10 | Opening a gateway window supersedes the manual window in the same bot, and vice versa                                               | integration                           |
| TPTG-11 | `final_amount` different from the payable changes neither the settled/credited amount, the fee, the gift nor the refund ceiling     | integration                           |
| TPTG-12 | A created card invoice is the open attempt (handed back); one without a card is not                                                 | integration                           |
| TPTG-13 | The website route is unchanged: a created link invoice is still open, and still `gateway_no_link` without a link                    | existing tests + one added            |
| TPTG-14 | Credentials are independent: the Telegram route cannot be enabled with only the website key stored, and never reads it              | integration (HTTP)                    |
| TPTG-15 | `WRONG_API_KEY_KIND` is configuration: FAILED without customer notification, condition opened for `TONPAYS_TELEGRAM`                | unit + integration                    |
| TPTG-16 | A webhook to `/tonpays/` naming a Telegram order id is `IGNORED_UNKNOWN`, and vice versa                                            | integration                           |
| TPTG-17 | An invoice id outside the safe charset is never placed in a URL path                                                                | unit (adapter)                        |
| TPTG-18 | The attempt is refused before any row when the customer's Telegram id is not a safe integer, or the request is not from a bot       | integration                           |
| TPTG-19 | `gr:`/`gk:` for another customer's, another bot's or a non-PENDING payment change nothing and answer `gateway_closed`               | unit (runtime) + integration          |
| TPTG-20 | Change card is refused locally while one is in flight, during the provider's cooldown, and once exhausted                           | integration                           |
| TPTG-21 | No key, card number, file id, caption or byte reaches a log line, audit row or operational context                                  | unit (spy logger) + integration       |
| TPTG-22 | Every new lane gives back unreached leases when the budget runs out (TP-16/17 for the new lanes)                                    | integration                           |
| TPTG-23 | The website route's default name changed and a tenant's `display_name` and template override still win                              | unit (composer) + web test            |

Commands: `pnpm verify`, `pnpm db:check`, `pnpm test:integration` (serialised or on its own
database — CLAUDE.md), and the Telegram/web suites. A real-provider acceptance remains owed
(`OQ-WP10-01`, OQ-TPTG-16) and no capability is claimed as accepted before it.

## 16. What this audit did not do

It read code and documents only. It ran no test, created no migration, edited no source file,
pushed nothing, and printed no secret. It did not see the screenshot.
