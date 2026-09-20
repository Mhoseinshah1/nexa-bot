# Deliverable A falsification — the per-panel username policy

Every production rule the username policy introduces, reverted one at a time,
with the committed test that fails as a result. A rule with no test is a rule
the next commit reverts silently; a test that stays green under mutation is not
a test.

The area has one failure shape and a dozen ways to reach it: a name that two
parties disagree about. This installation and the panel, the summary a customer
agreed to and the account they were given, one customer and another, one tenant
and a tenant it has never heard of that happens to point at the same machine.

Eleven mutations, run against `tests/integration/service-username.test.ts`.

## The eleven

| #      | Rule                                                            | Mutation                                                 | Named test                                                           | Result |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| F6C-01 | an accepted name is folded to lowercase before anything sees it | `canonicalizeCustomUsername` returns its input unchanged | _stores the canonical lowercase form of what the customer typed_     | KILLED |
| F6C-02 | the namespace is the provider and the HOST, not the panel       | the base URL's length appended to the derived key        | _holds a name across tenants that share one provider host_           | KILLED |
| F6C-03 | one order gets one name, decided by the unique index            | `reserve`'s read-back by order deleted                   | _gives one order one name however many times the button is tapped_   | KILLED |
| F6C-04 | a confirmation with no name allocates one where RANDOM is on    | the `allowRandom` guard replaced with `false`            | _refuses to confirm a CUSTOM-only order with no name_                | KILLED |
| F6C-05 | the chosen mode is checked against the PANEL, not the surface   | the `modesOffered` membership test replaced with `false` | _refuses a mode the panel does not offer, whatever the surface drew_ | KILLED |
| F6C-06 | a name may be chosen only while the order is a DRAFT            | the state guard deleted from `assertNameable`            | _refuses to change a name once the order is past DRAFT_              | KILLED |
| F6C-07 | a panel must allow at least one username mode                   | the neither-mode guard replaced with `false`             | _refuses a panel policy with neither mode_                           | KILLED |
| F6C-08 | a template that cannot render a legal name is refused at save   | the verdict check replaced with `false`                  | _refuses a template that cannot produce a unique name_               | KILLED |
| F6C-09 | an unconfigured panel mints the default preset                  | the random draw shortened from 16 bytes to 4             | _mints the DEFAULT preset on a panel nobody has configured_          | KILLED |
| F6C-10 | a template's `{random10}` renders ten characters                | the draw shortened to four                               | _renders the panel template for an AUTOMATIC name_                   | KILLED |
| F6C-11 | a typed name is validated before it is folded or stored         | `isValidCustomUsername` replaced with `false`            | _refuses a name that breaks the rule, and reserves nothing_          | KILLED |

## What the pass changed

F6C-03 did not kill on the first attempt, and neither did its mirror.
`allocate` read the order's reservation before deciding and `reserve` read it
back after a lost insert; with both present the suite stayed green when either
was reverted, so it could not say which one was doing the work — and a later
edit could have removed the load-bearing half in silence.

The index is the half that survives concurrency. A read issued before an insert
sees the state the loser started from, so two simultaneous taps both find
nothing and both try to take a name; the conditional insert is what makes
exactly one win. The early read was an optimisation wearing a rule's clothes and
is gone. With one mechanism left, the mutation kills.

## Round two — the universal contract, and the four presets

Run after the owner's correction replaced the 34-character ceiling with one
universal contract. Same standard: commit first, revert exactly one production
rule, watch the named test fail, restore byte-for-byte. Every row KILLED on the
first attempt.

| #    | Rule reverted                                          | Mutation                                                          | Named test                                                                           | Result |
| ---- | ------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| U-01 | a new name is at most twenty characters                | `PROVIDER_USERNAME_PATTERN` widened back to `{4,34}`              | _is longer than every NEW name, which is why it needs its own predicate_             | KILLED |
| U-02 | a template's SHORTEST render must still reach four     | the `TOO_SHORT` issue deleted                                     | _refuses a template whose best case falls under four_                                | KILLED |
| U-03 | `PREFIX_RANDOM` never overruns twenty                  | `prefixRandomLength` returns the target, ignoring the room left   | _PREFIX_RANDOM always leaves at least six random characters and stays inside twenty_ | KILLED |
| U-04 | `{order4}` is unique but NOT redrawable                | `order4` added to `USERNAME_REDRAWN_TOKENS`                       | _names order4 as unique but NOT as redrawable_                                       | KILLED |
| U-05 | `{tg4}` is exactly four, padded for a short id         | `padStart` deleted from `telegramIdSuffix4`                       | _takes the LAST four digits of a Telegram id, padded when it is shorter_             | KILLED |
| U-06 | a RENDER is checked, not only the template             | `assertNewProviderUsername` deleted from `renderUsernameTemplate` | _refuses a render that a bad VALUE made illegal_                                     | KILLED |
| U-07 | a preset with no configuration behind it is refused    | both `STRATEGY_CONFIGURATION` branches replaced with `if (false)` | _refuses a preset with no configuration behind it_                                   | KILLED |
| U-08 | a typed name needs a digit as well as a letter         | the digit test replaced with `true`                               | _requires at least one English letter and at least one digit_                        | KILLED |
| U-09 | the adapter refuses an illegal name before any request | `assertNewProviderUsername` deleted from Marzban's `createUser`   | _refuses on Marzban, and makes no request_                                           | KILLED |

U-01 killed three tests rather than one, and U-03 and U-07 two each. That is
reported as it happened rather than trimmed: a rule with several consequences
has several tests, and pretending each mutation kills exactly one would be the
tidier claim and the less true one.

## Round three — the hold's lifecycle, and the guard that judges migrations

Round two proved what a name may BE. These are about what happens to the row
that holds it, and one about the scanner that decides whether a migration is
safe to roll back onto.

| #    | Rule                                                 | Mutation                                                                         | Test that dies                                                                    | Verdict |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| U-10 | a boundary table may not be narrowed                 | `SET NOT NULL` on `tenants.slug` appended to an incoming migration               | _the incoming migrations only ADD_                                                | KILLED  |
| U-11 | a refunded RENEW must not end the service it renewed | `if (purchasedAs === 'PROVISION')` in `refundPurchase` replaced with `if (true)` | _refunds a renewal the panel definitively refused, and leaves the service ACTIVE_ | KILLED  |

U-11 measured the gap as well as closing it. Under the mutation the other 49
cases in `service-management.test.ts` and all 66 in `automatic-refund.test.ts`
and `provisioning-delivery.test.ts` together stayed green: every existing proof
that a failed renewal leaves the service alone ends BEFORE an operation is
planned — at settlement, where the panel was already refusing. Nothing reached the provisioner's own refund with a commercial
purchase, so the one line that distinguishes "the account was never created" from
"the account exists and the customer is using it" could be deleted without a
single failure. The new case is a bank-transfer RENEW on an operable panel whose
credentials stop working before the provisioner dials: terminal
`AUTHENTICATION_FAILED` on the first attempt, the order REFUNDED once for the
exact total, and the service still ACTIVE with the allowance and window it had.

U-10 is recorded because the exemption it guards is new: `SET NOT NULL` is now
permitted on a column this unreleased batch introduced, which is the same batch-scoped
reasoning `DROP COLUMN` already had. An exemption is only as good as the case it
still refuses, so the case it still refuses was run: appending
`ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL` to 0095 fails the named
assertion with `sets NOT NULL on TENANTS.SLUG`, and the file was restored
byte-for-byte afterwards (`git diff` clean).

### What the lifecycle rules rest on instead

The four lifecycle rules below were established by tests written against code
that did NOT have them — each test failed first, for the reason its comment
states, and passed once the rule existed. That is the same evidence a mutation
produces, obtained in the other order, and it is reported that way rather than
dressed up as a mutation pass that was not run:

- _gives the name back when the customer cancels_ — failed because
  `OrderService.cancelByCustomer` released the panel slot and not the hold.
- _sweeps an abandoned DRAFT's hold once its deadline passes_ — failed because
  nothing swept `service_username_reservations` at all.
- _lets the customer choose again, and the stale hold gives way_ — failed
  because `reserve` handed back the refused name under `ON CONFLICT DO NOTHING`.
- _turns a tap into a DRAFT and answers with the order summary_ — failed
  because the AUTOMATIC path read the order through a permission the customer
  does not hold, and answered with nothing at all.

The two NEGATIVE halves — a funded name surviving a late cancellation, and the
sweep leaving a funded hold alone — are what stop each of those rules being
satisfied by deleting unconditionally, and they are in the same three cases.

## Round four — the Codex findings on this PR

Seven findings. Two were already fixed by later commits on this branch and are
recorded as such rather than re-run; one no longer describes any code, because
the token it named was removed by the owner's final username correction. The
four that were real were fixed and each one was mutated.

| #    | Rule                                                          | Mutation                                                  | Test that dies                                                                | Verdict |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| U-12 | a completed username choice REPLAYS, it does not conflict     | the `replayUsername` lookup removed from `chooseUsername` | _hands a retried choice the name it already took, rather than a conflict_     | KILLED  |
| U-13 | a typing window opens only where typed names are accepted     | the `modesFor` gate removed from `beginUsernameEntry`     | _refuses to open a typing window on a panel that no longer takes typed names_ | KILLED  |
| U-14 | the overwrite warning covers the username policy              | `overwritesPolicy` dropped from `willOverwrite`           | _promises an overwrite when the concurrent change is the USERNAME POLICY_     | KILLED  |
| U-15 | a panel's holds move with its address, or the move is refused | the `rebind` call removed from `PanelService.update`      | _carries the names a panel holds to the namespace of its new address_         | KILLED  |

Each mutation killed only the cases named — 31 of the 33 in
`service-username.test.ts` and 88 of the 89 in `tests/web/panels.test.tsx`
stayed green under the ones that touch them, so none of these is a test that
passes because something else is failing.

U-12 and U-15 each kill a second case as well, and both are the negative half
that stops the fix being satisfied by doing the thing unconditionally: _still
refuses a DIFFERENT ask under one key_ (a replay must compare the request hash,
not just find the key) and _refuses the move when a name this panel holds is
already held at the destination_ (a rebind that skipped what it could not move
would be the collision with a success message on it). U-14 has the same pair in
`tests/web/panels.test.tsx`: _does not call a policy an overwrite when this
operator set the stored one_.

### The three that needed no fix, and why

- **Reap expired unfunded reservations (P1).** Already done, by the commits this
  record's round three describes: cancellation releases the hold
  (`OrderService.cancelByCustomer`), payment expiry releases one per expired
  order and sweeps abandoned drafts (`PaymentExpiryService`).
- **A customer-authorized read when rebuilding the summary (P1).** Already done:
  both the AUTOMATIC and the typed-name paths call `orders.orderForCustomer`,
  and section 6-8 of `docs/phase6c-audit.md` records the defect it fixed.
- **Strip UUID dashes before rendering `{order_id}` (P1).** Does not apply:
  `USERNAME_TEMPLATE_TOKENS` is a closed set and `{order_id}` is not in it. The
  owner's final correction replaced the id tokens with four-character digests
  (`{order4}`, `{customer4}`, `{tg4}`), each of which renders `[a-z0-9]` only.

## What is NOT covered here, and why

**The provider's real maximum username length.** Twenty is a product decision,
not a measurement. It is comfortably inside every provider username field this
product has driven, and every preset is built to fit it — but neither provider's
true limit has been measured, and it stays UNKNOWN
(`docs/open-questions.md`, OQ-6C-01). The number this section used to defend —
34, "proven" because it was the length our own generator happened to produce —
was evidence about this codebase rather than about a panel, and it is gone.

**That a panel accepts a custom or templated name at all.** Every case here ends
at rows this installation writes. A fake this repository wrote and an adapter
this repository wrote can only prove they agree with each other
(`docs/real-panel-acceptance.md`), and no disposable panel of either kind was
available in this session. Deferred to the owner, and it is an evidence gap
rather than a passed test.
