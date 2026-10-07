# A7/A8 — falsification record (memory and knowledge retrieval)

Driver: `scripts/mutate-sai-memory.py`. Each mutation reverts one rule, runs the named test, and
restores the file with `git checkout`. The driver prints the first failing assertion, so a mutant
that died by crashing shows up as a crash rather than as a kill. Run on 2026-10-07 against a
dedicated integration database (`nexa_test_sai2`).

The first run left four survivors (M12, M14, M16, M20): the tests reached the right answer by
another road — the topic's vocabulary found the article the episode was meant to find, and the
higher weight happened to be written last. The tests were sharpened so each one isolates its
rule (the episode test now uses a topic whose vocabulary matches nothing; the continuity test has
no topic and no intent; the weight test puts the higher weight first), M20 now cuts the earlier
decisions off at the context source, and the four were run again.

| ID      | Rule reverted                                                               | Test that failed (assertion)                                                                      | Result |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| SAI-M01 | An echo takes the lane of the reply it is                                   | an echo takes the lane of the reply it is                                                         | KILLED |
| SAI-M02 | An AI draft a person sent is `AI_ASSIST` (it became `STAFF`)                | a reply line is authored by its lane                                                              | KILLED |
| SAI-M03 | A support-side line opens with its author marker                            | every support line opens with its author marker; a customer line carries none                     | KILLED |
| SAI-M04 | A line's own text is neutralised before a marker is placed beside it        | the customer / an automatic reply typing an author marker never forges one                        | KILLED |
| SAI-M05 | A customer message is never relabelled                                      | a customer message is never relabelled, whatever reply shares its id                              | KILLED |
| SAI-M06 | 60 lines are read (it became 40)                                            | readSupportTranscript asks both repositories for 60 and merges them                               | KILLED |
| SAI-M07 | 40 lines reach the model (it became 20)                                     | the model sees the 40 most recent of the 60 lines                                                 | KILLED |
| SAI-M08 | Rule 13 forbids writing a marker into a reply                               | explains every author marker, and that a marker is never part of a reply                          | KILLED |
| SAI-M09 | The policy text cannot change without its version                           | pins the policy text to its version                                                               | KILLED |
| SAI-M10 | A zero-score entry is never sent                                            | A8: no match, or no query, selects nothing — a zero score is never sent                           | KILLED |
| SAI-M11 | A term counts at its part's weight                                          | a weighted part scores less than the same words from the customer                                 | KILLED |
| SAI-M12 | A term in two parts counts at the higher weight (last write won)            | a term counts once, at the highest weight of the parts it appears in                              | KILLED |
| SAI-M13 | At most 64 query terms, the highest-priority part's first                   | the term bound keeps the highest-priority part's terms                                            | KILLED |
| SAI-M14 | An open troubleshooting episode adds the earlier description                | THE EPISODE: the earlier description, not the topic alone, picks the article                      | KILLED |
| SAI-M15 | An episode is open only after a step or a question                          | troubleshooting is open only after a step or a question on a troubleshooting topic                | KILLED |
| SAI-M16 | The titles cited before join the query                                      | CONTINUITY: the article cited before stays ahead when the customer only answers «yes»             | KILLED |
| SAI-M17 | The context source reads the conversation's earlier decisions               | reads the conversation's latest decisions and passes the weighted query on                        | KILLED |
| SAI-M18 | Only `READY`/`SENT` jobs are earlier decisions (discarded and failed added) | A8: priorDecisions reads decided jobs, newest first — never discarded, failed or another tenant's | KILLED |
| SAI-M19 | `priorDecisions` is tenant-scoped                                           | A8: priorDecisions reads decided jobs … never … another tenant's                                  | KILLED |
| SAI-M20 | The earlier decisions reach the query, end to end through the database      | A8 end to end: on a repeated failure the draft still carries the article                          | KILLED |

**20 of 20 killed.**

## Not covered by a mutant

- The container passes the job repository to `TbSupportContextSource`. The integration suites
  build their services themselves, so no test runs the container's wiring of this source;
  removing the second argument silently turns the memory off in production (the D2 behaviour,
  the customer's words alone). Pinning it needs a test over the container's assembled
  assistant, which no suite has today.
- The contract bounds (eight entries, 24 KiB, 12 KiB) are asserted by value in the unit suites
  (`SUPPORT_CONTEXT_LIMITS.knowledge` is 8; the budget tests fit to the constants) but were not
  mutated: the tests import the built contracts package, so a source mutant needs a rebuild.
