# Phase 4J falsification

Every production rule this phase changes, mutated back and run against the
committed suite. A rule whose mutation leaves the suite green is a rule the suite
cannot see, and `CLAUDE.md` is explicit about what that costs: _"A rule with no
test is a rule that will be silently reverted."_

Mutations that SURVIVE are recorded here as such, with what was done about them.
One did, and it is the most useful row in the table: it produced a second guard
that did not exist, and corrected a docblock that promised behaviour the code did
not have.

## 4J-1 — the operations a crash left terminal and unanswered

The window: an operation terminalises and the announcement is enqueued in the
same transaction, but the process can die between the transition committing and
the loop reaching `announce`. `announced_at` makes that state visible, and the
sweep answers it.

| #      | Rule                                                 | Mutation                                                                           | Named test                                                                                        | Result |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| F4J-01 | the provisioner loop runs the sweep every tick       | the `await this.outcomes.announceDue(scope, DRAIN_LIMIT)` line deleted             | `provisioning.test.ts` › still answers a customer after an operator has STOPPED the tenant        | KILLED |
| F4J-02 | `markAnnounced` keeps the FIRST answer               | `isNull(provisioningOperations.announcedAt)` removed from its predicate            | `provisioning.test.ts` › keeps the FIRST answer when two replicas stamp the same operation        | KILLED |
| F4J-03 | a non-terminal operation is NOT stamped              | the early `return` replaced with `await stamp(); return;`                          | `operation-outcome-announcer.test.ts` › does NOT stamp an operation that has not finished         | KILLED |
| F4J-04 | the sweep takes only operations past the grace       | `lt(provisioningOperations.completedAt, before)` removed from `dueForAnnouncement` | `provisioning.test.ts` › is found by the sweep once it is past the grace, and not before          | KILLED |
| F4J-09 | one failing operation does not end the sweep's batch | the per-operation `try`/`catch` removed, so the first throw ends the loop          | `operation-outcome-announcer.test.ts` › announces the rest of the batch when one operation throws | KILLED |

### What F4J-01 says about its own coverage

One test died, and it is the STOPPED-tenant case rather than a case about
sweeping. That is worth stating plainly: the sweep's other proofs drive
`dueForAnnouncement` and `markAnnounced` directly, so they cannot tell whether
anything calls them. The tenant case is the only one that goes through
`ProvisionerLoop.tick`, and it is therefore doing double duty as the wiring
proof. Naming that here is cheaper than a second test asserting the same line,
and a reader deleting the tenant case now knows what else goes with it.

## 4J-2 — a reply a rate limit stopped

| #      | Rule                                                              | Mutation                                                                    | Named test                                                                                                       | Result                |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| F4J-05 | a rate-limited transfer CLAIM falls back to the notification lane | the `fallback` property deleted from `signalTransferSent`'s reply           | `telegram-payment-flow.test.ts` › puts a rate-limited transfer CLAIM on the notification lane                    | KILLED                |
| F4J-06 | ONLY a rate limit falls back, never an unknown outcome            | `sent.outcome === 'RATE_LIMITED'` widened to `sent.outcome !== 'DELIVERED'` | `telegram-payment-flow.test.ts` › queues nothing when the outcome is UNKNOWN, because the reply may have arrived | KILLED                |
| F4J-07 | a fallback kind declares no precondition                          | `PAYMENT_TRANSFER_RECORDED: false` flipped to `true`, contracts rebuilt     | `customer-notifications.test.ts` › has a real reader for every kind that declares a precondition                 | SURVIVED, then KILLED |

F4J-05 kills two tests; the table cites one. The other is
`telegram-payment-flow.test.ts` › tells a customer once however many rate-limited
taps they make.

### F4J-07, which survived, and what the survival was actually telling us

The first run of this mutation was **green — 14 of 14**. The lane's own test
constructs a `CustomerNotificationService` with a fake `subjects.stillHolds` that
answers `true`, so the real reader is never reached and the precondition table can
say anything at all.

What the survival exposed was not a missing test but a **false claim in
`packages/contracts`**. Its docblock said marking one of these kinds `true` "would
throw at send time rather than silently answering wrong — which is the failure
direction to prefer, and is asserted". Neither half held.
`DrizzleNotificationSubjectReader` refuses only kinds declaring NO precondition;
one declaring a precondition it cannot answer went straight to its single query,
looked a payment id up in `services`, found no row, and returned `false` — so the
message was SUPERSEDED and never sent, with a resolved row saying the lane had
done its job. Silently answering wrong is exactly what it did, and nothing
asserted otherwise.

So the fix is a rule rather than a test: `ANSWERABLE_KINDS` names the kinds the
reader has a branch for and refuses the rest, the contract docblock now says what
the code does, and the new test drives the REAL reader over every kind — requiring
it to answer the ones declaring a precondition and refuse the ones that do not.
Re-run under the same mutation: 1 failed, naming `PAYMENT_TRANSFER_RECORDED`.

## 4J-3 — the announcer's activity check, stated rather than absent

| #      | Rule                                                                    | Mutation                                                                                                                         | Named test                                                                                 | Result |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| F4J-08 | the announcer answers a customer even after the tenant has been STOPPED | `scopeActivity` added to its deps and a refusal at the top of `announce`, wired in the container as every other service wires it | `provisioning.test.ts` › still answers a customer after an operator has STOPPED the tenant | KILLED |

This is the inverse of every other row: the mutation is a **fix**, and the test
exists to refuse it. `docs/conventions.md` carries the exception and its bound so
the next reader can tell a decision from an oversight without re-deriving the
argument.

## The Codex review of PR #32, processed once

Three findings, all CONFIRMED by reading the code rather than by accepting the
verdict — and one of them confirmed with a correction to its premise, which is
recorded below rather than smoothed over.

| #      | Rule                                                                      | Mutation                                                                 | Named test                                                                                           | Result |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------ |
| F4J-10 | a kind this build cannot render is deferred, never stamped or spent       | the `row.kind in CUSTOMER_NOTIFICATION_TEMPLATES` guard made unreachable | `customer-notifications.test.ts` › defers a kind this build cannot render instead of spending it     | KILLED |
| F4J-11 | a producer that knows a deadline sets the row's floor                     | `input.nextAttemptAt ?? null` reverted to `null`                         | `customer-notifications.test.ts` › honours a producer that already knows when the dispatcher may try | KILLED |
| F4J-12 | the sweep is served by its partial index rather than the answered history | the declaration deleted from `ONLINE_INDEXES` and the index dropped      | `provisioning.test.ts` › finds the unanswered one without walking the history behind it              | KILLED |

### C3, and the half of its premise that does not hold here

Codex's P1 asked for the two new kinds to be STAGED across two releases: reader
support everywhere first, producer second, because widening the `kind` CHECK is
write-compatible and not reader-compatible.

The mechanism is exactly right. An older dispatcher indexes
`CUSTOMER_NOTIFICATION_TEMPLATES` with a kind it has never heard of, gets
`undefined`, and — before this fix — had already stamped `send_started_at`, so the
throw left `reapStranded` to resolve a message that was never sent. Permanently
lost, no Telegram request, nothing saying so.

### CORRECTION: the premise this section first gave was wrong

What was written here, and is false: _"it is not reachable for THIS release,
because nothing has ever been deployed."_ That was read out of `CLAUDE.md` and
`docs/vps-acceptance.md`, both of which said the deployment model had never been
run against a real server. Both were stale.

`git tag` says otherwise. **`v0.2.0` is tagged at `40f13d3`** — the Phase 4I
merge — and fifteen `v0.1.0-staging.*` tags precede it, and the owner ran a real
v0.2.0 staging acceptance against a deployed installation (it is what produced
the 4J-5 finding below). So an older reader exists, in the field, today.

**The exposure, stated exactly.** `v0.2.0`'s dispatcher has no guard and no
template for the two new kinds. Reading its
`customer-notification.service.ts` at `40f13d3`: `markSendStarted` commits
BEFORE the send, `CUSTOMER_NOTIFICATION_TEMPLATES[row.kind]` is `undefined`, the
send throws, the catch logs `customer notification send failed` and returns
`errored` leaving the lease, and `reapStranded` later resolves the row
`UNCONFIRMED`. Never sent, never retried, and the row reads as one that may have
been delivered.

The window is a ROLLBACK, because `botctl rollback` never restores the database:
update an installation to this release, let a 429 produce a fallback row, roll
back to `v0.2.0`, and that row is stranded. It is bounded — only the two new
kinds, only rows written while this release ran, only where Telegram rate-limited
one of two interactive replies — and it is not quite silent, because the old
release logs an error per row. It is still a customer who is never told.

**What the fix does and does not cover.** The `unsupported` guard is in the NEW
code, so it protects every rollback to this release or later and every future
kind addition — which is the direction that matters from here, and is why the
finding is also recorded as a rule in `docs/conventions.md`. It does nothing for
a rollback BELOW this release, because that code is already published.

So the residual risk is an operational caveat rather than a code change:
`docs/deployment.md` now carries it under "Rolling back", with the remedy — roll
forward again and reset the stranded rows to `PENDING`. Staging the two kinds
across two releases, which is what Codex asked for, would have avoided it
entirely; that option was rejected on a false premise, and the honest record is
that the caveat exists because of this mistake rather than because the design
required it.

## 4J-5 — the persistent main menu, after real v0.2.0 staging acceptance

Staging acceptance is what found this: the bot registered five commands with
Telegram and an ordinary customer still had to know to type a slash. The
keyboard is navigation only — it carries no identifier and therefore no
authority, and every contextual action stays on `callback_data`.

| #      | Rule                                                              | Mutation                                                    | Named test                                                                                                  | Result |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| F4J-13 | each menu label routes to the command it stands for               | the container's `mainMenu` map replaced with an empty one   | `telegram-payment-flow.test.ts` › answers a main-menu tap exactly as it answers the slash command           | KILLED |
| F4J-14 | `/start` attaches the persistent keyboard                         | the `keyboard: 'MAIN_MENU'` the START reply carries removed | `telegram-customer-turn.test.ts` › attaches the persistent main menu to the welcome, and nothing else to it | KILLED |
| F4J-15 | the menu offers exactly the four actions this release can perform | the wallet button deleted from `MAIN_MENU_ROWS`             | `bot-runtime.test.ts` › offers exactly the four top-level actions this release can perform                  | KILLED |
| F4J-16 | the string drawn is the string matched                            | the messenger draws each label with a trailing space        | `telegram-customer-turn.test.ts` › attaches the persistent main menu to the welcome, and nothing else to it | KILLED |

F4J-13 kills two tests; the table cites one. The other is
`telegram-payment-flow.test.ts` › answers the catalogue button with the
catalogue, and its buttons still work. F4J-15 also kills
`bot-runtime.test.ts` › routes every main-menu button to the command it stands
for and `telegram-customer-turn.test.ts` › attaches the persistent main menu to
the welcome, and nothing else to it.

### One more mutation, deliberately left out of the table

Rewording `bot.menu.wallet` in the catalogue without touching the routing table
breaks nothing, and it has no row above because it has no test to cite and never
should: it is a survivor by construction rather than for want of coverage.

Rewording a label breaks nothing, because the keyboard is DRAWN from the
catalogue entry and the route is DERIVED from the same entry. The two cannot
disagree, so a rename changes what the customer reads and not what the button
does — which is what the single source of truth was for.

The mutation that WOULD be a defect is desynchronising them, and it has two
shapes, both killed above: drawing a string the router does not match (F4J-16)
and moving the routing table without the label (F4J-15). Recording F4J-17 as a
survivor without that distinction would read as missing coverage; recording it
at all is the point, because the next reader asking "why is nothing asserting
the Persian text" deserves the answer.
