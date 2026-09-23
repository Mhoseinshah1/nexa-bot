# WP6 — Trial and customer service operations: audit and design

Plan §7. This file records what existed on `main` at d91f678 before any WP6 code, the
conflicts between earlier decisions, and the design each part of WP6 follows. WP6 ships
as three pull requests, each with its own single review:

| part  | what                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| WP6-A | a customer takes a trial; it is provisioned through the paid path; a definitive failure gives the eligibility back |
| WP6-B | trial administration from ADR-0015: per-customer overrides, the global reset, the operator's view                  |
| WP6-C | customer self-service link rotation, behind its own flag and cooldown                                              |

## 1. What existed

### Trial

- **ADR-0015 is accepted product policy.** A trial allowance is a _limit_ and a _used_
  count, stored separately. There is a global default limit, an optional persistent
  per-customer override, and a global reset that zeroes consumption and leaves the
  overrides alone. `0` means zero trials and never unlimited. The ADR records the
  semantics and deliberately created no table.
- **Phase 4 declared the mechanism and nothing uses it.** `promotions.ts` has
  `TRIAL_REJECTIONS` (`UNCONFIGURED`, `ALREADY_TAKEN`, `CUSTOMER_BLOCKED`,
  `PRODUCT_UNAVAILABLE`) and `TRIALS_PER_CUSTOMER = 1`. `events.ts` has `TrialIssued`,
  and `templates.ts` has `bot.trial.unavailable` and `bot.trial.issued`. Migration
  `0032` created `trial_grants` with a unique index on `(tenant_id, customer_id)`.
  Nothing in `apps/` reads or writes any of these.
- **Those two records conflict, and the Phase 4 one also conflicts with the plan.**
  - The unique index allows one trial per customer, ever. ADR-0015 allows a
    configurable limit, an override of, for example, five, and a reset.
  - The `trial_grants` docblock says a failed provisioning must still consume the
    grant, "which is the abuse a nullable service would otherwise open". Plan §7.1 says
    the opposite: "failed provider create must not incorrectly consume eligibility".
- **A service cannot exist without an order.**
  - `services.order_id` is NOT NULL.
  - Its foreign key is `(tenant_id, order_id, customer_id)`.
  - Trigger `nexa_services_require_purchase_order` (`0050`) raises unless the order's
    purpose is `NEW_SERVICE`.
  - The provisioner reads the purchased specification from the order
    (`purchases.specificationFor`).
- **The provisioner's refund lane has no payment-less exit.**
  - `refundPurchase` returns early when no confirmed payment exists. The service is
    left `PENDING_PROVISION`, where it holds a capacity slot, and the order is not
    closed.
  - `UndeliverableOrderRefunder.refund` requires a `PaymentRecord`.
- **A zero-total order is legal in the table, but it cannot settle.** The
  `orders_amounts_check` constraint is `>= 0`. Settlement, however, requires a
  CONFIRMED payment equal to the total, and `payments_amount_check` is `amount > 0`.

### Customer service operations

These already exist, for the customer, on Telegram:

- list and detail;
- stored usage with its `syncedAt` stamp;
- resend the link;
- renew, add traffic and add time;
- suspend and resume;
- terminate, as a two-tap action.

Every one of them checks ownership against the service row (`getForCustomer`, and
`CommercialActionService.ownedService`). Every one re-checks the legal state, panel
operability and scope activity inside its transaction. Terminate is a Phase 4E product
decision and stays.

Missing are link rotation (operator-only, deferred to WP6 by `rickpanel-rotate-audit.md`
D1 and OQ-RP-08) and a customer usage refresh (`SYNC_USAGE` is not a customer
operation). No per-customer rate limit exists on any customer action.

### Settings and flags

- **Settings** are tenant-scoped, declared in `settings.ts` and read through
  `SettingsResolver.valueOf`.
- **Flags** are booleans in `features.ts`, read through `FeatureFlagResolver.isEnabled`.
  A flag names its settings in `configuredBy`, and a test asserts the link is
  symmetric.
- **Rule on adding a flag:** a flag is added only when the code behind it is reachable.

## 2. Decisions for WP6-A

### A1 — A trial is an order with purpose `TRIAL` and a zero total

Every alternative is worse:

- **A service without an order** would make `services.order_id` nullable and would
  touch every reader of it.
- **A `NEW_SERVICE` order at zero** would be settled by nothing and indistinguishable
  from a pricing bug.

So:

- `TRIAL` joins `ORDER_PURPOSES`, and `orderPurposeCreatesNewService(TRIAL)` is true.
  A trial takes a capacity slot, is decided by the same eligibility evaluator and is
  provisioned by the same `PROVISION` operation.
- The service trigger is replaced by one that accepts `NEW_SERVICE` or `TRIAL`.
- The line snapshot is the product's **specification** at the moment of the grant:
  panel, duration and traffic. The snapshot guard freezes it at `confirmed_at`, so
  editing the trial product later changes nothing already granted. This is §7.1's
  "no mutable paid-product values without snapshotting".
- The order carries the tenant's `sales.currency` and a total of zero.

### A2 — `DRAFT → PAID` on a new event, `GRANT`, guarded by `orderIsFreeTrial`

- `PAID` is the state provisioning acts on, and a trial has to be provisioned. The
  guard is named in the contract and implemented where the transition is written. The
  transition requires `purpose = TRIAL` and a zero total, so no priced order can take
  this edge.
- `settlementIsFunded` does not apply, and that is the point. No money exists, so
  nothing can fund it, and nothing needs to.
- No payment row is written. `payments_amount_check` would refuse one anyway, correctly.

### A3 — Eligibility is limit minus used, decided under the customer's lock

- **limit:** the `trial.limit_per_customer` setting. It is an integer ≥ 0 with
  `zeroMeaning: 'LITERAL'`, where `0` means no trials, per ADR-0015. WP6-B adds the
  per-customer override on top.
- **used:** the number of this customer's grants that are not released.
- **Why a lock and not a count alone:** a count is a read followed by a write. The
  claim takes `lockCustomer` first, the same lock settlement takes, so two concurrent
  claims serialise and the second one counts the first.
- **The unique index `trial_grants_customer_key` is dropped.** It encodes "one, ever",
  which ADR-0015 overrides. It is replaced by `(tenant_id, order_id)`: one grant per
  trial order.
- **`TRIALS_PER_CUSTOMER` is removed from the contracts.** A constant that nothing
  reads, and that says something the policy denies, is worse than no constant.
- **`ALREADY_TAKEN` becomes `LIMIT_REACHED`.** With a limit it is the truthful name,
  and nothing consumed the old one.

### A4 — A definitive failure gives the eligibility back; an unknown one never does

- **The lane is the one a paid order uses.** `refundPurchase` treats a `TRIAL` order
  as bought as `PROVISION`. On a definitive failure it:
  - terminates the service;
  - releases the grant (`released_at`);
  - hands the order to `UndeliverableOrderRefunder` with no payment. The refunder
    accepts that only for a zero-total `TRIAL`. It moves the order `PAID → REFUNDED`,
    releases the slot and the name, credits nothing, and tells the customer through a
    new notification kind, `TRIAL_NOT_DELIVERED`.
- **`REFUNDED` is not a stretch.** An order has two outcomes, delivered or given back
  in full, and for a trial "in full" is nothing. The alternative is a third state for
  a paid-looking order, and CLAUDE.md forbids a third outcome.
- **`UNKNOWN` goes to `UNRECONCILED` and keeps the grant.** A create whose answer was
  lost may exist on the panel. Releasing the grant then would let the customer take a
  second trial while holding the first.
- **A `RECONCILE` that proves the account absent for the last time** reaches the same
  lane, exactly as it does for a paid order.
- **A priced order with no payment still declines.** The refunder's money rule is
  unchanged.

### A5 — Usernames: automatic only

- The claim reserves through `OrderUsernameLane.require`, which takes the panel's
  automatic mode.
- A panel whose policy allows only a typed name refuses with `PRODUCT_UNAVAILABLE`,
  rather than silently breaking its own policy with an `nx…` name.
- The customer's name is released with the order on a definitive failure, the same as
  a paid order's.

### A6 — Disabled by default, explicit configuration required

- **The flag:** `trials`, with `defaultEnabled: false`, `blastRadius: 'LOCAL'` and
  `configuredBy: ['trial.product_id', 'trial.limit_per_customer']`.
- **`trial.product_id`:** a product id or null, default null. Null is `UNCONFIGURED`.
- **The trial product** must be `ACTIVE` and have a panel. It needs **no price**; a
  product without one is `NOT_PRICED`, so the catalogue never sells it.
- **Any audience is accepted.** Pointing the trial at a sellable product is the
  operator's choice to make.

### A7 — The customer surface: an offer, not a keyboard promise

- `bot-commands.ts` refuses menu entries for things that may not be offered. So the
  trial is an inline button on the catalogue screen, drawn only when this customer can
  take a trial now: flag on, configured, product available and used < limit.
- The tap is re-decided on the server, like every other button.
- The tap is idempotent by the update key.
- A success answers `bot.trial.issued`. The link then arrives through the ordinary
  delivery lane, exactly as it does for a purchase.
- Every refusal answers `bot.trial.unavailable`, a single message as the template's
  own description says. The reason is recorded in the audit row and is not shown.

### A8 — What a trial never touches

It writes no wallet entry, no payment, no discount redemption, no referral and no
reseller margin. Tests assert the ledger, payments and refunds are empty afterwards.

### A9 — Who acts

- The Telegram webhook's `SYSTEM_JOB` actor, with the permission the commercial
  customer actions already take, inside `runAuthorizedMutation`.
- Scope activity is read inside the transaction.
- A blocked customer is refused as `CUSTOMER_BLOCKED` before anything is written.

## 3. Decisions for WP6-B and WP6-C, recorded now so A does not preclude them

- **WP6-B, the global reset.** It stamps `reset_at` on every unreleased, unreset grant.
  Used becomes the count of grants where both are null. It is a bulk operation, so it
  follows ADR-0010: a dry-run count, an explicit confirmation, an audited execution
  and a recorded result.
- **WP6-B, overrides.** An override is a row per customer. Removing it restores the
  global default rather than copying its value.
- **WP6-C, customer rotation.** It sits behind its own flag, off by default, and a
  per-service cooldown setting. The cooldown is checked under the service row's lock,
  and the same `ROTATE_SUBSCRIPTION` operation, capability and operability checks
  apply. It is offered only where the panel declares `ROTATE_SUBSCRIPTION_LINK`.
- **Customer usage refresh stays out.** It would let any customer drive panel calls at
  will, and nothing documents it as intended. Detail shows the stored usage and when it
  was read, which is truthful.

## 4. What the implementation added to the design

- **The Telegram claim's idempotency key is suffixed** (`<update key>:trial`), as every
  other write in that turn is. `resolveFromUpdate` has already spent the bare key in the
  same namespace, and reusing it would refuse the claim as a reused key.
- **A 500 on create is not an unknown outcome here.** The RickPanel adapter reads back
  after a 500 and proves the account absent, which is DEFINITIVE — so the trial is given
  back. A trial is kept counted only while its create is still retried or its outcome is
  unknown; `trials.test.ts` pins the retried case.
- **`0099_snapshot.json` was a verbatim copy of `0098`'s**, so both claimed the same
  parent and `drizzle-kit generate` refused to run ("collision"). The drift check passes
  on a clean tree because it generates nothing, which is why this went unnoticed. Its
  `id` is now its own and its `prevId` is `0098`'s — generator metadata only; no applied
  SQL changed.
- **A rollback to the release before this one** meets `TRIAL` orders it cannot parse.
  The older binary writes none and its provisioner declines them in `refundPurchase`
  (`PURCHASED_AS` lacks `TRIAL`), so the failure is a read error on a trial order's own
  screens, not a wrong write; `0102` keeps refusing every purpose `0050` refused.

## 5. Observed and left alone

`retireExhausted` retires a `PLANNED` operation at its attempt ceiling without a refund.
It reaches that state only when a worker died holding the last attempt, which is an
unknown outcome. So not refunding is the rule and not a gap: the `provisioning.stalled`
ERROR it writes is where an operator meets it. It applies to a trial exactly as it does
to a paid order.

## 6. UNKNOWN — product decisions nobody has made

| id        | question                                                                               | what WP6 does meanwhile                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-WP6-01 | May a customer who has already bought a service take a trial?                          | Yes. Nothing documents a restriction, and inventing one would be a policy.                                                                                                                     |
| OQ-WP6-02 | Should a trial require anything first: a channel join, a phone number, an account age? | No precondition. None is documented, and none of those identities is collected.                                                                                                                |
| OQ-WP6-03 | May a trial service be renewed or topped up like a bought one?                         | It is a service like any other once delivered: add-ons are offered to it, and a renewal is offered only when its product has a price — a trial product usually has none, so it usually is not. |
| OQ-WP6-04 | How often may a customer rotate their own link? (was OQ-RP-08)                         | WP6-C makes it a tenant setting behind a flag that is off by default.                                                                                                                          |
