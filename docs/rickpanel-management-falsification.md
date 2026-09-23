# RickPanel service management — falsification record

Plan §6.1: for the operations the RickPanel adapter already has — renew, add traffic,
add time, suspend, resume, terminate — prove through the APPLICATION layer that Nexa
and the panel agree, that money moves once, that a replay converges, and that the
panel's operability is decided again before anything is sent.
`tests/integration/rickpanel-management.test.ts` is that proof; it runs the shipped
container, settlement and provisioner against `tests/support/fake-rickpanel.ts`.

Each rule was reverted alone, the named suite was run, and the file was restored
byte-for-byte (`cmp`) before the next mutation.

| #     | rule                                                               | mutation                                                                 | tests that die                                                                                                                                                                                                                                                                                                                                        | result |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| RM-01 | operability is decided again before a commercial operation is sent | the provisioner's operability refusal skipped for `RENEW`                | `rickpanel-management.test.ts` › decides the panel again before writing: a renewal on a panel disabled since it was paid sends nothing and is refunded once                                                                                                                                                                                           | KILLED |
| RM-02 | a 5xx on the allowance write is retryable, not a refusal           | the adapter's non-2xx answer to the allowance `PUT` → `PROVIDER_REFUSED` | `rickpanel-management.test.ts` › converges when a renewal was applied and its answer lost: the replay sets, it does not add                                                                                                                                                                                                                           | KILLED |
| RM-03 | a time-only package sends no data limit                            | the `trafficLimitBytes !== null` guard on `data_limit` removed           | `rickpanel-management.test.ts` › adds traffic without touching the expiry, and adds time without touching the traffic                                                                                                                                                                                                                                 | KILLED |
| RM-04 | the expiry sent is the stored absolute target                      | the `expire` sent is the target plus one day                             | `rickpanel-management.test.ts` › renews: charged once, applied once, and Nexa and the panel agree; `rickpanel-management.test.ts` › adds traffic without touching the expiry, and adds time without touching the traffic; `rickpanel-management.test.ts` › converges when a renewal was applied and its answer lost: the replay sets, it does not add | KILLED |
| RM-05 | suspend disables the account on the panel                          | `suspendUser` sends `status: 'active'`                                   | `rickpanel-management.test.ts` › suspends, resumes and terminates, and the panel agrees at every step                                                                                                                                                                                                                                                 | KILLED |
| RM-06 | a renewal extends by exactly what was bought                       | `extendedExpiry` adds one day more than the purchase                     | `rickpanel-management.test.ts` › renews: charged once, applied once, and Nexa and the panel agree; `rickpanel-management.test.ts` › adds traffic without touching the expiry, and adds time without touching the traffic                                                                                                                              | KILLED |
| RM-07 | an add-on is charged its own price                                 | an add-on's quote charges five times its price                           | `rickpanel-management.test.ts` › adds traffic without touching the expiry, and adds time without touching the traffic                                                                                                                                                                                                                                 | KILLED |

RM-06 and RM-07 answer the one Codex review of PR #63, which found three assertions that
proved agreement or cardinality rather than the entitlement: the renewal now asserts the
exact expiry and allowance the plan bought, the add-on case asserts each debit's amount,
and the disabled-panel case asserts that no request at all reached the panel. RM-01 and
RM-04 were re-run against the strengthened tests and still kill them.

RM-01's test was renamed after the run — "…and is refunded once" was appended once its
exact assertions replaced a diagnostic — and the body RM-01 killed is the body it has.

What these rows cannot show is that the real panel behaves like the fake. The fake
applies a `PUT` and then answers 500 when told to lose an answer; whether a real
RickPanel can do that is the premise, not a finding. `tests/acceptance/real-panel-rickpanel.test.ts`
is the check against the real binary, and it has not been run: no disposable RickPanel
was available to this work.
