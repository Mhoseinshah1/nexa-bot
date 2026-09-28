# Package F (service transfer) — falsification record

Each rule below was reverted against the Package F branch, and the named test was run.

- **The unit file** ran in the unit project.
- **The integration file** ran against its own test database (`nexa_fmut`) and Redis
  database (14), because the suite truncates between tests.

The mutations ran in a separate worktree, never the implementation checkout. Each was
reverted with `git checkout` before the next one ran. Two kinds of row need more than that:

- **A contract mutation** rebuilds `@nexa/contracts` before and after, because the package
  resolves to its dist.
- **A migration mutation** runs on a freshly created database, which is dropped and
  recreated again after the restore. The migrator records a migration as applied and never
  re-reads it, so a mutated trigger is only seen by a database that never had the real one.

Every row is driven by `scripts/mutate-package-f.py`, which is committed.

## Gaps the first pass found

Before the first pass, three rules had no test that could fail when they were reverted.
Each gained one before the run:

- **The newest-row order.** The ownership trigger and the replay read both depend on it. Its
  new test is a round trip, A → B → A: the first row names the opposite direction, so
  reading it instead of the newest refuses the give-back (F-36) and the recipient's second
  tap (F-22).
- **The sender's own status.** Its new test is a blocked sender.
- **The scope-activity read inside the transaction.** Its new test is a stopped tenant.

The first pass then left one row alive:

- **F-32.** The trial test asked the evaluator directly and never rendered the bot's service
  detail, so a bot that drew the button whenever the feature was wired passed. The test now
  renders the detail and checks its keyboard. The happy path already proves the button
  appears on a transferable service, so this is not a vacuous absence.

F-42 to F-45 were added for the one Codex finding on #90. A confirmation drawn before the
service changed hands and came back was still obeyed: the service was the sender's again,
so no replay applied, and Telegram leaves an old keyboard tappable. The confirmation now
carries the ownership version it was drawn at, and a stale one is refused. The four rows
revert:

- the comparison under the lock (F-42);
- the version the preview reads (F-43);
- the decoder's demand for a version (F-44);
- the bound that keeps the payload within 64 bytes (F-45).

All 45 rows were run again on the fixed head, and all 45 are killed. F-22 needed its anchor moved first: the fix added `count` to the repository import the row edits.

| #    | rule                                                                             | tests that die                                                                                                                          | result |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | Only an ACTIVE or SUSPENDED service may change hands                             | `unit/service-transfer.test.ts` › refuses a service that is %s                                                                          | KILLED |
| F-02 | Only a DELIVERED subscription may change hands                                   | `unit/service-transfer.test.ts` › refuses a service whose link is %s rather than DELIVERED                                              | KILLED |
| F-03 | A trial never changes hands                                                      | `integration/service-transfer.test.ts` › refuses a trial, and draws no button for one                                                   | KILLED |
| F-04 | An undecided operation holds the service                                         | `integration/service-transfer.test.ts` › refuses a service an operator has planned to terminate, and a usage read the sender asked for  | KILLED |
| F-05 | An open refund request holds the service                                         | `integration/service-transfer.test.ts` › refuses a service with an OPEN refund request                                                  | KILLED |
| F-06 | A commercial order awaiting payment, or paid and unapplied, holds the service    | `integration/service-transfer.test.ts` › refuses a service with a paid renewal not yet applied, and one awaiting payment                | KILLED |
| F-07 | SUSPENDED is transferable (`SERVICE_TRANSFERABLE_STATES`)                        | `integration/service-transfer.test.ts` › transfers a SUSPENDED service, which the brief names beside an ACTIVE one                      | KILLED |
| F-08 | A scheduled usage read does not hold the service                                 | `integration/service-transfer.test.ts` › lets a SCHEDULED usage read through: nobody asked for it and nobody is told                    | KILLED |
| F-09 | A usage read the customer asked for does hold it                                 | `integration/service-transfer.test.ts` › refuses a service an operator has planned to terminate, and a usage read the sender asked for  | KILLED |
| F-10 | The pending-payment read looks for AWAITING_PAYMENT                              | `integration/service-transfer.test.ts` › refuses a service with a paid renewal not yet applied, and one awaiting payment                | KILLED |
| F-11 | The transfer takes the service's row lock                                        | `integration/service-transfer.test.ts` › loses to a terminate that holds the service first, and moves nothing                           | KILLED |
| F-12 | The transfer takes the lifecycle lock a settlement takes                         | `integration/service-transfer.test.ts` › takes the lifecycle lock a settlement takes, and waits for whoever holds it                    | KILLED |
| F-13 | Eligibility is decided again under both locks                                    | `integration/service-transfer.test.ts` › loses to a terminate that holds the service first, and moves nothing                           | KILLED |
| F-14 | A customer cannot transfer to themselves                                         | `integration/service-transfer.test.ts` › refuses a transfer to oneself, and writes nothing                                              | KILLED |
| F-15 | A blocked recipient is refused                                                   | `integration/service-transfer.test.ts` › refuses a blocked recipient with the same sentence as an unknown one                           | KILLED |
| F-16 | A blocked sender is refused                                                      | `integration/service-transfer.test.ts` › refuses a sender who has been blocked, and moves nothing                                       | KILLED |
| F-17 | A tenant that stopped accepting work is refused, inside the transaction          | `integration/service-transfer.test.ts` › refuses a transfer in a tenant that has stopped accepting work                                 | KILLED |
| F-18 | A replayed key answers with the transfer it made                                 | `integration/service-transfer.test.ts` › answers a replayed key with the transfer it made, and a later tap with the same one            | KILLED |
| F-19 | A key reused for a different service is refused, not replayed                    | `integration/service-transfer.test.ts` › answers a replayed key with the transfer it made, and a later tap with the same one            | KILLED |
| F-20 | A second tap under a new key is answered with the transfer it lost to            | `integration/service-transfer.test.ts` › serialises a double tap under two keys: one transfer, and both answered with it                | KILLED |
| F-21 | That answer requires the SAME recipient; another one is not found                | `integration/service-transfer.test.ts` › serialises two transfers to two recipients: exactly one moves the service                      | KILLED |
| F-22 | The replay read takes the newest transfer row, by `seq`                          | `integration/service-transfer.test.ts` › is given back by its recipient: the newest row counts, never the first                         | KILLED |
| F-23 | The sender's note is cleared                                                     | `integration/service-transfer.test.ts` › clears the sender’s note, so the recipient never reads it                                      | KILLED |
| F-24 | The audit row is written                                                         | `integration/service-transfer.test.ts` › transfers a service from the service detail, confirmed with the brief’s own words              | KILLED |
| F-25 | The `ServiceOwnershipTransferred` event is written                               | `integration/service-transfer.test.ts` › transfers a service from the service detail, confirmed with the brief’s own words              | KILLED |
| F-26 | The recipient's notification is enqueued in the transaction                      | `integration/service-transfer.test.ts` › tells the recipient through the dispatcher, with one «مشخصات سرویس» button opening the service | KILLED |
| F-27 | The notification is sent only while the recipient still holds the service        | `integration/service-transfer.test.ts` › supersedes the notification of a recipient who no longer holds the service when it is sent     | KILLED |
| F-28 | `SERVICE_TRANSFER_RECEIVED` is a kind the subject reader answers                 | `integration/service-transfer.test.ts` › supersedes the notification of a recipient who no longer holds the service when it is sent     | KILLED |
| F-29 | The notification carries its one button                                          | `integration/service-transfer.test.ts` › tells the recipient through the dispatcher, with one «مشخصات سرویس» button opening the service | KILLED |
| F-30 | A payer who no longer owns the service is refused: the wallet is not taken       | `integration/service-transfer.test.ts` › refuses to settle the old owner’s renewal from the wallet, and takes nothing                   | KILLED |
| F-31 | The same refusal gives money that already arrived back                           | `integration/service-transfer.test.ts` › refunds the old owner’s bank transfer for a renewal of a service they gave away                | KILLED |
| F-32 | The bot draws the transfer button only where the evaluator allows it             | `integration/service-transfer.test.ts` › refuses a trial, and draws no button for one                                                   | KILLED |
| F-33 | A refused recipient keeps the prompt open                                        | `integration/service-transfer.test.ts` › refuses an unknown recipient and text that is no numeric id, keeping the window open           | KILLED |
| F-34 | The database refuses a change of owner no transfer row names                     | `integration/service-transfer.test.ts` › refuses a change of owner with no transfer row, and one the newest row does not name           | KILLED |
| F-35 | …including one the newest row names wrongly                                      | `integration/service-transfer.test.ts` › refuses a change of owner with no transfer row, and one the newest row does not name           | KILLED |
| F-36 | The trigger reads the newest row, by `seq`                                       | `integration/service-transfer.test.ts` › is given back by its recipient: the newest row counts, never the first                         | KILLED |
| F-37 | A service's order is immutable                                                   | `integration/service-transfer.test.ts` › refuses a change of the order a service was bought by                                          | KILLED |
| F-38 | A service is written for its order's customer                                    | `integration/service-transfer.test.ts` › refuses a service written for a customer other than its order’s                                | KILLED |
| F-39 | A commercial action is written for the service's owner                           | `integration/service-transfer.test.ts` › refuses a commercial action written for a customer who does not own the service                | KILLED |
| F-40 | Transfer rows cannot be updated                                                  | `integration/service-transfer.test.ts` › keeps the transfer rows append-only                                                            | KILLED |
| F-41 | Transfer rows cannot be deleted                                                  | `integration/service-transfer.test.ts` › keeps the transfer rows append-only                                                            | KILLED |
| F-42 | A confirmation older than the last change of owner is refused (Codex on #90)     | `integration/service-transfer.test.ts` › refuses a confirmation drawn before the service changed hands and came back                    | KILLED |
| F-43 | The confirmation carries the ownership version read when it was drawn            | `integration/service-transfer.test.ts` › refuses a confirmation drawn before the service changed hands and came back                    | KILLED |
| F-44 | A `tc:` payload without a version is UNSUPPORTED, never a version-0 confirmation | `unit/bot-runtime.test.ts` › answers %s as UNSUPPORTED, never a half-read                                                               | KILLED |
| F-45 | No confirmation is drawn past the largest version a 64-byte payload can carry    | `unit/bot-runtime.test.ts` › round-trips every version shape, and draws nothing past the largest one                                    | KILLED |
