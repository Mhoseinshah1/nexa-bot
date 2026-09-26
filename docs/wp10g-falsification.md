# WP10G — falsification record

Customer blocking consistency (`docs/customer-blocking-consistency-audit.md`): every
generic block now needs a reason, on every surface. Each rule below was reverted ALONE in
the working tree, the named file run against a freshly created test database, and the
source restored byte-for-byte before the next mutation (the driver refuses to continue if
`git diff` of the mutated file is not empty afterwards).

| #      | rule                                                                 | mutation                                                            | tests that die                                                                                                                      | result |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G10-01 | the service refuses a block with no usable reason, from any caller   | the `CUSTOMER_BLOCK_REASON_REQUIRED` refusal in `setStatus` removed | `customers-http.test.ts` › the service refuses a reason-less block from any caller, not only the schema                             | KILLED |
| G10-02 | an empty reason is no reason                                         | `normaliseBlockReason` returns the empty string instead of null     | `customer-block-rule.test.ts` › the service normaliser refuses rather than cuts, counting code points                               | KILLED |
| G10-03 | an unblock clears the stored reason, whatever note it carries        | `blockedReason` written as the request's reason on an unblock too   | `customers-http.test.ts` › an unblock WITH a note clears the stored reason and never stores the note as one                         | KILLED |
| G10-04 | a second block of a blocked customer leaves the stored reason alone  | the `status = from` condition removed from the repository's UPDATE  | `customers-http.test.ts` › a second block of a blocked customer leaves the stored reason untouched                                  | KILLED |
| G10-05 | the Web Admin sends no block until a reason is typed                 | the confirm button's `trimmedReason === ''` disable removed         | `users.test.tsx` › sends no block until a non-empty reason is typed                                                                 | KILLED |
| G10-06 | a Telegram `9:b:` tap asks and writes nothing                        | `b` mapped to `ADMIN_CUSTOMER` in the `9:` code table               | `telegram-admin-customers.test.ts` › the block button asks first and writes nothing                                                 | KILLED |
| G10-07 | a Customers-section block is the capture's command, not the update's | `customerBlockCaptureKey` returns the receipt capture's prefix      | `customer-block-surface.test.ts` › a block from the Telegram Customers section is remembered under TELEGRAM, with the capture’s key | KILLED |

G10-03 SURVIVED its first run: no test sent an unblock with a note, so a note stored as
`blocked_reason` on an ACTIVE customer went unseen. The test cited above was added in the
same commit as this record, and the mutation re-run against it.

## Rows re-cited in older records

WP10G replaced the one-tap block with ask → reason → confirm, which renamed or re-premised
tests older records cite. Each was re-run against the new test, not re-pointed on trust:

- `docs/wp2-falsification.md` T-03 and T-04 — the block button's intent and target — now
  die on _the block button asks first and writes nothing_ and _blocks a customer through
  ask → reason → confirm, and the reply offers the unblock_.
- `docs/prerelease-hardening-falsification.md` PRH-07 (the actor's surface) dies on the
  renamed Customers-section test. PRH-08's rule — the `:customer-status` suffix on the
  update's key — no longer exists: the block's key comes from the capture. The row now
  records the equivalent rule and its re-run.
- `docs/wp10-falsification.md` PAY-108 (code points, not UTF-16 units) now dies only on
  _stores the whole confirmed block reason, counted in code points_: the bound refuses
  rather than cuts, so the old "never cuts a character in half" test is gone and the
  over-bound refusal counts the same way whichever unit is used for ASCII input.
