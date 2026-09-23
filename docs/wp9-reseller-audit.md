# WP9-B — resellers: audit and decisions

§9 of the execution plan, second half. The referral half is `docs/wp9-referral-audit.md`
and shipped first. This document records what existed before this package, then the
decisions R1–R14, then what is deliberately not built. Open questions are
`OQ-WP9-04`… in `docs/open-questions.md`.

The plan's governing line is kept in front of every decision here: **reseller margin,
customer discount, referral commission, cashback and wallet credit are five different
things and none of them is folded into another.**

## 1. What exists before this package

| Thing                                            | Where                                                                      | State                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resellers` table                                | migration 0032, `schema.ts`                                                | Created and never written. One row per customer (`resellers_customer_key`); `status` ACTIVE/SUSPENDED; `pricing_mode` LIST_PRICE/PERCENTAGE_DISCOUNT with `discount_percentage` 1–100 bound to the mode; `credit_limit_amount >= 0` with a currency. |
| `RESELLER_*` contracts                           | `promotions.ts`                                                            | Statuses, pricing modes ("a rate, never a price list"), `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR = 0n`, `debitIsWithinMeans` — unused.                                                                                                                   |
| `WALLET_ALLOWS_NEGATIVE_BALANCE = false`         | `payment.ts`                                                               | Its docblock names a reseller credit limit as "the ONE exception … a per-customer allowance checked against this floor — not a second code path".                                                                                                    |
| `canCover`                                       | `wallet/domain/balance.ts`                                                 | The one sufficiency check; its comment says the allowance arrives "as an argument here".                                                                                                                                                             |
| `RESELLERS_ONLY` audience                        | `catalog.ts`; excluded in `catalog-visibility.ts` and three SQL predicates | Failed closed in 4B because no reseller identity existed; the exclusion names this package as its trigger.                                                                                                                                           |
| `TIER_PRICE`, `USER_OVERRIDE` steps              | `pricing.ts` `PRICING_PRECEDENCE`                                          | Declared, `REPLACES`, never fired (OQ-WP8-07).                                                                                                                                                                                                       |
| `resellers.view` / `resellers.edit`              | `permissions.ts`                                                           | Declared; owner holds everything, observer holds every LOW key. No other seed role.                                                                                                                                                                  |
| `RESELLER_SETTLEMENT`, `RESELLER_MEMBERSHIP_FEE` | ledger reasons                                                             | Reserved, no producer. Not used here (R14).                                                                                                                                                                                                          |
| Reseller **bots**                                | `tenants.kind = RESELLER_BOT`, `parent_tenant_id`                          | A different concept: a sub-tenant running its own bot. Out of scope (R14).                                                                                                                                                                           |
| Web Admin `/resellers`                           | `app.tsx`, `planned.tsx`                                                   | A planned placeholder.                                                                                                                                                                                                                               |

There is no `CustomerTier` anywhere, and the legacy "one enum, four subsystems" (`f`/`n`/`n2`)
is the failure the contracts warn about. A reseller tier here is **its own table** and is
never a customer attribute, an admin role or a payment-route audience.

## 2. Decisions

**R1 — A reseller is a customer with a reseller row; the row is the whole identity.**
Tenant-scoped, one per customer, registered by an operator (`resellers.edit`). There is no
self-service application. A customer without a row, or with a `SUSPENDED` one, is an
ordinary customer in every respect: list price, no credit, no reseller-only products, and
no entitlement constraints. Suspension withdraws reseller privileges; blocking the
customer is the separate, existing lever.

**R2 — Tiers are tenant-scoped rows, and every reseller has exactly one.**
`reseller_tiers`: a name, a pricing policy and a credit policy. `resellers.tier_id` is
NOT NULL. A tier is edited in place and never deleted while referenced. Changing a tier,
or moving a reseller to another tier, affects only commercial actions **confirmed
afterwards**; a confirmed order carries its snapshot (R9).

**R3 — Pricing inheritance is deterministic, and each layer is a trace step.**

1. `BASE_PRICE` — the catalogue's list price, as today.
2. `TIER_PRICE` — the tier's policy: `LIST_PRICE` (no change) or `PERCENTAGE_DISCOUNT`.
3. `USER_OVERRIDE` — the reseller's own policy, when it is not `TIER`: `LIST_PRICE` or its
   own `PERCENTAGE_DISCOUNT`. The existing `pricing_mode` gains a third value, `TIER`, the
   default, meaning "no override".
4. `PROMOTIONAL_DISCOUNT` — WP8's rules, applied to the reseller price, unchanged.
5. The final total.

A layer that changes nothing adds no step, for WP8's reason: a step that did not fire reads
later as evidence that a rule was considered. Only one of steps 2 and 3 fires, because
the override REPLACES the tier. The percentage is taken off the list subtotal and rounds in
the reseller's favour, using the discount engine's own rounding, so there is one rounding
rule in the codebase.

**R4 — The reseller price is the order's subtotal; promotions are its discount.**
`orders.subtotal_amount` is the reseller cost, `discount_amount` stays promotions only, and
the line keeps the catalogue's list unit price. The list and the reseller cost are both in
the quote's trace, so nothing is derived from live settings afterwards, and the reseller's
margin is never counted as a customer discount.

**R5 — Entitlements fail closed, per dimension, with an explicit "all".**
A tier grants rows `(kind, subject)`, where the kinds are `PRODUCT`, `CATEGORY`, `PANEL`,
`BOT` and `OPERATION`. A row with a null subject grants every subject of its kind. **No row
of a kind grants nothing of that kind.** A new tier grants nothing, so a reseller on it
can buy nothing until an operator says what.

An ACTIVE reseller may take a commercial action only if all four of these hold:

- the operation (the order's purpose) is granted;
- the product is granted, or its category is;
- the product's panel is granted;
- the bot the request arrives through is granted.

`RESELLERS_ONLY` products become orderable for exactly these customers and remain refused
to everyone else.

**R6 — One evaluator, `ResellerEntitlements.decide`, with every caller named.**

| Caller                                  | Role                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| customer catalogue (Telegram)           | a courtesy filter, never trusted                                                |
| `OrderService.createDraft`              | refuses before a draft exists                                                   |
| `OrderService.confirm`                  | **authoritative**, inside the confirming transaction, and snapshotted (R9)      |
| `CommercialActionService` (renew / add) | refuses before the order exists; its confirmation goes through the same confirm |

A refusal is `RESELLER_NOT_ENTITLED` with the failing dimension in the details. The customer
is told `bot.order.unavailable`, the same sentence as `NOT_FOR_AUDIENCE`, so the bot does not
enumerate a tier's grants. The Telegram scope carries the bot, and a request with no bot
(an HTTP path) fails the `BOT` dimension unless the tier grants every bot.

**R7 — Entitlement is judged at confirmation and not re-judged at settlement.**
Confirmation is the moment the customer agrees to a price and the system agrees to sell, and
it is recorded. A grant withdrawn after that does not unwind an order the customer is
already paying, exactly as a price change does not re-price it (WP8 P6). The background lanes
(settlement, the provisioner) are protected by construction, not by a second check.
Nothing reaches them without passing confirmation, and confirmation writes the
entitlement's record (R9) in the same transaction as `DRAFT → AWAITING_PAYMENT`. So a
confirmed reseller order with no such record cannot exist, and a test pins that.

**R8 — Credit is an allowance below zero, enforced once, under the customer's lock.**
The effective limit is the reseller's own `credit_limit`, or the tier's when the reseller's
is null. Zero means no debt. It applies only to an ACTIVE reseller, and only in the limit's
own currency; a different currency gets no credit. It is read **inside** the wallet
settlement transaction, after `lockCustomer`, and passed to `canCover` as the allowance.
Two concurrent purchases therefore serialise on the lock, and the second sees the first's
debit. The limit is live, not snapshotted: it is a policy on the wallet, and it applies
when money moves, not when the customer agreed a price.

Credit is for purchases only. An operator's manual debit still cannot take a balance below
zero; manual changes stay the audited, compensating entries they already are. A refund
credits back the exact amount, as a compensating entry, and never needs to know the balance
was negative. The cashback and referral reversals already cap at `max(balance, 0)`.

**R9 — A reseller purchase is snapshotted at confirmation.**
`order_reseller_terms`, one row per order, append-only, written in the confirming
transaction. It holds:

- the reseller and tier ids, and the tier name as it was;
- the pricing layer that fired (`TIER`, `OVERRIDE` or `LIST`) and its percentage;
- the list amount, the reseller cost, the promotion discount and the sale amount;
- the margin (list minus cost) and the currency;
- the bot.

The confirmation re-derives the reseller layer from **live** terms and compares it with
the layer the quote recorded. Any difference refuses with `RESELLER_TERMS_CHANGED` and a
"start again" sentence; the order is never re-priced. This is the same rule WP8 applies to
a discount withdrawn between a quote and its confirmation.

**R10 — Refunds unwind through the existing single path.**
`RefundService` is untouched: a reseller order refunded as undeliverable, or refunded by an
operator, credits back what was paid, once. The snapshot is never rewritten, so the margin
of a refunded order stays what it was when it was sold, and reports read the refund beside
it.

**R11 — Operator writes are audited, idempotent and scope-checked.**
All of these need `resellers.edit`:

- create or update a tier;
- replace a tier's grants, as an atomic set with the before and after in the audit row;
- register a customer as a reseller;
- update a reseller's tier, status, pricing override or credit limit.

Reads need `resellers.view`. `finance` gains `resellers.view`, through a migration
backfill, so the people who read the ledger can read who has credit.

**R12 — Surfaces.**

HTTP:

- `GET/POST /reseller-tiers`, `GET/POST /reseller-tiers/:id`, `POST /reseller-tiers/:id/grants`;
- `GET/POST /resellers`, with search by Telegram id or name, tier and status;
- `GET/POST /resellers/:customerId`;
- the order pricing read gains the reseller snapshot.

Web Admin:

- a Resellers page that replaces the placeholder, with search, detail and editor, and the
  balance linked to the existing wallet ledger;
- a Tiers page with the grants editor;
- a reseller card on the customer page;
- a reseller block on the order's pricing card.

Telegram gains nothing new. The reseller buys through the ordinary flow, and the summary
shows the quote with the reseller price.

**R13 — Deliberately separate from the rest of §8 and §9.**

- Referral commission and cashback are computed on the **final** total, whoever the buyer
  is, exactly as before.
- A reseller's credit is not a wallet reason.
- A reseller's margin is not a discount row.
- Nothing here writes a ledger entry except the existing purchase debit, which may now go
  below zero within the limit.

**R14 — Not built.**

- Reseller sub-bots (`RESELLER_BOT` tenants).
- A reseller membership fee (O-3) and periodic settlement (O-4): `RESELLER_SETTLEMENT` and
  `RESELLER_MEMBERSHIP_FEE` stay reserved.
- A monthly floor (O-2).
- Per-product reseller price lists: the contract says a rate, never a price list.
- A reseller commission on their own customers' purchases. There is no reseller-owned
  customer base here; that is the sub-bot model.
- Showing the reseller price in the catalogue list. The list shows the catalogue price, and
  the summary shows what the reseller pays (OQ-WP9-05).
