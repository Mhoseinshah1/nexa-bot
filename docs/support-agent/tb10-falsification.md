# TB10 — falsification record

Driver: `scripts/mutate-tb10.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. A contracts mutant rebuilds `@nexa/contracts` before the run
and after the restore, because the test projects import its `dist`. The driver counts a
mutant as killed only if the named test RAN and failed. A filter that matches no test is
reported as SURVIVED. Run on 2026-10-05 against a dedicated integration database
(`nexa_test_tb10`).

| ID      | Rule reverted                                                                         | Test that failed                                                                          | Result |
| ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| TB10-01 | A handoff is a `SUPPORT` notification (moved to `SUPPORT_AI`)                         | a handoff reaches support’s inbox, linked to the conversation, and a takeover resolves it | KILLED |
| TB10-02 | `SUPPORT_AI` is admitted by `support_ai.configure` (widened to `business_chats.view`) | a rejected key and a silent chain reach support_ai.configure holders only                 | KILLED |
| TB10-03 | A handoff links to its conversation by `conversationId`                               | links a handoff to its conversation, and only by a UUID (unit)                            | KILLED |
| TB10-04 | Exact support codes, never a `support.` prefix                                        | never admits a support recovery, nor a support code nobody decided belongs here (unit)    | KILLED |
| TB10-05 | No wait once a reply is newer than the customer's last message                        | is nothing when a person or the AI replied after the customer’s last message (unit)       | KILLED |
| TB10-06 | The wait starts at the OLDEST unanswered message                                      | is the OLDEST customer message nobody answered, not the latest (unit)                     | KILLED |
| TB10-07 | `HALF_OPEN` from the instant `tripped_until` is reached (`>` made `>=`)               | is CLOSED with no trip, OPEN until the instant, HALF_OPEN from it on (unit)               | KILLED |
| TB10-08 | Every guard and handoff outcome is HANDED_OFF                                         | classifies every outcome … (unit)                                                         | KILLED |
| TB10-09 | The inbox orders HANDOFF_REQUIRED first                                               | lists conversations waiting for a person first, then newest, and pages without a gap …    | KILLED |
| TB10-10 | The keyset names the priority (two-key keyset)                                        | lists conversations waiting for a person first, … pages without a gap or a repeat         | KILLED |
| TB10-11 | `firstUnansweredAt` is the minimum (made the maximum)                                 | reads the customer’s wait from the oldest unanswered message, and clears it on a reply    | KILLED |
| TB10-12 | The cursor's priority is `0` or `1` only                                              | pages the inbox by the cursor it issued, and refuses one it did not (HTTP)                | KILLED |
| TB10-13 | The window's end is exclusive (escalations, `<` made `<=`)                            | counts each figure in [start, end), tenant by tenant                                      | KILLED |
| TB10-14 | The window's start is inclusive (jobs, `>=` made `>`)                                 | counts each figure in [start, end), tenant by tenant                                      | KILLED |
| TB10-15 | Runs are read for the caller's tenant only                                            | counts each figure in [start, end), tenant by tenant                                      | KILLED |
| TB10-16 | p95 is `percentile_cont(0.95)`                                                        | counts each figure in [start, end), tenant by tenant                                      | KILLED |
| TB10-17 | An AUTO job with no outcome is pending, never sent                                    | counts an AUTO job with no outcome as pending — never as sent … (unit)                    | KILLED |
| TB10-18 | Every Assist draft counts as requested                                                | counts every Assist draft as requested, and each by the state it is in now (unit)         | KILLED |
| TB10-19 | Analytics charge `support_ai.configure` before reading                                | is charged support_ai.configure before anything is read …                                 | KILLED |
| TB10-20 | The view's breaker is derived from `tripped_until`                                    | reports each breaker as of the read, the failures, a rejected key and the chain           | KILLED |
| TB10-21 | `chainUnavailable` reads the open condition                                           | reports each breaker as of the read …                                                     | KILLED |
| TB10-22 | The view carries `rejectedAt`                                                         | reports each breaker as of the read …                                                     | KILLED |
| TB10-23 | The wait is floored, never rounded (web)                                              | says how long the customer has waited, in one unit, floored                               | KILLED |
| TB10-24 | The ticket badge is drawn (web)                                                       | draws the wait …, a dash for an answered one, and a ticket link                           | KILLED |
| TB10-25 | `HALF_OPEN` has its own label (web)                                                   | draws each provider’s breaker as the server derived it …                                  | KILLED |
| TB10-26 | The «no provider is answering» banner (web)                                           | says so at the top when no provider is answering                                          | KILLED |
| TB10-27 | A handoff notification opens its conversation (web)                                   | link a handoff to its conversation, and the rest to the page that acts on them            | KILLED |
| TB10-28 | The analytics page says cost is not computed (web)                                    | shows no cost and says why: tokens, not a price nobody approved (OQ-TB-07)                | KILLED |
| TB10-29 | The analytics page asks for the range in the address (web)                            | sends a preset taken from the address as it is                                            | KILLED |
| TB10-30 | `.bchat-body` keeps `unicode-bidi: plaintext` (CSS)                                   | lays out what a person wrote by its own direction, aligned to its own start               | KILLED |
| TB10-31 | No hard-coded colour in a support rule (CSS)                                          | uses only theme tokens and logical sides in the support pages’ rules                      | KILLED |
| TB10-32 | No physical side in a support rule (CSS)                                              | uses only theme tokens and logical sides in the support pages’ rules                      | KILLED |
| TB10-33 | The composer is `dir="auto"` (web)                                                    | lets a text box take the direction of what is typed into it                               | KILLED |
| TB10-34 | Knowledge by source counts every article state, RETIRED included (TB9 RETIRE)         | knowledge by source counts a built article retired by a RETIRE proposal                   | KILLED |

**34 of 34 killed** on the restack onto TB9's substitute review (PR #204), where TB10-34 was
added for the RETIRE proposal kind. Before that, **33 of 33 killed.**

Notes:

- **The first run reported 28 of 33.** Four filters (TB10-13 to 16) contained `[start, end)`,
  which `vitest -t` reads as a regular expression. They matched no test, ran nothing, and the
  driver reported them SURVIVED rather than counting a non-run as a kill. TB10-12's first
  mutant (an optional priority) was caught by the cursor schema's second rule, the instant
  refine, so the test stayed green; it was not a reversion of one rule. The filters were made
  plain substrings, TB10-12 now reverts the priority's alphabet alone, and the five were run
  again: 5 of 5 killed.
- **The indexes are falsified by the plan test, by hand.** The harness applies migrations
  once per database, so the driver cannot revert `0210` in place. With its three indexes
  dropped from `nexa_test_tb10`, `support-plan.test.ts` failed five of its six plan cases. The
  first inbox page became a Seq Scan and a Sort, 1 118 buffers against 364 with the index.
  The indexes were then recreated.

## Substitute review of PR #205 — every fix, falsified

Codex was unavailable, so one read-only substitute review ran. It found no blocking defect,
three should-fix findings and five nits; all were valid and all are fixed. Each code fix has a
regression test, and reverting the fix fails that test. Run on 2026-10-05 against a dedicated
integration database (`nexa_test_tb10fix`).

| ID      | Finding                                                                                      | Fix                                                                                                                                                    | Regression test                                                                             | Result |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| TB10-35 | S1: «waiting since» compared Telegram's whole-second date with the server's sub-second `now` | `businessUnansweredSince` compares on the whole second (`businessUnansweredSecond`); a message in the reply's second is unanswered (a contract commit) | is still waiting for a customer message in the same Telegram second as a reply (unit)       | KILLED |
| TB10-36 | S1: the SQL's `firstUnansweredAt` used the millisecond rule                                  | `m.sent_at >= date_trunc('second', replied)`, the contract's rule, sargable                                                                            | a customer message in the same Telegram second as a reply confirmed at a sub-second now …   | KILLED |
| TB10-37 | S1: a delivered reply was stamped on the server's clock                                      | the lane stamps the reply with Telegram's `date` for it (the OWN_ECHO row's date), `now` only when Telegram gave none                                  | a server clock running ahead of Telegram does not mark a later customer message as answered | KILLED |
| TB10-38 | S1: Telegram's `date` for a sent message was never read                                      | `telegramSend` reads a positive integer `date`; the gateway and transport carry it                                                                     | reads Telegram’s own date for a sent message, and nothing that is not one (unit)            | KILLED |
| TB10-39 | N2: «load more» could draw a conversation twice (mutable keyset key)                         | `inboxRows` draws each id once, first position, fresher read; the skip case documented                                                                 | draws a conversation once when «load more» reads it again (web)                             | KILLED |
| TB10-40 | N3: the six analytics statements were six snapshots                                          | one `REPEATABLE READ, READ ONLY` transaction                                                                                                           | reads every figure from one snapshot, blind to a commit made mid-read                       | KILLED |
| TB10-41 | N3: (the transaction itself)                                                                 | —                                                                                                                                                      | reads every figure from one snapshot, blind to a commit made mid-read                       | KILLED |
| TB10-42 | N5: `percentile_cont` over a CUSTOM window of up to 731 days                                 | a CUSTOM window is at most 366 days (the longest preset), refused before reading                                                                       | is capped at a leap year — a longer one is refused before anything is read (unit)           | KILLED |
| —       | N4: the learning-candidate count walked the tenant's whole review-queue index                | `support_learning_candidates_created_idx` on `(tenant_id, created_at, state)` in `0210`                                                                | counts support_learning_candidates in the window … (plan; falsified by hand, below)         | KILLED |
| —       | N1: `0210` is a plain `CREATE INDEX`, not the online-index path                              | kept, and documented: every table it indexes is created empty by the same unreleased set; it ships with `0196`–`0209`                                  | — (a release rule, `tb10-polish-analytics.md` decision 9, `docs/deployment.md`)             | —      |
| —       | S2: the execution board said only TB0 was merged                                             | TB0–TB9 merged as #195–#204, each with its merge commit; TB10 #205 open                                                                                | — (documentation)                                                                           | —      |
| —       | S3: the runbook promised customers «به همکار سپرده شد» on a handoff                          | no such message exists; §3 now states the real cost of AUTO in an outage; §3, §5 and §9 corrected against the code                                     | — (documentation)                                                                           | —      |

TB10-05 and TB10-06 were re-anchored onto the whole-second rule and still revert the same two
rules. The unit test that pinned «a reply in the customer's own second answers them» was the
old, wrong behaviour; it now uses the next second.

**N4 by hand.** The harness applies migrations once per database, so the driver cannot revert
`0210`. With `support_learning_candidates_created_idx` dropped from `nexa_test_tb10fix`, the
plan case failed: the count went back to an index-only scan of the review-queue index, 228
buffers against 23, under an Index Cond that still named `created_at` — which is why the case
bounds the buffers rather than trusting the Index Cond. The index was then recreated.

**8 of 8 new mutants killed; the whole driver, TB10-01..42, 42 of 42 killed** on the fixed
head, with a clean tree after the run.
