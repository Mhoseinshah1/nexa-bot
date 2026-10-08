# A9/A10 — falsification record (vision and the evaluation corpus)

Driver: `scripts/mutate-sai-vision-eval.py`. Each mutation reverts one rule, runs the named test,
and restores the file with `git checkout`. Run on 2026-10-08 against a dedicated integration
database (`nexa_test_sai2`), after branch 2 took in the PR #236 review fixes.

The first record's SAI-E10/E11 pinned «وقت»/«وقتی» as stop words. The PR #244 review (MAJOR-1)
showed that broke expiry retrieval; the stop words are gone, the greeting is a phrase, and
E10/E11 now pin the new rule.

| ID      | Rule reverted                                                                 | Test that failed (assertion)                                                     | Result |
| ------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| SAI-V01 | OpenAI images go at `detail: 'high'` (back to `low`)                          | OpenAI: an image_url part carrying a base64 data URL                             | KILLED |
| SAI-V02 | One request's images stay within 15 MiB together                              | A9: the images together stay within the total, the most recent kept first        | KILLED |
| SAI-V03 | A step is given at most four images (back to two)                             | never more than 4 images in one request, the most recent                         | KILLED |
| SAI-V04 | The vision plan fetches the four most recent (back to two)                    | the four most recent customer images, newest first; older ones OVER_LIMIT        | KILLED |
| SAI-V05 | The same, end to end through the database and a Telegram stand-in             | at most the four most recent images go with a request; the oldest is OVER_LIMIT  | KILLED |
| SAI-E01 | A live run is refused under CI                                                | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E02 | A live run needs a test key                                                   | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E03 | A live run needs `--live`                                                     | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E04 | The scorer catches a leak                                                     | a leak of the canary, a marker or the policy is caught                           | KILLED |
| SAI-E05 | A fail-closed image asks no model                                             | a fail-closed image and the money check ask no model at all                      | KILLED |
| SAI-E06 | The scorer catches an invented citation                                       | a wrong decision, a wrong topic and an invented citation are each caught         | KILLED |
| SAI-E07 | The scorer checks the guard outcome                                           | an automatic answer where a person must answer is caught by the guard check      | KILLED |
| SAI-E08 | The scorer checks the article ranked first                                    | a missing article, a wrong first article and an excluded article are each caught | KILLED |
| SAI-E09 | The scorer checks that an expected article was selected                       | a missing article, a wrong first article and an excluded article are each caught | KILLED |
| SAI-E10 | The greeting «وقت بخیر» is removed as a phrase (PR #244, MAJOR-1)             | «سلام وقت بخیر» still selects nothing                                            | KILLED |
| SAI-E11 | «وقت» is NOT a stop word (MAJOR-1)                                            | «وقتم تموم شد» … ranks the expiry article first (4 failed)                       | KILLED |
| SAI-E12 | A SENT job is memory only while its lane row could reach the customer (CX1)   | PR #244 CX1: a SENT job whose lane row FAILED or was SUPERSEDED is not memory    | KILLED |
| SAI-E13 | The episode stops at the support reply before it (CX2)                        | PR #244 CX2: the episode stops at its own boundary                               | KILLED |
| SAI-E14 | The episode stops at a person's or an automatic line (CX2)                    | PR #244 CX2: the episode stops at its own boundary                               | KILLED |
| SAI-E15 | The step's own capabilities choose the images (CX3, MINOR-2)                  | MINOR-2: the per-adapter fit decides too                                         | KILLED |
| SAI-E16 | The production autoImageGuard decides an unloaded image (MINOR-2)             | MINOR-2: an unseen latest image fails closed through autoImageGuard              | KILLED |
| SAI-E17 | no_leak compares normalised text (CX4)                                        | CX4: a leak in another case, Unicode form, spacing or with a ZWNJ                | KILLED |
| SAI-E18 | The clarifying streak comes from the earlier decisions (CX5)                  | CX5: the clarifying limit is evaluated from the scenario's earlier decisions     | KILLED |
| SAI-E19 | CI set to the empty string is CI (MINOR-4)                                    | CI set to the empty string: no paid provider is built                            | KILLED |
| SAI-E20 | The factory holding the key runs only after the refusal check (MINOR-4)       | … no paid provider is built, the factory never runs (4 failed)                   | KILLED |
| SAI-E21 | A paid provider under CI is refused however it was built (MINOR-4)            | a paid provider under CI is refused, however it was built                        | KILLED |
| SAI-E22 | The PII guard folds Persian/Arabic-Indic digits (MINOR-3; a test-file mutant) | the guard fires on … (4 failed)                                                  | KILLED |
| SAI-V06 | Past the total an image is skipped, not the end of the walk (NIT-1)           | A9: past the total an image is skipped, and an older, smaller one still goes     | KILLED |
| SAI-V07 | The total, end to end into `support_ai_image_outcomes` (NIT-2)                | PR #244 NIT-2: past the 15 MiB total the oldest image is recorded OVER_LIMIT     | KILLED |

**30 of 30 killed** (run on 2026-10-08 after the PR #244 review). On that run SAI-E01 and SAI-E04
were restated (the CI check and the leak comparison they mutate were rewritten), and SAI-E15
first SURVIVED under the blind-adapter test — with `vision: false` nothing is fetched, so
`autoImageGuard` fails closed whichever capabilities `stepSight` is given; it is named against
the per-adapter-fit test, where only `stepSight` decides, and dies there.

## Not covered by a mutant

- The contract bounds (`SUPPORT_AI_VISION_MAX_IMAGES` = 4, `SUPPORT_AI_VISION_MAX_TOTAL_BYTES` =
  15 MiB) are asserted by value in `support-ai-vision.test.ts` but were not mutated at the source:
  the tests import the built contracts package. V03/V04 mutate the code paths that read them.
- The CLI's `main` only wires `evalProviders` (tested, E19–E21) to the real adapters; the wiring
  itself is not run by a test. A live run is NOT RUN (`sai-eval.md`).
