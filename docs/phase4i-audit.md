# Phase 4I audit — the thirteen deferred bootstrap findings, re-verified

Written before any 4I code, against `main` at `6173336` (the Phase 4H merge).
`OQ-TG-04` is this phase's subject. It records thirteen findings an independent
review raised against head `22239a6`, which the owner deferred rather than
rejected:

> **Not rejected, and not false positives** — every item below was reported by an
> independent review of head `22239a6` and is, as far as it was examined, real.

This document re-verifies each one against the tree this phase branches from,
because a finding written at `22239a6` is evidence about `22239a6` and six merged
phases have landed since. **All thirteen are still real.** What has changed is
that three of them have a smaller fix than the entry describes, one (item 10)
reads backwards on a fast pass, and one (item 12) is closed twice over by the
structural change.

---

## 1. The shape, and why it is one defect rather than nine

`OQ-TG-04` states the diagnosis itself, and it is worth repeating because it is
what decides the order of work:

> the installer derives an operator-facing remedy from a cause, in prose, in a
> file that cannot see the code that decided it.

`deploy/install.sh` carries seven `INCOMPLETE_*` summaries — six selected by
cause plus a fallback, about 180 lines. The selector is `TELEGRAM_RETRY`, built
at `install.sh:1170-1198` from two sources that are not alike:

| source                                                                                       | can the installer prove it? |
| -------------------------------------------------------------------------------------------- | --------------------------- |
| `telegram_state()`, a database read through `bootstrap-bot.cli.js --status`                  | **Yes.**                    |
| the exit code of the CLI step                                                                | **Yes.**                    |
| `case "$out" in *telegram.bootstrap_*\|*platform.secret_*)`, a grep over captured CLI output | **No.**                     |

The third is not merely unreliable, it is _absent_ on a whole path. The
interactive branch at `install.sh:1118-1128` deliberately does not capture, and
says so in words: _"The interactive path is NOT captured: a prompt delivered
after the command has finished is not a prompt."_ So on a first install at a
terminal, `$out` is empty, no `case` arm matches, and the classifier falls
through to a summary chosen from the STATE alone.

That single fact is item 2. Items 1, 4, 5, 7, 8 and 12 are the same mechanism
seen from six other angles: a sentence that is true in the state the author had
in mind and false in another state reachable with the same cause.

**So the work is ordered: remove the surface first, then fix what remains.**
Fixing nine false sentences in a file that cannot know the truth produces a tenth.

## 2. The structural change

### 2a. The CLI becomes the authority (`4I-2`)

`bootstrap-bot.cli.ts:331-341` already has the cause in its hand:

```ts
if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
```

It prints the code and the message and stops. The REMEDY — the thing the six
heredocs exist to carry — is not printed, and the installer then infers it from a
grep. The fix is to print it where the code is known.

A pure, exported `bootstrapRemedy(code): string | null`, unit-tested in its own
right, printed to stderr under the error line. An unrecognised code answers
`null` and nothing extra is printed: a remedy table that guesses is the defect
this phase removes, arrived at from the inside.

### 2b. The installer summarises only what it proves (`4I-1`)

The `case "$out"` classification is deleted with the six heredocs it selects.
What is left is keyed on `telegram_state()`, which the installer genuinely reads:

1. `none` — nothing is stored, so there is nothing to resume from.
2. `incomplete` | `ready` — a bot row with a stored token exists, and this run
   did not change it.
3. `unavailable`, or a state this installer does not recognise — the neutral
   summary, claiming nothing about what is stored.

`OQ-TG-04` says "the TWO the installer can state correctly". Three, not two, and
the third is a consequence of item 11's fix: once an inactive tenant answers
`unavailable` whether or not a bot row exists, "a token is stored" stops being
provable in that state. A third summary that claims nothing is the honest
discharge of the same rule, not an exception to it.

**The trap this phase must not walk into.** The obvious `none` summary —
"nothing was stored, so rerun the installer with a token source" — is ITSELF a
cause-derived remedy, and item 2 is the proof that it is false: an already-bound
refusal rolls its insert back, so its state is `none` too, and that rerun refuses
identically for ever. The honest summary states what is stored and points at the
error above. It does not prescribe.

The no-terminal-no-token branch keeps its own two warning lines. "There is no
terminal and no `--bot-token-file`" is a fact the installer PROVED by checking,
and it is the one case where no CLI ran, so there is no error above to point at.

### 2c. The coverage this must not lose

`tests/deploy/botctl.test.sh:5201-5460` asserts the prose of five of the six
heredocs, extracted by name with `sed`. Deleting the heredocs deletes those
assertions silently, and CLAUDE.md already names that failure: _"A rule with no
test is a rule that will be silently reverted."_

So the order inside `4I-1` is fixed: write `bootstrapRemedy`'s unit tests and the
three state-keyed summary assertions FIRST, watch them fail, then delete. Every
sentence the old tests protected gets a new home, most of them in
`bootstrapRemedy`, where it is asserted against the CODE that selects it instead
of against a grep that may not run.

## 3. The thirteen, re-verified

| #   | verdict | where it lives now                     | closed by                               |
| --- | ------- | -------------------------------------- | --------------------------------------- |
| 1   | REAL    | `bot-bootstrap.service.ts` `getMe`     | §7 — the message branches on `existing` |
| 2   | REAL    | `install.sh` classifier                | 2b — there is no classifier left        |
| 3   | REAL    | `bot-bootstrap.service.ts` legacy fill | its own fix, §4                         |
| 4   | REAL    | `INCOMPLETE_TOKEN_UNREADABLE` header   | 2a+2b — the heredoc goes                |
| 5   | REAL    | `INCOMPLETE_ALREADY_BOUND`             | §7 — one code, two paths, two messages  |
| 6   | REAL    | `telegram-bot-bootstrap.gateway.ts`    | its own fix, §4                         |
| 7   | REAL    | 0041 preflight prose                   | §4, with 2a                             |
| 8   | REAL    | `webhookFailure`                       | §7, with a second contract code         |
| 9   | REAL    | `bootstrap-bot.cli.ts:243`             | its own fix, §4                         |
| 10  | REAL    | `drizzle-tenant.repository.ts:450`     | its own fix, §4                         |
| 11  | REAL    | `bot-bootstrap.service.ts:181`         | its own fix, §4                         |
| 12  | REAL    | classifier has no `_unreachable` arm   | 2b, and §4 for the code                 |
| 13  | REAL    | `docs/deployment.md`                   | a doc correction, §4                    |

## 4. The seven that the structural change does not close by itself

### Item 11 — one reordering, and it stops a credential leaving the host

`bot-bootstrap.service.ts:181`:

```ts
const existing = await this.deps.bots.findBootstrapTarget(scope);
if (existing === null) return 'none'; // <- here
if ((await this.unavailableReason(scope, existing)) !== null) return 'unavailable';
```

`scopeIsActive` is consulted only inside `unavailableReason`, which is reached
only when a row EXISTS. A stopped tenant with no bot therefore answers `none`;
the installer prompts for a bearer credential, sends it to `getMe`, and only then
does the create transaction refuse. **The token need never have left the host.**

Fix: an inactive tenant is `unavailable` whether or not a bot row exists. More
truthful, and it closes the leak.

### Item 9 — the sentence it needs already exists and is discarded

`bootstrap-bot.cli.ts:243` writes the bare state to stdout and nothing else.
`unavailableReason` in the same service already computes a cause-specific,
actionable sentence for each of its three causes — webhook disabled, bot not
ACTIVE, tenant not accepting work — and `status()` collapses all three to the
word `unavailable`.

Fix: stdout keeps the bare state, because that is the script-readable contract;
the reason goes to STDERR when the state is `unavailable`. Item 13's
documentation correction then has something true to document.

### Item 13 — a contract automation depends on

`docs/deployment.md` still documents `none | incomplete | ready`. `unavailable`
is a fourth value the CLI has returned since it was added, so automation written
from that section rejects a legitimate answer exactly when something is disabled.

### Items 6 and 7 — one fix, and it needs a contracts commit

`telegram-bot-bootstrap.gateway.ts` maps every `FAILED_PERMANENT` to `REJECTED`,
and its own comment admits the two causes: a 401 from a revoked token, and a 2xx
that did not describe a bot, _"which means the configured API base is not
Telegram"_. It then discards the field that separates them —
`send-message.ts:277` sets `errorCode: 'telegram.rejected.getme_shape'` for the
second and `telegram.rejected.401` for the first.

`bot-bootstrap.service.ts:597` turns every `REJECTED` into
`TELEGRAM_BOOTSTRAP_TOKEN_REJECTED`, whose remedy is BotFather. That is item 7's
false diagnosis: a misconfigured `TELEGRAM_API_BASE_URL` sends the operator to
reissue a token that is fine.

Three layers, smallest change at each:

1. contracts, **its own commit**: `TELEGRAM_BOOTSTRAP_API_BASE_INVALID`.
2. `BotIdentityProbe` gains a fourth member `{ outcome: 'NOT_TELEGRAM'; detail }`,
   selected by the gateway on that one error code. A 401 is still `REJECTED`.
3. the service raises the new code, and `bootstrapRemedy` explains it.

### Item 3 — the root cause is narrower than "wrong ordering"

`refuseRepointing` returns early when `existing.telegramBotId === null` — exactly
a pre-0038 legacy row. So on such a row: the first call compares the supplied
token's claimed id against the id `getMe` just answered FOR THAT TOKEN, which
always agree, so it cannot refuse; `recordTelegramIdentity` then COMMITS the bot
id and username with an audit row; and the second `refuseRepointing` now sees a
populated id and throws a message opening "Nothing was changed.", which the
committed UPDATE and the audit row make false.

Two candidate fixes:

(a) correct the MESSAGE on the legacy path. The refusal is right; only the
"nothing was changed" clause is false, and the identity fill there is a
legitimate, audited migration of a row that predates the column.
(b) derive the existing bot id from the STORED token's `<botid>:` prefix before
the fill, and compare against that.

**(a).** The state after the refusal is correct either way, and (b) decrypts a
credential earlier than it needs to be decrypted, to buy prose that (a) already
delivers truthfully.

### Item 10 — a second constraint with no translation, not a translation that is too narrow

`drizzle-tenant.repository.ts:450` `rethrowAlreadyBound` matches only
`bot_instances_telegram_bot_id_key`. Its docblock is explicit and **correct**
about why:

> Named constraint, not bare 23505: `bot_instances` also has a unique index on
> `username`, and answering "already bound to another tenant" for that one would
> be a confident wrong answer about a genuinely different mistake.

So the narrow match is deliberate and stays. The defect is that the username
violation then has no translation AT ALL and reaches the CLI as a raw 23505. The
fix is a SECOND branch with its own code and message — a stale username still
held by another row after a rename in BotFather — not a widening of the first.
Widening it would introduce exactly the confident wrong answer the comment warns
about, which is how this entry reads on a fast pass and is not what it says.

## 5. Also in scope, from Phase 4H

`OQ-4H-02` — the command menu is registered only on a bootstrap that creates a
bot, so an installation upgrading into a release that adds a command keeps the
old menu until somebody re-runs a bootstrap that has nothing else to do. Same
surface, same phase.

## 6. Out of scope, explicitly

- `OQ-TG-01` — token rotation. Every summary in this area points at it and none
  of them invents it. 4I does not either; removing the prose that gestures at it
  is not the same as adding the command.
- `OQ-4H-01` — an interactive reply lost to a rate limit. Recorded for 4J.

## 7. Items 1, 5 and 8, re-verified in full — and what they teach about 2a

These three were checked line by line at `6173336` because each one changes the
shape of `bootstrapRemedy`.

### Item 1 — CONFIRMED, and the branch it needs is already a parameter

`getMe(scope, existing, token)` throws one `TELEGRAM_BOOTSTRAP_TOKEN_REJECTED`
message for every rejection, and it reads:

> There is no supported recovery for a revoked token in this release — a revoked
> one cannot be restored in BotFather, and a newly issued one is not used,
> because the registration always reads the credential already stored.

Every clause of that is true of a STORED credential and false when `existing` is
`null`: nothing is stored, `createFromBootstrap` has not run, and rerunning with
a corrected token IS the recovery. The method already TAKES `existing`. The fix
is to branch the message on it — no new plumbing, no new code.

### Item 5 — CONFIRMED, and it decides what `bootstrapRemedy` may say

`rethrowAlreadyBound` is called from two places: the INSERT
(`drizzle-tenant.repository.ts:367`) and the `recordTelegramIdentity` UPDATE
(line 433). Both throw the SAME sentence — "create a second bot in BotFather and
rerun". From the INSERT that is right: the row rolled back. From the UPDATE it is
not: the tenant already holds a legacy row AND an encrypted token for the
duplicated bot, and no operation in this release replaces a stored credential, so
the advertised retry cannot repair it.

**This is the constraint on 2a.** A remedy keyed on the CODE cannot say something
path-dependent, and `TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND` is one code with two
situations. So the split is:

- the **message**, written by the layer that knows which path it is on, carries
  everything path-dependent. `rethrowAlreadyBound` takes which statement raised
  it and says the right thing.
- `bootstrapRemedy`, keyed on the code, carries only what is true of that code in
  EVERY state it can be raised from — and for this code that is close to nothing,
  so it says close to nothing.

A remedy table that "fills in" a path it cannot see is the installer's defect
moved one layer down, and item 5 is the proof that the opportunity is there.

### Item 8 — CONFIRMED, and it needs the second code

`webhookFailure` builds ONE `detail` for both outcomes:

> The bot instance and its encrypted token are stored and correct; rerun the
> installer to retry the registration.

and then chooses only the ERROR KIND from `outcome.outcome`. `REFUSED` means
Telegram looked at the URL and refused it — not https, a port it does not accept,
a name it cannot resolve — and an unchanged rerun submits the same URL. Both also
share `TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED`, whose own docblock describes only the
transient case ("DNS that has not propagated and a certificate not yet issued …
both are fixed by waiting and rerunning").

So item 8 needs a second contract code beside item 6's, in the same contracts
commit: `TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED` for the permanent refusal, with the
existing code keeping the transient case its docblock already describes. Branch
the detail text with it.

## 8. The contracts commit, assembled

One commit, its own, before any behaviour changes — per CLAUDE.md, _"Adding a
state, event, permission, ledger reason, metric or template key is a contract
change: make it its own commit, and say why in the message."_

| addition                              | closes     |
| ------------------------------------- | ---------- |
| `TELEGRAM_BOOTSTRAP_API_BASE_INVALID` | items 6, 7 |
| `TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED`  | item 8     |
| `TELEGRAM_BOOTSTRAP_USERNAME_TAKEN`   | item 10    |

Nothing is removed and nothing is renamed: an installation mid-upgrade may raise
any of the existing codes, and `bootstrapRemedy` has to keep explaining them.

## 9. Items 4, 7, 12 and 13, re-verified

### Item 4 — CONFIRMED, header against body

`INCOMPLETE_TOKEN_UNREADABLE` (`install.sh:1391-1425`) has a header line

```
  why           the error printed above this summary names the key
```

and a body that then correctly says restoring key material fixes neither
`platform.secret_auth_failed` nor `platform.secret_key_id_mismatch` — and
`secret_auth_failed` names no key at all, deliberately: its contract docblock
argues that a wrong key, a modified byte, a truncated download and an edited
header are indistinguishable at the AEAD boundary and must stay that way. So a
correction was made to the body and not to the heading above it.

Closed by 2b: the heredoc goes. What it was trying to say — four codes, four
positions, two of them not key-shaped — belongs in `bootstrapRemedy` keyed on the
CODE, which is where `secret_auth_failed` can be given its own sentence instead of
sharing a header with three codes that do name a key.

### Item 7 — CONFIRMED, and the doc half is real too

`preflight.ts` `checkDistinctTelegramBotIds` refuses with:

> Decide which tenant keeps each bot, **give the others their own**, and retry.
> See `docs/deployment.md`, 'Migration preflight'.

Creating separate bots in BotFather changes no existing `telegram_bot_id` and no
stored credential, and no operation in this release replaces one (OQ-TG-01), so
the preflight fails identically on the retry it advertises. The honest text names
the remediation as direct database work and says which decision it encodes.

And `docs/deployment.md:570-600` — the section that message points at — covers
`0015_single_primary_tenant` and ONLY that. An operator sent there for a
duplicate-bot refusal finds a page about PRIMARY tenants.

Both halves are 4I's: the message stops prescribing what does not remediate, and
the section grows the second condition it is already cited for.

### Item 12 — CONFIRMED by absence

`install.sh:1180-1198` matches `telegram.bootstrap_bot_already_bound`,
`telegram.bootstrap_different_bot`, `telegram.bootstrap_token_rejected` and
`platform.secret_*`. There is no `telegram.bootstrap_unreachable` arm, so an
outbound failure during `getMe` falls through to the webhook summary — inbound
DNS and certificates — for a call that never reached `setWebhook`.

Closed twice: 2b removes the summary it falls into, and `bootstrapRemedy` gives
the code an explanation naming the OUTBOUND boundary.

### Item 13 — CONFIRMED, one line

`docs/deployment.md:246`:

```
botctl telegram status     # none | incomplete | ready
```

`unavailable` is a fourth value the CLI has returned since it was added, so
automation written from this line rejects a legitimate answer exactly when
something is disabled. With item 9's fix the line can also say where the reason
goes — stdout stays the bare state, stderr carries the cause.

## 10. `OQ-4H-02`, and the shape its fix has to have

The question already names the mechanism and the two things that are NOT it:

> The right mechanism is a command REVISION stored beside the bot, so an upgrade
> re-registers exactly once rather than on every boot of every replica …
> Registering unconditionally at startup instead would put an outbound Telegram
> call on the readiness path of every process.

So: a `bot_instances` column holding the revision of `BOT_COMMANDS` last
registered, a constant beside `BOT_COMMANDS` that is bumped when the list
changes, and a reconciliation that compares them. `registerCommands` at
`bot-bootstrap.service.ts:443` runs inside `execute` and nowhere else, which is
why a `botctl update` leaves the menu alone.

Where the comparison RUNS is the open part of the design, and 4I has to decide it
rather than inherit it: the bootstrap CLI is already the place a rerun
reconciles, and `botctl update` could invoke it — which keeps the outbound call
off every process's readiness path, and puts it on the one path an operator is
already watching.

## 11. What the collapse does NOT break, checked rather than assumed

`scripts/deployment-smoke.sh` was read line by line, because §2c's claim is that
the test debt is confined to `tests/deploy/botctl.test.sh`.

It is. The smoke script asserts on the CLI's **error codes**, never on installer
prose:

```sh
if ! grep -qE 'telegram\.bootstrap_(unreachable|token_rejected)' "$telegram_log"; then
  fail "the failure was not one of the two named bootstrap outcomes" "$telegram_log"
fi
```

So deleting the six heredocs changes nothing it looks at, and the remedy lines
`bootstrapRemedy` adds are extra output it ignores.

One rule the smoke script does impose on 4I, and it is load-bearing:

```sh
if grep -qF -- "$SMOKE_BOT_TOKEN" "$telegram_log"; then
```

**Nothing `bootstrapRemedy` prints may contain a credential.** It is keyed on a
CODE and takes nothing else, which is what makes that structurally true rather
than a thing to remember — and it is why the signature is `(code: string)` and
not `(error: NexaError)`, where a message interpolating a token would pass
straight through.

## 12. A third reason the third summary exists, found while drafting it

`install.sh:1012` refuses an unreadable state — _"could not determine whether
this installation's Telegram bot is configured … Refusing to guess."_ — and that
refusal runs BEFORE the CLI. But `TELEGRAM_RETRY` is re-read AFTER the failure at
line 1170, and that second read has its own failure mode:

```sh
TELEGRAM_RETRY="$(telegram_state)" || TELEGRAM_RETRY=""
```

If `docker compose` itself has gone by then, `TELEGRAM_RETRY` is the EMPTY
STRING. Under the two-summary proposal that empty value has to land in one of the
two, and both would be a claim about stored credentials made from a read that did
not happen. The catch-all arm makes it land in the summary that claims nothing,
which is the only true answer available.

So the third summary is not an exception to "two summaries". It is what "state
only what you can prove" produces when you also ask what happens when the proof
itself fails — and it means there is no path from a failed state read to a
sentence about a credential.
