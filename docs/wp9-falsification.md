# WP9-A — referral falsification record

Each rule below was reverted alone, in a separate worktree against its own database. Only
the named test was run, and the file was restored before the next mutation.
`docs/wp9-referral-audit.md` is the design these rows hold.

The driver ran every named test on the unmutated tree first and counted a mutation only
after that run passed. It then ran the same test against the mutation and required vitest
to report it FAILED. A run that executed no tests did not count. Every failure was read.
All but two died on an assertion. WP9-14 and WP9-15 died on the database's partial
unique index; that is explained below the table, as is the correction that re-ran
WP9-19 and WP9-20. No mutation in this record touched `packages/contracts`.

| #      | rule                                                                    | mutation                                                                      | tests that die                                                                                                                                                                                                                                                                 | result |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| WP9-01 | only the update that CREATES the customer is attributed                 | the `ALREADY_REGISTERED` refusal on `!input.created` removed                  | `referrals.test.ts` › refuses a customer who already exists as ALREADY_REGISTERED, whoever’s link they follow later                                                                                                                                                            | KILLED |
| WP9-02 | no attribution while the program is not active                          | the `PROGRAM_INACTIVE` refusal removed from `attributeOnArrival`              | `referrals.test.ts` › refuses every link as PROGRAM_INACTIVE while the program is off, or on with no rate chosen                                                                                                                                                               | KILLED |
| WP9-03 | the program is active only with the flag on AND a rate chosen           | `terms().active` reduced to the flag alone                                    | `referrals.test.ts` › refuses every link as PROGRAM_INACTIVE while the program is off, or on with no rate chosen; › answers INACTIVE and records nothing while the program is off, or on with no rate; › draws the referral button on /wallet only while the program is active | KILLED |
| WP9-04 | a blocked referrer's link attributes nobody                             | the `REFERRER_BLOCKED` refusal removed from `attributeOnArrival`              | `referrals.test.ts` › refuses a BLOCKED referrer’s link as REFERRER_BLOCKED                                                                                                                                                                                                    | KILLED |
| WP9-05 | a derived code another customer holds is refused, never reassigned      | the `TAKEN` → `UNAVAILABLE` answer in `invite` removed                        | `referrals.test.ts` › answers UNAVAILABLE, and never reassigns the code, when another customer already holds it                                                                                                                                                                | KILLED |
| WP9-06 | a link names only a bot of the customer's own tenant                    | the `bot.tenantId !== scope.tenantId` check removed from `invite`             | `referrals.test.ts` › answers UNAVAILABLE for a bot of another tenant: a link names the bot the customer is talking to                                                                                                                                                         | KILLED |
| WP9-07 | a trial is promised nothing                                             | the `isDiscountablePurpose` return removed from `promise`                     | `referrals.test.ts` › promises nothing on a TRIAL, whatever its total: a trial earns nobody anything                                                                                                                                                                           | KILLED |
| WP9-08 | an order below `referral.minimum_order_amount` is promised nothing      | the `total < minimum` return removed from `promise`                           | `referrals.test.ts` › promises nothing below referral.minimum_order_amount, and promises at the floor exactly                                                                                                                                                                  | KILLED |
| WP9-09 | a floor in another currency earns nothing rather than being converted   | the floor's currency comparison removed from `promise`                        | `referrals.test.ts` › promises nothing when the floor is in a currency the order is not in                                                                                                                                                                                     | KILLED |
| WP9-10 | a referrer blocked at confirmation is promised nothing                  | the `referrer.status === 'BLOCKED'` return removed from `promise`             | `referrals.test.ts` › promises nothing when the referrer is BLOCKED at confirmation                                                                                                                                                                                            | KILLED |
| WP9-11 | nothing is promised while the program is off at confirmation            | `!terms.active` dropped from the guard in `promise`, leaving the rate check   | `referrals.test.ts` › promises nothing while the program is off at confirmation, and a promise already made still settles after it is switched off                                                                                                                             | KILLED |
| WP9-12 | delivery is an operation of the type the order BOUGHT (`PURCHASED_AS`)  | the `op.type = CASE … PURCHASED_AS … END` predicate removed from `answered`   | `referrals.test.ts` › counts only an operation of the type the order BOUGHT as delivery                                                                                                                                                                                        | KILLED |
| WP9-13 | an order that ended undelivered voids its promise                       | the `!answer.delivered` → `VOID` branch in `settle` made unreachable          | `referrals.test.ts` › voids the promise of a paid order refunded because it could not be delivered, crediting and reversing nothing                                                                                                                                            | KILLED |
| WP9-14 | under first-order scope a second delivered commission is `VOID`         | the `hasEarnedForReferral` → `VOID` branch in `settle` made unreachable       | `referrals.test.ts` › under FIRST_PAID_ORDER, a second delivered order’s commission is VOID and only the first is credited                                                                                                                                                     | KILLED |
| WP9-15 | the earner takes the referrer's lock before judging first-order scope   | `lockCustomer` removed from `settle`                                          | `referrals.test.ts` › serialises two concurrent earners of one referral on the referrer’s lock, so exactly one first-order commission is EARNED                                                                                                                                | KILLED |
| WP9-16 | the earned amount is the promise less what completed refunds gave back  | `earned` set to the full promised amount instead of `proportionalTargetMinor` | `referrals.test.ts` › earns only the refunded-down share when a refund completed before delivery was noticed, and reverses nothing                                                                                                                                             | KILLED |
| WP9-17 | a reversal subtracts what earlier reversals already took                | `alreadyDue` multiplied by zero in `reverseForRefund`                         | `referrals.test.ts` › reverses across two partial refunds exactly what one full refund would                                                                                                                                                                                   | KILLED |
| WP9-18 | a reversal recovers at most the referrer's balance                      | `recovered` set to the whole `due`                                            | `referrals.test.ts` › records what a spent referrer balance cannot cover as unrecovered, and never takes it below zero                                                                                                                                                         | KILLED |
| WP9-19 | a reversal judges the commission's state only under the referrer's lock | the unlocked early return widened from `VOID` to anything not `EARNED`        | `referrals.test.ts` › never misses a reversal when a refund completes while the earner holds the referrer’s lock mid-credit                                                                                                                                                    | KILLED |
| WP9-20 | a reversal reads the balance under the referrer's lock                  | `lockCustomer` removed from `reverseForRefund`                                | `referrals.test.ts` › never takes the referrer below zero when they spend while a reversal is being decided                                                                                                                                                                    | KILLED |
| WP9-21 | a referrer's totals report what went unrecovered                        | `totalsForReferrer`'s `unrecovered` sums `due_amount` instead                 | `referrals.test.ts` › records what a spent referrer balance cannot cover as unrecovered, and never takes it below zero                                                                                                                                                         | KILLED |
| WP9-22 | every referral read needs `referrals.view`                              | the guard check removed from `ReferralReadService.list`                       | `referrals.test.ts` › answers 403 on all three routes without referrals.view, and 200 with it                                                                                                                                                                                  | KILLED |
| WP9-23 | another tenant's customer is NOT FOUND, never an empty summary          | the not-found throw kept only for a malformed id; a foreign id is summarised  | `referrals.test.ts` › keeps tenants apart: another tenant’s operator lists none of these rows and is told the customer does not exist                                                                                                                                          | KILLED |
| WP9-24 | the `/wallet` invite button is drawn only while the program is active   | `referring` set from whether `terms` answered at all, not from `active`       | `referrals.test.ts` › draws the referral button on /wallet only while the program is active                                                                                                                                                                                    | KILLED |
| WP9-25 | the customer referral card issues no request without `referrals.view`   | the card's query `enabled` forced on                                          | `referrals.test.tsx` › names the key and issues no request without referrals.view                                                                                                                                                                                              | KILLED |
| WP9-26 | a commission's scope column names the scope it was promised under       | `COMMISSION_SCOPE_LABELS.FIRST_PAID_ORDER` pointed at the every-order label   | `referrals.test.tsx` › renders every figure as money in its own currency                                                                                                                                                                                                       | KILLED |

**WP9-14 and WP9-15 die on the database, not on an assertion.** Both mutations let a
second first-order commission of one referral reach `earn`. The partial unique index
`order_referral_commissions_first_earned_key` refuses it with `23505`, and the test fails
on that error. That is the index doing its job as the backstop. The service rule is still
falsified: with it reverted, the sweep throws on the second commission every tick.

**WP9-19 and WP9-20 were re-run after the race test was corrected.** The first pass
killed both, but only on the test's blocking witness, and it found why. The blocker had
inserted its colliding ledger row for the REFERRER. Through `wallet_entries_customer_fk`
that row takes `FOR KEY SHARE` on the referrer's customer row, so the earner waited at
`lockCustomer`, before it had read a refund, and not at its ledger insert as the test
claimed. That was checked with `pg_locks` at the second `awaitBlocked`. So the interleaving
the rule exists for was never built.

The test was changed in three ways:

- **The blocker's row belongs to a bystander.** The earner still waits on the per-tenant
  unique reference, but only after it has taken the referrer's lock and read the refunds.
- **The premise is asserted.** Exactly one backend waits on a lock in
  `insert into "wallet_entries"`. With the blocker's row put back on the referrer, that
  assertion fails with 0.
- **The blocker is released only once the completion has got as far as it can.** That
  means either queued behind the earner, or already committed. Releasing earlier lets the
  earner commit first, and the completion then reads `EARNED` whichever way the rule is
  written.

Re-run against the corrected test:

- **WP9-19** now dies on money: "half the payment stands, so half the promise: expected
  10000n to be 5000n". The completion judged the unlocked `PENDING`, walked away and
  committed, and the earner's full credit stood.
- **WP9-20** survives it, and that is correct. The completion also takes the commission
  row's own lock, which the earner holds, so the order is still enforced. What the
  referrer's lock adds is a consistent balance read. It now has its own case, a debit of
  the referrer's whole balance that holds their row while the reversal arrives, and dies
  there: "the balance never goes below zero: expected -5000n to be 0n". The row above
  cites that case.

**The same correction was ported to WP8-16.** `cashback.test.ts` › never misses a reversal
when a refund completes while the earner is mid-credit had the identical premise, with its
blocker's row on the credited customer. It gets the same three changes. WP8-16's mutation,
the unlocked early return widened to anything not `EARNED`, now dies on "expected 10000n
to be 5000n", not on the witness.

**What these rows do not cover:**

- **Earned exactly once.** This is the same answer as WP8's cashback: three independent
  guards, each sufficient. They are the conditional `PENDING -> EARNED` update, the
  ledger's unique `${orderId}:referral` reference, and the referrer's wallet lock.
  Removing any one leaves the other two, so no single mutation falsifies it.
  `referrals.test.ts` › earns nothing before delivery, then credits the REFERRER once
  with REFERRAL_COMMISSION referenced <orderId>:referral shows the combination holds.
- **The database guards** on referrals, codes, commissions and reversals. These are the
  triggers and indexes in migration `0108`. The tests assert the database refuses each
  write directly; they are not mutated here.
- **The `created` flag's source.** `CustomerService` passes its own transaction's
  `created` answer to `attributeOnArrival`. The rows mutate the consumer (WP9-01), not
  the producer.
