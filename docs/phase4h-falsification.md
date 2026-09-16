# Phase 4H falsification — the lane that tells a customer

Every rule Phase 4H introduces, reverted one at a time, with the committed test
that fails as a result. `scripts/falsify.sh` applies the mutation, runs the named
file, restores the tree and refuses to report anything if the restore is not
byte-identical.

This file grows with the phase. It starts with the contracts commit, because a
vocabulary can be wrong in exactly one interesting way — a machine nothing
validates — and that is worth proving before anything is built on it.

## The vocabulary

| #      | Rule                                                                  | Mutation                                      | Named test                                                        | Result |
| ------ | --------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | ------ |
| F4H-01 | `CUSTOMER_NOTIFICATION_MACHINE` is registered and therefore validated | the `PENDING → SUPERSEDED` transition deleted | `contracts-invariants.test.ts` › validates every declared machine | KILLED |

F4H-01 is the row this phase's vocabulary needed most, and the reason is the
shape of the machine rather than the machine being new. Every state in it except
the initial one is terminal, so a dropped edge does not leave a dead end — the
failure a reader notices — it leaves a state UNREACHABLE, which nothing about
reading the file would reveal. Deleting the `SUPERSEDE` edge produced exactly
that, naming the machine:

```
"machine": "CustomerNotification",
"message": "State \"SUPERSEDED\" cannot be reached from \"PENDING\".",
"state": "SUPERSEDED",
```

Registering a machine in `STATE_MACHINES` is one line and forgetting it is
silent, which is why the mutation is worth running rather than assuming: a
machine declared and not registered is a machine nothing checks, and it would
have passed every other test in the suite.

## The lane, and the 429 that stranded a paid customer

| #      | Rule                                                                        | Mutation                                                      | Named test                                                                                             | Result |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| F4H-02 | a Telegram 429 is RATE_LIMITED, never a send whose fate is unknown          | the `telegram.rate_limited` branch deleted from the messenger | `customer-send-rate-limit.test.ts` › never becomes the state the delivery sweep refuses to re-claim    | KILLED |
| F4H-03 | `DeliveryService` HOLDS on a rate limit rather than recording an outcome    | the hold replaced by `recordDelivery(..., 'UNCONFIRMED')`     | `provisioning-delivery.test.ts` › does not spend an attempt when Telegram rate-limits the announcement | KILLED |
| F4H-04 | the backoff is Telegram's own `retry_after`, with our floor only as default | `result.retryAfterMs ?? BACKOFF` replaced by a bare `BACKOFF` | `provisioning-delivery.test.ts` › does not spend an attempt when Telegram rate-limits the announcement | KILLED |

F4H-02 also killed two sibling cases in the same file — the two that read
Telegram's `retry_after` — so the branch is pinned three ways.

F4H-04 is recorded because its FIRST version survived, and the reason is worth
keeping: the test sent `retry_after: 30` while `DELIVERY_BACKOFF_MS` is five
minutes, so "honoured Telegram's number" and "fell back to our floor" both
satisfied `>= now + 30s`. The fix was the fixture, not the rule — the 429 now
says nine hundred seconds, which is longer than the floor, and the mutation
KILLED. A test that cannot distinguish a rule from its absence is not a test.

## The outcome announcer

| #      | Rule                                                        | Mutation                                               | Named test                                                                                      | Result |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------ |
| F4H-05 | only SUCCEEDED and ABANDONED are announced                  | the terminal check narrowed to `outcome === 'PLANNED'` | `operation-outcome-announcer.test.ts` › says nothing about a FAILED operation                   | KILLED |
| F4H-06 | only the six operations a customer starts are announced     | the `CUSTOMER_INITIATED_OPERATIONS` filter removed     | `operation-outcome-announcer.test.ts` › says nothing about an operation no customer asked for   | KILLED |
| F4H-07 | the notification is keyed on the OPERATION, not the service | `serviceId` passed as the subject                      | `operation-outcome-announcer.test.ts` › keys the notification on the operation, not the service | KILLED |

F4H-07 is the row worth reading twice. `customer_notifications_subject_key` is
`(tenant, kind, subject)`, so keying on the service is not a crash and not a
duplicate — it is a customer being told about their FIRST renewal and silently
never told about any renewal after it, because the second enqueue hits the unique
index and no-ops exactly as a replay does. Green suite, working product, one
customer per service per lifetime hearing nothing.

## A customer's claim, and their own order

| #      | Rule                                                              | Mutation                                                  | Named test                                                                                        | Result |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| F4H-08 | the FIRST claim is the recorded one                               | `customer_signalled_at IS NULL` dropped from `signalSent` | `customer-order-actions.test.ts` › keeps the FIRST claim when the customer taps again             | KILLED |
| F4H-09 | the repository refuses a stamp on a payment that has ended        | `state = 'PENDING'` dropped from `signalSent`             | `customer-order-actions.test.ts` › refuses the stamp at the REPOSITORY when the payment has ended | KILLED |
| F4H-10 | cancelling an order closes the transfer instruction with it       | `withdrawPendingFor` replaced by an empty list            | `customer-order-actions.test.ts` › closes the live transfer instruction with the order            | KILLED |
| F4H-11 | an order whose transfer was claimed as sent cannot be cancelled   | the `claimedPendingFor` refusal short-circuited to false  | `customer-order-actions.test.ts` › refuses to cancel once the customer has said they paid         | KILLED |
| F4H-12 | only an `AWAITING_PAYMENT` order may be cancelled by its customer | the source-state check deleted                            | `customer-order-actions.test.ts` › refuses to cancel an order that has been paid                  | KILLED |
| F4H-13 | a cancellation re-reads the OWNER from the row                    | `before.customerId !== customerId` removed                | `customer-order-actions.test.ts` › answers a cancellation of somebody else's order as unknown     | KILLED |
| F4H-14 | a claim re-reads the OWNER from the row                           | `payment.customerId !== customerId` removed               | `customer-order-actions.test.ts` › answers a claim about somebody else's payment as unknown       | KILLED |

F4H-09 survived on its first run, and the honest reason is worth recording
rather than quietly fixing: through `PaymentService.signalTransferSent` the
repository's own `state = 'PENDING'` predicate is UNREACHABLE, because the
service refuses a non-PENDING payment before it. So the mutation left every test
in the file green — a rule the suite could not distinguish from its own absence,
which is precisely the shape `CLAUDE.md` says gets silently reverted.

The response was a test that calls the repository directly rather than deleting
the predicate. It is worth keeping for the reason it is worth testing: it is what
makes `signalSent`'s `false` mean "there was nothing to record" rather than "the
caller already checked", and the next caller may not check. With that test in
place the same mutation KILLED.

The two schema-level rules are asserted against the driver's own message rather
than against "it threw", because a missing column and a NOT NULL violation would
also throw and neither would prove the trigger fired:

- migration 0058's CONFIRMED branch — «a confirmed payment's money … and what the
  customer claimed — are immutable» — for a claim stamped after an approval.
- `payments_customer_signal_check` — for a claim on anything that is not a
  `MANUAL_TRANSFER`.

## The defect a button assertion could not see

Not a mutation — a real bug, found by reading the diff after the tests were green,
and recorded here because the reason the suite missed it is the same reason
mutation testing exists.

`cancelOrderAsk` first called `OrderService.get` to re-read the order before
drawing its question. That is the OPERATOR's read and it checks `orders.view`. A
customer-initiated Telegram turn runs as `SYSTEM_JOB`, whose entire grant is

```
$ sed -n '318,320p' packages/contracts/src/permissions.ts
export const SYSTEM_JOB_PERMISSIONS = [
  'maintenance.run',
] as const satisfies readonly PermissionKey[];
```

so every customer who tapped the cancel button would have been refused. Eighteen
integration cases covered the cancellation itself and two surface cases asserted
the BUTTON was drawn; none of them tapped it, so nothing was red.

The fix is `OrderService.awaitingPaymentForCustomer`, the same
customer-scoped read `PaymentService.pendingTransferForCustomer` already is: it
returns only a row in the state the question is about, compares ownership against
the row, and takes no permission because it draws a question rather than
performing anything.

Two new cases go through the WEBHOOK — `telegram-order-flow.test.ts` › cancels an
order over the wire, and asks before it does, and › answers a cancel tap on an
order that is no longer awaiting payment. Reverting to `orders.get` fails the
first of them. The lesson is narrower than "test the surface": an assertion that a
control EXISTS is not an assertion that it works, and the two look alike in a diff.

## A note on how these were run

The first pass of F4H-08 to F4H-14 was run while a full `pnpm test:integration`
was still executing in the background against the SAME `nexa_test` database.
That produced 78 failures in the background run and three in the foreground —
none of them real, and all of them the failure mode `CLAUDE.md` records from the
Phase 2 branch, where two suites over one database manufactured 122 false
failures that looked exactly like true ones.

Every row above was re-run afterwards with nothing else touching the database,
and the earlier numbers are discarded rather than reported. The rule is the one
already written down: agents that share PostgreSQL are serialised or given
separate databases, and that applies to a background job of one's own.
