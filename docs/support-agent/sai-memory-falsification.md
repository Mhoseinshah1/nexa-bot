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

| SAI-M21 | Each message is bounded before the join (PR #236 review, P2) | three long messages never push the newest one out of the customer part | KILLED |

| SAI-M22 | Brackets neutralised by category (back to the pre-review list) | ⁅…⁆ / ⦋…⦌ / ⌈…⌉ / 〈…〉 … around a marker never forges one, in any line (10 failed) | KILLED |
| SAI-M23 | A moved version must name the text it ships (version moved, text not) | pins the policy text to its version, in both directions | KILLED |
| SAI-M24 | A sent automatic decision records the titles it cited | A8 review N2: a sent automatic reply records the knowledge it cited, by title | KILLED |
| SAI-M25 | The customer's words leave a reserve of terms for the other parts | N3: a long customer message leaves terms for the intent, the titles cited and the topic | KILLED |
| SAI-M26 | Topic words count only in a title or a tag | N4: after a vague «باز هم نشد», a topic word matches a title, never a body | KILLED |
| SAI-M27 | The container gives the source its memory | PR #236 review N5: the ASSEMBLED container gives both AI paths a context source with memory | KILLED |
| SAI-M28 | The transcript's character ceiling | past 24,000 characters the oldest lines leave first; the latest always stays | KILLED |

**28 of 28 killed.** After the PR #236 independent review the whole driver was run again on
the review fix: SAI-M11–M13 had to be restated for the reworked scorer (their first anchors no
longer existed), and SAI-M27 first SURVIVED — the wiring probe's article said «باز», which the
vague message matched on its own; the probe article was changed and M27 then died. TB6-22
(`scripts/mutate-tb6.py`) was restated for the line now bounded again after NFKC, and killed.

## Not covered by a mutant

- The contract bounds (eight entries, 24 KiB, 12 KiB) are asserted by value in the unit suites
  (`SUPPORT_CONTEXT_LIMITS.knowledge` is 8; the budget tests fit to the constants) but were not
  mutated: the tests import the built contracts package, so a source mutant needs a rebuild.
