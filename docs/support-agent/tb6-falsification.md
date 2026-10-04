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
