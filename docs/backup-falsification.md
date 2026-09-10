# Telegram Backup V1 — falsification record

Every production rule this phase added, reverted one at a time against the
working tree, with the test that dies named. A rule with no test is a rule that
will be silently reverted; a claim about testing that leaves no test behind is
worse than no claim.

The harness is `scripts/falsify.sh`: it applies exactly one textual mutation
(refusing to run if the text is not unique), runs one test file, restores the
file with `git checkout --`, and **fails the row if the file is not
byte-identical afterwards**. A falsification harness that leaves a mutation
behind is how a reverted production rule reaches a commit.

Four rows below are marked SURVIVED-then-fixed. They are the point of doing
this: in each case the mutation passed a green suite, which meant the rule had
no test — and in two of them the _comment_ claimed a guarantee the code did not
have. The fix is recorded beside the row.

## Rules that die when reverted

| #   | Rule                                                                  | Mutation                                                      | Named test                                                                                              | Result |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| B01 | `DELIVER` is reachable only from a `VERIFY_RESTORE` that passed       | `if (!outcome.ok)` → `if (false)`                             | `backup-pipeline.test.ts` › never delivers an archive whose restore verification failed                 | KILLED |
| B02 | A restore that produces zero tables is a failure                      | `if (outcome.tableCount === 0)` → `if (false)`                | `backup-pipeline.test.ts` › fails a restore that succeeds and produces no tables                        | KILLED |
| B03 | The decrypted bytes must checksum to what was taken before encryption | the mismatch guard → `if (false)`                             | `backup-pipeline.test.ts` › fails when the decrypted bytes do not match the checksum that was taken     | KILLED |
| B04 | A zero-byte dump is a failure, not an artifact                        | `if (digest.bytes === 0)` → `if (false)`                      | `backup-pipeline.test.ts` › fails a zero-byte dump rather than encrypting and delivering it             | KILLED |
| B05 | The plaintext dump is removed before the delivery stage               | `await workspace.discardPlaintext()` → `[]`                   | `backup-pipeline.test.ts` › removes the plaintext dump before delivery, and everything on failure       | KILLED |
| B06 | Above Telegram's ceiling the group is notified, not sent a document   | the size branch → `if (false)`                                | `backup-pipeline.test.ts` › notifies rather than sends when the archive is above the Telegram ceiling   | KILLED |
| B07 | No destination configured is `NOT_ATTEMPTED`, not a failure           | `if (!this.deps.delivery.configured)` → `if (false)`          | `backup-pipeline.test.ts` › distinguishes no destination from a failed delivery                         | KILLED |
| B08 | Due is measured from the last SUCCESSFUL run, not from process start  | `dueAt` → `0`                                                 | `backup-pipeline.test.ts` › measures the interval from the last SUCCESS, not from process start         | KILLED |
| B09 | A throwing tick does not advance the scheduler's freshness            | advance `lastTickAt` in the `catch` too                       | `backup-pipeline.test.ts` › is not fresh until a tick completes, and stops being fresh when ticks throw | KILLED |
| B11 | Every archive gets a fresh payload nonce                              | `randomBytes(GCM_IV_BYTES)` → `Buffer.alloc(GCM_IV_BYTES, 7)` | `backup-archive.test.ts` › gives every archive fresh key material and fresh nonces                      | KILLED |
| B14 | The manifest length is validated AFTER authentication, never before   | restore the early `throw archiveMalformed(...)`               | `backup-archive.test.ts` › detects a single modified byte anywhere in the ciphertext                    | KILLED |
| B16 | A 5xx or a 429 is `OUTCOME_UNKNOWN`, never a definitive failure       | `OUTCOME_UNKNOWN` → `FAILED_DEFINITIVE`                       | `backup-delivery.test.ts` › treats a 5xx as unobserved rather than as a failure                         | KILLED |
| B17 | An unreadable 2xx body is `OUTCOME_UNKNOWN`                           | `OUTCOME_UNKNOWN` → `FAILED_DEFINITIVE`                       | `backup-delivery.test.ts` › treats a 2xx whose body will not parse as unobserved                        | KILLED |
| B18 | A transport failure mid-upload is `OUTCOME_UNKNOWN`                   | `OUTCOME_UNKNOWN` → `FAILED_DEFINITIVE`                       | `backup-delivery.test.ts` › treats a dropped connection as unobserved                                   | KILLED |
| B20 | An archive that was never opened is a DEFINITIVE failure              | `FAILED_DEFINITIVE` → `OUTCOME_UNKNOWN`                       | `backup-delivery.test.ts` › is definitive, not ambiguous, when nothing was ever sent                    | KILLED |
| B22 | A restore target that already holds tables is refused                 | the emptiness guard → `if (false)`                            | `backup.test.ts` › refuses a restore target that already holds tables                                   | KILLED |
| B25 | A stale lease is CLOSED, releasing the lock, not left RUNNING         | `state: 'FAILED'` → `state: 'RUNNING'`                        | `backup.test.ts` › releases a lock whose owner stopped reporting, by failing the run                    | KILLED |
| B26 | Backup delivery is configured wholly or not at all                    | `if (chat !== token)` → `if (false)`                          | `config.test.ts` › refuses half-configured backup delivery                                              | KILLED |
| B27 | The work directory is never under `/tmp`                              | default → `/tmp/nexa-backups`                                 | `config.test.ts` › defaults the scheduled backup OFF and its work directory off /tmp                    | KILLED |
| B28 | The scheduled backup is off until an operator turns it on             | `default(false)` → `default(true)`                            | `config.test.ts` › defaults the scheduled backup OFF and its work directory off /tmp                    | KILLED |
| B30 | The dump excludes nothing, `processed_messages` included              | add `--exclude-table=processed_messages`                      | `backup.test.ts` › produces an archive the operator restore path turns back into a database             | KILLED |
| B32 | The dump is PostgreSQL's custom format                                | `--format=custom` → `--format=plain`                          | `backup.test.ts` › dumps, checksums, encrypts, restores into a scratch database and delivers            | KILLED |
| B33 | The ENCRYPTED archive is what is delivered                            | deliver `dump.pgcustom` instead of `archive.nxb`              | `backup.test.ts` › delivers ciphertext, never the plaintext dump                                        | KILLED |

## Rules that needed TWO reverts, because two mechanisms enforce them

| #       | Rule                                                                           | Mutation                                                                                  | Named test                                                                                    | Result           |
| ------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| B10+B13 | The archive header is bound, so an edited header is refused rather than obeyed | remove the payload AAD on both sides AND strip `backupId`/`keyId` from the key-unwrap AAD | `backup-archive.test.ts` › refuses an edited header rather than decrypting under it           | KILLED (2 tests) |
| B21     | A write naming the wrong lease owner changes nothing                           | drop `eq(leaseOwner)` from `finish`'s predicate                                           | `backup.test.ts` › refuses a write naming the wrong lease owner even while the run is RUNNING | KILLED           |

B10 and B13 each survived ALONE, and the reason is worth stating: the payload
AAD and the key-unwrap AAD are redundant with each other, so removing either
leaves the other protecting the header. The falsifiable claim is therefore "the
header is bound", not "the AAD binds it" — and the docblock in `archive.ts` was
corrected to say so, because it had claimed the stronger thing.

B21 survived alone for a different reason: `state = 'RUNNING'` in the same
predicate already rejects a late write from a reclaimed run, because reclaiming
sets `FAILED`. The lease guard's own contribution is only visible while the run
is genuinely still RUNNING and only the owner is wrong, which is the case the
new test constructs.

## Rules reverted in the DATABASE, not in the source

| #   | Rule                                                     | Mutation                                                                                        | Named test                                                                             | Result |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| B24 | The installation's backup lock is a partial unique index | `DROP INDEX backup_runs_single_active_idx` on the live test database, then recreate it verbatim | `backup.test.ts` › lets exactly one of several concurrent starts hold the installation | KILLED |

Mutating `schema.ts` does NOT falsify this, and the first attempt to do so
reported SURVIVED: the schema file is the Drizzle model, and the constraint that
actually rejects a second `RUNNING` row comes from the applied migration. The
index was dropped from the running database and recreated from
`pg_indexes.indexdef`, which was compared before and after.

## Rules that could not be falsified, and why

Stated rather than omitted. Each of these is real code that runs; none of them
has a test that fails when it is removed, and the honest reading is that each is
defence in depth behind a rule that IS tested.

| #   | Rule                                                                              | Why it could not fail                                                                                                                                                                                                         | What it is now                                                                                                  |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B12 | `readArchiveHeader` refuses a file too short to hold its own tag                  | A file that short also fails authentication a moment later, so the truncation tests stay red either way                                                                                                                       | Kept: an early, specific refusal beats a generic authentication failure for an operator reading the message     |
| B15 | `openArchive` refuses an archive whose manifest and header name different backups | `sealArchive` derives the header's id from the manifest, so this installation cannot produce one; an archive that authenticates is one we wrote                                                                               | Kept, with the docblock now saying it is unreachable today and naming what makes it reachable — a second writer |
| B31 | `pg_restore --exit-on-error` during verification                                  | The sabotaged archive fails at the header, so `pg_restore` exits non-zero with or without the flag; a partially-restorable dump is what would separate them, and constructing one reliably is not something this suite can do | Kept: the tested backstop is the table count, which is what actually makes "restored nothing" a failure         |
| B29 | Verification decrypts to a second path, not over the dump                         | The decrypted bytes are compared against a checksum taken before encryption, so a wrong decrypt is caught wherever it lands                                                                                                   | Kept as hygiene, and the comment claiming it prevented a tautological verification was CORRECTED — it did not   |

## The operator's commands, added after the audit found no test for them

These rows exist because the commit that added the CLI cited seven manually-run
command outcomes in its message and committed no test — the exact thing
`CLAUDE.md` forbids. Writing them exposed two real defects rather than just
filling a gap, both fixed in the same commit: the argument requirements were
checked after the container was built, so a missing `--target` needed a database
connection to be refused; and `verify` called `loadConfig()`, so the one command
meant to work when the database is broken demanded a `DATABASE_URL` it never
uses.

| #   | Rule                                                                      | Mutation                                               | Named test                                                                                | Result |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------ |
| B34 | A restore with no `--target` is refused, and says why there is no default | the guard → `if (false)`                               | `backup-cli.test.ts` › refuses a restore with no target, and says why there is no default | KILLED |
| B35 | A restore or a verify with no `--archive` is refused                      | the guard → `if (false)`                               | `backup-cli.test.ts` › refuses a restore or a verify with no archive                      | KILLED |
| B36 | A flag whose value is another flag is refused                             | drop the `next.startsWith('--')` half of the predicate | `backup-cli.test.ts` › refuses a flag whose value is another flag                         | KILLED |

## The harness ate an uncommitted refactor, and now refuses to

Recorded because it is the sharpest lesson of this phase and it is about the
tooling rather than the product.

`scripts/falsify.sh` restores with `git checkout --`, which restores the file
**as committed**. Run against a file with uncommitted edits, it therefore
deletes them — silently, and while reporting KILLED. It did exactly that to an
unfinished refactor of `backup.cli.ts` mid-session, and the only reason it was
noticed is that a later `grep` found the old code back where the new code had
been.

A harness whose failure mode is deleting the author's work has to refuse rather
than warn, so it now checks `git diff` and `git ls-files` on the target before
mutating anything and exits `SETUP-FAILED` on a dirty or untracked file. Proven
by appending a line to a tracked source file and watching the run refuse:

```
GUARD  SETUP-FAILED: apps/api/src/backup.cli.ts has uncommitted changes; commit or stash them first
```

## Method notes

Two lessons, both earned here.

**A fixture can make two rules indistinguishable.** B01 first survived because
the verification-failure fixture used `tableCount: 0`, so the empty-restore rule
killed the mutation instead. A partial `pg_restore --exit-on-error` really does
leave tables behind, so the fixture now uses a non-zero count and each rule has
its own row.

**A loose assertion is a rule with no test.** B13 and B23 both survived against
`toThrowError(/authenticat|readable format/i)` and `toMatchObject({ code })`
respectively, because a second mechanism produced a refusal that matched. Both
tests now pin the exact refusal — per header field, and by message for the
live-target guard — so each names one mechanism.
