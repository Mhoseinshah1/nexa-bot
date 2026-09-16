# ADR 0030 — the customer notification lane, and what a failed send means

**Status: accepted.** Phase 4H. Supersedes nothing; extends the rule
`DeliveryService` already applies to one message, to the several 4D–4G created.

## Context

`docs/phase4h-audit.md` §1 establishes by measurement that this product can tell a
customer exactly one thing they did not ask for — the subscription link — and that its
lane is shaped around that one subject. Phases 4D–4G created several more asynchronous
facts a customer needs: a payment rejected or expired, six customer-initiated operation
kinds completing or failing (three of which they have paid for), and provisioning that
has stalled.

`OQ-4G-01` deferred building the lane and named the reason: _"a best-effort
`CustomerMessenger.send` from inside the sweep would be a message whose failure nobody
records, which is the shape `DeliveryService` exists because of."_ It also named the
design question this ADR exists to answer — **what a failed send to a customer means** —
and said the answer belongs with the Telegram UX rather than bolted to a sweep.

Three mechanisms in this repository already answer a version of that question, and none
of the three transfers unexamined:

- the **Phase 2 notification dispatcher**, whose destinations are operator channels and
  whose `DELIVERY_OUTCOMES` enum is pinned by a CHECK constraint;
- **`DeliveryService`**, which answers it for one subscription link;
- the **backup pipeline** (ADR 0025), whose third delivery outcome exists precisely
  because Telegram can reject a request whose upload it accepted.

## Decision

### 1. A new table, not the outbox and not `notifications`

The lane gets its own table with its own state machine, claim, lease and attempt count.

**Not `notifications`.** That table is the operator lane. `CLAUDE.md` states the rule
this would break: its `DELIVERY_OUTCOMES` enum is the dispatcher's and is pinned by a
CHECK constraint, and ADR 0025 already records what happens when one enum is made to
serve two audiences. A customer and an operator are different audiences with different
answers to "what does a failed send mean" — an operator alert that is late is still
useful, and a duplicate one is merely noise.

**Not the outbox.** `outbox_messages` carries DOMAIN EVENTS and its append-only guard
freezes their content while allowing delivery bookkeeping. A customer message is an
EFFECT of an event, not the event; a lane built on outbox rows would conflate "what
happened" with "what we told someone about it", and could not carry the per-message
state (claimed, sent-started, delivered, unconfirmed, failed) that the send needs.

The enqueue still happens **inside the business transaction** that produced the fact,
exactly as the outbox rule requires. What is new is a row in the lane's own table, not a
second mechanism for getting events out of a transaction.

### 2. The outcome table is `DeliveryService`'s, with one correction

`CustomerSendOutcome` is already three-valued and the reasoning is already written down:

| Outcome     | Meaning                            | Lane                                                                 |
| ----------- | ---------------------------------- | -------------------------------------------------------------------- |
| `DELIVERED` | Telegram accepted it               | terminal, delivered                                                  |
| `REFUSED`   | Telegram rejected it               | retried with backoff until the attempt ceiling, then terminal FAILED |
| `UNKNOWN`   | Telegram **may** have delivered it | terminal `UNCONFIRMED`, **never** retried automatically              |

`UNKNOWN` is the one that matters and it is not negotiable: a retried "your service is
ready" is a customer wondering which of two links is real, and a retried "your payment
was rejected" is worse. This is the same third outcome ADR 0025 insists on for backup
delivery and for the same reason.

**The correction.** A 429 is currently folded into `UNKNOWN`, and it must not be.

This is a DELIBERATE, documented classification rather than an oversight, and saying so
is the point of putting it in an ADR instead of a bug fix. `provisioning.ts:443` defines
`UNCONFIRMED` as _"the send outcome was `UNKNOWN`: a timeout, a 5xx, a 429, or a 2xx whose
body would not parse. The customer MAY have it."_ The 429 is named there explicitly.

It is nonetheless wrong on the facts, and listing it beside three genuinely ambiguous
cases is how it survived. A timeout, a 5xx and an unreadable 2xx all mean the request may
have been processed and the customer may be holding the message. A 429 means Telegram
DECLINED that request and told us when to come back. There is no ambiguity about delivery
in a 429; there is only a delay.

The chain, verifiable by reading:

1. `apps/api/src/infrastructure/telegram/send-message.ts:135` — a 429 returns
   `FAILED_RETRYABLE` with `errorCode: 'telegram.rate_limited'` and Telegram's own
   `retry_after` as `retryAfterMs`.
2. `apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts:181`
   — `const unknown = result.outcome === 'FAILED_RETRYABLE'`, so **every** retryable
   failure becomes `UNKNOWN`. The distinct error code and the `retryAfterMs` are
   discarded.
3. `delivery.service.ts:61` — `deliveryStateAfter(PENDING, 'UNKNOWN', n)` is
   `'UNCONFIRMED'`.
4. `drizzle-service.repository.ts:451` — the due query claims
   `deliveryState = 'PENDING'` only, so `UNCONFIRMED` is never re-claimed.

So **one rate-limit response permanently withholds a paid customer's subscription link
until a human notices** — and a 429 is what Telegram sends precisely when many customers
are being served at once. A 429 is Telegram declining a request; it is not ambiguous
about delivery.

The lane therefore distinguishes it, and so does `DeliveryService`:

- a rate limit is **retried**, not terminal;
- it does **not spend an attempt** — the attempt ceiling exists to bound refusals of
  _this message_, and burning three attempts on a burst would fail a message that was
  never rejected on its merits;
- the next attempt is Telegram's own `retry_after` where it gave one, because a back-off
  we invented would be ruder or slower than the number the server asked for. This is the
  rule `telegram-transport.test.ts` already states for the transport and that the
  provider lane already follows (`BUDGET_EXHAUSTED` uses the refusal's bounded
  `retryAfterMs`).

This correction is implemented with the lane, in 4H-2, so that one table serves both and
there is no second copy to drift. **No committed test asserts the current behaviour**;
the four references above are a code-path claim, checkable by reading, and the
regression test arrives in the commit that fixes it.

### 3. Staleness is per-kind and is re-checked after the claim, not a TTL column

Most of what the lane carries are facts about a **terminal** state — rejected, expired,
cancelled, an operation succeeded or failed. Those do not go stale: an hour-late "your
payment was rejected" is still true and still actionable, and the customer's other route
to it (`bot.payment.not_pending` on the old button) is unchanged.

One kind is different. "Your service is taking longer than expected" is a claim about a
**transient** state and is false once the service is ACTIVE — and arriving a second
before the subscription link would be worse than not arriving.

So there is no expiry column and no invented TTL. Instead the dispatcher re-reads the
subject and re-checks a per-kind precondition **after claiming and before sending**; a
kind with no precondition says so explicitly. This is the same discipline the repository
already applies everywhere — `OrderRepository.expireDue` and `ServiceRepository.claimDue`
both re-check every predicate after the row lock — and it keeps the decision next to the
fact rather than in a number nobody can justify.

### 4. Fairness is the loop's scope, bounded per pass — not a second budget

The lane drains due rows oldest-first, bounded per pass, within the scope the loop
resolves. It does **not** get a second rate budget.

The panel monitor's claim-and-budget model exists because outbound calls to a _panel_ are
rate-limited per tenant and background work must not raise a tenant's total outbound
rate — `CLAUDE.md` states that reserve-floor rule. Telegram's limits are per BOT and per
CHAT, not per tenant, and the mechanism that already respects them is the one in §2:
Telegram says `retry_after` and we obey it. Inventing a client-side token bucket beside
that would be a second, weaker opinion about a number the server already supplies.

What the lane does owe is that one customer cannot monopolise a pass, which the
oldest-first bound gives, and that a wedged row cannot hold the lane, which the lease
gives.

### 5. The executor still cannot call a messenger

`ProvisionerLoop`'s constructor states the property and it is structural rather than a
comment: `ProvisionerService` does not hold a `CustomerMessenger`, so a failed Telegram
send **cannot** reach the provisioning transaction. The lane preserves this. Producers
enqueue a row inside their transaction; a separate dispatcher sends. Nothing that sends
holds a transaction, which is the repository's non-negotiable "no network call inside a
database transaction" seen from the other side.

## Consequences

- One more worker loop, with `LoopProgress` health like the others, so a lane whose every
  pass fails becomes visible instead of silent.
- `DeliveryService`'s outcome table gains a rate-limit row, and its behaviour changes:
  a rate-limited subscription send is retried instead of being parked in `UNCONFIRMED`.
  That is a behaviour change to merged code and is called out as such.
- `CustomerSendOutcome` grows to distinguish a rate limit. It lives in the module's own
  `ports.ts`, not in `packages/contracts`, so this is not a frozen-contract change.
- A kind added later must declare its precondition, or declare that it has none. That is
  deliberate friction: §3 is the rule that stops a "still working on it" message arriving
  after the thing it is about has finished.

## What this ADR does not decide

- **Whether an operator may end an order when rejecting a receipt** — `OQ-4G-02`,
  business policy, still the owner's.
- **Whether the approval decision belongs in Telegram** — `OQ-4C-03`. The lane carries
  the customer's half of the conversation and changes nothing about where an operator
  decides.
- **Receipts as files.** Owner revision 17 is honoured in full and 4H does not touch it.
