# TB8 — falsification record

Driver: `scripts/mutate-tb8.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. Run on 2026-10-05 against a dedicated integration database
(`nexa_test_tb89`).

| ID     | Rule reverted                                                                  | Test that failed                                                                   | Result |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------ |
| TB8-01 | The context reads `state = 'APPROVED'` (in SQL)                                | a draft, a disabled and a retired article never reach the context                  | KILLED |
| TB8-02 | The context reads `enabled` (in SQL)                                           | a draft, a disabled and a retired article never reach the context                  | KILLED |
| TB8-03 | The TB3 builder reads approved knowledge at all                                | approve publishes ONE article … the context carries it                             | KILLED |
| TB8-04 | Reject only from `PENDING` (service check and the SQL predicate, together)     | approve publishes ONE article … (a later reject is `not_in_state`)                 | KILLED |
| TB8-05 | Approve names the version read (service check and the SQL predicate, together) | a stale version is refused and publishes nothing                                   | KILLED |
| TB8-06 | The idempotent replay                                                          | approve publishes ONE article … a replay publishes once                            | KILLED |
| TB8-07 | Every write charges `support_knowledge.review`                                 | permissions: support views and proposes but cannot review; the denial is audited   | KILLED |
| TB8-08 | The candidate lookup is tenant-scoped                                          | tenant isolation                                                                   | KILLED |
| TB8-09 | `ScopeActivityReader` inside the review transaction                            | a stopped tenant takes no review                                                   | KILLED |
| TB8-10 | An approval's text is scrubbed, edited or not                                  | an approval whose text still holds personal data is refused                        | KILLED |
| TB8-11 | An edit of approved knowledge is a new revision                                | a draft, a disabled and a retired article … an edit is a new revision              | KILLED |
| TB8-12 | The conversation is scrubbed BEFORE the provider                               | the provider never reads the customer's phone                                      | KILLED |
| TB8-13 | A scrubber hit in the output is rejected automatically                         | a scrubber hit in the model's output is rejected automatically and stored redacted | KILLED |
| TB8-14 | AI OFF: a handback enqueues nothing                                            | AI OFF: a handback enqueues nothing, a proposal is refused, …                      | KILLED |
| TB8-15 | AI OFF: a queued job extracts nothing                                          | AI OFF: … a queued job extracts nothing                                            | KILLED |
| TB8-16 | One job per conversation per 24 hours                                          | an explicit proposal is idempotent on the reply, and the 24-hour window refuses    | KILLED |
| TB8-17 | The near-duplicate (trigram) merge                                             | a NEAR duplicate (trigram) merges too                                              | KILLED |
| TB8-18 | Title normalisation folds Arabic ي/ى                                           | normalises Arabic letters, digits, … (unit)                                        | KILLED |
| TB8-19 | Only a DELIVERED reply teaches                                                 | only a DELIVERED reply an operator wrote, in that conversation, can be proposed    | KILLED |
| TB8-20 | A handback enqueues a learning job                                             | a handback learns a PENDING candidate …                                            | KILLED |
| TB8-21 | The `assistant` role runs learning jobs                                        | a handback learns a PENDING candidate …                                            | KILLED |
| TB8-22 | The purge waits for the retention                                              | the retention purges the text of candidates never approved                         | KILLED |
| TB8-23 | Persian digits are folded before matching                                      | an Iranian mobile in Persian digits → PHONE (and three more, unit)                 | KILLED |
| TB8-24 | A 16-digit run is a CARD                                                       | a card number → CARD (and two more, unit)                                          | KILLED |
| TB8-25 | «ویرایش و تأیید» sends the edited text (web)                                   | edit then approve sends the EDITED text, not the proposal                          | KILLED |
| TB8-26 | Reject never calls the approve route (web)                                     | reject sends no edit, and never the approve route                                  | KILLED |
| TB8-27 | No write control without `support_knowledge.review` (web)                      | draws no write control without the review permission                               | KILLED |
| TB8-28 | One learning job per claim, leased from its own claim (TB5 review, finding 4)  | claims learning jobs ONE per claim, each leased from its own claim (unit)          | KILLED |

**28 of 28 killed** on the restack onto the reviewed TB5 (PR #200): TB8-21's anchor moved with
the loop's one-per-claim learning pass, and TB8-28 was added for it. Before that, **27 of 27
killed.** TB8-07 and TB8-08 were re-run after their anchors were corrected for
prettier's line breaks (the first pass reported `ANCHOR MISSING`, which the driver counts as
not run). `scripts/mutate-tb7.py` TB7-20's anchor moved because the handback now calls the
learning trigger after resolving the handoff signal; it still kills.

Notes:

- **TB8-04 and TB8-05 are pairs, on purpose.** The state and the version are checked twice:
  by the service after its read, and in the conditional UPDATE. Reverting either half alone
  survives, because the other refuses with the same code. The schema's shape CHECKs (an
  approved candidate has an article; a rejected one has a reason) are a third line, not
  mutated here.
- **The exact duplicate is a unique index.** TB8-17 removes only the trigram check; the exact
  match still merges through the index's `ON CONFLICT DO NOTHING` path, which the "merges as
  an extra source" test covers.
- **Not mutated:** the per-tenant hourly cap (no test enqueues 30 jobs), the append-only
  trigger on revisions (asserted by the integration test, but it is SQL in `0207`), and the
  `dropped_scope` path of `produce` (no test stops a tenant mid-extraction). This record claims
  nothing about them.
