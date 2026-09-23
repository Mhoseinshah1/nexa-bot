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

| #      | Rule                                                            | Mutation                                                                     | Named test                                                                                                      | Result   |
| ------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| F4E-06 | `PERFORMABLE_OPERATION_TYPES` names only what has a branch      | `'TERMINATE'` appended to the constant (see the note below)                  | `registries.test.ts` › names exactly the ten types this release performs, and no more                           | KILLED   |
| F4E-07 | The executor refuses an unperformable type before anything else | `if (!isPerformableOperation(operation.type)) {` → `if (false as boolean) {` | `provisioning-delivery.test.ts` › refuses a rotation on a panel that cannot rotate, before contacting a panel   | SURVIVED |
| F4E-08 | An unperformable type is legal from NO service state            | `ROTATE_SUBSCRIPTION: []` → `ROTATE_SUBSCRIPTION: ['ACTIVE']`                | `provisioning-delivery.test.ts` › refuses a rotation on a panel that cannot rotate, before contacting a panel   | SURVIVED |
| F4E-09 | A usage sync writes what the panel said                         | `recordUsage(...)` call removed from `finishUsageSync`                       | `provisioning-delivery.test.ts` › refreshes a stale usage figure from the panel, and writes what the panel said | KILLED   |
| F4E-10 | A fresh figure is not re-read                                   | `COALESCE(usage_synced_at, created_at)` → `usage_synced_at IS NULL OR …`     | `provisioning-delivery.test.ts` › does not sync a service whose figure is still fresh                           | KILLED   |
| F4E-11 | One sync per cadence window, however many ticks run             | the window removed from the derived operation id                             | `provisioning-delivery.test.ts` › plans ONE sync per cadence window however many ticks run                      | KILLED   |
| F4E-12 | A failed sync claims no refresh it did not make                 | `if (!read.ok)` branch falls through to `recordUsage`                        | `provisioning-delivery.test.ts` › a sync that the panel refuses is FAILED, never UNKNOWN, and moves no service  | KILLED   |

#### F4E-06 after Phase 4F

The cited case was RENAMED in Phase 4F — six types became nine — and the citation
here was repointed in the same commit that noticed, which is the check
`scripts/check-falsification-citations.mjs` exists to force.

The MUTATION in that row is historical and is no longer applicable on this head:
`TERMINATE` became performable in 4E itself, and the three commercial types in
4F, so appending `'TERMINATE'` is now a no-op. The rule is unchanged and is
re-measured on the current code as **F4F-30**, which removes the three types 4F
added and kills the same case.

#### F4E-06, F4E-07 and F4E-08 after RickPanel rotation

The registry case was renamed again — nine types became ten — when
`ROTATE_SUBSCRIPTION` became performable (`docs/rickpanel-rotate-audit.md`), and
F4E-06 is repointed to it. F4F-30's mutation still kills it on this head.

F4E-07 and F4E-08 cited the integration case that planned a `ROTATE_SUBSCRIPTION`
because no code performed one. That is no longer true, so the case was rewritten into
its successor: a rotation on a 3X-UI panel is refused before the panel is dialled. The
rows now cite the successor, and their results are recorded as they stand on this head
rather than re-derived: **every member of `OPERATION_TYPES` is performable**, so the
membership check has no contract type left that reaches it, F4E-07's mutation has no
reachable input, and F4E-08's target (an empty legal-from list for `ROTATE_SUBSCRIPTION`)
no longer exists. Both refusals are kept for the next type the contract gains; the
registry pin is what forces that type to arrive with its branch. The measurement below
is the one made in 4E, when a type without a branch still existed.

### F4E-07 and F4E-08, the two survivals, and what they actually mean

Neither mutation fails a test **on its own**, and that is the design rather than a
gap: they are two independent refusals of the same thing, so removing either leaves
the other standing. What had to be measured is whether the PAIR is load-bearing, so
both were applied together — the membership check disabled and the unperformable type
declared legal from `ACTIVE` — and the test then FAILED:

Both rows were **re-run after the scope correction**, against
`ROTATE_SUBSCRIPTION` rather than `TERMINATE`, because TERMINATE became performable
in this phase and a mutation against it would no longer be testing what these rows
claim. Individually SURVIVED, exactly as before; together:

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

`OPERATION_REQUIRED_CAPABILITIES['ROTATE_SUBSCRIPTION']` is
`['ROTATE_SUBSCRIPTION_LINK']`, which no adapter declares, so the third refusal still
covers the type these rows now use — and the reasoning above is unchanged by the swap.

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

---

# Service management — Marzban suspend, resume and terminate

The scope correction (`docs/phase4e-audit.md`) narrowed this half of the phase to
Marzban. These are the rules it introduced, and what happens when each is taken
away.

Two of them were **corrected against a real panel before they were falsified**,
which is a different kind of evidence and is recorded as such in
`docs/real-panel-acceptance.md`: falsification proves a rule has a test, not that
the rule is right. F4E-21 is the clearest case — the rule it protects was WRONG
when Phase 4D shipped it, and no mutation of a fake this repository wrote could
have said so.

| #       | Rule                                                              | Mutation                                                                  | Named test                                                                                                       | Result |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| F4E-21  | A Marzban create names the operator's inbound tags                | `payload['inbounds'] = activation.inboundTags;` → `= {}`                  | `marzban-service.test.ts` › names the operator’s inbound tags, so the account is not excluded from every inbound | KILLED |
| F4E-22b | Every configured protocol must have at least one tag              | the `superRefine`'s empty-tags condition → `false && (…)`                 | `contracts-invariants.test.ts` › refuses tags for SOME protocol while another is left with none                  | KILLED |
| F4E-23  | A suspend sends the status and nothing else                       | `value: { status }` → `value: { status, expire: 0 }`                      | `marzban-service.test.ts` › sends the status and NOTHING else, so a suspend cannot rewrite an allowance          | KILLED |
| F4E-24  | A 200 must carry the status that was asked for                    | `if (record['status'] !== status)` → `if (false && …)`                    | `marzban-service.test.ts` › refuses a 200 whose record does not carry the status that was asked for              | KILLED |
| F4E-25  | A 404 on a state change is ABSENT, never a wire failure           | `if (changed.status === 404) return …` → `if (false && …)`                | `marzban-service.test.ts` › reports an account the panel does not have as ABSENT, never as a failure             | KILLED |
| F4E-26  | A replayed delete is a success that did no work                   | `if (removed.status === 404) return …` → `if (false && …)`                | `marzban-service.test.ts` › treats a replayed delete as a success that did no work                               | KILLED |
| F4E-27  | A capability guard needs the method AND the declaration           | `canDisableUser` drops `&& adapter.supports('DISABLE_USER')`              | `contracts-invariants.test.ts` › says no to a method whose capability is not declared                            | KILLED |
| F4E-28  | An idempotent mutation's uncertain failure is FAILED, not UNKNOWN | `if (isIdempotentMutation(type)) return 'FAILED';` → `if (false && …)`    | `registries.test.ts` › classifies the three management types as idempotent mutations, and PROVISION not          | KILLED |
| F4E-29  | TERMINATE is not legal from TERMINATED                            | `'TERMINATED'` appended to `OPERATION_LEGAL_FROM.TERMINATE`               | `registries.test.ts` › gives each management type exactly the SERVICE_MACHINE edges it may take                  | KILLED |
| F4E-30  | SUSPEND is legal from ACTIVE alone                                | `SUSPEND: ['ACTIVE']` → `['ACTIVE', 'SUSPENDED']`                         | `registries.test.ts` › gives each management type exactly the SERVICE_MACHINE edges it may take                  | KILLED |
| F4E-31  | A panel that has no such account does not move the service        | `if (!changed.found) {` → `if (false && …) {`                             | `service-management.test.ts` › never reports a suspend that suspended nothing                                    | KILLED |
| F4E-32  | Ending a service takes two taps                                   | the detail screen's terminate button carries the DESTRUCTIVE prefix       | `service-management.test.ts` › offers pause and end on an active service, and the end button only ASKS           | KILLED |
| F4E-33  | A button is drawn only where the panel can honour it              | `if (operable.ok) available.push(type);` → `available.push(type);`        | `provisioning-delivery.test.ts` › offers no management button for a service on a panel that cannot manage one    | KILLED |
| F4E-34  | An operation of this type already open is returned, not rivalled  | `findOpen(...)` → `null as never`                                         | `service-management.test.ts` › plans ONE operation however many times the same tap arrives                       | KILLED |
| F4E-35  | A customer's request checks the state the action is legal from    | `if (!legalFrom.includes(service.state))` → `if (false && …)`             | `service-management.test.ts` › offers nothing further once the service has ended                                 | KILLED |
| F4E-36  | A suspend moves the service to SUSPENDED                          | `MANAGEMENT_TARGET_STATE.SUSPEND: 'SUSPENDED'` → `'ACTIVE'`               | `service-management.test.ts` › pauses the account on the panel and says the request was recorded, not done       | KILLED |
| F4E-37  | One operation in flight per SERVICE, or no claim at all           | `AND in_flight.state = 'IN_FLIGHT'` → `= 'NEVER_A_STATE'`                 | `service-management.test.ts` › claims no second operation for a service that already has one in flight           | KILLED |
| F4E-38  | A code that is not a refusal is re-thrown, never answered         | `if (!refusals.includes(code)) throw error;` → `if (false && …)`          | `service-management.test.ts` › does not answer an outage with a sentence about the customer’s panel              | KILLED |
| F4E-39  | A customer's request to end a service is recorded as a decision   | the `service.request_*` `audit.record` made unreachable                   | `service-management.test.ts` › records WHO asked for a service to be ended, as its own decision                  | KILLED |
| F4E-40  | A stranded replayable mutation returns to the retry path          | the reaper's `WHEN isReplayable THEN 'PLANNED'` → `'UNKNOWN'`             | `service-management.test.ts` › retries a suspend whose worker died mid-call, instead of stranding it for ever    | KILLED |
| F4E-41  | A retried mutation is not announced as a stall                    | `if (isIdempotentMutation(operation.type)) continue;` → `if (false && …)` | `service-management.test.ts` › retries a suspend whose worker died mid-call, instead of stranding it for ever    | KILLED |

## F4E-22, the mutation that survived and the one that did not

The first attempt at F4E-22 made `inboundTags` optional again — the exact shape the
field had before this phase — and **SURVIVED**. That is a true finding about where
the rule actually lives, and the reason to record it rather than quietly replace it
with the mutation that killed.

`.optional()` is not what refuses a panel with no tags. The `superRefine` is: it
iterates `proxyProtocols` and demands a non-empty tag list for each, so an activation
with the key absent fails that check whether or not the field is optional. The two
are not redundant — the optionality is what makes the type honest, and the refine is
what makes the VALUE correct — but only one of them is load-bearing at runtime, and
the falsification says which.

So F4E-22b is the row, and F4E-22 is the note. Recording only the kill would have
implied a cover the codebase does not have.

## What is NOT falsified in this half, and why

**The `canDisableUser` guards inside the executor's three dispatch branches.** They
are unreachable as the code stands — `decideOperability` has already refused, reading
the same capability from the same descriptor — so a mutation disabling one changes
nothing any test can see. That is stated in the code beside them rather than papered
over: they earn their place against a future edit that relaxes the operability check,
and they turn what would be a TypeError into a refusal. A TypeError is not a
`ProviderFailureKind`, so nothing would classify it and a mutating operation could not
say whether it took effect.

**The acceptance suites**, for the reason the 3X-UI half of this document already
gives: `scripts/falsify.sh` refuses a project it does not know, deliberately, because
an unknown project once matched no files and manufactured seven KILLED verdicts in one
session. Adding `acceptance` to that list would make the harness report a kill whenever
no panel was running.

Every mutation above was applied by `scripts/falsify.sh`, which restores by
`git checkout --` and FAILS if the tree is not byte-identical afterwards. The two
mutations applied together for F4E-07/F4E-08 were restored by hand and verified with
`cmp` against copies taken beforehand; `git status` was clean.
