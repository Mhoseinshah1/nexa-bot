# Hotfix audit — a panel that passes its health check and cannot create a service

Read out of the tree at `4cd87a0` (the merge of PR #57), before any line of the fix
was written. Every claim in the production report was checked against the code
rather than accepted, and every number in it is explained below.

## The incident, reconstructed from the code

Order `01a0c54b-d282-71a7-8607-3978533cd3a0`, on v0.2.8. The panel was `ACTIVE`,
`HEALTHY` and had free capacity, and it could not create a user, because its
Marzban activation configuration was absent or incomplete. The customer paid
10,000 toman, waited about seven minutes, and got their money back.

Nothing in that sequence is a bug in the sense of a line that does the wrong
thing. It is four correct components answering four different questions, none of
which is "may we sell this".

| Production fact | The code that produces it |
| --- | --- |
| The panel was sellable while unprovisionable | `decideEligibility` reads status, health and capacity. It does not read activation, credentials, capability or whether a connection test ever passed. |
| Payment was accepted | `PanelSalesGate.acquire` (confirmation) and `.consume` (settlement) both decide through that same evaluator, so the transaction-level recheck re-asked the same incomplete question. |
| `attempts = 5` | `OPERATION_MAX_ATTEMPTS = 5`. |
| `failure_message = ACTIVATION_INCOMPLETE` | `decideOperability` — the evaluator that DOES check activation — runs in the provisioner, which is after the money has moved. |
| ~7 minutes | `refusalIsPermanent` returns true only for `PROVIDER_NOT_OPERABLE` and `CAPABILITY_UNSUPPORTED`. `ACTIVATION_INCOMPLETE` backs off: 30s + 60s + 120s + 240s = 450s ≈ 7.5 min. |
| No useful provisioner log | `ProvisionerService` takes no logger. `ProvisionerLoop` has one and uses it on exactly one line — a thrown tick. A refusal returns a value and logs nothing. |
| `services.state = TERMINATED`, `delivery_state = PENDING` | `refundPurchase` transitions the service to `TERMINATED` and does not touch `delivery_state`, which no longer means anything for a service that will never be delivered. |
| Wallet 4,870,000 → 4,880,000 | Correct, and the one part of the incident that worked as designed. |

## The two evaluators, and the gap between them

This codebase already knows that operability and eligibility are different
questions — `CLAUDE.md` states it as a Phase 6B rule, and both docblocks argue it
at length. What neither of them says, and what this incident is, is that
**eligibility is missing a term that operability has**.

- `decideOperability` (`provisioning/application/panel-operability.ts`) asks *may
  this one operation run*: adapter exists, capability supported, credentials
  shaped, activation parses. It ignores health, deliberately.
- `decideEligibility` (`panels/application/panel-eligibility.ts`) asks *may we
  take money for a new account*: not archived, not disabled, not confirmed-down,
  not full. It ignores capabilities, deliberately.

The deliberate ignorance in the second is the defect. "Ignores capabilities" was
written about `SUSPEND` — a panel whose adapter cannot suspend is still sellable,
which is right. It silently also ignores `PROVISION`, which is the one capability
without which the sale cannot be delivered at all, and it ignores the
configuration that capability needs.

**So the fix belongs in `decideEligibility` and nowhere else.** It has four
callers — catalogue, confirmation, settlement, release — and the class docblock of
`PanelSalesGate` already explains why a predicate must not be copied among them.
Adding the missing terms to the one evaluator fixes the catalogue, the
confirmation and the settlement recheck in one place, which is exactly the
architecture this repository already chose.

## Findings

| # | Finding | Verdict |
| --- | --- | --- |
| F1 | `decideEligibility` omits activation, credentials, `PROVISION` and any connection-test evidence. | **CONFIRMED** — root cause. |
| F2 | The Web Admin has no input for `proxyProtocols` or `inboundTags` at all. `requiredActivationFields` is rendered as a read-only banner naming the field names, and the table column prints the same list. An operator cannot configure a Marzban panel from the Web Admin — the only route is a raw `PATCH /panels/:id`. | **CONFIRMED** — proximate cause. |
| F3 | `refusalIsPermanent` treats four operator-configuration refusals as transient. | **CONFIRMED.** |
| F4 | `ProvisionerService` has no logger. Per-operation outcomes are invisible. | **CONFIRMED.** |
| F5 | `ORDER_REFUNDED_TO_WALLET` renders a frozen template with no placeholders and the lane carries no payload. The required message names an amount and a balance. | **CONFIRMED — needs a design decision**, see below. |
| F6 | `web.orders_scope_body` says delivery, cancellation and refund do not exist in this version; `web.payment_not_settled_here` says service creation does not happen in this version. Both false since 4D/4G. | **CONFIRMED.** |
| F7 | The order detail page shows payments and nothing about the service, the provisioning operation, the terminal failure or the refund. | **CONFIRMED.** |
| F8 | A terminated-never-provisioned service still reads `delivery_state = PENDING`. | **CONFIRMED**, cosmetic; fixed at the surface, not by rewriting the column. |
| F9 | The already-paid defensive path refunds exactly once. `UndeliverableOrderRefunder` is idempotent at three independent levels — conditional order transition, payment-locking `refundUndeliverable` returning null, and a unique `(tenant, kind, subject)` on the notification. | **ALREADY CORRECT** — has no test naming it. |
| F10 | A planned operation is due immediately: `plan` writes `nextAttemptAt: now`, and the claim orders by that column. The first attempt waits at most one tick. | **ALREADY CORRECT** — has no test naming it. |

## Two decisions this hotfix has to take, and takes explicitly

### D1 — "a connection test has succeeded" must not mean "recently"

The requirement is that a sellable panel must have a passed connection test. The
obvious implementation reuses `validationAuthorisesEnable`, which requires the
probe to be **fresh** (`PANEL_HEALTH_FRESH_FOR_MS`).

That would reintroduce, as a sales rule, the exact failure `decideEligibility`'s
docblock already refuses: *"A panel whose health is STALE is eligible, and this is
the rule that keeps a stopped monitor from closing every shop in the
installation."* A monitor stopped for an afternoon would take every panel in the
installation out of the catalogue.

So sellability requires that a probe **concluded something usable against the
panel's CURRENT identity** — `validatedIdentity === connectionIdentityOf(panel)` —
and does **not** require it to be recent. That is the strictly stronger reading of
"a connection test has succeeded": not "somebody tested it lately" but "the thing
that was tested is the thing we would sell onto". Change the address, the
activation or a credential, and the evidence stops counting the moment it stops
describing the panel. Staleness remains the health lane's business, where
`isConfirmedUnusable` already handles it with hysteresis.

### D2 — the refund message needs figures, and NOT a payload

> **Corrected during implementation.** What follows was the reasoning at audit
> time and its conclusion was wrong in one respect, so it is kept with the
> correction attached rather than rewritten — the whole point of writing the
> audit first is that it records what was believed before the code was read
> properly.
>
> The lane already renders values for a kind, without a payload:
> `SERVICE_REMINDER_NOTIFICATION_KINDS` have their frozen figures **read back by
> subject id** at send time (`reminderValues`). The same works here and is
> strictly better. The subject is the order; the wallet ledger is append-only, so
> "what was credited for this order" is the sum of its REFUND entries and "the
> balance as of that credit" is the sum of every entry up to and including the
> last of them. Both are derived, both are stable for ever, and a resend states
> the same figures.
>
> **So ADR 0030 §1 stands unamended, no column is added, and no balance is
> stored** — which also keeps the non-negotiable that balance is derived from the
> ledger and never a column. The reasoning below is superseded from "so it is
> made as one" onwards.

`CUSTOMER_NOTIFICATION_KINDS` carries no payload by design, and `CLAUDE.md` states
it as a rule. The required message quotes a committed refund amount and a
committed wallet balance, which cannot come from a frozen sentence.

This is the owner's explicit instruction and it is the right call — "your money
went back, go and look at /wallet" is exactly the kind of answer the research
records as useless. But it is an architecture change, not a copy change, so it is
made as one: ADR 0030 is amended rather than quietly contradicted, the payload is
a **closed, per-kind, validated shape** rather than a free `jsonb` bag, and it is
rendered through the ordinary template placeholder machinery. A lane that could
carry arbitrary values would be the "send this customer some text" lane ADR 0030
exists to prevent; a lane that carries two money fields for one kind is not.

## Not in this hotfix

- `services.transfer` — untouched, still deferred.
- Anything in Phase 7.
- Provider adapter wire behaviour. The attached RickPanel OpenAPI document
  describes a *different* panel whose `/api/user` ignores `inbounds` and gives
  every user every protocol. That is evidence about RickPanel, not about Marzban
  v0.8.4, whose measured behaviour is recorded in `docs/providers/marzban.md`. A
  provider rule is verified against the real binary and corrected in the same
  commit as its fake; guessing from another vendor's document is what
  `docs/research/` forbids. Recorded, not acted on.
