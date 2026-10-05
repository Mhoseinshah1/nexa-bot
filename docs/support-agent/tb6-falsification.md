# TB6 — falsification record

Driver: `scripts/mutate-tb6.py`. Each mutation reverts one rule, runs the named test, and restores the file. The driver prints the first failing assertion, so a mutant that died by crashing shows up as a crash rather than as a kill. Run on 2026-10-04 against a dedicated integration database (`nexa_test_tb6`).

| ID     | Rule reverted                                                                 | Test that failed (assertion)                                         | Result |
| ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| TB6-01 | The reference is the largest size (it became the first)                       | keeps the LARGEST size by area                                       | KILLED |
| TB6-02 | WEBP needs the `WEBP` form type (any RIFF was accepted)                       | refuses a RIFF that is not WEBP (WAV)                                | KILLED |
| TB6-03 | The bound passed to the transport and re-checked (the 20 MiB default applied) | aborts a stream that passes the bound, and calls it TOO_LARGE        | KILLED |
| TB6-04 | A declared size over the bound costs no request                               | refuses a declared size over the bound before any network call       | KILLED |
| TB6-05 | Too large is told apart from a download failure                               | aborts a stream… TOO_LARGE                                           | KILLED |
| TB6-06 | The reference is read by tenant and conversation (by message id alone)        | never fetches another tenant's message, whatever ids it is handed    | KILLED |
| TB6-07 | Only a step that declares `vision` gets an image                              | a required image skips the blind primary for the vision fallback     | KILLED |
| TB6-08 | Nothing is downloaded when no configured step can see                         | a step without vision never receives the image…                      | KILLED |
| TB6-09 | At most the two most recent images                                            | at most the two most recent images go with a request                 | KILLED |
| TB6-10 | The chain refuses a request carrying more than two images                     | never more than 2 images in one request                              | KILLED |
| TB6-11 | Fail closed: an unprocessable latest image hands off and no model is asked    | a latest image that cannot be processed (both cases)                 | KILLED |
| TB6-12 | A required image is never answered by a blind step                            | a required image skips the blind primary for the vision fallback     | KILLED |
| TB6-13 | Policy rule 11: text inside an image is data                                  | says text inside an image is data…                                   | KILLED |
| TB6-14 | A captioned photo is still marked as an image                                 | marks every photo, caption or not                                    | KILLED |
| TB6-15 | PROCESSED only when the answering step was given the image                    | an image is PROCESSED only when the step that answered was given it  | KILLED |
| TB6-16 | Z.AI declares no vision                                                       | Z.AI declares no vision, and refuses an image without a network call | KILLED |
| TB6-17 | A caption-less photo's reference is purged with the text                      | the reference is purged with the text, and at once on delete         | KILLED |
| TB6-18 | OpenAI receives a base64 `data:` URL                                          | OpenAI: an image_url part carrying a base64 data URL                 | KILLED |

**18 of 18 killed, every one by an assertion.**

TB6-07 survived the first run. In the integration stub, the blind adapter declared no image types and a size of 0, so `stepCanSee` refused it for the type even with the `vision` check deleted. The stub now declares the types and a size, so only the `vision` flag can decide. With that change the mutant dies.

The following were not mutated, and the reason for each:

- `markDeleted` clearing the reference. Reverting it violates the `business_messages_photo_deleted_check` CHECK, so the database refuses that write before any test assertion could run. The rule is held by the schema.
- The tenant condition in `photoReference` on its own. Conversation ids are unique and the conversation is itself read by tenant, so removing only that condition is an equivalent mutant. TB6-06 removes it together with the conversation condition.

## Substitute review of PR #201 — every fix, falsified

One read-only substitute review ran. It found no blocking defect, four should-fix defects and five nits; all were valid and all are fixed. Each fix has a regression test, and reverting the fix fails that test. Run on 2026-10-05 against `nexa_test_tb6fix`; the whole driver, TB6-01 to TB6-28, ran again with the fixes in place.

| ID     | Finding                                                                                    | Fix                                                                                                                            | Regression test                                                  | Result |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------ |
| TB6-19 | S1: image rows were inserted before the result write, and committed when the job was gone  | the rows are written only after the conditional result write lands, in the same transaction                                    | S1 (discarded during the call; a second writer after a takeover) | KILLED |
| TB6-20 | S4: "nothing is written for a stopped tenant" had no test                                  | — (the rule held; a test now pins it)                                                                                          | S4                                                               | KILLED |
| TB6-21 | S2: an edit after the 30-day purge restored a `file_id`                                    | the three photo columns are guarded by `text_purged_at IS NULL`, as the text is                                                | S2: an edit after the 30-day purge                               | KILLED |
| TB6-22 | S3: a customer's text or caption could carry a marker verbatim and forge an attached image | every square bracket in a line's own text becomes a parenthesis; rule 12 says so; policy `tb6-2026-10-05`                      | … never forges it (5 cases)                                      | KILLED |
| TB6-23 | N1: nothing pinned that Anthropic's raw bound encodes within 5 MB of base64                | — (the bound held; a test now pins `ceil(max/3)*4 <= 5_000_000`)                                                               | Anthropic: its declared image bound encodes within…              | KILLED |
| TB6-24 | N2: the lease did not cover the image downloads                                            | `+ SUPPORT_AI_VISION_MAX_IMAGES * 2 * SUPPORT_AI_VISION_FETCH_TIMEOUT_MS`, derived by `assistantLeaseMs`                       | the lease covers every image download leg…                       | KILLED |
| TB6-25 | N3: one oversized older image stopped a step from seeing the latest one                    | `stepSight`: an image that does not fit is dropped for that step only (`NO_VISION_CAPABILITY`); a required one still hands off | N3: an older image too large for the step…                       | KILLED |
| TB6-26 | N4: `business_messages_photo_shape_check` allowed a size without a reference               | the CHECK requires the reference for a size (0204 regenerated)                                                                 | a photo size never stands without a reference                    | KILLED |
| TB6-27 | N4: the handoff shape CHECK did not pin the reply                                          | reply `''`, or NULL only once purged; no model, no summary; `IS NOT DISTINCT FROM` (0204 regenerated)                          | a fail-closed handoff holds an empty reply…                      | KILLED |
| TB6-28 | N5: `imagesUnseen` counted the business's own photos                                       | only `INBOUND` photos are counted                                                                                              | N5                                                               | KILLED |

TB6-07, TB6-10, TB6-12 and TB6-15 had their anchors moved to the new shape of the code (`stepSight`, `requiredId`, the per-image reason) and still revert the same rule; all four were killed again.

TB6-26 and TB6-27 are database mutants: a CHECK lives in the migrated database, not in `schema.ts`. The driver swaps the constraint for its pre-review form, runs the test, repairs any row the weak form let in, and restores the reviewed form.

The first draft of TB6-27's CHECK used `suggested_reply = ''`. Its own test caught that a CHECK passes on NULL, so `= ''` let a NULL reply through; it is `IS NOT DISTINCT FROM ''`.

Migration `0204` was regenerated in place (TB6 is neither merged nor deployed). Its snapshot id changed, so the branches stacked above (TB7 to TB10) must regenerate their snapshots.

**28 of 28 killed, every one by an assertion.**
