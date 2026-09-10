# Architecture Hardening — falsification record

Every production rule this branch added, reverted one at a time against the
working tree, with the test that dies named. A rule with no test is a rule that
will be silently reverted; a claim about testing that leaves no test behind is
worse than no claim.

The harness is `scripts/falsify.sh`. Rows below were produced by running it, and
the commands are reproducible from the table: label, file, the exact text
replaced, the text it was replaced with, the test file, the project.

Three things this record exists to say plainly, because each one was found here
rather than reasoned about:

1. **The harness itself was blind to contract changes.** Two rows reported
   SURVIVED for rules that are in fact tested, because `@nexa/contracts` is
   consumed as `dist/index.js` and the harness mutated `src`. Fixed in the
   harness rather than in this document — see § The harness could not see a
   contract change.
2. **Three rules from the first hardening commit had no reachable test**, and
   two of them had a comment claiming a guarantee nothing checked. One was a
   test asserting an hour into the future, where no progress record of any kind
   is fresh, so it passed whatever the code did.
3. **One mutation below was a no-op and was discarded rather than recorded.**
   Inserting `await Promise.resolve()` before a call does not change the order
   of two awaited calls, so its SURVIVED result said nothing. The replacement
   (B-05) moves the call past the one it must precede.

## Item E-2 — the probe cooldown floor

| #     | Rule                                                                      | Mutation                                            | Named test                                                                                          | Result |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| E2-01 | The per-panel cooldown is floored on a whole PROBE, not on one request    | drop `* MAX_REQUESTS_PER_PROBE` from `container.ts` | `web-admin-v2.test.ts` › reports the cooldown the probes actually obey, not the raw setting         | KILLED |
| E2-02 | Each provider declares the length of its longest probe path               | `maxRequestsPerProbe: 4` → `1` (Sanaei)             | `probe-cooldown-floor.test.ts` › declares, for every provider, the length of its longest probe path | KILLED |
| E2-03 | The installation-wide maximum is DERIVED across providers, never restated | the `reduce` reduced to `(most) => most`            | `probe-cooldown-floor.test.ts` › covers the longest probe any registered provider can make          | KILLED |
| E2-04 | A declared count never exceeds the adapter's own `http.send(` call sites  | `maxRequestsPerProbe: 2` → `9` (Marzban)            | `probe-cooldown-floor.test.ts` › never declares more requests than the adapter has call sites       | KILLED |

E2-02 and E2-03 are the two that first reported SURVIVED. They are recorded here
with their real result, and the reason for the false one is recorded below.

## Item H — worker loop health

| #    | Rule                                                               | Mutation                                                                 | Named test                                                                                       | Result |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ |
| H-01 | A loop that was never started makes no freshness claim             | `?? this.startedAt` → `?? this.startedAt ?? nowMs`                       | `loop-progress.test.ts` › is not fresh before it has started                                     | KILLED |
| H-02 | Freshness is bounded by the loop's own interval times its slack    | the comparison → `return true`                                           | `loop-progress.test.ts` › is fresh from the moment it starts, for one slack window               | KILLED |
| H-03 | The relay records progress on a COMPLETED batch                    | delete `this.progress.record(...)` in `processBatch`                     | `worker-loop-health.test.ts` › is not fresh until a batch has completed                          | KILLED |
| H-04 | The dispatcher records progress on a COMPLETED tick                | delete `this.progress.record(...)` in `tick`                             | `worker-loop-health.test.ts` › is not fresh until a tick has completed                           | KILLED |
| H-05 | A tick that THREW is not progress                                  | move the `record` above the `await`, so it runs before the tick resolves | `worker-loop-health.test.ts` › records no progress for a tick that threw                         | KILLED |
| H-06 | A sweeper records progress on a completed sweep                    | delete the `record` before `return removed`                              | `retention-sweeper.test.ts` › is not fresh until a sweep has completed                           | KILLED |
| H-07 | A stopped loop makes no claim                                      | delete `this.progress.end()` from `stop`                                 | `retention-sweeper.test.ts` › stops claiming freshness once stopped                              | KILLED |
| H-08 | Every freshness-bearing loop is NAMED in the worker's health check | delete the `throttle-sweeper` row from `main.worker.ts`                  | `worker-health-coverage.test.ts` › names every freshness-bearing loop in the worker health check | KILLED |
| H-09 | A stalled loop makes the worker report unhealthy                   | the `filter` → `return []`                                               | `loop-health.test.ts` › names a loop that has stopped making progress                            | KILLED |
| H-10 | A DISABLED loop is not a broken loop                               | drop `enabled &&` from the predicate                                     | `loop-health.test.ts` › treats a disabled loop as healthy rather than as broken                  | KILLED |

H-05, H-09 and H-10 did not exist as passing rows on the first run. What happened
to each is recorded below, because the sequence is the evidence and the final
KILLED on its own would misrepresent it.

## Item B — a failed backup is no longer silent

| #    | Rule                                                                           | Mutation                                                | Named test                                                                                         | Result |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| B-01 | A failed run opens an operational condition, not just a log line               | `code: 'backup.run_failed'` → `'backup.run_ok'`         | `backup-pipeline.test.ts` › reports a failed run as an operational condition, not just a log line  | KILLED |
| B-02 | A success CLOSES the open failure                                              | delete `recoversCode` / `recoversDedupeKey`             | `backup-pipeline.test.ts` › closes the open failure when a run succeeds                            | KILLED |
| B-03 | One installation-wide dedupe key, so a nightly failure is ONE condition        | `BACKUP_CONDITION_KEY` → a per-run key                  | `backup-pipeline.test.ts` › reports a failed run as an operational condition, not just a log line  | KILLED |
| B-04 | A successful run reports at all                                                | delete the whole success `report` call                  | `backup-pipeline.test.ts` › closes the open failure when a run succeeds                            | KILLED |
| B-05 | The recovery is recorded BEFORE the row is finished                            | swap the `report` and `finish` blocks                   | `backup-pipeline.test.ts` › records the recovery BEFORE it finishes the row                        | KILLED |
| B-06 | With no tenant provisioned, nothing is recorded rather than invented           | the `scope === null` guard → an invented scope          | `backup-pipeline.test.ts` › records nothing rather than addressing an alert to nobody              | KILLED |
| B-07 | A failing ops log does not replace the failure it was reporting                | rethrow from the `catch`                                | `backup-pipeline.test.ts` › does not let a failing ops log replace the failure it was reporting    | KILLED |
| B-08 | A run records what it is attributable to, and a SCHEDULED one invents no human | the repository writes `trigger: 'MANUAL'` for every run | `backup.test.ts` › records what a run is attributable to, and invents no human for a scheduled one | KILLED |

B-05's test did not exist before this run. The rule was in the code with a
docblock explaining its crash-safety reasoning, and the order was not observable
from any test, so swapping the two calls was a silent change. `FakeRuns` now
carries a `writes` log that the fake ops log appends to as well.

## Item G — the webhook edge

| #    | Rule                                                              | Mutation                                               | Named test                                                                           | Result |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------ |
| G-01 | The webhook's body limit is far below the application-wide one    | `64 * 1024` → `1_048_576`                              | `http-surface.test.ts` › keeps the application-wide limit well above the webhook one | KILLED |
| G-02 | The limit is actually applied to the route                        | delete `route.bodyLimit = ...` from the `onRoute` hook | `http-surface.test.ts` › refuses a body above the route limit before reading it      | KILLED |
| G-03 | The route does not exist at all unless the feature is switched on | register the controller unconditionally                | `http-surface.test.ts` › does not expose the route at all                            | KILLED |

G-03 is the row this item exists for, and it is recorded twice on purpose. Run
against the test AS IT WAS, at `debd0fc~1`, the same mutation reported SURVIVED.
The case posted to `/telegram/webhook` with no bot instance in the path, and the
controller is at `/telegram/webhook/:botInstanceId`, so Fastify answered 404
whether the controller was registered or not. Both results were measured, in that
order, against the same mutation and the same database — only the test changed.

A test that cannot fail is worse than a missing one: the missing test is visible
in a coverage gap, and this one reported a guarantee for two releases.

## Item D — no network or subprocess work inside a transaction

| #    | Rule                                                                  | Mutation                                                         | Named test                                                                                                    | Result |
| ---- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| D-01 | The guard refuses inside a transaction and permits outside one        | invert `if (label === undefined) return`                         | `transaction-boundary.test.ts` › refuses an external call inside a transaction, naming the sink and the scope | KILLED |
| D-02 | `uow.run` marks its callback as inside a transaction                  | drop the `withinTransaction` wrapper                             | `transaction-boundary.test.ts` › refuses a panel request made inside a real transaction                       | KILLED |
| D-03 | Every panel HTTP request asks the guard                               | delete the `assertOutsideTransaction` call from `SafeHttpClient` | `transaction-boundary.test.ts` › refuses a panel request made inside a real transaction                       | KILLED |
| D-04 | The context is scoped to the transaction, not set on the current task | `transactionLabel.run(...)` → `enterWith(...)` then `fn()`       | `transaction-boundary.test.ts` › does not leak the context to work that merely started inside                 | KILLED |

D-01 and D-04 ran against `tests/unit/transaction-boundary.test.ts`; D-02 and D-03
against `tests/integration/transaction-boundary.test.ts`. Two files share a
describe name, which is why the rows name the case rather than the file alone.

D-04 is the row worth reading. `enterWith` is the plausible-looking alternative to
`run`, and it passes every other case in the file: it sets the label for the
current task and never removes it, so the transaction's own code is guarded
correctly and everything that runs after it on the same task is ALSO guarded —
which means a legitimate send after a committed transaction is refused. The only
case that sees it is the one asserting the context is clean afterwards.

### The build-time half, which has no test file

The three checks in `scripts/check-boundaries.sh` are verified by introducing the
violation each one names, because a shell check is not reachable from vitest:

- a sink import in an `application/` directory — `import { request } from 'node:https'`
  in `panels/application/` — is reported as "A domain or application layer reaches
  a network or subprocess sink directly";
- a new file importing `node:http` outside the enumerated list is reported as "not
  covered by the transaction guard check";
- deleting the guard CALL from `telegram-transport.ts` is reported as "A network or
  subprocess sink does not refuse to run inside a transaction".

The third of those found a real hole while being written. The check originally
grepped for the bare identifier, which the file's own `import` line satisfies, so
deleting the call left it green — measured, then fixed to require
`assertOutsideTransaction(`. The probe is the reason the check works; it is
recorded here rather than cited from memory.

## The Caddy edge transition — a CONFIRMED staging defect

| #        | Rule                                                                  | Mutation                                                        | Named test                                                                                               | Result |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| CADDY-01 | An edge that will not adopt the target configuration fails the update | delete the SECOND `nexa_verify_edge_config`, return 0           | `botctl.test.sh` › update: an edge that will not adopt the target configuration FAILS the update         | KILLED |
| CADDY-02 | An edge `up -d` left alone is force-recreated                         | replace the `--force-recreate --no-deps caddy` call with `true` | `botctl.test.sh` › update: an edge that `up -d` leaves alone is recreated, and the update still succeeds | KILLED |

And the whole fix, reverted: restoring the pre-fix behaviour — bring the stack up
and declare victory, which is what `up -d` alone did — fails SIX of the 174
checks, among them `update: an edge that will not adopt the target configuration
FAILS the update`. That is the staging lie, and it is the one a test must refuse.

### The harness learned to run a shell suite

These rows could not be produced by `scripts/falsify.sh` before this branch: it
ran `vitest` and nothing else, and the deployment state machine's tests are a
shell suite. So every rule whose only behavioural test lives in
`tests/deploy/botctl.test.sh` had to be falsified BY HAND — copy the file aside,
edit it, run the suite, copy it back — which is exactly the procedure the harness
exists to replace, and exactly how a mutation gets left in a tree.

`PROJECT` now accepts the literal `shell`, which runs the named file with bash.
The first attempt at CADDY-01 was run against
`tests/unit/deployment-compose.test.ts` and reported SURVIVED, correctly: that
file is a source scan and does not assert the predicate. The row above is the
same mutation against the suite that does.

## Item I — backup_runs retention

Every row against a real PostgreSQL, because every rule is a SQL predicate and
two of them are subqueries for "the most recent row".

| #      | Rule                                                             | Mutation                                                       | Named test                                                                                        | Result |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| RET-02 | A run whose delivery outcome was never observed is never removed | delete the `delivery_state <> 'OUTCOME_UNKNOWN'` clause        | `backup-retention.test.ts` › NEVER removes a run whose delivery outcome was never observed        | KILLED |
| RET-04 | The cutoff is honoured                                           | delete the `finished_at < cutoff` clause                       | `backup-retention.test.ts` › keeps a finished run that is newer than the cutoff                   | KILLED |
| RET-05 | The most recent SUCCEEDED run is never removed                   | the subquery's `state = 'SUCCEEDED'` → a state no row can have | `backup-retention.test.ts` › NEVER removes the most recent SUCCEEDED run, even when it is ancient | KILLED |
| RET-06 | Oldest first                                                     | `ORDER BY finished_at ASC` → `DESC`                            | `backup-retention.test.ts` › respects the batch bound and removes the OLDEST rows first           | KILLED |
| RET-07 | The most recent run of any state is never removed                | delete the second `COALESCE` exclusion                         | `backup-retention.test.ts` › NEVER removes the most recent run of any state                       | KILLED |
| RET-08 | The batch is bounded by the caller's limit                       | `LIMIT ${limit}` → `LIMIT 1000000`                             | `backup-retention.test.ts` › respects the batch bound and removes the OLDEST rows first           | KILLED |

## A rule that needed TWO reverts, because two clauses enforce it

**A RUNNING run is never removed.** Two independent clauses exclude it, and
neither can be falsified alone:

- `candidate.finished_at IS NOT NULL` — a RUNNING row has no finish time, which
  the `backup_runs_finished_at_check` CHECK constraint makes equivalent to its
  state;
- `candidate.state <> 'RUNNING'` — the state named directly.

Removing either leaves the other, so each single-line mutation reported SURVIVED
(RET-01 and RET-03). That is not an untested rule; it is a rule with two guards.
Removing BOTH kills
`backup-retention.test.ts` › NEVER removes a RUNNING run, however old.

Recorded this way rather than as two SURVIVED rows, because "the rule has no
test" and "the rule has two guards" are opposite findings and the harness's
single-mutation output cannot tell them apart. The second clause is kept
deliberately: a reader must not have to know about a CHECK constraint in another
file to see that the installation's backup lock is safe, and a future run state
that carries a finish time must not quietly become eligible.

## Items A, C, K and L — the Phase 4 foundations

These are contracts with no consumer yet, which makes the falsification question
sharper rather than looser: a rule nothing calls is a rule whose test is the only
thing holding it, so a surviving mutation here would mean the declaration is
decoration.

| #       | Rule                                                        | Mutation                                    | Named test                                                                                                  | Result |
| ------- | ----------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| ACKL-01 | The namespace is part of the derived identity               | drop the namespace from the hash input      | `operation-identity.test.ts` › differs per namespace for the same key                                       | KILLED |
| ACKL-02 | A hasher that is not SHA-256 hex is refused                 | the digest guard → `if (false)`             | `operation-identity.test.ts` › refuses a hasher that does not return SHA-256 hex                            | KILLED |
| ACKL-03 | Evidence may narrow an unknown outcome to definitive        | delete the `NOT_SENT` narrowing             | `operation-identity.test.ts` › lets evidence narrow an unknown outcome to definitive, and never the reverse | KILLED |
| ACKL-04 | A lost response is UNKNOWN, not definitive                  | `TIMEOUT: 'UNKNOWN'` → `'DEFINITIVE'`       | `operation-identity.test.ts` › is a DIFFERENT axis from retryability                                        | KILLED |
| ACKL-05 | A note over budget is refused, never truncated              | the length guard → `if (false)`             | `operation-identity.test.ts` › stays inside the budget, and refuses rather than truncating                  | KILLED |
| ACKL-06 | A note is recognised by its whole SHAPE, not by a substring | the shape test → `trimmed.includes('TG: ')` | `operation-identity.test.ts` › recognises its own note and refuses to claim somebody else                   | KILLED |

ACKL-06 is the one worth reading. The loose version — "does it mention TG?" —
passes every case about recognising our own note and fails only on the cases about
NOT claiming somebody else's: a human note reading `TG: 123456789`, and our note
with a human's words appended. Those are the cases that matter, because the
consequence of getting them wrong is overwriting a human's note with no copy
anywhere.

## The harness could not see a contract change

`packages/contracts/package.json` declares `exports: { ".": "./dist/index.js" }`,
and `node_modules/@nexa/contracts` is a link to the package directory. Nothing
aliases the specifier to `src` — not `vitest.config.mts`, not any tsconfig in
play at runtime. So a test importing `MAX_REQUESTS_PER_PROBE` reads the COMPILED
file, and mutating `packages/contracts/src/provider.ts` left that file untouched.

Measured, in this order. `maxRequestsPerProbe: 4` → `1` reported SURVIVED, then
KILLED once the harness rebuilt the package. The `reduce` reduced to the identity
reported SURVIVED, then KILLED. Both SURVIVED results were false. Nothing about the rules changed between the
two columns; only the harness did.

`docs/phase3d-falsification.md` already recorded this trap, as something the
author has to remember to do by hand. Remembering is not a mechanism, and the
cost of forgetting is a row in an evidence record that is exactly backwards. So
`scripts/falsify.sh` now derives the package from the mutated path, rebuilds it
before running the test, and rebuilds it again from the restored source
afterwards.

The second rebuild is not symmetry for its own sake. Without it a MUTATED `dist`
is left on disk beside clean `src`, which `git diff` cannot see — a strictly
worse version of the leftover-mutation failure the harness already refuses to
end on.

A mutation that does not COMPILE now reports SETUP-FAILED rather than running the
test, because a test failing on a broken package is not evidence about a rule.

## Three rules from the first hardening commit that no test could reach

### H-05 — a test that asserted an hour into the future

`worker-loop-health.test.ts` › records no progress for a tick that threw read
`dispatcher.isFresh(now + 60 * 60 * 1000)`. The hour was there to avoid reading
progress that an earlier case in the same file had recorded on the shared
dispatcher — and an hour out, no progress record of any kind is fresh, so the
assertion held whether this tick recorded progress or not.

It killed the DELETION of the recording, which is why it looked like a working
test. It SURVIVED moving the recording above the `await`, which is the mutation
that actually reintroduces the bug: a tick that threw would count as progress,
and the loop that drains the queue by which this installation reports anything
being wrong would report healthy while every tick failed.

The case now calls `stop()` first — which clears both the start instant and the
last tick — and asserts at `now`, where only a new record can make it true.

### H-09 and H-10 — an aggregation no test could call

The worker's readiness verdict was a closure inside `main()`, reachable only by
booting the role. Replacing its `filter` with `[]` — a worker reporting healthy
with every loop dead — left the entire suite green. The comment above it said the
aggregation "is a `filter` and needs no test".

It is now `stalledLoops` in `apps/api/src/infrastructure/lifecycle/loop-health.ts`.
The per-loop enable flag is passed as DATA rather than folded into the boolean by
the caller, so H-10 is falsifiable too — and that direction matters as much as
H-09: a disabled loop never had `begin()` called, so its `isFresh` is false for
ever, and reading that as a failure would make every deployment with the relay
switched off permanently unhealthy.

`worker-health-coverage.test.ts` still proves every loop is NAMED in the check by
reading the source; `loop-health.test.ts` proves the check then does something
with the names. Neither subsumes the other, and the first cannot replace the
second: a source scan can see a list and not what the list is for.

### B-08 — what accountability for a backup actually rests on

The audit's item B reported that the backup module has no `ScopeContext`, no
`ActorContext`, no idempotency key and no audit row. All four are true, and
ADR-0025 now argues each as a decision rather than leaving the grep to speak for
itself: `backup run` is a CLI on the host, the actor model knows an `admins` row or
`SYSTEM_JOB`, and a shell user is neither — so recording one would invent an
administrator or address the run to an unrelated tenant.

So the row asserts the source of accountability that EXISTS, which is the run row's
trigger, its identity, its bounding times and its lease owner. The mutation forces
every run to `MANUAL`, which is the shape a false attribution takes: a
system-triggered run wearing a human's trigger. The same case also asserts that no
duplicate audit row was invented, because two rows carrying the same id, times,
trigger and outcome are two rows that come to disagree the first time a failure
lands between them.

## Items E-1 and F-1 — the capability gate and the Redis requirement

| #     | Rule                                                            | Mutation                                                          | Named test                                                                                  | Result |
| ----- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| E1-01 | The monitor asks the adapter before it probes                   | the gate's condition → `if (false) {`                             | `panel-monitor.test.ts` › does not probe a provider whose adapter does not do health checks | KILLED |
| E1-02 | The operator is TOLD, rather than getting a silent 200          | the `CAPABILITY_UNSUPPORTED` branch's condition → `false`         | `panels.test.ts` › refuses to test a panel whose adapter does not do health checks          | KILLED |
| E1-03 | The refusal defers on the STABLE cadence                        | delete `case 'CAPABILITY_UNSUPPORTED':` from `deferralIntervalMs` | `probe-capability-gate.test.ts` › is STABLE, not transient                                  | KILLED |
| E1-04 | The scheduler records the reason it actually had                | `deferralReasonOf` returns `'INTERNAL_ERROR'` for it              | `panel-monitor.test.ts` › does not probe a provider whose adapter does not do health checks | KILLED |
| E1-05 | The gate sits ABOVE the credential read                         | move the gate below `toProviderCredentials`                       | `panels.test.ts` › reports the capability refusal ahead of a missing credential             | KILLED |
| F1-01 | Only a REQUIRED dependency being down makes a process not ready | drop `&& d.required !== false` from the aggregation               | `readiness-requirements.test.ts` › is STILL READY when Redis is down, and reports it down   | KILLED |
| F1-02 | Redis is declared NOT required                                  | `this.timed('redis', false, …)` → `true`                          | `readiness-requirements.test.ts` › is STILL READY when Redis is down, and reports it down   | KILLED |
| F1-03 | An UNSTATED requirement counts as required                      | `required !== false` → `required === true`                        | `readiness-requirements.test.ts` › treats an UNSTATED requirement as required               | KILLED |
| F1-04 | Redis is still REPORTED down — not made invisible               | the cache probe always returns `{ ok: true }`                     | `readiness-requirements.test.ts` › is STILL READY when Redis is down, and reports it down   | KILLED |

### What E1-01 found that reading did not

The gate was written, the unit test passed, and the integration test failed with
`deferred: 0` and a schedule row reading `INTERNAL_ERROR`. The CHECK constraint on
`panel_monitor_schedule.deferred_reason` is built from the contract enum by a
migration, so a new reason is unwritable until one widens it: the insert violated
the constraint, the candidate threw, and the monitor recorded the generic scheduler
failure for a refusal it had understood perfectly well. Migration 0028 is in the
contract commit for that reason. The unit test could not have found this — the
constraint is in the database.

It also found a defect in the test harness rather than in the product. Every panel
suite built its adapter as `{ ...providerAdapter(type), probe }`, and the adapters
are classes, so `supports` is a PROTOTYPE method that object spread does not copy.
The stand-in had silently lost every prototype method and passed for as long as
nothing called one; asking `supports()` failed 71 monitor cases at once, on a
production change that was correct. `adapterWith` in `tests/integration/harness.ts`
assigns onto the real instance instead. The bad version of this bug is the one
where the test keeps passing — which is what a spread would do for any future
method no test happens to exercise.

### F1-03 is the row that needed the production code changed to be testable

The predicate was a lambda inside `run`, and all four probes in that file state
`required` explicitly — so `!== false` and `=== true` behave identically there and
the mutation SURVIVED. The case that claimed to cover it restated the predicate in
its own assertion, which is the "test that cannot fail" shape: it was green under
the mutation because it was not reading the production line at all.

`blocksReadiness` is now an exported free function, so it can be called with the
shape a probe that omits the flag actually produces. That is the only way this rule
is falsifiable, and the rule matters in exactly one direction: with `=== true` a
dependency added without the flag is silently optional — down while the process
reports ready, which is item F's defect pointing the other way.

## Item E-3 — a producer check for the provider failure taxonomy

No test file: it is a build-time check in `scripts/check-boundaries.sh`, like the
`check:build` half of item D. Both halves were run by hand against a committed tree
and the tree verified byte-identical afterwards.

Adding `'A_KIND_NOTHING_PRODUCES'` to `PROVIDER_FAILURE_KINDS` makes the check
report `FAIL  every provider failure kind has a producer`, and the vacuity guard
beside it still reports `ok … (11 kinds)` — so the two are independent, which is
the point of having both. Pointing the guard's `sed` range at a constant that does
not exist makes it report `FAIL  The provider failure kinds could not be read from
the contract` while the producer check above it reports `ok`: a reader that has
stopped matching looks exactly like a vocabulary with no dead entries, and that is
the failure the guard exists to separate.

Ten kinds, ten producers. The reason this check was worth adding to a taxonomy that
is currently complete is the shape of the tests that already existed: every one
ITERATES the list to assert consumers handle each kind, which cannot notice a kind
nothing produces — remove the only producer of `AUTHENTICATION_REQUIRES_INTERACTION`
and every consumer test still passes, because the list still contains it.

## Item M — the failure modes nothing exercised

Item M listed five failure modes with no test. The CLI was already fixed on the
Backup V1 branch; Redis-unreachable is covered above as `F1-04`. These are the
other three, and **two of them found defects rather than confirming rules.**

| #    | Rule                                                                     | Mutation                                                | Named test                                                                                      | Result |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| M-01 | An IDLE pooled connection's death does not kill the process              | delete `pool.on('error', report)`                       | `connection-death.test.ts` › does not kill a process whose IDLE pooled connection is terminated | KILLED |
| M-02 | A connection killed MID-CHECKOUT does not kill the process either        | `pool.on('connect', …)` attaches nothing                | `connection-death.test.ts` › does not kill a process whose OPEN TRANSACTION loses its backend   | KILLED |
| M-03 | A workspace that cannot be created FAILS the run rather than escaping it | create the workspace before the `try`, as it used to be | `backup.test.ts` › fails the run and delivers nothing when the work directory cannot be written | KILLED |
| M-04 | A dump past its deadline is stopped PROMPTLY                             | delete `child.kill('SIGTERM')`                          | `backup.test.ts` › stops a dump that runs past its timeout, and kills the subprocess            | KILLED |
| M-05 | A dump that IGNORES SIGTERM is killed anyway                             | delete the `SIGKILL` backstop timer                     | `backup.test.ts` › kills a dump that ignores SIGTERM                                            | KILLED |

### M-01 and M-02 — the defect was that nobody was listening

`pg_terminate_backend` appeared nowhere in the repository, and testing it found
that `pg` delivers a connection death as an `'error'` EVENT while nothing in
`apps/api/src` listened — no `pool.on('error')`, no `uncaughtException` handler.
`EventEmitter` throws for an unlistened `'error'`, so the death was an uncaught
exception and the process died, past every `try`/`catch` and past the shutdown
hooks. Measured before the fix:

    idle client        UNCAUGHT: terminating connection due to administrator command
    open transaction   UNCAUGHT: Connection terminated unexpectedly

The two rows are separate because the obvious fix covers only one of them. A
listener on the POOL handles an idle client, whose error `pg-pool` re-emits there;
it does NOT handle a checked-out client, because `pg-pool` removes its own listener
for the duration of a checkout and the socket error arrives in that window, before
the transaction's `finally` can release. Measured: with only `pool.on('error')` the
idle case survives and the in-transaction case still exits. M-02 is the row that
proves the second listener is not redundant.

These cases spawn a CHILD PROCESS, because the property is "this process is still
alive" and no test can assert that about its own runner — vitest handles the
uncaught exception, reports it beside a test that may still pass, and carries on.
The child exits 9 on an uncaught exception, 8 if a transaction survived its own
backend, 7 if the pool could not reconnect, and 0 only when the death was
reported, the work failed cleanly and a later checkout worked.

### M-03 — disk exhaustion made backups stop silently

`workspaces.create(id)` was the statement between the RUNNING claim and the `try`.
A work directory that could not be created threw out of `run()` and left the claim
behind: no FAILED row, therefore no `backup.run_failed` condition and no
notification, while the RUNNING row held the installation's one-backup-at-a-time
lease until it went stale. The only symptom was the absence of backups.

The test uses ENOTDIR — a regular file occupying the path the work root needs —
and not a read-only directory. `chmod 0500` was the first attempt and proved
nothing: these suites run as root, root ignores directory permissions, and the
backup SUCCEEDED through a mode `0500` directory. **A test that can only pass as
an unprivileged user is a test that does not run where it matters.**

ENOSPC itself needs a size-limited filesystem and therefore mount privileges CI may
not have, so it was exercised BY HAND against a 64 KiB tmpfs with the real
`PostgresDatabaseTools`. `pg_dump` fails and the tool reports:

    CODE: backup.tool_failed
    MESSAGE: pg_dump did not complete, so this run produced no artifact.

Classified, and with no path, no connection string and no errno handed onward. That
throw happens inside the `try`, so it takes the recorded path the suite already
asserts. A 1 MiB tmpfs was tried first and the dump FITTED — the development
database dumps to 104 KiB — which is why the figure is 64 KiB.

### M-04 and M-05 — one case that covered two rules covered neither

M-04 first reported SURVIVED. Deleting `child.kill('SIGTERM')` left the timeout
case green, because the SIGKILL backstop five seconds later still ends the child
and the upper bound was 30s — wide enough to hide the difference between
"terminated promptly" and "terminated five seconds late by the backstop". The bound
is now 4s.

The backstop then needed its own case, because `sleep` dies on SIGTERM: with one
case, deleting the backstop was invisible. M-05's child traps SIGTERM and keeps
going, which is the state the backstop exists for.

Its stdio is redirected to `/dev/null` before it sleeps, and that is load-bearing:
the production code settles on the child's `close` event, which waits for the stdio
pipes as well as the exit, so an orphan still holding the inherited stdout keeps
the promise pending for ever. The first version of the fixture backgrounded `sleep`
with the pipes inherited and the test hung for its full sixty seconds with the
shell already killed on time. `pg_dump` and `pg_restore` leave no such descendant,
which is why that is the fixture's problem and not the product's.

## Method notes

- Every row was run against a COMMITTED tree. The harness refuses a dirty target
  for a reason recorded in `docs/backup-falsification.md`: restore is
  `git checkout --`, so it once deleted an unfinished refactor.
- Integration rows ran against real PostgreSQL 16.13 and the real loops. Unit
  rows are pure.
- **One failure observed mid-branch was chased to a conclusion rather than
  dismissed.** A single run of `worker-loop-health.test.ts` was recorded as
  failing (1 failed / 5 passed) against a case noted as "claims no freshness
  until it is started". It has not recurred and the note was wrong about the
  name: **no test in this repository is called that**. The nearest is
  `loop-progress.test.ts` › "is not fresh before it has started".

  Both were run to determinism: `worker-loop-health.test.ts` **14 consecutive
  passes** (4 at the time, 10 in one loop afterwards), `loop-progress.test.ts`
  **25 consecutive passes**. 39 runs, no failure.

  The structural reason a race here is implausible is worth stating, because run
  counts alone never prove absence: `LoopProgress` takes every timestamp as a
  PARAMETER — `begin(nowMs)`, `record(nowMs)`, `isFresh(nowMs)` — and reads no
  clock and sets no timer. The only time that can vary is the caller's, and the
  assertions in both suites compare against a timestamp captured before the work,
  so a slow run makes `nowMs - since` more negative rather than crossing the
  bound. There is no window to lose.

  The most likely explanation is that the run was made against a mid-edit tree:
  the failure was observed while `probe-core.ts` and `readiness.service.ts` were
  being rewritten, and an incomplete file is a real failure of the code at that
  instant rather than nondeterminism. What would change this verdict is one
  recurrence with a log naming a case that exists.

- `B-04` as first written inserted `await Promise.resolve()` and reported
  SURVIVED. That is a no-op mutation, not a survival: it does not reorder two
  awaited calls. It is recorded here rather than in the table, because a SURVIVED
  row whose mutation changes nothing is noise that reads as a finding.
