# TB3 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb3.py`, and the
named test was run against the mutant. The run was on 2026-10-04 against the TB3 head, with
`TEST_DATABASE_URL=…/nexa_test_tb3`. **13 of 13 were killed.** The tree was clean after
every restore, and the contract was rebuilt after TB3-08.

| Id     | Rule reverted                                                                               | Killed by                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TB3-01 | `recentOrders` filters by the customer                                                      | `support-context.test.ts`: gives the exact customer their own services, orders and payments — never another customer’s or tenant’s |
| TB3-02 | `recentPayments` filters by the tenant                                                      | `support-context.test.ts`: every reader puts the tenant in its WHERE                                                               |
| TB3-03 | `activeIncidentNotices` filters by the tenant                                               | `support-context.test.ts`: every reader puts the tenant in its WHERE                                                               |
| TB3-04 | The customer page hides a service refunded away (`notRefundedAway` in `pageForCustomer`)    | `support-context.test.ts`: a service refunded away at the customer’s request is not in the context                                 |
| TB3-05 | A PENDING payment the customer signalled is under review                                    | `support-context.test.ts`: under review: UNKNOWN, and PENDING the customer signalled                                               |
| TB3-06 | An UNKNOWN payment is under review                                                          | `support-context.test.ts`: under review: UNKNOWN, and PENDING the customer signalled                                               |
| TB3-07 | The under-review flag is computed over all of the customer's payments (window before LIMIT) | `support-context.test.ts`: the under-review flag reads ALL payments, not only the five shown                                       |
| TB3-08 | The allowlist excludes the subscription URL (contract **and** builder widened together)     | `support-context.test.ts`: gives the exact customer … (the URL is found in the JSON)                                               |
| TB3-09 | The strict parse refuses a key the contract does not list (builder alone emits the URL)     | `support-context.test.ts`: gives the exact customer … (the build throws)                                                           |
| TB3-10 | A null customer's payload claims no identity                                                | `support-context.test.ts`: customerId null: no account facts at all, only public support                                           |
| TB3-11 | A null customer takes the public branch and no account reader runs                          | `support-context-payload.test.ts`: a null customer gets public support only, and no account reader is asked                        |
| TB3-12 | A LOCATION target matches only the location's own panel                                     | `support-context.test.ts`: incident matching agrees with the notice audience, target shape by target shape                         |
| TB3-13 | Truncation drops entries from the tail of a family, not the head                            | `support-context-payload.test.ts`: truncation drops whole entries from the tail, family by family, in the documented order         |

Notes:

- **TB3-08 and TB3-09 are two different guards.** TB3-09 shows that the builder cannot add a
  field on its own, because the strict schema throws. TB3-08 shows that widening the
  contract as well is still caught, because the integration test asserts the seeded URL is
  absent from the JSON. The unit allowlist snapshot is a third guard on the same change,
  and TB3-08 would also fail it.
- **TB3-11 is killed by a crash, not by an assertion about which readers ran.** Without the
  public branch, the builder dereferences the null customer before any account reader
  runs. The assertion `asked` stays as the guard for a refactor that dereferences safely.
- **Not mutated: the `DRAFT` exclusion** (`OQ-TB-13`). It is a product decision recorded
  as open, and has no test yet.
- **Not mutated: the `PARTIAL` / `LATE_COMPLETION` arm of `underReview`.** It needs a
  `gateway_invoices` fixture, and it is open (`OQ-TB-12`).
