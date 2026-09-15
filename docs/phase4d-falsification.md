# Phase 4D falsification — provisioning

The rules this phase introduces, mutated, with what the mutation actually did.

**Five SURVIVED their first attempt**, and every survival was a finding rather than
noise: two about a harness or a test that was weaker than the rule it named, and three
about rules the suite could not distinguish from their own absence. They are recorded
here with what was done about them, because a falsification record that lists only kills
is a record of the mutations somebody chose to publish.

It does NOT claim to cover every rule in the phase. A self-review found five load-bearing
rules with no test at all — `markCallStarted`, the `UNKNOWN` outcome reaching
`UNRECONCILED`, the delivery sweep's `ACTIVE` predicate, the provisioner's stopped-tenant
gate and the delivery attempt ceiling — each proven missing by a mutation that passed.
They are F4D-14 through F4D-18 below, and finding them is the reason this file's earlier
claim to completeness was removed rather than restated.

| #      | Rule                                                                 | Mutation                                                                                   | Named test                                                                                                 | Result |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------ |
| F4D-01 | The probe budget is not funded by service-half call sites            | `maxRequestsPerProbe: 4` → `5` (Sanaei)                                                    | `probe-cooldown-floor.test.ts` › never declares more requests than the PROBE PATH has call sites           | KILLED |
| F4D-02 | A declared capability has a method behind it                         | `async createUser(` → `async createUserDisabled(` (Marzban)                                | `registries.test.ts` › backs every declared service capability with a method that exists                   | KILLED |
| F4D-03 | One service per order, at the database                               | `DROP INDEX services_tenant_order_key` in `nexa_test`                                      | `provisioning.test.ts` › refuses a second service for the same order, at the database                      | KILLED |
| F4D-04 | A started provider call is never released by the lease sweep         | both `isNull(callStartedAt)` predicates removed from `releaseExpiredLeases`                | `provisioning.test.ts` › will not release a lease once a provider call has been recorded as started        | KILLED |
| F4D-05 | A blocked claim re-reads the row and refuses one another worker took | `eq(state, 'PLANNED')` removed from `claimDue`'s outer UPDATE                              | `provisioning.test.ts` › refuses a claim on a row another worker took while this one was blocked           | KILLED |
| F4D-06 | A provisioned service enters delivery in the same tick               | `await this.delivery.deliverDue(scope, DRAIN_LIMIT);` → `void DRAIN_LIMIT;`                | `provisioning-delivery.test.ts` › sends the subscription in the SAME tick that provisions it               | KILLED |
| F4D-07 | A delivery claim leases the row against a second sweep               | `.set({ deliveryNextAttemptAt: leaseUntil, updatedAt: now })` → `.set({ updatedAt: now })` | `provisioning.test.ts` › leaves a service ACTIVE when its announcement is refused, and schedules a retry   | KILLED |
| F4D-08 | The claim re-checks readiness AFTER the row lock is granted          | `ready,` removed from `claimDeliveryDue`'s outer UPDATE                                    | `provisioning.test.ts` › refuses a delivery claim on a row another sweep leased while this one was blocked | KILLED |
| F4D-09 | An UNKNOWN send is never retried automatically                       | `deliveryStateFor` UNKNOWN → `'PENDING'` instead of `'UNCONFIRMED'`                        | `provisioning-delivery.test.ts` › keeps the committed service when the reply dies on the wire              | KILLED |
| F4D-10 | An operator's panel activation reaches the row                       | `activation` dropped from `DrizzlePanelRepository.create`'s values                         | `provisioning-delivery.test.ts` › sends the subscription in the SAME tick that provisions it               | KILLED |
| F4D-11 | A blocked customer's service is not due, at the query                | `eq(customers.status, 'ACTIVE')` removed from `claimDeliveryDue`                           | `provisioning-delivery.test.ts` › does not announce to a customer an operator has blocked                  | KILLED |
| F4D-12 | A stopped tenant's rows are not even claimed                         | `return EMPTY_SWEEP;` → `void EMPTY_SWEEP;`                                                | `provisioning-delivery.test.ts` › announces nothing for a tenant that has stopped accepting work           | KILLED |
| F4D-13 | The send itself refuses a stopped tenant                             | `deliver`'s `scopeIsActive` guard → `if (false as boolean)`                                | `provisioning-delivery.test.ts` › announces nothing for a tenant that has stopped accepting work           | KILLED |
| F4D-14 | The executor stamps `call_started_at` before making the call         | `markCallStarted(...)` → `void operation.id;`                                              | `provisioning-delivery.test.ts` › stamps that a provider call started, before making it                    | KILLED |
| F4D-15 | An UNKNOWN provider outcome moves the service to `UNRECONCILED`      | `serviceEventFor` UNKNOWN → `null` instead of `PROVISION_LOST_TRACK`                       | `provisioning-delivery.test.ts` › creates one account when a create is cut off after the panel stored it   | KILLED |
| F4D-16 | The delivery sweep takes ACTIVE services only                        | `eq(services.state, 'ACTIVE')` removed from `claimDeliveryDue`                             | `provisioning-delivery.test.ts` › creates one account when a create is cut off after the panel stored it   | KILLED |
| F4D-17 | Delivery gives up after `DELIVERY_MAX_ATTEMPTS`                      | the ceiling branch → `return 'PENDING';` (never give up)                                   | `provisioning-delivery.test.ts` › gives up announcing after the attempts are spent, and says so            | KILLED |
| F4D-18 | The provisioner refuses a stopped tenant                             | `if (!active) {` → `if (false as boolean) {`                                               | `provisioning-delivery.test.ts` › holds off a stopped tenant without spending an attempt on it             | KILLED |
| F4D-19 | A hold-off refunds the attempt the claim counted                     | `attempts: GREATEST(attempts - 1, 0)` removed from `holdOff`                               | `provisioning-delivery.test.ts` › holds off a stopped tenant without spending an attempt on it             | KILLED |
| F4D-20 | The create → reconcile → absent cycle is bounded                     | `if (cycles >= SERVICE_PROVISION_CYCLE_LIMIT) {` → `if (false as boolean) {`               | `provisioning-delivery.test.ts` › bounds the create-reconcile-absent cycle instead of dialling for ever    | KILLED |
| F4D-21 | A reconcile is planned for an unresolved unknown outcome             | `await this.planReconciles(scope, now);` removed                                           | `provisioning-delivery.test.ts` › creates one account when a create is cut off after the panel stored it   | KILLED |
| F4D-22 | A non-retryable provider failure is not re-planned                   | `PROVIDER_FAILURE_RETRYABLE[failure] &&` removed from `persistFailure`                     | `provisioning-delivery.test.ts` › stops dialling a panel that answered with a wrong password               | KILLED |
| F4D-23 | The call stamp asserts the CLAIM, not just the row id                | `eq(provisioningOperations.claimedBy, worker),` removed from `markCallStarted`             | `provisioning.test.ts` › refuses the call stamp to a worker whose lease expired while it stalled           | KILLED |
| F4D-24 | A crash mid-call is recovered rather than left `IN_FLIGHT`           | `await this.reapStrandedCalls(scope, now);` → `void LEASE_SWEEP_LIMIT;`                    | `provisioning-delivery.test.ts` › recovers a provider call whose worker died, instead of waiting for ever  | KILLED |
| F4D-25 | A reconcile closes the unknown it answered                           | `resolveUnknownForService(` → `Promise.resolve(`                                           | `provisioning-delivery.test.ts` › keeps reconciling a service whose SECOND create also loses track         | KILLED |
| F4D-26 | A stamped, unresolved send is never CLAIMED by the automatic lane     | `isNull(services.deliverySendStartedAt)` removed from `claimDeliveryDue`'s sub-select      | `provisioning-delivery.test.ts` › does not announce twice when the sender dies between the send and the record | SURVIVED |
| F4D-27 | Readiness requires the process that fulfils the orders                | `provisioner` removed from `NEXA_READY_SERVICES`                                           | `botctl.test.sh` › the readiness parser answers correctly for every container shape                         | KILLED |
| F4D-28 | A create's activation is part of its idempotency hash                | `activation: command.activation,` removed from the create `requestHash`                    | `panels.test.ts` › refuses to replay a create whose activation differs                                     | KILLED |
| F4D-29 | A device limit the panel cannot apply is refused, not dropped        | the `bought.deviceLimit !== null` branch → `if (false as boolean && …)`                    | `provisioning-delivery.test.ts` › refuses to sell a device limit the panel cannot apply                    | KILLED |

## F4D-03 survived its first attempt, and the harness was why

Editing `uniqueIndex(...)` to `index(...)` in `schema.ts` changed nothing the test could
see: the index lives in migration 0042, which is already applied to `nexa_test`, and
`scripts/falsify.sh` mutates source rather than the database. The mutation that means
what the rule means is `DROP INDEX` against the test database, which is how the
`bot_instances_telegram_bot_id_key` index was proven load-bearing on the branch before
this one. Recorded because the first result read `SURVIVED` and could have been believed.

## F4D-04's guard is deliberately duplicated

`releaseExpiredLeases` carries `call_started_at IS NULL` in BOTH its sub-select and its
outer UPDATE, so removing either one alone survives — the other still holds. Only
removing both kills the test. That is defence in depth rather than redundancy to tidy
away, and a future reader deleting "the duplicate" should know the test will not object
until the second one goes too.

## F4D-05 survived until the test was made concurrent

The first claim test drove two claims SEQUENTIALLY, and the sub-select alone satisfies
that: the second caller's scan finds nothing, whatever the outer predicate says. So
removing `state = 'PLANNED'` from the UPDATE passed — a weaker test than the rule, which
is exactly the failure `docs/phase4b-falsification.md` records M05 surviving against.

The rule is about the CONCURRENT case. Two workers' sub-selects can both see a `PLANNED`
row before either UPDATE commits; under READ COMMITTED the loser blocks on the row lock
and re-evaluates its WHERE clause against the winner's committed row. Without the outer
predicate it matches an `IN_FLIGHT` row and overwrites somebody else's claim — two
workers holding one operation, and two provider calls for one paid order.

The replacement test MAKES that interleaving instead of hoping for it: it holds the row
lock in a transaction of its own, starts the claim so it blocks, commits the competing
claim, and then reads what the blocked caller decided. The same mutation then kills it.

## F4D-07 survived against the delivery test and was killed by the repository one

Two sweeps run back to back in `provisioning-delivery.test.ts` do not prove the lease:
the first sweep DELIVERED the service, so the second finds nothing because the delivery
state moved, not because the row was leased. Removing the lease write therefore survived
that file.

The proof that means what the rule means is the repository-level one, where the service
is still `PENDING` and no outcome has been recorded: there the second claim returns the
row unless the lease pushed `delivery_next_attempt_at` out. Recorded because the first
result read `SURVIVED` against a test that looked like the right one.

## F4D-12 and F4D-13 are two halves of one rule, and each needed its own caller

The sweep asks `scopeIsActive` before it claims, and `deliver` asks again before it
sends. The first is an optimisation — without it a stopped tenant's rows are claimed and
leased only to be refused one at a time — and the second is the rule.

With the early return in place, removing the inner guard changes nothing the sweep can
see, so it survives any test that only drives `deliverDue`. It is killed through
`redeliver`, the customer-initiated caller, which is why that assertion is in the
stopped-tenant case rather than in a case of its own.

## The rule with no mutation, stated rather than manufactured

**A failed Telegram send never changes `ServiceState`.** It is the rule this whole file
exists for, and it is held by an ABSENCE: `DeliveryService` never calls
`ServiceRepository.transition`, and `ProvisionerService` has no messenger to fail with.
There is no single predicate to revert, so no honest mutation of an existing rule
falsifies it — a mutation would have to ADD a transition call, which proves the test
catches a change nobody made rather than that the rule is load-bearing.

`provisioning-delivery.test.ts` › leaves the service ACTIVE when Telegram refuses the
message asserts it anyway, because the next refactor that gives the sweep a service
transition is the one this catches.

## The five that survived because the rule had no test at all

F4D-14 through F4D-18 were not written when this phase was first proposed as finished.
They exist because a self-review ran a mutation against each of five rules and watched
the whole suite stay green:

- **`markCallStarted`** — every crash mid-create becomes a second paid-for account. The
  lease-sweep guard HAD a test, but that test wrote `call_started_at` itself, so nothing
  distinguished "the executor stamps it" from "the executor does not".
- **`UNKNOWN` → `UNRECONCILED`** — a timeout leaves the service `PENDING_PROVISION`, so
  `retryProvisioning`, which refuses only `UNRECONCILED`, happily plans a second create.
- **the sweep's `ACTIVE` predicate** — a `PENDING_PROVISION` service is immediately due,
  is claimed, has no subscription URL and is recorded `FAILED`; `FAILED` is not swept, so
  the customer is never told even after provisioning succeeds.
- **the stopped-tenant gate** — a tenant an operator has stopped goes on having its
  panels dialled with its operator's credentials.
- **the delivery ceiling** — "always PENDING" passes: the ceiling, and the argument for
  why it is lower than `OPERATION_MAX_ATTEMPTS`, described behaviour nothing checked.

The common cause is one gap: **no test in the phase made the provider fail.** The fake
3X-UI was only ever driven down its success path, and every one of these rules is
reachable only through a failure. Two failure behaviours and a `setBehaviour` were added
to the fixture, and four of the five now die to a case that exercises a real one.

## What writing F4D-20's test found

The cycle it bounds did not exist until this branch wired the reconcile, so the defect
arrived with the fix. Each round of create → unknown → reconcile → absent derives a NEW
operation id from the round before, so nothing collides, the per-operation attempt
ceiling never applies, and a panel that failed every create while answering every lookup
"absent" would have been dialled for ever at the tenant's budget. The test was written to
assert a three-tick sequence and instead recorded one tick doing the whole loop — which
is what made the absence of a ceiling visible.

## F4D-26 survived, and it is defence in depth rather than a missing test

Removing `delivery_send_started_at IS NULL` from `claimDeliveryDue` changes nothing
the stranded-send test can see, because `deliverDue` runs `reapStrandedSends` FIRST:
by the time the claim executes there is no stamped row left to claim. That ordering is
deliberate and it is the primary guard.

The predicate is not therefore dead. The case it covers is a send stamped by
`redeliver` — the customer-initiated path, which takes no lease, so its row is
immediately `ready` — landing in the window between this tick's reap and this tick's
claim. There the sweep would otherwise claim a row whose message is still in flight and
send the customer a second one.

It is recorded SURVIVED rather than given a test, because the test that would kill it
has to interleave a customer's re-request with a sweep at one specific statement
boundary, and a test that merely stamps a row first does not reproduce it — the reap
takes that row before the claim is reached, which is the very thing that makes the
mutation survive. Writing one anyway would produce a case that passes for a reason it
does not state, which `docs/phase4b-falsification.md` records as the failure mode worth
more than the coverage.

So this is the F4D-04 shape: a guard the suite cannot distinguish from its own absence,
kept deliberately, written down so the next reader deleting "the redundant predicate"
knows the tests will not object.
