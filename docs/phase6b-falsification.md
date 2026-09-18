# Phase 6B falsification — capacity, eligibility and the enable gate

Every production rule the Phase 6B core introduces, reverted one at a time,
with the committed test that fails as a result. A rule with no test is a rule
the next commit reverts silently; a test that stays green under mutation is not
a test.

The core is three mechanisms that can each be wrong in a way nobody notices
until a customer has paid: a capacity slot that is a reservation row rather than
a count, one eligibility evaluator with four callers, and a connection test that
authorises an enable. Fifteen mutations, run against
`tests/integration/panel-capacity.test.ts` and
`tests/integration/panels.test.ts`.

## The fifteen

| #      | Rule                                                                  | Mutation                                                      | Named test                                                                   | Result |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| F6B-01 | `reserve` takes the panel's row lock BEFORE it counts                 | `.for('update')` dropped from the panel select                | _holds the panel row for update before it counts_                            | KILLED |
| F6B-02 | an order that already holds a slot is answered with the slot it holds | `held.length > 0` weakened to `> 1`                           | _answers a second acquire for the same order with the slot it already holds_ | KILLED |
| F6B-03 | every non-terminal service state occupies a slot                      | the state filter dropped from the service count               | _counts every service state that occupies a slot, and not TERMINATED_        | KILLED |
| F6B-04 | an expired reservation stops occupying one                            | the `expires_at > now` predicate dropped from the hold count  | _an expired reservation stops counting immediately, with nothing having run_ | KILLED |
| F6B-05 | a panel is unusable only after the streak reaches the threshold       | the `unusableStreak` comparison deleted                       | _keeps selling through one bad probe, and stops at the threshold_            | KILLED |
| F6B-06 | a stale or unchecked probe condemns nothing                           | the freshness bound replaced with `true`                      | _never empties the catalogue because health is unchecked or stale_           | KILLED |
| F6B-07 | status is decided before capacity, and archived is its own reason     | both status arms deleted from `decideEligibility`             | _refuses an archived panel as ARCHIVED, never as at capacity_                | KILLED |
| F6B-08 | the catalogue filters its page by the same evaluator                  | the filter replaced with the unfiltered page                  | _hides a product whose panel is disabled, and refuses it if asked anyway_    | KILLED |
| F6B-09 | confirming an order acquires a slot inside its transaction            | `acquire` replaced with an unconditional `{ eligible: true }` | _takes exactly one slot when an order is confirmed_                          | KILLED |
| F6B-10 | a customer's own cancellation releases the slot                       | the `release` call deleted                                    | _gives the slot back when the customer cancels their own order_              | KILLED |
| F6B-11 | the payment expiry sweep releases it too                              | the `release` call deleted                                    | _gives the slot back when the order expiry sweep closes the order_           | KILLED |
| F6B-12 | `available` is floored at zero                                        | `Math.max(0, …)` removed                                      | _floors available at zero when the cap is below current usage_               | KILLED |
| F6B-13 | enabling a panel requires a connection test that passed               | the gate's condition made unreachable                         | _refuses to enable a panel nobody has successfully tested_                   | KILLED |
| F6B-14 | that test is bound to the panel's identity NOW                        | the identity comparison deleted                               | _stops counting a green test once the credential it used is replaced_        | KILLED |
| F6B-15 | the gate is scoped to `DISABLED -> ACTIVE`                            | widened to every transition into `ACTIVE`                     | _does not make an archived panel unrestorable_                               | KILLED |

F6B-01 is the row this file exists for, and it took four test designs to write.
The first used `Promise.allSettled` over two concurrent confirmations and was
timing-dependent — which is the one thing the instruction for this work
explicitly forbade, and it passed with the lock removed about as often as it
failed. The second tried a rendezvous barrier and could not work at all: with
the lock in place the loser makes NO progress, so any barrier waiting for it to
reach a point deadlocks the test rather than proving the lock. The third
asserted that `reserve` blocks while another transaction holds the panel row —
and that is true with `.for('update')` deleted, because inserting a reservation
takes a key-share lock on the FK parent row by itself. Three tests, three green
runs against a mutant.

What is actually observable, given the FK, is the lock MODE. So the fourth pauses
inside `reserve` before its count, reads `pg_backend_pid()` from the paused
transaction, and asks `pg_locks` from a second connection which relation locks
that backend holds on `panels`. `RowShareLock` is `SELECT ... FOR UPDATE` and
nothing else takes it; the mutant holds `AccessShareLock` and `RowExclusiveLock`
and the assertion fails. The distance between "a test about concurrency" and a
test that can fail is this whole paragraph.

F6B-02 survived its first test for a reason worth writing down. The obvious
falsifier is _a replayed confirmation holds ONE slot, not two_ — and it never
reaches the reservation's replay path, because `confirm`'s idempotency store
answers the second call before `acquire` is called at all. The test is a real
test of ORDER idempotency and proves nothing about the hold. A direct
double-`acquire` inside one unit of work was added, and it kills the mutant.
Both tests are kept: they hold different rules.

F6B-05 and F6B-06 are the owner's hysteresis sentence, in two directions. Without
the streak, a single failed probe empties a tenant's catalogue; without the
freshness bound, a panel nobody has probed recently is treated as condemned by
whatever its last probe said, which is how "UNCHECKED must not empty the
catalogue" becomes exactly that.

F6B-07 is an ordering, not a predicate. Both orders refuse an archived panel, so
"is it refused" cannot tell them apart — the assertion is on the REASON, which
is what the surfaces render and what an operator acts on. A full archived panel
reported as `AT_CAPACITY` sends somebody to raise a cap that changes nothing.

F6B-13 through F6B-15 are the enable gate, and F6B-15 is a defect this pass
found rather than a rule it confirmed. Gating every transition into `ACTIVE`
made `ARCHIVED -> ACTIVE` unreachable, because `testConnection` refuses an
archived panel: there was no sequence of operator actions that restored an
archived panel. The gate is scoped to `DISABLED -> ACTIVE` and the mutation
re-creates the dead end.

## Rules held by a mechanism rather than by a mutation

| Rule                                                    | What holds it                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| two holds for one order cannot both exist               | the partial unique index on `(tenant_id, order_id)`; the pre-check is an optimisation and the index is the rule                |
| the occupying states cannot drift from the contract     | `SERVICE_CAPACITY_STATES` is derived from `SERVICE_STATES` minus `SERVICE_TERMINAL_STATES`, so a new state occupies by default |
| a reservation cannot outlive its order's payment window | `expires_at` is the order's own `expires_at`, passed in by the caller rather than computed in the repository                   |
| no surface can read a capacity it was not scoped to     | every query in the repository carries `tenant_id`, and `counts nothing across the tenant boundary` asserts it end to end       |

## The Web Admin: nine more

The panel detail's workload tab and the second press on archive. Mutations
against `apps/web/src/pages/panels.tsx`,
`apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository.ts`
and `apps/api/src/surfaces/web/products.controller.ts`, run against
`tests/web/panels.test.tsx` and `tests/integration/products-http.test.ts`.

| #      | Rule                                                             | Mutation                                        | Named test                                                                          | Result |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| F6B-W1 | the product list honours a panel filter in SQL                   | the condition dropped from the repository       | _narrows the list to one panel, and excludes a product that names no panel_         | KILLED |
| F6B-W2 | the controller forwards the filter it parsed                     | the field dropped from the parsed query         | _narrows the list to one panel, and excludes a product that names no panel_         | KILLED |
| F6B-W3 | archiving asks before it writes                                  | the first press wired straight to the mutation  | _does not archive on the first press_                                               | KILLED |
| F6B-W4 | a refused archive takes its own question down                    | `setArchiveAsked(false)` deleted from `onError` | _leaves no confirmed-looking screen behind when the archive is refused_             | KILLED |
| F6B-W5 | the products list says "there is more" only on a cursor          | the guard inverted                              | _says there is more on each list the server truncated, and only those_              | KILLED |
| F6B-W6 | and so does the services list                                    | the guard inverted                              | _says there is more on each list the server truncated, and only those_              | KILLED |
| F6B-W7 | neither says it without one                                      | the guard replaced with `true`                  | _claims no completeness it was not given: neither list says there is more_          | KILLED |
| F6B-W8 | the workload asks for THIS panel                                 | `panelId` dropped from the services query       | _asks the server for this panel only, and never for the whole catalogue_            | KILLED |
| F6B-W9 | a listed service shows its username, never the panel's id for it | the cell fed `providerUserId`                   | _carries no subscription URL, subscription ref or client id for a service it lists_ | KILLED |

F6B-W5 through F6B-W7 are one rule in three rows because the first version of
the test could not tell them apart. Two cards each carry their own truncation
notice from their own response, and `findByText` is satisfied by either — so
inverting the PRODUCTS guard left the case green on the strength of the
SERVICES notice. The test asserts the COUNT now, and a third case asserts that
an untruncated pair shows none.

F6B-W2 is worth its own row even though it dies to the same test as F6B-W1.
The controller parses the query and then builds the search separately, so the
filter can be validated, accepted and silently not passed on — which is a
surface that appears to filter and returns everything.

## How the mutations were run

Each mutation is applied to the working tree, the named test is run alone
against the live database, the file is restored byte-for-byte from a copy taken
before the edit, and the suite is green again afterwards. The script that did it
is not committed — it is fifteen string replacements and a `vitest run -t`, and
committing it would invite the next phase to trust its output rather than re-run
it. What IS committed is every test named above.
