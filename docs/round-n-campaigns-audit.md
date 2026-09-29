# Round N, C1 — Campaigns (کمپین‌ها): audit and decisions

Written before the code, as every package audit here is. It records what exists, what the
Mirza research does and does not establish, and the decisions the Campaign layer is built
on. Anything nobody has decided is recorded as UNKNOWN (§7) rather than guessed.

The one-sentence design: **a campaign is a record that COMPOSES engines that already
exist, and owns none of their decisions.** It prices nothing (the discount engine does),
credits nothing (the wallet ledger, through the cashback earner or the shared mass-credit
engine, does), sends nothing (Broadcast does) and dials no panel (the shared bulk
traffic/time engine does). What it owns is a name, a window, a frozen audience, the links
to what it created, and a state machine whose every edge is a conditional UPDATE.

## 1. What exists before this package

### 1.1 Discount rules (WP8, `docs/wp8-pricing-audit.md`)

- `discounts` holds CODE and AUTOMATIC rules: `PERCENTAGE` 1..100 or `FIXED_AMOUNT` with a
  currency; `applies_to` (a non-empty subset of `NEW_SERVICE`, `RENEW`, `ADD_TRAFFIC`,
  `ADD_TIME`); product OR category scope; an optional single customer; first purchase
  only; a minimum subtotal; a half-open window `[starts_at, ends_at)`; a total and a
  per-customer limit; priority and stackable.
- `PricingService.price` over the pure `pricing-engine.ts` is the ONE pricing boundary.
  The engine enforces the window itself (`NOT_STARTED`, `ENDED`), and confirmation
  re-decides status, window, limits and first purchase under the rule's row lock
  (`DISCOUNT_NO_LONGER_VALID`), never the amount.
- Limits count LIVE redemptions (`discount_redemptions` whose order is `AWAITING_PAYMENT`
  or `PAID`); there is no counter.
- A customer-typed code applies to `NEW_SERVICE` only (OQ-WP8-01); automatic rules reach
  every paid purpose.
- `DiscountAdminService` creates a rule `INACTIVE`, activates and deactivates by a
  conditional UPDATE naming the `from` state, never deletes, and never changes a rule's
  kind or code. Permission `catalog.discounts.edit` (HIGH).

### 1.2 Cashback rules (WP8 P8/P9)

- `cashback_rules`: percent 1..100, `applies_to`, product OR category scope, a half-open
  window, `ACTIVE`/`INACTIVE`. The eligible rule with the highest percent wins; rules never
  stack.
- The rule is snapshotted into the quote at draft time and promised as `order_cashback`
  `PENDING` at confirmation. It is NOT re-checked at confirmation: withdrawing a rule never
  takes back a promise already made.
- Earned once, at delivery, by the provisioner sweep (`CASHBACK_PURCHASE`, reference
  `${orderId}:cashback`); voided when the order ends undelivered; reversed on refund by the
  cumulative target, never below zero, shortfall recorded as `unrecovered`.
- Permission `catalog.pricing.edit` (HIGH).

### 1.3 Referral terms (WP9-A, `docs/wp9-referral-audit.md`) and the signup gift

- Three TENANT-WIDE settings: `referral.commission_percent`, `referral.commission_scope`
  (snapshotted onto each attribution at registration) and `referral.minimum_order_amount`;
  plus the flag `referrals` and the signup-gift settings `referral.signup_gift.*`.
- Attribution happens only at registration and is never changed.

### 1.4 Scheduling patterns

- Worker lanes are timers over the database (`CustomerReminderLoop`, `PaymentExpiryLoop`)
  with `LoopProgress` health registered in `main.worker.ts`. Work is claimed by a
  conditional UPDATE, so two replicas on a rolling update are the normal case.
- Background work acts as `SYSTEM_JOB` and charges `maintenance.run`.
- Tenant presentation: `tenants.display_timezone` and `calendar`;
  `report-calendar.ts` `localInstant` resolves a civil date and wall time in the tenant's
  zone and calendar to a UTC instant.

### 1.5 The shared audience, Broadcast and mass actions

Owned by Agent E (B1/B2) and reused here; see §5.

## 2. What the Mirza research establishes (C1)

From the lead's audit (`mirza-audit.md` §2 C1), which cites the corpus:

| Behaviour | Status | What Nexa keeps |
| --- | --- | --- |
| Any campaign entity, schedule or attribution | NOT_EXPOSED (zero corpus hits) | Nothing. A campaign is a **Nexa addition**, never labelled parity. |
| Discount codes: percentage only; total and per-user caps; lifetime in hours (0 = unlimited); scope by tier, panel→product, section (buy/renew/both), first purchase only; case-insensitive; applied on the pre-invoice via `🎟 اعمال کد تخفیف` | VERIFIED (SBR-014..021, store crossmap) | The campaign's discount action is the EXISTING engine's rule, which already carries percentage, both caps, a window, product/category and purpose scope and first purchase. |
| Discount tier scope (`f`/`n`/`n2`) and panel scope | VERIFIED in Mirza | NOT expressible in Nexa's discount engine, which has no tier or panel dimension. Not added here (§3 D4): a campaign creates rules, it does not grow the pricing engine. |
| Whether the total cap counts users or redemptions; stacking and precedence; how a valid redemption is displayed | UNKNOWN | Nexa's engine decides (live redemptions; priority + stackable). |
| Cashback: per gateway, per tier on top-up, on renewal, refund button | PARTIAL (existence only) | Standing settings in Mirza, not campaigns. The campaign's cashback action is Nexa's WP8 cashback rule. |
| Start gift `💝 هدیه استارت` | VERIFIED (existence) | A standing setting, not a campaign. Not touched. |
| Referral: percent, flat per-referral gift, minimum purchase, per-user override | VERIFIED | Standing tenant-wide terms. See D8 for why a campaign does not adjust them. |
| Lucky wheel, nightly lottery | VERIFIED (existence); prizes UNKNOWN | Out of scope. |
| Mass top-up `👥 شارژ همگانی`: amount → tier → purchase history → notify, executes with no count, no total, no confirmation | VERIFIED (flow and the ABSENCE of safeguards) | The wallet-gift action goes through E's mass credit, which adds the count, the total liability and the confirmation Mirza lacks. |
| Cancelling the mass top-up's message cancels only the message, never the credit | VERIFIED (UBR-023) | A campaign's cancel stops future work and never reverses a completed financial effect (D6). |
| `🔋 حجم یا زمان همگانی` | VERIFIED (existence only); every behaviour UNKNOWN | Nothing is parity. The traffic/time action is whatever E's bulk engine does. |

So the whole Campaign concept, its states, its schedule and its analytics are Nexa's own
design. The only parity claims this package makes are the ones E's and WP8's engines
already make for the actions it composes.

## 3. Decisions

### D1 — A campaign owns records, not decisions

Two tables:

- `campaigns`: name, internal description, state, the window, the frozen audience
  snapshot, the announcement choice, who created/scheduled/paused/cancelled it and when.
- `campaign_actions`: one row per promotional action, with its kind, its frozen
  configuration, and a link column to the ONE row it created in another engine
  (`discount_id`, `cashback_rule_id`, or E's operation/broadcast id). Unique per
  `(campaign, kind)`: a campaign has at most one action of each kind.

Nothing in the campaign module computes a price, writes a wallet entry, sends a message
or calls a provider.

### D2 — States, and every edge a conditional UPDATE

`DRAFT → SCHEDULED → ACTIVE ⇄ PAUSED → COMPLETED`, and `CANCELLED` from any non-terminal
state. `COMPLETED` and `CANCELLED` are terminal. Declared as `CAMPAIGN_MACHINE` in the
contracts and registered with `STATE_MACHINES`, so the validator checks it.

| edge | who | condition |
| --- | --- | --- |
| DRAFT → SCHEDULED | operator, after the preview | `campaigns.manage` AND each action's own permission; window valid and not already over |
| SCHEDULED → ACTIVE | the worker (`SYSTEM_JOB`) | `now ≥ starts_at` |
| ACTIVE → PAUSED, PAUSED → ACTIVE | operator | `now < ends_at` for a resume |
| ACTIVE/PAUSED → COMPLETED | the worker | `now ≥ ends_at` |
| DRAFT/SCHEDULED/ACTIVE/PAUSED → CANCELLED | operator | — |

There is no `setState`. Each edge is `UPDATE … SET state = $to WHERE id = $id AND state IN
($from…) [AND time condition]`, and a row that did not move is reported as unchanged
rather than as success. A replay, a double click and two worker replicas are all safe for
that one reason.

### D3 — Time is the tenant's

The operator enters the start and end as a civil date in the tenant's calendar
(`YYYY-MM-DD`, Jalali for a Jalali tenant) and a wall time `HH:MM` in the tenant's
`display_timezone`. The server resolves both with `localInstant`, stores UTC `timestamptz`,
and the window is half-open `[starts_at, ends_at)`. Responses carry the instant and the
tenant's zone and calendar, and the Web Admin renders with `formatInstantIn`, never the
browser's zone.

The end is required: a campaign is bounded by definition, and a discount or cashback rule
that the campaign created must stop on its own even if nothing else runs.

### D4 — Discount action: the existing engine's rule, created at confirmation

- At DRAFT → SCHEDULED, inside the same transaction, the campaign creates ONE discount
  rule through `DiscountRepository.create` with the operator's terms (kind CODE or
  AUTOMATIC, percentage or fixed amount, purposes, product or category, first purchase,
  minimum subtotal, total and per-customer limits, priority, stackable) and the
  **campaign's window as the rule's window**, and moves it `INACTIVE → ACTIVE` with the
  repository's conditional `setStatus`. The rule id is stored on the action row. The
  campaign writes the same `discount.create` / `discount.activate` audit rows the
  discounts page writes, so the rule's history reads the same wherever it was made.
- **The engine decides when it applies.** Because the rule's window IS the campaign's
  window, the discount starts and stops at the exact instants the operator chose even if
  the worker is late or down. SCHEDULED → ACTIVE and ACTIVE → COMPLETED are bookkeeping
  for the discount; they write nothing to pricing.
- Pause deactivates the rule (`ACTIVE → INACTIVE`); resume reactivates it; cancel
  deactivates it. Each is the repository's conditional update. What that does to orders
  is the engine's existing rule and nothing new: a draft already carrying the discount is
  refused at confirmation with `DISCOUNT_NO_LONGER_VALID`; a confirmed order keeps what it
  was sold at.
- The rule is an ordinary rule afterwards. It appears on the discounts page, and an
  operator who edits it there edits the campaign's discount: one rule, one truth. The
  campaign page reads the rule's live row, never a copy.
- **Audience and eligibility are different things.** The discount engine has no audience
  dimension (it scopes by product, category, purpose, first purchase and one optional
  customer). A campaign's audience decides who is TOLD, through the announcement. Who is
  ELIGIBLE is the rule's own scope. Adding an audience dimension to the engine would be a
  change to the single pricing boundary and a second place segmentation is evaluated; it
  is not built, and is recorded as OQ-C1-01. The Web Admin says this in words on the
  campaign form.

### D5 — Cashback action: the existing cashback rule, the same way

Identical to D4 with `cashback_rules` (percent, purposes, product or category, the
campaign's window) and `catalog.pricing.edit`. The earner, the promise, the reversal and
"max wins" are WP8's and unchanged. Withdrawing the rule (pause, cancel) never takes back
a promise: WP8 P8 already says a promise is not re-checked at confirmation.

### D6 — Cancel stops future work and never undoes a completed financial effect

- Discount/cashback: the rule is deactivated. Confirmed redemptions stay, promised
  cashback stays and is still earned at delivery, earned cashback is not reversed.
- Direct grants (wallet gift, traffic/time) and the announcement: E's engine is asked to
  cancel what is still unprocessed. Credits already written, provider operations already
  succeeded and messages already sent stay exactly as they are; nothing is "recalled".
- A cancel is audited with what it stopped.
- A Telegram delivery failure in the announcement is a delivery outcome in E's lane; it
  never touches a campaign's financial actions, which are separate records in separate
  transactions.

### D7 — Preview before confirmation

The preview is a read (writes nothing, holds no lock):

- the audience count, from E's shared audience query over the SAME definition that will
  be frozen;
- the discount and cashback terms, in words, and the products/categories they reach;
- for a wallet gift, the exact count × amount = total liability (from E's engine);
- for traffic/time, the affected-service count (from E's engine);
- the schedule in the tenant's calendar;
- the announcement preview (from Broadcast).

A discount or cashback campaign has no determinable liability up front — it depends on
orders nobody has placed — and the preview says so rather than inventing a figure. Where
a maximum IS determinable (a FIXED_AMOUNT discount with a total limit: `value × limit`)
it is shown as a maximum.

### D8 — Referral incentive: not built, and why

The brief allows it "only if safely expressible through existing referral terms without
rewriting historical attribution". It is not, for three reasons:

1. **The terms are tenant-wide settings with no window and no audience.** A campaign could
   only express a "referral incentive" by writing `referral.commission_percent` at the
   start and writing it back at the end. That targets every referrer in the tenant, not
   the campaign's audience.
2. **The write-back is a lost update.** A background job restoring "the old value" at the
   end would silently overwrite whatever an operator set in between, which is exactly the
   silent-overwrite failure `docs/conventions.md` ("Settings are readable") records.
3. **The scope cannot be campaigned without rewriting attribution.** `commission_scope`
   is snapshotted onto each attribution at registration and governs that referee for
   life (WP9 F5); changing it for a window changes the terms of everybody who registers in
   the window, permanently.

What IS possible — and is left to the operator on the existing settings page — is to
change the referral percent by hand, which affects only orders confirmed afterwards.
Recorded as OQ-C1-02.

### D9 — Analytics: only what is persisted

Every figure the campaign page shows is a query over rows that name the campaign's own
linked records:

| figure | source |
| --- | --- |
| targeted customers | the frozen audience materialization (E) |
| announcement sent / failed / blocked / not attempted | E's per-recipient delivery rows |
| orders that redeemed the campaign's discount, by order state, and the discount amount | `discount_redemptions` where `discount_id` = the campaign's rule, joined to `orders.state` |
| cashback promised / earned / void, and reversed | `order_cashback` where `rule_id` = the campaign's rule; `cashback_reversals` |
| wallet gifts credited, and total credited | E's per-recipient mass-credit rows |
| traffic/time operations succeeded / failed / unknown | E's per-service operation rows |
| status and timing | the campaign row |

There is no "revenue caused by the campaign" and no "conversion rate": nothing persists
that a purchase was CAUSED by an announcement. The page shows the order totals of orders
that redeemed the campaign's own discount, labelled as exactly that. A regression test
pins that the analytics response has no field that is not one of these persisted counts.

### D10 — Permissions

- `campaigns.view` (LOW): read campaigns, their preview and their analytics.
- `campaigns.manage` (HIGH): create, edit a draft, schedule, pause, resume, cancel.
- AND the permission of every action the campaign composes, checked through the guard on
  schedule, pause, resume and cancel: `catalog.discounts.edit` for a discount,
  `catalog.pricing.edit` for cashback, and E's permissions for Broadcast and mass actions.
  A campaign is never a way to do what the operator could not do directly.
- The worker's transitions charge `maintenance.run` as `SYSTEM_JOB`, like every other lane,
  and never gain a pricing or wallet permission: the scheduled edges write nothing
  financial (D4, D5), and direct grants are launched per §5.

### D11 — The worker lane

`CampaignScheduleLoop` in the worker role, health-checked in `main.worker.ts`. Each tick:

1. `SCHEDULED → ACTIVE` for every campaign with `starts_at ≤ now`, bounded, id order, each
   a conditional UPDATE; then the launch of each direct-grant action (§5), each keyed
   deterministically by `(campaign, action)` so a crash between the two is resumed by the
   next tick without a second launch.
2. `ACTIVE|PAUSED → COMPLETED` for every campaign with `ends_at ≤ now`.

Two replicas running the same tick is the ordinary case: the UPDATE decides which one
moved the row, and the other's is a no-op.

## 4. What is NOT in this package

- An audience dimension on the discount or cashback engine (OQ-C1-01).
- A referral incentive (D8, OQ-C1-02).
- Customer-typed codes on renewals and add-ons (OQ-WP8-01 stands).
- A campaign-caused revenue figure (D9).
- Any Telegram customer surface of its own: the announcement is Broadcast's, and the
  discount is shown by the existing order summary.

## 5. Composition with the shared audience, Broadcast and mass actions (Agent E)

Everything below is E's engine, called under the OPERATOR's actor and permissions; the
campaign adds no segmentation, no delivery lane and no credit path of its own.

### 5.1 The audience

- The draft stores the audience in the shared contract's ONE canonical spelling
  (`freezeAudience`: `definition` and its sha256 `audience_hash`).
- The preview is `AudienceService.evaluate` + `sampleOf` over that stored definition — the
  count, the reachable count, the set's md5 fingerprint and a sample, exactly what the
  Broadcast page shows. It charges the audience engine's own read key (`users.view`)
  besides `campaigns.view`, because the sample names customers.
- The confirmation re-evaluates the same definition INSIDE the scheduling transaction and
  refuses with the engine's own `audience.changed` when the hash, the count or the SET
  differs (a right count with a different set is refused too). The confirmed count and
  fingerprint are frozen on the campaign row (`audience_confirmed_count`,
  `audience_fingerprint`).

### 5.2 When recipient identity is frozen

The brief asks for identity frozen "at launch" for broadcast and direct-grant campaigns and
for the exact liability before confirmation. For a campaign scheduled in the future those
two are the same instant only if the launch IS the operator's confirmation, so it is:

- **Gifts** are handed to the mass-action engine at the confirmation, with the engine's
  `notBefore` = the campaign's start (added by E at F's request). The items and the
  confirmation (definition hash, count, set, and for money `amount × count`) are frozen
  then; the processor takes no item before the start; a cancel before the start cancels
  every item and credits nothing (`tests/integration/campaigns.test.ts` › "credits nothing
  before the start…").
- **The announcement** is created and launched at the confirmation in Broadcast's own
  `SCHEDULE` mode for the start (or `NOW` when the start is less than 90 seconds away,
  because Broadcast refuses a schedule under a minute). Broadcast freezes its recipients at
  that launch.
- Live safety facts (a customer blocked since, a service no longer operable) are re-read
  by each engine when it processes an item, as E's engines already do.
- Both engines accept work at most sixty days ahead, so a campaign with a gift or an
  announcement must start within 59 days (`campaign.window_invalid` otherwise).

### 5.3 The hand-over, and why it is outside the campaign's transaction

The campaign's own transaction (rules + state + per-action binding) commits FIRST; the
engines are then called, each in its own transaction. A campaign never holds its lock
across another module's work, and a Telegram or provider outcome can never roll back a
financial action because they are different records in different transactions.

Each hand-over uses a key derived from the campaign and the action
(`campaign:<id>:wallet_gift`, `…:announcement`, `…:announcement:launch`) and the binding
frozen on the action row, so a retried hand-over — the confirmation replayed, or the
operator's «سپردن دوبارهٔ اقدامات در انتظار» (`POST /campaigns/:id/launch`) — makes the
engine replay rather than create a second operation. An engine's refusal on the merits
(`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `PRECONDITION_FAILED`) leaves the action `FAILED`
with the code; anything else (the database, a crash) leaves it `PENDING` — never a guess.

### 5.4 Pause, resume, cancel

- Pause/resume move the standing rules and steer the announcement (Broadcast pauses a
  `SENDING` broadcast and resumes a `PAUSED` one). **A gift is not paused**: the mass-action
  engine has no pause, so a gift already processing finishes its frozen items. The Web
  Admin says so beside the buttons.
- Cancel asks each engine to cancel what is left (a repeated cancel is answered by the
  engine), withdraws the rules, and cancels actions never handed over. Cancelling a
  CANCELLED campaign again re-asks the engines, so an engine cancel that failed can be
  retried. Nothing done is undone (§3 D6).

### 5.5 Limits of this composition

- The announcement is text with link buttons and Broadcast's placeholder catalogue; media
  is composed on the Broadcast page itself, not from a campaign.
- A PAUSED campaign's gift keeps processing (above).
- A campaign's discount or cashback edited on the discounts page is the campaign's rule;
  one rule, one truth (§3 D4).

## 6. Tests the package owes, and what each regression is pinned by

| brief regression | pinned by (`tests/integration/campaigns.test.ts` unless named) |
| --- | --- |
| scheduled activation idempotent, multi-worker safe | "the worker lane" (two replicas on one tick move a campaign once; one audit row), "refuses each edge in the database itself…" |
| existing discount/cashback engines reused | "creates nothing priced while a DRAFT, and ACTIVE rules windowed…" (the order is priced by `OrderService` through `PricingService.price`; the trace names the campaign's rule), "leaves the price alone before the window opens…" |
| cancel stops future work, undoes no completed financial effect | "cancel stops future work and undoes no completed financial effect" (redemptions, an EARNED and a PENDING cashback, the credit; no reversal), "credits nothing before the start, and a cancel before it credits nothing", "shows the exact liability, then credits each customer exactly once" |
| audience engine shared with Broadcast | the service is built with `container.audience` (no stand-in); "refuses a confirmation whose audience moved…" (a new registration moves the set) |
| analytics never claim unpersisted attribution | "reports only persisted attribution…" (response keys pinned; an order before the campaign is not counted); `tests/web/campaigns.test.tsx` › "reports persisted facts only" |
| Telegram failure does not roll back money | "a failed announcement rolls back no financial action" |
| each action's own permission | "charges each action's own permission", "charges the mass-credit permission" |

Falsification, run on this branch (revert the rule, watch the named test fail, restore):

- `start` without its `starts_at <= now` condition → "refuses each edge in the database
  itself" fails.
- `complete` without its `ends_at <= now` condition → the same test fails.
- `cancel` without withdrawing the rules → "cancel stops future work…" fails.
- `schedule` without comparing the audience's hash, count and fingerprint → "refuses a
  confirmation whose audience moved since the preview…" fails.
- A gift's typed-count check removed → "refuses a confirmation whose liability or typed
  count is not what the preview showed" fails.

### What the package set out to test

- Scheduled activation is idempotent and multi-replica safe: two ticks racing move a
  campaign once, and launch each direct grant once.
- The discount and cashback actions create rules in the EXISTING tables that the existing
  engine then applies (a draft priced through `PricingService.price` carries the campaign
  rule), and outside the window it does not.
- Cancel deactivates the rule and stops future work; a confirmed redemption, a promised
  cashback and a completed credit survive it.
- The audience preview and the frozen snapshot go through E's audience engine.
- Analytics counts come only from persisted rows, and the response carries no attribution
  figure beyond them.

## 7. UNKNOWN / open

| id | question | meanwhile |
| --- | --- | --- |
| OQ-C1-01 | Should a discount or cashback rule be restricted to a campaign's audience? | No. The audience decides who is told; the rule's scope decides who is eligible (D4). |
| OQ-C1-02 | Should a campaign be able to raise the referral commission for a window? | No (D8). Referral terms stay on the settings page. |
| OQ-C1-03 | Mirza's discount tier and panel scope (VERIFIED in Mirza) | Not in Nexa's engine; unchanged by this package. |
