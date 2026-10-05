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
| TB8-29 | A stopped tenant's learning jobs are not claimed (checked in the claim's tx)   | a stopped tenant: no learning job claimed, no provider call, no write              | KILLED |
| TB8-30 | A stopped tenant's retention pass purges nothing                               | a stopped tenant: the retention is a pass that purges nothing                      | KILLED |
| TB8-31 | A job claimed before a stop asks no provider after it                          | a stopped tenant: no learning job claimed, no provider call, no write              | KILLED |

**31 of 31 killed** on the restack onto the reviewed TB7 (PR #202), where TB8-29..31 were added
for the scope-activity checks of the learning claim, the retention and the provider call.
Before that, **28 of 28 killed** on the restack onto the reviewed TB5 (PR #200): TB8-21's anchor moved with
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
- **Not mutated:** the append-only trigger on revisions (asserted by the integration test,
  but it is SQL in `0208`). The per-tenant hourly cap and the activity check in `produce`'s
  result transaction, listed here before, are now TB8-46 and TB8-58 (below).

## Substitute review of PR #203 — every fix, falsified

One substitute review ran on PR #203. It found no blocking defect, seven should-fix defects and
three nits; all were valid and all are fixed. Each fix has a regression test, and reverting the
fix — one rule at a time — fails that test. Run on 2026-10-05 against `nexa_test_tb8fix`.

| ID             | Finding                                                                                   | Fix                                                                                                                       | Regression test                                                         | Result |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| TB8-32         | F1: `6037  9975  1234  5678` and `6037 – 9975 – 1234 – 5678` passed                        | digit groups may be separated by RUNS of up to three separators, en/em dashes and Arabic separators included              | a card with double spaces (unit)                                         | KILLED |
| TB8-33         | F1: `server: de1.example.com port 443` passed (a §29 server address)                        | the `HOST` kind (contract): any domain, with a port or a path                                                              | a server by name (unit)                                                  | KILLED |
| TB8-34         | F1: `https://x/getSub?id=abc123` passed (short, unlisted token)                             | every URL with a scheme is a hit                                                                                          | a URL with a short unlisted parameter (unit)                             | KILLED |
| TB8-35         | F1: `?t=abcdef` passed                                                                    | a URL with a query, a fragment or userinfo is `URL_TOKEN`                                                                 | a URL with a one-letter parameter (unit)                                 | KILLED |
| TB8-36         | F1: `password is hunter2`, `رمزتون abc123 هست` passed                                      | a secret word followed by a Latin, digit or symbol value, in prose                                                        | a password in prose, a Persian password in prose (unit)                | KILLED |
| TB8-37         | F1: `t.me/ali_reza` passed                                                                | a `t.me/<name>` link is a `USERNAME`                                                                                      | a t.me profile link (unit)                                               | KILLED |
| TB8-38         | F1: `۲۵۰٫۰۰۰ تومان` kept its `250` (U+066B missing from AMOUNT's class)                    | `٫` in the amount's figure class                                                                                          | no figure of an amount survives (unit)                                   | KILLED |
| TB8-39         | F1: `150k` passed                                                                         | a figure in `k`, thousands or millions                                                                                    | an amount in k (unit)                                                    | KILLED |
| TB8-40         | F1: amounts in words passed                                                               | Persian and English number words before a currency word                                                                   | an amount in Persian words (unit)                                        | KILLED |
| TB8-41         | F1: `panel.example.com/sub/abcdef` passed                                                 | a scheme-less `/sub/` path on a domain or an IP is a `SUBSCRIPTION_LINK`                                                  | a scheme-less subscription path (unit)                                   | KILLED |
| TB8-42         | F2: an approved LEARNED article edited with personal data was republished unscrubbed      | `updateArticle` scrubs, whatever the source                                                                               | finding 2                                                               | KILLED |
| TB8-43         | F2 (decided): a MANUAL article was exempt (OQ-TB-54)                                      | `createArticle` scrubs MANUAL articles too — fail closed                                                                  | finding 2                                                               | KILLED |
| TB8-44         | F2: publishing a draft did not scrub                                                      | `publish` scrubs the draft as it is published                                                                             | finding 2                                                               | KILLED |
| TB8-45         | F3: two proposals racing on one conversation both counted zero                            | the enqueue takes `pg_advisory_xact_lock(0x4c4a, hashtext(tenant))` before it counts                                      | finding 3: two proposals racing … exactly one job (barrier)              | KILLED |
| TB8-46         | F3: the hourly cap had no test                                                            | — (the rule held; a test now pins it)                                                                                     | finding 3: thirty jobs in the hour …                                     | KILLED |
| TB8-47, TB8-48 | F4: the approve and reject UPDATEs' predicates survived mutation alone                    | — (the rules held; a barrier race in both orders pins them)                                                               | finding 4: approve and reject racing … (both orders)                    | KILLED |
| TB8-49..52     | F4: each predicate (state, version) of each UPDATE, alone                                 | —                                                                                                                         | finding 4: each conditional UPDATE names both its from-state and version | KILLED |
| TB8-53         | F5: `propose` ignored its idempotency key                                                 | the key is bound to (conversation, reply) by `hashRequest` and `rememberOnce`                                             | finding 5                                                               | KILLED |
| TB8-54, TB8-55 | F6: a purged candidate kept its title and tags                                            | the purge nulls the title (now nullable, contract) and empties the tags; only `normalized_title` stays                    | the retention purges the title, body, rationale and tags …              | KILLED |
| TB8-56         | F7: a SENSITIVE_CONTENT rejection absorbed every later clean proposal of the lesson       | the title index is partial, and the near-duplicate read skips scrubber rejections                                         | finding 7                                                               | KILLED |
| TB8-57         | N1: the reject note reached the audit log unscrubbed                                      | the note is scrubbed before it is audited                                                                                 | nit: the reviewer’s reject note is scrubbed …                            | KILLED |
| TB8-58         | N2: no test stopped the tenant between the provider call and the result write             | — (the rule held; a test now pins it)                                                                                     | nit: a tenant stopped during the provider call …                        | KILLED |
| TB8-59         | N3: anyone holding `propose` could propose another person's reply                         | the proposer must be the reply's author unless they hold `support_knowledge.review`; the refusal is audited as its denial | nit: an operator proposes only their own reply …                        | KILLED |

Notes:

- **F4: why the state and version predicates are each load-bearing only at the repository.**
  Inside one statement the two are redundant for every state the SERVICE can reach: nothing
  advances a candidate's version while it is PENDING (a merge deliberately does not), and every
  transition out of PENDING advances it. So in the barrier race (TB8-47/48, where the service's
  checks have already passed for both decisions) a mutant must remove both predicates of a
  statement to be observable; it is then refused by the shape CHECKs as a raw database error
  where `not_in_state` is required, which is what kills it. Each predicate alone (TB8-49..52)
  is killed by calling the repository directly: a PENDING candidate at another version, and a
  candidate the scrubber REJECTED at the named version — a state the repository can be handed
  even though the service refuses it first. TB8-04 and TB8-05 stay as they were.
- **F3: the barrier is what makes the race deterministic.** Each proposal waits at its first
  count for the other (up to 750 ms). Without the lock both arrive and both count zero; with
  it the second is still waiting for the lock, the first goes on alone, and the second counts
  the first one's job.
- **F6: `normalized_title` is kept, not hashed.** A keyed hash would keep the exact-duplicate
  rule and lose the trigram near-duplicate rule, which needs the folded text. It is the
  twice-scrubbed title folded to a match key, and nothing shows it.
- **Schema:** migration `0207` was regenerated in place (TB8 is unmerged): the `sensitive_kinds`
  CHECK gains `HOST`; `title` is nullable, with the title and purge CHECKs widened; the unique
  index on `(tenant_id, normalized_title)` is partial (`WHERE reject_reason IS DISTINCT FROM
  'SENSITIVE_CONTENT'`). `0208` is unchanged.

RESULT_PLACEHOLDER
