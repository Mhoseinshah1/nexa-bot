# R11 B5 — Telegram Stars paid inside the mini app (`openInvoice`)

Money PR. Behind a new flag `miniapp_stars_invoice`, **OFF by default**, and only where the
existing Stars route is offered.

## What changed

### Contract (own commit: `contract(miniapp, features): …`)

- **Feature flag `miniapp_stars_invoice`** — default OFF, `TENANT_WIDE`, no settings. The Stars
  route's own switch still decides whether Stars are offered at all; this flag only decides
  whether the mini app may ALSO open that invoice in place. Web Admin presentation (Persian
  title + summary) in `features-catalogue.ts` / `web.fa.ts`; switching off loses nothing (the
  chat invoice stays payable, nothing paid changes), so the page does not ask first. Pinned in
  `tests/unit/registries.test.ts`.
- **Route `MINIAPP_ROUTES.paymentStarsInvoice`** = `POST /payments/:paymentId/stars-invoice`,
  response `miniAppStarsInvoiceSchema` `{ paymentId, invoiceLink }`, documented as never being
  evidence of payment.
- **Wire fields** `miniAppGatewayAttemptSchema.inAppInvoice` and the order routes'
  `paysInApp`, both `.default(false)` so older payloads/fixtures still parse. The API
  projections stated them as `false` in that commit so the tree compiled; behaviour arrived in
  the feature commit.

### Server

- **`telegramCreateInvoiceLink`** (`infrastructure/telegram/send-message.ts`): `createInvoiceLink`
  through the existing outbound Telegram path (`telegramCall`: `assertOutsideTransaction`,
  `redirect: 'error'`, the retryable/permanent taxonomy). The Stars invoice body is now ONE
  function, `starsInvoiceFields`, used by BOTH `telegramSendInvoice` (chat) and
  `telegramCreateInvoiceLink` (link): `XTR`, empty `provider_token`, exactly one price, the
  attempt's payload — so the two cannot drift into two different invoices. A 2xx without a
  string `result` is `telegram.no_invoice_link` (UNKNOWN-class), never a link; a Star amount that
  is not a positive safe integer is refused before any call (same rule as `sendInvoice`).
- **`TelegramStarsInvoiceLinkCreator`** (`commerce/miniapp/infrastructure/telegram-stars-invoice-link.ts`):
  the token of the bot the attempt is bound to via `tokenForBotInstance` (the worker's path), the
  presentation the worker renders. The container's Stars presentation closure was lifted into one
  `starsInvoicePresentation` function shared by the worker (`GatewayPaymentService`) and this
  creator.
- **`MiniAppStarsInvoiceService`** (`commerce/miniapp/application/miniapp-stars-invoice.service.ts`):
  - `linkFor(context, actor, paymentId)`:
    1. early `guard.check(PAYMENT_PLACE_PERMISSION)` (denial audited via `recordMutationDenial`)
       before anything is asked of Telegram;
    2. the customer's own attempt (`GatewayPaymentService.attemptFor`, by id AND owner; another
       customer's is the mini app's one not-found);
    3. offered here only for a `TELEGRAM_STARS` ORDER attempt bound to THIS session's bot (pre-checkout
       would refuse any other bot) while the flag is on — else `MINIAPP_ROUTE_UNAVAILABLE`;
    4. payment `PENDING` and inside its deadline (`PAYMENT_STATE_INVALID`), order
       `AWAITING_PAYMENT` (`ORDER_STATE_INVALID`);
    5. **route eligibility identical to the bot's**: `CheckoutService.gatewayRouteFor(scope,
customer, order.totals.total, 'TELEGRAM_STARS')` — the same call `payByGateway` makes for
       the bot and the mini app; not offered → the existing `MINIAPP_ROUTE_UNAVAILABLE`;
    6. **one link per attempt**: idempotency store, namespace `MINI_APP`, key
       `stars-invoice:<bot>:<customer>:<paymentId>`, request hash over (payment, payload, Stars,
       unit, bot). A stored link is returned as is; otherwise `createInvoiceLink` with the
       attempt's own `provider_order_id` and snapshotted `sent_amount` (bigint, never recomputed);
    7. the record is written in `runAuthorizedMutation` (authoritative permission check in the
       transaction), with `ScopeActivityReader.scopeIsActive` read INSIDE that transaction, plus an
       audit row `gateway_invoice.stars_link_created` (provider, unit, Stars, bot — not the link,
       not the payload). A concurrent loser (`remember` → false) returns the winner's link.
    8. A failed create remembers nothing and answers `PAYMENT_GATEWAY_UNAVAILABLE`
       (`reason: INVOICE_LINK_FAILED`); a later ask tries again (safe: a link is not a charge and
       names the same attempt).
  - `offersInApp(context, attempt)` → the attempt wire's `inAppInvoice`; `paysInApp(scope,
provider)` → the routes' `paysInApp`.
  - **No settlement code, no credit path**: payment is the existing `pre_checkout_query` +
    `successful_payment` handling (`StarsPaymentService`) on the bot's webhook.
- **Controllers**: `MiniAppPaymentsController.starsInvoice` (new route), `status`/`check` and
  `MiniAppShopController.payGateway` pass `inAppInvoice`; the order routes state `paysInApp`; the
  top-up attempt passes `false` (top-ups stay in chat).

### Client (`apps/miniapp`)

- `telegram.ts`: `openInvoice` on the typed `TelegramWebApp`, `openStarsInvoice(url)` → the
  status Telegram reports, or `unsupported`.
- Checkout: after `payGateway`, a Stars attempt with `inAppInvoice` goes to the payment screen
  with `openInvoice: true`; the Stars tile says «پرداخت همین‌جا با تلگرام استارز» when `paysInApp`.
- Payment screen: opens the invoice once on arrival; a «پرداخت با تلگرام استارز» button while
  PENDING. `paid`/`pending` → headline «در حال تأیید پرداخت…» and the screen keeps polling the
  existing payment-status endpoint (5 s) — it says «پرداخت تأیید شد.» only when the SERVER says
  CONFIRMED; the client callback is never treated as proof. `cancelled`/`failed` → «پرداخت انجام
  نشد. سفارش شما هنوز باز است…», order still payable, button still there. No `openInvoice`
  (old client) → told to pay the chat invoice. A `route_unavailable` refusal shows the existing
  sentence «این روش برای این مبلغ دیگر در دسترس نیست.».

### Docs

- `docs/open-questions.md`: OQ-R11-B5-01 (two invoices for one attempt; simultaneous double
  approval → second charge recorded `SECOND_CHARGE`, not settled), OQ-R11-B5-02 (top-ups stay in
  chat), OQ-R11-B5-03 (`openInvoice` and the unverified origin rule of OQ-R11-A5-01).

## Tests

| File                                              | Tests | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/miniapp-stars-invoice.test.ts`        | 15    | link once per attempt / replay same; attempt's own payload + Stars (bigint); concurrent loser gets winner's link; not offered → `route_unavailable` (and the bot's question asked with the order total); flag off; other bot / top-up / other provider; not found; closed/expired payment, order not awaiting payment; failed create remembers nothing; stopped scope records nothing; `offersInApp`/`paysInApp`; `createInvoiceLink` body == `sendInvoice` body minus `chat_id` (XTR, one price, empty token); non-link answer; amount refused before call; creator uses the attempt bot's token + presentation |
| `tests/web/miniapp-stars-invoice.test.tsx`        | 6     | auto-open once, client `paid` → «در حال تأیید پرداخت…» not «تأیید شد»; confirmed only when the server says so; `cancelled`/`failed` leave it payable; refusal sentence; no button when not offered; no `openInvoice`                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/integration/miniapp-stars-invoice.test.ts` | 4     | real app + fake Telegram: link once per attempt, payload = `provider_order_id`, XTR `amount: 200` (260,000 T / 1,300 T per Star), bot token, no `chat_id`, no second attempt; flag off and Stars route disabled → `miniapp.route_unavailable`, no Telegram call; another customer → 404; client-side `paid` leaves PENDING/AWAITING_PAYMENT; webhook pre-checkout + `successful_payment` (redelivered) → CONFIRMED once, order PAID, no ledger rows; afterwards link refused and pre-checkout refused                                                                                                            |

### Mutation checks (each: break → named test red → restore → green)

| #   | Mutation                                       | Red test                                                                                                |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| M1  | skip the stored-link replay                    | unit «makes ONE link per attempt…»                                                                      |
| M2  | drop the `gatewayRouteFor` check               | unit «refuses with the existing route_unavailable…»                                                     |
| M3  | link asks `sentAmount + 1n`                    | unit «asks for the attempt’s OWN payload and snapshotted Stars…»                                        |
| M4  | ignore the flag                                | unit «refuses while the flag is off», «draws the in-app button only…»                                   |
| M5  | price `amount + 1` in the shared invoice body  | unit «sends the chat invoice’s body exactly…»                                                           |
| M6  | client `paid` shown as «پرداخت تأیید شد.»      | web «…a client `paid` is NOT a paid order», «says confirmed only once the server does»                  |
| M7  | hide the pay button after `cancelled`/`failed` | web «leaves the order payable after `cancelled` or `failed`…»                                           |
| M8  | (integration) link asks `sentAmount + 1n`      | integration «makes the link once per attempt, with the attempt’s own payload and exact XTR Stars»       |
| M9  | (integration) skip the stored-link replay      | integration «makes the link once per attempt…»                                                          |
| M10 | (integration) drop the `gatewayRouteFor` check | integration «refuses with the existing route_unavailable when Stars is not offered, or the flag is off» |

### Local gate

- `pnpm verify`: typecheck, lint, format:check, boundaries, i18n, citations, shell — green; unit
  `passed=10325 failed=5` where the 5 were `tests/unit/backup-cli.test.ts` needing `apps/api/dist`
  (fresh worktree, `build` is verify's last stage); after `pnpm build`: backup-cli + `test:web` +
  `test:deploy` `passed=3382 failed=0`, build green.
- Guard integration suites (`telegram-stars`, `miniapp-surface`, `r10-char-checkout-parity`,
  `r9-char-checkout-payment`, `fx-stars`, `miniapp-stars-invoice`): `passed=99 failed=0`.

## Decisions

- A mini-app-specific flag was added (round rule: every feature ships OFF); OFF by default.
- The worker still sends the chat invoice for the attempt (the bot pipeline is unchanged); the
  in-app link is a second door to the same attempt, paid at most once by pre-checkout's
  `ALREADY_PAID` (OQ-R11-B5-01).
- One link per ATTEMPT (key = payment id), not per client request key; stored in the existing
  idempotency store (no migration).
- Orders only; top-ups keep the chat invoice (OQ-R11-B5-02).
- A lost `createInvoiceLink` answer is retried on the next ask: unlike a gateway create, a link is
  not a charge and carries the same payload.

## Migrations

None.
