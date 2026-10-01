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
   store, the inquiry-only approval, the deadline checked under the payment's lock, the
   late-completion record, the one settlement path, the fee and top-up-gift snapshots and
   the webhook route all apply. The one change to their meaning is item 7.
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
   `gateway_invoices`, four new tables (card history, card-change requests, receipt
   capture windows, receipt submissions), and two provider-NEUTRAL timestamps on `payments`
   for the review window (§7.0). No column on `orders` or `wallet_entries`. No balance. No
   receipt bytes, ever.
7. **Owner decision of 2026-10-01 (resolves OQ-TPTG-11): the 70 minutes are the
   customer's window, not the final settlement cutoff once TonPays has acknowledged the
   receipt.** An acknowledgement in the receipt-upload answer, recorded under the payment's
   lock while `now < expires_at`, opens a 24-hour provider review window from that
   acknowledgement. The persisted review deadline replaces `expires_at` as the settlement
   deadline for that attempt only. The expiry sweep skips the attempt. An approval inside
   the window settles through the existing path, and a provider "no" fails it. A window
   that ends with no trustworthy answer moves the payment `PENDING → UNKNOWN`. That state,
   its edges, the `RECONCILIATION` evidence kind, the `PaymentOutcomeUnknown` event and a
   Web Admin banner already exist in the contracts, and nothing produces them today
   (§9.6.4). The two review timestamps sit on the `payments` row because the expiry
   predicate must be row-local to be race-safe (§9.6.3).

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

| Component                      | Evidence                                                                                                                                                                                                                                                                                                                               | Verdict for `TONPAYS_TELEGRAM`                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider roster                | `packages/contracts/src/payment-gateways.ts:80` `['MANUAL_TRANSFER','TONPAYS','TELEGRAM_STARS']`; `:82` zod enum                                                                                                                                                                                                                       | Grows by one member. Contract change, own commit.                                                                                                                                                                         |
| Descriptors                    | `payment-gateways.ts:100-163`: `settlesVia`, `requiresCredentials`, `invoiceCredential`, `approval`, `conversion`                                                                                                                                                                                                                      | New entry `{ GATEWAY, true, GATEWAY_KEY, INQUIRY, SAME_UNIT }` plus the new fields in §5.3.                                                                                                                               |
| Provider CHECKs                | `schema.ts:3910` (`payments.gateway_provider`), `:4130` (`gateway_invoices`), `:4416` (`payment_gateways`), `:4525` (`payment_gateway_credentials`), `:4559` (`payment_gateway_call_budgets`); precedent `apps/api/drizzle/0127_package_a_telegram_stars.sql:7-28`                                                                     | All five regenerate from the widened enum in one migration, Stars' shape.                                                                                                                                                 |
| Tests pinning the roster       | `tests/unit/gateway-eligibility.test.ts:176`, `tests/unit/gateway-selector.test.ts:22,51`                                                                                                                                                                                                                                              | Updated in the contracts commit.                                                                                                                                                                                          |
| Route row provisioning         | `drizzle-payment-gateway.repository.ts:166-211` `ensureDefaults` (conflict-ignoring insert, credential routes start `DISABLED`); called at boot, `apps/api/src/bootstrap.ts:116`                                                                                                                                                       | Reused unchanged: the row appears `DISABLED` on the first boot of the release. No SQL insert needed (Stars' precedent, 0127 inserts none).                                                                                |
| Encrypted credential           | `payment_gateway_credentials` `schema.ts:4499-4532`, unique `(tenant, provider)`, FK to the route; store `drizzle-gateway-credentials.ts:28-142`, AEAD purpose `payment_gateway.api_key` bound to the row id (`:77-80`, `:108-112`); registry `secret-registry.ts:255-256`                                                             | Reused unchanged. A second provider value IS a second, independent row and ciphertext. Nothing copies a key between routes (§6).                                                                                          |
| Credential write + enable gate | `PaymentGatewayService.setCredential` `payment-gateway.service.ts:230-289`; enable refused without key `:500-512`; `factsFor` `:203-215` (set-at + generated callback URL, never the key)                                                                                                                                              | Reused unchanged; driven by `requiresCredentials`.                                                                                                                                                                        |
| Payment attempt                | `PaymentService.requestGatewayPayment` `payment.service.ts:3213-3297`, `requestGatewayTopup` `:3299-3391`, `gatewayRouteFor` `:3584-3640`, `openGatewayAttempt` `:3716-3923`                                                                                                                                                           | Reused. Needs the descriptor-driven bot binding and buyer-chat requirement (§5.3); `findOpenAttempt`'s link predicate generalised.                                                                                        |
| Fee snapshot                   | `gatewayCustomerFeeMinor` `payment-gateways.ts:296-306`; snapshotted `payment.service.ts:3776-3800`; frozen by 0124                                                                                                                                                                                                                    | Reused unchanged. `sent_amount` = payable (principal + fee) in Toman.                                                                                                                                                     |
| Top-up gift snapshot           | `payments.topup_cashback_percent`, `requestGatewayTopup` passes `route.gateway.topupCashbackPercent` (`payment.service.ts:3380`), credited once in `confirmAndCredit` (`:2245`, reason `TOPUP_GATEWAY` at `:2324`)                                                                                                                     | Reused unchanged.                                                                                                                                                                                                         |
| Toman amount                   | `tomanAmountOf` `domain/tonpays.ts:57-67` (IRT as is; IRR only when divisible by 10; else refuse)                                                                                                                                                                                                                                      | Reused unchanged.                                                                                                                                                                                                         |
| Provider order id              | `tonpaysOrderId` `domain/tonpays.ts:86-104`: `NX` + 18 Crockford chars = 20                                                                                                                                                                                                                                                            | Reused with a distinct prefix (_proposed_ `NT`), still exactly 20 (§13 OQ-TPTG-01).                                                                                                                                       |
| Invoice persistence            | `gateway_invoices` `schema.ts:3957-4170`: unique `(tenant, provider, provider_order_id)` `:4108-4112`, `(tenant, provider, provider_invoice_id)` `:4113-4115`; `bot_instance_id` `:4018`; snapshot guard trigger `0127:35-57`; Stars CHECK `:4152-4155`                                                                                | Reused; gains latest-card columns and a `TONPAYS_TELEGRAM` snapshot CHECK (§7).                                                                                                                                           |
| Port                           | `ExternalGatewayAdapter` `gateway-invoice-ports.ts:132-169`; outcomes `:85-130`; repository `:237-486`; credential store `:492-505`; budget `:511-518`                                                                                                                                                                                 | Extended minimally (§5).                                                                                                                                                                                                  |
| Website adapter                | `infrastructure/tonpays-adapter.ts` (the only TonPays HTTP; listed sink `scripts/check-boundaries.sh:647-653`); bounded body read `:527-554`; error-code-only diagnostics `:156-258`; `redirect: 'error'` `:483`; 5xx is UNKNOWN before any code is read `:351`                                                                        | NOT edited for the new route. Its pure helpers are factored or re-used; a SEPARATE adapter file speaks the custom API (§5.4).                                                                                             |
| Orchestration                  | `GatewayPaymentService` `gateway-payment.service.ts:202-1229`: create lane `:325-552`, inquiry lane `:554-738`, `settleApproved` `:744-788`, webhook `:928-1017`, check tap `:1048-1068`, late completion `:1116-1183`                                                                                                                 | Reused. Gains two lanes (card change, receipt upload) on the same claim/stamp/call/record shape.                                                                                                                          |
| Worker loop                    | `gateway-payment-loop.ts`, started `main.worker.ts:214-216`                                                                                                                                                                                                                                                                            | Reused; the new lanes run inside `runOnce`.                                                                                                                                                                               |
| Call budget                    | `payment_gateway_call_budgets` `schema.ts:4542-4563`; `DrizzleGatewayCallBudget.take` `drizzle-gateway-credentials.ts:151-177` (one conditional upsert per call)                                                                                                                                                                       | Reused; see §9.5 for which row the new route charges.                                                                                                                                                                     |
| Settlement                     | `PaymentService.confirmGatewayPayment` `payment.service.ts:3393-3484`: payment `FOR UPDATE` (`:3412`), `PENDING` + `GATEWAY` + `now < expires_at` under the lock (`:3416-3429`), evidence by descriptor (`:3435-3447`), `confirmAndCredit` / `confirmAndSettle`; `failGatewayPayment` `:3497-3577`                                     | Reused, with one change: the deadline it compares under the lock is the attempt's EFFECTIVE deadline, the review deadline once acknowledged and `expires_at` otherwise (§9.6.3). TonPays Telegram never settles directly. |
| Expiry                         | `PaymentExpiryService` (worker, 60 s, `payment-expiry-loop.ts:43`); `PaymentRepository.expireDue` `drizzle-payment.repository.ts:507-570` with `noReceiptFiled()` `:746-750`                                                                                                                                                           | Gains ONE row-local predicate, `provider_review_until IS NULL`, in its candidate SELECT and its UPDATE (§9.6.3). `noReceiptFiled()` is untouched, PROVIDED provider receipts never enter `payment_receipts` (§3.4).       |
| Late completion                | `GATEWAY_INVOICE_OUTCOMES` `contracts/src/gateway-invoices.ts:104-110`; `lateCompletion` `gateway-payment.service.ts:1116-1183` (audit, `payments.gateway_late_completion`, `PaymentLateCompletionObserved`)                                                                                                                           | Reused unchanged; it also records an approval observed at or after the REVIEW deadline, or on an `UNKNOWN` payment (§9.6.4).                                                                                              |
| Webhook route                  | `surfaces/gateway/webhook.controller.ts:54-82`, `POST /payments/webhook/:provider/:tenantId`; provider segment is a lower-cased member with `settlesVia === 'GATEWAY'` (`:86-90`); 16 KiB body limit `:18`, applied `bootstrap.ts:198-199`; Caddy `deploy/caddy/routes.caddy:71-74`; path generator `gateway-payment.service.ts:80-98` | Reused unchanged: the route serves `/payments/webhook/tonpays_telegram/<tenant>` with no edit. §9.3.                                                                                                                      |
| Telegram gateway UX            | `g:`/`gc:`/`gp:` `bot-runtime.ts:785-801`; `pm:` selector; `gatewayPayment` `:14240-14287`; `gatewayCheck` `:14294-14307`; `gatewayAttemptScreen` `:15363-15480`; top-up chooser `tp:<capture>.<provider>` `:1078`, `:11519`, dispatched in `WalletTopupFlowService.choose` (`wallet-topup-flow.service.ts:291-294`)                   | Selection and check reused. The screen gains a card-transfer branch; two new callbacks (§8).                                                                                                                              |
| Edit-in-place                  | `WizardInvoiceScreens` `surfaces/telegram/wizard-invoice-screens.ts:51-114` (one conditional `moveAll` per origin, 429 moved back, UNKNOWN left moved); steps `contracts/src/telegram-wizards.ts:49-63`                                                                                                                                | Reused unchanged for every card/receipt state change. No new wizard step is needed (§8.1).                                                                                                                                |
| Media download                 | `infrastructure/telegram/fetch-file.ts:54-68` (`getFile` then `/file/bot<token>/<path>`, path validated, `redirect: 'error'`, bound enforced while streaming `:154-161`, `:197+`); bound is `PAYMENT_RECEIPT_MAX_BYTES` = 20 MiB (`contracts/src/payment-receipts.ts:227`); bot binding `telegram-receipt-files.ts:27-31,53-81`        | Reused with a caller-supplied `maxBytes` (5 MB) — the one change outside the payments module. Bot token from the ROW's bot, never the request.                                                                            |
| Inbound photo parsing          | `receiptFileOf` `bot-runtime.ts:3400-3448` (PHOTO largest size, DOCUMENT); routed as `RECEIPT_UPLOAD` `:3179-3181`; handler `:9909-9923` (ticket window first, then manual `submitReceipt`)                                                                                                                                            | Parser reused. Handler gains one branch BEFORE the manual receipt (§8.3).                                                                                                                                                 |
| Manual receipt workflow        | `receipt_captures` `schema.ts:4834-4893`; `ReceiptService.submit` `receipt.service.ts:190+`; review queue `:455-480`; `payment_receipts`                                                                                                                                                                                               | **Not reused** (§3.4).                                                                                                                                                                                                    |
| Web Admin gateways             | `surfaces/web/payment-gateways.controller.ts:54-235` (list/update/status/credential; credential state is set-at + callback URL `:203-235`); `apps/web/src/pages/payment-gateways.tsx` (`nameOf` `:136-146`, key form `:292-429`, `:694-703`, callback cell `:1011-1014`)                                                               | Reused; exhaustive switches gain a case; no new endpoint.                                                                                                                                                                 |
| Web Admin payment detail       | `apps/web/src/pages/payments.tsx:252` (provider label), gateway invoice card; `gatewayInvoiceViewSchema` `contracts/src/gateway-invoices.ts:126-182`                                                                                                                                                                                   | View gains card / card-change / receipt-submission facts (§10).                                                                                                                                                           |
| Customer route name            | `CustomerScreenComposer.routeName` `messaging/application/customer-screens.ts:384-390`; `ROUTE_NAME_KEYS` `:160-165`                                                                                                                                                                                                                   | One key added (§4).                                                                                                                                                                                                       |
| Tenant / bot isolation         | Every repository method takes `TenantContext` and `requireTenantId`; webhook resolves within the URL's tenant only (`gateway-payment.service.ts:942-956`); `findOpenAttempt` matches `bot_instance_id` (`drizzle-gateway-invoice.repository.ts:735-737`); `receipt_captures_open_key` per `(tenant, bot, customer)`                    | Reused, and the new tables carry the same keys (§7).                                                                                                                                                                      |
| Operational codes              | `gateway-payment.service.ts:41-58`                                                                                                                                                                                                                                                                                                     | Reused; two new codes declared beside their producer (§9.4).                                                                                                                                                              |

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

### 3.3 The 70-minute deadline today, and the owner's review window

What exists: `TONPAYS_ATTEMPT_LIFETIME_MINUTES = 70` (`contracts/src/tonpays.ts:101`) is the
adapter's `attemptLifetimeMs` (`tonpays-adapter.ts:263`), written as `expires_at` at
`payment.service.ts:3843`, and checked under the payment's lock at `:3423-3429`
(`now >= expires_at` → `NOT_ELIGIBLE`/`DEADLINE_PASSED`; a null is past). The expiry sweep
moves a `PENDING` payment past `expires_at` to `EXPIRED` (`drizzle-payment.repository.ts:507-570`).
An approval after that is `LATE_COMPLETION` and settles nothing
(`gateway-payment.service.ts:744-788`, `:1116-1183`). The same `expires_at` also drives six
ADVISORY reads: the inquiry lane's `eligible` (`:561-565`), its schedule (`nextInquiryAt`
`:899-912`), the webhook's `eligible` (`:959-962`), the check tap (`:1053-1057`),
`findOpenAttempt` (`drizzle-gateway-invoice.repository.ts:746`) and the Telegram screen
(`bot-runtime.ts:15404-15409`).

**The owner's decision of 2026-10-01 resolves OQ-TPTG-11 and changes this for
`TONPAYS_TELEGRAM` only.** The 70 minutes stay the customer's payment and
receipt-submission window. A provider acknowledgement of the receipt inside that window
opens a 24-hour provider review window, which becomes the attempt's settlement deadline. A
window that ends unresolved goes to reconciliation, never to `EXPIRED` and never to
`FAILED`. The design, its predicates and its evidence are §9.6. Every other route keeps the
rule above exactly.

### 3.4 Why the manual receipt workflow is not reused for provider receipts

The brief says different domains; the code shows it would also be wrong:

- `ReceiptService.submit` files a `payment_receipts` row and is reached by
  `RECEIPT_REVIEW` pushes and `reviewItem` (`receipt.service.ts:455-480`), i.e. a Nexa
  operator's queue whose approval settles the payment. A provider receipt there is a second
  approver for a payment whose only approver is TonPays' inquiry.
- `noReceiptFiled()` (`drizzle-payment.repository.ts:746-750`) exempts any PENDING payment
  with a `payment_receipts` row from expiry, and has no end. A provider receipt filed there
  would suspend the deadline INDEFINITELY. The owner's review window is bounded: 24 hours,
  opened only by the provider's acknowledgement, ending in reconciliation. It is therefore
  a separate, row-local predicate on `payments` scoped to the route (§9.6.3), and
  `noReceiptFiled()` keeps its meaning for manual transfers exactly.
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
`payments` gains only two provider-NEUTRAL review timestamps (§7.0); no balance column; no
receipt bytes and no image hash.

### 7.0 `payments` (the review window — owner decision, §9.6)

Two nullable columns, both provider-neutral in name and meaning: "an external gateway has
acknowledged evidence for this attempt and is reviewing it, until when". The precedent is
`checkout_held_until` (`schema.ts:3718-3726`), a gateway-only fact on the payment row for
the same reason, a row-local predicate (§9.6.3).

- `provider_review_started_at timestamptz`: the moment Nexa observed the provider's
  acknowledgement (§9.6.3 c).
- `provider_review_until timestamptz`: `provider_review_started_at + 24 h`, written in the
  SAME statement.
- `payments_provider_review_check`, generated from the contract (the window constant and
  the descriptor's `providerReview` list, §9.6.9):

  ```sql
  (provider_review_started_at IS NULL) = (provider_review_until IS NULL)
  AND (provider_review_until IS NULL OR (
        method = 'GATEWAY'
    AND gateway_provider IN ('TONPAYS_TELEGRAM')
    AND expires_at IS NOT NULL
    AND provider_review_started_at < expires_at
    AND provider_review_until = provider_review_started_at + interval '24 hours'))
  ```

  All of it is row-local, so the database itself refuses an acknowledgement at or after the
  70-minute deadline (half-open), a window of any other length, and the columns on any other
  route.

- `nexa_payments_confirmation_guard` (latest body `0124_wp18_gateway_customer_fee.sql:9+`)
  gains: once `provider_review_until` is non-null, both columns are frozen in every state,
  and they may be set only while `OLD.state = 'PENDING'`. A repeated or later
  acknowledgement can never move the deadline, whoever writes it.
- `payments_provider_review_idx` on `(tenant_id, provider_review_until)` WHERE
  `state = 'PENDING' AND provider_review_until IS NOT NULL`, shipped in the same release as
  the review sweep that reads it (the `payments_pending_expiry_idx` note,
  `schema.ts:3823-3836`).
- Nothing on `payments_resolved_check` changes: `UNKNOWN` is not a resolved state
  (`contracts/src/payment.ts:79`), so a payment whose review lapsed carries no `resolved_at`.

### 7.1 `gateway_invoices` (columns + CHECK)

- `card_number text`, `card_name text`, `card_seq integer`, `card_received_at timestamptz` —
  the CURRENT card, latest state, the same "the row holds what the customer pays through"
  precedent as `invoice_url` (`schema.ts:3988-3989`). Bounded by CHECK (lengths only; the
  format is UNKNOWN, §13 OQ-TPTG-06). Never projected into a log or an audit `after`.
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
`receipt_received`, `opened_review`, `byte_length`, `created_at`.

- unique `(tenant_id, payment_id, telegram_file_unique_id)`: the same photo is one submission;
- partial unique: at most ONE row per payment in `QUEUED` or `SENDING`;
- partial unique: at most ONE row per payment in `UNKNOWN` that is not superseded by a later
  inquiry (§9.1);
- partial unique: at most ONE row per payment with `opened_review = true`, the submission
  whose acknowledgement opened the review window (set in the same transaction as §7.0's
  columns, §9.6.3 c). An operator can see which photo the 24 hours run from;
- `byte_length` is a count, never content. No bytes, no hash, no caption.

### 7.6 Migration plan

One migration, **the next number after 0156 at implementation time** (PR #133 owns 0156; if
another round merges first, regenerate the number and the snapshot chain at integration, as
WP11A did for 0122 — `docs/tonpays-gateway-audit.md` §7.3, the `nexa-migrations` skill):

1. drop and re-add the five provider CHECKs (`0127:7-28` shape) with `TONPAYS_TELEGRAM`;
2. `payments`: the two review columns, `payments_provider_review_check`, the replaced
   `nexa_payments_confirmation_guard` body (0124's, plus the freeze) and
   `payments_provider_review_idx` (§7.0);
3. `gateway_invoices` columns and CHECKs (§7.1);
4. the four tables (§7.2-§7.5) with their indexes, CHECKs and the card-history append-only
   trigger;
5. no data writes, no Persian text, no backfill. Additive: the previous release reads a
   `TONPAYS_TELEGRAM` row as a provider with no adapter and offers nothing (Stars' rollback
   note, `0127:1-6`). `botctl rollback` never restores the database (CLAUDE.md). **Rollback
   note for the review window:** the previous release's `expireDue` does not know
   `provider_review_until`, so a rollback while any payment is in review expires it at its
   70-minute deadline, and a later approval is `LATE_COMPLETION`. That is recorded and
   moves nothing, but the customer is told `PAYMENT_EXPIRED` about a receipt TonPays is
   reviewing. The migration's header says so, and the rollback checklist lists
   `SELECT count(*) FROM payments WHERE state = 'PENDING' AND provider_review_until IS NOT NULL`
   as a pre-rollback read.

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
  «🔎 بررسی وضعیت» (the existing `gc:<paymentId>`), main menu. `gr:` and `gk:` are drawn
  only in the customer window (`now < expires_at`, no review started).

Two more branches, for the owner's review window (§9.6), decided BEFORE the existing
"closed" test at `bot-runtime.ts:15404-15409`. Today that test renders every payment that is
not `PENDING`, or is past `expires_at`, as `bot.payment.gateway_closed`. That would tell a
customer whose receipt TonPays is reviewing that their payment is closed:

- `PENDING` with `provider_review_until > at` renders the new screen
  `bot.payment.gateway_in_review`. It shows the route, the payable from the snapshot, that
  TonPays has received the receipt and is reviewing it, and the review deadline. The buttons
  are 🔎 (`gc:`) and the main menu, with no receipt, no card change and no retry. Paying
  again is exactly what must not be invited;
- `UNKNOWN` renders the new screen `bot.payment.gateway_review_unresolved`. It says the
  outcome is not confirmed yet, that nothing has failed, that the payment is being checked
  and that the customer should not pay again. It offers the main menu only. It is never
  `gateway_failed` and never `gateway_closed`.

Callback data: `gr:` and `gk:` are unused (all current prefixes are listed at
`bot-runtime.ts:766-2382`, grepped; neither shadows `g:`/`gc:`/`gp:`); each is 3 + 36 bytes, under
Telegram's 64. Each names the PAYMENT only — an identifier, never an amount or a card — and
is re-decided against the row: owner, method `GATEWAY`, provider `TONPAYS_TELEGRAM`, state
`PENDING`, inside the CUSTOMER window (`now < expires_at`; the review deadline never
re-opens `gr:`/`gk:`), no review started, invoice `CREATED`, the bot equal to the invoice's
`bot_instance_id`. Anything else answers `bot.payment.gateway_closed`, or re-renders the
review screen when the payment is in review.

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
  one is unresolved (§9.1), once the provider status is `processing` or terminal, once a
  review has started (§9.6), and at or after `expires_at`. The tap itself extends nothing
  (§9.6.3 c).
- The `RECEIPT_UPLOAD` handler (`bot-runtime.ts:9909-9923`) gains one branch AFTER the ticket
  window check and BEFORE `submitReceipt`: an open gateway window for `(tenant,
input.botInstanceId, customer)` takes the file. A window in another bot is invisible by the
  key. The window's payment, invoice and provider come from the ROW, never from the update.
- Accepted: a `PHOTO` only. A `DOCUMENT` (even `image/*`), a video, a PDF or anything else is
  answered with a template asking for a photo; nothing is stored. Declared `file_size` over
  5 MB is refused at once. Telegram re-encodes photos to JPEG; the worker still sniffs the
  magic bytes after download and refuses anything not JPEG/PNG (§13 OQ-TPTG-07).
- The turn writes a `gateway_receipt_submissions` row `QUEUED` and closes the window
  `RECEIVED`, under the payment's row lock; the answer is "sending to TonPays…". No download
  and no upload happen in the turn.
- The worker claims the row, downloads with the INVOICE's bot token
  (`TelegramReceiptFiles.download`, `telegram-receipt-files.ts:53-81`) bounded at 5 MB while
  streaming, takes the budget, and re-reads the payment. If it is no longer `PENDING`, or
  `now >= expires_at`, the row is `ABANDONED` with `nexa.deadline_passed` and NOTHING is
  uploaded, because a receipt sent after the window could not open a review anyway. Then it
  stamps `sent_at`, uploads, drops the bytes, records the outcome, records the
  acknowledgement when the answer is one (§9.6.3 c), schedules an inquiry, and refreshes the
  screen.
- Never the manual review queue, never `payment_receipts`, never `receipt_captures`. No bytes,
  file id, caption, card number or key in a log line, an audit row or an operational context;
  audit rows carry the submission id, state and error code.
- Windows expire by a sweep (the `receipt_captures` precedent) and are closed
  `PAYMENT_CLOSED` when the payment leaves `PENDING`.

## 9. Ambiguity, retries, webhook and inquiry

### 9.1 Ambiguity and retry, per call

| Call        | Answer lost (timeout, network, 5xx, unreadable 2xx, 4xx without a code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `RATE_LIMIT_EXCEEDED` (4xx)                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create      | `CREATE_UNKNOWN`, never retried, never re-keyed (existing rule, `gateway-payment.service.ts:328-336`, `:531-551`). The customer is not shown a card; a new tap opens a NEW attempt with a NEW order id. A later webhook naming this order id is inquired and adopted only if the inquiry returns this order id (TP-05).                                                                                                                                                                                                                               | Same order id, deferred, at most `TONPAYS_CREATE_MAX_ATTEMPTS` (existing, `:500-519`).                                                                  |
| Inquiry     | Backoff; nothing decided (existing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Backoff ≥ 60 s (existing, `:628-633`).                                                                                                                  |
| Change card | `UNKNOWN`. Never re-sent automatically. The current card is HIDDEN (the provider may have retired it, and the inquiry does not return card data), the screen says the card could not be confirmed and offers receipt upload and check. The customer may tap change again once the local 60 s cooldown has passed: a new, explicit request, not a retry.                                                                                                                                                                                               | Not applied; the row is `RATE_LIMITED`, the current card stays, and the customer may tap again. No automatic retry.                                     |
| Receipt     | `UNKNOWN`. **Never re-uploaded blindly** — the provider documents no receipt idempotency. The next inquiry is brought forward; a later inquiry status `processing` (or terminal) resolves it as received FOR DISPLAY, but **never opens the review window** (only the upload answer's acknowledgement does, §9.6.3 c), so an ambiguous upload leaves the 70-minute deadline in force; while it stays `pending` the customer may send a DIFFERENT photo explicitly, inside the window (§13 OQ-TPTG-08). The same `file_unique_id` is never sent twice. | Definitely not processed: `QUEUED` again with `retry_at`, the same bytes re-downloaded, bounded (3), then `ABANDONED` and the customer asked to resend. |

A row claimed with `sent_at` already stamped is UNKNOWN and never re-sent — the existing
create rule (TP-03) applied to all three new calls. Only a readable 4xx
`RATE_LIMIT_EXCEEDED` clears a stamp; a 5xx is UNKNOWN before its body is read (TP-14).

### 9.2 Inquiry

Unchanged in meaning: `completed` AND `paid === true` (the JSON boolean) is the only approval,
judged by `tonpaysVerdict`; the inquiry's own `order_id` and `invoice_id` must equal the
attempt's (`gateway-payment.service.ts:662-685`); `APPROVED` goes to
`confirmGatewayPayment`, which re-checks the EFFECTIVE deadline under the payment's lock
(§9.6.3 d). A receipt
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
  `X-API-Key` is not read. During a review its `eligible` reads the effective deadline
  (§9.6.5), and a webhook never opens, extends or ends a review.

### 9.4 Operational codes and audit actions

Reused: `payments.gateway_misconfigured`/`_configured`, `_create_unknown`,
`_late_completion`, `_identity_mismatch`. New, declared beside the producer, part of the
schema once shipped: `payments.gateway_receipt_unknown` and
`payments.gateway_card_change_unknown` (per payment), and for the review window
`payments.gateway_review_unresolved` (WARN, per payment) with its recovery
`payments.gateway_review_reconciled` (INFO, `recoversCode`, the `_configured` shape,
`gateway-payment.service.ts:1201-1213`) (§9.6.4). New audit actions:
`gateway_invoice.card_change_requested|applied|refused|unknown`,
`gateway_receipt.queued|accepted|refused|unknown|abandoned`, `payment.provider_review_started`,
`payment.lose_track`, `payment.reconcile_confirmed|reconcile_failed`,
`gateway_invoice.reconcile_inquiry_requested`.

### 9.5 Call budget

The custom API's rate limit is UNDOCUMENTED (§13 OQ-TPTG-10). `payment_gateway_call_budgets` is
keyed `(tenant, provider)`. _Proposed:_ every TonPays Telegram call (create, inquiry, change
card, receipt) takes the budget with an inquiry share and a create floor as today, and the
adapter declares conservative figures (e.g. 25 total, 15 background) so that the two TonPays
routes together stay under the website's documented 60/min if the provider counts per account.
Receipt and change-card are customer-initiated and take the create floor's side.

### 9.6 The provider review window (owner decision of 2026-10-01, resolves OQ-TPTG-11)

#### 9.6.1 The decision, as given

- The first 70 minutes (`expires_at`) are the customer's payment and receipt-submission
  window. With no provider-acknowledged receipt by then, the existing expiry semantics apply
  unchanged.
- A receipt that TonPays ACKNOWLEDGES before that deadline moves the attempt into a separate
  provider review window of **24 hours from the acknowledgement**. The acknowledgement is
  `receipt_received: true`, or an authoritative `processing`, in the receipt-upload answer.
- During the review window, `completed && paid === true` settles through the existing path.
  `rejected`, `expired` and `canceled` end it as terminal non-success. `pending`,
  `processing` and `need_action` leave it unresolved.
- A review window that ends with no trustworthy terminal result moves the payment to the
  existing UNKNOWN / manual-review style of reconciliation. Nothing auto-settles, and the
  payment is never called failed while the outcome is uncertain.
- A receipt uploaded after the 70-minute deadline never reopens an expired payment.
  Pressing «ارسال فیش» never extends anything. An ambiguous upload outcome never extends
  anything.
- The acknowledgement time and the review deadline are persisted, so a restart or redeploy
  cannot reset the clock. Race tests cover an acknowledgement at minute 70 and a settlement
  exactly at the review deadline.

#### 9.6.2 Lifecycle state machine

`payments.state` uses only members that already exist (`contracts/src/payment.ts:34-50`).
"In provider review" is NOT a new state. It is `PENDING` with `provider_review_until` set,
because a new `PAYMENT_STATES` member would be a contract change, and every `PENDING`
predicate in the codebase (settlement, cancel, the order's live-payment guard) is already
correct for a payment that is still awaiting the provider. Each window is half-open.

```text
PENDING · customer window      [created, expires_at)        expires_at = created + 70 min (unchanged)
  ├─ inquiry completed && paid===true, now < expires_at ──────────► CONFIRMED   (existing settlement)
  ├─ inquiry rejected|expired|canceled, now < expires_at ─────────► FAILED      (existing; GATEWAY_PAYMENT_FAILED)
  ├─ upload answer acknowledged, ack_at < expires_at,
  │  recorded under the payment's lock ───────────────────────────► PENDING · in provider review
  └─ now ≥ expires_at, no acknowledgement (expiry sweep) ─────────► EXPIRED     (existing; PAYMENT_EXPIRED)

PENDING · in provider review   [ack_at, review_until)       review_until = ack_at + 24 h, write-once
  ├─ inquiry completed && paid===true, now < review_until ────────► CONFIRMED   (same path, same lock)
  ├─ inquiry rejected|expired|canceled, now < review_until ───────► FAILED      (same path; GATEWAY_PAYMENT_FAILED)
  ├─ pending | processing | need_action | completed without paid
  │  | an undocumented status | an inquiry error ──────────────────► stays
  ├─ expiry sweep ────────────────────────────────────────────────► never (row-local exclusion)
  ├─ customer cancel / wallet purchase / a new attempt ───────────► refused (§9.6.3 f)
  └─ now ≥ review_until (review sweep, LOSE_TRACK) ───────────────► UNKNOWN

UNKNOWN (contract: non-terminal, "terminal until reconciled", payment.ts:45-50, :121-125)
  ├─ a later inquiry approval ─────────────────────────────────────► recorded LATE_COMPLETION; nothing moves
  ├─ a later inquiry rejected|expired|canceled ───────────────────► recorded as evidence; nothing moves
  ├─ operator RECONCILE_CONFIRMED, recorded completed+paid ───────► CONFIRMED   (one settlement path)
  └─ operator RECONCILE_FAILED, recorded provider "no" ───────────► FAILED

EXPIRED, FAILED, CONFIRMED: terminal and frozen (nexa_payments_confirmation_guard, 0124:9+).
An acknowledgement that arrives at or after expires_at is recorded on the submission and
opens nothing.
```

The provider statuses during the review, through the existing pure verdict
`tonpaysVerdict` (`domain/tonpays.ts:35-46`), unchanged:

| Provider (inquiry)                                | Verdict        | In review, `now < review_until`                                                     | At/after `review_until` (payment `UNKNOWN`)               |
| ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `completed` + `paid === true`                     | `APPROVED`     | `confirmGatewayPayment` → `SETTLED`                                                 | `LATE_COMPLETION` (`PAYMENT_NOT_PENDING`), nothing moves  |
| `rejected` / `expired` / `canceled`               | `UNSUCCESSFUL` | `failGatewayPayment`, `notifyCustomer: true` (`gateway-payment.service.ts:717-725`) | outcome recorded only (the `if (eligible)` guard, `:718`) |
| `pending` / `processing` / `need_action`          | `OPEN`         | stays; next inquiry on the review cadence (§9.6.5)                                  | stays `UNKNOWN`                                           |
| `completed` without `paid === true`, undocumented | `OPEN`         | stays                                                                               | stays `UNKNOWN`                                           |
| `INVOICE_NOT_FOUND`, 5xx, timeout                 | — (no answer)  | recorded, backoff; never paid, never failed (`:628-659`)                            | stays `UNKNOWN`                                           |

#### 9.6.3 The exact predicate changes

**(a) Where the review facts live, and why on `payments`.** The expiry sweep is
`UPDATE payments … WHERE … AND id IN (SELECT … FOR UPDATE SKIP LOCKED)`
(`drizzle-payment.repository.ts:516-566`). Under READ COMMITTED, a row that was LOCKED but
not UPDATED by a transaction that committed after the sweep statement's snapshot is locked
and returned WITHOUT re-evaluation. Every sub-select over ANOTHER table, such as a
`NOT EXISTS` over `gateway_invoices`, reads that older snapshot. The re-check after the lock
(EvalPlanQual) re-reads the target row's OWN columns, and only when that row was updated.
So an acknowledgement recorded on `gateway_invoices` that commits between the sweep's
snapshot and its lock would be invisible, and the sweep would expire a payment TonPays is
reviewing. The acknowledgement must therefore UPDATE the payment row, and the exclusion must
read that row. That is exactly the reasoning already recorded for `checkout_held_until`
("a row-local predicate, so a cancellation that waited on the approval's row lock re-reads
it", `schema.ts:3718-3726`; `notHeldAt`, `drizzle-payment.repository.ts:821-823`, used at
`:312` and `:481`). Hence §7.0.

_Finding, outside this route, not changed here:_ `noReceiptFiled()` is a cross-table
`NOT EXISTS` (`:746-750`), and `ReceiptService.submit` locks the payment but does not update
it (`receipt.service.ts:285`, `findByIdForUpdate` only). The comment at `:558-565` says the
UPDATE's re-check is "redundant today" because of the lock. By the semantics above, a
manual receipt committing inside one sweep statement's snapshot-to-lock interval would not
be seen. The interval is milliseconds, but the race is real. Proposed for the implementation
round's reviewer to confirm with a two-connection test, and to fix in its own commit if it
reproduces (for example by touching `payments.updated_at` plus a row-local flag). It is not
folded into this route.

**(b) `PaymentRepository.expireDue`.** Both the candidate SELECT and the UPDATE
(`drizzle-payment.repository.ts:520-525`, `:552-563`) gain

```ts
isNull(payments.providerReviewUntil), // row-local; §9.6.3 (a)
```

and nothing else. `noReceiptFiled()` stays exactly as it is, AND-ed beside it. Scope by
construction: `payments_provider_review_check` (§7.0) makes the column non-null only on a
`GATEWAY` payment of a provider whose descriptor has `providerReview: true`, and only
`TONPAYS_TELEGRAM` has it. A website `TONPAYS`, Stars or manual payment can never carry it,
so their expiry is unchanged. A `TONPAYS_TELEGRAM` attempt with no acknowledgement expires at
minute 70 as today. `PaymentExpiryService` itself needs no change: its audit and
`PAYMENT_EXPIRED` notification follow the rows `expireDue` returns
(`payment-expiry.service.ts:203-229`).

**(c) Recording the acknowledgement.** This is a new
`PaymentService.recordProviderReview(scope, actor, paymentId, { submissionId, acknowledgedAt })`,
called by the receipt lane after the upload answer. It runs as an authorized mutation
(`runAuthorizedMutation`, the `failGatewayPayment` shape, `payment.service.ts:3497-3577`),
as `SYSTEM_JOB`, with `assertScopeActive` inside the transaction:

1. `findByIdForUpdate` (the payment's row lock), FIRST.
2. Refuse, with no write, unless `method = 'GATEWAY'`, the descriptor has
   `providerReview`, `state = 'PENDING'`, `expires_at IS NOT NULL` and
   `acknowledgedAt < expires_at`. The interval is half-open: an acknowledgement at exactly
   minute 70 opens nothing.
3. One conditional UPDATE, naming its `from`:

   ```sql
   UPDATE payments
      SET provider_review_started_at = :ack,
          provider_review_until      = :ack + interval '24 hours',
          updated_at                 = :now
    WHERE tenant_id = :t AND id = :id
      AND state = 'PENDING'
      AND provider_review_until IS NULL
      AND expires_at > :ack
   ```

   It reports whether the row moved, and there is no setter. Zero rows on a repeated
   acknowledgement is the "never moves the deadline" rule. The guard trigger (§7.0) and the
   CHECK enforce it again for any writer that forgets.

4. In the same transaction: the submission gets `opened_review = true` (§7.5), the audit
   action `payment.provider_review_started` (ids, the two timestamps, and no file, caption or
   card), and the receipt capture window closes.

What counts as an acknowledgement is ONE pure function in the Telegram domain module,
pinned by a unit test over every outcome:
`receiptAcknowledged(outcome) = outcome.kind === 'ACCEPTED' && (outcome.receiptReceived === true || outcome.status === 'processing')`,
with `receiptReceived` read as the JSON boolean only (the `paid === true` precedent,
`domain/tonpays.ts:20-26`). Everything else is not an acknowledgement and extends nothing:
`UNKNOWN` (timeout, network, 5xx, unreadable 2xx), `REFUSED`, `RATE_LIMITED`, `NOT_FOUND`, an
`ACCEPTED` without either signal, a submission still `QUEUED`/`SENDING`, the customer's tap,
a webhook, and an INQUIRY reporting `processing` (§9.1). Whether `processing` without
`receipt_received: true` can occur is OQ-TPTG-18.

`acknowledgedAt` is the Clock read AFTER the adapter returned, which is the earliest moment
Nexa knows. It is not the send stamp (which precedes the provider's decision) and not the
commit time. The comparison with `expires_at` happens under the lock, as
`confirmGatewayPayment` does (`payment.service.ts:3402` reads `now`, `:3427` compares under
the lock). A send stamped at 69:59 whose answer returns at 70:01 opens nothing. Should a
scope stop between the answer and this transaction, nothing is written; the submission is
reclaimed with `sent_at` set, is `UNKNOWN` (§9.1), and the 70-minute rule stands. That is
the conservative failure.

**(d) `confirmGatewayPayment` reads the EFFECTIVE deadline under the lock.** One pure
function in `domain/settlement.ts`, `gatewaySettlementDeadline(payment) =
payment.providerReviewUntil ?? payment.expiresAt`, replaces the comparison at
`payment.service.ts:3427`:
`const deadline = gatewaySettlementDeadline(payment); if (deadline === null || now >= deadline) → NOT_ELIGIBLE / DEADLINE_PASSED`.
It is read from the row fetched `FOR UPDATE` at `:3412`, so the deadline and the state are
judged together, whatever the caller believed. An approval at or after `review_until` is
`DEADLINE_PASSED`, and the lane records `LATE_COMPLETION` (`gateway-payment.service.ts:783-785`,
`:1116-1183`). The six advisory reads listed in §3.3 call the same function, so they agree
with the authoritative one, and none of them decides anything. For the lane, the claim's
payment read (`withPayments`, `drizzle-gateway-invoice.repository.ts:755-800`) selects
`provider_review_until` beside `expires_at`, so `paymentExpiresAt` becomes the effective
deadline.

**(e) The review sweep (the first producer of `LOSE_TRACK`).** This is a new
`PaymentRepository.loseTrackOfReviewed(scope, now, limit, tx)`, with `expireDue`'s two-step
shape: candidates `state = 'PENDING' AND method = 'GATEWAY' AND provider_review_until IS NOT
NULL AND provider_review_until <= now`, ordered by `provider_review_until, id`,
`FOR UPDATE SKIP LOCKED`. Then `UPDATE … SET state = 'UNKNOWN', updated_at = now` with every
predicate restated. It reads the row-local column only, and `resolved_at` stays NULL
(`payments_resolved_check`). In the same transaction it writes the audit action
`payment.lose_track`, the outbox event `PaymentOutcomeUnknown` (it already exists,
`contracts/src/events.ts:114`, payload `:315-327`, and has no producer today), and the
operational event `payments.gateway_review_unresolved` (dedupe per payment). It runs in the
GATEWAY worker lane (`GatewayPaymentService.runOnce`, every 3 s,
`gateway-payment-loop.ts:14`), not in `PaymentExpiryService`, so the payment message can be
refreshed after the commit as the lane already does (`gateway-payment.service.ts:294-304`).
Two worker replicas take different rows (`SKIP LOCKED`), and a replayed pass moves nothing
(`WHERE state = 'PENDING'`).

**(f) Money in flight: what else must not touch a payment in review or `UNKNOWN`.** A
reviewed receipt is money the customer has very probably already sent, for up to 24 hours,
and then for as long as reconciliation takes. Today four paths would act on it:

- `cancelPendingForOrder` (`drizzle-payment.repository.ts:445-487`), used by the wallet
  purchase (`payment.service.ts:750`) and the customer's own cancellation
  (`container.ts:1966-1971`), CANCELS every `PENDING` payment of the order that carries no
  manual signal and no Stars hold. A payment in review would be cancelled, and TonPays' later
  approval would be `LATE_COMPLETION`, money with no order. It gains
  `isNull(payments.providerReviewUntil)` row-locally, beside `notHeldAt(now)` at `:481`.
- The wallet purchase then refuses on a claimed transfer or a Stars hold
  (`payment.service.ts:751-768`), and so does `OrderService.cancelByCustomer` through the
  same lane (`container.ts:1966-1971`). Both gain a third read,
  `hasProviderReviewOrUnknownForOrder` (`state = 'PENDING' AND provider_review_until IS NOT
NULL`, or `state = 'UNKNOWN'`). It refuses with the EXISTING
  `ORDER_TRANSFER_UNDER_REVIEW` (`contracts/src/errors.ts:1062`, "a transfer for this order is
  waiting to be reviewed"), so no new error code is needed.
- `DrizzleOrderRepository.expireDue`'s `noLivePayment` (`drizzle-order.repository.ts:282-287`)
  counts only `PENDING`. An `UNKNOWN` payment would let the order EXPIRE and its username hold
  go (`payment-expiry.service.ts:252`), so a reconciled confirmation would find no order
  to settle. It widens to `live.state IN ('PENDING', 'UNKNOWN')`. Nothing produces `UNKNOWN`
  today (`ports.ts:293-296`), so the change is inert for every existing route. The pending
  reminder already treats `UNKNOWN` as live
  (`drizzle-pending-payment-reminder.repository.ts:125`).
- A new attempt on the same route for the same order: `findOpenAttempt`
  (`drizzle-gateway-invoice.repository.ts:701-752`) compares `expires_at`. For the `CARD`
  form it compares the effective deadline, so the in-review attempt is handed back, showing
  the review screen, instead of a second provider invoice being opened. Another ROUTE for the
  same order is OQ-TPTG-17.

What deliberately does NOT change: the panel slot hold lapses at the ORDER's deadline
(`panel-sales-gate.ts:196-249`), and the settlement re-decides eligibility, refunding an
undeliverable order to the wallet (`payment.service.ts:3389-3391`). That is the existing rule
for any late-but-valid gateway approval, now possible up to 24 hours later. The username hold
survives while the order is `AWAITING_PAYMENT` (`payment-expiry.service.ts:145-147`).

#### 9.6.4 Reconciliation: what exists today, and the smallest addition

Searched: payment and invoice states, gateway outcomes, `UNKNOWN`/`UNRECONCILED`/`RECONCIL*`,
operational codes, operator endpoints.

| Piece                                               | Evidence                                                                                           | Produced or consumed today?                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Payment state `UNKNOWN`                             | `contracts/src/payment.ts:45-50` (rationale `:21-31`), CHECK via `PAYMENT_STATES` `schema.ts:3837` | No producer: `ports.ts:293-296` ("two reconcile edges have no producer in this release")                |
| Edges `LOSE_TRACK`, `RECONCILE_CONFIRMED`/`_FAILED` | `payment.ts:141-153`, both reconcile edges guarded `reconciliationEvidenceRecorded`                | None. `confirm` and `resolve` are hard-bound to `PENDING` (`drizzle-payment.repository.ts:270`, `:310`) |
| Evidence kind `RECONCILIATION`                      | `payment.ts:214-215` ("an operator resolved an UNKNOWN outcome against the gateway's own records") | Never written                                                                                           |
| Event `PaymentOutcomeUnknown`                       | `events.ts:114`, payload `:315-327` ("so a reconciliation surface has something to list")          | No producer, no consumer (grepped `apps/api/src`)                                                       |
| Reconciliation queue index                          | `payments_unknown_idx` `schema.ts:3819-3822` ("the reconciliation queue")                          | No reader                                                                                               |
| Web Admin                                           | `payments.tsx:1313-1315` banner, `web.fa.ts:2101-2102`; `payment-timeline.tsx:362`                 | Renders, but nothing reaches it                                                                         |
| Operator write on a gateway payment                 | `surfaces/web/payments.controller.ts:76-238`: `GET` routes only                                    | None                                                                                                    |
| Permission                                          | `payments.retry` "Retry a payment settlement" (`permissions.ts:101`)                               | No reader in `apps/api/src`; its name is a retry, not a reconciliation                                  |
| `CREATE_UNKNOWN`                                    | `gateway-invoices.ts:66-72`                                                                        | About the CREATE; leaves the payment `PENDING` until its deadline. Does not fit                         |
| `LATE_COMPLETION`                                   | `gateway-invoices.ts:104-110`; `gateway-payment.service.ts:1116-1183`                              | An invoice outcome for an approval already SEEN; fits the after-deadline approval, not "unknown"        |
| Service `UNRECONCILED`                              | provisioning                                                                                       | Panel accounts, not money. Does not fit                                                                 |

So the vocabulary for "paid status unknown after the review window" already exists in the
contracts, deliberately, and nothing builds it. The smallest addition uses it and adds no
state, no edge, no evidence kind and no event:

1. **Producer:** the review sweep, §9.6.3 (e). Not a contract change.
2. **Operational visibility:** `payments.gateway_review_unresolved` (WARN, dedupe
   `…:<paymentId>`, context ids only), recovered by `payments.gateway_review_reconciled` when
   the payment leaves `UNKNOWN`. Both are declared beside the producer and become schema once
   shipped (CLAUDE.md, operational-event codes).
3. **Evidence keeps arriving, and is never acted on automatically.** The lane already treats a
   payment that is not `PENDING` as post-deadline: no further schedule
   (`gateway-payment.service.ts:626`), webhook-triggered diagnostics at most
   `POST_DEADLINE_INQUIRY_MAX = 3` (`domain/tonpays.ts:173`; `gateway-payment.service.ts:978-986`). A later approval goes
   through `settleApproved(!eligible)` to `lateCompletion` (`:752-755`). A later "no" records
   the outcome only, because the `if (eligible)` guard at `:718` skips `failGatewayPayment`.
   Both are recorded on the invoice (`provider_status`, `provider_paid`, `outcome`) and are
   what the operator reconciles against. This needs no new code.
4. **Operator commands (new):** `PaymentService.reconcileGatewayPayment(scope, actor, id,
{ to: 'CONFIRMED' | 'FAILED', note, idempotencyKey })` behind a new permission
   `payments.reconcile` (HIGH, a contract change; OQ-TPTG-19 asks whether to reuse
   `payments.retry` instead). Under the payment's lock it requires `state = 'UNKNOWN'` and
   applies the `reconciliationEvidenceRecorded` guard from the RECORDED inquiry, never from
   the operator's recollection. `CONFIRMED` requires the invoice's latest recorded inquiry to
   be `completed` with `paid === true`; identity is already verified, because a mismatched
   answer is stored as `nexa.identity_mismatch` with a null status (`:662-684`). `FAILED`
   requires it to be `rejected`, `expired` or `canceled`. Anything else is refused, and the
   payment stays `UNKNOWN`.
   - `CONFIRMED` goes through new conditional `reconcileConfirm` (`WHERE state = 'UNKNOWN'`)
     and then the SAME `confirmAndSettle` / `confirmAndCredit` body, refactored to take its
     `from` state rather than copied (one settlement path, `payment.service.ts:3393`). Evidence
     is `RECONCILIATION` and `confirmed_by_admin_id` is the operator. An order no longer
     `AWAITING_PAYMENT` is refused as `NOT_ELIGIBLE`, today's behaviour for a late approval,
     and stays `UNKNOWN` (OQ-TPTG-17). The order IS still awaiting payment in the ordinary
     case, because of §9.6.3 (f).
   - `FAILED` goes through new conditional `reconcileFail` (`WHERE state = 'UNKNOWN'`):
     `resolved_by_admin_id` is the operator (`payments_resolution_reviewer_check` allows it on
     `FAILED`), the note is `tonpays_telegram:<status>`, the customer gets the existing
     `GATEWAY_PAYMENT_FAILED`, and the outbox gets the existing `PaymentFailed`.
   - "Ask the provider again" (new) is a DB write only (`next_inquiry_at`), spaced 60 s and
     audited. It is not bounded by `POST_DEADLINE_INQUIRY_MAX`, so the lane's stop condition
     at `gateway-payment.service.ts:586` must let an operator-requested inquiry through, which
     needs a flag on the row rather than a raised constant. The worker makes the call under
     the ordinary budget.
5. **Financial log:** `financial-log.consumer.ts` gains a `PaymentOutcomeUnknown` case
   (WP18, so the money log hears of it as it hears of a late completion).

#### 9.6.5 Inquiry cadence during the 24 hours

Today: `inquiryBackoffMs` runs from 20 s to a 300 s cap (`domain/tonpays.ts:154-160`),
"about seventeen calls" over 70 minutes (`:150-152`). At the cap, 24 hours is 288 calls per
payment, too many for an undocumented limit (§9.5). _Proposed_ (constants in
`contracts/src/tonpays-telegram.ts`), chosen by time since `provider_review_started_at`:

| Since acknowledgement | Interval                                                                             | Calls |
| --------------------- | ------------------------------------------------------------------------------------ | ----- |
| first inquiry         | at once                                                                              | 1     |
| 0 – 1 h               | 2 min                                                                                | 30    |
| 1 – 6 h               | 10 min                                                                               | 30    |
| 6 – 24 h              | 30 min                                                                               | 36    |
| last, before deadline | `review_until − 15 s` (`nextInquiryAt`'s rule, `gateway-payment.service.ts:906-911`) | 1     |

That is about 98 calls per payment over a review. At the proposed background share of
15/min (§9.5), a steady state sustains about 450 payments in the late phase and 30 freshly
acknowledged ones at once. When the budget runs out, rows defer 5 s (`:610-621`). Claims
take the earliest `next_inquiry_at` first (`drizzle-gateway-invoice.repository.ts:494`),
so the final pre-deadline inquiry is never starved by fresher rows. A webhook during review
brings the next inquiry forward no sooner than `INQUIRY_MIN_SPACING_MS` (5 s,
`domain/tonpays.ts:170`), with `eligible` judged against the effective deadline. The
customer's 🔎 tap does the same with a 60 s spacing during review (_proposed_), so a
customer cannot spend the budget.

#### 9.6.6 Customer messaging

- **No new `CUSTOMER_NOTIFICATION_KINDS` member** (closed set, `customer-notifications.ts:32-199`,
  pinned by a CHECK). Settlement is the existing path. A provider "no" in review is
  `GATEWAY_PAYMENT_FAILED` (`:199`, via `failGatewayPayment`). No acknowledgement by minute 70
  is `PAYMENT_EXPIRED` (`:36`, `payment-expiry.service.ts:221-228`).
- Entering review and entering `UNKNOWN` are shown by **editing the payment message in place**
  (`WizardInvoiceScreens.refresh`, `wizard-invoice-screens.ts:71-114`, after each commit),
  using the two screens of §8.1. They render state, so they are screen templates, not
  notifications (ADR-0030 §1, the rule stated at `customer-notifications.ts:57-67`). If an
  edit is rate-limited or lost, the next 🔎 tap re-renders it. A notification kind for
  `UNKNOWN` would be a contract change and is not proposed.
- Template keys `bot.payment.gateway_in_review` and `bot.payment.gateway_review_unresolved`
  are a contract change (`templates.ts`), in P0.

#### 9.6.7 Web Admin

- Payment detail: "receipt acknowledged at" and "provider review until", plus a derived
  badge "in provider review" (`PENDING` and `provider_review_until > now`). The fields are
  `providerReviewStartedAt` and `providerReviewUntil` on the payment view (a contract
  change). The state badge and the `UNKNOWN` banner already exist (`payments.tsx:1313-1315`).
  The latest inquiry evidence is already in the gateway invoice view (`providerStatus`,
  `providerPaid`, `lastInquiryAt`, `gateway-invoices.ts:130-137`).
- On an `UNKNOWN` gateway payment, three actions under `payments.reconcile`: confirm, fail
  (each enabled only when the recorded evidence allows it, and re-decided by the server) and
  ask again. These are the only new endpoints, as `POST` commands with idempotency keys.
- `/admin/logs` shows `payments.gateway_review_unresolved`.

#### 9.6.8 Restart and redeploy

The acknowledgement and the review deadline are written in the acknowledgement's own
transaction on the payment row. They are frozen by the trigger and bound by the CHECK
(§7.0). Every reader (sweep, lane, screen, settlement) derives from the row and the Clock,
and no timer or process memory holds the deadline. A restart between the acknowledgement and
the review sweep changes nothing. Two replicas during a rolling update are the normal case
and are safe by `SKIP LOCKED` and the conditional UPDATEs. The one hazard is rolling back
across this release (§7.6).

#### 9.6.9 Contract changes this decision adds (P0, own commit)

- `contracts/src/tonpays-telegram.ts`: `TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS = 24`, the review
  inquiry cadence, the 60 s check-tap spacing.
- `contracts/src/payment-gateways.ts`: descriptor field `providerReview: boolean` (true only
  for `TONPAYS_TELEGRAM`), the list that generates §7.0's CHECK.
- Payment view schema: `providerReviewStartedAt`, `providerReviewUntil`.
- `templates.ts`: `bot.payment.gateway_in_review`, `bot.payment.gateway_review_unresolved`
  (and their catalogue values).
- `permissions.ts`: `payments.reconcile` (unless OQ-TPTG-19 decides to reuse `payments.retry`).
- NOT changed: `PAYMENT_STATES`, `PAYMENT_EVENTS`, `PAYMENT_MACHINE`,
  `PAYMENT_EVIDENCE_KINDS`, `GATEWAY_INVOICE_OUTCOMES`, `CUSTOMER_NOTIFICATION_KINDS`, the
  event list (`PaymentOutcomeUnknown` exists), and the error codes (`ORDER_TRANSFER_UNDER_REVIEW`
  exists).

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
- **Provider review (§9.6.7):** the review timestamps and an "in provider review" badge on
  the payment detail; the existing `UNKNOWN` banner; and, on an `UNKNOWN` gateway payment
  only, the three reconciliation commands under `payments.reconcile`.
- No other new endpoint. No write action for an operator on a card or a receipt, because
  TonPays decides those.

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
  lower, Nexa still credits only the principal. Display only (§13 OQ-TPTG-03).
- Exactly once: the conditional `PENDING → CONFIRMED`, `payments_order_confirmed_key`, the
  ledger's per-payment indexes, `recordOutcome` once. Card change and receipt rows cannot
  reach any of them. The reconciled confirmation is `UNKNOWN → CONFIRMED` through the same
  body and the same index (§9.6.4).
- The review window moves no money. It changes WHICH deadline the one settlement path
  compares under the lock (§9.6.3 d). It never settles on a receipt answer: an
  acknowledgement's `paid` and `receipt_received` open a window and approve nothing. After
  the window, nothing settles or fails automatically.
- Money in flight is protected: while a payment is in review or `UNKNOWN`, the order is not
  withdrawn, cancelled by its customer, paid from the wallet or expired (§9.6.3 f), so one
  transfer cannot become two payments, or a payment with no order.
- Undeliverable order after approval: refunded to the wallet by `refundUndeliverable` (the
  existing one credit path; the money moved). No provider refund call exists or is invented.
- Coexistence: two routes, two `payment_gateways` rows, two credential rows, two webhook
  paths, attempts keyed `(tenant, provider, order_id)`, `findOpenAttempt` per provider. An
  order may have one open attempt per provider; settlement's
  `payments_order_confirmed_key` keeps it to one CONFIRMED payment whichever route wins, and
  the loser's later approval is `LATE_COMPLETION`/`ORDER_NOT_AWAITING_PAYMENT`, settling
  nothing — the existing behaviour for the website route and Stars. A 24-hour review makes
  that window much longer for this route, so whether a SECOND route may be opened for an
  order with a payment in review or `UNKNOWN` is an owner question (OQ-TPTG-17).

## 13. API behaviour NOT supported by the supplied documentation (C)

Each is UNKNOWN and must not be resolved by guessing. _Proposed_ `docs/open-questions.md`
entries (this audit may not edit that file; the implementation's contracts commit adds them):

| Id         | Unknown                                                                                                                                                                                                                                                                                                                                      | What Nexa does meanwhile                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-TPTG-01 | Whether `order_id` uniqueness is shared with the website API (one namespace per account?) and its allowed charset.                                                                                                                                                                                                                           | 20 chars, `NT` + 18 Crockford, 90 random bits: fits max 20 and Nexa's own `length 1..64` CHECK (`schema.ts:4157-4160`); collision is negligible.                                                      |
| OQ-TPTG-02 | Amount unit and rounding beyond "int, Toman"; minimum/maximum amounts (no `AMOUNT_TOO_LOW/HIGH` is listed for this API).                                                                                                                                                                                                                     | `tomanAmountOf` exactly; IRR not divisible by 10 refused, never rounded. An undocumented refusal is `REFUSED`.                                                                                        |
| OQ-TPTG-03 | Meaning of `request_amount` vs `final_amount` vs `credit_amount`, and whether `final_amount` can change after a card change.                                                                                                                                                                                                                 | Metadata only; shown as the provider's transfer figure; latest observed value displayed; never settles.                                                                                               |
| OQ-TPTG-04 | The webhook signature algorithm.                                                                                                                                                                                                                                                                                                             | Not verified, not read, not logged. Hint only.                                                                                                                                                        |
| OQ-TPTG-05 | Webhook retry schedule, event names, and whether a card change or receipt emits one.                                                                                                                                                                                                                                                         | Nothing depends on it; background inquiries cover a lost webhook.                                                                                                                                     |
| OQ-TPTG-06 | `card_number`/`card_name` format (16-digit PAN? IBAN? masked?) and whether either can be null.                                                                                                                                                                                                                                               | Stored as bounded strings; a `CREATED` answer with no `card_number` is a created invoice with no instructions — shown as such, never open (`no_link` analogue).                                       |
| OQ-TPTG-07 | Accepted image types for `receipt` beyond "image".                                                                                                                                                                                                                                                                                           | Photos only; JPEG/PNG by magic bytes.                                                                                                                                                                 |
| OQ-TPTG-08 | Receipt idempotency; how many receipts per invoice; whether a second upload replaces or adds; whether `need_action` asks for a new receipt.                                                                                                                                                                                                  | No blind re-upload; one in flight; an `UNKNOWN` blocks new uploads until an inquiry answers; `need_action` shown as a hint only.                                                                      |
| OQ-TPTG-09 | Whether change-card or receipt is accepted on a non-`pending` invoice; error codes for a change during cooldown or after exhaustion.                                                                                                                                                                                                         | Offered only while PENDING in Nexa and last-known provider status `pending`; an undocumented refusal changes nothing.                                                                                 |
| OQ-TPTG-10 | The custom API's rate limit, and whether it is per key, store or account (shared with the website key?).                                                                                                                                                                                                                                     | Conservative per-route budget (§9.5).                                                                                                                                                                 |
| OQ-TPTG-11 | **Nexa side RESOLVED by the owner (2026-10-01):** the 70 minutes are the customer's window; a receipt-upload acknowledgement before it opens a 24-hour review window; an unresolved window goes to reconciliation (§9.6). Still unknown: the provider invoice's OWN expiry and TonPays' review time, and whether either can exceed 24 hours. | §9.6. An approval after the review deadline is `LATE_COMPLETION` on an `UNKNOWN` payment, which an operator reconciles from recorded inquiry evidence. Nothing settles automatically.                 |
| OQ-TPTG-12 | `buyer_chat_id` semantics: must the buyer have started a TonPays bot? Does it relate to the bot the customer is talking to when a tenant runs several bots?                                                                                                                                                                                  | Sent as `customers.telegram_user_id` (NOT NULL, unique per tenant, `schema.ts:2894`, `:2944`), which is the same id in every bot. The attempt is still bound to its bot.                              |
| OQ-TPTG-13 | Whether `DUPLICATE_ORDER_ID` returns the existing invoice; whether an inquiry by `order_id` exists for this API.                                                                                                                                                                                                                             | Not assumed; `CREATE_UNKNOWN`.                                                                                                                                                                        |
| OQ-TPTG-14 | HTTP status per error code; whether error bodies keep the website's `{ detail: { code } }` shape.                                                                                                                                                                                                                                            | Same reader; a status with no readable code is classified by class; ambiguous is UNKNOWN.                                                                                                             |
| OQ-TPTG-15 | Whether `X-API-Key` on the webhook is the merchant key verbatim (a secret sent to Nexa's public endpoint on every delivery).                                                                                                                                                                                                                 | Never read, never logged; Caddy and API access logs must not log request headers (verify in the deploy config at implementation).                                                                     |
| OQ-TPTG-16 | Sandbox or test mode.                                                                                                                                                                                                                                                                                                                        | None assumed. Acceptance needs the real provider (`OQ-WP10-01`); every automated test uses a fake written from the transcription.                                                                     |
| OQ-TPTG-17 | (Nexa, owner) Whether a customer may open ANOTHER route (website TonPays, manual transfer) for an order whose `TONPAYS_TELEGRAM` payment is in review or `UNKNOWN`. Today's coexistence allows it, and the loser's later approval is `LATE_COMPLETION` with nothing moved, but money was sent twice.                                         | Wallet purchase and customer cancellation are refused (`ORDER_TRANSFER_UNDER_REVIEW`, §9.6.3 f); the same route hands back the in-review attempt. Other routes: today's behaviour, pending the owner. |
| OQ-TPTG-18 | Whether an upload answer can be `status: "processing"` without `receipt_received: true` (or the reverse), and which TonPays treats as acknowledgement.                                                                                                                                                                                       | Either opens the review window (the owner's wording, §9.6.3 c), as the JSON boolean / exact string only; any other shape opens nothing.                                                               |
| OQ-TPTG-19 | (Nexa, owner) The permission for reconciling an `UNKNOWN` gateway payment: a new `payments.reconcile` (HIGH) or the existing, unread `payments.retry` (`permissions.ts:101`).                                                                                                                                                                | _Proposed:_ a new `payments.reconcile`; it is a contract change in P0.                                                                                                                                |

## 14. Package and file ownership for implementation

Sequential where marked; no two agents edit one file concurrently. Every phase works in its
own worktree. Round T's files are avoided entirely: the bot-menu builder module, `main-menu.ts`,
the send-message reply keyboards and the bot-buttons page are NOT touched. Shared files that
PR #133 also edits — `schema.ts`, `container.ts`, `contracts/src/errors.ts` (if a code is
needed), `contracts/src/index.ts`, `apps/web/src/api/client.ts`, `drizzle/meta/_journal.json`,
`docs/open-questions.md`, `tests/integration/harness.ts`,
`scripts/check-falsification-citations.mjs` — are edited only AFTER #133 merges, by the single
owner named below for each.

| Phase | Owner (agent)       | Files (exclusive while the phase runs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends on                                                                              |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0    | Contracts           | `packages/contracts/src/payment-gateways.ts` (member, descriptor fields incl. `providerReview`), `tonpays-telegram.ts` (new: paths, statuses, error codes, lifetime, limits, `TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS`, review cadence), `gateway-invoices.ts` (states, view), the payment view schema (`providerReviewStartedAt`, `providerReviewUntil`), `templates.ts` (new keys incl. `bot.payment.gateway_in_review`, `bot.payment.gateway_review_unresolved`), `permissions.ts` (`payments.reconcile`, OQ-TPTG-19), `index.ts`; `packages/i18n/src/catalogue.fa.ts` (new keys + the website default-name VALUE); `apps/web/src/i18n/templates.fa.ts`, `web.fa.ts`; `tests/unit/gateway-eligibility.test.ts`, `gateway-selector.test.ts`; `docs/open-questions.md` (§13). ONE commit for the contract change, its own message.                                                                                                                                                                                                                                                        | #133 merged                                                                             |
| P1    | Persistence/adapter | `schema.ts` (incl. §7.0 `payments` columns, CHECK, index), the new migration + snapshot + journal (incl. the replaced `nexa_payments_confirmation_guard`); `payments/infrastructure/tonpays-telegram-adapter.ts` (new), shared TonPays HTTP helpers extracted from `tonpays-adapter.ts` (behaviour-preserving); `drizzle-gateway-invoice.repository.ts` (`findOpenAttempt` effective deadline); `drizzle-payment.repository.ts` (`expireDue` row-local predicate, `cancelPendingForOrder` exclusion, `recordProviderReview`, `loseTrackOfReviewed`, `reconcileConfirm`/`reconcileFail`, `hasProviderReviewOrUnknownForOrder`); `commerce/orders/infrastructure/drizzle-order.repository.ts` (`noLivePayment` counts `UNKNOWN`); new repositories for §7.2-§7.5; `gateway-invoice-ports.ts`, payments `ports.ts`; `infrastructure/telegram/fetch-file.ts` (`maxBytes` parameter, default unchanged); `scripts/check-boundaries.sh` (`SINK_FILES`); `tests/unit/tonpays-telegram-adapter.test.ts`, `tests/integration/payment-provider-review-repository.test.ts` (two-connection races). | P0                                                                                      |
| P2    | Orchestration       | `payment.service.ts` (descriptor-driven bot binding, buyer-chat requirement, `payableForm`, `confirmGatewayPayment` effective deadline, `recordProviderReview`, `reconcileGatewayPayment`, wallet-purchase refusal); `domain/settlement.ts` (`gatewaySettlementDeadline`), the Telegram domain module (`receiptAcknowledged`, review cadence); `gateway-payment.service.ts` (card fields on create, card-change and receipt lanes, the review sweep, effective deadline in the advisory reads, codes); `orders/application/order.service.ts` (cancel refusal through the lane); `financial-log.consumer.ts` (`PaymentOutcomeUnknown`); `gateway-payment-loop.ts`, `container.ts`; `tests/integration/tonpays-telegram-gateway.test.ts`, `tests/integration/tonpays-telegram-review-window.test.ts`.                                                                                                                                                                                                                                                                                     | P1                                                                                      |
| P3    | Telegram surface    | `surfaces/telegram/bot-runtime.ts` (`gr:`/`gk:`, `gatewayAttemptScreen` card, in-review and unresolved branches BEFORE the closed test, `RECEIPT_UPLOAD` branch), `wizard-invoice-screens.ts` (only if needed), a new `gateway-receipt-capture.service.ts` in payments/application; `tests/unit/bot-runtime*.test.ts` additions, `tests/integration/tonpays-telegram-telegram.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P2                                                                                      |
| P4    | Web Admin           | `surfaces/web/payment-gateways.controller.ts` (view facts only), `surfaces/web/payments.controller.ts` (the three reconciliation `POST` commands, §9.6.7), `apps/web/src/pages/payment-gateways.tsx`, `payments.tsx` (review facts, badge, reconcile actions), `apps/web/src/api/client.ts` (types + the three calls), `tests/web/*`; `tests/web/shots/fixtures/*` if screenshots exist for gateways.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P2 for the commands (the read-only part may start after P0, beside P3 — no shared file) |
| P5    | Docs/falsification  | `docs/tonpays-telegram-falsification.md`, `scripts/check-falsification-citations.mjs` (register it), this audit's §15 "what was built".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P2–P4                                                                                   |

## 15. Test matrix and falsification targets

Each "TPTG" rule is reverted ALONE in a mutation worktree and the named test must die
(`CLAUDE.md`, reviewing with agents). Existing TP-01..TP-20 must stay KILLED.

| #       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Test (level)                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| TPTG-01 | Only inquiry `completed` + `paid === true` approves; a receipt answer with `paid: true` or `receipt_received: true` settles nothing                                                                                                                                                                                                                                                                                                                                                             | unit (verdict) + integration                       |
| TPTG-02 | An approval at/after the EFFECTIVE deadline (`expires_at`, or `provider_review_until` once acknowledged) is `LATE_COMPLETION`, decided under the payment's lock, even with a receipt `processing`                                                                                                                                                                                                                                                                                               | integration                                        |
| TPTG-03 | A create with a stamped send is `CREATE_UNKNOWN` and never re-sent; `DUPLICATE_ORDER_ID` is `CREATE_UNKNOWN`                                                                                                                                                                                                                                                                                                                                                                                    | integration                                        |
| TPTG-04 | A card-change claim with a stamped send is `UNKNOWN`, never re-sent, and hides the current card                                                                                                                                                                                                                                                                                                                                                                                                 | integration                                        |
| TPTG-05 | A receipt claim with a stamped send is `UNKNOWN`, never re-uploaded; the same `file_unique_id` is never queued twice                                                                                                                                                                                                                                                                                                                                                                            | integration                                        |
| TPTG-06 | Only a 4xx `RATE_LIMIT_EXCEEDED` re-queues a receipt; a 5xx with that code in its body is `UNKNOWN`                                                                                                                                                                                                                                                                                                                                                                                             | unit + integration                                 |
| TPTG-07 | A photo goes to the gateway window only within `(tenant, bot, customer)`; a window in bot A never takes a photo from bot B                                                                                                                                                                                                                                                                                                                                                                      | integration                                        |
| TPTG-08 | A gateway receipt never writes `payment_receipts`, never appears in the review queue, and never exempts the payment from expiry through `noReceiptFiled()`; only a recorded acknowledgement opens the bounded review window                                                                                                                                                                                                                                                                     | integration                                        |
| TPTG-09 | A `DOCUMENT`, video or >5 MB file is refused before any row is written; a download stops at 5 MB while streaming                                                                                                                                                                                                                                                                                                                                                                                | unit (fetch-file bound) + integration              |
| TPTG-10 | Opening a gateway window supersedes the manual window in the same bot, and vice versa                                                                                                                                                                                                                                                                                                                                                                                                           | integration                                        |
| TPTG-11 | `final_amount` different from the payable changes neither the settled/credited amount, the fee, the gift nor the refund ceiling                                                                                                                                                                                                                                                                                                                                                                 | integration                                        |
| TPTG-12 | A created card invoice is the open attempt (handed back); one without a card is not                                                                                                                                                                                                                                                                                                                                                                                                             | integration                                        |
| TPTG-13 | The website route is unchanged: a created link invoice is still open, and still `gateway_no_link` without a link                                                                                                                                                                                                                                                                                                                                                                                | existing tests + one added                         |
| TPTG-14 | Credentials are independent: the Telegram route cannot be enabled with only the website key stored, and never reads it                                                                                                                                                                                                                                                                                                                                                                          | integration (HTTP)                                 |
| TPTG-15 | `WRONG_API_KEY_KIND` is configuration: FAILED without customer notification, condition opened for `TONPAYS_TELEGRAM`                                                                                                                                                                                                                                                                                                                                                                            | unit + integration                                 |
| TPTG-16 | A webhook to `/tonpays/` naming a Telegram order id is `IGNORED_UNKNOWN`, and vice versa                                                                                                                                                                                                                                                                                                                                                                                                        | integration                                        |
| TPTG-17 | An invoice id outside the safe charset is never placed in a URL path                                                                                                                                                                                                                                                                                                                                                                                                                            | unit (adapter)                                     |
| TPTG-18 | The attempt is refused before any row when the customer's Telegram id is not a safe integer, or the request is not from a bot                                                                                                                                                                                                                                                                                                                                                                   | integration                                        |
| TPTG-19 | `gr:`/`gk:` for another customer's, another bot's or a non-PENDING payment change nothing and answer `gateway_closed`                                                                                                                                                                                                                                                                                                                                                                           | unit (runtime) + integration                       |
| TPTG-20 | Change card is refused locally while one is in flight, during the provider's cooldown, and once exhausted                                                                                                                                                                                                                                                                                                                                                                                       | integration                                        |
| TPTG-21 | No key, card number, file id, caption or byte reaches a log line, audit row or operational context                                                                                                                                                                                                                                                                                                                                                                                              | unit (spy logger) + integration                    |
| TPTG-22 | Every new lane gives back unreached leases when the budget runs out (TP-16/17 for the new lanes)                                                                                                                                                                                                                                                                                                                                                                                                | integration                                        |
| TPTG-23 | The website route's default name changed and a tenant's `display_name` and template override still win                                                                                                                                                                                                                                                                                                                                                                                          | unit (composer) + web test                         |
| TPTG-24 | The acknowledgement opens a review only when `acknowledgedAt < expires_at` under the payment's lock. Mutation: drop the check (and the CHECK's clause) → an acknowledgement at minute 70:00.000 opens a review; the test dies                                                                                                                                                                                                                                                                   | integration (+ a direct-SQL CHECK test)            |
| TPTG-25 | `expireDue` skips a payment in review. Mutation: drop `isNull(provider_review_until)` from the SELECT and the UPDATE → an acknowledged payment is `EXPIRED` at minute 70 and told `PAYMENT_EXPIRED`                                                                                                                                                                                                                                                                                             | integration                                        |
| TPTG-26 | The exclusion is scoped: past their deadlines a website `TONPAYS`, a Stars and an unacknowledged `TONPAYS_TELEGRAM` payment still expire, and a manual transfer with a receipt is still exempt by `noReceiptFiled()`; the review columns cannot be written on any other route (CHECK)                                                                                                                                                                                                           | integration                                        |
| TPTG-27 | Approval in review is judged against the review deadline. Mutation: `confirmGatewayPayment` compares `expires_at` again → `completed`+`paid` at minute 71 in review becomes `LATE_COMPLETION`; the test dies                                                                                                                                                                                                                                                                                    | integration                                        |
| TPTG-28 | An approval at exactly `review_until` (and after) is `NOT_ELIGIBLE`/`DEADLINE_PASSED` → `LATE_COMPLETION`, nothing settles; at `review_until − 1 ms` it settles (half-open)                                                                                                                                                                                                                                                                                                                     | integration (fixed clock)                          |
| TPTG-29 | Nothing but an acknowledging upload answer extends: the `gr:` tap, a `QUEUED`/`SENDING` submission, an `UNKNOWN` upload (timeout, 5xx, unreadable 2xx), `REFUSED`, `RATE_LIMITED`, `NOT_FOUND`, `ACCEPTED` with neither signal, `receipt_received: "true"` (a string), and an INQUIRY `processing`. Mutation: loosen `receiptAcknowledged` → the unit test dies                                                                                                                                 | unit (pure predicate, every outcome) + integration |
| TPTG-30 | A repeated or later acknowledgement never moves the deadline. Mutation: drop `provider_review_until IS NULL` from the UPDATE → the second acknowledgement no longer returns a clean `false` with the deadline unchanged (it raises the guard trigger's error), and the test dies; a direct UPDATE of either column is refused by the trigger                                                                                                                                                    | integration + direct-SQL trigger test              |
| TPTG-31 | Minute-70 race, both orders, two connections and a barrier: (a) the acknowledgement holds the payment's lock while the sweep runs → skipped; after the commit the next sweep does not expire it; (b) the sweep expires first → the acknowledgement finds `EXPIRED`, writes nothing, opens no review; (c) the sweep's snapshot is taken BEFORE the acknowledgement commits and its lock AFTER → still not expired. (c) is what kills a cross-table (`gateway_invoices`) variant of the predicate | integration (two connections)                      |
| TPTG-32 | Review-deadline race, both orders: an approval racing the review sweep at `review_until` → exactly one of `CONFIRMED` or `UNKNOWN` + `LATE_COMPLETION`, never both and never a settlement on an `UNKNOWN` row; sweep first → `UNKNOWN`, then the approval is `PAYMENT_NOT_PENDING`/`LATE_COMPLETION`                                                                                                                                                                                            | integration (two connections)                      |
| TPTG-33 | An acknowledgement after expiry never reopens: an upload answered after `expires_at` (payment still `PENDING` because the sweep is late, and payment already `EXPIRED`) writes no review columns; the worker never uploads once `now >= expires_at` (`ABANDONED`, `nexa.deadline_passed`)                                                                                                                                                                                                       | integration                                        |
| TPTG-34 | Restart preserves the clock: a fresh container and service instances after the acknowledgement read `provider_review_until` from the row; the sweep at `review_until` moves it; the CHECK pins `+ 24 h`                                                                                                                                                                                                                                                                                         | integration                                        |
| TPTG-35 | `UNKNOWN` is never auto-settled or auto-failed: a later inquiry approval is `LATE_COMPLETION` and a later `rejected` is recorded only; the payment stays `UNKNOWN`; the customer is not told it failed; `PaymentOutcomeUnknown` and `payments.gateway_review_unresolved` are written once                                                                                                                                                                                                       | integration                                        |
| TPTG-36 | Money in flight: while in review or `UNKNOWN`, the wallet purchase and the customer's cancellation are refused with `ORDER_TRANSFER_UNDER_REVIEW`; `cancelPendingForOrder` leaves the payment; the order is not expired while its payment is `UNKNOWN`. Mutation: each predicate alone                                                                                                                                                                                                          | integration                                        |
| TPTG-37 | Reconciliation needs permission and RECORDED evidence: confirm without a recorded `completed`+`paid` is refused, fail without a recorded `rejected`/`expired`/`canceled` is refused, both only from `UNKNOWN`, both conditional (a double click moves once), confirm settles through the one path with evidence `RECONCILIATION`                                                                                                                                                                | integration (HTTP)                                 |
| TPTG-38 | In review, `rejected`/`expired`/`canceled` → `FAILED` + `GATEWAY_PAYMENT_FAILED`; `pending`/`processing`/`need_action`/`completed` without `paid` stay `PENDING`                                                                                                                                                                                                                                                                                                                                | unit (verdict) + integration                       |
| TPTG-39 | The screen: in review renders `gateway_in_review` (no `gr:`/`gk:`, no retry), `UNKNOWN` renders `gateway_review_unresolved`; neither renders `gateway_closed` or `gateway_failed`                                                                                                                                                                                                                                                                                                               | unit (runtime)                                     |
| TPTG-40 | The review inquiry cadence stays within the budget and the last inquiry before `review_until` is scheduled and claimed first                                                                                                                                                                                                                                                                                                                                                                    | unit (cadence) + integration                       |

Commands: `pnpm verify`, `pnpm db:check`, `pnpm test:integration` (serialised or on its own
database — CLAUDE.md), and the Telegram/web suites. A real-provider acceptance remains owed
(`OQ-WP10-01`, OQ-TPTG-16) and no capability is claimed as accepted before it.

## 16. What this audit did not do

It read code and documents only. It ran no test, created no migration, edited no source file,
pushed nothing, and printed no secret. It did not see the screenshot. §9.6 and the sections
it touches record the owner's decision of 2026-10-01 on OQ-TPTG-11. They were written the same
way, against the same `main`, and every race claim in them is a test the implementation
owes (TPTG-31, TPTG-32), not one this audit ran.
