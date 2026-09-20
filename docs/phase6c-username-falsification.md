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
| F6C-09 | a legacy-policy panel mints `nx` plus 32 hex                    | the random draw shortened from 16 bytes to 4             | _mints the legacy shape when the panel has no template_              | KILLED |
| F6C-10 | a template's `{random10}` renders ten characters                | the draw shortened to four                               | _renders the panel template for a RANDOM name_                       | KILLED |
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

## What is NOT covered here, and why

**The provider's real maximum username length.** `PROVEN_PROVIDER_USERNAME_MAX_LENGTH`
is 34 because that is the shape both real-panel acceptance suites have actually
created accounts with — not because either provider has been measured. The true
limit is UNKNOWN (`docs/open-questions.md`, OQ-6C-01), and raising the constant
is a real-panel acceptance task rather than an edit. Nothing in this table
claims otherwise.

**That a panel accepts a custom or templated name at all.** Every case here ends
at rows this installation writes. A fake this repository wrote and an adapter
this repository wrote can only prove they agree with each other
(`docs/real-panel-acceptance.md`), and no disposable panel of either kind was
available in this session. Deferred to the owner, and it is an evidence gap
rather than a passed test.
