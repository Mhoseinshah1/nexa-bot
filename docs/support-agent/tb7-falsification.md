# TB7 — falsification record

Driver: `scripts/mutate-tb7.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. Run on 2026-10-04 against a dedicated integration database
(`nexa_test_tb7`).

| ID     | Rule reverted                                                                   | Test that failed                                                                          | Result |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| TB7-01 | A newer inbound message discards the pending job (coalescing)                   | two inbound messages coalesce into one job and one reply                                  | KILLED |
| TB7-02 | Idempotency on the message (both proofs: TB2's "nothing new" and the job key)   | a redelivered inbound message enqueues no second job                                      | KILLED |
| TB7-03 | A job is not claimed before `due_at` (the settle delay)                         | waits the settle delay: a job is not claimed before it is due                             | KILLED |
| TB7-04 | The epoch and state re-check before the provider call                           | a human message during the settle delay: no provider call and no AUTO send                | KILLED |
| TB7-05 | The epoch and state re-check when the reply is enqueued                         | a human message during the provider call: the reply is never enqueued                     | KILLED |
| TB7-06 | The mode re-check before the provider call                                      | a mode switched OFF while a job is pending drops it…                                      | KILLED |
| TB7-07 | The lane refuses an AUTO row while the mode is not AUTO_REPLY_SAFE              | …while a row is queued, the lane refuses it                                               | KILLED |
| TB7-08 | `finishAuto` only from QUEUED (a replaced in-flight job writes nothing)         | a job replaced while its provider call is in flight writes nothing: one reply in all      | KILLED |
| TB7-09 | The allowlist guard                                                             | an empty allowlist means no automatic reply is ever sent                                  | KILLED |
| TB7-10 | The hard-handoff topic guard                                                    | each guard individually blocks the reply and hands off with its own reason                | KILLED |
| TB7-11 | The identity guard (an unlinked customer gets general topics only)              | each guard individually blocks the reply…                                                 | KILLED |
| TB7-12 | The account-review guard (payment under review, unreconciled service)           | each guard individually blocks the reply…                                                 | KILLED |
| TB7-13 | The confidence guard                                                            | each guard individually blocks the reply…                                                 | KILLED |
| TB7-14 | The reply-bounds guard (empty)                                                  | each guard individually blocks the reply…                                                 | KILLED |
| TB7-15 | The grounding guard (a cited fact the payload did not contain)                  | each guard individually blocks the reply…                                                 | KILLED |
| TB7-16 | The loop guard (`>=` → `>`); since roadmap A1 the session budget (re-anchored)  | stops when the session budget is spent, before any provider cost                          | KILLED |
| TB7-17 | Only an INBOUND trigger is answered (never our echo, an away message, a person) | preflight: only a customer message with readable text is ever answered (unit)             | KILLED |
| TB7-18 | A handoff escalates (record, ticket, signal) in its own transaction             | an UNKNOWN send is UNCONFIRMED, never resent, and hands off with a ticket                 | KILLED |
| TB7-19 | Link the customer's active ticket instead of opening a duplicate                | links the customer's existing active ticket instead of opening another                    | KILLED |
| TB7-20 | Resuming a handed-off conversation resolves the operator signal                 | a handoff opens exactly one ticket, links it on the next handoff, and signals an operator | KILLED |
| TB7-21 | Widening the allowlist charges `support_ai.auto_reply`                          | widening the allowlist is the CRITICAL permission; narrowing is not                       | KILLED |
| TB7-22 | An unseen image the reply would be about hands off (`autoImageGuard`)           | a photo with vision off is never answered: no provider call, a handoff                    | KILLED |
| TB7-23 | A required image the answering step was not given hands off                     | a photo the answering step was not given hands off, even with a valid REPLY               | KILLED |
| TB7-24 | The unclaimed-draft rule fails ASSIST drafts only, never an AUTO job            | the unclaimed rule fails a waiting ASSIST draft and never an AUTO job                     | KILLED |
| TB7-25 | `claimNext` claims only the kinds the caller can produce                        | a claimer without the AUTO producer never claims an AUTO job, and its due_at holds        | KILLED |
| TB7-26 | A stopped tenant's AUTO transcript is never sent to a provider                  | an AUTO job claimed while the tenant is active and produced after a stop asks no provider | KILLED |
| TB7-27 | AUTO image outcomes are written only with the job's own transition (TB6 S1)     | an AUTO job replaced during its provider call records no image outcome (TB6 review, S1)   | KILLED |

**27 of 27 killed** on the restack onto the reviewed TB6 (PR #201), where TB7-23 was re-anchored
on the `sight`-based required-image check and TB7-27 added for S1. Before that, **26 of 26
killed** on the restack onto the reviewed TB5 (PR #200), `nexa_test_stack`, where
TB7-24..26 were added for TB5's single-job `claimNext`, the unclaimed-draft rule and the activity
check before the provider. Before that, **23 of 23 killed** (re-run on the TB6 restack, `nexa_test_tb7r`, where TB7-17's anchor moved
with the photo preflight and TB7-22/23 were added for the TB6 integration; `scripts/mutate-tb6.py`
still kills 18 of 18 on the same tree).

Notes:

- **TB7-02 is a pair, on purpose.** A redelivered message is refused twice. TB2 records
  nothing new for a message it already holds, so no trigger fires. The job's key also names
  the message and its content version. Reverting either half alone survives: the other half
  still holds. The first run used a weaker mutant (only the content-version line), which
  survived because TB2's `inserted || edited` gate also holds. The test was also strengthened
  to assert that the pending job stays `QUEUED`, not merely that one row exists. A
  coalescing re-insert under the same key would leave one row, DISCARDED.
- **TB7-08 needed a new test.** The coalescing test alone never produced the replaced job,
  because it was not yet due. The in-flight test records the newer message from inside the
  provider call.
- **Formerly not mutated:** the scope-activity read in the job's transaction. The substitute
  review of PR #202 removed `dropped_scope` and added the test; it is TB7-32 below.

## Substitute review of PR #202 — every fix, falsified

One substitute review ran on PR #202. It found five should-fix findings (the fourth a list of
eight rules with no killing test) and four nits; all were valid and all are fixed. Each fix
has a regression test in `tests/integration/support-auto-reply.test.ts`, and reverting the fix
fails that test. Run on 2026-10-05 against `nexa_test_tb7fix`, the whole driver at once.

| ID         | Finding                                                                                  | Fix                                                                                                                                                                                           | Regression test                                                        | Result |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| TB7-28     | 1: the enqueue re-checked only the mode; the guards decided on the facts before the call | the enqueue transaction re-reads the config, the trigger, the counts and the account facts (`autoGuardFlags`) and runs both guard sets again; a failure hands off                             | finding 1: a topic removed from the allowlist during the provider call | KILLED |
| TB7-29     | 1: (the same re-check, a payment put under review)                                       | (as above)                                                                                                                                                                                    | finding 1: a payment put under review during the provider call         | KILLED |
| TB7-30     | 1: (the preflight half of the re-check, a customer blocked)                              | `autoPreflight` runs again in the transaction, on the in-transaction blocked flag                                                                                                             | finding 1: a customer blocked during the provider call                 | KILLED |
| TB7-31     | nit: a trigger deleted after the preflight was still answered                            | (the same in-transaction preflight; fail closed: a handoff, like a trigger deleted before)                                                                                                    | nit: a trigger deleted before the job runs, or during its call         | KILLED |
| TB7-32     | 2 (R9): a stopped scope's job was ended `dropped_scope` — a write in a stopped scope     | a stopped scope writes nothing: `INACTIVE`, the job left QUEUED under its lease, as TB5 leaves a draft                                                                                        | finding 2: a stop during the provider call writes nothing              | KILLED |
| TB7-33     | 2: on resume, a job held through a stop would be answered however late                   | a job produced more than `SUPPORT_AI_AUTO_STALE_SECONDS` after its `due_at` hands off (`handoff_stale`, `REPLY_STALE`) with no provider call                                                  | finding 2: …after resume the stale job hands off                       | KILLED |
| TB7-34     | 2: an AUTO lane row held through a stop would be sent however late                       | the lane's final check supersedes an AUTO row older than the bound (`support_ai.reply_stale`) and hands off                                                                                   | finding 2: an AUTO lane row left unsent past the bound                 | KILLED |
| TB7-35     | 3: a bad category override on an unseeded tenant threw out of the handoff                | the seed renders every title before writing; the escalation catches `TICKET_CATEGORY_INVALID` → `NO_CATEGORY`                                                                                 | finding 3: a bad category override on an unseeded tenant               | KILLED |
| TB7-36     | 3: one row's failing handoff aborted the whole delivery pass                             | each row is delivered under its own try; a failure is logged and rolls back that row alone                                                                                                    | at the send: the failing row is rolled back alone                      | KILLED |
| TB7-37     | 3: the reaper reaped every stranded row in one transaction, so one failure stalled all   | one transaction per stranded row, with its handoff; a failure is logged and the pass goes on                                                                                                  | at the reaper: each stranded row in its own transaction                | KILLED |
| TB7-38 R7  | 4: `support.handoff_required` recovered on takeover had no test                          | — (the rule held; a test now pins it)                                                                                                                                                         | R7: a person taking over a handed-off conversation recovers…           | KILLED |
| TB7-39 R6  | 4: `lockCustomer` in the escalation had no test                                          | —                                                                                                                                                                                             | R6: two concurrent handoffs … open one ticket                          | KILLED |
| TB7-40 R5  | 4: the inactive-connection refusal in `enqueueAutoSend` had no test                      | —                                                                                                                                                                                             | R5: a connection that stopped being usable during the provider call    | KILLED |
| TB7-41 R12 | 4: the epoch check before a handoff had no test                                          | —                                                                                                                                                                                             | R12: a takeover and resume during the provider call                    | KILLED |
| TB7-42 R4  | 4: "an edit of an answered message starts nothing" had no test                           | —                                                                                                                                                                                             | R4: an edit of an answered message starts nothing                      | KILLED |
| TB7-43     | nit: an edit of an older message re-targeted the pending job to it                       | an edit re-enqueues only when it is of the pending job's own trigger                                                                                                                          | nit: an edit of an OLDER message while a job is pending                | KILLED |
| TB7-44 R8  | 4: the escalation summary purge had no test                                              | —                                                                                                                                                                                             | R8: the escalation summary is purged … after 30 days                   | KILLED |
| TB7-45 R10 | 4: SUPERSEDED rows excluded from the loop guard had no test                              | —                                                                                                                                                                                             | R10: a SUPERSEDED automatic reply never counts                         | KILLED |
| TB7-46     | 4: Telegram REFUSED on an AUTO row handing off had no test                               | —                                                                                                                                                                                             | Telegram REFUSED on an AUTO row hands off                              | KILLED |
| TB7-47     | 5: the AI's summary was visible with `tickets.view` alone                                | `TicketService.detail` returns the summary only to an actor holding `business_chats.view`                                                                                                     | finding 5: tickets.view without business_chats.view                    | KILLED |
| TB7-48     | nit: raising the reply limits or shortening the delays was not "widening"                | in a resulting AUTO mode, a higher reply limit (now `sessionReplyBudget`/`maxAutoRepliesPerHour`, roadmap A1)/`maxOutputChars` or a lower cooldown/settle delay needs `support_ai.auto_reply` | nit: in AUTO, raising the reply limits or shortening the delays        | KILLED |

TB7-26 was re-anchored: the activity check before the provider call now returns `INACTIVE`
rather than writing `dropped_scope`. The decision 3 nit was wording only: `tb7-auto-reply.md`
now states that the mode is read when each step processes, so a mode switched OFF and back
ON before the assistant or the lane reached a job or a row leaves it to run, under every other
check. The former note "Not mutated: the scope-activity read in the job's transaction" is
answered by TB7-32.

Each mutant was killed by exactly one failing assertion in its named test (the driver prints
the failing test). TB7-28/29 and TB7-30/31 are one mutation each, run against two tests on
purpose, so each test is shown to depend on the rule.

**48 of 48 killed.**

## Hotfix 2026-10-06 — automatic clarifying questions

Driver: `scripts/mutate-clarifying.py` (each mutation replaces one exact string, runs the named
suite, and restores the file byte for byte). Run on 2026-10-06 against
`nexa_test_clar`. Integration cases are in `describe('hotfix: automatic clarifying
questions')`.

| ID    | Rule reverted                                                   | Tests that failed                                                                                                                      | Result |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| CQ-01 | The guard change (`!== 'REPLY'` restored)                       | 1/17, 2, 3/10, 5/11, 10–16, item 3/12/16/20 (17 tests)                                                                                 | KILLED |
| CQ-02 | The allowlist guard skipped for a question                      | 2: a clarifying question on a topic off the allowlist hands off                                                                        | KILLED |
| CQ-03 | The hard-topic guard skipped for a question                     | 6/8: a hard topic cannot pass as a clarifying question                                                                                 | KILLED |
| CQ-04 | The confidence guard skipped for a question                     | a clarifying question passes through EVERY guard a REPLY does (unit)                                                                   | KILLED |
| CQ-05 | An empty question allowed                                       | a clarifying question passes through EVERY guard a REPLY does (unit)                                                                   | KILLED |
| CQ-06 | The grounding guard skipped for a question                      | 5/11: a clarifying question citing a fact or knowledge entry it was not given                                                          | KILLED |
| CQ-07 | Knowledge citations unchecked                                   | each guard individually blocks the reply…; 5/11                                                                                        | KILLED |
| CQ-08 | The identity guard skipped for a question                       | item 16: an unlinked customer gets a general question                                                                                  | KILLED |
| CQ-09 | The account-review guard skipped for a question                 | a clarifying question passes through EVERY guard a REPLY does (unit)                                                                   | KILLED |
| CQ-10 | The limit `>=` → `>`                                            | 10, 11, 12/6, 10b, 14/15, 15                                                                                                           | KILLED |
| CQ-11 | The streak never counts                                         | 1/17, 10, 11, 12/6, … (10 tests)                                                                                                       | KILLED |
| CQ-12 | A REPLY does not reset the streak                               | 12/6; item 20 (acceptance flow)                                                                                                        | KILLED |
| CQ-13 | The epoch filter removed                                        | 14/15: a takeover and return to the AI start a new streak                                                                              | KILLED |
| CQ-14 | FAILED and SUPERSEDED rows counted                              | 13: a refused, superseded or failed reply, and a discarded job, never count                                                            | KILLED |
| CQ-15 | Jobs joined by conversation, not by the sent row (double count) | 11, 12/6, 14/15, 16/4, item 20                                                                                                         | KILLED |
| CQ-16 | The enqueue-transaction recheck ignores the streak              | 10b: the limit is decided again in the enqueue transaction                                                                             | KILLED |
| CQ-17 | A sent question recorded as `sent`                              | 1/17, 10, 11, 12/6, … (13 tests)                                                                                                       | KILLED |
| CQ-18 | Raising the limit in AUTO not charged `support_ai.auto_reply`   | 9: in AUTO, raising the clarifying limit needs support_ai.auto_reply                                                                   | KILLED |
| CQ-19 | The default 3 instead of 2                                      | the setting's default and bounds (unit); 7, 9, 10, … (6 integration)                                                                   | KILLED |
| CQ-20 | The web widening warning removed                                | warns that an increase under AUTO_REPLY_SAFE is a widening (web)                                                                       | KILLED |
| CQ-21 | N1: PENDING lane rows not counted                               | N1: a question still PENDING on the lane counts (fail closed)                                                                          | KILLED |
| CQ-22 | N4: an absent limit saved as the default 2                      | N4: a save that omits the limit keeps the stored value                                                                                 | KILLED |
| CQ-23 | N7: invisible-only text not treated as empty                    | N7: a reply or question of only zero-width or invisible marks is empty (unit); a clarifying question passes through EVERY guard (unit) | KILLED |

CQ-21 to CQ-23 were added after the review of PR #228 and run on 2026-10-06 against the same
database.

Commit history note (review N2): the review reported the contract change as folded into the
feature commit `96fa26e7`. Checked with `git show --name-only`: `96fa26e7` touches no file
under `packages/contracts`; the whole contract surface of the hotfix is `a3f1473f`, committed
before it. Nothing is rewritten either way (the history is pushed; no force-push). The review's
own contract change (N4, `supportAiConfigSaveSchema`) has its own commit, before the code
that uses it.

Test 15 (a redelivered message and a repeated lane pass count one question) pins the
idempotency TB7-02 already falsified and the one-row-per-job key; CQ-15, the mutation that
would double count, is killed by five other streak tests rather than by test 15, whose single
job and row multiply to one. Every new test also fails against the unchanged `main` source
(run on 2026-10-06: 7 of the new unit cases, all 8 web cases; the integration cases need the
new contract and column).

**23 of 23 killed.**

## Roadmap A1/A2 (2026-10-07): the session reply budget, the hourly limit, the clarifying default

Driver: `scripts/mutate-sai-limits.py` (each mutation replaces one exact string, runs the named
suites — the A1/A2, hotfix and loop-guard cases of `tests/integration/support-auto-reply.test.ts`,
`tests/unit/support-auto-reply-guards.test.ts`, `tests/web/support-ai-limits.test.tsx` — and
restores the file byte for byte). Run on 2026-10-07 against a dedicated database.

| #     | Mutation                                                                  | Killed by (examples)                                                                                  | Result |
| ----- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| SL-00 | The budget `>=` → `>`                                                     | preflight unit; A1 budget of 5; five hours still one session; takeover; defaults; enqueue recheck (6) | KILLED |
| SL-01 | A GREETING reply counted in the session                                   | GREETING replies never spend the budget; a greeting job with no topic                                 | KILLED |
| SL-02 | No inactivity reset (every row of the epoch counts)                       | six hours of inactivity start a new session                                                           | KILLED |
| SL-03 | `now` not part of the activity                                            | six hours of inactivity start a new session                                                           | KILLED |
| SL-04 | The session not bound to the epoch                                        | stops when the budget is spent; takeover; the hourly limit across epochs; defaults                    | KILLED |
| SL-05 | An unknown topic (NULL) treated as GREETING (`<>` for `IS DISTINCT FROM`) | seven tests, among them a greeting job with no recorded topic counts                                  | KILLED |
| SL-06 | The hourly limit a constant 30                                            | caps per window; greetings fill the hour; the hourly limit is the tenant's                            | KILLED |
| SL-07 | The session budget a constant 20                                          | budget of 5; five hours; takeover; enqueue recheck; stops when spent                                  | KILLED |
| SL-08 | Raising the budget in AUTO not charged                                    | nit: raising the reply limits needs `support_ai.auto_reply`                                           | KILLED |
| SL-09 | Raising the hourly limit in AUTO not charged                              | nit: raising the reply limits needs `support_ai.auto_reply`                                           | KILLED |
| SL-10 | An absent budget saved as the default (not the stored value)              | a save without the new fields keeps the stored values                                                 | KILLED |
| SL-11 | A2: a GREETING reply resets the clarifying streak                         | the streak unit; a GREETING reply between questions does not reset                                    | KILLED |
| SL-12 | A2: the clarifying default back to 2                                      | the default unit; 7 (A2) the column default and a stored 2 kept                                       | KILLED |
| SL-13 | A1: the budget default 4                                                  | 3 unit, 44 integration (the default no longer passes its own bounds)                                  | KILLED |
| SL-14 | Web: no widening warning for the budget                                   | sessionReplyBudget: an increase under AUTO_REPLY_SAFE warns                                           | KILLED |
| SL-15 | Web: no widening warning for the hour                                     | maxAutoRepliesPerHour: an increase under AUTO_REPLY_SAFE warns                                        | KILLED |

**16 of 16 killed.** `scripts/mutate-clarifying.py` CQ-19 now reverts the default 3 to 2.

### Review of PR #241 (2026-10-08)

Same driver, five more mutants (SL-16 to SL-20), and the whole driver re-run against the fixed
code on `nexa_test_sai1`: **21 of 21 killed**.

| #     | Mutation                                                                 | Killed by                                                                                 | Result |
| ----- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------ |
| SL-16 | N1: greetings read by the streak query (the bounded read loses the ASKs) | N1: forty-five greetings between questions cannot push the questions out of the read      | KILLED |
| SL-17 | N3: a greeting is free at any length                                     | N3: a "greeting" longer than a greeting is an answer, and spends the budget               | KILLED |
| SL-18 | N3: a purged greeting reads as length 0, so free                         | N3: (the purged body counts)                                                              | KILLED |
| SL-19 | Rolling deploy: the retired limit not projected into the read            | rolling deploy: the read still carries the retired limit an older bundle requires         | KILLED |
| SL-20 | N5: an absent limit sent as NaN                                          | rolling deploy: against an older replica the absent limits are empty … and not sent (web) | KILLED |

Notes:

- SL-11 (a GREETING reply resets the streak, in `clarifyingStreakOf`) is now killed by the unit
  test only. The SQL filter added for N1 removes greetings before the walk, so the walk's own
  rule is a second line of defence that no integration test can reach.
- SL-18's first version only dropped the `IS NOT NULL` and survived. It was an equivalent
  mutant: `char_length(NULL)` is NULL, and a NULL `free` counts. The mutant was replaced by one
  that reads a purged body as length 0.
- `scripts/mutate-tb7.py` now FAILS on a missing anchor instead of skipping the mutant (N4).
  TB7-14, TB7-15 and TB7-16 were re-anchored: N7, the hotfix's joined citation check, and A1's
  session budget had moved their strings. Re-run 2026-10-08: 3 of 3 killed.
- N2 has no mutant. Its evidence is `EXPLAIN` with `enable_seqscan = off`:
  - both activity reads show `Index Cond: (tenant_id, conversation_id, sent_at|created_at >= $n)`
    from the scalar subquery;
  - the jobs joins can use `support_ai_jobs_conversation_idx` (`Index Cond: (tenant_id,
conversation_id)`) once they name the conversation.
    No new index was added.

## Roadmap A3–A6 (2026-10-08): progress guards, the handoff notice, the handoff's context, NO_ACTION

Driver: `scripts/mutate-sai-progress.py`. Each mutation replaces one exact string, runs the named
suites, and restores the file byte for byte, also on SIGTERM. A missing anchor fails the run. The
suites are `tests/unit/support-progress-guards.test.ts`, the `roadmap A3` cases of
`tests/integration/support-auto-reply.test.ts` and, for the notice, TB2's
`business-conversations.test.ts`. Run against `nexa_test_sai1b`.

| #     | Mutation                                    | Killed by (examples)                               | Result |
| ----- | ------------------------------------------- | -------------------------------------------------- | ------ |
| SP-00 | «نشد» not failure feedback                  | 10 unit; A3 three «it did not work»                | KILLED |
| SP-01 | no_progress at 4, not 3                     | unit; A3 three «it did not work»; A3 Finglish      | KILLED |
| SP-02 | another message does not end the run        | unit; A3 Finglish … any other message ends the run | KILLED |
| SP-03 | failures before any reply counted           | 5 unit                                             | KILLED |
| SP-04 | the run reads past the epoch                | unit `since`; A3 … a resume starts again           | KILLED |
| SP-05 | the same message needs 4                    | unit; A3 the same message three times              | KILLED |
| SP-06 | the rate: 8 in a minute is already a flood  | unit                                               | KILLED |
| SP-07 | the rate not bounded by the epoch           | unit                                               | KILLED |
| SP-08 | repeated advice never matches               | unit; A3 a reply the customer already received     | KILLED |
| SP-09 | greetings not exempt from repeated advice   | unit; A3 the same greeting twice                   | KILLED |
| SP-10 | service: no_progress not applied            | A3 three «it did not work»; A3 Finglish            | KILLED |
| SP-11 | service: flood not applied                  | A3 same message; A3 more than eight in a minute    | KILLED |
| SP-12 | service: repeated advice not applied        | A3 a reply the customer already received           | KILLED |
| SP-13 | the notice never enqueued                   | 8 A4 cases; TB2 UNKNOWN and stranded               | KILLED |
| SP-14 | the notice sendable in any state            | unit `businessOutboundSendable`                    | KILLED |
| SP-15 | mode OFF does not silence the notice        | A4 switching the mode OFF                          | KILLED |
| SP-16 | the escalation ignores the recorded context | A5 money; A3 three «it did not work»               | KILLED |
| SP-17 | steps tried not recorded                    | 6 A5 and A3 cases                                  | KILLED |
| SP-18 | the ticket gate leaks the topic             | A5 tickets.view alone sees none of it              | KILLED |
| SP-19 | intent not purged                           | A5 the intent is purged with the summary           | KILLED |
| SP-20 | NO_ACTION: any closing line is enough       | unit                                               | KILLED |
| SP-21 | NO_ACTION: allowlist skipped                | unit; A6 NO_ACTION on anything else                | KILLED |
| SP-22 | NO_ACTION: a question closes                | unit «حل شد؟»                                      | KILLED |
| SP-23 | service: NO_ACTION always hands off         | A6 «مرسی، حل شد»; A6 «اوکی درست شد», «ممنون»       | KILLED |

**24 of 24 killed.**

Notes:

- SP-06, SP-07, SP-14, SP-20 and SP-22 are killed by unit tests only.
- SP-14: the notice's state rule is redundant with its epoch rule in every integration path
  (a takeover or a resume moves the epoch). The unit test pins the state rule on its own.
- The first run showed the A6 «مرسی، حل شد» case failing under unrelated mutants. It was
  timing-dependent: a customer line in the same second as the reply counts as after it (B1).
  The test now ages the question by a minute, and its result no longer varies between runs.
