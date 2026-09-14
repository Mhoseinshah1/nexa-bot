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
