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

| #      | Rule                                           | Mutation                                                                           | Named test                                                                                 | Result |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| F4J-01 | the provisioner loop runs the sweep every tick | the `await this.outcomes.announceDue(scope, DRAIN_LIMIT)` line deleted             | `provisioning.test.ts` › still answers a customer after an operator has STOPPED the tenant | KILLED |
| F4J-02 | `markAnnounced` keeps the FIRST answer         | `isNull(provisioningOperations.announcedAt)` removed from its predicate            | `provisioning.test.ts` › keeps the FIRST answer when two replicas stamp the same operation | KILLED |
| F4J-03 | a non-terminal operation is NOT stamped        | the early `return` replaced with `await stamp(); return;`                          | `operation-outcome-announcer.test.ts` › does NOT stamp an operation that has not finished  | KILLED |
| F4J-04 | the sweep takes only operations past the grace | `lt(provisioningOperations.completedAt, before)` removed from `dueForAnnouncement` | `provisioning.test.ts` › is found by the sweep once it is past the grace, and not before   | KILLED |

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
