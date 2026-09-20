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
