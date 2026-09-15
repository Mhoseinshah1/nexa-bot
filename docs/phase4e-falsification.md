# Phase 4E falsification — the real-panel acceptance

Rules introduced or corrected while standing a real MHSanaei/3x-ui v3.7.0 panel
up against the shipped adapter. `docs/real-panel-acceptance.md` is what the
acceptance covers and how to run it; this is what happens when each rule is
taken away.

One row **SURVIVED**, and it is recorded with the reading that makes it a
finding rather than a gap — see F4E-02.

| #      | Rule                                                                | Mutation                                                               | Named test                                                                                               | Result   |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| F4E-01 | A session-mode request carries the CSRF token the panel minted      | `'x-csrf-token': csrfToken,` removed from the session auth headers     | `sanaei-adapter.test.ts` › 17. creates a client through a session and sends the token on the POST        | KILLED   |
| F4E-02 | The fake refuses an unsafe `/panel/api` call with no bound token    | the `/panel/api` CSRF gate → `if (false && ...)`                       | `sanaei-adapter.test.ts` › 17. creates a client through a session and sends the token on the POST        | SURVIVED |
| F4E-03 | A replay of the same create is an idempotent success                | the fake's `existing.subId === subId` branch → `if (false)`            | `sanaei-adapter.test.ts` › 19. a replay of the same create is an idempotent success, not a refusal       | KILLED   |
| F4E-04 | A Bearer create sends no CSRF token                                 | covered by the same header removal as F4E-01, from the other direction | `sanaei-adapter.test.ts` › 18. a BEARER create sends no CSRF token, because api_authed short-circuits it | n/a      |
| F4E-05 | The CSRF rule reaches provisioning end to end, not just the adapter | `'x-csrf-token': csrfToken,` removed from the session auth headers     | `provisioning-delivery.test.ts` › sends the subscription in the SAME tick that provisions it             | KILLED   |

## The SYNC_USAGE sweep and the operation dispatch

| #      | Rule                                                            | Mutation                                                                     | Named test                                                                                                         | Result   |
| ------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| F4E-06 | `PERFORMABLE_OPERATION_TYPES` names only what has a branch      | `'TERMINATE'` appended to the constant                                       | `registries.test.ts` › names exactly the three types 4E performs, and no more                                      | KILLED   |
| F4E-07 | The executor refuses an unperformable type before anything else | `if (!isPerformableOperation(operation.type)) {` → `if (false as boolean) {` | `provisioning-delivery.test.ts` › refuses an operation type this release cannot perform, before contacting a panel | SURVIVED |
| F4E-08 | An unperformable type is legal from NO service state            | `TERMINATE: []` → `TERMINATE: ['ACTIVE']`                                    | `provisioning-delivery.test.ts` › refuses an operation type this release cannot perform, before contacting a panel | SURVIVED |
| F4E-09 | A usage sync writes what the panel said                         | `recordUsage(...)` call removed from `finishUsageSync`                       | `provisioning-delivery.test.ts` › refreshes a stale usage figure from the panel, and writes what the panel said    | KILLED   |
| F4E-10 | A fresh figure is not re-read                                   | `COALESCE(usage_synced_at, created_at)` → `usage_synced_at IS NULL OR …`     | `provisioning-delivery.test.ts` › does not sync a service whose figure is still fresh                              | KILLED   |
| F4E-11 | One sync per cadence window, however many ticks run             | the window removed from the derived operation id                             | `provisioning-delivery.test.ts` › plans ONE sync per cadence window however many ticks run                         | KILLED   |
| F4E-12 | A failed sync claims no refresh it did not make                 | `if (!read.ok)` branch falls through to `recordUsage`                        | `provisioning-delivery.test.ts` › a sync that the panel refuses is FAILED, never UNKNOWN, and moves no service     | KILLED   |

### F4E-07 and F4E-08, the two survivals, and what they actually mean

Neither mutation fails a test **on its own**, and that is the design rather than a
gap: they are two independent refusals of the same thing, so removing either leaves
the other standing. What had to be measured is whether the PAIR is load-bearing, so
both were applied together — the membership check disabled and `TERMINATE` declared
legal from `ACTIVE` — and the test then FAILED:

```
× refuses an operation type this release cannot perform, before contacting a panel
AssertionError: expected 'FAILED' to be 'ABANDONED'
```

The restore afterwards was verified byte-identical against copies taken beforehand,
and `git status` was clean.

That result also names a THIRD refusal, which is worth writing down because it is the
one nobody designed. With both of this phase's checks removed the TERMINATE still
never reached `provisionCall`: `decideOperability` refused it, because
`OPERATION_REQUIRED_CAPABILITIES['TERMINATE']` is `['DELETE_USER']` and no adapter
declares it. Today every unperformable type happens to require a capability no adapter
has, so that check covers all of them.

It is an accident and not a guarantee. `RECONCILE` already requires none, and the next
type added with an empty capability list would have exactly the two refusals this phase
adds standing between it and a create on somebody's panel. Which is why they are two.

## Service expiry

| #      | Rule                                                        | Mutation                                                       | Named test                                                                                                | Result   |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| F4E-13 | Something expires a service whose window has closed         | `await this.expireDue(scope, now);` → `void now;`              | `provisioning-delivery.test.ts` › expires a service whose window has closed, without contacting the panel | KILLED   |
| F4E-14 | `expires_at IS NULL` is an unlimited plan and never expires | BOTH copies of `isNotNull(services.expiresAt)` → `TRUE`        | `provisioning-delivery.test.ts` › leaves an unlimited service alone for ever                              | SURVIVED |
| F4E-15 | The audit says which state the service was in               | the per-statement `state: from` dropped from the mapped record | `provisioning-delivery.test.ts` › records the state the service was actually in, not the one it moved to  | KILLED   |
| F4E-16 | Expiry runs behind the tenant kill switch                   | covered by F4E-13's removal, from the other direction          | `provisioning-delivery.test.ts` › expires nothing for a tenant that has stopped accepting work            | n/a      |

### F4E-14, which found something about this code rather than about a test

`isNotNull(services.expiresAt)` was mutated to `TRUE` in the sub-select, then in the
UPDATE, then in BOTH at once. The unlimited service survived every time.

That is not a missing test. It is that the predicate is **redundant**: `expires_at <=
now` is already NULL — not true — for an unlimited plan, so SQL's three-valued logic
excludes the row with no help from `isNotNull` at all. The test is doing its job; the
line it appeared to be testing is not the line that does the work.

It is kept, with a comment that now says exactly this, because it is the one place the
intent is written down and the predicate that really carries it is easy to rewrite
without noticing: `COALESCE(expires_at, <anything>) <= now` would expire every
unlimited service on the next tick, and nothing else in the query would object. The
test would catch THAT, which is the mutation worth having a test for.

The measurement: both sites changed at once, `1 passed | 26 skipped`, restore verified
byte-identical against a copy taken beforehand, `git status` clean.

## The customer-facing service surface

| #      | Rule                                                           | Mutation                                                          | Named test                                                                                                           | Result |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| F4E-17 | A service that is not the customer's is refused                | `service.customerId !== customerId` dropped from `getForCustomer` | `provisioning-delivery.test.ts` › refuses another customer’s service with the SAME answer as one that does not exist | KILLED |
| F4E-18 | A subscription is only ever resent into a private chat         | the null chat falls back to the callback message's own chat       | `provisioning-delivery.test.ts` › will not resend a subscription into a group chat                                   | KILLED |
| F4E-19 | A service is labelled as it was SOLD, from the frozen snapshot | the button label → `service.id`                                   | `provisioning-delivery.test.ts` › /services lists the customer’s own service, labelled as it was SOLD                | KILLED |
| F4E-20 | A resend produces ONE message, sent by the delivery lane       | `key: null` → a template key, so the runtime answers as well      | `provisioning-delivery.test.ts` › sends the subscription again when the customer asks, through the delivery lane     | KILLED |

### A first attempt at F4E-17 that proved nothing

`ownedService` was mutated to fall back to the tenant's first service on a refusal,
and it SURVIVED — because the fallback itself threw and the surrounding `catch`
turned it back into the same `null`. The mutation never changed behaviour, so the
survival said nothing about the test.

Recorded because that is the shape a manufactured verdict takes: `scripts/falsify.sh`
reports SURVIVED for a mutation that does nothing exactly as it does for a rule with
no test. The second attempt mutates the production rule itself — the ownership
comparison in `getForCustomer` — and kills.

## F4E-02, the survival

Disabling the fake's CSRF gate does not fail a test **on its own**, and that is
correct: the gate is not a production rule. It exists so that F4E-01 kills.

What matters is whether the pair is load-bearing, so both mutations were applied
together — the adapter as it shipped before this fix, and the fake as it was
before this fix. Measured: `1 failed | 3 passed | 62 skipped`. The one that still
failed is test 17, which asserts the header value directly against
`server.mintedCsrfTokens[0]` and therefore does not depend on the gate at all.
Tests 18, 19 and 20 passed — which is precisely the state the repository was in
before this commit, with forty-odd green scenarios and a panel answering 403.

So the rule has two independent covers, and the record says which is which:

- **Test 17** pins the header directly, and would have caught this without any
  gate. It did not exist, because no unit test drove a session-mode MUTATION at
  all; every session-mode case in the file was a `probe`, which is a GET.
- **The gate** is what makes tests 19 and 20 — and the whole integration file,
  F4E-05 — fail on the same mutation. That breadth is what stops the next person
  removing the header in a refactor and seeing one narrow assertion break.

The restore after the two-file mutation was verified byte-identical against a
copy taken beforehand, and `git status` was clean afterwards.

## What is NOT falsified here

The acceptance suite itself. Its mutations would have to be run against a live
panel, and `scripts/falsify.sh` names one of `unit`, `web`, `exhaustive`,
`integration` or `shell` — deliberately, because an unknown project silently
matched no files and manufactured seven KILLED verdicts in one session. Adding
`acceptance` to that list would make the harness report a kill whenever no panel
was running, which is the same failure wearing the same clothes.

What the acceptance suite has instead is that it FAILS rather than skips when
`NEXA_ACCEPTANCE_PANEL_URL` is absent, so it cannot be green without a panel.
