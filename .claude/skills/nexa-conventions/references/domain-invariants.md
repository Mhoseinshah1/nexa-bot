# Domain invariants

Copied verbatim from CLAUDE.md on 2026-10-24; the same text, with the project
history around it, is in `docs/project-status.md`. If the two ever disagree,
`docs/project-status.md` is the record — fix this copy.

## Authorization

Authentication and authorization are real. Every new write path takes a
`ScopeContext` and an `ActorContext` and checks a permission through the guard —
never by inspecting an actor's type, and never by not drawing a button.

## Money

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

## Payments gateway (TonPays)

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

## Pricing

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

## Referral

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

## Resellers

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

## Customer notifications and operations (Phase 4)

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

## Templates, settings, flags (Phase 2)

Three Phase 2 rules that are easy to break by accident:

- A template body is stored **raw** and rendered nowhere near where it is
  edited. Nothing in this codebase may persist a rendered string.
- A setting is declared in the registry or it does not exist. Unknown keys fail
  closed at the schema, the service and the surface.
- A feature flag is a boolean; its parameters are settings. Neither registry
  grows a field that belongs to the other.

## Panels, credentials and health (Phase 3, 3C)

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

## Capacity and usernames (Phase 6B, 6C)

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

**A service's username is per-panel policy, not a derivation.** A panel allows
CUSTOM, RANDOM or both; a customer's chosen name is canonicalised to lowercase,
held by a reservation row in a namespace derived from the provider and host —
deliberately NOT tenant-scoped, because two tenants pointing at one machine
share its account namespace — funded in the transaction that takes the money,
and released only by the transaction that gives it back. A panel with no
template keeps the `nx…` shape. `docs/phase6c-username-falsification.md`.

## Real-panel acceptance and operational-event codes

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

One more, learned in Phase 3C:

- An operational-event CODE is part of the schema, not a string. `operational_events`
  dedupes and recovers by code, and the append-only guard forbids rewriting
  `code` on an existing row — so splitting or renaming one strands every row
  still open under it, unresolvable, for ever. Do it only in the release that
  introduced the code, or ship a reconciliation that resolves the open rows
  through the ordinary recorder.

## Backup (ADR-0025)

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

## Recovery (ADR-0028)

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

## Deployment

Three deployment rules that are easy to break by accident:

- The root `docker-compose.yml` is **development infrastructure**. Production
  is `deploy/`. Never merge the two.
- A release is a **digest**, never a tag. `botctl` resolves a version once and
  addresses the image by digest everywhere afterwards.
- `botctl rollback` never restores the database. The backup predates the
  migration, so restoring it would discard every write made since.
