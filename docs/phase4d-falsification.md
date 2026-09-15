# Phase 4D falsification — provisioning

Every rule this phase introduces, mutated, with what the mutation actually did. Two of
the five SURVIVED their first attempt, and both survivals were findings rather than
noise: one about the harness, one about the test. They are recorded here with what was
done about them, because a falsification record that lists only kills is a record of
the mutations somebody chose to publish.

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
