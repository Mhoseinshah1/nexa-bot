# Phase 4G falsification — the outcomes a payment could not reach

Every rule Phase 4G introduced, reverted one at a time, with the committed test
that fails as a result. `scripts/falsify.sh` applies the mutation, runs the named
file, restores the tree and refuses to report anything if the restore is not
byte-identical.

**Nineteen KILLED, three recorded as SURVIVED with the reading that makes each
one a finding rather than a gap, and four run by hand because the harness cannot
reach what they test.** Six of the nineteen are rules the self-review of the
whole diff added; two of the original SURVIVED rows became KILLED in that round,
by a better mutation rather than a new test.

The three survivors are each a finding in their own right and none is a missing
test: one is an application check a deeper guard catches first, one is a mutation
that turned out to be equivalent to the original, and one is a predicate whose
own comment already calls it redundant — the survival being the evidence for that
claim rather than a hole in it.

Section headings are the section a rule belongs to, not the round it was found
in: the three rows under _"what the self-review found"_ are rules that did not
exist until that round, and F4G-16 and F4G-17 are beside the sweep rows they
belong with.

## The two decisions a person makes

| #      | Rule                                                                        | Mutation                                                   | Named test                                                                            | Result   |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| F4G-01 | `resolve` moves a payment only from `PENDING`, and reports whether it moved | the `WHERE state = 'PENDING'` in `resolve` → `sql\`true\`` | `payments.test.ts` › resolves only from PENDING, and tells the loser it lost          | KILLED   |
| F4G-03 | A withdrawal re-reads the OWNER from the row, not from the tap              | `payment.customerId !== customerId` removed from the guard | `payments.test.ts` › answers another customer’s payment id as not found               | KILLED   |
| F4G-04 | A rejection is refused unless the payment is `PENDING`                      | the state check → `if (false)`                             | `payments.test.ts` › refuses to reject a payment that was confirmed                   | SURVIVED |
| F4G-07 | A rejection records WHO made it                                             | `resolvedByAdminId: adminIdOf(actor)` → `null`             | `payments.test.ts` › records who, when and why, and leaves the order awaiting payment | KILLED   |
| F4G-11 | A withdrawal records NO administrator                                       | `resolvedByAdminId: null` → `adminIdOf(actor)`             | `payments.test.ts` › closes the payment and leaves the order open                     | SURVIVED |

## The sweep

| #      | Rule                                                                     | Mutation                                                    | Named test                                                                                           | Result   |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| F4G-02 | A stopped tenant's rows are not swept, checked inside the transaction    | the `scopeIsActive` guard → `if (false)`                    | `payments.test.ts` › expires nothing for a tenant that has stopped, and does not call that a failure | KILLED   |
| F4G-16 | ...and a stopped tenant is a COMPLETED pass, not a failed one            | the zero report → `throw`                                   | `payments.test.ts` › expires nothing for a tenant that has stopped, and does not call that a failure | KILLED   |
| F4G-17 | An order with a PENDING payment against it is never expired              | `noLivePayment`'s `'PENDING'` → a state no row holds        | `payments.test.ts` › never expires an order while a payment against it is still pending              | KILLED   |
| F4G-08 | Every expired payment leaves an audit row under its own action name      | `action: 'payment.expire'` → `'payment.expired'`            | `payments.test.ts` › expires a stale payment and the order it was against, in one pass               | KILLED   |
| F4G-09 | Every expired order leaves an audit row under its own action name        | `action: 'order.expire'` → `'order.expired'`                | `payments.test.ts` › expires a stale payment and the order it was against, in one pass               | KILLED   |
| F4G-14 | An order with a CONFIRMED payment against it is never expired            | `noConfirmedPayment`'s `'CONFIRMED'` → a state no row holds | `payments.test.ts` › never touches a confirmed payment or the order it settled                       | SURVIVED |
| F4G-15 | The order sweep states its state predicate on both sides of the row lock | the UPDATE's state predicate removed                        | `payments.test.ts` › never touches a confirmed payment or the order it settled                       | SURVIVED |

## The window

| #      | Rule                                                               | Mutation                                            | Named test                                                                            | Result |
| ------ | ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| F4G-05 | A payment's deadline never outlives the order it names             | `paymentDeadline` → always the configured window    | `payments.test.ts` › never outlives the order it names                                | KILLED |
| F4G-06 | A payment's deadline is bounded by the window even on a long order | `paymentDeadline` → always the order's own deadline | `payments.test.ts` › holds a transfer open for the configured window, not the order’s | KILLED |

## Three rules the self-review of the whole diff added

| #      | Rule                                                                | Mutation                                       | Named test                                                                                                   | Result |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| F4G-18 | Approve and reject are different commands under one idempotency key | `decision: 'REJECT'` → `'CONFIRM'` in the hash | `payments.test.ts` › will not honour a confirmation under the key a rejection already used                   | KILLED |
| F4G-19 | A window too short to transfer money in is refused, not issued      | the floor comparison → `false`                 | `payments.test.ts` › refuses to issue bank instructions that would die before the customer acts              | KILLED |
| F4G-20 | The first tap ASKS; only the second withdraws                       | the ASK dispatch → the withdrawal directly     | `telegram-payment-flow.test.ts` › offers a way out with the instructions, and withdrawing closes the payment | KILLED |

## The surfaces

| #      | Rule                                                                 | Mutation                                                        | Named test                                                                                                   | Result |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| F4G-10 | `x:` routes to the withdrawal, and nothing else does                 | the `CANCEL_PAY_CALLBACK_PREFIX` branch deleted from `intentOf` | `telegram-payment-flow.test.ts` › offers a way out with the instructions, and withdrawing closes the payment | KILLED |
| F4G-12 | A refused payment answers with the PAYMENT's key, not the order's    | `'bot.payment.not_pending'` → `'bot.order.unavailable'`         | `bot-runtime.test.ts` › sends no copy that promises a flow this head does not have                           | KILLED |
| F4G-13 | The reject card is drawn only for an operator holding the permission | the `&& mayReview` removed from the card's condition            | `payments.test.tsx` › offers no rejection to an operator without receipts.review                             | KILLED |

## Run by hand, because the harness cannot reach what they test

`scripts/falsify.sh` mutates one committed FILE and restores it. Two of these
rules live in two places at once and neither place alone is load-bearing; the
third lives in an APPLIED migration, where editing the source file changes
nothing about the database the test runs against. Each was run by the same
procedure — mutate, run the named test, restore, re-run — with the transcript in
this session.

| #     | Rule                                                                                    | Mutation                                                                                                         | Named test                                                                            | Result |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| H4G-1 | A rejection is refused on a non-`PENDING` payment by the application AND the repository | F4G-04 and F4G-01 applied together                                                                               | `payments.test.ts` › refuses to reject a payment that was confirmed                   | KILLED |
| H4G-2 | The order sweep states its predicates on BOTH sides of the lock                         | F4G-14 and F4G-15 applied together                                                                               | `payments.test.ts` › never touches a confirmed payment or the order it settled        | KILLED |
| H4G-3 | Migration 0052 freezes a resolved payment against a raw UPDATE                          | the function's resolved-state branch dropped in the live test database, 0033/0035's CONFIRMED branch left intact | `payments.test.ts` › refuses a raw UPDATE that would reopen a rejected payment        | KILLED |
| H4G-4 | Migration 0053 freezes the three evidence columns 0052 left writable                    | the live function replaced with 0052's own body, which is that state exactly                                     | `payments.test.ts` › refuses a raw UPDATE that would dress a rejection up as a review | KILLED |

H4G-3 is the one that matters most and the one a source-file mutation would have
reported SURVIVED for a rule fully in force. The guard is a `CREATE OR REPLACE`
that has already run; the test exercises the database, not the file. So the
mutation was applied with `psql` against `nexa_test`, the two freeze cases failed
(`2 failed | 1 passed`), the function was restored by running
`apps/api/drizzle/0052_freeze_a_resolved_payment.sql` itself rather than by
retyping it, and all three cases passed again.

## What the four survivors mean

**F4G-04 and H4G-1 — an application check the repository catches anyway.** The
service refuses a rejection on a non-`PENDING` payment, and removing that check
changes nothing observable: `resolve` is a conditional UPDATE, returns false, and
the `if (!moved)` branch throws the SAME error code. So the test cannot tell the
two apart, and it should not be able to. The rule is real and enforced twice; the
application check is the earlier and cheaper refusal and the repository's is the
one that holds under a race. H4G-1 removes both and the test dies, which is the
evidence the pair is load-bearing and neither half alone is.

**F4G-14, F4G-15 and H4G-2 — the same predicate on both sides of a row lock.**
Removing it from the sub-select leaves the UPDATE re-checking it; removing it
from the UPDATE leaves the sub-select filtering. That is the point of writing it
twice — `ServiceRepository.expireDue` states the rule this follows: _"the
sub-select alone is satisfied by a scan that found the row before another writer
moved it"_ — and it is also why neither mutation alone can kill a test. H4G-2
removes both and the test dies.

**F4G-11 — a mutation that was not one.** The intent was to prove that a
withdrawal writes no administrator by making it write one. It SURVIVED, and the
first reading — "the rule has no test" — was wrong: the actor on that path is a
`SYSTEM_JOB` and `adminIdOf` returns null for one, so the mutated line produced
exactly the same value as the original. Recorded as an equivalent mutation rather
than as a gap, and answered by writing the test the rule actually needed:
`payments.test.ts` › refuses an administrator on a withdrawal, at the schema,
which drives `payments_resolution_reviewer_check` directly. That constraint needs
a `PENDING` row to be reachable at all — on a resolved one, 0052's trigger raises
before any CHECK is evaluated, so a test written the obvious way would have
proved the trigger twice and the constraint never.

## What this pass did NOT find, and what the round after it did

No rule in this phase turned out to have no test at all. Every mutation either
died against a test written with the code, or survived for a reason stated above
— and the three reasons are "another layer catches it first", "the mutation was
equivalent" and "the predicate is redundant and says so", none of which is a
missing test.

What the pass could not find is the class the self-review of the whole diff did:
rules that were WRONG rather than untested. A mutation proves a rule is enforced;
it cannot tell you the rule should have been a different rule. The sweep's
ordering invariant had a test that passed and a docblock that was false for any
backlog larger than the bound; the two halves of `receipts.review` shared an
idempotency identity and every test of each half passed; a stopped tenant took
the worker's health down and nothing asserted otherwise. Six of the rows above
exist because that review ran after this one, not instead of it.

The honest limit of that claim: this pass falsified the rules 4G ADDS. It says
nothing about the rules 4G leaves in place, and the audit is explicit that three
`PAYMENT_MACHINE` edges still have no producer at all (`OQ-4G-04`) — an absence
no mutation can surface, because there is nothing to mutate.
