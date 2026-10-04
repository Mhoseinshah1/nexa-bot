# TB2 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb2.py`, and the
named test was run against the mutant. Run on 2026-10-04 against the TB2 head. 9 of 9
killed.

| Id     | Rule reverted                                                        | Killed by (`business-conversations.test.ts`)                       |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| TB2-01 | The final check requires the row's epoch to equal the conversation's | R6                                                                 |
| TB2-02 | An `AUTO` row also needs `AI_ACTIVE`                                 | R1                                                                 |
| TB2-03 | Resume advances the epoch                                            | R5                                                                 |
| TB2-04 | A human signal advances the epoch                                    | a message the owner types by hand takes the conversation           |
| TB2-05 | A human signal on an already-human conversation moves nothing        | a second operator message … does not supersede the first           |
| TB2-06 | The send record proves an echo is ours                               | an operator’s send … its echo is recognised as ours                |
| TB2-07 | An unknown `AUTO` outcome hands the conversation to a person         | an AUTO send whose outcome is unknown is never resent, and hands … |
| TB2-08 | The customer lookup is tenant-scoped and by exact id                 | links the customer only by exact id                                |
| TB2-09 | An operator's send is itself a human signal                          | an operator’s send takes the conversation over                     |

## Substitute review of PR #197 — every fix, falsified

Codex was unavailable (usage limits), so one read-only substitute review ran. It found no blocking defect, four should-fix defects and four nits; all were valid and all are fixed. Each fix has a regression test, and reverting the fix fails that test.

| ID             | Finding                                                                             | Fix                                                                                                                        | Regression test | Result |
| -------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------- | ------ |
| TB2-10         | F1: a late update on a superseded connection repointed the conversation at it       | `upsertLocked` repoints only to a connection that is not superseded, decided in the transaction                            | F1              | KILLED |
| TB2-11         | F2: an echo that arrives before the lane writes the message id stays HUMAN for ever | classification runs under the conversation lock, which the lane now also takes; DELIVERED relabels a HUMAN row with its id | F2              | KILLED |
| TB2-12         | F3: an owner's edit of a message NEXA sent was taken as our echo                    | an edit is never proved ours by the send record                                                                            | F3              | KILLED |
| TB2-13         | M1: R4 did not pin "a redelivery moves the epoch once"                              | — (the rule held; a test now pins it)                                                                                      | M1              | KILLED |
| TB2-14         | M3: the stamp's `send_started_at IS NULL` guard had no test                         | —                                                                                                                          | M3              | KILLED |
| TB2-15         | M4: "an edit never rewinds" was tested with one edit                                | —                                                                                                                          | M4              | KILLED |
| TB2-16, TB2-17 | M5: no stopped-scope test for send, takeover or the lane                            | —                                                                                                                          | M5              | KILLED |
| TB2-18         | N6: a pass whose lease was taken over could stamp and bypass `retry_after`          | the stamp requires the pass's own lease                                                                                    | N6              | KILLED |
| TB2-19         | N7: an edit restored text that retention had purged                                 | the edit leaves a purged row's text null                                                                                   | N7              | KILLED |
| TB2-20         | N8: an outcome for a row the reaper had resolved counted as delivered               | the lane checks each conditional write and logs a lost outcome                                                             | N8              | KILLED |

N5 had `origin` in the request hash, so a redelivery after the echo proof resolved failed as a payload mismatch. `origin` is now out of the hash, and the second half of F2 pins the replay.

**20 of 20 killed.**
