# Package E (RickPanel subscription files) — falsification record

Each rule below was reverted against the Package E branch, and the named test was run:

- **Unit files** ran in the unit project.
- **The integration file** ran against its own test database (`nexa_emut`) and Redis
  database (8), because the suite truncates between tests.

The mutations ran in a separate worktree, never the implementation checkout. Each was
reverted with `git checkout` before the next one ran. A mutation of `packages/contracts`
rebuilds the package before and after, because `@nexa/contracts` resolves to its dist.
Every row is driven by `scripts/mutate-package-e.py`, which is committed.

The first pass left three mutations alive.

- **E-18 was a real gap.** The integration 429 answers about 60 seconds, which is also the
  constant a broken conversion would print, so replacing the arithmetic with `60` passed.
  A unit test now drives the service with a stubbed adapter at 1.5 s, 37 s, 0 and no wait
  at all. E-41 to E-43 were added on the same test: the default, the floor and the rounding.
- **E-05 was a test that said more than it checked.** Its name promised an empty file and
  it carried none. It now has one. Alone, each of the two empty-file guards is an
  equivalent mutant, because the other holds:
  - `decodeStrictBase64` refuses the empty text;
  - `parseSubscriptionFiles` refuses zero decoded bytes.

  The row reverts both, and dies.

- **E-02 is equivalent, and stays alive by design.** A Base64 encoder never emits a length
  that is not a multiple of four. So the re-encode comparison (E-01) already refuses
  everything the length check refuses. The check is an early exit before a
  multi-megabyte buffer is allocated. It is kept, and recorded here so nobody reads its
  survival as a missing test.

Every other row is killed.

E-44 was added for the one Codex finding on #89. The ownership read's catch had turned any failure into NOT_FOUND, an outage included. It now translates only `SERVICE_NOT_FOUND`. E-25 was re-anchored on the narrowed branch and still dies. E-44 widens the branch back to every error, and the outage test dies.

| #    | rule                                                                                   | tests that die                                                                                                            | result     |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| E-01 | A Base64 text must re-encode to itself, never a lenient partial decode                 | `unit/subscription-files.test.ts` › decodes strict Base64 only, never a lenient partial                                   | KILLED     |
| E-02 | A Base64 length is a multiple of four (an early exit; see below)                       | `integration/subscription-files.test.ts` › refuses malformed Base64 as a failed format, never a partial decode            | EQUIVALENT |
| E-03 | More than 20 entries is malformed, never truncated                                     | `unit/subscription-files.test.ts` › refuses more entries than the bound as malformed, never truncating                    | KILLED     |
| E-04 | A file over 5 MiB is a failed format                                                   | `unit/subscription-files.test.ts` › refuses an empty file and one past the per-file bound as failed formats               | KILLED     |
| E-05 | An empty file is a failed format (both guards reverted together)                       | `unit/subscription-files.test.ts` › refuses an empty file and one past the per-file bound as failed formats               | KILLED     |
| E-06 | Files stop at 20 MiB in total; the rest count as failed                                | `unit/subscription-files.test.ts` › stops adding files at the aggregate bound and counts the rest as failed               | KILLED     |
| E-07 | An entry carrying an `error` is counted, not read                                      | `unit/subscription-files.test.ts` › counts a failed format and keeps the others                                           | KILLED     |
| E-08 | A file name is reduced to its base name                                                | `unit/subscription-files.test.ts` › reduces a file name to a safe base name                                               | KILLED     |
| E-09 | A name of only dots falls back to `subscription-<n>`                                   | `unit/subscription-files.test.ts` › reduces a file name to a safe base name                                               | KILLED     |
| E-10 | A media type with a parameter other than `charset` is octet-stream                     | `unit/subscription-files.test.ts` › maps a media type into the closed set, charset allowed, anything else octet-stream    | KILLED     |
| E-11 | A media type outside the closed set is octet-stream                                    | `unit/subscription-files.test.ts` › maps a media type into the closed set, charset allowed, anything else octet-stream    | KILLED     |
| E-12 | A caption loses its control characters, except newline                                 | `unit/subscription-files.test.ts` › cleans and bounds a caption, and drops an empty one                                   | KILLED     |
| E-13 | A caption is bounded to 900 characters                                                 | `unit/subscription-files.test.ts` › cleans and bounds a caption, and drops an empty one                                   | KILLED     |
| E-14 | An answer in no known envelope is malformed, never an empty list                       | `unit/rickpanel-files-adapter.test.ts` › refuses a 200 in no shape it knows as MALFORMED_RESPONSE, never as an empty list | KILLED     |
| E-15 | An unreadable `Retry-After` is the documented minute                                   | `unit/rickpanel-files-adapter.test.ts` › falls back to the documented minute when a 429 says nothing it can read          | KILLED     |
| E-16 | A `Retry-After` is capped at one hour                                                  | `unit/subscription-files.test.ts` › honours Retry-After in seconds and falls back to the documented minute                | KILLED     |
| E-17 | A 429 is RATE_LIMITED and carries its wait                                             | `unit/rickpanel-files-adapter.test.ts` › carries a 429 Retry-After in delta-seconds as milliseconds                       | KILLED     |
| E-18 | The customer is told the panel’s wait in seconds, not a constant                       | `unit/subscription-files.test.ts` › tells the customer the panel’s own wait, rounded up to whole seconds and at least one | KILLED     |
| E-19 | A 404 is `found: false`, not a fault                                                   | `unit/rickpanel-files-adapter.test.ts` › answers a 404 as found:false — a user the panel does not hold, not a fault       | KILLED     |
| E-20 | The username is URL-encoded into the path                                              | `unit/rickpanel-files-adapter.test.ts` › asks the all-files route for the ENCODED username, with the bearer it was issued | KILLED     |
| E-21 | The adapter reports an unparseable 200 as MALFORMED_RESPONSE                           | `unit/rickpanel-files-adapter.test.ts` › refuses a 200 in no shape it knows as MALFORMED_RESPONSE, never as an empty list | KILLED     |
| E-22 | `canFetchSubscriptionFiles` needs the method AND the declaration                       | `unit/subscription-files.test.ts` › requires the method AND the declaration                                               | KILLED     |
| E-23 | RickPanel declares `SUBSCRIPTION_FILES`                                                | `unit/subscription-files.test.ts` › is offered by RickPanel and by no other provider                                      | KILLED     |
| E-24 | The permission is checked before anything is read                                      | `unit/subscription-files.test.ts` › checks the permission before it reads anything                                        | KILLED     |
| E-25 | A service that is not the customer’s answers NOT_FOUND, not a thrown refusal           | `integration/subscription-files.test.ts` › never sends another customer's files, and never asks the panel                 | KILLED     |
| E-26 | Ownership is in the query: the customer predicate                                      | `integration/subscription-files.test.ts` › never sends another customer's files, and never asks the panel                 | KILLED     |
| E-27 | Ownership is in the query: the tenant predicate                                        | `integration/subscription-files.test.ts` › never serves another tenant's service                                          | KILLED     |
| E-28 | `send` refuses a state whose files may not be read                                     | `unit/subscription-files.test.ts` › does not offer, nor fetch, the files of a service that is not readable                | KILLED     |
| E-29 | `offered` refuses a state whose files may not be read                                  | `integration/subscription-files.test.ts` › draws no files button where the panel cannot fetch files                       | KILLED     |
| E-30 | A DISABLED panel is not asked                                                          | `unit/subscription-files.test.ts` › asks nothing of a panel the operator disabled                                         | KILLED     |
| E-31 | A panel address the URL policy refuses is not dialled                                  | `unit/subscription-files.test.ts` › never dials a panel address the URL policy refuses                                    | KILLED     |
| E-32 | An unreadable stored credential asks nothing of the panel                              | `unit/subscription-files.test.ts` › asks nothing of a panel whose stored credential cannot be read                        | KILLED     |
| E-33 | An empty outbound budget asks nothing of the panel                                     | `unit/subscription-files.test.ts` › asks nothing of the panel when the tenant’s outbound budget is spent                  | KILLED     |
| E-34 | The first send Telegram declines stops the rest                                        | `integration/subscription-files.test.ts` › stops at the first send Telegram declines and retries nothing                  | KILLED     |
| E-35 | The failed-format count reaches the result                                             | `integration/subscription-files.test.ts` › sends the usable formats and counts the one the panel failed to build          | KILLED     |
| E-36 | No usable file is UNAVAILABLE, not an empty SENT                                       | `integration/subscription-files.test.ts` › answers UNAVAILABLE when every format failed, and sends nothing                | KILLED     |
| E-37 | The bot draws the button only where `offered` says so                                  | `integration/subscription-files.test.ts` › draws no files button where the panel cannot fetch files                       | KILLED     |
| E-38 | Files go only to the private chat the tap came from                                    | `integration/subscription-files.test.ts` › sends nothing to a tap that did not come from a private chat                   | KILLED     |
| E-39 | A partial result tells the customer the count                                          | `integration/subscription-files.test.ts` › tells the customer how many formats could not be built                         | KILLED     |
| E-40 | A 429 is answered with the wait, not "unavailable"                                     | `integration/subscription-files.test.ts` › tells the customer how long to wait after a 429                                | KILLED     |
| E-41 | A 429 with no wait is told the documented minute                                       | `unit/subscription-files.test.ts` › tells the customer the panel’s own wait, rounded up to whole seconds and at least one | KILLED     |
| E-42 | The wait is at least one second                                                        | `unit/subscription-files.test.ts` › tells the customer the panel’s own wait, rounded up to whole seconds and at least one | KILLED     |
| E-43 | The wait is rounded UP, never down                                                     | `unit/subscription-files.test.ts` › tells the customer the panel’s own wait, rounded up to whole seconds and at least one | KILLED     |
| E-44 | Only SERVICE_NOT_FOUND is NOT_FOUND; a failed ownership read propagates (Codex on #89) | `unit/subscription-files.test.ts` › lets a failed ownership read propagate, never answering it as NOT_FOUND               | KILLED     |
