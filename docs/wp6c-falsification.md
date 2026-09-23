# WP6-C — customer link rotation falsification record

Each rule below was reverted alone, `customer-rotate-link.test.ts` was run, and the file
was restored byte-for-byte before the next mutation. `docs/wp6c-audit.md` is the design
these rows hold.

| #     | rule                                                 | mutation                                                             | tests that die                                                                                                                                                                                        | result |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WC-01 | the flag is re-read inside the transaction           | the in-transaction flag check disabled                               | `customer-rotate-link.test.ts` › draws no button and refuses the tap while the flag is off; `customer-rotate-link.test.ts` › refuses the tap when the flag is turned off after the question was asked | KILLED |
| WC-02 | a rotation inside the cooldown is refused            | the cooldown comparison disabled                                     | `customer-rotate-link.test.ts` › refuses a second rotation inside the cooldown, and names when it may be asked again                                                                                  | KILLED |
| WC-03 | only a SUCCEEDED rotation counts                     | `FAILED` counted as well                                             | `customer-rotate-link.test.ts` › does not charge a rotation that failed to the cooldown                                                                                                               | KILLED |
| WC-04 | only the customer's own rotations count              | the `requested_by_customer_id` predicate removed                     | `customer-rotate-link.test.ts` › does not start the customer's cooldown with an operator's rotation                                                                                                   | KILLED |
| WC-05 | a replay of the key is answered before the cooldown  | the replay check removed                                             | `customer-rotate-link.test.ts` › answers a redelivered confirmation with the rotation it planned, not the cooldown                                                                                    | KILLED |
| WC-06 | the service row is locked before anything is read    | `lockForUpdate` replaced by an unlocked `findById`                   | `customer-rotate-link.test.ts` › serialises two confirmations under different keys on the service row lock                                                                                            | KILLED |
| WC-07 | a customer rotates an ACTIVE service only            | `SUSPENDED` admitted                                                 | `customer-rotate-link.test.ts` › refuses a SUSPENDED service, which an operator may still rotate                                                                                                      | KILLED |
| WC-08 | a blocked customer is refused inside the transaction | the `BLOCKED` check removed                                          | `customer-rotate-link.test.ts` › refuses a blocked customer inside the transaction                                                                                                                    | KILLED |
| WC-09 | the button is drawn only while the flag is on        | the offer ignores the flag                                           | `customer-rotate-link.test.ts` › draws no button and refuses the tap while the flag is off                                                                                                            | KILLED |
| WC-10 | a customer's own rotation is answered                | `ROTATE_SUBSCRIPTION` removed from `CUSTOMER_REQUESTABLE_OPERATIONS` | `customer-rotate-link.test.ts` › asks first, then rotates the link, delivers it and tells the customer                                                                                                | KILLED |
| WC-11 | the cooldown is the setting in hours                 | hours read as minutes                                                | `customer-rotate-link.test.ts` › refuses a second rotation inside the cooldown, and names when it may be asked again                                                                                  | KILLED |

WC-06 dies because the race case PROVES both requests are waiting on the held service
row before it releases it: with no lock, neither waits, and the case fails rather than
passing on whichever interleaving the scheduler happened to choose.

Every row was killed on its first run. That is the weaker kind of evidence, so the
record says which test died and nothing more. For WC-02 through WC-08 and WC-10 the only
test that dies is the one written for that rule, so no other case is carrying the claim
for it.

What these rows cannot show:

- that a real RickPanel mints a new link on `revoke_sub`. That is the operator rotation's
  acceptance (`docs/rickpanel-rotate-audit.md`), which this package reuses unchanged;
- that the old link stops working. It is not claimed anywhere (OQ-RP-07).
