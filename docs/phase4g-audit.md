# Phase 4G audit — payment completion

What Phase 4F left, measured against the code and against the applied schema rather
than remembered, before any of this phase is written.

4F's headline was that the money path produced exactly one kind of outcome — a new
service — and had to learn three more. This phase's headline is the same shape one
level up: **`PAYMENT_MACHINE` declares six ways a payment can end and this repository
can reach exactly one of them.** A payment either becomes CONFIRMED or stays PENDING
for ever. There is no rejection, no withdrawal, no expiry and no reconciliation, and
two partial indexes already exist to serve sweeps that were never written.

## What already exists

| Thing                                                     | Where                                                    | State                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_STATES` — six                                    | `packages/contracts/src/payment.ts`                      | Frozen. One reachable                                                                                                     |
| `PAYMENT_MACHINE` — seven transitions                     | same                                                     | Frozen. **One has a caller**                                                                                              |
| `PAYMENT_EVIDENCE_KINDS` incl. `RECONCILIATION`           | same                                                     | Frozen; `RECONCILIATION` has no writer                                                                                    |
| `PAYMENT_METHODS` incl. `GATEWAY`                         | same                                                     | `GATEWAY` refused, never simulated. No adapter                                                                            |
| `ORDER_MACHINE` edges `CANCEL` and `EXPIRE`               | `packages/contracts/src/commerce.ts`                     | Frozen. **Neither has a caller**                                                                                          |
| `receipts.review` — _"Approve or reject a receipt"_, HIGH | `packages/contracts/src/permissions.ts`                  | Granted to `finance` and `receipt_reviewer`. **Only approve exists**                                                      |
| `PaymentRepository`                                       | `.../payments/application/ports.ts`                      | `create`, `findById`, `findByReference`, `list`, `confirm`. **No transition method at all**                               |
| `PaymentService`                                          | `.../payments/application/payment.service.ts`            | `list`, `get`, `settleFromWallet`, `requestManualTransfer`, `confirmManualTransfer`                                       |
| `OrderRepository.transition`                              | `.../orders/application/ports.ts`                        | A conditional UPDATE, but its `stamps` are `confirmedAt` and `settledAt` only                                             |
| `orders_expiry_idx`                                       | applied schema                                           | `(expires_at) WHERE state = 'AWAITING_PAYMENT'` — **an index with no reader**                                             |
| `payments_unknown_idx`                                    | applied schema                                           | `(tenant_id, created_at) WHERE state = 'UNKNOWN'`, commented _"the reconciliation queue"_ — **no reader and no producer** |
| `RetentionSweeper`                                        | `.../platform/identity/application/retention-sweeper.ts` | The worked example of a bounded, health-reporting worker sweep                                                            |
| `ProvisionerService.expireDue`                            | `.../provisioning/application/provisioner.service.ts`    | The worked example of a lifecycle sweep inside a tick                                                                     |
| `OQ-4C-01`                                                | `docs/open-questions.md`                                 | Records the gap AND the owner's window. See below                                                                         |

## The absences, and what each costs

### 1. Five of the six payment outcomes have no caller

```
PENDING -> CONFIRMED  on CONFIRM              settleFromWallet, confirmManualTransfer
PENDING -> FAILED     on FAIL                 no caller
PENDING -> CANCELLED  on CANCEL               no caller
PENDING -> EXPIRED    on EXPIRE               no caller
PENDING -> UNKNOWN    on LOSE_TRACK           no caller
UNKNOWN -> CONFIRMED  on RECONCILE_CONFIRMED  no caller
UNKNOWN -> FAILED     on RECONCILE_FAILED     no caller
```

`PaymentRepository` offers no method that could take any of them: `confirm` is the only
write, and it is hard-bound to `PENDING -> CONFIRMED` with its evidence. So this is not
a service that forgot to call something — there is nothing to call.

The cost is stated inside the code that caused it. `requestManualTransfer`'s own
docblock, explaining why it answers a second tap with the existing payment instead of
creating a second one:

> Confirming either settles the order and strands the other PENDING for ever — **there
> is no cancel, fail or expire path in this release.**

### 2. `receipts.review` promises a decision and delivers half of one

The permission reads _"Approve or reject a receipt"_, is classified HIGH, and is carried
by two seeded roles. `POST /payments/:id/confirm` is the only write on the payments
controller, and `apps/web/src/pages/payments.tsx` says so in terms: _"This page has
exactly ONE write."_

An operator looking at a transfer that never arrived has no action. The row stays
PENDING, the order stays AWAITING_PAYMENT, and the customer keeps a live payment
instruction quoting a reference nobody will honour. This is precisely the shape
`CLAUDE.md` names as the legacy defect — a declared capability with no enforcement
behind it — with the sign reversed: declared, and no mechanism behind it.

### 3. Nothing expires anything, and the schema was built expecting that it would

`orders.expires_at` is written at DRAFT and re-read at confirmation. `payments.expires_at`
carries the order's deadline onto the payment. Both are read only by REFUSALS —
`orderAwaitingPayment` compares the deadline to the clock and throws `ORDER_EXPIRED` —
so a stale order is refused but never moved.

Two partial indexes exist for the sweeps that would move them, and neither index has a
reader anywhere in the codebase. An index is a statement about a query somebody meant to
write.

### 4. The order repository cannot perform `CANCEL` — the database would refuse it

`OrderRepository.transition` sets `state`, optionally `confirmedAt`, optionally
`settledAt`, and `updatedAt`. There is no `cancelledAt` stamp. The applied constraint,
read from the live database:

```
orders_cancelled_at_check | CHECK (((state = 'CANCELLED') = (cancelled_at IS NOT NULL)))
```

Measured, not reasoned about — the same UPDATE shape against a temp table carrying that
exact constraint:

```
INSERT 0 1
ERROR:  new row for relation "probe_orders" violates check constraint "orders_cancelled_at_check"
DETAIL:  Failing row contains (CANCELLED, null).
```

So `CANCEL` is not an unwritten call site; it is an unwritable one. `EXPIRE` is
different and worth stating separately: there is **no** `expired_at` column, so
`orders_*_at_check` has nothing to say about it and the existing signature can take that
edge unchanged. The asymmetry is deliberate in the schema and this phase must not
"tidy" it by adding a column no constraint asks for.

### 5. A payment has nowhere to record a non-confirmation outcome

`payments_confirmed_check`, read from the live database:

```
CHECK (((state = 'CONFIRMED') = ((confirmed_at IS NOT NULL) AND (evidence_kind IS NOT NULL))))
```

`confirmed_at`, `evidence_kind`, `evidence_note` and `confirmed_by_admin_id` are the
confirmation's evidence and the constraint binds them to CONFIRMED — correctly. A
REJECTION has the same evidentiary need and no column: who rejected it, when, and why.
Writing a rejection into `evidence_note` would be the legacy defect this schema was
designed against, because then one column means two things and no query can separate
them.

So 4G owes a column set, and the reason it owes it is the same reason 0035 exists: the
research records that the legacy receipt review stores neither reviewer nor time
(`UNK-PR-010`), so _"was this approved by a human"_ is unanswerable there. _"Was this
REJECTED by a human, and why"_ is the same question and currently has the same answer.

### 6. The confirmation guard freezes CONFIRMED only

`nexa_payments_confirmation_guard` (0033, replaced by 0035) opens with
`IF OLD.state = 'CONFIRMED' AND (...)`. Every other state is unguarded. Today that is
harmless, because no other state is reachable. The moment `FAILED`, `CANCELLED` and
`EXPIRED` become reachable it stops being harmless: a terminal payment could be moved
back to PENDING by any UPDATE, and `payments_state_check` — an enum membership test —
would not notice. The application will use conditional UPDATEs naming their `from`
states, which is the rule, and the rule that has to hold when an older binary is the one
writing is the database's.

`botctl rollback` never restores the database. That is why 4F answered its two
rollout-window findings with triggers (0049, 0050) rather than with a flag, and it is
the same answer here.

### 7. `UNKNOWN` has no producer, and inventing one would be the fake this repo forbids

`LOSE_TRACK` means an external side may have taken money and this installation cannot
tell. `payment.ts` is explicit about where that comes from:

> A gateway is reached through `PaymentGatewayPort` and there is no adapter in this
> release. An unconfigured gateway is REFUSED, not simulated.

`SELF_CONTAINED_PAYMENT_METHODS` is `WALLET` and `MANUAL_TRANSFER`. Neither can lose
track of anything: a wallet debit commits or rolls back in the same transaction as the
confirmation, and a manual transfer's outcome is an operator's assertion. **There is no
event in this release that could produce an `UNKNOWN` payment**, and no external
credential is available to this session to build one against.

Writing `reconcile()` now would give the reconciliation queue a consumer and still no
producer, which is a surface an operator can open and never see anything in — and worse,
a path whose only exercise would be a test fixture that put a payment into `UNKNOWN` by
hand. `CLAUDE.md` names that exact failure: _"A fake this repository wrote and an adapter
this repository wrote can only prove they agree with each other."_

So 4G builds the four edges that have a real producer — `FAIL`, `CANCEL`, `EXPIRE` and
the terminal freeze — and records `LOSE_TRACK` / `RECONCILE_CONFIRMED` /
`RECONCILE_FAILED` as blocked on the gateway rail, which is itself blocked on a decision
and a credential nobody in this session has.

### 8. The customer cannot withdraw, and is never told what happened

The bot's twenty-odd callback prefixes cover catalogue, order confirmation, the two
payment methods, and eight service actions. None of them withdraws anything. A customer
who chose MANUAL_TRANSFER and changed their mind has one option: never pay, and leave a
PENDING row behind for ever. There is no template for a payment that expired and none
for one an operator rejected, so even once the states are reachable, nothing would say
so.

## What the owner has already decided, and 4C could not use

`OQ-4C-01` deferred the expiry sweep because _"no contract states that hour"_. It also
records the owner's revision 4 verbatim:

> «مهلت پرداخت حداکثر **یک ساعت** است و پس از آن پرداخت و سفارش باید منقضی یا لغو شوند.
> این قاعده باید در دامنه و سرور اجرا شود، نه با یک تایمر در مرورگر.»

At most one hour; after it, the payment **and** the order must be expired or cancelled;
and the rule belongs in the domain and on the server rather than in a browser timer.

That is a stated policy, not an invented one. What 4C lacked was a place to put it, and
saying so is different from saying the number is unknown. 4G states it where a setting
is stated — bounded by the contract's own constants, with the owner's _"at most"_ as the
ceiling rather than as the default, so a tenant may shorten the window and may not
lengthen it past what the owner fixed.

`sales.order_expiry_minutes` is **not** that setting and must not be reused as it. Its
own description says it bounds a DRAFT's price hold; a customer holding a quote and a
customer holding bank details and an amount are in different situations, and the setting
registry already records the distinction in a comment.

## What 4G will build

1. **Contracts** — a resolution vocabulary for a payment that ended without money, the
   refusal codes each new path can produce, the HTTP shapes, and the payment-window
   setting bounded by the owner's hour. Its own commit, as `packages/contracts` requires.
2. **Schema** — the resolution columns with a CHECK binding them to the non-CONFIRMED
   terminal states; the guard widened to freeze every terminal state; `cancelled_at`
   reachable through `OrderRepository.transition`. (Migrations 0051, 0052 and — after
   the self-review found 0052's resolved branch narrower than its own message — 0053,
   which adds the three evidence columns it left writable.)
3. **Rejection and cancellation** — `PaymentRepository.transition` as a conditional
   UPDATE naming its `from` states, and the two service methods over it, each
   idempotent, audited, permission-checked and scope-activity-checked inside its
   transaction.
4. **The sweep** — one bounded, tenant-fair, multi-replica-safe worker lane that expires
   stale payments and their orders together, reporting freshness to the worker health
   check exactly as the existing sweepers do. This is what closes `OQ-4C-01`.
5. **Surfaces** — the customer withdrawing and being told; the operator rejecting with a
   reason. Server-side refusal in both cases regardless of what is drawn.

## What 4G will NOT build, and why

| Not built                                           | Why                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A gateway adapter                                   | No credential, no configured gateway, and `payment.ts` says an unconfigured one is refused rather than simulated. Out of the directive's scope and out of this session's means  |
| `LOSE_TRACK` / the two `RECONCILE_*` edges          | They have no producer without a gateway. Building the consumer alone would give an operator a queue that is empty by construction                                               |
| Reversing a CONFIRMED payment                       | That is a refund. `OQ-4C-02` holds the deferred decision and `refunds.issue` is CRITICAL and unimplemented. A confirmation stays frozen; a rejection is legal only from PENDING |
| Discounts, cashback, referral on any of these paths | Phase 7, and the directive puts it out of scope by name                                                                                                                         |
| A second amount or expiry policy layer              | `FBR-008` records the legacy precedence as unresolved. One window, one ceiling, no per-method override                                                                          |

## Open questions this phase will record rather than answer

- **What a rejection owes the customer.** Nothing in this release moves money on a
  rejection — a rejected manual transfer never took any — but the order it was against
  must not silently stay live at the old quote. 4G's answer is the narrowest one: a
  rejection resolves the payment and leaves the order AWAITING_PAYMENT until its own
  deadline, so the customer may pay again by another method within the window. Whether
  an operator should be able to reject-and-cancel in one action is a policy question and
  goes to the open questions.
- **Whether the review decision belongs in Telegram.** `OQ-4C-03` is already open on
  exactly this for approval. Rejection inherits it unchanged and must not be taken as
  settling it.

## What the phase found about itself

Two things worth recording beside the audit that opened it, because both changed the
shipped design after the code was written and the tests were green.

**The falsification pass found no untested rule and could not have found what came
next.** A mutation proves a rule is enforced; it cannot tell you the rule should have
been a different rule. The sweep's ordering invariant had a passing test and a docblock
that was false for any backlog larger than one pass's bound. The two halves of
`receipts.review` shared an idempotency identity, and every test of each half passed.

**A stopped tenant took the worker's health down.** The sweep threw for an inactive
scope, the loop records no progress for a pass that threw, and three minutes later the
worker container is unhealthy — so `botctl update` fails its readiness wait and backs
the release out after the migration has run, naming the release rather than the stop an
operator made deliberately. The existing worked example (`ProvisionerService.runOnce`)
answers the same condition with `IDLE`, and this now returns a zero report.

Both are in `docs/phase4g-falsification.md` with the rows that hold them, and both
argue the same thing: the deliberate review of the whole diff is not a formality after
the tests go green — on this phase it was where the two worst defects were found.
