# Phase 5A falsification record

Every rule 5A adds, mutated in the working tree, with the committed test that died.
Each mutation was reverted byte-for-byte and the suite re-run green.

Suites: `tests/unit/payment-account-validation.test.ts` (no database) and
`tests/integration/payment-accounts.test.ts` (real PostgreSQL).

## The validators

| #      | Rule                                                                                   | Mutation                                                                     | Named test                                                                                            | Result           |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| F5A-01 | A card number must pass its Luhn check digit                                           | `isValidCardNumber` returns `sum >= 0` rather than `sum % 10 === 0`          | `payment-account-validation.test.ts` › refuses a transposed pair through the check digit              | KILLED, 2 failed |
| F5A-02 | mod-97 is computed digit by digit, never through `Number`                              | `isValidIban` returns `Number(rearranged) % 97 === 1`                        | `payment-account-validation.test.ts` › refuses a wrong check digit through mod-97                     | KILLED, 2 failed |
| F5A-03 | Normalisation keeps digits and letters rather than dropping a listed set of separators | `NOISE` becomes `/[ \t-]/gu`, the deny-list that forgets the invisible marks | `payment-account-validation.test.ts` › removes the separators a human types, including invisible ones | KILLED, 1 failed |
| F5A-04 | An empty-string Sheba means "no Sheba", not "a Sheba that is empty"                    | the `value.trim() === ''` branch removed                                     | `payment-account-validation.test.ts` › treats an absent, null or empty Sheba as no Sheba              | KILLED, 1 failed |

F5A-02 was killed by the positive assertion `isValidIban(SHEBA)` in the named test — the
`Number` overflow fails a VALID Sheba too — not by the row written for it.

## The destination

| #      | Rule                                                                     | Mutation                                                              | Named test                                                                            | Result           |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------- |
| F5A-05 | Only an ENABLED account may be selected as a destination                 | `selectDestination` drops `eq(paymentAccounts.enabled, true)`         | `payment-accounts.test.ts` › refuses a manual transfer when no enabled account exists | KILLED, 1 failed |
| F5A-06 | No enabled account is a REFUSAL, never a payment with blank instructions | the `PAYMENT_DESTINATION_UNCONFIGURED` throw made unreachable         | `payment-accounts.test.ts` › refuses a manual transfer when no enabled account exists | KILLED, 1 failed |
| F5A-07 | A re-issued payment READS its snapshot; it never re-derives one          | `instructionFor` calls `selectDestination` instead of `findByPayment` | `payment-accounts.test.ts` › survives an edit of the account it was taken from        | KILLED, 2 failed |
| F5A-08 | The default account cannot be disabled                                   | the `!input.enabled && before.isDefault` guard made unreachable       | `payment-accounts.test.ts` › refuses to disable the default, from either end          | KILLED, 1 failed |
| F5A-09 | A destination line whose field is absent is not composed                 | the renderer composes `value ?? ''` instead of skipping               | `payment-accounts.test.ts` › renders every configured line and omits the absent one   | KILLED, 1 failed |

F5A-05 and F5A-06 share one test — a gap, named rather than hidden: the case disables
every account, so an unfiltered selection and a missing refusal both surface there.

## Held by the database, not by TypeScript

Exercised directly against PostgreSQL and asserted by `refuses a malformed card number
and a malformed Sheba at the table too` and `refuses to update or delete a snapshot, in
the database`:

- `payment_accounts_tenant_default_key`, `payment_accounts_default_enabled_check`,
  `payment_accounts_tenant_card_key` (partial, on `enabled`)
- `payment_accounts_card_number_check` / `payment_accounts_iban_check`
- `payment_destinations_no_update` / `payment_destinations_no_delete` (migration 0063)

Asserted through the `cause` chain, not Drizzle's outer message — that message is the
failed SQL and would match any failure.

## The Codex round on PR #34

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

Two of these tests did not bite in their first version: `answers a disable that lost to a
promotion` and `returns the CURRENT row when a concurrent disable won` committed the
competing change before the service ran, so the pre-check refused and the branch under
test was never reached. Both were rewritten to hold a `FOR UPDATE` row lock across the
service call — the technique `customer-order-actions.test.ts` uses for this window, and
the third time on this project a race test has needed it.

F5A-13's mutation also kills F5A-12's test (both rules share the null branch), so F5A-12
is the weaker signal of the pair.

### C8 — the per-tenant limit under concurrency

The owner overruled the earlier "the race is acceptable" answer. `lockForCreate` takes a
tenant-scoped, transaction-scoped advisory lock before the count; the rationale is above
`lockForCreate` in `account-ports.ts`.

| #      | Rule                                                 | Mutation                                      | Named test                                                                               | Result |
| ------ | ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| F5A-20 | The per-tenant account limit holds under concurrency | Delete the `lockForCreate` call from `create` | `payment-accounts.test.ts` › refuses the second of two concurrent creates at the ceiling | dies   |
| F5A-21 | The lock is keyed on the TENANT, not on a constant   | Replace `hashtext(tenantId)` with `0`         | `payment-accounts.test.ts` › refuses the second of two concurrent creates at the ceiling | dies   |

Both mutations kill the ceiling test and neither kills `lets another tenant create while
this tenant holds the lock` — the holder takes `(CLASS, hashtext(tenantA))` explicitly, so
a constant-keyed production lock blocks nothing. No single-line mutation kills only the
isolation case.
