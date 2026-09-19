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

## The Codex review of this branch: eight more

Four findings of the single Codex review were confirmed against the code and
fixed; each fix is a rule, and each rule is mutated here.

| #      | Rule                                                   | Mutation                                | Named test                                                                    | Result |
| ------ | ------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| F6B-C1 | the cap is part of a CREATE's request hash             | the field dropped from the hash         | _refuses to replay a create whose cap differs_                                | KILLED |
| F6B-C2 | and of an UPDATE's                                     | the same, on the update path            | _refuses to replay an update whose cap differs_                               | KILLED |
| F6B-C3 | capacity is read in ONE statement, so in one snapshot  | a second statement added before it      | _reads a panel capacity in ONE statement, because two would be two snapshots_ | KILLED |
| F6B-C4 | the catalogue scans past the caller's bound            | the scan narrowed back to the bound     | _fills the catalogue bound past a screenful of ineligible products_           | KILLED |
| F6B-C5 | and still cuts the answer to it                        | the slice removed                       | _still bounds the catalogue, and says so when there are more_                 | KILLED |
| F6B-C6 | `hasMore` counts eligible rows past the bound too      | it reports only the database's own flag | _still bounds the catalogue, and says so when there are more_                 | KILLED |
| F6B-C7 | a concurrent CAP change is an overwrite like any other | the cap term dropped from the notice    | _promises an overwrite when the concurrent change is the CAP_                 | KILLED |
| F6B-C8 | and typing the stored value is not one                 | the "differs from stored" term dropped  | _does not call a cap an overwrite when this operator typed the stored one_    | KILLED |

C3 is the one rule whose FAILURE cannot be reproduced in a test, and the row
says what is asserted instead. The defect is a second snapshot: under READ
COMMITTED a settlement committing between a service count and a hold count is
seen by neither, and `used` comes back one too low. Constructing that
interleaving requires two statements to commit between — which is precisely
what having one statement makes impossible. So the test counts the statements,
which is the only form of the rule a test can hold.

## Codex C4: money that arrived, for a service that could not be created — RETIRED

The fifth confirmed finding of the same review. Its fix introduced
`PAID_UNFULFILLED`, an operator retry and a panel reassignment, and every rule
of it was mutated against the live database: eight rows, seven KILLED and one
HELD as the bound of another.

**All eight are retired, and the tests they named are deleted.** The owner
removed the state and everything built on it in favour of one automatic
outcome, so the rules those rows certified no longer exist to be falsified —
`settling` cannot be pinned to `SETTLE` when there is no second edge to pin it
away from, and `panel_id` has no exception to bound. Keeping them as rows
citing tests that are gone is exactly the failure this document's own checker
exists to catch, and keeping them as prose claiming a coverage nothing holds
would be worse.

What C4 established SURVIVES, in a different shape, and is re-falsified in
**The owner's decision** below: recording the receipt of money is still
independent of the ability to fulfil it, a wallet settlement is still refused
rather than recorded, and an order that creates no service still never consults
the create path. Three of the eight rules are those three, mutated again
against the code that replaced them.

Two things about the retired rows are worth keeping, because they are about how
the pass was run rather than about the feature:

**F6B-C4-4 earned its test by surviving first.** The comment above the check
said an unauthorized caller replaying somebody else's key would be handed their
order, and no test could see it, because the one permission case in the file
used a fresh key — which `runAuthorizedMutation` refuses whether or not the
early check exists. The test was written for the mutation. The same shape is
now held by _refuses the confirmation to an administrator a custom role could
not authorise_.

**F6B-C4-7 was the only mutation in this document applied to the DATABASE
rather than the tree.** The rule was a trigger body, so the function was
replaced with the pre-0083 form, the test run, and `0083` re-applied. Migration
0085 has since restored that function to what 0033 froze, permanently.

## The second Codex round: four more, two of them P1

The re-review of `86ce31a` found four. Two were defects in the C4 work itself,
one was the first half of a fix that had not finished the job, and one belonged
to the capacity work earlier on this branch.

| #       | Rule                                                | Mutation                                | Named test                                                   | Result |
| ------- | --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ------ |
| F6B-N3a | the catalogue scan widens until the bound is filled | back to one round of `PRODUCT_PAGE_MAX` | _reaches an eligible product past EVERY former scan ceiling_ | KILLED |
| F6B-N4a | a changed connection identity starts a new streak   | increment across the change, as before  | _starts a NEW streak when the connection identity changed_   | KILLED |

**N1 and N2 are retired with the feature, and nine rows went with them.** N1
was "a completed refund closes a `PAID_UNFULFILLED` order" and N2 was the Web
Admin control for retrying one; neither rule survives the owner's decision, and
their tests are deleted. Two notes from running them are worth keeping, because
they are about method rather than about the feature:

- F6B-N1a and F6B-N1b SURVIVED individually and F6B-N1c, which applied both
  mutations, killed. That is the honest record of a rule held in two places at
  once — removing either left the other holding — and it is why a mutation pass
  reports what survived instead of reporting only the kills.
- F6B-N2d took three attempts and the first two found a bad TEST, not a bad
  rule: the case asserted "no request" synchronously after a click, and no
  request could have been issued by then either way, so it passed with the
  guards removed. A negative assertion measured against a moment when nothing
  could have happened is not an assertion.

**F6B-N3a is the second round of F6B-C4.** The first fix scanned one page and
cut to the caller's bound, which moved the cliff from twenty products to a
hundred rather than removing it; the reviewer said so and was right. The row
above is the widened scan, and the test uses 101 products precisely so it fails
against the one-page version.

## The third Codex round: a permission, a lock order and the same ceiling again

Three findings, and the third of them was the catalogue ceiling for the third
time. Two of the three are fixed by a rule in a single place; the lock order was
reproduced with a real deadlock before anything was changed.

| #       | Rule                                                                 | Mutation                                              | Named test                                                                       | Result   |
| ------- | -------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| F6B-M2a | a permission whose prerequisite is missing is not held               | drop the `PERMISSION_REQUIRES` pass from resolution   | _drops receipts.review from an administrator who cannot view payments_           | KILLED   |
| F6B-M2b | the same, through a DENY override rather than a role                 | the same mutation                                     | _takes receipts.review with it when an override DENIES the read_                 | KILLED   |
| F6B-M2c | the same, for a GRANT override onto a role that cannot read          | the same mutation                                     | _drops a GRANTED receipts.review when the role cannot read payments_             | KILLED   |
| F6B-M2d | the write refuses a caller the rule narrowed                         | the same mutation                                     | _refuses the confirmation to an administrator a custom role could not authorise_ | KILLED   |
| F6B-M2e | the narrowing reaches the session's own list, not just the guard     | the same mutation                                     | _does not let a custom role hold receipts.review without payments.view_          | KILLED   |
| F6B-M3a | every path takes the ORDER lock before the panel and the reservation | remove both `OrderRepository.lock` calls              | _lets exactly one of a settlement and a cancellation win, three times over_      | KILLED   |
| F6B-M3b | the same, with no scripted holder                                    | the same mutation                                     | _survives a cancellation and a settlement started together, five times_          | SURVIVED |
| F6B-M3c | the expiry sweep passes over a locked order rather than waiting      | drop `skipLocked` from `expireDue`                    | _passes over an order another transaction holds rather than queueing behind it_  | KILLED   |
| F6B-M4a | eligibility is applied before the LIMIT, not after it                | filter the bounded page, as both earlier versions did | _reaches an eligible product past EVERY former scan ceiling_                     | KILLED   |
| F6B-M4b | the same, against four different reasons a panel is unsellable       | the same mutation                                     | _reaches eligible products behind every KIND of unsellable panel at once_        | KILLED   |
| F6B-M4c | eligibility costs a fixed number of queries                          | evaluate each returned product's panel individually   | _asks the database a fixed number of times, whatever the catalogue holds_        | KILLED   |
| F6B-N4  | the eligible fleet is bound ONCE, not one parameter per panel        | both `= ANY(...::uuid[])` forms restored to `inArray` | _sends the fleet as ONE bind parameter, however many panels it holds_            | KILLED   |

Two rows need saying plainly.

**F6B-M2a…e are one mutation, five kills, and that is the point of where it
lives.** `resolveEffectivePermissions` is the single rule the request guard, the
Web Admin's session and the notification lane all read, so removing it is
visible at all three — the resolver, the route and the recipient list. A fix in
a role editor would have bound only the first of the three shapes and there is
no role editor to put it in.

**F6B-M3b SURVIVED, and it is kept anyway.** Two real requests started together
with `Promise.all` do not reliably interleave into the cycle — the lesson
`financial-concurrency.test.ts` states at the top of the file and
`docs/phase4b-falsification.md` records as M05. It is the realistic shape (a
customer double-tapping two buttons) and it did fail against the unfixed code on
the first run of this file, but it cannot be relied on to, so F6B-M3a is the row
that establishes the rule: the same race with the interleaving MADE, three
rounds, killed.

**F6B-N4 is the bound F6B-M4c does not give.** Removing the ceiling on how
many products the catalogue scans left the FLEET filter as an `IN` expansion,
so the parameter count became the tenant's panel count across three reads — the
capacity read, the panel view read and the catalogue's own filter. Past
PostgreSQL's 65535-parameter ceiling that is a rejected bind rather than a slow
query: an empty shop, with nothing in the response saying the fleet outgrew it.
M4c counts STATEMENTS and reports three either way, which is exactly why it
could not see this; N4 measures the WIDEST statement of the whole request, at
the pool, with the fleet grown by an order of magnitude between the two
measurements. The unfixed form reports 12 then 102.

**On M3 the reproduction came before the fix, and corrected it twice.** The
static reading said settlement and the expiry sweep could deadlock; the
reproduction showed the sweep can never be the waiting party, because
`expireDue` uses `FOR UPDATE SKIP LOCKED` and passes over a held order. It also
showed settlement reaches the order earlier than the new lock anyway, through
the foreign key on `payments.order_id` taking `FOR KEY SHARE`. Both are in the
test's own comments, because both contradict what the fix's first draft claimed.

## The owner's decision: two terminal outcomes, and nothing between them

`PAID_UNFULFILLED` is gone, and with it the operator retry, the reassignment
and `orders.fulfil`. An order the installation cannot deliver is REFUNDED — the
exact amount, to the customer's wallet, in the transaction that discovers it.
What C4 established survives in that shape, and these are the rules that hold
it, each reverted and watched to fail.

| #   | Rule                                                             | Mutation applied                                                   | Result | Named test                                                                                  |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| 1   | a wallet purchase is REFUSED, never refunded                     | `onIneligible` made `'REFUND'` unconditionally                     | KILLED | _refuses a WALLET settlement instead, and debits nothing_                                   |
| 2   | the automatic credit is what is LEFT, not the price              | `outstanding` set to `payment.amount.amountMinor`                  | KILLED | _credits only what is LEFT when an operator already returned part of it_                    |
| 3   | a create whose outcome is UNKNOWN is never refunded              | the refund branch widened from `FAILED` to `FAILED \|\| UNKNOWN`   | KILLED | _refunds nothing while the outcome is UNKNOWN, and waits for the read_                      |
| 4   | only an operation matching what the order BOUGHT may refund it   | the `PURCHASED_AS` guard deleted                                   | KILLED | _never reports a suspend that suspended nothing_                                            |
| 5   | the customer is told, in the transaction that made it true       | the `notifier.notify` call deleted                                 | KILLED | _refunds when the panel was ARCHIVED after the transfer_                                    |
| 6   | `receipts.review` cannot be held without `payments.view`         | the `PERMISSION_REQUIRES` entry deleted                            | KILLED | _does not let a custom role hold receipts.review without payments.view_                     |
| 7   | 0085 retires `orders.fulfil` from every role that was granted it | the `DELETE FROM "role_permissions"` statement commented out       | KILLED | _never backfills a pair the frozen contract does not assign_                                |
| 8   | an automatic refund names nobody, and an operator's names both   | `refunds_operator_completion_check` DROPped from the live database | KILLED | _refuses an automatic refund that names an administrator who did not decide it_             |
| 9   | the second settlement ask carries the CALLER's disposition       | `onIneligible` replaced with a hard-coded `'REFUSE'`               | KILLED | _answers a second ask with a verdict when the caller can refund, and throws when it cannot_ |

Row 8 is the second mutation in this document applied to the DATABASE rather
than to the tree, for the same reason as F6B-C4-7: the rule is a CHECK
constraint, so reverting it in the schema file would prove nothing about the
database the tests run against. The constraint was dropped, the four cases run,
and migration 0086's exact definition re-applied; the file is byte-identical
and all 28 invariants are green again.

Row 9 is Codex's `STRAND` finding, which outlived the design it was raised
against. `confirmAndSettle` asks whether a commercial order can be delivered,
moves the order, and then `planCommercialAction` asks the same three refusals
again — and under READ COMMITTED that second read takes a fresh snapshot, so a
settlement for another order on the same service committed in between is
invisible to the first and visible to this one. Hard-coded `REFUSE` turned that
disagreement into a throw, unwinding a transaction that had already confirmed
money which arrived days ago. Removing `PAID_UNFULFILLED` did not touch it: that
work changed what happens when a settlement DECIDES it cannot deliver, not what
happens when the second check contradicts the first.

The row asserts both halves of the disposition, and it asserts them directly
rather than through the race. The window is only reachable by a real
interleaving, which `docs/phase4b-falsification.md` M05 records as something
`Promise.all` does not reliably produce; the refusal in the test is genuine — an
operation for that service really is outstanding — and what is under test is
what the method DOES with it. **What has no test is the suppression that went
with it**: planning moved ahead of the audit record and both outbox writes so a
late refund cannot follow an `OrderSettled`, and only the race can reach that
ordering. It is stated here rather than claimed as covered.

**Two mutations SURVIVED, and both are recorded rather than papered over.**

**AR-S1: removing `panelSales.release` from the refunder changes nothing this
suite can see.** Every path the tests can build reaches the refunder through
`PanelSalesGate.consume`, which releases the hold BEFORE it decides
eligibility — so by the time an UNFULFILLABLE verdict is returned, the slot is
already back, and `holdsFor(orderId)` reads zero with the release deleted. The
one path where `consume` returns without releasing is a panel whose ROW has
gone, and archival does not delete a row, so the suite cannot construct it.
The call stays: it is idempotent by construction (`release` deletes by order id
and reports whether anything was there), and a hold nobody released occupies a
slot until it expires — a panel that filled up would refuse the next customer
because of the order it had just refunded. It is defence for a case this
document cannot demonstrate, and saying so is the point of the row.

**AR-S2: removing `if (!moved) return false` also survives.** The boolean is
the race guard: the order transition is conditional on the caller's `from`, and
a caller that loses must write nothing. Every replay the suite can produce is
stopped EARLIER — by the idempotency key at the surface, which is what _refunds
ONCE when the same confirmation is delivered twice_ actually proves — so the
refunder is never re-entered with a transition that fails. Demonstrating the
guard needs two settlements interleaved inside one transaction's lifetime, and
`docs/phase4b-falsification.md` M05 records that two real requests started with
`Promise.all` do not reliably interleave. What IS held: the caller's own
`if (!changed) throw` is exercised by that test, and row 2 above now covers the
second line of defence — a replay past the transition credits the remainder,
which is nothing.

## The fifth Codex round: five ways the refund gave back less than it promised

All five were validated as CONFIRMED against the code before anything was
written. Three are money the customer did not get, one is the request that would
have returned it dying with a serialization error, and one is an operator queue
that only grew.

| #   | Rule                                                                       | Mutation applied                                                  | Result | Named test                                                                          |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| F2  | an operator's UNFINISHED refund is superseded, never subtracted            | the supersede loop short-circuited with `if (true) continue`      | KILLED | _abandons an operator s unsent refund and returns the whole amount_                 |
| F3a | `sales.currency` cannot retire while refundable money is denominated in it | the guard loop in `SettingsService.set` short-circuited           | KILLED | _refuses to retire a currency that still has money owed in it_                      |
| F3b | and it is a guard, not a ban: zero exposure allows the change              | `exposed === 0` changed to `exposed === -1`, so it always refuses | KILLED | _allows the change once nothing is left to refund_                                  |
| F4  | the CUSTOMER is locked before the PANEL on every settlement path           | the `lockCustomer` call deleted from `confirmAndSettle`           | KILLED | _does not deadlock when a wallet settlement holds the customer and wants the panel_ |
| F5  | the refund CLOSES the stalled condition it can never otherwise close       | the `recovers` pointer removed from the refunder call             | KILLED | _bounds the create-reconcile-absent cycle instead of dialling for ever_             |

F4's mutation does not merely fail an expectation: it fails with the literal
`40P01` the finding names, on round 0 of 3, which is the difference between a
test that describes a deadlock and a test that produces one.

F5 was rewritten mid-pass because of what the first version's mutation showed.
The recovery was originally a SECOND `order.refunded_undeliverable` row written
by the provisioner, and the test that caught the missing recovery caught the
duplicate too: two rows under one code, stating the same fact twice, in a log
whose whole purpose is that it does not do that. The recovery now rides on the
one row the refunder already writes, passed in as `recovers`. That also fixed a
correctness problem the duplicate had: the refunder writes nothing at all when
another transaction moved the order first, which is exactly when the condition
must stay open — the old version recorded the recovery on a `refunded` boolean
the provisioner had to re-derive.

**F1's fix has NO test, and the reason is the other fix in this same round.**

`planCommercialAction` now converts a lost INSERT on
`provisioning_operations_open_commercial_key` into the same `UNFULFILLABLE`
verdict its READ already returns. The fix is right — a read and an index that
enforce one rule must produce one answer, and the read-then-insert window is real
under READ COMMITTED. But the mutation (`if (false && …)`) SURVIVED five suites,
173 tests, and it survives because the window is no longer reachable through any
wired caller: `planCommercialAction` has exactly one, `prepareCommercialSettlement`,
reached only from `confirmAndSettle` — which F4 just made take the CUSTOMER's row
lock before it plans anything. Two commercial settlements of one service are two
settlements for one customer, so they now serialise on that row, and the loser's
`findOpenCommercial` sees the winner's committed row and refuses through the read.

So the catch is defence for a caller that does not exist yet: anything that plans
a targeted operation without holding the customer's lock. It is kept because the
invariant is worth stating in code, and it is recorded here as untested rather
than described as covered — a commit message on the deployment branch once cited
coverage that had been run and thrown away, and the next reader believed it.

## Rules held by a mechanism rather than by a mutation

| Rule                                                    | What holds it                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| two holds for one order cannot both exist               | the partial unique index on `(tenant_id, order_id)`; the pre-check is an optimisation and the index is the rule                |
| the occupying states cannot drift from the contract     | `SERVICE_CAPACITY_STATES` is derived from `SERVICE_STATES` minus `SERVICE_TERMINAL_STATES`, so a new state occupies by default |
| a reservation cannot outlive its order's payment window | `expires_at` is the order's own `expires_at`, passed in by the caller rather than computed in the repository                   |
| no surface can read a capacity it was not scoped to     | every query in the repository carries `tenant_id`, and `counts nothing across the tenant boundary` asserts it end to end       |

## How the mutations were run

Each mutation is applied to the working tree, the named test is run alone
against the live database, the file is restored byte-for-byte from a copy taken
before the edit, and the suite is green again afterwards. The script that did it
is not committed — it is fifteen string replacements and a `vitest run -t`, and
committing it would invite the next phase to trust its output rather than re-run
it. What IS committed is every test named above.
