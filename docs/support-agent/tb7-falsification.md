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
| TB7-16 | The consecutive loop guard (`>=` → `>`)                                         | stops after N consecutive automatic replies with no person, before any provider cost      | KILLED |
| TB7-17 | Only an INBOUND trigger is answered (never our echo, an away message, a person) | preflight: only a customer message with readable text is ever answered (unit)             | KILLED |
| TB7-18 | A handoff escalates (record, ticket, signal) in its own transaction             | an UNKNOWN send is UNCONFIRMED, never resent, and hands off with a ticket                 | KILLED |
| TB7-19 | Link the customer's active ticket instead of opening a duplicate                | links the customer's existing active ticket instead of opening another                    | KILLED |
| TB7-20 | Resuming a handed-off conversation resolves the operator signal                 | a handoff opens exactly one ticket, links it on the next handoff, and signals an operator | KILLED |
| TB7-21 | Widening the allowlist charges `support_ai.auto_reply`                          | widening the allowlist is the CRITICAL permission; narrowing is not                       | KILLED |
| TB7-22 | An unseen image the reply would be about hands off (`autoImageGuard`)           | a photo with vision off is never answered: no provider call, a handoff                    | KILLED |
| TB7-23 | A required image the answering step was not given hands off                     | a photo the answering step was not given hands off, even with a valid REPLY               | KILLED |

**23 of 23 killed** (re-run on the TB6 restack, `nexa_test_tb7r`, where TB7-17's anchor moved
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
- **Not mutated:** the scope-activity read in the job's transaction (`dropped_scope`). No test
  stops a tenant mid-job, so this record claims nothing about it.
