# Phase 4C — falsification record

Every production rule this branch adds, reverted one at a time and the test that
dies named. A rule with no test is a rule that will be silently reverted; a claim
about testing that leaves no test behind is worse than no claim.

The harness is `scripts/falsify.sh` — label, file, the exact text replaced, the
replacement, the test file, the vitest project. It refuses a file with
uncommitted changes, restores by `git checkout --`, and fails the run if the tree
is not byte-identical afterwards.

This is a BOUNDED record of the rules this phase adds, not a mutation catalogue.

## What the wallet round found

**Two rules had no test, and both were found by mutation rather than by reading.**

- **W12** — `adjust` charging `users.wallet.credit` for a DEBIT left the suite
  green. The permission test used a `support` actor, which holds NEITHER wallet
  permission, so it was refused either way: the test proved that _some_
  permission is charged, never that the direction picks which one. `finance` is
  the actor that can tell them apart — it holds `users.wallet.credit` and not
  `users.wallet.debit` — and it now credits successfully and is refused the debit
  in the same case, with both audit rows pinned in order. This is the shape
  `CLAUDE.md` records from Phase 4B as "a test that asserted the wrong half",
  found here before it reached a review.
- **W15** — removing `assertScopeActive` from inside the committing transaction
  left the suite green, and that is a stated non-negotiable: every write path
  reads `ScopeActivityReader` INSIDE its transaction, because a surface checks
  activity when the request arrives and a stop can commit in between. Panels is
  the module that skipped it and gave a stopped tenant new panels and a
  background monitor. Here it would have been new money.

**One mutation was a bad aim rather than a missing test.** W06 replaced
`.onConflictDoNothing({ target: … })` with a bare `.onConflictDoNothing()`, which
is behaviourally identical while `wallet_entries_tenant_reference_key` is the
only unique index the insert can violate — so SURVIVED said nothing about
coverage. W06b removes the conflict handling outright, which is the rule, and
kills two cases. Recorded rather than quietly replaced, because a SURVIVED whose
cause is the harness's aim is as misleading as a real one.

## The wallet ledger

| #    | Rule                                                                       | Mutation                                                    | Test that dies                                                                                      | Result |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| W01  | A DEBIT subtracts. The sign lives in `direction` and is applied once       | `signedMinor`'s `DEBIT` → `return amountMinor`              | `wallet.test.ts` › agrees with the TypeScript sign rule over every direction                        | KILLED |
| W02  | The SQL sum applies the same sign rule as the TypeScript one               | the `ELSE -amount` → `ELSE amount`                          | `wallet.test.ts` › derives a balance from the entries, and reports how many produced it             | KILLED |
| W03  | A balance is exact past 2^53                                               | `BigInt(row.balance)` → `BigInt(Number(row.balance))`       | `wallet.test.ts` › keeps a balance EXACT past the precision of a JavaScript number                  | KILLED |
| W04  | A balance is per CURRENCY and never sums across them                       | the currency predicate removed from `balanceOf`             | `wallet.test.ts` › answers per CURRENCY, and never sums across them                                 | KILLED |
| W05  | A reference lookup carries the tenant                                      | `and(tenantId, reference)` → `reference` alone              | `wallet.test.ts` › cannot see, sum or address another tenant’s entries                              | KILLED |
| W06b | A movement is idempotent at the unique index, not in a process             | the whole `.onConflictDoNothing(…)` removed                 | `wallet.test.ts` › moves money ONCE for a repeated reference, and returns the first entry           | KILLED |
| W07  | The keyset cursor is PostgreSQL microsecond text, not a `Date`             | `last.createdAtText` → `last.createdAt.toISOString()`       | `wallet.test.ts` › pages over MICROSECONDS, so two entries inside one millisecond do not straddle   | KILLED |
| W08  | An amount is greater than zero and within the ceiling, at the SERVICE      | `this.assertLedgerAmount(input.amountMinor)` removed        | `wallet.test.ts` › refuses an amount of zero or past the ceiling, as a refusal and not a 500        | KILLED |
| W09  | A wallet does not go below zero                                            | `if (!canCover(…))` → `if (false)`                          | `wallet.test.ts` › refuses a debit the balance cannot cover, and names the SHORTFALL                | KILLED |
| W10  | An amount is denominated in `sales.currency`, and nothing converts         | `if (input.currency !== selling)` → `if (false)`            | `wallet.test.ts` › refuses a currency this installation does not sell in                            | KILLED |
| W11  | The ledger reason is derived from the direction, never named by the caller | `CREDIT: 'ADMIN_CREDIT'` → `CREDIT: 'PURCHASE'`             | `wallet.test.ts` › credits once for a repeated command, and commits the audit and the event with it | KILLED |
| W12  | CREDIT and DEBIT charge their OWN permissions                              | the direction ternary → `WALLET_CREDIT_PERMISSION`          | `wallet.test.ts` › charges the direction’s OWN permission, and audits the refusal                   | KILLED |
| W13  | A refusal before the replay still leaves an audit row                      | `recordMutationDenial(…)` removed from `authorize`          | `wallet.test.ts` › charges the direction’s OWN permission, and audits the refusal                   | KILLED |
| W14  | A movement's reference is DERIVED from the idempotency key, not generated  | `operationId(key)` → `ids.uuid()`                           | `wallet.test.ts` › derives the same reference from the same key, with no lookup                     | KILLED |
| W15  | Scope activity is read INSIDE the committing transaction                   | `await this.assertScopeActive(scope, tx)` removed           | `wallet.test.ts` › refuses an installation that has stopped accepting work                          | KILLED |
| W16  | The domain event commits with the entry                                    | `eventType: 'WalletEntryRecorded'` → `'CustomerRegistered'` | `wallet.test.ts` › credits once for a repeated command, and commits the audit and the event with it | KILLED |

Sixteen mutations run, fifteen rules covered. W06 is not a row here: a table of
citations is a table of rules with tests, and W06 names none — it is the bad aim
recorded above, and W06b is the mutation that states its rule.

Two rules in this module are NOT falsifiable through this harness because they
are not in TypeScript: `wallet_entries_no_update` and `wallet_entries_no_delete`
are database triggers, and the test that proves them issues a raw `UPDATE` and
`DELETE` through the pg client rather than through the repository — the
repository has no method that could be mutated, which is the point.
