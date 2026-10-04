# TB5 — falsification record

Driver: `scripts/mutate-tb5.py`. Each mutation reverts one rule, runs the named test, and restores the file. Run on 2026-10-04 against a dedicated integration database.

| ID     | Rule reverted                                        | Test that failed                                                       | Result |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| TB5-01 | An uncited alias is dropped (it was kept as a label) | produces a draft and sends nothing by itself                           | KILLED |
| TB5-02 | The strict decision schema (output trusted as-is)    | records an over-long reply, or a decision with an extra key, as FAILED | KILLED |
| TB5-03 | `markReady` only from QUEUED                         | a draft discarded while it was being produced is not resurrected       | KILLED |
| TB5-04 | A newer request discards the open draft              | a newer request discards the older draft…                              | KILLED |
| TB5-05 | Mode OFF refuses                                     | refuses a draft while the support AI is OFF                            | KILLED |
| TB5-06 | The send is an `ASSIST` row                          | sends a draft only by the operator…                                    | KILLED |
| TB5-07 | Only a READY draft can be sent                       | …a discarded draft cannot be sent                                      | KILLED |
| TB5-08 | An unlinked customer's prompt (it claimed linkage)   | tells an unlinked customer's model to discuss no account at all        | KILLED |
| TB5-09 | The reply-length bound                               | records an over-long reply… as FAILED                                  | KILLED |

**9 of 9 killed.**

A note on TB5-02: an earlier version of the test used an out-of-enum `decision`. The database CHECK refused that write, so the mutant died by the CHECK, not by the schema. The test now uses shapes no CHECK can refuse: an extra key, and an over-long reply.
