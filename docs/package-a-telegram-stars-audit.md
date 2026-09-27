# Package A — Telegram Stars: audit and design

The owner's post-WP20 brief, Package A. Telegram Stars (`XTR`) becomes a real Nexa payment
route for the bot's digital services, inside the existing payment architecture. It adds no
second accounting system.

## 1. What already exists, and what does not fit

The gateway layer (WP11A, `docs/tonpays-gateway-audit.md`; WP18) is provider-neutral in
most of its parts:

- **Routes.** `payment_gateways` holds one row per `(tenant, provider)`. The descriptor
  decides how a route settles (`settlesVia`), never its name.
- **The attempt.** A `payments` row with method `GATEWAY`. It snapshots the principal, the
  customer fee, the payable and a hard deadline, and trigger 0114/0124 freezes all of them.
  Beside it sits a `gateway_invoices` row with the provider-side facts.
- **The worker.** `GatewayPaymentService` creates invoices outside any transaction and
  inquires. On an approval it calls `PaymentService.confirmGatewayPayment`, the one
  exactly-once settlement path. That path checks the deadline under the payment's lock,
  then hands off to `confirmAndSettle` (an order) or `confirmAndCredit` (a top-up).
- **The financial log** (WP18) logs every confirmation, failure and late completion.
- **Refunds** never call a provider: `REFUND_METHOD_SUPPORT.GATEWAY` is unsupported, and
  every refund is a wallet credit.

Five things did not fit Stars, and the design below answers each one.

1. **`XTR` is not a currency of this product**, and it must not become one. `Money` is
   Toman or Rial. A Star is the unit a provider invoice is denominated in, exactly as
   TonPays' Toman figure is. It gets its own list, `GATEWAY_PROVIDER_UNITS`, used only by
   `gateway_invoices.provider_unit`.
2. **Approval is pushed, not pulled.** TonPays is asked ("only the inquiry decides").
   Telegram tells the bot: `successful_payment` arrives on the bot's own authenticated
   webhook, and nothing else proves a Stars payment.
3. **The invoice is sent with the bot's own token**, to the customer's own chat. There is
   no gateway API key.
4. **The price needs a conversion.** No FX feed exists or is invented. The route carries an
   operator-set rate, and each attempt snapshots it.
5. **Today a `pre_checkout_query` is dropped at the webhook**, because it has no `message`
   or `callback_query` user. A `successful_payment` reaches the runtime and is answered
   `bot.unknown_command`.

## 2. Design

### 2.1 The route

- **Provider.** `TELEGRAM_STARS`, with this descriptor:
  - `settlesVia: 'GATEWAY'`;
  - `requiresCredentials: false` (the bot token is the credential);
  - `invoiceCredential: 'BOT_TOKEN'` (TonPays: `'GATEWAY_KEY'`);
  - `approval: 'RECORDED_PAYMENT'` (TonPays: `'INQUIRY'`);
  - `conversion: 'FIXED_RATE'` (TonPays: `'SAME_UNIT'`).

  Callers branch on these fields, never on the name.

- **The rate.** `payment_gateways.provider_unit_rate_minor`: the sales currency's minor
  units per Star, which is the owner's `toman_per_star` for a Toman installation.
  - It is a positive integer, or null.
  - A `FIXED_RATE` route cannot be enabled while it is null (`PAYMENT_GATEWAY_UNAVAILABLE
{reason: 'RATE_MISSING'}`), and cannot be cleared while enabled.
  - Web Admin edits it on the existing payment-gateways page.
- **The boot reconcile** (`ensureDefaults`) creates the row DISABLED, as it does for every
  provider.
- **Scope (brief A1, "tenant/bot scoped").** The route's configuration — status, rate, fee,
  limits — is the tenant's, as every gateway row is (`payment_gateways` is unique per
  tenant and provider). What is bound to a bot is the ATTEMPT: the invoice snapshots the
  bot it was sent through (`gateway_invoices.bot_instance_id`), is sent with that bot's
  token, and pre-checkout and `successful_payment` are accepted only on that bot's webhook.
  A per-bot rate would be a second configuration table for one row's worth of settings,
  while two bots of one tenant sell the same catalogue in the same currency. The decision
  is recorded here rather than left for a later reader to guess.

### 2.2 The conversion (brief A1)

1. The principal is the order total, or the top-up amount.
2. The WP18 customer fee is computed on the principal, unchanged.
3. The payable is principal plus fee, in Toman.
4. The rate is read inside the request transaction and snapshotted on the invoice
   (`gateway_invoices.conversion_rate_minor`).
5. `stars = ceil(payable / rate)`, in `bigint` only. A positive payable is at least one
   Star. The result is `sent_amount`, frozen with the row.

The rounding excess is not money Nexa has. It is not stored as principal, fee, credit,
cashback or anything refundable. Every one of those reads `payments.amount` or its fee
snapshot, both in Toman, and neither changes.

### 2.3 The attempt

`requestGatewayPayment` and `requestGatewayTopup` are unchanged except for two additions.

- **The bot instance.** It must be known: the customer's bot, from the turn's scope. It is
  written to `gateway_invoices.bot_instance_id`, which a CHECK requires for a `BOT_TOKEN`
  route. A request without a bot (none exists today) is refused.
- **The payload.** The provider order id is an opaque random 32-hex string. It is the
  invoice `payload`, well inside Telegram's 1–128 bytes, and it names no customer, order,
  secret or token.

### 2.4 The invoice (brief A2)

The worker's creation lane sends it. For a `BOT_TOKEN` route the credential it reads is the
attempt's bot token, not a stored key.

- **The call.** The adapter calls `sendInvoice` to the customer's chat with:
  - `currency: 'XTR'`;
  - one `LabeledPrice`;
  - `provider_token: ''`;
  - no tips, shipping or subscription period.
- **The text.** Title, description and price label are rendered from templates.
- **The outcomes** are mapped as TonPays' are:

  | Telegram answer            | Outcome                               |
  | -------------------------- | ------------------------------------- |
  | OK                         | `CREATED` (invoice id `message:<id>`) |
  | 429                        | `RATE_LIMITED`                        |
  | 400 / 403                  | `REFUSED`, customer-side              |
  | 401 / 404                  | `REFUSED`, configuration              |
  | timeout / 5xx / unreadable | `UNKNOWN`                             |

- **An UNKNOWN create is never re-sent**, as the gateway rule says. If the invoice did
  arrive, the customer can still pay it: pre-checkout validates the attempt, not the
  creation state.
- **Budgets.** Stars has its own budgets. The creation budget protects the bot's Telegram
  rate. No inquiry calls are ever made.

### 2.5 Pre-checkout (brief A3)

It is answered in the webhook request, before the customer turn, because Telegram's
deadline is 10 seconds and no queue belongs in it. `StarsPaymentService.preCheckout`
reads, without locking, and approves only if all of these hold:

- the payload resolves to a `TELEGRAM_STARS` invoice in this tenant;
- the invoice belongs to this webhook's bot instance;
- the payer's Telegram id is the attempt's customer's, and the customer is not blocked;
- the currency is `XTR`, and `total_amount` equals the snapshotted `sent_amount`;
- the payment is `PENDING`, with at least `STARS_PRE_CHECKOUT_MARGIN_MS` (two minutes)
  before its deadline;
- the order is still `AWAITING_PAYMENT` (an order payment), or the top-up is still open.

It answers `ok: true`, or `ok: false` with a fixed customer sentence. It moves no money and
provisions nothing.

The margin is the one piece of judgement here. Telegram charges between the approval and
`successful_payment`, and a payment that lands after the deadline settles nothing (§2.7).
So approval stops two minutes early rather than at the deadline.

### 2.6 `successful_payment` (brief A4)

This is also handled in the webhook, before the turn, and in two steps.

1. **Record.** One transaction takes the invoice's row lock and validates everything
   pre-checkout validated except the deadline: payload, bot, payer, currency and amount.
   It then writes `provider_charge_id` (the `telegram_payment_charge_id`), sets
   `provider_paid = true`, and makes the row due for settlement.
   - `gateway_invoices_charge_id_key`, unique on `(tenant_id, provider,
provider_charge_id)`, makes a charge id impossible to attach to a second attempt.
   - A duplicate update carrying the same charge id is a no-op.
   - A different charge id on an already-paid invoice, or any validation failure, is
     recorded as `payments.gateway_identity_mismatch`, with the charge id and no update
     body. Nothing settles.
2. **Settle.** `GatewayPaymentService.settleRecorded` runs the approval branch of the
   inquiry for that one payment, and calls `confirmGatewayPayment`, the same exactly-once
   path TonPays uses. It locks, re-checks the deadline, and writes the order or wallet
   effects, the notifications and the financial log.

If the record step throws, the webhook answers 500, so Telegram redelivers the update. A
charge nobody recorded is the one failure this route cannot repair afterwards. If the
settle step throws, the recorded row is still due, and the worker settles it on its next
pass. For a `RECORDED_PAYMENT` provider, the worker's inquiry reads the recorded row
instead of calling out. Either way, settlement is decided exactly once, by the payment's
row lock and conditional UPDATE.

### 2.7 Late and mismatched payments

A recorded payment whose attempt is no longer eligible is a `LATE_COMPLETION`, as
everywhere else. That means a deadline passed, or the order was cancelled. It is recorded
once, the operator is alerted, and nothing settles and nothing is credited.

Telegram has charged the customer. Handing the Stars back (`refundStarPayment`) is a manual
operator decision that this package does not automate (brief A6). The charge id is stored
exactly so a later package can do it honestly.

### 2.8 The customer (brief A5)

- **The order screen** draws one button per external route. The new callback
  `gp:<orderId>.<provider>` names the route. The old `g:<orderId>` still works for
  messages already sent, and picks the first route as before.
- **Top-up** already names the route (`tp:`).
- **The Stars reply** shows the principal, the fee when there is one, the payable in
  Toman, and `⭐ N`. The invoice itself then arrives as its own message.
- **After payment**, the existing messages apply: the order's delivery, or the top-up
  credit.

### 2.9 `/paysupport` (brief A7)

A text command answered with the existing support screen (`support.accounts`). It is added
to `BOT_COMMANDS` so the command menu lists it. There is no new ticketing.

### 2.10 Refunds (brief A6)

Nothing changes, and no path calls `refundStarPayment`. A service refund request is a
wallet credit of principal chosen by the administrator. It never refunds the fee or the
Star rounding.

### 2.11 The financial log (brief A8)

The existing events carry a Stars payment, with route `TELEGRAM_STARS`. For Stars, the
provider columns show the charge id and the Star amount. The log never contains the bot
token, the payload or an update body.

## 3. Rollback

The migration is additive:

- nullable columns;
- one widened enum per provider CHECK;
- one new unique partial index.

The release before this one reads a `TELEGRAM_STARS` row as an unknown provider. Its
`routesFor` has no adapter for it and offers nothing. A Stars attempt left `PENDING`
across a rollback expires by the generic sweep. A `successful_payment` arriving while the
old release runs is answered `bot.unknown_command` and is not recorded. Before rolling
back, disable the Stars route and wait for its open attempts' deadlines (70 minutes). The
query:

```sql
SELECT count(*) FROM payments
 WHERE gateway_provider = 'TELEGRAM_STARS' AND state = 'PENDING';
```

## 4. Not done, deliberately

- **Recurring Star subscriptions, tips and shipping** (brief A2).
- **Automatic Star refunds** (brief A6).
- **Reconciling a lost `successful_payment` through `getStarTransactions`.** The webhook
  answers non-2xx instead, so Telegram redelivers.
