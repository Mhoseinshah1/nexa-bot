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

## Rules asserted by a mechanism rather than by a mutation

Stated here rather than left out, because "not in the table" reads as "not
checked" and two of these are load-bearing.

| Rule                                                     | What holds it                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Neither Telegram call may run inside a transaction       | `assertOutsideTransaction` in the shared call core, plus `currentTransactionLabel()` asserted inside both test fakes    |
| A surface may not reach the bootstrap                    | `scripts/check-boundaries.sh` — its own check, separate from the owner bootstrap's, so a failure names which one leaked |
| The repository cannot write a token onto an existing row | `BotBootstrapRepository` declares no such method; the capability does not exist to be called                            |
| `telegram_bot_id` is filled but never rewritten          | `isNull(botInstances.telegramBotId)` in the UPDATE's WHERE, not a caller-side check                                     |
