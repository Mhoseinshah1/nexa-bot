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

| #    | Rule                                                                    | Mutation                                        | Named test                                                                                        | Result |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| B-01 | A failed run opens an operational condition, not just a log line        | `code: 'backup.run_failed'` → `'backup.run_ok'` | `backup-pipeline.test.ts` › reports a failed run as an operational condition, not just a log line | KILLED |
| B-02 | A success CLOSES the open failure                                       | delete `recoversCode` / `recoversDedupeKey`     | `backup-pipeline.test.ts` › closes the open failure when a run succeeds                           | KILLED |
| B-03 | One installation-wide dedupe key, so a nightly failure is ONE condition | `BACKUP_CONDITION_KEY` → a per-run key          | `backup-pipeline.test.ts` › reports a failed run as an operational condition, not just a log line | KILLED |
| B-04 | A successful run reports at all                                         | delete the whole success `report` call          | `backup-pipeline.test.ts` › closes the open failure when a run succeeds                           | KILLED |
| B-05 | The recovery is recorded BEFORE the row is finished                     | swap the `report` and `finish` blocks           | `backup-pipeline.test.ts` › records the recovery BEFORE it finishes the row                       | KILLED |
| B-06 | With no tenant provisioned, nothing is recorded rather than invented    | the `scope === null` guard → an invented scope  | `backup-pipeline.test.ts` › records nothing rather than addressing an alert to nobody             | KILLED |
| B-07 | A failing ops log does not replace the failure it was reporting         | rethrow from the `catch`                        | `backup-pipeline.test.ts` › does not let a failing ops log replace the failure it was reporting   | KILLED |

B-05's test did not exist before this run. The rule was in the code with a
docblock explaining its crash-safety reasoning, and the order was not observable
from any test, so swapping the two calls was a silent change. `FakeRuns` now
carries a `writes` log that the fake ops log appends to as well.

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

## Method notes

- Every row was run against a COMMITTED tree. The harness refuses a dirty target
  for a reason recorded in `docs/backup-falsification.md`: restore is
  `git checkout --`, so it once deleted an unfinished refactor.
- Integration rows ran against real PostgreSQL 16.13 and the real loops. Unit
  rows are pure.
- `B-04` as first written inserted `await Promise.resolve()` and reported
  SURVIVED. That is a no-op mutation, not a survival: it does not reorder two
  awaited calls. It is recorded here rather than in the table, because a SURVIVED
  row whose mutation changes nothing is noise that reads as a finding.
