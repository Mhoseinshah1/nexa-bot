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
