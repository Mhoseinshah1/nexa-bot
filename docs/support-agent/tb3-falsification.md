# TB3 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb3.py`, and the
named test was run against the mutant. The run was on 2026-10-04 against the TB3 head, with
`TEST_DATABASE_URL=…/nexa_test_tb3`. **13 of 13 were killed.** The tree was clean after
every restore, and the contract was rebuilt after TB3-08.

| Id     | Rule reverted                                                                                                        | Killed by                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TB3-01 | `recentOrders` filters by the customer                                                                               | `support-context.test.ts`: gives the exact customer their own services, orders and payments — never another customer’s or tenant’s |
| TB3-02 | `recentPayments` filters by the tenant                                                                               | `support-context.test.ts`: every reader puts the tenant in its WHERE                                                               |
| TB3-03 | `activeIncidentNotices` filters by the tenant                                                                        | `support-context.test.ts`: every reader puts the tenant in its WHERE                                                               |
| TB3-04 | The customer read hides a service refunded away (`notRefundedAway` in `supportServicesForCustomer` since the review) | `support-context.test.ts`: a service refunded away at the customer’s request is not in the context                                 |
| TB3-05 | A PENDING payment the customer signalled is under review                                                             | `support-context.test.ts`: under review: UNKNOWN, and PENDING the customer signalled                                               |
| TB3-06 | An UNKNOWN payment is under review                                                                                   | `support-context.test.ts`: under review: UNKNOWN, and PENDING the customer signalled                                               |
| TB3-07 | The under-review flag is computed over all of the customer's payments (its own `LIMIT 1` statement since the review) | `support-context.test.ts`: the under-review flag reads ALL payments, not only the five shown                                       |
| TB3-08 | The allowlist excludes the subscription URL (contract **and** builder widened together)                              | `support-context.test.ts`: gives the exact customer … (the URL is found in the JSON)                                               |
| TB3-09 | The strict parse refuses a key the contract does not list (builder alone emits the URL)                              | `support-context.test.ts`: gives the exact customer … (the build throws)                                                           |
| TB3-10 | A null customer's payload claims no identity                                                                         | `support-context.test.ts`: customerId null: no account facts at all, only public support                                           |
| TB3-11 | A null customer takes the public branch and no account reader runs                                                   | `support-context-payload.test.ts`: a null customer gets public support only, and no account reader is asked                        |
| TB3-12 | A LOCATION target matches only the location's own panel                                                              | `support-context.test.ts`: incident matching agrees with the notice audience, target shape by target shape                         |
| TB3-13 | Truncation drops entries from the tail of a family, not the head                                                     | `support-context-payload.test.ts`: truncation drops whole entries from the tail, family by family, in the documented order         |

Notes:

- **TB3-08 and TB3-09 are two different guards.** TB3-09 shows that the builder cannot add a
  field on its own, because the strict schema throws. TB3-08 shows that widening the
  contract as well is still caught, because the integration test asserts the seeded URL is
  absent from the JSON. The unit allowlist snapshot is a third guard on the same change,
  and TB3-08 would also fail it.
- **TB3-11 is killed by a crash, not by an assertion about which readers ran.** Without the
  public branch, the builder dereferences the null customer before any account reader
  runs. The assertion `asked` stays as the guard for a refactor that dereferences safely.
- The `DRAFT` exclusion and the `PARTIAL` / `LATE_COMPLETION` arm were left unmutated in the
  first run. They are now pinned (TB3-17, -19 and -20, below).

## Substitute review of PR #198 — every fix, falsified

Codex was unavailable, so one read-only substitute review ran. It found nothing blocking,
six should-fix findings and five nits. All eleven were valid and all are addressed. Each
fix or newly pinned rule has a regression test, and reverting it fails that test. The run
was on 2026-10-05 against `a27d4683`.

| ID     | Finding                                                                                       | Fix                                                                                                                                                | Regression test (`support-context.test.ts`)                                                | Result |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| TB3-14 | 1: `references` kept aliases the byte budget had cut                                          | the maps are built from the aliases that survive in the fitted payload                                                                             | references hold only the aliases that survived the byte budget                             | KILLED |
| TB3-15 | 2: the incident match's customer filter had no test                                           | — (the rule held; a test now pins it)                                                                                                              | an incident on a panel reaches only the customer with a live service there                 | KILLED |
| TB3-16 | 3: the incident match's live-state rule had no test                                           | — (a TERMINATED-only customer joins the `noticePreview` agreement test)                                                                            | incident matching agrees with the notice audience, target shape by target shape            | KILLED |
| TB3-17 | 4: the `state <> 'CONFIRMED'` part of the PARTIAL / LATE_COMPLETION arm had no test           | — (a `gateway_invoices` fixture: PARTIAL on FAILED vs CONFIRMED)                                                                                   | under review, gateway facets: …                                                            | KILLED |
| TB3-18 | 4: the `provider_review_started_at` half of the PENDING arm had no test                       | — (a NOWPayments PENDING with only an open provider review)                                                                                        | under review, gateway facets: …                                                            | KILLED |
| TB3-19 | 4: the `REFUND_RELATED` exclusion of that arm had no test                                     | — (PARTIAL on FAILED with a refund row)                                                                                                            | under review, gateway facets: …                                                            | KILLED |
| TB3-20 | 5: the DRAFT exclusion had no test                                                            | —                                                                                                                                                  | orders: a DRAFT is not in the context; an AWAITING_PAYMENT order is                        | KILLED |
| TB3-21 | 6: the client-app relevance filter had no TB3 test                                            | —                                                                                                                                                  | client apps: an app restricted to another provider is not offered to a customer on Marzban | KILLED |
| TB3-22 | 8: the order filter of `serviceCardFacts` had no test                                         | —                                                                                                                                                  | service card facts read only the customer’s own order for a title                          | KILLED |
| TB3-23 | 11: the ten newest services of any state could push live ones out                             | `supportServicesForCustomer`: every non-TERMINATED service first, newest within each; same repository and `notRefundedAway()` as `pageForCustomer` | live services come first: newer TERMINATED ones cannot push an ACTIVE one out of the ten   | KILLED |
| TB3-07 | 9: the flag evaluated the correlated queue subqueries for every payment (`bool_or … OVER ()`) | its own `LIMIT 1` statement over the same predicate; the mutant now reverts it to the shown rows' verdict                                          | the under-review flag reads ALL payments, not only the five shown                          | KILLED |

The other two nits have no rule a mutant could revert:

- **Nit 7.** The no-writes check now also wraps a **linked** build. Nothing in the builder
  writes, so this test guards a future change; there is no fix to revert.
- **Nit 10.** `tb3-support-context.md` now states that aliases are positional per build,
  and that an alias must be resolved only through the same build's `references`, kept
  with the turn.

TB3-04 is re-anchored on `supportServicesForCustomer`, the read the builder now makes. The
whole driver was re-run after the fixes: **23 of 23 killed**, with a clean tree after every
restore.
