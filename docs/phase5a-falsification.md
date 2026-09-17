# Phase 5A falsification record

Every rule 5A adds, mutated in the working tree, with the committed test that died.
Each mutation was reverted byte-for-byte afterwards and the suite re-run green — the
last line of each run below is that check, not a claim about it.

Two suites are involved and they are named per row: `tests/unit/payment-account-validation.test.ts`
(14 cases, no database) and `tests/integration/payment-accounts.test.ts` (20 cases,
against a real PostgreSQL).

## The validators

| #      | Rule                                                                                   | Mutation                                                                     | Named test                                                                                            | Result           |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| F5A-01 | A card number must pass its Luhn check digit                                           | `isValidCardNumber` returns `sum >= 0` rather than `sum % 10 === 0`          | `payment-account-validation.test.ts` › refuses a transposed pair through the check digit              | KILLED, 2 failed |
| F5A-02 | mod-97 is computed digit by digit, never through `Number`                              | `isValidIban` returns `Number(rearranged) % 97 === 1`                        | `payment-account-validation.test.ts` › refuses a wrong check digit through mod-97                     | KILLED, 2 failed |
| F5A-03 | Normalisation keeps digits and letters rather than dropping a listed set of separators | `NOISE` becomes `/[ \t-]/gu`, the deny-list that forgets the invisible marks | `payment-account-validation.test.ts` › removes the separators a human types, including invisible ones | KILLED, 1 failed |
| F5A-04 | An empty-string Sheba means "no Sheba", not "a Sheba that is empty"                    | the `value.trim() === ''` branch removed                                     | `payment-account-validation.test.ts` › treats an absent, null or empty Sheba as no Sheba              | KILLED, 1 failed |

**F5A-02 is recorded with a correction to what killed it.** The row written for it —
`computes mod-97 over the whole twenty-six characters`, which changes the LAST digit —
still passed under the mutation, by coincidence. What killed the mutation is the
POSITIVE assertion `isValidIban(SHEBA)` inside `refuses a wrong check digit through
mod-97`: the `Number` overflow makes a VALID Sheba fail too. The test named above is
therefore the one that died, and the one written for the overflow did not.

## The destination

| #      | Rule                                                                     | Mutation                                                              | Named test                                                                            | Result           |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------- |
| F5A-05 | Only an ENABLED account may be selected as a destination                 | `selectDestination` drops `eq(paymentAccounts.enabled, true)`         | `payment-accounts.test.ts` › refuses a manual transfer when no enabled account exists | KILLED, 1 failed |
| F5A-06 | No enabled account is a REFUSAL, never a payment with blank instructions | the `PAYMENT_DESTINATION_UNCONFIGURED` throw made unreachable         | `payment-accounts.test.ts` › refuses a manual transfer when no enabled account exists | KILLED, 1 failed |
| F5A-07 | A re-issued payment READS its snapshot; it never re-derives one          | `instructionFor` calls `selectDestination` instead of `findByPayment` | `payment-accounts.test.ts` › survives an edit of the account it was taken from        | KILLED, 2 failed |
| F5A-08 | The default account cannot be disabled                                   | the `!input.enabled && before.isDefault` guard made unreachable       | `payment-accounts.test.ts` › refuses to disable the default, from either end          | KILLED, 1 failed |
| F5A-09 | A destination line whose field is absent is not composed                 | the renderer composes `value ?? ''` instead of skipping               | `payment-accounts.test.ts` › renders every configured line and omits the absent one   | KILLED, 1 failed |

F5A-05 and F5A-06 are killed by the SAME test, and that is worth stating rather than
hiding: the case disables every account and then asks for a transfer, so an unfiltered
selection and a missing refusal both surface there. They are separate rules — one is
"which row is chosen", the other "what happens when there is none" — and a single test
covering both is a gap a later change could widen. F5A-07's second casualty,
`survives the account being disabled`, is the same rule from the other side.

## What was probed against the database rather than mutated

Five constraints and two triggers cannot be falsified by editing TypeScript, because
they are not in TypeScript. They were exercised directly against PostgreSQL before the
schema commit and are asserted by the suite afterwards:

- `payment_accounts_tenant_default_key` — a second default is refused
- `payment_accounts_default_enabled_check` — a disabled default is refused
- `payment_accounts_tenant_card_key` — a duplicate ENABLED card is refused, and the same
  card is accepted once the live one is disabled
- `payment_accounts_card_number_check` / `payment_accounts_iban_check` — a 15-digit card
  and a `DE00` Sheba are refused, asserted through the `cause` chain rather than
  Drizzle's outer message, which is the SQL text and would match any failure
- `payment_destinations_no_update` / `payment_destinations_no_delete` (migration 0063) —
  both refused, asserted the same way

`refuses a malformed card number and a malformed Sheba at the table too` and `refuses to
update or delete a snapshot, in the database` are the tests.

## The Codex round on PR #34

Ten findings, all P2. Seven were confirmed and fixed; the mutations below are the proof
that the fixes are load-bearing rather than decorative, and each names the test that
dies. Three findings are answered without a code change and are recorded at the bottom
with the reason.

Two of these rows are here because the FIRST version of their test did not bite.
`answers a disable that lost to a promotion` and `returns the CURRENT row when a
concurrent disable won` were written as raw-SQL setups that committed the competing
change BEFORE the service ran — so the service's own pre-check refused, the branch under
test was never reached, and both passed with the fix reverted. They were rewritten to
hold a `FOR UPDATE` row lock, the technique `customer-order-actions.test.ts` already uses
for the same shape of window: the service's plain SELECT is not blocked and reads the old
row, its UPDATE blocks, and the competing change commits in between. That is the third
time on this project that a race test has had to be rewritten for exactly this reason.

| #      | Rule                                                                    | Mutation                                                                                                                           | Named test                                                                                                     | Result |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| F5A-10 | A create's idempotency hash covers `makeDefault`                        | Drop `makeDefault` from `hashRequest`                                                                                              | `payment-accounts.test.ts` › treats a create differing only in makeDefault as a MISMATCH, not a replay         | dies   |
| F5A-11 | `enabled: false` with `makeDefault: true` is refused, not half-applied  | Delete the refusal, restoring `input.enabled && (...)` as the only filter                                                          | `payment-accounts.test.ts` › refuses to create a disabled account as the default                               | dies   |
| F5A-12 | A disable is conditional on the row not being the default               | Remove `is_default = false` from `setEnabled`'s predicate                                                                          | `payment-accounts.test.ts` › answers a disable that lost to a promotion with a refusal, not a constraint error | dies   |
| F5A-13 | A conditional update that matched nothing is re-read, never assumed     | Restore `return before` in place of the re-read                                                                                    | `payment-accounts.test.ts` › returns the CURRENT row when a concurrent disable won                             | dies   |
| F5A-14 | A lost default-selection race has its own retryable code                | Map `payment_accounts_tenant_default_key` back to `PAYMENT_ACCOUNT_DUPLICATE`                                                      | `payment-accounts.test.ts` › names a lost default-selection race distinctly from a duplicate card              | dies   |
| F5A-15 | Check digits are enforced by the table, not only the schema             | `ALTER TABLE payment_accounts DROP CONSTRAINT payment_accounts_card_luhn_check, DROP CONSTRAINT payment_accounts_iban_mod97_check` | `payment-accounts.test.ts` › refuses a shape-valid card or Sheba with wrong check digits, in SQL               | dies   |
| F5A-16 | A reissued transfer's audit row names the account it was frozen against | Restore `account?.id ?? null`                                                                                                      | `payment-accounts.test.ts` › records the frozen account id on a reissued manual transfer                       | dies   |
| F5A-17 | The frozen destination reaches the operator's payment detail            | Remove the destination card from the detail page                                                                                   | `payments.test.tsx` › names the account the instructions pointed at                                            | dies   |
| F5A-18 | The controller projects the snapshot, rather than sending null          | `destination: null` in `toDetail`                                                                                                  | `wallet-payments-http.test.ts` › shows the detail with its evidence note, behind payments.view                 | dies   |
| F5A-19 | The payment-accounts screen gates writes on `payments.accounts.edit`    | Draw every control whenever the list read is permitted                                                                             | `payment-accounts.test.tsx` › draws no write control for a role that may only view                             | dies   |

F5A-13's mutation also kills F5A-12's test, because with `return before` restored the
null branch no longer refuses anything. That is reported rather than tidied away: the two
rules share one branch, and a reader should know that the second mutation is the weaker
signal of the pair.

F5A-19's mutation kills three tests, including the route-level one that proves `resolve`
passes the two permissions separately. A page gated correctly behind a route that derived
`mayEdit` from the wrong key would still be wrong, and nothing else would have said so.

### Answered without a code change

- **The per-tenant account limit is not serialised.** `count`-then-insert under READ
  COMMITTED lets two creates at the ceiling both pass, leaving 51. This is a stated
  decision with its reason above `create`: the limit is a rail that keeps the list
  complete rather than a policy anybody buys, and 51 rows is still a complete list
  returned without pagination. Serialising every create behind a tenant lock to hold the
  number exactly costs more than it protects.
- **Nothing else in the review was left unaddressed.** The other nine are the seven rows
  above plus the two web findings, which are one fix each.
