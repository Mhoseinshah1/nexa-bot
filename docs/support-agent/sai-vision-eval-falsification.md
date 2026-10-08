# A9/A10 — falsification record (vision and the evaluation corpus)

Driver: `scripts/mutate-sai-vision-eval.py`. Each mutation reverts one rule, runs the named test,
and restores the file with `git checkout`. Run on 2026-10-08 against a dedicated integration
database (`nexa_test_sai2`), after branch 2 took in the PR #236 review fixes.

SAI-E11 first SURVIVED: it removed «وقت» from the stop words, but «وقتی» was still one, so the
corpus's greeting could no longer reach the expiry article by that road. The mutant now removes
the pair the corpus finding added together, and dies; SAI-E10 pins «وقت» alone in the unit test.

| ID      | Rule reverted                                                     | Test that failed (assertion)                                                     | Result |
| ------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| SAI-V01 | OpenAI images go at `detail: 'high'` (back to `low`)              | OpenAI: an image_url part carrying a base64 data URL                             | KILLED |
| SAI-V02 | One request's images stay within 15 MiB together                  | A9: the images together stay within the total, the most recent kept first        | KILLED |
| SAI-V03 | A step is given at most four images (back to two)                 | never more than 4 images in one request, the most recent                         | KILLED |
| SAI-V04 | The vision plan fetches the four most recent (back to two)        | the four most recent customer images, newest first; older ones OVER_LIMIT        | KILLED |
| SAI-V05 | The same, end to end through the database and a Telegram stand-in | at most the four most recent images go with a request; the oldest is OVER_LIMIT  | KILLED |
| SAI-E01 | A live run is refused under CI                                    | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E02 | A live run needs a test key                                       | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E03 | A live run needs `--live`                                         | every condition is required, and CI refuses outright                             | KILLED |
| SAI-E04 | The scorer catches a leak                                         | a leak of the canary, a marker or the policy is caught                           | KILLED |
| SAI-E05 | A fail-closed image asks no model                                 | a fail-closed image and the money check ask no model at all                      | KILLED |
| SAI-E06 | The scorer catches an invented citation                           | a wrong decision, a wrong topic and an invented citation are each caught         | KILLED |
| SAI-E07 | The scorer checks the guard outcome                               | an automatic answer where a person must answer is caught by the guard check      | KILLED |
| SAI-E08 | The scorer checks the article ranked first                        | a missing article, a wrong first article and an excluded article are each caught | KILLED |
| SAI-E09 | The scorer checks that an expected article was selected           | a missing article, a wrong first article and an excluded article are each caught | KILLED |
| SAI-E10 | «وقت» is a stop word (the corpus's finding)                       | a greeting matches nothing and carries no knowledge                              | KILLED |
| SAI-E11 | «وقت»/«وقتی» are stop words, seen through the corpus              | every scenario passes every check that applies, with no network call             | KILLED |

**16 of 16 killed.**

## Not covered by a mutant

- The contract bounds (`SUPPORT_AI_VISION_MAX_IMAGES` = 4, `SUPPORT_AI_VISION_MAX_TOTAL_BYTES` =
  15 MiB) are asserted by value in `support-ai-vision.test.ts` but were not mutated at the source:
  the tests import the built contracts package. V03/V04 mutate the code paths that read them.
- The CLI's `main` (provider construction, the paid-call warning) is not unit-tested; its rules
  live in `live-args.ts`, which is. A live run is NOT RUN (`sai-eval.md`).
