# Web Admin Disaster Recovery — falsification record

Every production rule this branch added, reverted one at a time against the
working tree, with the test that dies named. A rule with no test is a rule that
will be silently reverted; a claim about testing that leaves no test behind is
worse than no claim.

The harness is `scripts/falsify.sh`, and every row below was produced by running
it: label, file, the exact text replaced, the text it was replaced with, the test
file, the project. Each is reproducible from the table.

Three things this record exists to say plainly, because all three were found here
rather than reasoned about:

1. **Three rows reported SURVIVED on the first run, and all three were real.**
   One was a test that could not fail — the relay's quiesce assertion was
   satisfied by an empty outbox, so it passed whether the gate refused the batch
   or there was nothing to refuse. One was a rule with genuinely no test: the
   executor's own cutover refusal, unreachable through any archive because the
   restore test refuses a diverged one first. One was a defensive branch that is
   unreachable by construction, and is recorded as such rather than given a
   contrived test. None of them is hidden here.
2. **The expiry row was falsified in BOTH directions**, and the second direction
   is the one that matters: inverting the comparison — refusing every
   confirmation rather than none — kills seven cases including a positive control
   written for exactly that. This project has shipped an inverted rule three
   times on one branch, each inversion passing a green suite, and a one-sided
   mutation would not have seen it.
3. **Two rows are NOT FALSIFIABLE and say why.** They are not counted as passing.

## The rules this branch added

| #    | Rule                                                                          | Mutation                                                          | Named test                                                                                                      | Result |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| A-01 | The payload must BE a `pg_dump` custom archive, not merely decrypt            | `isCustomFormatDump(...)` → `true`                                | `web-disaster-recovery.test.ts` › refuses a payload that is not a pg_dump archive, naming the manifest          | KILLED |
| A-02 | The manifest's checksum must be the payload's                                 | `opened.dumpChecksum === opened.manifest.checksum` → `true`       | `web-disaster-recovery.test.ts` › refuses a manifest whose checksum is not the payload it carries               | KILLED |
| A-03 | A key this installation does not hold is its OWN code, not a corrupt file     | `'recovery.archive_foreign_key'` → `'recovery.archive_malformed'` | `web-disaster-recovery.test.ts` › refuses an archive wrapped under a key this installation does not hold        | KILLED |
| C-01 | A recovery id is validated before it reaches PostgreSQL                       | `if (!uuidV7Schema.safeParse(id).success) {` → `if (false) {`     | `web-disaster-recovery.test.ts` › answers 404 and never 500 for %s (%s) (it.each, 5 shapes)                     | KILLED |
| T-01 | A recovery is read within its scope, and another scope's id is not-found      | `byId(scope.tenantId, id)` → `byIdUnscoped(id)`                   | `web-disaster-recovery.test.ts` › answers not-found for a recovery belonging to another scope                   | KILLED |
| D-01 | The download serves the ENCRYPTED archive and never a plaintext dump          | `'archive.nxb'` → `'dump.sql'`                                    | `web-disaster-recovery.test.ts` › takes a real backup, verified against a real restore                          | KILLED |
| S-01 | The restore-test's scratch database is dropped whatever happened              | delete `await this.deps.engine.dropDatabase(scratch);`            | `web-disaster-recovery.test.ts` › drops the scratch database and removes the plaintext                          | KILLED |
| Q-01 | A manual backup is refused on ARRIVAL while a recovery holds the installation | `if (lock !== null && lock.quiescing) {` → `if (false && ...) {`  | `web-disaster-recovery.test.ts` › refuses a new backup while a recovery is restoring, and says so in the status | KILLED |
| Q-02 | The status REPORTS the quiesce, so the page does not find out by pressing     | `quiesced: lock !== null && lock.quiescing` → `quiesced: false`   | `web-disaster-recovery.test.ts` › refuses a new backup while a recovery is restoring, and says so in the status | KILLED |
| G-01 | Every durable write is refused at the unit of work during a quiesce           | delete `assertInstallationWritable(...)` from `run`               | `recovery-executor.test.ts` › quiesces the installation while restoring, and the relay idles                    | KILLED |
| G-02 | The outbox relay claims nothing during a quiesce                              | `await this.gate.quiescedBy({ tx })` → `null`                     | `recovery-executor.test.ts` › quiesces the installation while restoring, and the relay idles                    | KILLED |
| X-01 | A confirmation EXPIRES, and the executor checks the clock as it claims        | the expiry comparison → `false`                                   | `recovery-executor.test.ts` › refuses an expired confirmation, and nothing destructive happens                  | KILLED |
| X-03 | …and the check is the right way round                                         | `<=` → `>=` in the same comparison                                | `recovery-executor.test.ts` › accepts a confirmation that is still inside its window                            | KILLED |
| R-01 | A pre-restore backup that cannot START aborts the recovery                    | `if (emergency.kind === 'BUSY') {` → `if (false) {`               | `recovery-executor.test.ts` › aborts before anything destructive when the emergency backup cannot run           | KILLED |
| R-02 | The request's own row is RE-ASSERTED into the restored database               | delete `await this.deps.requests.reassert(reasserted);`           | `recovery-executor.test.ts` › re-asserts its own row into the restored database                                 | KILLED |
| R-03 | A candidate this release cannot account for is never cut over to              | `if (!compatibility.permitted) {` → `if (false) {`                | `recovery-executor.test.ts` › refuses to cut over to a candidate this release cannot account for                | KILLED |
| R-04 | A candidate whose name is already taken fails, and production keeps serving   | (no mutation — the collision IS the fixture)                      | `recovery-executor.test.ts` › fails on a candidate name already taken, and leaves production serving            | n/a    |
| L-01 | Only one executor claims a confirmed recovery                                 | drop `lease_owner IS NULL` from the claim predicate               | `recovery-executor.test.ts` › lets only one executor claim a confirmed recovery                                 | KILLED |
| E-01 | `restoreIntoEmpty` refuses the LIVE database by name                          | delete `assertNotLiveTarget(...)` from `restoreIntoEmpty`         | `restore-engine-refusals.test.ts` › a restore into the LIVE database, by name                                   | KILLED |
| E-02 | `restoreIntoEmpty` refuses a target that is not empty                         | delete `await this.assertEmpty(name, env);`                       | `restore-engine-refusals.test.ts` › a restore into a database that is not empty                                 | KILLED |
| H-11 | The recovery role checks the loop it starts                                   | `container.recoveryExecutor.isFresh(...)` → `true`                | `worker-health-coverage.test.ts` › checks the recovery executor in the recovery role                            | KILLED |
| H-12 | The worker names the recovery sweeper in its health check                     | delete the `recovery-request-sweeper` row from `main.worker.ts`   | `worker-health-coverage.test.ts` › names every worker-started loop in the worker health check                   | KILLED |

## The Web Admin's rules

| #    | Rule                                                                     | Mutation                                                       | Named test                                                                                                         | Result |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| W-01 | No run BUTTON for an actor without `backup.run` — absent, not disabled   | `{mayRun && (` → `{true && (`                                  | `recovery.test.tsx` › offers no run button to an actor without backup.run                                          | KILLED |
| W-02 | No download control for an actor without `backup.download`               | `if (!mayDownload) return null;` → `void mayDownload;`         | `recovery.test.tsx` › offers no download link to an actor without backup.download                                  | KILLED |
| W-03 | The confirm button stays disabled until the phrase matches               | `disabled={!matches \|\| busy \|\| ...}` → `disabled={busy}`   | `recovery.test.tsx` › keeps the confirm button disabled until the exact phrase is typed                            | KILLED |
| W-04 | The phrase comparison is the CONTRACT's, not a friendlier local one      | `isRecoveryConfirmationPhrase(phrase)` → a lower-cased compare | `recovery.test.tsx` › keeps the confirm button disabled until the exact phrase is typed                            | KILLED |
| W-05 | The run button is disabled while a recovery holds the installation       | `disabled={busy \|\| status.quiesced}` → `disabled={busy}`     | `recovery.test.tsx` › shows the quiesce banner and disables the run button while a recovery holds the installation | KILLED |
| W-06 | The restore section REFUSES rather than vanishing without the permission | the refusal banner → `null`                                    | `recovery.test.tsx` › refuses the restore section to an actor without recovery.restore                             | KILLED |
| W-07 | The confirmation carries the artifact's checksum, so it is bound         | `artifactChecksum: input.checksum` → `artifactChecksum: ''`    | `recovery.test.tsx` › sends the artifact checksum with the confirmation, so it is bound                            | KILLED |
| W-08 | Nothing secret-shaped is rendered                                        | a forbidden token planted in a rendered i18n value             | `recovery.test.tsx` › renders no secret anywhere on the page                                                       | KILLED |

W-08's mutation is in `web.fa.ts` rather than in the page, deliberately: the
assertion's value is as a tripwire over the rendered TEXT, and the question worth
answering is whether it fires at all — a scan wired to the wrong container, or
comparing against the wrong string, passes silently for ever.

## The two SURVIVED results, and what was done about each

**G-02 — the relay's quiesce check.** Removing it left the suite green. The
assertion was `expect(batch).toEqual({ claimed: 0, published: 0, failed: 0 })`
against an EMPTY outbox, so it passed whether the gate refused the batch or
there was simply nothing to claim — a test that could not fail, guarding one of
the two chokepoints the entire quiesce design rests on. Fixed by planting a real
outbox message first, asserting it is still unclaimed afterwards, and then
lifting the quiesce and asking the same relay again as a positive control. The
mutation now dies.

**R-03 — the executor's cutover refusal.** Genuinely untested, and the reason is
structural: a diverged archive is refused by the restore test before it can
become a confirmed request, so no archive can reach this check. It is still
load-bearing, by two routes no archive produces — a candidate that passed the
restore test as BEHIND-but-migratable and did not become current after
`migrateCandidate`, and an executor running a different release's migration
journal than the api that tested the archive, which is one moment of every
rolling update. Fixed by injecting the STATE at the executor's own seam: its real
deps with `compatibility` reporting a verdict this release cannot cut over to,
everything else the production object, so the refusal happens after a real
candidate has really been restored. The mutation now dies.

## NOT FALSIFIABLE, with the reason

Neither is counted as a passing row, and neither is given a contrived test.

**The expiry's null branch.** `request.confirmationExpiresAt === null` cannot be
reached: the binding re-check above it refuses any row whose `confirmedChecksum`
is null, and `recovery_requests` carries a CHECK constraint requiring the four
confirmation columns to be set together or not at all
(`num_nonnulls(...) IN (0, 4)`). Replacing the null test with `false` therefore
survives. The case it exists for — a row that reached `RESTORE_REQUESTED` with no
confirmation at all — IS tested, and dies on the binding check:
`recovery-executor.test.ts` › refuses a request that reached RESTORE_REQUESTED
with no confirmation at all. The branch stays as defence against a future
reordering.

**The candidate-name collision (R-04).** Its fixture is the collision itself —
the candidate's name is derived from the recovery id, so the test takes the name
in advance — and there is no production predicate to revert: the refusal is
PostgreSQL's, arriving as a failed `CREATE DATABASE`. What the case proves is the
HANDLING, which is falsifiable through R-01's neighbour rows rather than through
a mutation of its own.

## Tests that cannot fail, removed rather than explained

One, found while writing the web suite and recorded because it was green and
worthless: two cases asserted the ABSENCE of a control after awaiting a card
HEADING, which renders outside the query's state switch and therefore before the
response arrives. Both were asserting over an empty section. Ungating the run
button left both passing; they now wait on a value the response produced, and
W-01 and W-02 above are the mutations that prove it.

## The final review round, after the exact-head CI was green

Three rules, added or corrected by the bounded review of PR #18. Produced
differently from the rows above and said so plainly: `scripts/falsify.sh` reverts
a predicate in a source file, and two of these rules live in a MIGRATION and in a
`Dockerfile` rather than in TypeScript. Each mutation below was applied by hand to
the file named, the focused test was run, the file was restored, and the test was
re-run green — the same four steps the harness performs, with the mutation in a
file it cannot reach.

| #    | Rule                                                                             | Mutation                                                                              | Named test                                                                                                | Result |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | A displaced database with NO cutover is representable — the `RENAMED_OUT` window | `0030_*.sql`: the check back to `(cutover_at IS NULL) = (displaced_database IS NULL)` | `recovery-executor.test.ts` › reconstructs a cutover that renamed the outgoing database and stopped there | KILLED |
| F-02 | Retention keeps a row naming a displaced database, cutover or not                | delete `displaced_database IS NULL` from both predicates of `purgeFinishedBefore`     | `web-disaster-recovery.test.ts` › never purges a row naming a displaced database, cutover or not          | KILLED |
| F-03 | The image's PostgreSQL client major IS the compose server's                      | `Dockerfile`: `ARG PG_MAJOR=16` → `15`                                                | `deployment-compose.test.ts` › installs the PostgreSQL client tools at the server image major version     | KILLED |

**What F-01 was.** The check refused the one row both reconstruction paths write
after a cutover that renamed the outgoing database and failed to rename the
candidate into place. `reassert` raised 23514, so the recovery was recorded
nowhere, the journal was never cleared, and every later tick threw inside
`reconcileCutovers` — which runs before `reclaimAbandoned` and before any claim,
so the executor would never take another recovery. The displaced name, which is
the operator's rollback, was lost with it.

**What F-03 was.** The `Dockerfile` comment cited this test before the test
existed. A claim about testing that leaves no test behind is worse than no claim,
so the test it named is now the test that exists.
