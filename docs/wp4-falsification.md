# WP4 — falsification record

Every rule this package installs or relies on, reverted one at a time, against
the integration suite. The file is `tests/integration/customer-order-actions.test.ts`
unless another is named.

| #   | rule                                                                   | mutation                                                                 | tests that die                                                                                        | result             |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------ |
| M1  | a transition that moved nothing is not a cancellation                  | `if (!changed && after.state !== 'CANCELLED')` → `if (false)`            | `customer-order-actions.test.ts` › refuses a cancellation when the order settles first                | KILLED             |
| M2  | the audit row belongs to the transaction that performed the transition | `if (changed)` → `if (true)` around the audit write                      | `customer-order-actions.test.ts` › writes no audit row for a cancellation that lost the transition    | KILLED             |
| M3  | the same key twice is a replay, answered from the record               | the `replay` short-circuit deleted                                       | `customer-order-actions.test.ts` › answers a redelivered cancellation from the idempotency record     | KILLED             |
| M4  | a claim landing mid-cancellation rolls the whole thing back            | the post-withdrawal `claimedPendingFor` guard → `if (false)`             | `customer-order-actions.test.ts` › leaves no transition and no claim when the cancellation rolls back | KILLED             |
| M5  | an order belonging to another customer is unknown                      | `before.customerId !== customerId` dropped from the guard                | `customer-order-actions.test.ts` › answers a cancellation of somebody else's order as unknown         | KILLED             |
| M6  | an order belonging to another tenant is unknown                        | `eq(orders.tenantId, tenantId)` dropped from the repository's `findById` | `customer-order-actions.test.ts` › refuses another tenant even when the customer id would match       | KILLED (see below) |

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
