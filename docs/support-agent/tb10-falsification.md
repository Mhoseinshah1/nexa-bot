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

**33 of 33 killed.**

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
