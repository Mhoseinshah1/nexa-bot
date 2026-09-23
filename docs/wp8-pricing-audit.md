# WP8 — Pricing, discounts and cashback

Written before the code, as every package audit here is. It records what exists, what
does not, and the decisions the package is built on. Anything nobody has decided is
recorded as UNKNOWN in §6 rather than guessed.

## 1. What exists

### 1.1 One pricing function, one step

- **Three quote functions.** `orders/application/order-pricing.ts` has `quoteProduct`,
  `quoteAddon` and `quoteTrial`. Each applies exactly one step of `PRICING_PRECEDENCE`
  (`BASE_PRICE`, with `ruleId: null`) and computes the discount as
  `clampDiscount(subtotal, 0n)`.
- **Where the price is fixed.** A draft is priced once, when it is created:
  - `OrderService.createDraft` for `NEW_SERVICE`;
  - `CommercialActionService.draft` for `RENEW`, `ADD_TRAFFIC` and `ADD_TIME`;
  - `TrialService.claim` for `TRIAL`.
- **Confirmation does not re-price.** It re-checks orderability and nothing else
  (`order.service.ts`, "Orderability is re-checked; the PRICE is not re-quoted").
- **The snapshot is frozen.** `nexa_orders_snapshot_guard` (migration `0085`) freezes
  `subtotal_amount`, `discount_amount`, `total_amount`, `currency`, `quote` and
  `discount_code` once `confirmed_at` is set. Before that they may change.
- **The database already knows about discounts.** `orders_total_consistent_check`
  (`total = subtotal - discount`) and `orders_discount_bounded_check` exist.
- **Settlement reads only the frozen row.** `settlementRefusal` requires the payment to
  equal `orders.total_amount` exactly, in the same currency.

### 1.2 Discount tables with no code

- **`discounts` and `discount_redemptions` have existed since Phase 0.** Nothing reads or
  writes them.
- **`discounts` is code-only.** `code` is NOT NULL and unique per tenant. It carries:
  - `PERCENTAGE` 1..100 or `FIXED_AMOUNT` with a currency;
  - a window;
  - a total limit and a per-customer limit;
  - a minimum subtotal;
  - `redemption_count`, a counter that nothing increments.
- **`discount_redemptions` is unique per order**, and its FK carries the customer with
  the order.
- **Contracts with no caller:**
  - `promotions.ts` has `normaliseDiscountCode`, `discountAmountMinor`, the percentage
    bounds and `DiscountLimits`;
  - `pricing.ts` has `MAX_DISCOUNT_CODES_PER_ORDER = 1`;
  - the events `DiscountRedeemed` and `ReferralRewarded`;
  - the templates `bot.discount.applied` and `bot.discount.rejected`.
- **Permissions declared and never checked:** `catalog.pricing.edit` (HIGH) and
  `catalog.discounts.edit` (HIGH). The seeded `sales` role holds the second.
- **The Web Admin `/discounts` route** is a planned-surface placeholder.

### 1.3 Cashback

There is no cashback anywhere, only vocabulary for it:

- **Ledger reasons.** `LEDGER_REASONS` declares `CASHBACK_GATEWAY`, `CASHBACK_TOPUP`
  and `CASHBACK_RENEWAL`, named after the three legacy mechanisms. Nothing writes them.
- **Gateway field.** `PAYMENT_GATEWAY_PARITY_DEFERRALS` defers `CASHBACK_PERCENT`.
- **The wallet has one balance per customer and currency.** It is derived from the
  append-only `wallet_entries`.
  - There is no bucket, no restricted balance and no expiry.
  - `WALLET_ALLOWS_NEGATIVE_BALANCE = false`.
  - `reverses_entry_id` exists and is never written.

### 1.4 Refunds

- **An operator refund** (`RefundService.request`) may be PARTIAL. It is bounded by what
  the payment paid, less what is already consumed.
  - `WALLET_CREDIT` is born `COMPLETED`, with its ledger credit written in the same
    transaction.
  - `EXTERNAL_MANUAL` becomes `COMPLETED` later, through `complete`.
- **The automatic refund** (`refundUndeliverable`) refunds the whole remainder. It runs
  only on an order that was never delivered.
- **Neither refund knows about discounts or cashback**, because neither exists yet.

### 1.5 The legacy evidence (`docs/research`)

Summarised from a research-lookup pass, with its citations:

- **Discount codes (SBR-014..021).**
  - The value is percent only.
  - The code is saved in lower case.
  - Two caps exist, a total cap and a per-user cap.
  - The lifetime is in hours, and 0 means unlimited.
  - A code can be scoped by tier, by panel and product, and by section (buy, renew or
    both), and can be limited to a first purchase.
  - No fixed amount, no maximum discount and no minimum purchase were seen.
  - The code is applied on the pre-invoice, after the price is computed (SBR-038).
- **Per-user discount percent (UBR-004).** It exists and its runtime effect is unknown.
- **Cashback: three mechanisms** — per gateway, per tier on top-up, and on renewal.
  - None was ever observed at runtime.
  - Whether they stack is `O-6` (fallback "max wins").
  - What they are computed on, where they land and whether a refund reverses them is not
    addressed anywhere in the corpus.
- **Precedence.** `PRICING_PRECEDENCE = UNKNOWN` (SBR-033). The six-step table in
  `@nexa/contracts` is our own proposal, pending sign-off.
- **Rounding.** None was ever observed in pricing.

## 2. What the plan requires, and what is missing

| requirement (plan §8)                                                                           | today                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| One pricing boundary, deterministic quote                                                       | Three functions, one step each           |
| Discounts after the effective base, not stacked                                                 | No discount is ever applied              |
| One coupon per action; replay-safe                                                              | Tables exist; nothing writes them        |
| Eligibility: product, category, customer, window, first purchase, purpose, minimum, usage limit | Partially in the table; no evaluator     |
| Quote snapshot, re-check at confirmation                                                        | Snapshot exists; no discount to re-check |
| Cashback: earned on delivery, reversed on refund, exactly once                                  | Nothing                                  |
| Admin: rules, eligibility, priority, limits, cashback, preview                                  | A placeholder route                      |
| Customer: truthful price, discount, cashback                                                    | Price only                               |

## 3. Decisions

### P1 — One engine, pure, with three callers

`commerce/pricing/domain/pricing-engine.ts` is a pure function. It has no database, no
clock and no settings; the caller passes everything in.

**Inputs:**

- the base line: the product's or add-on's list price, or, when a draft is re-quoted,
  the draft's own `line_unit_price` and `line_quantity`;
- the purpose;
- the product, category and customer ids;
- the order currency;
- `now`;
- the candidate discount rules;
- the candidate cashback rules;
- an optional code.

**Output:** the totals, a quote with its trace, and a cashback figure.

**Callers:** `quoteProduct` and `quoteAddon` become callers of it. `quoteTrial` does
not: a trial is never discounted and never earns cashback, and it keeps its own
zero-quote function so that no rule can reach it.

The same function answers the Web Admin's price preview. The preview writes nothing,
records no redemption and holds no lock.

### P2 — Precedence

1. `BASE_PRICE` (REPLACES): the list price. It is the only replacement step that fires
   in this package. `TIER_PRICE`, `PANEL_ADJUSTMENT`, `CUSTOM_SERVICE_FORMULA` and
   `USER_OVERRIDE` still have no rules behind them, and a step with no rule is not put
   in the trace. Reseller-tier pricing (§9) is the first replacement step to be added.
2. `PROMOTIONAL_DISCOUNT` (ADJUSTS): one trace entry per applied rule, in the order
   applied, each carrying the rule's id and label and the amount before and after it.
3. The final amount is the last `amountAfter`.

Cashback is **not a step**. It never changes what the customer pays. It is recorded
beside the trace as `quote.cashback` (`{ ruleId, ruleLabel, percent, amount }` or
absent), because it is settlement, as `PRICING_PRECEDENCE`'s docblock already says. The
wire schema gains the field as optional, so a quote written before this package still
parses.

### P3 — A discount rule

`discounts` grows rather than a second table being added, because a code and an
automatic promotion share every other column.

| field                                           | meaning                                                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                          | `CODE` (applies only when the customer enters the code) or `AUTOMATIC` (applies to every eligible order)                                                                                     |
| `code`                                          | Required for `CODE`, forbidden for `AUTOMATIC` (CHECK)                                                                                                                                       |
| `label`                                         | The operator's name for it; the trace's `ruleLabel`                                                                                                                                          |
| `type`, `value`, `currency`                     | Unchanged: `PERCENTAGE` 1..100 or `FIXED_AMOUNT` in minor units with a currency                                                                                                              |
| `applies_to`                                    | A non-empty subset of `NEW_SERVICE`, `RENEW`, `ADD_TRAFFIC`, `ADD_TIME`. `TRIAL` is never a member (CHECK)                                                                                   |
| `product_id`, `category_id`                     | Optional; at most one is set. A product rule matches that product. A category rule matches products in that category. An add-on order has no product, so it matches only a rule with neither |
| `customer_id`                                   | Optional. When set, only that customer is eligible. This is the legacy per-user discount (UBR-004) as a rule rather than a column on the customer                                            |
| `first_purchase_only`                           | Eligible only for `NEW_SERVICE`, and only when the customer has no other `NEW_SERVICE` order in `AWAITING_PAYMENT` or `PAID`                                                                 |
| `minimum_subtotal_amount`                       | Unchanged; compared with the effective base, before any discount                                                                                                                             |
| `starts_at`, `ends_at`                          | Unchanged; half-open `[starts_at, ends_at)`                                                                                                                                                  |
| `total_redemptions_limit`, `per_customer_limit` | Unchanged                                                                                                                                                                                    |
| `priority`                                      | Integer; higher applies first                                                                                                                                                                |
| `stackable`                                     | Boolean, default false                                                                                                                                                                       |
| `status`                                        | `ACTIVE` or `INACTIVE` (the existing `DISCOUNT_STATUSES`)                                                                                                                                    |

`redemption_count` is dropped. Nothing ever wrote it, so it has always read zero; a
counter that the limit does not use is a second answer to "how many", and a list reads
the live count instead (P6). Nothing writes the column, so dropping it is not the
expand/contract case the migration skill warns about.

### P4 — Selection and stacking

This is deterministic, and iteration order never decides it.

1. **Build the candidates.** They are every eligible `AUTOMATIC` rule, plus the entered
   code's rule if a code was entered.
   - An entered code that is unknown or ineligible is REFUSED. It is never silently
     ignored: a customer who typed a code is owed an answer about it.
   - Every refusal reaches the customer as ONE message and one error code
     (`DISCOUNT_CODE_REJECTED`). `bot.discount.rejected`'s frozen description already
     says why: telling a customer that a code exists but is exhausted is an oracle for
     guessing codes. The reason (`DISCOUNT_REFUSAL_REASONS`) goes into the error details
     and the audit row. The operator's preview shows it.
2. **Order them** by `priority` descending, then by id ascending. Ids are UUIDv7, so
   among equal priorities the older rule comes first.
3. **Apply the first.** Each later candidate is applied only if it AND every rule
   already applied are `stackable`. So a non-stackable rule applied first stands alone,
   and a non-stackable rule reached later is skipped.
4. **An entered code that was skipped is refused**, with reason `NOT_COMBINABLE`, and
   the draft keeps the quote it had. Silently dropping the code would show a price the
   customer believes includes a code that did nothing.
5. **Compute each rule on the running amount**, meaning the amount after the rules
   before it, never on the base. Stacked percentages therefore compound and can never
   pass 100%.
6. **Clamp each step** with `clampDiscount`, so the payable amount is never negative.

`MAX_DISCOUNT_CODES_PER_ORDER = 1` stands: a draft holds at most one code
(`orders.discount_code`), and entering a second replaces the first.

### P5 — Rounding

- **Discount: rounded UP to the minor unit, in the customer's favour.**
  `discountAmountMinor`'s docblock always said so ("rounds in the CUSTOMER's favour").
  Its body truncated toward zero, which is the opposite: the discount comes out smaller
  and the customer pays the fraction. Nothing called it, so the fix changes no
  observable behaviour, and it is pinned by a test at the boundary (`10% of 1005` is
  `101`).
- **Cashback: rounded DOWN.** A stated percentage is a ceiling on what is credited,
  never exceeded by a minor unit.
- **A reversal is computed from the cumulative refunded amount**, not per refund, so a
  series of partial refunds cannot drift from the full-refund answer (P9).

### P6 — The quote a customer saw, and confirmation

- **Automatic rules apply at draft creation.** This holds for every purpose except
  `TRIAL`.
- **Entering a code re-quotes the DRAFT from the draft's own snapshot base**, never from
  the live list price. So a price change between draft and code does not reach the
  customer. The same goes for removing a code.
  - `orders.discount_code`, the totals and the quote change in one statement, which the
    snapshot guard permits only while `confirmed_at` is NULL.
- **Confirmation never re-prices.** It re-checks every applied rule inside the
  confirming transaction, under the rule's row lock (`FOR UPDATE`, in id order, after the
  order lock):
  - it is still `ACTIVE`;
  - `now` is inside its window;
  - its scope still matches;
  - the total limit and the per-customer limit have room;
  - a first-purchase rule's customer has no other live `NEW_SERVICE` order.
- **A rule that fails is a refusal** (`DISCOUNT_NO_LONGER_VALID`), not a silent new
  price. The customer starts the order again and sees the new quote.
- **A rule that PASSES is honoured at the quoted amount**, even if an operator has
  since changed its value.
- **A passing rule becomes a `discount_redemptions` row** for that order and rule, with
  the amount the trace took off.
- **Limits count live redemptions** — those whose order is `AWAITING_PAYMENT` or `PAID`.
  A cancelled, expired or refunded order frees its use without anything having to run,
  exactly as a capacity hold does. UNK-S010/011's fallback is "redemptions", and this
  is it.
- **The rule lock is what makes the last use exclusive.** Two confirmations reaching
  for it serialise on the row, and the second counts the first.
- **First purchase is serialised per customer** by a transaction-scoped advisory lock on
  `(tenant, customer)`. Only confirmation takes it, so it cannot close a cycle with any
  other lock.
- **`redemption_count`'s docblock claimed** "the conditional UPDATE that increments it"
  was the authority. No such UPDATE ever existed. The live count under the row lock is
  now the authority.
- **`discount_redemptions` is unique on `(tenant_id, order_id, discount_id)`**, no
  longer on the order alone, because a stacked order redeems more than one rule.
  Applying the same code twice still produces one row.
- **`DiscountRedeemed` is emitted once per redemption row**, in the confirming
  transaction.

### P7 — Commercial actions

- **Automatic rules apply to `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` at draft time.** The
  quote comes from the same engine, and `service_commercial_actions.amount` records the
  discounted total.
- **Customer-entered codes on those purposes are NOT built.** The commercial evidence
  row is append-only (`0048`) and written with the draft, so a code entered after it
  would leave the row naming a different amount from the order. A code would have to be
  captured before the draft exists, which is a different flow. OQ-WP8-01.

### P8 — Cashback rules

`cashback_rules` is its own table: cashback is not a discount and shares none of a
discount's semantics beyond eligibility.

| field                       | meaning                                      |
| --------------------------- | -------------------------------------------- |
| `label`, `status`           | as for a discount                            |
| `percent`                   | 1..100                                       |
| `applies_to`                | a non-empty subset of the four paid purposes |
| `product_id`, `category_id` | optional, at most one                        |
| `starts_at`, `ends_at`      | half-open                                    |

- **Selection: the eligible rule with the highest percent**, then by id ascending. This
  is the `O-6` fallback ("max wins"); rules never stack.
- **Basis: the final payable amount**, after every discount.
- **None on a zero total**, so a fully discounted order earns nothing, and none on a
  trial.
- **The rule is snapshotted into the quote at draft time.** At confirmation, an
  `order_cashback` row is written: order, customer, rule, percent, amount, currency,
  state `PENDING`.
- **Not re-checked at confirmation.** Cashback is a promise made in the quote, not a
  price. A rule disabled after the customer saw it does not take the promise away.

### P9 — Cashback lifecycle

- **Earned at delivery.** Delivery is an operation of type `PURCHASED_AS[order.purpose]`
  with this `order_id` in state `SUCCEEDED`, which is the provisioner's own definition of
  what the order bought. An `order_cashback` row moves `PENDING -> EARNED` only then.
  - A wallet `CREDIT` is written with reason `CASHBACK_PURCHASE` and reference
    `${orderId}:cashback`.
  - The reference is unique per tenant, so a replay writes nothing.
- **Where earning runs: a lane, not thirteen call sites.**
  - `CashbackEarner.earnDue` runs in the provisioner loop after the outcome announcer.
    It finds `PENDING` rows whose delivery succeeded, bounded and in id order.
  - It also runs for the one order just delivered, immediately.
  - A crash between the two costs a delay, never the credit: the row is still
    `PENDING` and the next tick finds it.
  - The provisioner transitions operations to `SUCCEEDED` in thirteen places. A hook in
    each is thirteen chances to forget one.
- **Void, never earned, when the order ends without delivery.** An order that is
  `REFUNDED`, `CANCELLED` or `EXPIRED` has its row moved `PENDING -> VOID` by the same
  lane. A provider failure refunds the order before delivery, so no cashback was ever
  credited for it.
- **Amount earned.** It is `floor(snapshot × (paid − refunded) / paid)`, where
  `refunded` is the sum of this payment's `COMPLETED` refunds at the moment of earning. A
  refund that completed before delivery therefore reduces what is earned rather than
  having to be reversed.
- **Reversal on refund.** When a refund of an order whose cashback is `EARNED` reaches
  `COMPLETED`, in that same transaction:
  - the new target is `floor(snapshot × (paid − refunded) / paid)`;
  - `due` is what has been earned, less the target, less what reversals have already
    recorded;
  - if `due > 0`, a wallet `DEBIT` with reason `CASHBACK_REVERSAL` takes
    `min(due, balance)`, with reference `${refundId}:cashback-reversal`;
  - an append-only `cashback_reversals` row records `due`, `recovered` and
    `unrecovered`.
  - A full refund therefore reverses the whole credit. A partial refund reverses its
    share, and the shares add up to the whole.
- **Reversal after the cashback was spent — the liability rule.**
  - The balance never goes negative, and history is never edited.
  - What cannot be taken from the balance is recorded as `unrecovered` on the reversal
    row. It is visible to the operator on the order and is not collected automatically.
  - On a `WALLET_CREDIT` refund this can never happen: the credit lands in the same
    transaction first, and the credit is always at least the reversal.
  - Only a refund paid outside the wallet can leave a shortfall.
- **Locks.** The earner takes the customer lock (`wallet.lockCustomer`), then the
  `order_cashback` row. A refund already holds the payment or refund row, then takes the
  same two in the same order. The earner never locks a payment or a refund, so no cycle
  exists.

### P10 — Spending

Earned cashback is ordinary wallet balance. The existing wallet purchase is its
spending path: atomic under the customer lock, and idempotent by reference. A
restricted or expiring cashback balance is not built (OQ-WP8-03).

### P11 — Customer surfaces (Telegram)

- **The order summary** comes in four frozen variants:
  - `bot.order.summary`, unchanged;
  - `bot.order.summary_discounted`, with the subtotal, the discount and the total;
  - `bot.order.summary_cashback`, with a cashback line;
  - `bot.order.summary_discounted_cashback`, with both.

  The template renderer has no conditional lines: a missing value renders as its literal
  token. So a variant per shape is the only way that no customer ever reads `{discount}`
  or a `0` discount line. The cashback line says the amount will be credited to the
  wallet after delivery. That sentence is true of a `PENDING` promise, and it says nothing
  about when.

- **A "discount code" button on a `NEW_SERVICE` summary** opens a capture window
  (`discount_code_captures`), modelled on `username_captures`: one open window per
  customer and bot, tied to the order, and expiring.
  - The customer's next ordinary message is offered to the window.
  - `USERNAME_TEXT`'s handler asks the username window first and the code window second;
    `NO_WINDOW` from both is the old fallback.
  - Opening either window supersedes the other's open window for that customer and bot,
    so a message can never be read by two windows.
- **Code outcomes.** An accepted code re-renders the summary. A refused one answers
  `bot.discount.rejected` with the reason, and leaves the window open for another try. A
  "remove code" button clears it.
- **Commercial quotes** (`bot.service.action_quote`) show the discounted total. They
  have no code button (P7).

### P12 — Operator surfaces

Permissions:

- `catalog.discounts.edit` — create, edit, activate and deactivate discount rules.
- `catalog.pricing.edit` — the same for cashback rules. Cashback is a liability the
  tenant takes on for every order, which is pricing, not a promotion.
- `catalog.view` — read both lists and run the price preview.

The Web Admin:

- **Discounts.** This replaces the placeholder: a list with live use counts, and
  create/edit with every P3 field.
- **Cashback.** A list and create/edit.
- **Price preview.** The inputs are a product or add-on, a purpose, optionally a
  customer, and optionally a code. The output is the full trace and the cashback. It is
  a GET and writes nothing.
  - Without a customer, a first-purchase or customer-scoped rule is shown as "depends on
    the customer" rather than assumed.
- **Order detail.** It shows the discount lines from the quote trace, the redemptions,
  and the cashback row with its state and any reversal shortfall.

Editing a rule affects future quotes only. A confirmed order keeps its quote, its
redemptions and its cashback snapshot.

## 4. Contracts

These are their own commits:

- **Discounts:** `DISCOUNT_KINDS` and `DISCOUNTABLE_PURPOSES`.
- **Cashback:** `CASHBACK_RULE_STATUSES` and `CASHBACK_STATES` (`PENDING`, `EARNED`,
  `VOID`).
- **Ledger reasons:** `CASHBACK_PURCHASE` and `CASHBACK_REVERSAL`. The second is added to
  `REVERSAL_REASONS`.
- **Events:** `CashbackEarned` and `CashbackReversed`.
- **Error codes:**
  - `DISCOUNT_CODE_REJECTED` (one code for every reason, with the reason in its
    details)
  - `DISCOUNT_NO_LONGER_VALID`
  - `DISCOUNT_CODE_TAKEN`
  - `DISCOUNT_NOT_FOUND`
  - `CASHBACK_RULE_NOT_FOUND`
- **Quote wire:** an optional `cashback`.
- **HTTP shapes:** discount and cashback-rule CRUD, the preview, and the order detail's
  adjustments and cashback.
- **Templates:**
  - the summary's discount and cashback lines;
  - the code prompt;
  - the reasons for `bot.discount.rejected`.
- **`discountAmountMinor`:** the rounding fix (P5).

## 5. Tests the package owes

- **Engine (unit):**
  - precedence;
  - the stacking algorithm, including a non-stackable rule first, a non-stackable rule
    later, and a code skipped for stacking;
  - rounding at the boundaries;
  - the clamp;
  - determinism under shuffled candidates.
- **Integration:**
  - the last use raced by two confirmations, behind a row-lock barrier;
  - the per-customer limit;
  - first purchase, raced;
  - a rule disabled or edited between draft and confirmation;
  - a live price change not reaching a draft that gets a code;
  - replaying a code;
  - cashback earned exactly once when the lane and the immediate call race;
  - VOID on refund-before-delivery;
  - full and partial reversal, and a sequence of partial reversals summing to the whole;
  - a shortfall after spend;
  - tenant isolation for rules, preview and redemptions.
- **HTTP and web:** each permission refusal, and the preview writing nothing.
- **Falsification:** one mutation per rule above, recorded in
  `docs/wp8-falsification.md`.

## 6. UNKNOWN

| id        | question                                                                                             | what WP8 does meanwhile                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| OQ-WP8-01 | Should a customer be able to enter a code on a renewal or add-on? Legacy allowed renewals (SBR-021). | Automatic rules apply to them; entered codes are for new purchases only (P7).                                   |
| OQ-WP8-02 | Does cashback apply to a purchase paid from the wallet, including from earlier cashback?             | Yes: the basis is what was paid, whatever the rail. A rail dimension is one more eligibility column.            |
| OQ-WP8-03 | Is cashback a restricted or expiring balance?                                                        | No: ordinary wallet balance (P10).                                                                              |
| OQ-WP8-04 | The legacy per-gateway and top-up cashback (FBR-006, WEB-BR-021).                                    | Not built. Cashback here is earned on delivered orders only.                                                    |
| OQ-WP8-05 | Is an unrecovered reversal ever collected, and how?                                                  | Recorded on the reversal row and shown to the operator; never collected automatically (P9).                     |
| OQ-WP8-06 | Does a per-customer discount stack with a code (UNK-UM-003)?                                         | By configuration: both are rules, and `stackable` and `priority` decide (P4).                                   |
| OQ-WP8-07 | `PRICING_PRECEDENCE` is still pending owner sign-off (O-1).                                          | Only `BASE_PRICE` and `PROMOTIONAL_DISCOUNT` fire; their relative order is the one every draft already assumes. |
