# Phase 4I falsification

Every production rule this phase changes, mutated back and run against the
committed suite. A rule whose mutation leaves the suite green is a rule the suite
cannot see, and `CLAUDE.md` is explicit about what that costs: _"A rule with no
test is a rule that will be silently reverted."_

Mutations that SURVIVE are recorded here as such, with what was done about them.
So is a mutation another rule rejects first — an honest KILLED names the test that
failed, not a red suite.

## `OQ-TG-04` items 6 and 7 — an API base that is not Telegram

| #      | Rule                                                                             | Mutation                                                                             | Named test                                                                                                    | Result |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| F4I-01 | the bootstrap gateway splits `FAILED_PERMANENT` on the transport's `errorCode`   | collapsed back to `return { outcome: 'REJECTED', detail: outcome.errorMessage }`     | `telegram-bootstrap-gateway.test.ts` › reports an API base that is not Telegram as NOT_TELEGRAM, not REJECTED | KILLED |
| F4I-02 | `getMe` refuses a `NOT_TELEGRAM` probe with its own code, not as an upstream one | the whole `if (probe.outcome === 'NOT_TELEGRAM')` block deleted, so it falls through | `bot-bootstrap.test.ts` › reports a configured API base that is not Telegram as its own failure               | KILLED |

Each mutation killed **two** tests; the table cites one apiece. The others are
`telegram-bootstrap-gateway.test.ts` › reports a 2xx whose id is not a number as
NOT_TELEGRAM, and `bot-bootstrap.test.ts` › does not send the operator to
BotFather for a misconfigured API base.

### What F4I-01 also proved, and why the gateway got a test file of its own

Under the F4I-01 mutation, **every test in `bot-bootstrap.test.ts` still passed.**
44 tests ran across the two files; both failures were in the new gateway file.

That is not incidental, and it is the reason two mutations are recorded for what
reads like one fix. `bot-bootstrap.test.ts` injects a `BotIdentityProbe` through a
fake `BotBootstrapTelegram`, so it asserts what the SERVICE does with an outcome
it is handed — which is equally true of the version that had the defect, because
the defect was never in the service. It was in the one line that decides which
outcome to hand over, and nothing in this repository stubbed `fetch` beneath that
line before this phase.

So F4I-02 falsifies the service's decision and F4I-01 the adapter's translation,
and the finding lived entirely in the second. A phase that had added only the
service test would have published a table with a KILLED row above a defect that
was still reachable — which is the shape this whole document exists to refuse.

## `OQ-TG-04` item 8 — a URL Telegram refused is not a registration to retry

| #      | Rule                                                                      | Mutation                                                                           | Named test                                                                                               | Result |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| F4I-03 | `webhookFailure` gives `REFUSED` its own code AND its own remedy sentence | restored to one `detail` and `TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED` for both outcomes | `bot-bootstrap.test.ts` › reports a URL Telegram refused separately from one it could not be asked about | KILLED |

The companion that also died is `bot-bootstrap.test.ts` › does not tell an
operator to rerun a registration that would be refused again, and it is the one
that matters: a fix that split the CODE and left both messages saying "rerun the
installer to retry the registration" would satisfy the first test and change
nothing an operator reads. The mutation above is written that way on purpose — it
keeps the shared sentence — and both tests fail under it.

## `OQ-TG-04` item 10 — a stale username collision is not a bot bound twice

| #      | Rule                                                                            | Mutation                                                       | Named test                                                                                         | Result |
| ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| F4I-04 | `rethrowAlreadyBound` translates `bot_instances_username_key` in its OWN branch | the entire `isUniqueViolation(…'username_key')` branch deleted | `bot-bootstrap-identity.test.ts` › names a stale username collision instead of leaking a raw 23505 | KILLED |

Against a real database, because the rule is a unique index and a fake repository
would assert the fake. The test also pins the half a WIDER first branch would get
wrong — `rejects.not.toThrowError(/already configured for another tenant/)` —
because widening the bot-id branch to catch both constraints passes a test that
only checks something was refused, and gives the operator the confident wrong
answer `rethrowAlreadyBound`'s own comment has warned about since before either
branch existed.

## `OQ-TG-04` items 1, 3 and 5 — three refusals that misdescribed the state they left

| #      | Rule                                                                                  | Mutation                                                                        | Named test                                                                                              | Result |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| F4I-05 | a rejected token on a FIRST bootstrap gets its own message, because nothing is stored | the `existing === null` branch deleted, leaving one message for both            | `bot-bootstrap.test.ts` › does not tell a FIRST bootstrap that a rejected token is unrecoverable        | KILLED |
| F4I-06 | `refuseRepointing` says so when a legacy identity fill committed before the refusal   | `filledLegacyIdentity` ignored, so the message is always "Nothing was changed." | `bot-bootstrap-identity.test.ts` › does not claim nothing changed after it filled a legacy identity     | KILLED |
| F4I-07 | the already-bound refusal names the remedy of the statement that raised it            | `source` ignored, so both paths get the fresh-INSERT remedy                     | `bot-bootstrap-identity.test.ts` › names the collision when a LEGACY row learns an id another row holds | KILLED |

### F4I-05 also failed a test that had pinned the defect

The second failure under F4I-05 is `bot-bootstrap.test.ts` › validates the token
with getMe BEFORE it writes anything — and it is the more interesting one,
because that test previously required the OPPOSITE:

```ts
expect(message).toMatch(/no supported recovery/);
expect(message).toMatch(/OQ-TG-01/);
```

on the FRESH-INSTALL path. Both are statements about a stored credential, and
that path has none. So the suite made the false sentence mandatory in the one
state where it is false, and a change that removed it — the correct change —
would have failed a green suite for being right. The assertions were moved to
`still says a STORED token has no supported replacement in this release`, where
they are true, and the fresh-install case now pins the sentence that belongs to
it. Recorded rather than quietly rewritten, because a test asserting a defect is
evidence about how the surrounding tests were written.

### Each of F4I-06 and F4I-07 leaves the OTHER side pinned

Both mutations are "ignore the parameter and print the old sentence", which a
test asserting only the new sentence would catch — and a fix that printed the NEW
sentence unconditionally would pass. So both cases have a companion asserting the
opposite state: `still says nothing changed when no fill happened`, and the
fresh-INSERT half of `refuses a second tenant binding the same bot, even under a
new username`, which now requires `Use a separate bot for this tenant` and
requires that `OQ-TG-01` is absent. A path-dependent message needs a test on each
path or it is one `if` away from being a constant again.

## `OQ-TG-04` items 9, 11 and 13 — what `status` knows and what it says

| #      | Rule                                                                      | Mutation                                                       | Named test                                                                                     | Result |
| ------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| F4I-08 | the scope-level causes are checked BEFORE the bot row is looked up        | the row lookup moved back in front of `unavailableScopeReason` | `bot-bootstrap.test.ts` › does not answer none for a stopped tenant that has no bot yet        | KILLED |
| F4I-09 | `statusWithReason` carries the cause, it does not recompute a word        | both `reason` values replaced with `null`                      | `bot-bootstrap.test.ts` › reports WHICH condition makes a bot unavailable, alongside the state | KILLED |
| F4I-10 | `docs/deployment.md` documents every value `BotBootstrapStatus` can print | `unavailable` removed from the documented line                 | `botctl.test.sh` › the documented telegram status contract names every value the CLI can print | KILLED |

**F4I-08 is a credential leak, not a wording bug**, and its mutation says so: it
also killed `does not answer none when this installation does not serve the
webhook route`and`reports WHICH condition makes a bot unavailable`. `none`is
the one state in which the installer PROMPTS for a bearer credential and sends it
to`getMe`; a stopped tenant with no bot row answered `none`, so the token left
the host before the create transaction refused.

The companion `still answers \`none\` for an ACTIVE tenant with no bot`is what
stops the fix from becoming "answer`unavailable` more often": a healthy fresh
install must still reach the path that asks for a token, or nothing can ever be
configured.

**F4I-10 runs against the DOCUMENT, and reads the union from the TYPE.** The
assertion loops over `BotBootstrapStatus`'s members rather than a list written
beside it, so a fifth value added and not documented fails the same way. The
mutation printed exactly one failure out of 264 deploy checks:

```
docs/deployment.md does not document the status value unavailable: [unavailable] not found in output
FAIL  1 of 264 checks failed
```

That is the shape item 13 needs: the section is a contract callers parse, and a
prose fix nothing checks would go stale again on the next value.

## The structural change — items 2, 4 and 12, and the surface they came from

| #      | Rule                                                                              | Mutation                                                                          | Named test                                                                                                     | Result |
| ------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| F4I-11 | the installer derives `TELEGRAM_RETRY` from the state read and from nothing else  | one `case "$out"` arm restored, setting `TELEGRAM_RETRY="token-rejected"`         | `botctl.test.sh` › the installer no longer classifies a failure from captured CLI output                       | KILLED |
| F4I-12 | the state-keyed summaries name no cause the installer cannot see                  | "the usual causes are DNS … or a certificate not yet issued" added to the summary | `botctl.test.sh` › the token-stored summary names no cause it cannot see                                       | KILLED |
| F4I-13 | `bootstrapRemedy` answers for the secrets codes and for no `telegram.bootstrap_*` | an entry added for `TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND`                         | `telegram-bootstrap-remedy.test.ts` › says nothing about an already-bound bot: one code, two opposite remedies | KILLED |

**F4I-11 also killed `a first attempt that stored nothing outranks the error
code`**, and that is the cleanest statement of what the old design cost. Under
the mutation the classifier overrode a `none` state, so an install that stored
nothing was told about a credential that does not exist — the defect `OQ-TG-04`
item 2 describes, reproduced by adding back one of the six arms.

**F4I-12 is the rule the collapse exists for, not a wording check.** The
forbidden strings are each a sentence one of the six deleted heredocs carried
—`BotFather`, `botctl secrets`, `DNS`, `certificate`, `Create a second bot` —
and every one was false in at least one state the summary was reachable in. The
loop asserts they are absent from a file that CANNOT know which failure occurred.

**F4I-13 is about a table that would look authoritative.** `bootstrapRemedy` is
keyed on an error code, and item 5 is one code covering two situations with
opposite remedies, so any entry for a `telegram.bootstrap_*` code would be the
installer's defect rebuilt one layer down — in TypeScript, where it would read as
deliberate. The test asserts the absences one at a time rather than as a loop,
because a loop lets a future entry be added by deleting one line from a list.

### What the collapse did NOT lose

`tests/deploy/botctl.test.sh` went from 264 checks to 262. The two that went were
assertions on the prose of heredocs that no longer exist; everything else they
protected has a new home, and three of the replacements assert the RULE rather
than a sentence:

- the CLI's error reaches the operator for five different codes, in a loop —
  which matters more now, because that output is the only thing carrying the
  cause;
- the same state with three different CLI errors produces the SAME summary, and a
  different state produces a different one, so the check cannot pass on a
  constant;
- `TELEGRAM_RETRY` is assigned exactly twice (its declaration and the state
  read), and none of the four inferred values appears anywhere in the file.

## `OQ-4H-02` — the command menu an upgraded installation never got

| #      | Rule                                                                                | Mutation                                                                 | Named test                                                                                             | Result |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| F4I-14 | the menu is reconciled on the ALREADY_COMPLETE path too, not only on a registration | the `reconcileCommands` call before the early return deleted             | `bot-bootstrap.test.ts` › registers a CHANGED command menu on an installation that is already complete | KILLED |
| F4I-15 | the digest is written ONLY when Telegram accepted the menu                          | the `if (registered)` guard removed, so the digest is written either way | `bot-bootstrap.test.ts` › does not record a revision the registration did not achieve                  | KILLED |
| F4I-16 | a NULL stored digest is UNKNOWN, never a match                                      | `stored === null` added to the skip condition                            | `bot-bootstrap.test.ts` › treats a NULL stored revision as unknown rather than as matching             | KILLED |

**F4I-14 is the defect itself.** Deleting one call reproduces `OQ-4H-02` exactly:
`setMyCommands` runs only on the register-and-mark path, `execute` returns
ALREADY_COMPLETE above it, and every installation whose webhook is already
current — which is every installation that upgrades — keeps whatever menu it had.

**F4I-15 is the fix's own worst failure mode.** A digest stored after a FAILED
`setMyCommands` makes the next reconcile skip the call, so the menu stays wrong
until the list changes again — the same silence this item is about, reintroduced
by its own repair. The test also asserts the next run tries again and succeeds.

**F4I-16 kills five**, including two that predate this phase, and that is the
useful part: `creates the bot, registers the webhook, and marks it afterwards`
and `completes the install when Telegram refuses the command menu` both fail,
because on a FRESH install the stored digest is NULL and the mutation makes the
menu never register at all. The pre-0059 row is the same shape, which is why
NULL has to mean unknown.

The companion that keeps the fix honest in the other direction is `does not
re-register an UNCHANGED menu on every rerun`: without it, the cheapest passing
implementation is to call `setMyCommands` unconditionally, which is an outbound
Telegram request on every `botctl update` of every installation for a menu that
has not moved.

## What the self-review of this phase's own diff found

Two defects, both in code 4I itself wrote, and one of them SURVIVED its first
mutation. Recorded here rather than folded silently into the work, because
CLAUDE.md is explicit that a fix is reviewed as hard as the bug and that the
interesting question is _"what does this fix now do that it did not do before,
and in which state is that wrong?"_

| #      | Rule                                                                       | Mutation                                                    | Named test                                                                                   | Result                             |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| F4I-17 | a stopped TENANT is reported before a stopped BOT                          | the scope-level check moved back after the row's own status | `bot-bootstrap.test.ts` › reports the tenant before the bot when BOTH are in the way         | KILLED                             |
| F4I-18 | the menu write takes the lock and re-reads activity INSIDE its transaction | both lines deleted                                          | `bot-bootstrap.test.ts` › refuses to record a menu revision for a scope that stopped mid-run | **SURVIVED at first**, then KILLED |

### F4I-17 — a precedence this phase moved and nothing pinned

Item 11's fix splits the three unavailability causes into a scope-level pair and
a row-level one, so `status` can consult the pair before looking for a bot at
all. That REORDERED them: webhook route, bot status, tenant activity became
webhook route, tenant activity, bot status.

Every existing test builds one cause at a time, so both orders passed
identically. The new order is the right one — a tenant that has stopped accepting
work makes its bot's own status moot, and naming the bot first sends an operator
to fix what is not in the way — but "right and untested" is how three successive
inversions of the readiness parser passed a green suite on the deployment branch.
Two tests now pin the full precedence.

### F4I-18 — the check was added by the review and had nothing asserting it

`reconcileCommands` is a WRITE, and its first version took neither the
bot-change lock nor the in-transaction activity re-read that CLAUDE.md names as a
non-negotiable: _"Every write path also reads `ScopeActivityReader` INSIDE its
transaction"_. The self-review caught it and added both.

**The first falsification of that addition survived.** Deleting the two lines
again left all 54 tests green, because a check added during a review has, by
construction, nothing asserting it — the suite was written against the version
without it. That is the same shape this document's F4I-01 note describes from the
other direction, and it is why the mutation was run at all rather than assumed.

Two tests followed. One drives the exact race the rule exists for, with a reader
that answers TRUE outside a transaction and FALSE inside — a constant `false`
would be caught by the readiness read long before this write and would prove
nothing. The other counts the lock, because the ordering (lock, then activity) is
what stops two writers deadlocking rather than queueing. Re-run afterwards, the
same mutation kills both.

The check is unreachable today — `execute` refuses an inactive tenant before it
can reach ALREADY_COMPLETE — and that is not an argument against it. The refusal
is one reordering away from moving, and this write is now reached by every
`botctl update` of every installation.

## What the one Codex review of PR 31 found

Five findings on `0cea848`, all real, and four of them in code this phase wrote.
Three are the same shape — a claim the code cannot support — which is the shape
this phase exists to remove, twice inside the module built to remove it.

| #      | Rule                                                                        | Mutation                                                                   | Named test                                                                                                       | Result |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| F4I-19 | botctl reads a booleanish setting with the vocabulary the schema accepts    | `nexa_boolean_word` narrowed to `true) printf 'on' ;; *) printf 'invalid'`  | botctl.test.sh › the booleanish vocabulary botctl reads is the one the schema accepts                             | KILLED |
| F4I-20 | the menu reconcile asks the state before it invokes the CLI                 | the `case "$state" in none \| unavailable` skip deleted                     | botctl.test.sh › the command menu is reconciled only where there is a menu to reconcile                           | KILLED |
| F4I-21 | a rollback reconciles the command menu too                                  | `telegram_reconcile_menu "${previous}"` deleted from `cmd_rollback`         | botctl.test.sh › a rollback reconciles the command menu too                                                       | KILLED |
| F4I-22 | the version-unsupported remedy names no cause the code cannot separate      | the old `Re-enable acceptance, or upgrade.` text restored                   | telegram-bootstrap-remedy.test.ts › does not name a configuration remedy for an envelope that may be truncated    | KILLED |
| F4I-23 | the auth-failed remedy does not rule out the one cause an operator can undo | the old `restoring key material does NOT fix it` clause restored            | telegram-bootstrap-remedy.test.ts › does not tell an operator a wrong key cannot be the cause of an auth failure  | KILLED |

### F4I-19, and a rule that was already written down

`nexa_listing_boolean` in `nexa-lib.sh` carried the reasoning verbatim before
this phase started: _"a reader accepting only `true` would report a monitor an
operator enabled with `yes` as disabled"_. The command-menu reconciliation was
written one file away and compared against the literal `true` anyway. So the
defect is not that the rule was unknown; it is that the rule lived in a function
nobody had to call. `nexa_boolean_word` is that vocabulary extracted, and
`nexa_listing_boolean` now calls it — one list, two readers.

The test reads the spellings out of `config.schema.ts` rather than restating
them, for the same reason: a list copied into a test agrees with the copy.

### F4I-20 — the claimed mechanism was wrong and the defect was real

Codex described `botctl update` HANGING on an invisible token prompt. It does
not: `promptForToken` refuses when `stdin.isTTY !== true`, and `-T` is exactly
what guarantees that — `cmd_telegram`'s own comment says so, one screen below.

What actually happened is worse to read and easier to miss. The refusal went to
`/dev/null`, and this printed _"the Telegram command menu could not be
reconciled; run 'botctl telegram register'"_ — a command that fails in exactly
the same way, because it supplies no token by design and the installation has no
bot row. That is a fix telling an operator to run a command that cannot work,
which `CLAUDE.md` records happening three times on the deployment branch, and
`OQ-TG-04` item 2 is its general form. Validating a finding means checking the
mechanism, not just the verdict; here the verdict was right and the mechanism was
not.

### F4I-22 and F4I-23 — the module's own argument, used against it

`telegram-bootstrap-remedy.ts` opens by arguing that a remedy keyed on a code
alone cannot separate two situations that share one code, and cites `OQ-TG-04`
item 5 as the example. Both findings are that same defect inside that same file:

- `SECRET_VERSION_UNSUPPORTED` has two producers in `secret-cipher.ts` — a v1
  envelope with acceptance off, and an envelope that is not a recognised format
  at all. The remedy named only the first pair and recommended a configuration
  change, while the cipher's message printed one line above it says _"newer
  release, or truncated"_. It contradicted the error it was annotating.
- `SECRET_AUTH_FAILED` said _"restoring key material does NOT fix it"_ and _"A
  key is not the problem"_ while listing a wrong key among the causes it cannot
  distinguish. The right key id holding the wrong key material fails exactly
  this way, and restoring the material is the one recovery an operator can
  perform. The clause is true of `SECRET_KEY_ID_MISMATCH` and was copied one
  case too far.

### What the re-read found that Codex did not

The comment 4I wrote above the reconciliation said the update _"released"_ the
lock before it and that _"the CLI's own registration path takes the installation
lock"_. Neither is true: `nexa_acquire_lock` holds a `flock` on a descriptor
belonging to the calling shell and there is no release function, so the lock is
held until botctl exits; and the CLI takes no lock at all — botctl takes it
around the CLI. The arrangement is correct and the explanation was backwards,
which is the version that survives a review, because a reader checking the claim
finds the behaviour they were promised.

No mutation is recorded for a comment. It is listed here because this document
is the record of what this phase's own re-reads found, and a false comment found
by re-reading is worth as much as a rule found by mutating.
