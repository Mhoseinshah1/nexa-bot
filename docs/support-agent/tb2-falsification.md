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
