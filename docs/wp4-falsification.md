# WP4 — falsification record

Every rule this package installs or relies on, reverted one at a time, against
the integration suite. The file is `tests/integration/customer-order-actions.test.ts`
unless another is named.

| #   | rule                                                                   | mutation                                                                                   | tests that die                                                                                            | result             |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------ |
| M1  | a transition that moved nothing is not a cancellation                  | `if (!changed && after.state !== 'CANCELLED')` → `if (false)`                              | `customer-order-actions.test.ts` › refuses a cancellation when the order settles first                    | KILLED             |
| M2  | the audit row belongs to the transaction that performed the transition | `if (changed)` → `if (true)` around the audit write                                        | `customer-order-actions.test.ts` › writes no audit row for a cancellation that lost the transition        | KILLED             |
| M3  | the same key twice is a replay, answered from the record               | the `replay` short-circuit deleted                                                         | `customer-order-actions.test.ts` › answers a redelivered cancellation from the idempotency record         | KILLED             |
| M4  | a claim landing mid-cancellation rolls the whole thing back            | the post-withdrawal `claimedPendingFor` guard → `if (false)`                               | `customer-order-actions.test.ts` › leaves no transition and no claim when the cancellation rolls back     | KILLED             |
| M5  | an order belonging to another customer is unknown                      | `before.customerId !== customerId` dropped from the guard                                  | `customer-order-actions.test.ts` › answers a cancellation of somebody else's order as unknown             | KILLED             |
| M6  | an order belonging to another tenant is unknown                        | `eq(orders.tenantId, tenantId)` dropped from the repository's `findById`                   | `customer-order-actions.test.ts` › refuses another tenant even when the customer id would match           | KILLED (see below) |
| M7  | the permission charged is the one the caller must actually hold        | `ORDER_PLACE_PERMISSION` → `'orders.manual.create'`                                        | `customer-order-actions.test.ts` › refuses a cancellation when the order settles first                    | KILLED             |
| M8  | the permission is charged BEFORE the replay lookup                     | the `guard.check` in `OrderService.authorize` → a no-op                                    | `customer-order-actions.test.ts` › refuses an unauthorized replay instead of answering it from the record | KILLED             |
| M9  | authorization is enforced on the cancel path at all                    | BOTH `guard.check` calls — `OrderService.authorize` and `runAuthorizedMutation` — → no-ops | `customer-order-actions.test.ts` › refuses an actor that does not hold the order permission               | KILLED (see below) |

## M6 survived first, and that was a finding about the test

The cross-tenant case that already existed — _answers a cancellation from another
tenant as unknown_ — passes with the tenant predicate deleted. It asks for tenant
A's order through tenant B's scope **and** with tenant B's customer id, so the
OWNERSHIP predicate refuses it before tenancy is ever consulted. Two guards, one
argument, and the test could not tell you which was doing the work.

`refuses another tenant even when the customer id would match` removes the
ownership predicate from the argument by passing tenant A's own customer id.
Nothing but the repository's tenant predicate can refuse that, and deleting it
turns the case red. The original case is kept: it still asserts the ordinary
shape of the refusal.

## What the mutations say about the shape of the fix

M2 is the package's own rule and dies alone: reverting it leaves M1's test green,
because a lost transition is still refused — it just used to claim a SUCCESS on
the way out. That separation is the point. The transition guard decides what the
customer is TOLD; the audit gate decides what the log CLAIMS. Two different
failures, two different tests, and neither covers the other.

## One test corrected rather than added to

`answers both when two taps arrive together` (formerly _cancels once when two
taps arrive together_) claimed to be "the conditional UPDATE carrying the whole
concurrency story". It is not. `Promise.all` does not interleave these two inside
the window — the second transaction's opening read happens after the first
commits, so it takes the early return and never reaches the `!changed` branch.

Measured, not reasoned: that case passes with M2 applied. Its comment now says
what it actually establishes, and the real race is driven beside it with a row
lock. `CLAUDE.md` names this exact shape, and the C4 case in the same file had
already hit it once.

## The transaction boundary: a mutation with no reachable test

Dropping the `tx` argument from `this.deps.audit.record(...)` — so the audit row
is written outside the business transaction — is not detectable by any test in
this suite. It has no row above, because a row in a citation table must name a
test that dies and this mutation kills none.

The reason is structural: on the only path where the
transaction rolls back after a state change — a payment claim landing mid-cancel,
M4's case — the rollback is raised BEFORE the audit write is reached. There is no
reachable interleaving in which the audit row is written and the transaction then
aborts.

The one route that would produce it was tried and is closed. `rememberOnce` throws
after the audit write when a key is reused with a different payload, which would
be exactly the needed shape — but the idempotency store raises
`IDEMPOTENCY_PAYLOAD_MISMATCH` from `find`, which runs before the transaction
opens, so the command never reaches the audit write at all. That refusal is worth
pinning for its own sake, and it is:
`refuses a key reused with a different payload, changing nothing`.

So this is a rule with no test. It is stated here rather than asserted anywhere,
and the honest reading is that `tx` on that call is currently load-bearing only
against a future path that rolls back later than any path does today.

## M9 mutates two lines, because one at a time proves nothing here

`OrderService.authorize` charges the permission before the replay lookup;
`runAuthorizedMutation` charges it again inside the transaction. For a FIRST
attempt the two are redundant, so removing either one ALONE leaves every case in
the file green — both single mutations were run and both reported SURVIVED. That
is a rule with two guards, not a rule with no test, and the two findings look
identical in single-mutation output, so M9 removes both together. That is what
turns `refuses an actor that does not hold the order permission` red, and it is
the evidence that authorization is enforced on this path at all. The precedent is
`hardening-falsification.md` RET-01/RET-03, recorded the same way for the same
reason.

The early check has a purpose the inner one cannot serve, and M8 isolates it. A
replay is answered from `request_idempotency` without entering the transaction,
so the inner check never runs for it: without the early check, a caller holding
nothing who presents a key somebody else already used is handed that order back.
`refuses an unauthorized replay instead of answering it from the record` drives
exactly that, and it is a case this package added — before it, removing the early
check was undetectable.

The inner check is left without a mutation of its own, deliberately. Its distinct
value is a permission revoked BETWEEN the two checks, and that window is not
reachable from a test: `runAuthorizedMutation` runs its check before `fn`, so
there is no lock a case could block on in between. Defence in depth that no
outcome-level assertion can isolate — not a hole, since M9 shows removing it
alongside the other is caught.
