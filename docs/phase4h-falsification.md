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

## What is said while a customer waits

| #      | Rule                                                  | Mutation                                                    | Named test                                                                                                            | Result |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| F4H-15 | a settlement is followed by a second message          | the follow-up send short-circuited to false                 | `telegram-payment-flow.test.ts` › settles from the wallet, debits exactly the order total, and then says what follows | KILLED |
| F4H-16 | only `NEW_SERVICE` is told a service is being made    | the purpose check removed, so every settlement promises one | `bot-runtime.test.ts` › says nothing further about a purpose that changes a service that exists                       | KILLED |
| F4H-17 | `NEW_SERVICE` IS told                                 | the follow-up never chosen                                  | `bot-runtime.test.ts` › promises a service only for the purpose that creates one                                      | KILLED |
| F4H-18 | an abandoned PROVISION or RECONCILE announces a delay | the `ABANDONED` guard dropped                               | `operation-outcome-announcer.test.ts` › says nothing when a PROVISION succeeds                                        | KILLED |
| F4H-19 | the delay notification is keyed on the SERVICE        | `operationId` passed as the subject                         | `operation-outcome-announcer.test.ts` › announces a delay when a PROVISION is abandoned                               | KILLED |
| F4H-20 | a background read being abandoned is not a delay      | `SYNC_USAGE` added to `DELAY_ANNOUNCED_OPERATIONS`          | `operation-outcome-announcer.test.ts` › says nothing when a background read is abandoned                              | KILLED |

F4H-16 is the third rule this phase that survived its first mutation, and the
reason is the same shape as the other two: **no test in this repository settles a
RENEW over Telegram**, so an unconditional follow-up — every paying customer told
their service was being created, including the ones renewing a service they
already have — left the whole suite green.

Building a renewal through the webhook needs an ACTIVE service and an add-on
catalogue, which is a fixture rather than a case. So the DECISION was extracted
instead: `followUpForSettlement(purpose)` is a pure function, exported and unit
tested the way `replyFor` already is, and a third case asserts the two cases
between them exhaust `ORDER_PURPOSES` — so a fourth purpose added to the contract
cannot be silently untested by both.

F4H-19 is the counterpart of F4H-07 and points the opposite way, which is worth
stating because the two look inconsistent. Every other announcement is keyed on
the OPERATION, so that a second renewal is not swallowed by the first's unique
index. This one is keyed on the SERVICE, because
`CUSTOMER_NOTIFICATION_PRECONDITIONS` marks `SERVICE_PROVISION_DELAYED` as needing
a re-check before sending and `DrizzleNotificationSubjectReader` performs it by
reading `services.state`. Keyed on the operation, that lookup finds nothing,
answers `false`, and every delay notification is SUPERSEDED instead of sent — a
lane that works perfectly and delivers none of them.

## The Services surface

| #      | Rule                                                       | Mutation                                  | Named test                                                                                    | Result |
| ------ | ---------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| F4H-21 | no credential appears in a service response                | `subscriptionUrl` added to the projection | `services-http.test.ts` › lists a service without any of the three credentials                | KILLED |
| F4H-22 | the page cursor carries PostgreSQL's own microsecond text  | the cursor rebuilt from the row's `Date`  | `services-http.test.ts` › pages without repeating a row whose created_at carries microseconds | KILLED |
| F4H-23 | `services.view` is checked in the SERVICE, not the surface | both `guard.check` calls removed          | `services-http.test.ts` › refuses an authenticated operator who does not hold services.view   | KILLED |

F4H-22 is a latent defect this surface would have shipped rather than a rule this
phase invented. `ServiceCursor.createdAt` was a `Date`, and `timestamptz` keeps
microseconds while a JavaScript `Date` keeps milliseconds — the driver truncates
rather than rounds, so the cursor lands strictly BELOW the row it was built from
and the tuple comparison lets that row back in. One duplicate at every page
boundary, and at `limit=1` a traversal that never ends.

`CustomerCursor` and `PanelCursor` already carry the measurement and the fix; the
service list had simply never been paged from outside the process, so nothing
could see it. The test writes the microseconds by hand, because a settled order
stamps a millisecond `Clock.now()` — the rows that trigger it are the ones a
restore, an import or an ops script created, which is exactly the set nobody
thinks to test.

Two more things the tests had to be corrected for, both recorded because a case
that asserts nothing reads as coverage:

- the negative authorization case first used the `technical` role, which is one
  of the THREE seeded roles that DO hold `services.view`. It passed with a 200
  and proved nothing. `receipt_reviewer` is the role that genuinely lacks it.
- the tenancy cases first re-homed a tenant A service with an `UPDATE`, which the
  database refused in both orderings —
  `provisioning_operations_service_fk` is composite on `(tenant_id, service_id)`.
  They now build a service tenant B genuinely owns, through a settled order, for
  the reason `docs/real-panel-acceptance.md` gives one layer down: a row in a
  state the product cannot produce proves less than it appears to.

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

## The Web Admin Services page, and the payment signal it exposed

| #      | Rule                                                         | Mutation                                            | Named test                                                                                      | Result |
| ------ | ------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| F4H-24 | the service list pages newest first (owner revision 13)      | `desc` -> `asc` and `<` -> `>` in the keyset        | `services-http.test.ts` › serves the newest service first                                       | KILLED |
| F4H-25 | the Web Admin shows a customer's transfer claim on the list  | the column's renderer replaced with a constant dash | `payments.test.tsx` › shows that a customer said they paid, and still calls the payment pending | KILLED |
| F4H-26 | the service LIST issues no write                             | a `POST .../terminate` added to the page            | `services.test.tsx` › offers no write from the list: every request it makes is a GET            | KILLED |
| F4H-27 | a descending list does not flip the pager labels             | `nextLabel="web.newer"` copied from `/orders`       | `services.test.tsx` › labels the next page older, the way a descending list must                | KILLED |
| F4H-28 | a promoted page leaves `PLANNED_SURFACES` in the same commit | a `services` entry re-added to the list             | `services.test.tsx` › is gone from PLANNED_SURFACES, so the placeholder cannot shadow it        | KILLED |

F4H-26 was narrowed in Phase 6A, which built the operator actions this row's rule
originally covered. What the row still asserts is true and still worth asserting: the
actions are on the DETAIL and the LIST issues no write, because a column of action
buttons over a page of services is how a mis-click ends the wrong customer's account.
The renamed test carries the same mutation.

F4H-24 is a correction rather than a rule this slice invented. `/users`, `/orders`
and `/products` all page an ASCENDING keyset, the service list was written the same
way, and owner revision 13 says services are ordered `created_at` descending — a
rule the placeholder had recorded in words since Phase 3D and that nothing in code
obeyed. Promoting the page would have printed that sentence above a list whose first
page was the oldest service the installation ever sold. Both halves moved: the
repository pages descending, and the pager keeps `CursorPager`'s default labels
instead of the flipped pair the three ascending lists pass. The mutation fails the
microsecond-paging case too, which is the same keyset seen from the other end.

F4H-25 is the one that SURVIVED first, and the record matters more than the fix.
The original case asserted that the column HEADER was present and that not every
cell in the table was a dash; a mutation replacing the column's renderer with a
constant dash left both true, because the header comes from the column definition
rather than from the data. The rewritten case reads the body cell under that header
by index and compares it against `formatTimestamp` of the fixture's own instant,
with a companion case pinning the dash for an unsignalled payment — so neither can
pass by rendering a constant. Only then did the mutation fail.

The defect underneath it was worse than the weak test. `customerSignalledAt` has
been REQUIRED by `paymentSummarySchema` since `7b934a5`, the controller has
returned it since `eef356f`, and the Web Admin rendered it nowhere — while
`tests/web/payments.test.tsx` carried a fixture without the field, so all nineteen
cases in that file failed the zod parse and the branch head had a red web suite
that no gate run in this session had reported. The contract's own docblock says the
field sits on the SUMMARY "because it is the field that makes the pending list
triageable"; until this slice, the list it was for did not have it.

## The Codex review of PR #30

Nine findings on head `a472a8b`, all validated against the code before anything was
changed. Seven were fixed; two are recorded as `OQ-4H-01` and `OQ-4H-02` with the
reason, because each needs a contract or a schema decision rather than a fix.

| #      | Rule                                                       | Mutation                                                        | Named test                                                                                                     | Result |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| F4H-29 | every operation the loop terminalises is announced         | `announce` moved back below the `REFUSED` break                 | `provisioner-loop-announcement.test.ts` › announces an operation a refusal abandoned, before it stops draining | KILLED |
| F4H-30 | a cancellation never withdraws a signalled transfer        | `isNull(customerSignalledAt)` and the post-write re-ask removed | `customer-order-actions.test.ts` › refuses to cancel an order whose transfer was signalled during the attempt  | KILLED |
| F4H-31 | a cancel that lost its transition is refused, not reported | the `!changed` guard removed                                    | `customer-order-actions.test.ts` › refuses a cancellation when the order settles first                         | KILLED |
| F4H-32 | a transfer signal that was not recorded is refused         | the `!stamped` re-read removed                                  | `customer-order-actions.test.ts` › refuses a transfer signal when the payment is rejected first                | KILLED |

F4H-29 is the one worth reading. Codex reported C2 as a crash window — the terminal
transition commits, the announcement is a second transaction, and a process that dies
between them leaves a terminal operation nobody will claim again. That half is real and
is NOT fixed here; it is `OQ-4H-01`'s neighbour in kind and 4J's subject.

The half that WAS fixed is the one the report mentions second and which turned out to be
much worse: three refusal paths in `runOnce` transition the operation to `ABANDONED` and
return `{ kind: 'REFUSED' }`, and `ProvisionerLoop` broke on `REFUSED` before announcing.
So a customer whose RENEW was refused because this release cannot renew on their panel
type was told nothing — not as a race, but every time, deterministically. The fix moves
the call above the break and removes the `outcome` PARAMETER entirely: `announce` now
reads the operation's own state, so no caller can hand it an outcome that does not match
the row, and the call is idempotent and safe from anywhere.

The remaining six fixes are conditional-write results that were computed and ignored,
which is one shape wearing six hats:

- **C1** `cancelPendingForOrder` matched `state = 'PENDING'` only, so a transfer the
  customer had just claimed was withdrawn by a cancellation whose guard read had run
  before the claim committed. The UPDATE now refuses a signalled row AND the guard is
  re-asked after it, so a row left behind is a refusal rather than a partial cancel.
- **C4** `cancelByCustomer` computed `changed` and used it only as an audit field, so a
  cancel that lost to a settlement audited SUCCESS and returned the `PAID` row — which
  the bot renders as "your order was cancelled".
- **C3** `signalTransferSent` read a `false` from `signalSent` as "already on record".
  One of its three causes leaves `customer_signalled_at` null, so the claim reached
  nobody and the customer was told it was filed.
- **C5** a customer blocked between the claim and the contact lookup was recorded
  terminally `FAILED`, while the same customer blocked a moment earlier was simply not
  claimed — `claimDue` excludes them at the query and argues at length that burning an
  attempt would punish a reversible moderation decision. One rule, two answers, decided
  by a race.
- **C7** the operator's operation history promised "newest first" in its docblock and in
  its Persian copy, and called a repository method that orders ASCENDING — so a service
  with more than fifty operations showed the oldest fifty, losing exactly the recent
  failures an operator opened the page to read.
- **C9** the delay precondition tested `state !== 'ACTIVE'`, and `TERMINATE` is legal
  from both `PENDING_PROVISION` and `UNRECONCILED` — so a customer who ended their
  service could still be told its provisioning was taking longer than expected.

### Two of the three race tests SURVIVED their first mutation

Worth more than the fixes. F4H-31 and F4H-32 were first written as two calls started
together with `Promise.allSettled`, asserting an invariant — and both passed with the
production fix REVERTED. The reason is the same in each: the competing transaction
committed entirely before the method under test took its opening read, so the PRE-READ
guard refused and the branch the fix added was never reached. The tests were measuring
a path that was already correct, which is the shape `CLAUDE.md` calls a test that
cannot fail.

The rewrite drives the window with a real row lock instead of hoping for it. The test
holds the payment row on its own connection; the method under test reads the row as
`PENDING`, blocks on its conditional UPDATE, and the competing change commits while it
waits. It then resumes into exactly the state the branch exists for — an opening read
that said one thing and a conditional write that matches nothing. Both mutations fail
against the rewritten cases.

F4H-30 killed its mutation on the first attempt, because `withdrawPendingFor` takes the
payment row lock itself and the interleaving happens without help.

One incident along the way, recorded because it cost a run: the first lock-driven
version wrote `state = 'PAID'` without `settled_at`, which `orders_settled_at_check`
refuses — `(state = 'PAID' OR state = 'REFUNDED') = (settled_at IS NOT NULL)`. That
aborted the holder's transaction and returned a poisoned connection to the pool, and
the failure surfaced several statements later as "current transaction is aborted"
inside an unrelated helper. Both lock-driven cases now roll back in a `catch` rather
than trusting the commit.

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
