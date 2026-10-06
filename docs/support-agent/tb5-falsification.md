# TB5 — falsification record

Driver: `scripts/mutate-tb5.py`. Each mutation reverts one rule, runs the named test, and restores the file. Run on 2026-10-04 against a dedicated integration database.

| ID     | Rule reverted                                           | Test that failed                                                  | Result |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| TB5-01 | An uncited alias is dropped (it was kept as a label)    | produces a draft and sends nothing by itself                      | KILLED |
| TB5-02 | The strict decision schema (output trusted as-is)       | records a decision with an extra key as FAILED, with its class¹   | KILLED |
| TB5-03 | `markReady` only from QUEUED                            | a draft discarded while it was being produced is not resurrected  | KILLED |
| TB5-04 | A newer request discards the open draft                 | a newer request discards the older draft…                         | KILLED |
| TB5-05 | Mode OFF refuses                                        | refuses a draft while the support AI is OFF                       | KILLED |
| TB5-06 | The send is an `ASSIST` row                             | sends a draft only by the operator…                               | KILLED |
| TB5-07 | Only a READY draft can be sent (both layers, see below) | …a discarded draft cannot be sent                                 | KILLED |
| TB5-08 | An unlinked customer's prompt (it claimed linkage)      | tells an unlinked customer's model to discuss no account at all   | KILLED |
| TB5-09 | The reply-length bound                                  | keeps an over-long reply as a READY draft, marked over the limit¹ | KILLED |

**9 of 9 killed.**

¹ Revised 2026-10-06 (branch `sai/runtime-capability-diagnostics`, agent audit D10): an Assist
reply over `maxOutputChars` is no longer FAILED. It is a READY draft with `replyOverLimit`, shown
with a warning, because a person edits it before sending (the send stays bounded by the outbound
limit). The test was split; both halves were re-falsified on that branch (the over-limit mark by
mutation I6, the extra key by reverting the parse). Automatic replies still refuse an over-long
reply (`reply_bounds`).

A note on TB5-02: an earlier version of the test used an out-of-enum `decision`. The database CHECK refused that write, so the mutant died by the CHECK, not by the schema. The test now uses shapes no CHECK can refuse: an extra key, and an over-long reply.

## Substitute review of PR #200 — every fix, falsified

Codex was unavailable, so one substitute review ran. It found two blocking defects, five should-fix defects and two nits; all were valid and all are fixed. Each fix has a regression test, and reverting the fix fails that test. Run on 2026-10-05 against a dedicated integration database (`nexa_test_tb5fix`) with `python3 scripts/mutate-tb5.py`.

| ID             | Finding                                                                                    | Fix                                                                                                                                                 | Regression test (`support-assist.test.ts` unless named)                    | Result |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| TB5-10         | B1: `produce()` read no scope activity; a stopped tenant's transcript reached the provider | the decision to call the chain checks activity in a transaction first; an inactive scope returns `INACTIVE` and writes nothing                      | a stop between the claim and the call…                                     | KILLED |
| TB5-11         | B1: the result was recorded with no activity check                                         | `markReady`/`markFailed` take a tx and run in `uow.run` behind the check                                                                            | a stop during the provider call…                                           | KILLED |
| TB5-12         | B1: `claimDue` leased a stopped tenant's jobs                                              | `claimNext` runs in a transaction behind the check                                                                                                  | never leases a stopped tenant's queued draft…                              | KILLED |
| TB5-13         | B2: two sends under different keys produced two outbound rows                              | READY→SENT is a conditional write inside the lane's own transaction (`enqueueHumanSend`'s `within` hook); zero rows → NOT_READY and a full rollback | two concurrent sends under different keys…                                 | KILLED |
| TB5-14         | B2: a send racing a discard                                                                | `markSent` only from READY, in the send's transaction                                                                                               | a send racing a discard…                                                   | KILLED |
| TB5-15         | B2: a replay returned early on SENT and never reached the lane's payload check             | no early return; a replay goes through the lane's replay                                                                                            | a replay of the operator's key goes through the lane's replay…             | KILLED |
| TB5-16         | B2 (found while fixing): a key replayed onto a different draft answered with the first row | a replay answers only for the draft that was sent as that row                                                                                       | the same key used on a different draft is refused…                         | KILLED |
| TB5-07         | (revised) only a READY draft can be sent                                                   | the rule now has two layers, a courtesy read and the conditional write; the mutant reverts both                                                     | …a discarded draft cannot be sent                                          | KILLED |
| TB5-17         | S3: the heartbeat window was 3 × 2 s while a job takes minutes                             | progress recorded after every job; window `max(3 × interval, lease)`                                                                                | `assistant-loop.test.ts`: stays fresh while a provider call takes a minute | KILLED |
| TB5-18         | S4: a 5-minute lease against a 6-minute worst case                                         | lease = `(1 + maxFallbacks) × timeoutMs.max + 2 min`, derived                                                                                       | two assistant replicas sharing a clock and a slow provider…                | KILLED |
| TB5-19         | S4 (found by the new test): `IN (… LIMIT 1 FOR UPDATE SKIP LOCKED)` leased the whole queue | one job per claim through a scalar subquery (evaluated once)                                                                                        | two assistant replicas…                                                    | KILLED |
| TB5-20         | S5: `request()` replayed by key alone                                                      | `request_hash` (migration `0203`); a mismatch is `platform.idempotency_payload_mismatch`                                                            | the same key with another conversation is refused…                         | KILLED |
| TB5-21         | S6: with the assistant down a draft stayed QUEUED for ever                                 | the listing fails a QUEUED job with no live lease for `SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS` as `job.unclaimed`                                       | the listing fails a QUEUED draft unclaimed for the bound…                  | KILLED |
| TB5-22         | S6: the bound must not fail a job being produced                                           | the clock runs from `coalesce(claimed_until, created_at)`                                                                                           | a draft being produced (a live lease) is never failed…                     | KILLED |
| TB5-23         | S6: a new request discarded an unclaimed draft as if it had been replaced                  | the request fails it as `job.unclaimed` first                                                                                                       | a new request fails the old unclaimed draft…                               | KILLED |
| TB5-32         | S6: the web polled and disabled re-request for ever                                        | the wait is bounded by the same constant plus two polls                                                                                             | `support-ai.test.tsx`: …a draft nothing claims                             | KILLED |
| TB5-24, TB5-25 | S7: `ASSISTANT_MAX_ATTEMPTS` had no test                                                   | —                                                                                                                                                   | a job claimed more than 3 times…; attempt 3 is still produced              | KILLED |
| TB5-26, TB5-27 | S7: the claim's lease predicate had no test                                                | —                                                                                                                                                   | the lease predicate…                                                       | KILLED |
| TB5-28         | S7: the 30-day purge had no test                                                           | —                                                                                                                                                   | purges a draft's text after 30 days, and not before                        | KILLED |
| TB5-29         | S7: send needing `business_chats.reply` had no test                                        | —                                                                                                                                                   | sending needs business_chats.reply as well as support_ai.assist            | KILLED |
| TB5-30         | S7: discard idempotency had no test                                                        | —                                                                                                                                                   | discard is idempotent, and never discards a sent draft                     | KILLED |
| TB5-31         | Nit: a missing tenant scope was silent (now logged once)                                   | logged once per process                                                                                                                             | `assistant-loop.test.ts`: reports a missing tenant scope once              | KILLED |

The second nit (the newer-request test asserts `support_ai.draft_not_ready` rather than any NexaError) changes a test, not a rule, so it has no mutant.

An inactive scope's job is left QUEUED rather than FAILED `scope.inactive`: a stopped scope takes no writes, ours included, and the job needs no special case afterwards — once the scope is started it is claimed again, or failed as unclaimed by the ordinary bound.

**32 of 32 killed** (9 original, TB5-07 revised, 23 new).
