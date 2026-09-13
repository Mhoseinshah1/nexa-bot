# Falsification — Phase 4A, customers and the Telegram turn

Every load-bearing rule Phase 4A added, the mutation that removes it, and the
test that dies. The method is the repository's: revert the rule, run the focused
suite, restore the file byte-for-byte, re-run it green. A rule whose test survives
its own mutation is not a rule.

The pass was **bounded on purpose**. Thirteen mutations aimed at the rules the
owner named, plus one (M14) for a defect the self-review found afterwards, driven by `/tmp/falsify-4a.py` — which prints the applied diff
before every run, so "it applied" is evidence rather than an assumption, and
refuses to continue if `git status` is not clean again afterwards. No cosmetic
mutation catalogue: a mutation is here because a specific sentence of behaviour
depends on the line it removes.

Everything ran in a **separate git worktree against a separate database**
(`nexa_falsify_4a`). `CLAUDE.md` records both reasons: a reviewer sharing the
implementation checkout once deleted a real fix mid-edit, and two suites sharing
one database once produced 122 false failures that looked exactly like real ones.

## The ledger

| #   | Rule                                                                  | Mutation                                                                                              | Named test                                                                                                          | Result |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Every customer query is scoped to the tenant                          | `drizzle-customer.repository.ts`: the list's first predicate becomes `TRUE`                           | `customers-http.test.ts` › lets the SAME Telegram id and username exist in two tenants, independently               | KILLED |
| M2  | The Telegram id is unique PER TENANT, not globally                    | `drizzle-customer.repository.ts`: the upsert's conflict target drops `tenantId`                       | `telegram-customer-turn.test.ts` › keeps the same Telegram id in two tenants as two customers                       | KILLED |
| M3  | Identity is the Telegram id; the username is not identity             | `drizzle-customer.repository.ts`: the exact search matches `lower(username)` instead                  | `customers-http.test.ts` › lets the SAME Telegram id and username exist in two tenants, independently               | KILLED |
| M4  | A redelivered update is a replay                                      | `customer.service.ts`: the replay branch is made unreachable                                          | `telegram-customer-turn.test.ts` › treats a REDELIVERED update as a replay: one row, one reply                      | KILLED |
| M5  | `created` is a fact about the statement, not a guess                  | `drizzle-customer.repository.ts`: `created` is hard-coded `true`                                      | `telegram-customer-turn.test.ts` › greets a RETURNING customer differently, and creates no second row               | KILLED |
| M6  | BLOCKED outranks every intent when choosing the reply                 | `bot-runtime.ts`: `replyFor`'s BLOCKED branch is made unreachable                                     | `telegram-customer-turn.test.ts` › does NOT unblock a blocked customer on /start, and replies with the blocked text | KILLED |
| M7  | A profile refresh never touches `status`                              | `drizzle-customer.repository.ts`: the upsert's DO UPDATE list also sets `status: 'ACTIVE'`            | `telegram-customer-turn.test.ts` › does NOT unblock a blocked customer on /start, and replies with the blocked text | KILLED |
| M8  | `users.block` is re-checked INSIDE the committing transaction         | `customer.service.ts`: `runAuthorizedMutation` is given `users.view` instead                          | `transactional-authorization.test.ts` › refuses customers.block when authority is revoked before the transaction    | KILLED |
| M9  | A block writes an audit row, and a no-op writes one too               | `customer.service.ts`: the block's `audit.record` call is made unreachable                            | `customers-http.test.ts` › blocks, audits the block, and stays blocked when pressed again                           | KILLED |
| M10 | A cursor this server did not mint is a 400, never page one            | `keyset-cursor.ts`: the byte-for-byte re-encode check is deleted                                      | `keyset-cursor.test.ts` › never restarts the traversal, for any of those shapes                                     | KILLED |
| M11 | A Telegram send never happens inside a business transaction           | `customer.service.ts`: a `telegramSend` is placed inside the resolve transaction                      | `telegram-customer-turn.test.ts` › commits the customer BEFORE the reply leaves, and sends outside the transaction  | KILLED |
| M12 | An inactive bot instance is refused at the edge                       | `webhook.controller.ts`: the `status !== 'ACTIVE'` arm is dropped from the bot guard                  | `telegram-customer-turn.test.ts` › writes nothing and sends nothing for an INACTIVE bot instance                    | KILLED |
| M14 | The username prefix search is served by an index, not a filtered walk | `customers_tenant_username_idx`: `text_pattern_ops` removed, so it is a default-collation btree again | `customers-plan.test.ts` › serves the username PREFIX search from customers_tenant_username_idx                     | KILLED |
| M13 | An inactive tenant is refused at the edge                             | `webhook.controller.ts`: the `status !== 'ACTIVE'` arm is dropped from the tenant guard               | `telegram-customer-turn.test.ts` › writes nothing and sends nothing for an INACTIVE tenant                          | KILLED |

Fourteen of fourteen killed — **after two of them were fixed, and the fixing is
the finding.**

## The two that survived the first round

Both are the failure `CLAUDE.md` names in full: _"a rule with no test is a rule
that will be silently reverted… a test that stays green under mutation is not a
test."_ Neither was visible from reading a diff, and both sat under a suite that
was green and looked thorough.

### M6 — the blocked reply had no end-to-end test

Removing `if (arrival === 'BLOCKED') return 'bot.blocked'` left **all sixteen**
Telegram-turn cases passing. The blocked case asserted that one reply went out and
that its text did not contain the operator note; both remained true when the
blocked customer was greeted with `bot.start.welcome_back` instead. The unit test
on `replyFor` did cover the function, and that is exactly why the gap was
invisible: the rule was tested in isolation and the WIRING was not.

Fixed by naming the template in every reply assertion, read from `CATALOGUE_FA`
rather than copied — so a wrong key fails while a reworded sentence moves both
sides at once. The mutation now kills two cases, one unit and one integration.

### M8 — the in-transaction re-check was unobservable, twice over

Replacing `CUSTOMER_BLOCK_PERMISSION` with `CUSTOMER_VIEW_PERMISSION` in the
`runAuthorizedMutation` call left **all 22** `customers-http` cases passing,
because the up-front `guard.check` added in the same phase already refuses an
unprivileged caller. Nothing could distinguish a block authorised once from a
block authorised twice — and the second check is the entire reason
`runAuthorizedMutation` exists (ADR-0014: authority is established inside the
transaction that commits).

The fix needed **two attempts, and the second attempt is the sharper finding.**
Adding a `customers.block` case to `transactional-authorization.test.ts` did not
kill it either: the shared `revokeA` moves the actor to `observer`, which holds
nothing, so the refusal happens whichever permission the in-transaction check
names. `revokeTo` is now per case and `customers.block` revokes to `support`,
which holds `users.view` and `users.search` and not `users.block` — removing
exactly the one permission under test.

That pattern is worth stating because the three older cases in that file have the
same shape: revoked to `observer`, they would survive a mutation that swapped
their permission for another the observer also lacks. They are left alone (their
permissions have no neighbour in the seeded roles) and the note lives on `revokeA`,
so the next case added does not inherit the weakness by copying the default.

### M14 — an index that existed and was never read

Found in the self-review rather than by mutation, and then falsified like the
rest. `customers_tenant_username_idx` was `(tenant_id, lower(username))` with the
default collation, and `/users?username=` is a PREFIX search — which a
default-collation btree cannot serve at all. Measured on 20 000 customers in one
tenant: the planner ignored the index, walked `customers_tenant_created_idx` and
discarded 12 289 rows to return 26, at 364 shared buffers. With `text_pattern_ops`
(migration 0036) the prefix is an Index Cond: 111 rows, 31 buffers, and the gap
grows with the tenant's size.

The defect that makes it a finding rather than a missed optimisation is the
COMMENT: `drizzle-customer.repository.ts` said the search used that index, so the
code carried a promise the plan did not keep. `customers-plan.test.ts` now reads
the plan for the statement the repository itself builds — via `listStatement`,
exposed for the reason `DrizzlePanelRepository.pageKeysQuery` is — and asserts the
index by NAME plus an `Index Cond` rather than a `Filter`. Both return the same
rows, so only the plan can tell them apart. Reverting the operator class in the
test database kills that case and leaves the keyset case green.

## A note on the method, learned during this pass

One run of M8 reported **three** dead tests — `settings.set` and `features.set`
alongside the named one — for a mutation that touches only the customer service.
The cause was mine: a manual `vitest` invocation and the driver were both running
against `nexa_falsify_4a` at the same time, and the integration suite truncates
tables between tests. That is the 122-false-failures hazard `CLAUDE.md` records,
reproduced by the person who had just written the separate database to avoid it.

Re-run alone, M8 kills exactly one test and it is the named one. Every row above
was confirmed from a run with nothing else touching that database, and the
discrepancy is recorded rather than quietly dropped — a mutation that appears to
kill three tests proves the weakest of them, which is the same reasoning the
config-upgrade record gives for its H-08.

## What this pass did NOT try

Stated rather than left as an absence, because an unstated omission reads as
coverage:

- **No mutation of 4B–4F.** Those phases have no implementation, so there is
  nothing to revert. The tables and contracts they will use exist; no behaviour
  does.
- **No mutation of the Web Admin page.** `tests/web/users.test.tsx` asserts the
  absences directly — no tag concept, no wallet column, no disabled block button —
  and an absence is already the mutation's result rather than its input. The
  permission-shaped rules it draws (no search form without `users.search`, no
  block control without `users.block`) are each asserted against a rendered page
  with the real API client underneath.
- **No mutation of the panel cursor's own behaviour beyond M10.** The extraction
  moved code it did not change, and `panels-http.test.ts`'s eighteen malformed
  shapes are the evidence that the surface is unchanged; `keyset-cursor.test.ts`
  pins the same rules without a database, which is the half that runs in
  `pnpm verify`.
