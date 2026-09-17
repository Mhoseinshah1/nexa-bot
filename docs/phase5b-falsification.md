# Phase 5B falsification record

Each rule mutated in the working tree, with the committed test that died. Every mutation
was reverted and the suite re-run green.

| #      | Rule                                                 | Mutation                                           | Named test                                                                                  | Result |
| ------ | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| F5B-01 | The amount is matched against the configured presets | Take `presets[0]` instead of matching              | `wallet-topup.test.ts` › refuses an amount the tenant does not offer                        | dies   |
| F5B-02 | `wallet.topup.minimum` is enforced server-side       | Drop the `chosen < floor` refusal                  | `wallet-topup.test.ts` › refuses a preset below the configured minimum                      | dies   |
| F5B-03 | The credit's reference is derived from the PAYMENT   | Derive it from a fresh uuid instead                | `wallet-topup.test.ts` › credits once when a second operator confirms under a different key | dies   |
| F5B-05 | A payment with no order credits, and settles nothing | Send a null-order confirmation down the order path | `wallet-topup.test.ts` › credits the wallet once when an operator confirms                  | dies   |

**The mutation that did NOT die, recorded rather than dropped.** Forcing the `inserted`
guard around the top-up announcement to `true` left the suite green, so the guard has no
citation row — it is an optimisation, not the invariant:
`customer_notifications_subject_key` is unique on (tenant, kind, subject) and the enqueue
is `ON CONFLICT DO NOTHING`, so the second copy is refused by the index whether the guard
is there or not. The suite proves the OUTCOME — one queued message after a raced
confirmation — which is the property worth protecting; the comment in
`confirmAndCredit` now says which mechanism provides it, because it previously implied
the guard did.
