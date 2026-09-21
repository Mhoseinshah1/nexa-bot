# Work Package 3 — falsification record

Every production rule this package added or changed, reverted one at a time
against the committed test that names it. A rule with no test is a rule the next
commit reverts silently; a test that stays green under mutation is not a test.

Run as: revert the single rule, run the named suite filtered to the named test,
restore the file, confirm green again. Nothing here was run and thrown away —
every row names a test that exists on this branch, and
`scripts/check-falsification-citations.mjs` resolves each one against the test
sources rather than taking this table's word for it.

WP3 has three ways to fail and they are not the same failure. The LOOKUP fails
by returning rows it should not — another tenant's, or every account whose name
starts with the same two letters. The SCREEN fails by naming the wrong thing, or
by needing a permission the thing it is about does not need. The BOUND fails by
lying: a truncated list that reads as a complete one, which is the defect WP1
named and the one the old Web copy compounded by calling a long history a fault.

## The lookup

`tests/integration/services-http.test.ts`,
`tests/integration/services-plan.test.ts`, three mutations.

| #    | Rule                                                       | Mutation                                                    | Named test                                                                       | Result |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| L-01 | the name is matched by EQUALITY, never as a prefix         | `eq(...)` replaced with `like '<name>%'`                    | _answers a PREFIX of a name with nothing, rather than with the account it names_ | KILLED |
| L-02 | the same mutation must also destroy the index's usefulness | as L-01                                                     | _serves the provider-username lookup from services_tenant_provider_username_idx_ | KILLED |
| L-03 | the list is scoped to the caller's tenant                  | `eq(services.tenantId, tenantId)` replaced with a tautology | _cannot find another tenant's service by the name on its panel_                  | KILLED |

L-03 also killed _cannot reach another tenant's service, and says only that it
is unknown_, which is the pre-existing case. Both are recorded because the new
filter is a NEW way to ask the same question, and a tenancy proof that only
covers the old way is a proof about the old way.

## The index

`tests/integration/services-plan.test.ts`, one mutation.

| #    | Rule                                                    | Mutation                                                       | Named test                                                                       | Result |
| ---- | ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| X-01 | the lookup index is declared and built on every upgrade | the entry removed from `ONLINE_INDEXES`, and the index dropped | _serves the provider-username lookup from services_tenant_provider_username_idx_ | KILLED |

X-01 needed BOTH halves, and that is worth stating rather than hiding. Dropping
the index alone proves nothing: the harness runs `ensureOnlineIndexes` on
migrate, so the next run rebuilds it. Removing the declaration alone proves
nothing either, on a database where the index already exists. Together they are
the state a fresh installation would be in if the declaration were deleted —
which is the only state that matters, because that is what a new install gets.

## The Telegram screens

`tests/integration/telegram-admin-services.test.ts`, three mutations.

| #    | Rule                                                              | Mutation                                                      | Named test                                                                  | Result   |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| T-01 | the screen names the customer by their Telegram identity          | `customer` set back to `service.customerId`                   | _carries the identity, both states, usage, expiry and the latest operation_ | KILLED   |
| T-02 | the customer read is SKIPPED, not attempted and caught            | the `users.view` check before `customers.get` deleted         | _links to the customer, and only for an administrator who may read them_    | KILLED\* |
| T-03 | the page button carries the cursor the server minted              | the more button's data replaced with the bare browse callback | _pages the browsable list rather than truncating it_                        | KILLED   |
| T-04 | `services.view` decides before the argument's shape is considered | the permission check at the top of `adminService` deleted     | _refuses /service for an administrator who does not hold services.view_     | KILLED   |

\* T-02 SURVIVED its first run, and the gap is the one worth naming. The case
asserted only that no button and no identity appeared for an administrator
holding `services.view` alone — and without the skip they still do not, because
the guard throws instead. What the skip actually protects is the SCREEN: a
permission denial is not `isCustomerMiss`, so it is rethrown and a services
screen becomes an error over a permission the service itself does not need (and
one denial is recorded per screen opened). The assertion that the reply key is
still `bot.admin.service` was added, and the mutation then died with
`expected 'bot.admin.refused' to be 'bot.admin.service'`.

## The bound

`tests/unit/service-operation-history.test.ts`, `tests/web/services.test.tsx`,
four mutations.

| #    | Rule                                                 | Mutation                                                                   | Named test                                                    | Result |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| B-01 | the reader asks for one row beyond its bound         | `SERVICE_OPERATION_LIMIT + 1` reduced to `SERVICE_OPERATION_LIMIT`         | _asks for one row beyond its bound, and never returns it_     | KILLED |
| B-02 | `hasMore` is strictly greater, never `>=`            | `found.length > LIMIT` replaced with `found.length >= LIMIT`               | _reports a history of EXACTLY the bound as complete_          | KILLED |
| B-03 | the notice is drawn from `hasMore`, not from a count | `operations.data.hasMore` replaced with `operations.length === limit`      | _says the history was cut, with the bound the SERVER applied_ | KILLED |
| B-04 | the figure printed is the SERVER's bound             | `<Num value={operations.data.limit} />` replaced with `<Num value={50} />` | _says the history was cut, with the bound the SERVER applied_ | KILLED |

B-03 killed both web cases, the positive and the negative, which is what makes
the pair worth having: under that mutation a history of exactly the bound gains
a notice it must not have, and a truncated one keeps the notice it must. Only
the negative case can tell those apart.

## The Web filter

`tests/web/services.test.tsx`, two mutations.

| #    | Rule                                                       | Mutation                                          | Named test                                                                 | Result |
| ---- | ---------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| F-01 | the box refuses what the schema refuses, before requesting | `usernameProblem` replaced with `() => undefined` | _refuses a name the server would refuse, without spending a request on it_ | KILLED |
| F-02 | the client sends the name UNFOLDED                         | `.toLowerCase()` added in `fetchServices`         | _asks the server for the exact name, and sends it unfolded_                | KILLED |

F-02 is the rule that keeps the fold in one place. It is not about correctness
of the result today — the server folds, so a pre-folded value finds the same row
— it is about there being ONE opinion. Two folds agree until one of them changes.

## The Codex round

One review on `5223cc9`, three findings, all three real and all three fixed. Four
mutations, all KILLED.

| #    | Rule                                                    | Mutation                                           | Named test                                                                       | Result |
| ---- | ------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| R-01 | a name matching more than one service hands back BOTH   | the `MANY` branch deleted, leaving the first match | _hands back BOTH matches when one name names two services, and offers no action_ | KILLED |
| R-02 | the disambiguation screen carries no ACTION             | a terminate button added beside each match         | _hands back BOTH matches when one name names two services, and offers no action_ | KILLED |
| R-03 | a history that could not be READ renders `-`, never `0` | the null branch renders `'0'` again                | _says the history is UNREADABLE rather than reporting it as empty_               | KILLED |
| R-04 | `history` is an OPTIONAL placeholder                    | `required: false` set back to `true`               | _accepts a body that predates an OPTIONAL placeholder the key later gained_      | KILLED |

**R-01 is the one that mattered.** The first version asked for `limit: 1` and took
the newest match, with a docblock calling it "the row a support conversation is
almost always about". That is a guess wearing a rule's clothes, and the screen it
produced carried SUSPEND and TERMINATE — so `/service <name>` could end the wrong
customer's account while looking like it had answered correctly.
`services_panel_provider_username_key` is unique per PANEL, and `schema.ts` says
in as many words that two panels of one tenant may point at different machines.

R-02 exists because R-01 alone does not pin the safety property: a version that
returned both matches AND offered to terminate each would satisfy the first
assertion. The negative arm is what makes the screen a router rather than a
control panel.

**R-04 is an upgrade-path rule, not a rendering one.** An override is raw
persisted source and nothing rewrites it, so requiring the new token would leave
an operator who overrode this key before WP3 able to READ their body and never
save it again — refused for a token they never wrote. The case uses the body this
catalogue shipped BEFORE the placeholder, so it fails the moment the token is
marked required again.

## One gap found here, and not papered over

`docs/wp1-falsification.md` is NOT registered in
`scripts/check-falsification-citations.mjs`, and WP3 did not register it.

It cites SUITES — `admin-http`, `telegram-admin`, `web/administrators` — where
every other record cites the test that dies. The checker resolves `_test name_`
citations against committed sources, so a record with no citation column fails
it outright rather than being silently skipped (which is a deliberate property
of that script, and the failure mode its own comments record).

Converting WP1's twenty-one rows means re-running twenty-one mutations to learn
which test each one kills. Writing the names without running them is precisely
the "claim about testing that leaves no test behind" the review rules forbid —
the failure that put eleven parser shapes and twelve guard probes into a commit
message with nothing committed behind them. So the gap is stated here, in the
script, and in the consolidated report, and left for whoever re-runs those
mutations.
