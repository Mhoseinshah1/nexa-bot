# Telegram fresh-install bootstrap — falsification record

Every production rule this branch adds, reverted one at a time against the
working tree, with the test that dies named. A rule with no test is a rule that
will be silently reverted; a claim about testing that leaves no test behind is
worse than no claim.

The harness is `scripts/falsify.sh`, and every row below was produced by running
it — label, file, the exact text replaced, the replacement, the test file, the
vitest project. It refuses a file with uncommitted changes, restores by
`git checkout --`, and fails the run if the tree is not byte-identical
afterwards.

## What this round found

**Two rules had no test, and both were found by the mutation pass rather than by
reading.** Neither was visible in review: the code reads correctly, the comments
state the rule, and the suite was green.

- **B13.** Replacing `resolveToken(scope, view.id)` with
  `input.token ?? resolveToken(...)` changed nothing any test could observe. The
  service's own comment claims the token always comes from the ROW — so a rerun
  handed a token for the same bot with a different secret would have been used
  to register the webhook, while the comment said otherwise and the suite
  agreed. `registers with the STORED token, not one handed to the rerun` now
  asserts which token reached `setWebhook`.
- **B14.** Reversing the exclusive lock and the activity check inside the create
  transaction was invisible because the fake had no notion of order. The
  deadlock it prevents is a Postgres property — two transactions that both take
  the SHARE lock `scopeIsActive` takes and then try to upgrade — and no unit test
  can demonstrate that. The ORDER, though, is this service's to get right, so
  the activity fake now asserts the exclusive lock is already held.

**The review round found what the mutation pass could not.** Twenty rules were
KILLED before it ran, and the suite was green, and the feature would still have
failed on every fresh install: the webhook secret was minted in an alphabet
Telegram refuses. A mutation pass proves that the rules you wrote down are
tested; it cannot tell you that a rule you did not write down is wrong. The eight
rows below exist because the review supplied those rules and this then proved
them.

**One mutation was thrown away rather than recorded.** An early B13 attempt
substituted a call to a function that does not exist. It reported KILLED, and
the kill was the TypeScript error, not a test. A compile failure satisfies this
harness exactly the way a real kill does, which makes it the one result here
that has to be read rather than counted.

## The rules

| #   | Rule                                                                      | Mutation                                                                 | Test that dies                                                                                   | Result |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ |
| B01 | A rerun whose webhook is already registered here registers NOTHING        | the already-complete guard → `if (false)`                                | `bot-bootstrap.test.ts` › does nothing at all when Telegram is already pointed here              | KILLED |
| B02 | A token for a DIFFERENT bot is refused, not ignored                       | `refuseRepointing`'s early return → `if (true) return;`                  | `bot-bootstrap.test.ts` › refuses a token for a different bot instead of repointing              | KILLED |
| B03 | A webhook is not registered without a usable secret                       | `secret.length < 16` → `secret.length < 0`                               | `bot-bootstrap.test.ts` › refuses to register a webhook without a usable secret                  | KILLED |
| B04 | The webhook origin must be https                                          | `protocol !== 'https:'` → `protocol === 'nope:'`                         | `bot-bootstrap.test.ts` › refuses an origin Telegram could never deliver to, before any call     | KILLED |
| B05 | The webhook origin carries no path, query or fragment                     | the path/search/hash guard → `if (false)`                                | `bot-bootstrap.test.ts` › refuses an origin Telegram could never deliver to, before any call     | KILLED |
| B06 | The create path RE-READS under the lock, so the race loser reconciles     | `if (raced !== null)` → `if (raced !== null && false)`                   | `bot-bootstrap.test.ts` › makes the loser reconcile the winner’s row rather than create a second | KILLED |
| B07 | A stored token that now names another bot is refused                      | the `telegramBotId !== identity.botId` throw → `if (false)`              | `bot-bootstrap.test.ts` › refuses when the stored token has come to belong to another bot        | KILLED |
| B08 | Every rerun asks Telegram whether the stored token still works            | the reconcile `getMe` → the row's own stored identity                    | `bot-bootstrap.test.ts` › still asks Telegram whether the stored token works                     | KILLED |
| B09 | A failed registration FAILS the run; it does not report success           | `throw this.webhookFailure(registered)` → return RECONCILED              | `bot-bootstrap.test.ts` › keeps the row and the token, and still fails the run                   | KILLED |
| B10 | `getMe` establishes the identity; nothing is derived from the typed token | the create-path `getMe` → the token's own id half and a literal username | `bot-bootstrap.test.ts` › validates the token with getMe BEFORE it writes anything               | KILLED |
| B11 | `status` normalises the origin the same way `execute` does                | drop `requireOrigin` from `status`                                       | `bot-bootstrap.test.ts` › treats a trailing slash as the same origin                             | KILLED |
| B12 | A token that is not shaped like one is refused before Telegram is asked   | the four-part shape check → `token === ''`                               | `bot-bootstrap.test.ts` › refuses a token that is not shaped like one, without asking Telegram   | KILLED |
| B13 | The token registered with comes from the ROW, never from the input        | `resolveToken(...)` → `input.token ?? resolveToken(...)`                 | `bot-bootstrap.test.ts` › registers with the STORED token, not one handed to the rerun           | KILLED |
| B14 | The exclusive lock is taken BEFORE the activity check, never after        | swap the two calls in the create transaction                             | `bot-bootstrap.test.ts` › creates the bot, registers the webhook, and marks it afterwards        | KILLED |

## The installer

The installer is shell, which `scripts/falsify.sh` does not reach, so each of
these was applied by hand and each restore confirmed with `git diff --exit-code`.

| #   | Rule                                                          | Mutation                                                     | Test that dies                                                                                        | Result |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ |
| B15 | A webhook failure does not abort the install                  | the `TELEGRAM_INCOMPLETE` branch → `nexa_die`                | `botctl.test.sh` › a webhook failure does not report a successful install, and does not undo anything | KILLED |
| B16 | ...and does not report success either                         | drop the `TELEGRAM_INCOMPLETE="yes"` assignment              | `botctl.test.sh` › a webhook failure does not report a successful install, and does not undo anything | KILLED |
| B17 | An unreadable Telegram state is refused, never guessed        | the `*)` arm → `state="none"`                                | `botctl.test.sh` › an unreadable Telegram state is refused rather than guessed                        | KILLED |
| B18 | `--skip-telegram` on a configured bot says so, not "run this" | drop the `ready` branch from the skip arm                    | `botctl.test.sh` › skip-telegram does not tell a configured installation to configure itself          | KILLED |
| B19 | A rerun never regenerates the webhook secret                  | drop the `have_secret` guard from `ensure_telegram_config`   | `botctl.test.sh` › a rerun never regenerates the webhook secret                                       | KILLED |
| B20 | The webhook secret never reaches a process argument list      | pass it as a positional argument to the substituting python3 | `botctl.test.sh` › the installer never puts a secret into a process argument list                     | KILLED |

## The review round

Eight rules the adversarial review produced, falsified the same way. Two of them
— B21 and B27 — are the CRITICAL and one HIGH finding, so these two rows are the
evidence that those defects cannot come back silently.

| #   | Rule                                                              | Mutation                                                      | Test that dies                                                                                        | Result |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| B21 | The webhook secret is minted in Telegram's alphabet, not base64's | `random_webhook_secret` → plain `base64 -w0`                  | `deployment-config.test.ts` › mints a webhook secret Telegram will actually accept                    | KILLED |
| B22 | ...and the schema refuses one that is not, at boot                | the charset predicate → `false`                               | `deployment-config.test.ts` › mints a webhook secret Telegram will actually accept                    | KILLED |
| B23 | A registration is current only if the SECRET matches too          | the fingerprint comparison → `return true`                    | `bot-bootstrap.test.ts` › re-registers when the webhook SECRET has been rotated                       | KILLED |
| B24 | Queued updates are discarded on a create and NEVER on a reconcile | `dropPendingUpdates: ensured.createdNow` → `true`             | `bot-bootstrap.test.ts` › discards queued updates on a first registration and NEVER on a reconcile    | KILLED |
| B25 | A bot an operator stopped is not `ready`                          | the `status !== 'ACTIVE'` guard → `if (false)`                | `bot-bootstrap.test.ts` › refuses a STOPPED bot rather than registering a webhook nothing will answer | KILLED |
| B26 | Every write path refuses a scope that has stopped accepting work  | `requireActiveScope` → an unconditional early return          | `bot-bootstrap.test.ts` › refuses a scope that has stopped accepting work, inside the transaction     | KILLED |
| B27 | A rerun of a READY installation still asks the application        | restore the `ready` short-circuit in `configure_telegram_bot` | `botctl.test.sh` › a rerun of a READY installation still asks the application                         | KILLED |
| B28 | An identity write is audited only if it changed a row             | `if (!filled) return;` → `if (false) return;`                 | `bot-bootstrap.test.ts` › does not audit an identity write that changed no row                        | KILLED |

## The Codex round

Eight findings from an independent review of the pushed head. Every one was
real, and four of them were states in which something claimed success that had
not happened — the same class the self-review round found, reached from
different directions.

One of the fixes SURVIVED its own mutation and had to be made testable first:
gutting `suppliedToken` left the suite green, because the CLI's tests covered
`parseArgs` and `tokenFromFile` while the rule lived in `main`, which needs a
database. The decision is now a pure function with the prompt injected, and C2
below is the two halves of it.

| #   | Rule                                                                  | Mutation                                                         | Test that dies                                                                                  | Result |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| C1  | The token is STREAMED to the container, never bind-mounted            | restore the `-v` mount and `--bot-token-file`                    | `botctl.test.sh` › the token never reaches the bootstrap CLI as an argument                     | KILLED |
| C2  | A supplied token is READ whatever the state                           | `suppliedToken` → `return null`                                  | `bootstrap-bot-cli.test.ts` › reads a supplied file, and reports none when nothing was supplied | KILLED |
| C2b | ...and used rather than prompted over                                 | drop the `supplied !== null` arm of `tokenForRun`                | `bootstrap-bot-cli.test.ts` › never prompts when a token was supplied, whatever the state       | KILLED |
| C3  | Readiness requires the webhook ROUTE to be served                     | the `webhookEnabled()` guard → `if (false)`                      | `bot-bootstrap.test.ts` › is NOT ready when this installation does not serve the webhook route  | KILLED |
| C4  | Readiness requires the TENANT to be accepting work                    | the `scopeIsActive` guard → `if (false)`                         | `bot-bootstrap.test.ts` › is NOT ready when the TENANT has stopped accepting work               | KILLED |
| C5  | A failure that stored nothing is not told it can resume               | `TELEGRAM_RETRY="$(telegram_state)"` → a hard-coded `incomplete` | `botctl.test.sh` › a FIRST-attempt failure does not claim a stored token                        | KILLED |
| C6  | `--skip-telegram` on a fresh install names a remedy that can work     | fold `none` back into the `botctl telegram register` arm         | `botctl.test.sh` › skip-telegram does not tell a configured installation to configure itself    | KILLED |
| C7  | `botctl telegram register` takes the installation's exclusive lock    | drop `nexa_acquire_lock 0`                                       | `botctl.test.sh` › telegram register takes the deployment lock                                  | KILLED |
| C8  | A first configuration with no terminal and no token source is refused | the `[ ! -t 0 ]` refusal → `:`                                   | `botctl.test.sh` › a first configuration with no terminal and no token source is refused        | KILLED |
| C8b | ...and a RECONCILE without one is NOT, because none is needed         | (covered by the same fix; the two halves are separate cases)     | `botctl.test.sh` › a RECONCILE with no terminal and no token source is NOT refused              | KILLED |

## The second Codex round

Three findings on the pushed head, all real, and all three were the SAME defect
class reached from a new direction: something claiming a state it was not in.
Two of them are the states the first round's fixes did not cover — which is the
pattern `CLAUDE.md` records about reviewing a fix as hard as the bug.

| #   | Rule                                                              | Mutation                                                    | Test that dies                                                                                  | Result                |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| D1  | Only callers that take the deployment lock run the compiled CLI   | restore `bot:bootstrap` to `apps/api/package.json`          | `bootstrap-callers.test.ts` › does not expose the compiled CLI as a package script              | KILLED                |
| D1b | ...and the allow list holding that rule cannot be widened quietly | add `apps/api/package.json` to the check's `grep -vxF` list | `bootstrap-callers.test.ts` › agrees with the allow list the build actually enforces            | KILLED                |
| D2  | An `unavailable` installation still runs the CLI                  | restore the early `return 0`                                | `botctl.test.sh` › an unavailable bot still runs the CLI, and a supplied token still reaches it | KILLED                |
| D3  | The CLI's error CODE refines what the state cannot say            | drop the `case "$out"` refinement                           | `botctl.test.sh` › the installer no longer classifies a failure from captured CLI output        | SUPERSEDED, see below |
| D3b | ...but `none` outranks it, because nothing was stored             | `[ "$TELEGRAM_RETRY" != "none" ]` → `true`                  | `botctl.test.sh` › a first attempt that stored nothing outranks the error code                  | KILLED                |
| D3c | Capturing the CLI's output is not the same as swallowing it       | drop the `printf '%s\n' "$out" >&2` echo                    | `botctl.test.sh` › the CLI error reaches the operator, whatever the state                       | KILLED                |

D1 is the one worth reading twice. The service's comment asserted "there is no
third caller" and `apps/api/package.json` had been exposing one — the COMPILED
CLI, on a host holding the production database and secrets, taking no lock at
all. The claim was checkable and had never been checked, so it read as a
guarantee for as long as it was false. It is now `check-boundaries.sh`, and
`bootstrap-callers.test.ts` reads that script's allow list rather than restating
it, so widening the list without moving the expectation fails too.

What D1 does NOT do is close the race. Serialization across a network call needs
a lock this application cannot take — a database advisory lock would be held
while the marker transaction takes a second connection from the same pool, and
`DATABASE_POOL_MAX` may be 1, which is a deadlock this codebase has reproduced
twice. `docs/open-questions.md` OQ-TG-03 carries the residual rather than a
comment implying it is gone.

## The third Codex round

Six findings, all real, and the first two are the round before this one: the
summary added for a revoked token recommended a procedure that cannot work, and
the classifier that was supposed to make the summaries exhaustive left out every
failure that happens before Telegram is reached at all. `CLAUDE.md` says to
review a fix as hard as the bug; this is what that looks like when it is not
done.

| #   | Rule                                                             | Mutation                                                      | Test that dies                                                                                             | Result |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| E1  | The revoked-token summary invents no rotation this release lacks | restore "reissuing ... is the supported route"                | `bot-bootstrap.test.ts` › still says a STORED token has no supported replacement in this release           | KILLED |
| E2  | The additive Telegram config is written by rename, not by append | write straight to `$app_env` instead of a temp file           | `botctl.test.sh` › the additive Telegram configuration is written by rename, not by append                 | KILLED |
| E3  | One Telegram bot binds to one row, cross-tenant                  | point `isUniqueViolation` at an index that does not exist     | `bot-bootstrap-identity.test.ts` › refuses a second tenant binding the same bot, even under a new username | KILLED |
| E3b | ...and the INDEX is what holds it, not the mapping               | `DROP INDEX bot_instances_telegram_bot_id_key` in `nexa_test` | `bot-bootstrap-identity.test.ts` › refuses a second tenant binding the same bot, even under a new username | KILLED |
| E4  | An unrecognised CLI argument is refused, not ignored             | accept every argument the parser does not recognise           | `bootstrap-bot-cli.test.ts` › refuses an unknown flag rather than ignoring it                              | KILLED |
| E5  | A directory is refused as a token file, in PREFLIGHT             | remove the `-f` check                                         | `botctl.test.sh` › a DIRECTORY as --bot-token-file is refused before the host is changed                   | KILLED |
| E6  | A stored token that cannot be DECRYPTED is its own outcome       | match a code no error produces                                | `telegram-bootstrap-remedy.test.ts` › explains every secrets code a stored token can fail with             | KILLED |

E3b is the only mutation in this record made against a database rather than a
file, and it is the one that matters: the mapping E3 kills is how the rule
reaches an operator, and the index is the rule. Dropping it in `nexa_test` let
the second tenant's insert succeed, which is the defect exactly — two rows for
one bot, Telegram's single webhook moved to the second, and the first still
reporting `ready`. It was restored and the suite re-run green.

E1 is the one to read twice. It was written in the round before this one, in the
same commit as the mechanism that classifies failures correctly, and it told the
operator to do something the code three files away makes impossible — with the
true statement immediately above it. Nothing in the gate could have caught it:
every test passed, the summary was reachable, and the sentence was simply false.

## The fourth Codex round

Nine findings, all real, and **five of them are a fix from an earlier round that
covered one path and not its sibling**. That is the pattern, and it is the rule
`CLAUDE.md` already states — a fix is reviewed as hard as the bug — missed five
separate times in a row.

| #   | Rule                                                         | Mutation                                               | Test that dies                                                                                             | Result                |
| --- | ------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| F1  | An already-bound refusal outranks the `none` rule            | drop the `already-bound` arm of the classifier         | `botctl.test.sh` › the installer no longer classifies a failure from captured CLI output                   | SUPERSEDED, see below |
| F2  | Duplicate bot ids are refused BEFORE 0041 runs               | drop the preflight call                                | `migration-preflight.test.ts` › refuses a database where one Telegram bot is bound twice, before 0041 runs | KILLED                |
| F3  | A `botctl telegram` subcommand refuses an argument           | remove the refusal                                     | `botctl.test.sh` › telegram subcommands refuse an argument rather than dropping it                         | KILLED                |
| F4  | An `unavailable` skipped bot is not sent to `register` alone | make the `unavailable` arm unreachable                 | `botctl.test.sh` › skip-telegram does not prescribe registration for an UNAVAILABLE bot                    | KILLED                |
| F5  | A legacy row still refuses a token naming a different bot    | drop the second `refuseRepointing`                     | `bot-bootstrap.test.ts` › refuses a different bot on a row that predates the identity column               | KILLED                |
| F6  | BOTH writers of `telegram_bot_id` name the collision         | rethrow raw from `recordTelegramIdentity`              | `bot-bootstrap-identity.test.ts` › names the collision when a LEGACY row learns an id another row holds    | KILLED                |
| F7  | A missing token records the release instead of dying         | restore the `nexa_die`                                 | `botctl.test.sh` › a first install with no terminal and no token records its release                       | KILLED                |
| F8  | The decryption summary names each code, not one repair       | restore "restoring the key material makes it readable" | `telegram-bootstrap-remedy.test.ts` › gives each of the four a DIFFERENT sentence                          | KILLED, re-run in 4I  |
| F9  | The rejected-token MESSAGE invents no recovery either        | restore "restore it in BotFather"                      | `bot-bootstrap.test.ts` › validates the token with getMe BEFORE it writes anything                         | KILLED                |

F8 was re-run in Phase 4I and cites a different test than it did when it was
written. The one it named — "does not promise key material fixes the two it
cannot fix" — was RENAMED, because the Codex review of PR 31 established that the
claim was true of only ONE of those two codes: restoring key material is exactly
the recovery when `SECRET_AUTH_FAILED` comes from a right key id holding wrong
material. F8's rule is unchanged — four codes, four sentences, not one repair —
and collapsing them to one repair still kills four tests, of which "gives each of
the four a DIFFERENT sentence" is the one that pins the rule as stated. Re-run
here rather than left pointing at a name that no longer exists, which
`check:citations` would have caught anyway and did.

F9 is E1 again, one layer down: the installer summary was corrected and the CLI
error printed immediately before it still told the operator to restore a revoked
token in BotFather. Two messages, one fixed, the other contradicting it — and the
fix for the first was written without reading the second.

F1 is the most interesting. D3b established that `none` outranks the error code,
and that rule was falsified and correct — for the failures that existed when it
was written. An already-bound refusal rolls its insert back, so its state is
NECESSARILY `none`, and the rule then routed it to a summary naming the wrong
cause and a retry that would refuse for ever. A correct rule met a case it was
not written against, which is not the same defect as a wrong rule and needs the
same watching.

## The diagnosability round

Not a rule about the product — a rule about the test that guards it. The
Telegram bootstrap step failed in CI twice, and both failures named a log file
inside the directory the EXIT trap removes. Two different defects therefore
arrived as the same opaque line, and the second was diagnosed by reasoning about
the release image's uid rather than by reading what the container said.

These four are mutated the same way everything else here is, because a
diagnostic that silently stops working is indistinguishable from one that was
never needed.

| #   | Rule                                                            | Mutation                                               | Test that dies                                                                                         | Result |
| --- | --------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| S1  | `dump_log` redacts the bot token out of a log it dumps          | the redacting `sed` → a plain `tail`                   | `deployment-smoke-diagnostics.test.ts` › redacts the bot token out of a log it has not yet proved safe | KILLED |
| S2  | ...and survives the failures that run before a token is written | drop the `:-` default on `SMOKE_BOT_TOKEN`             | `deployment-smoke-diagnostics.test.ts` › prints the log when no token has been written yet             | KILLED |
| S3  | A log that does not exist is reported, not an abort in `fail`   | remove the missing-file arm                            | `deployment-smoke-diagnostics.test.ts` › says so when the log it was asked for does not exist          | KILLED |
| S4  | A failure never names a log path instead of dumping it          | restore one `fail "... (see ${telegram_log})"` message | `deployment-smoke-diagnostics.test.ts` › never names a log file it does not also dump                  | KILLED |

S1's ordering is the reason it is a rule and not a nicety: the outcome assertion
dumps the log, and the assertion that the CLI never printed the token runs after
it. Without the redaction, the diagnostic for one failure would publish the
credential the next assertion exists to catch. The one failure whose log is
KNOWN to contain the token is deliberately not dumped at all.

## Rules asserted by a mechanism rather than by a mutation

Stated here rather than left out, because "not in the table" reads as "not
checked" and two of these are load-bearing.

| Rule                                                     | What holds it                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Neither Telegram call may run inside a transaction       | `assertOutsideTransaction` in the shared call core, plus `currentTransactionLabel()` asserted inside both test fakes    |
| A surface may not reach the bootstrap                    | `scripts/check-boundaries.sh` — its own check, separate from the owner bootstrap's, so a failure names which one leaked |
| The repository cannot write a token onto an existing row | `BotBootstrapRepository` declares no such method; the capability does not exist to be called                            |
| `telegram_bot_id` is filled but never rewritten          | `isNull(botInstances.telegramBotId)` in the UPDATE's WHERE, not a caller-side check                                     |
| The bot token never reaches an audit payload             | asserted over the WHOLE entry — an earlier fake discarded `before` and `reason` before the assertion ran                |
| The installer never passes a token through argv or env   | `botctl.test.sh` reads the whole `configure_telegram_bot` body, not four lines forward from `cli.js`                    |

## What Phase 4I did to six of these rows

Four rules moved and two were DELETED on purpose. Neither is a reason to remove a
row: the mutations were run and the rules were real when they were written, and a
record that quietly drops what a later phase changed its mind about is worth less
than one that says so.

**Re-pointed, because the rule survived and its test moved:**

- **D3c** — "capturing the CLI's output is not the same as swallowing it" matters
  MORE after 4I, not less: that output is now the only thing carrying the cause.
  Its new test asserts it for five different error codes.
- **E1** — "the revoked-token summary invents no rotation this release lacks" was
  a rule about installer prose. The prose is gone and the rule is now in the
  SERVICE message, where `getMe` branches on whether anything is stored — so the
  sentence appears on a rerun, where it is true, and not on a first bootstrap,
  where it never was.
- **E6, F8** — see below.

**SUPERSEDED, because 4I removed the mechanism they protected:**

- **D3** — "the CLI's error CODE refines what the state cannot say", and
- **F1** — "an already-bound refusal outranks the `none` rule".

Both describe the `case "$out"` classifier, and `OQ-TG-04` is the record of what
it cost: it reads output the interactive path deliberately does not capture, so
on a first install at a terminal none of its arms could run, and nine
operator-facing sentences were false in a state reachable with them. F1 is itself
an exception bolted onto D3 after D3's rule got a case wrong — which is the shape
that stopped rather than a rule to keep.

Their citations now point at the test that pins the classifier's ABSENCE. That is
the honest successor: the rule these rows protected was replaced, and the
replacement is checked.

## Where E6 and F8 live now (Phase 4I)

Both rows were verified as written, and the RULES they name survive. Their tests
did not: `OQ-TG-04` moved the decryption explanation out of `deploy/install.sh`,
where it was selected by grepping the CLI's captured output — a selection that
cannot run on the interactive path at all — and into `bootstrapRemedy`, which is
keyed on the error code in the process that raised it.

So the citations are re-pointed rather than deleted, and the mutations still
kill:

- **E6** — "a stored token that cannot be DECRYPTED is its own outcome" is now
  held by the remedy table answering for all four `platform.secret_*` codes
  instead of by an installer arm that classified one of them.
- **F8** — "the decryption summary names each code, not one repair" is now four
  distinct sentences, two of which say restoring key material does NOT fix them.

The row text is left exactly as it was written. A falsification record that
quietly rewrites its own history is worth less than one that says where a rule
moved and why.
