# Project status and standing decisions

This file was moved verbatim out of `CLAUDE.md` on 2026-10-24. It holds project history and the per-feature standing decisions; the rules here are binding exactly as they were in `CLAUDE.md`. The coding rules are also repeated in `.claude/skills/nexa-conventions` under "Domain invariants".

## Contents

- [Phases and status](#phases-and-status)
- [Owner-defined main-menu buttons (R10 D2)](#owner-defined-main-menu-buttons-r10-d2)
- [Authentication and authorization](#authentication-and-authorization)
- [Payments and gateways (TonPays)](#payments-and-gateways-tonpays)
- [Providers and panels (Phase 3)](#providers-and-panels-phase-3)
- [Pricing, referral and resellers](#pricing-referral-and-resellers)
- [Money rules](#money-rules)
- [Phase 4 product rules](#phase-4-product-rules)
- [Automatic renewal (Round 10, D1)](#automatic-renewal-round-10-d1)
- [Phase 2 control plane](#phase-2-control-plane)
- [Phase 6 capacity and usernames](#phase-6-capacity-and-usernames)
- [Deployment](#deployment)
- [Backup](#backup)
- [Recovery](#recovery)
- [Real-panel acceptance](#real-panel-acceptance)
- [Operational events](#operational-events)

## Phases and status

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, React. One codebase, several process roles. (No queue library and no
Telegram framework are installed yet — the webhook is parsed at the boundary
and the notification dispatcher polls Postgres.)

**Phases 0, 1 and 2 are done: foundation, identity and RBAC, then the control
plane** — templates, settings, feature flags, notifications and the operational
log. **Phase 3 is done**: 3A gave providers, panels, credentials and health; 3B
added the MHSanaei/3x-ui v3.7.0 adapter; 3C a dedicated `monitor` process role
that keeps panel health up to date on a schedule; 3D the Web Admin. **Telegram
Backup V1 is done** — the disaster-recovery pipeline, ADR-0025 and
`docs/backup.md`. **Web Admin Disaster Recovery is done** — one operational
section, a fourth `recovery` process role, and a real cutover by database rename
(ADR-0028).

**Phase 4 is the product, and it is done.** 4A customers; 4B catalogue and
orders; 4C wallet, payments and settlement; 4D the `provisioner` process role
that turns a paid order into an account on a panel; 4E suspend, resume,
terminate and usage; 4F renew, add traffic and add time; 4G the payment
outcomes an operator or a deadline produces; 4H the customer notification lane
(ADR-0030) and the two actions a customer can take on their own order; 4I the
Telegram bootstrap surface; 4J the final hardening pass
(`docs/phase4j-audit.md`).

**An order the installation cannot deliver is refunded, not queued.** The owner
removed `PAID_UNFULFILLED` and everything built on it — the operator retry, the
reassignment, `orders.fulfil` — in favour of one automatic outcome. See the four
money rules below.

## Owner-defined main-menu buttons (R10 D2)

Owner-defined buttons on the customer main menu, added from the Web Admin: a **link** (opens
a URL) or **content** (a stored text, photo or document the bot sends). Binding rules; the
reasoning is ADR-0036.

- **Off by default** (`custom_menu_buttons`, switched from the Web Admin's features page). Off, no
  custom button is drawn on any keyboard and a tap on a stale one is answered
  `bot.custom_button.unavailable`; the registry buttons are exactly as before.
- **Placed through the builder**, never in `bot.main_menu`. A layout that places a custom button is
  stored as `v: 2` (`custom:<uuid>` rows); one that places none is **always `v: 1`**, so a tenant
  that never uses the feature is untouched by a rollback. A `v: 2` head read by an older release
  falls back to the projection (the recorded `bot_menu.published_unreadable` degrade).
- **A custom button is always gated** (flag, archive, sending bot), so it never keeps a keyboard
  non-empty. "Per bot" means which bots show it.
- **A route is not authority.** The tap re-decides from state (flag, archive, bot, the PUBLISHED
  layout). A custom label routes to the map VALUE `mb:<uuid>`; typed `mb:<uuid>` routes nothing; a
  registry label always wins a collision.
- **Content is bytes, never a `file_id`**, under the ticket-file allow-list; a link must pass the
  https-only grammar; the operator's text is a value of a plain-text template. Limits: 20 buttons,
  label 64, text 4096, caption 1024, 50 MB per tenant. A button is archived, never deleted.
- **Owner's real-bot acceptance** (not done by the tests): an inline URL button opens, a multipart
  photo and document arrive, the reply keyboard shows the custom label and its style.

## Authentication and authorization

Authentication and authorization are real. Every new write path takes a
`ScopeContext` and an `ActorContext` and checks a permission through the guard —
never by inspecting an actor's type, and never by not drawing a button.

## Payments and gateways (TonPays)

**TonPays (WP11A) is the first external payment gateway, built and NOT yet accepted
against the real provider** (`docs/tonpays-gateway-audit.md`, `OQ-WP10-01`). Three rules,
each a way to credit money nobody approved:

- **Only the inquiry decides.** `completed` AND `paid === true`, read from TonPays' own
  check endpoint, is the one approval. A webhook is a hint that brings an inquiry forward;
  its signature is undocumented and never read. The provider's amounts are metadata.
- **The attempt's 70-minute deadline is checked under the payment's lock**, in
  `PaymentService.confirmGatewayPayment`, whatever its caller believes. A later approval is
  recorded as `LATE_COMPLETION` and settles nothing.
- **A create whose answer was lost is never retried and never re-keyed.** The send is
  stamped before the call; only the provider's own `RATE_LIMIT_EXCEEDED` clears it.

**Card-to-card receipt review happens in BOTH places** (owner, R12 F3 item 8, reversing Payment File
02 §10). The Web Admin approves, rejects or credits to the wallet through the SAME application
methods Telegram uses (`confirmManualTransfer`, `rejectManualTransfer`,
`ReceiptDispositionService.creditToWallet`): no second settlement path; `receipts.review` (the
credit also `users.wallet.credit`); approve asks first. A decision in one place excludes a decision
in the other.

**A TonPays Telegram cancel whose answer was lost is not a cancellation** (owner, Round 11 A8).
While the invoice is open as far as Nexa knows, «❌ لغو فاکتور» stays and the customer may ask
again — a new request row, one in flight at a time, spaced from the lost one; Nexa never repeats
it by itself. A tap once Nexa knows it was cancelled says «فاکتور قبلاً لغو شده»; a paid invoice
is never cancelled (`docs/tonpays-telegram-gateway-audit.md` §21).

**The custom gateway (Round 10 C1) is built and NOT yet accepted against a real bridge**
(`docs/protocols/custom-gateway.md`, `docs/custom-gateway-audit.md`, `OQ-CG-01`). It is Nexa's
OWN protocol — one code-backed type, `CUSTOM`, that a third-party bridge implements; an operator
points the route at a bridge and never defines a provider. The same three rules hold, plus: a
callback NEVER credits by itself (only the bridge's SIGNED inquiry answer, `PAID` with this
attempt's invoice id, reference and exact amount, approves); one per-route secret signs every
direction with its own prefix; the base URL is https-only through the installation's URL policy,
frozen on each attempt, and changed only while the route is DISABLED. The route ships DISABLED.

## Providers and panels (Phase 3)

**Marzban is the supported mutable provider.** 3X-UI keeps the five
capabilities it has — of which only `CREATE_USER` mutates anything — and gains
no new mutable scope: the owner's correction, recorded in
`docs/phase4e-audit.md`.

Four Phase 3 rules that are easy to break by accident (ADR-0023):

- A panel credential travels **one way**. The repository projection selects the
  three set-at timestamps and never a ciphertext, so no response builder can
  acquire a value. Never add a masked stand-in either — `********` can be
  resubmitted as the real password.
- A provider type is **code**, not a row, and the adapter is resolved before the
  panel row is written. A panel that cannot be operated must not become a row.
- Health is **latest state only**, and `DISABLED` and `UNCHECKED` are projected
  rather than stored. A probe result changes health and nothing else — never a
  status, never a credential.
- Private addresses are **deliberately reachable**; only destinations that are
  never a panel are refused. Redirects are never followed and the socket is
  pinned to a pre-validated address, which is why that code is on `node:http`
  rather than `fetch`.

Four more from Phase 3C:

- There is **one probe implementation**, `panels/application/probe-core.ts`.
  The operator's connection test and the background monitor are two wrappers
  over it. Never copy it; the copy that would silently keep the old behaviour
  is the unattended one that dials panels on a timer.
- The monitor probes **ACTIVE panels only**, and the rule is enforced in the
  discovery query and again in the core. `DISABLED` means the operator said
  stop using this for now.
- Background work takes the SAME tenant probe budget with a **reserve floor**,
  never a second bucket. A second bucket would raise a tenant's total outbound
  rate, which is the bound's whole purpose.
- Nothing about a probe is decided in a process. The per-panel claim and the
  budget are conditional writes; **two monitor replicas are the normal case**,
  briefly, on every rolling update.

### The custom panel — Nexa's own bridge protocol (R10 C2)

**Built, behind `custom_panel_provider` (OFF by default), and NOT accepted against a real
bridge.** The specification is `docs/protocols/custom-panel.md` (v1); the adapter is
`providers/infrastructure/custom-panel.adapter.ts`. Owner's spec: Nexa's OWN protocol (not
MirzaBot-compatible), JSON over HTTPS, requests signed with a per-panel secret and a
timestamp; create, get (traffic used/limit, expiry, status, last connection), renew / add
traffic / add time, change link, enable / disable / delete, connection links, health; a
`custom` member of `PROVIDER_TYPES` wired into provisioning, the live check, the monitor and
the capacity and health views like the other three; Web Admin to add one (base URL, secret,
timeout) and test it; Persian errors only; the existing service-created logs.

Lead decisions (R10 C2), binding:

- **Only a signed answer can say yes, absent or refused.** Every bridge response is signed
  over its status, the request's nonce and its body hash. An unsigned or wrongly signed 404 is
  a malformed answer, never "account not found" — a wrong base URL must not license a second
  create. An unknown error code, or a known one under the wrong status, is `PROVIDER_ERROR`
  (UNKNOWN for a create), never `PROVIDER_REFUSED` (which refunds).
- **Idempotency on Nexa's operation id, binding on `nexaRef`.** Every write carries
  `operationId` (the provisioning operation's id, the same on every attempt) and `nexaRef`
  (the service's stored `clientId`); the bridge refuses a write on an account bound to
  another ref. A write without an operation id is refused before it is sent. A lookup whose
  `nexaRef` is not this service's is a refusal — neither found nor absent.
- **Absolute allowance targets.** Renew, add traffic and add time are one call carrying the
  targets; an omitted field is unchanged.
- **Descriptor-gated, no provider-type branches.** The flag, https-only and the 32-character
  minimum secret are declared on the descriptor (`requiresFeature`, `transport`,
  `minimumApiTokenLength`) and enforced generically by the panel service. The secret lives in
  the existing encrypted API-token column, one way. A per-panel timeout may only LOWER the
  installation's `PANEL_HTTP_TIMEOUT_MS` (`SafeHttpClient.forBase` takes the minimum).
- **No auto-adoption after a lost create (C2-b not built).** A create whose answer was lost
  and whose account a read then finds bound to the service waits for an operator
  (`provisioning.stalled`, `FOUND_WITHOUT_PROVENANCE`), exactly as on RickPanel. Adopting it
  by its binding is `OQ-C2-01`, the owner's call.
- **Turning the flag off blocks creating NEW custom panels only** (and hides the type from
  the form). Existing custom panels keep being edited, tested, re-keyed, sold onto and
  operated: their services were paid for.
- **Declared without a real-bridge acceptance** — the second recorded deviation from
  declare-after-acceptance (RickPanel's is the first): the capabilities rest on Nexa's own
  specification and a contract test of every operation and failure mode against a mock
  bridge that enforces it. The protocol document's §12 is the acceptance run the first real
  bridge must pass before the flag is turned on in production (`OQ-C2-02`).

## Pricing, referral and resellers

**Discounts and cashback are built (WP8, `docs/wp8-pricing-audit.md`), and so
are the referral program (WP9-A, `docs/wp9-referral-audit.md`) and resellers
(WP9-B, `docs/wp9-reseller-audit.md`).** What remains unbuilt is affiliate,
reseller sub-bots and any other promotion. Do not add them without an explicit
instruction.

Four pricing rules, each a way to charge a customer a number they did not see
or give away money twice:

- There is **one pricing boundary**, `PricingService.price` over the pure
  `pricing-engine.ts`. Checkout, a typed code, the commercial actions and the
  operator's preview all go through it; a second calculation is a second
  answer to "what does this cost".
- A quote is **honoured, never re-priced**. Confirmation re-decides only what
  can make the quote unfulfillable — status, window, limits, first purchase —
  under the rules' row locks in id order, and refuses with
  `DISCOUNT_NO_LONGER_VALID` rather than charging a different figure. A code
  re-quotes a draft from its OWN snapshot, never from today's price.
- A limit counts **live redemptions** (order `AWAITING_PAYMENT` or `PAID`),
  asked of the order at read time; there is no counter. A customer is told one
  sentence for every code refusal — the reason is an oracle for guessing codes.
- Cashback is **earned once, at delivery** (an op of the order's `PURCHASED_AS`
  type `SUCCEEDED`), by the provisioner loop's sweep, never by hooks at each
  success site. A refund reverses it by the cumulative target, so partial
  refunds sum to one full one; what the balance cannot cover is recorded as
  unrecovered and never collected. The reversal judges the promise's state
  only under the customer's wallet lock.

Three referral rules, each a way to pay a commission that was never owed:

- An attribution is made **only at registration**, from the new customer's own
  `/start ref-…`, and is never changed afterwards. A refused one is audited as
  DENIED and the customer is told nothing different — the greeting is not an
  oracle for which codes exist. Because a referrer always registered first, the
  lock order referee-then-referrer has no cycle.
- A commission is **promised at confirmation** by `PricingService.redeem` and
  **earned at delivery** by the provisioner sweep, into the REFERRER's wallet
  under the referrer's lock. First-order scope is decided under that lock, at
  earn time, and the partial unique index is the same rule for a writer that
  forgets it. A trial is never promised.
- The reversal runs **inside the refund's transaction**, after the cashback
  one, by the same cumulative target, never below zero; the shortfall is
  recorded, never collected.

The membership (signup) gift and its R10 D5 amendment:

- The recorded owner rule (`docs/customer-ux-completion-audit.md` §I) is
  "eligibility is the accepted attribution, and nothing else": both sides may
  claim from the attribution on, with no purchase. **R10 D5 (b) amends it,
  behind `referral_abuse_guard` (default OFF)**: with the guard on and
  `referral.abuse.gift_unlock = ON_FIRST_PAID_PURCHASE`, neither side is payable
  before the referee's first paid, DELIVERED order (the commission earner's own
  "delivered"; never a trial, never a Mirza referral), read both by the claim
  button and inside the claim's locked set. `referral.abuse.referrer_daily_gift_cap`
  pays a referrer at most that many shares per local day (the rest waits for the
  next day; the referee's share is never capped), and
  `referral.abuse.referrer_daily_commission_cap` DEFERS a commission over the
  cap to the next local day (`not_before`, migration 0283), never voids it. No
  new grant path: the claim is still the only payer. Turning the guard on or off
  never changes a stamped side or a balance — no clawback, no retroactive grant;
  off is the old rule with nothing to undo. Open points: `open-questions.md`
  OQ-D5-01..04.

The `/start` captcha (R10 D5 (a), `start_captcha`, default OFF): only a
customer CREATED while it is on is asked (the row is written in the
registration transaction); existing and imported customers never are,
administrators never are, and turning it off frees everybody waiting. A wrong
answer costs an attempt and, at the limit, a cooldown — never a block, never a
status change. It is the first check of the bot's gate chain and a mini-app
gate (`CAPTCHA`). Open points: OQ-D5-05..07.

Four reseller rules, each a way to sell below cost or on credit nobody granted:

- A reseller is a customer with an **ACTIVE** reseller row; SUSPENDED is an
  ordinary customer, with no discount and no reseller-only product.
  Margin, discount, commission and cashback are four things: the
  reseller layer is a `TIER_PRICE` or `USER_OVERRIDE` step that REPLACES the
  subtotal, so a margin is never recorded as a discount.
- Entitlement is **one evaluator**, `decideEntitlement`, deny-by-default per
  dimension (operation, catalogue, panel, bot). The catalogue is a courtesy
  held to it by a unit test over every grant subset; confirmation decides
  again, authoritatively, in `ResellerService.recordPurchase`.
- A quote is **honoured, never re-priced**: confirmation compares the quoted
  layer with the layer the live terms produce and refuses
  `RESELLER_TERMS_CHANGED` when the cost, step or rule differs. A change that
  leaves the price as quoted (a list-priced reseller suspended, a customer
  registered onto a list-priced tier) confirms under the standing in force at
  confirmation, audience and entitlement included. `order_reseller_terms` is
  written once; history reads that row, never live settings.
- **There is no reseller credit** — removed by owner decision (2026-10-01): no
  reseller debt, no negative balances, no credit purchases. `creditAllowanceOf`
  is zero for everyone, so `settleFromWallet` never takes a wallet below zero;
  every reseller write refuses a non-zero limit (after its idempotent replay),
  and migration `0155_reseller_credit_removed` zeroed every stored limit so an
  old replica grants none either. A balance already negative (a legacy debt from
  the removed credit line, or a negative Mirza balance the import carried) is a
  negative wallet like any customer's: no entry rewrites or ages it, and it
  **blocks every purchase, on every rail, until a top-up brings it to zero**
  (owner decision 2026-10-18, replacing 2026-10-01's "never collected";
  `assertWalletNotNegative`, the same gate for customers and resellers). A
  top-up is never refused. An operator's manual debit never
  overdraws; a clawback never goes below zero. Never reintroduce a credit
  line, a debt, or a monthly-minimum consequence without an explicit owner
  instruction (`docs/reseller-phase3-closure.md`).

## Money rules

Four rules about money the owner decided, and each one is a way to lose some:

- An order has **two terminal outcomes and no third**: FULFILLED, or REFUNDED
  for the exact amount to the customer's wallet, automatically, in the
  transaction that discovers it cannot be delivered. `PAID_UNFULFILLED`, the
  operator retry and the reassignment are gone. Never add a state, a queue or a
  button for "paid, undelivered, somebody will decide later" — what that
  produced was a list that only grew and a customer with neither an answer nor
  their money.
- There is **one credit path**, `RefundService.refundUndeliverable`, and the
  settlement lane and the provisioner both call it. It locks the payment, sums
  what is already committed and writes at most one ledger entry. A second writer
  would be a second answer to "how much did we give back", and the point of a
  ledger is that there is one.
- A **wallet purchase is refused, never refunded**. The debit is written in the
  settling transaction and dies with it, so crediting it back would be a credit
  for money that never left. The asymmetry with a bank transfer is deliberate:
  that money has already moved, so it is confirmed and then returned.
- **UNKNOWN is never refunded.** A create whose answer was lost may have taken
  effect, so the service goes to `UNRECONCILED` and a READ decides first.
  Refunding an ambiguous timeout gives money back for an account the customer is
  holding. `PURCHASED_AS` is the other half of that care: an operation carries
  `order_id` whenever its service has one, so a failed SUSPEND names the order
  that created the service, and only an operation matching what the order BOUGHT
  may refund it.

## Phase 4 product rules

Four Phase 4 rules that are easy to break by accident:

- A customer is told a fact through the **notification lane**, never a string.
  `CUSTOMER_NOTIFICATION_KINDS` is a closed set pinned by a CHECK constraint,
  each kind renders one frozen template, and none of them carries a payload. A
  reply that RENDERS state does not belong there — it would need the
  parameterised payload ADR-0030 §1 refuses, and the lane would become "send
  this customer some text".
- A terminal operation is **answered exactly once**, and `announced_at` is what
  says so. NULL means unanswered, never "no answer was owed", so four of the
  five exits from `announce` stamp — including the three that decide nothing is
  owed. The fifth, a state that is not terminal, must not.
- An outcome that is **UNKNOWN is never retried and never queued again**. A
  429 is not an unknown outcome and a timeout is not a rate limit; the three
  are kept apart at every layer, because every collapse of them costs a
  customer either a duplicate charge or a message they cannot reconcile.
- The announcer is **the one write path that does not check scope activity**,
  and that is a stated exception with a bound and a test — see
  `docs/conventions.md`. Everything else reads `ScopeActivityReader` inside its
  transaction.

## An ended order is answered on its own message (Round 11, A11)

Owner request: when an unpaid order expires or is cancelled, Nexa **edits the order's own
payment message** into the ended screen instead of sending a new «مهلت این سفارش به پایان
رسیده است». Binding rules:

- **One expiry notice per order, ever:** `ORDER_EXPIRED`, unique per order and kind by
  `customer_notifications_subject_key`. A payment against an order is told nothing of its own
  (`PaymentExpiryService`); only a top-up's payment keeps `PAYMENT_EXPIRED`. Before this an order
  with several attempts got one `PAYMENT_EXPIRED` per attempt, minutes apart (a gateway attempt's
  lifetime runs from its own creation), plus the order's.
- The ended screen (`bot.order.expired_screen` / `bot.order.cancelled_screen`) keeps the order
  summary (code, product, amount), carries **nothing that pays** (no card, no copy button, no
  pay or receipt button), shows «🔁 سفارش دوباره» and «🏠 منوی اصلی», and has **no "no money
  was taken" line**. Re-order is a read-only entry (the order's category, the custom-service
  menu or the catalogue); nothing is ordered until the customer confirms again.
- It is EDITED onto the order's latest screen (FIX-08's `answerOrder`, plus the receipt prompt
  `RECEIPT_WAIT`). A new message only when that message cannot be edited (deleted, too old) or
  is not known (a mini-app order) — once, recorded by the notification row. «message is not
  modified» counts as delivered; an unknown edit is never repeated.
- A tap on a stale pay/confirm button of an ended order is answered by editing THAT message into
  the ended screen, never by a new refusal message. A cancellation edits the order's message and
  removes the confirmation question.
- **Ended means the sweep ended it** (Codex, #354): an `AWAITING_PAYMENT` order past its deadline
  is not shown as expired until `expireDue` has moved it — the sweep keeps an order whose payment
  is still live (a receipt under review, a provider review, `UNKNOWN`), and a customer who may
  have paid is never offered «🔁 سفارش دوباره». Only a DRAFT past its hold (never swept) is read
  from its deadline.
- **A cancellation respects the settle window** (Codex, #354): while another writer may still be
  editing the order's message, the turn does not touch it; the `ORDER_CANCELLED` row is queued
  for the window's end and the lane edits the message (or sends once).
- **A definite 429 on an ended screen leaves the screen tappable** (Codex, #354): the wizard goes
  back to the step it was tapped at, so the next tap answers it; nothing else would for a draft.
- No customer message from a migration or backfill; nothing here has one.

## Automatic renewal (Round 10, D1)

Owner spec, binding: the customer opts in per service («تمدید خودکار», bot service screen
and mini app); before expiry (`auto_renew.lead_hours`, default 24) a covered wallet renews
it through the normal renewal service — same pricing, ledger, provisioning, and ops log
«منبع: تمدید خودکار»; a short wallet gets ONE notice through the reminder lane; idempotent
per service per period, never double-charged; feature flag `service_auto_renew` OFF by
default, switchable from the Web Admin. Lead decisions (Round 10): imported (Mirza)
services are not offered it in v1 (`OQ-R10-D1-01`); a price above the total consented at
opt-in is not renewed and is told once; a transfer clears the consent; the worker acts as
`SYSTEM_JOB` (surface and idempotency namespace `SCHEDULER`) with keys derived from the
unique (service, period) run row; the flag off stops new runs immediately.

- **No second money path.** The sweep runs the customer's own RENEW draft, confirmation
  and `settleFromWallet`, exactly as the manual order runs an operator's.
- **A debit commits only with `RENEWED`.** The run's `CLAIMED -> RENEWED` is the
  settlement's `inTransaction` hook, conditional on the attempt, and it re-reads the flag,
  the owner's consent and its ceiling where the money moves.
- **No order for money that is not there.** The wallet is read before any draft.

## Phase 2 control plane

Three Phase 2 rules that are easy to break by accident:

- A template body is stored **raw** and rendered nowhere near where it is
  edited. Nothing in this codebase may persist a rendered string.
- A setting is declared in the registry or it does not exist. Unknown keys fail
  closed at the schema, the service and the surface.
- A feature flag is a boolean; its parameters are settings. Neither registry
  grows a field that belongs to the other.

## Phase 6 capacity and usernames

**A service's username is per-panel policy, not a derivation.** A panel allows
CUSTOM, RANDOM or both; a customer's chosen name is canonicalised to lowercase,
held by a reservation row in a namespace derived from the provider and host —
deliberately NOT tenant-scoped, because two tenants pointing at one machine
share its account namespace — funded in the transaction that takes the money,
and released only by the transaction that gives it back. A panel with no
template keeps the `nx…` shape. `docs/phase6c-username-falsification.md`.

Four Phase 6B rules, each naming a way to oversell or mis-sell a panel:

- A capacity slot is a **RESERVATION ROW**, not a count. Between a confirmation
  and a payment there is no service, so counting services sells the last slot
  twice and the second customer finds out after paying. `reserve` takes the
  panel's row lock FIRST and counts AFTERWARDS — a count issued before the wait,
  or the subqueries of a single `INSERT ... SELECT`, see the state the loser
  started from.
- **Operability and eligibility are different questions** and disagree in both
  directions. `decideOperability` asks whether one operation may run and ignores
  health; `decideEligibility` asks whether we may take money for a new account
  and ignores capabilities. A full panel is operable; a panel whose adapter
  cannot suspend is sellable.
- Eligibility is decided by **one evaluator with four callers** — catalogue,
  confirmation, settlement, release. Catalogue filtering is a courtesy and is
  never trusted: confirmation re-decides inside its transaction under the panel's
  lock, and settlement re-decides again. A predicate copied into four places
  disagrees with itself invisibly.
- **Enabling a panel requires a connection test bound to what it is NOW.**
  `validated_identity` is provider, address, activation and the three credential
  timestamps — deliberately NOT `configurationFingerprint`, which carries
  `status` and `updated_at` and would be invalidated by the act it authorises.
  Lowering a cap below current usage is accepted and terminates nothing.

## Deployment

**The deployment checkpoint after Phase 2 is done too**: an immutable image,
a production Compose topology behind Caddy, an Ubuntu installer, and `botctl`
with update and rollback (ADR-0022, `docs/deployment.md`). `v0.2.0` and
`v0.2.1` HAVE been deployed to a real staging server, and the owner's own
acceptance on them is what produced the Telegram main menu and the Phase 5
payment work. What is still unrun is the PRODUCTION checklist —
`docs/vps-acceptance.md` decides that. `BLOCKER-SECRETS-V2` is **partly closed**: the v2
envelope, keyring, rewrap and retire-check exist; what is open is dropping the legacy
`SECRETS_KEK` alias and refusing v1 everywhere (`docs/open-questions.md`).

Three deployment rules that are easy to break by accident:

- The root `docker-compose.yml` is **development infrastructure**. Production
  is `deploy/`. Never merge the two.
- A release is a **digest**, never a tag. `botctl` resolves a version once and
  addresses the image by digest everywhere afterwards.
- `botctl rollback` never restores the database. The backup predates the
  migration, so restoring it would discard every write made since.

## Backup

Four backup rules (ADR-0025), because each names a way to produce a file that
looks like a backup and is not:

- The stage order is the contract: **DELIVER is reachable only from a
  VERIFY_RESTORE that passed**. A successful `pg_dump` is a file. Never add a
  path that delivers without verifying, and never verify the plaintext dump
  still on disk — verification decrypts the ENCRYPTED archive through
  `openArchive`, the same function the operator's restore uses.
- The dump **excludes nothing**. Not by table name, not by prefix, not because a
  table looks transient — `processed_messages` looks like a cache and is what
  stops a redelivered outbox message duplicating its effect. An exclusion needs
  a reason inside the manifest, where a restorer can read it.
- Delivery has **three** outcomes, and the third is why the run row exists.
  A 5xx, a 429, a timeout and an unreadable 2xx are `OUTCOME_UNKNOWN`, never
  "retryable": Telegram can reject a request whose upload it accepted. Nothing
  resends automatically. Never fold this into `DELIVERY_OUTCOMES` — that enum is
  the notification dispatcher's and is pinned by a CHECK constraint.
- One backup at a time is a **partial unique index**, not a process. Two worker
  replicas is normal on every rolling update. A stale lease is taken over by
  FAILING the abandoned run, never by adopting it: its files belong to a process
  that may still be writing them.

## Recovery

Five recovery rules (ADR-0028). Each one is a way to produce something that
looks like a restore and is not:

- **No HTTP request restores into the database serving it.** A request may
  upload, verify and confirm; the destructive work belongs to the `recovery`
  process role. Never add a path where a controller calls `pg_restore` against
  the live database — that is the instruction this whole design exists to obey,
  and it is one convenience refactor away from being broken.
- **The cutover is two RENAMES, and nothing drops the displaced database.** The
  candidate is restored into a new database, validated, and only then renamed
  into place; the outgoing one survives as `nexa_pre_restore_<id>` and is the
  rollback. Adding a cleanup that drops it turns a two-rename rollback into a
  restore from an archive — and it is the only copy of what the restore replaced.
  It survives the cutover only because of the pool's `'error'` listener: `pg`
  delivers connection death as an EVENT, and an unlistened one throws.
- **The quiesce is derived from the recovery row's state**, never from a second
  flag, and it is enforced at the two places a durable write actually passes —
  `DrizzleUnitOfWork.run` and `OutboxRelay.processBatch`. `PRE_RESTORE_BACKUP` is
  deliberately outside the window. A surface ALSO checks on arrival: the gate
  alone lets a six-stage pipeline run to COMPLETED with its writes refused one at
  a time, which is how a backup came to be reported as taken during a restore.
- **The confirmation binds to the artifact's SHA-256 and expires**, and both are
  checked again by the executor as it claims the work. The phrase is a constant,
  so storing the phrase proves nothing; the checksum is what makes a confirmation
  for one archive unable to restore another.
- **Every state change is a conditional UPDATE naming its `from` states.** There
  is no `setState`. That one mechanism is what makes a replay, a double-click and
  two executor replicas all safe, and a convenience setter would quietly remove
  it from all three.

## Real-panel acceptance

One more, learned by running a real panel (`docs/real-panel-acceptance.md`):

- A fake this repository wrote and an adapter this repository wrote can only
  prove they **agree with each other**. Four defects reached `main` that way and
  each shipped behind a green suite: three on the Sanaei create path (two wrong
  routes and a dropped CSRF token), and one on Marzban's, where omitting
  `inbounds` was documented as "every inbound" and actually means NONE — a 200,
  a subscription URL, and a zero-byte subscription for the customer. So a
  provider rule is verified against the real panel binary, and the fake is
  corrected to match it in the same commit. `pnpm test:acceptance` needs a
  disposable panel of each kind and **fails rather than skips** without one; it
  is not in `pnpm verify` and CI does not run it.
- A capability is declared **after** the acceptance proves it, never before.
  `capabilities` is what the product promises an operator, and
  `canDisableUser`/`canEnableUser`/`canDeleteUser` require the method AND the
  declaration, so an implemented-but-unproven operation is refused rather than
  offered.

## Operational events

One more, learned in Phase 3C:

- An operational-event CODE is part of the schema, not a string. `operational_events`
  dedupes and recovers by code, and the append-only guard forbids rewriting
  `code` on an existing row — so splitting or renaming one strands every row
  still open under it, unresolvable, for ever. Do it only in the release that
  introduced the code, or ship a reconciliation that resolves the open rows
  through the ordinary recorder.
