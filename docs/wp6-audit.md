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
- **A rollback to the release before this one** meets `TRIAL` orders it cannot settle.
  Its `claimDue` takes any `PLANNED` operation, so it can create a pending trial's
  account (harmless). On a DEFINITIVE failure, though, its `refundPurchase` returns
  early (`PURCHASED_AS` lacks `TRIAL`). The operation is `FAILED`, the order stays
  `PAID`, the service stays `PENDING_PROVISION` and the grant keeps counting (Codex,
  PR #64). That release cannot be changed, and a sweep in this one cannot tell those
  leftovers from `retireExhausted`'s: both are `FAILED`, and the latter is an UNKNOWN
  outcome that must keep the grant. So the shape is left for the operator's
  `retryProvisioning`, the remedy the stalled case already uses. `trials.test.ts`
  proves both of the retry's outcomes on this release: delivered, or given back. No
  money is at stake either way; a trial moves none.

- **Codex, PR #64, four more.**
  - A refusal is now remembered under the claim's key. A second delivery of one update
    re-reads that key under the customer lock, so it answers as a replay rather than
    deciding again.
  - The claim carries the product its decision approved instead of reading it twice.
  - The offer asks the catalogue's eligibility evaluator and the username lane before
    drawing the button.
  - The `trials` flag is `TENANT_WIDE`.

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

## 7. WP6-B design — the override, the reset and the operator's view

Written before the code, as §2 was for WP6-A. ADR-0015 is the policy. This section says
where each of its sentences lives.

### B1 — One evaluator for the allowance

`TrialAllowance` = `{ globalLimit, override, effectiveLimit, used, remaining }`, computed
in one place: `trialAllowanceFor`. `TrialService` decides a claim with it, under the
customer's row lock. The operator's view renders the same function outside the lock. A
second copy would be the button and the decision disagreeing, which is the Phase 6B
eligibility rule applied to a smaller table.

- `effectiveLimit` = `override ?? trial.limit_per_customer`.
- `used` = grants with `released_at IS NULL AND reset_at IS NULL`.
- `remaining` = `max(0, effectiveLimit − used)`. It is derived and never stored.
- When an override is set, even to `0`, the global value is not consulted. Zero is zero
  (ADR-0015).

### B2 — An override is a row per customer

- It lives in `trial_limit_overrides(tenant_id, customer_id)`, with the primary key on
  that pair and the limit bounded by the same `TRIAL_LIMIT_MIN..MAX` as the setting.
- Setting it upserts the row. Removing it deletes the row. Nothing ever copies the global
  value into it, so after a removal a later change to the default applies to that
  customer again.
- Both writes take the customer's row lock (`wallet.lockCustomer`), the lock a claim
  decides under. An override therefore never lands in the middle of a claim's decision:
  the claim sees the old limit or the new one, never a mixture.
- The permission is a new key, `users.trial.edit` (HIGH). `users.edit` is uncharged on
  purpose (every customer attribute comes from Telegram), and a trial limit is not a
  Telegram attribute, so reusing that key would hand it an argument it was never given.
  It is seeded to `operator`, and a hand-written migration backfills it into the existing system roles.
- The change is audited with its before and after values. No event is written: nothing
  reacts to an override, and `events.ts` admits only what another module must react to.

### B3 — The global reset follows ADR-0010

1. **Dry run.** `previewReset` counts the grants that would be stamped and the
   customers they belong to, states the set's `fingerprint` (MD5 over the grant ids in
   id order), and returns a sample of at most ten customers. It writes nothing. All of
   it is ONE statement, so the totals, the fingerprint and the sample describe one
   snapshot.
2. **Counted preview.** The operator is shown those two numbers and the sample.
3. **Confirmation.** The execute request carries `expectedGrants`, the count the
   operator was shown and typed back, the preview's `fingerprint`, and a mandatory
   reason. The server does the stamping and compares both its count and the fingerprint
   of what it stamped, in the same transaction. On either mismatch it refuses with
   `TRIAL_RESET_STALE` and rolls back, so a preview can never authorise a different
   reset than the one it described — including a different set of the same size. A reset with nothing to
   stamp is refused with `TRIAL_RESET_NOTHING`; a no-op would add a history row that
   records nothing.
4. **Audited execution.** One audit row carries the actor, the reason and both counts.
5. **Recorded result.** A `trial_resets` row holds the id, actor, reason, counts and
   time. Every grant it stamped carries its `reset_id`, so the question "which grants did
   this reset cover" has an answer in the rows themselves, and a reversal (not built)
   would have one to work from.

The permission is `settings.destructive` (CRITICAL). It is declared for exactly this
kind of bulk mutation (`features.ts`), it was charged by nothing until now, and it is
seeded to `owner` only. The PREVIEW also takes `users.view`, because its sample names
customers and `settings.destructive` does not require it. Viewing the history takes
`settings.view`.

**Concurrency.** The stamping is one conditional `UPDATE … WHERE released_at IS NULL AND
reset_at IS NULL`.

- **Two resets.** The second waits on the first's row locks, then re-evaluates its
  `WHERE` and stamps nothing it covered. When the first covered every grant, the
  second is refused as `TRIAL_RESET_NOTHING`; otherwise it is stale. Tested with a
  row-lock barrier (TB-17).
- **A reset and a release on the same grant.** Whichever commits second finds the other's
  stamp. The count excludes a grant that carries either stamp, so a grant never counts
  twice or goes negative. If the reset is the one that waited, it is refused as stale.
- **A claim running alongside a reset.** Its new grant is not in the reset's snapshot. It
  stays counted, as a trial taken after the reset should be.
- **The same command twice at once.** Both miss the replay read; the second waits, stamps
  nothing and is refused. It then reads the idempotency record again, outside its
  rolled-back transaction, and answers with the reset the first recorded.

The four changes above — the fingerprint, the single-statement preview, `users.view` on
the preview and the same-command re-read — are the Codex review of PR #65.

### B4 — The operator's view

- On a customer's page, a trial card shows the global limit and the override as stored
  (or «none»), then the effective limit, used and remaining, and whether the `trials`
  flag is on. It echoes the stored value (ADR-0015's first constraint).
- A holder of `users.trial.edit` can set or remove the override from that card.
- A Trials page lists the customers with a custom limit, showing limit, used and
  remaining.
- For a holder of `settings.destructive` that page also has the reset (preview, typed
  count, reason, execute), and for a holder of `settings.view` the reset history.

The Telegram admin surface does not gain these screens in WP6-B. The service is where
the rules live, so a later Telegram section reaches the same answers. That is recorded,
not promised.
