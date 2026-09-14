# Phase 4D falsification — provisioning

Every rule this phase introduces, mutated, with what the mutation actually did. Two of
the five SURVIVED their first attempt, and both survivals were findings rather than
noise: one about the harness, one about the test. They are recorded here with what was
done about them, because a falsification record that lists only kills is a record of
the mutations somebody chose to publish.

| #      | Rule                                                                 | Mutation                                                                    | Named test                                                                                          | Result |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| F4D-01 | The probe budget is not funded by service-half call sites            | `maxRequestsPerProbe: 4` → `5` (Sanaei)                                     | `probe-cooldown-floor.test.ts` › never declares more requests than the PROBE PATH has call sites    | KILLED |
| F4D-02 | A declared capability has a method behind it                         | `async createUser(` → `async createUserDisabled(` (Marzban)                 | `registries.test.ts` › backs every declared service capability with a method that exists            | KILLED |
| F4D-03 | One service per order, at the database                               | `DROP INDEX services_tenant_order_key` in `nexa_test`                       | `provisioning.test.ts` › refuses a second service for the same order, at the database               | KILLED |
| F4D-04 | A started provider call is never released by the lease sweep         | both `isNull(callStartedAt)` predicates removed from `releaseExpiredLeases` | `provisioning.test.ts` › will not release a lease once a provider call has been recorded as started | KILLED |
| F4D-05 | A blocked claim re-reads the row and refuses one another worker took | `eq(state, 'PLANNED')` removed from `claimDue`'s outer UPDATE               | `provisioning.test.ts` › refuses a claim on a row another worker took while this one was blocked    | KILLED |

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
