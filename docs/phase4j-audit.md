# Phase 4J audit — the eight axes, measured rather than asserted

Phase 4J is "final cross-system hardening": tenancy, idempotency, concurrency,
crash windows, money, secrets, provider correctness, and
migrations/update/rollback. Every earlier phase audit in this directory opens by
reading the code a phase is about to change. This one cannot: its subject is
eight properties that are supposed to hold EVERYWHERE, and the failure mode of a
"does it hold?" audit is a page of confident prose that nobody can check.

So this audit is arranged differently. **Each axis gets an instrument — a command
that produces a list — and the audit records the command, its output, and the
classification of every row in it.** A null result stated that way is worth
something: the next phase re-runs the command in one line and sees whether the
answer changed. A null result stated as prose is worth nothing, and
`docs/phase4g-audit.md` closes by recording why — the two worst defects of that
phase were rules that were WRONG rather than untested, and neither the suite nor
the falsification pass could see them.

The scans live in `scripts/audit/` so they are re-runnable rather than quoted.

## The shape of the one real finding, stated first

Seven of the eight axes come back clean, and the audit says so with its working.
**One does not.** The crash-window axis has a defect that no amount of
transaction discipline can close, because it is not inside a transaction:

```
provisioner-loop.ts   await this.executor.runOnce(scope)   // transaction A: terminalises
provisioner-loop.ts   await this.outcomes.announce(...)    // transaction B: enqueues the message
```

Two transactions with a process boundary between them. A crash after A and before
B leaves an operation that is terminal, un-announced, and that nothing will ever
call `announce` for again — the loop has moved on, and `grep -n "announce("`
finds exactly one call site in the whole tree. The customer paid, the work
happened, and the sentence that says so was lost to a container restart.

That is Phase 4H's Codex finding C2, which 4H declined with a reason, and §4
below is the argument for why the reason was right and the shape of the fix that
follows from it.

## Axis 1 — tenancy

**Instrument.** `scripts/audit/tenancy-scan.mjs` walks every `select(`, `insert(`,
`update(` and `delete(` in `apps/api/src/**/*repository*.ts` and flags a
statement whose next 30 lines never mention `tenantId`.

**Output.** 49 flags across 22 repositories. Every one is accounted for:

| class                                        | count | why it is not a finding                                                                                                                                                                                                                                             |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commerce list queries                        | 6     | `conditions`/`filters` is built ABOVE the window and its FIRST element is `eq(<table>.tenantId, tenantId)` in every one                                                                                                                                             |
| `drizzle-operation.repository.ts` :558, :832 | 2     | both filter `tenantId`, past the 30-line window; read and confirmed                                                                                                                                                                                                 |
| platform-wide tables                         | 41    | `admin_sessions`, `admin_login_throttle`, `backup_runs`, `recovery_requests`, the dispatcher's ACTIVE-tenant scan, and lookups of `tenants`/`bot_instances` BY id — which is how a scope is resolved in the first place, so a tenant filter there would be circular |

**Verdict: no finding.** The scan is the deliverable.

## Axis 2 — idempotency

**Instrument.** `scripts/audit/idempotency-scan.mjs` lists every `async` method
on a `*.service.ts` whose body opens a transaction and never mentions
`idempotencyKey`.

**Output.** Nine methods — and counting them as findings would file eight false
ones, because the rule is not "every method takes a key":

| method                                                                                                     | the mechanism it uses instead                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-management.changeOwnPassword`, `authentication.logout`, `bootstrap-owner.execute`                   | identity, not tenant business work. A replayed logout is a no-op; a password change is last-writer                                                                                    |
| `bot-bootstrap.execute`                                                                                    | reconcile-shaped by construction — Phase 4I's whole subject                                                                                                                           |
| `customer-notification.deliverDue`, `payment-expiry.runOnce`, `delivery.deliverDue`, `provisioner.runOnce` | sweeps. **The claim IS the key**: a conditional UPDATE plus a lease                                                                                                                   |
| `delivery.deliver`                                                                                         | the customer's own redelivery tap, guarded by `markSendStarted(scope, id, FROM, …)`. A second tap reads the same `from`, loses the conditional write, and is refused rather than sent |

So the rule this codebase actually holds is: **every COMMAND takes a key, and
every CLAIM is conditional on the state it was read from.** Both are real, and
the second is what every background lane uses. Writing that sentence down is the
finding — an unstated rule is the one a future reviewer "fixes".

**Verdict: no finding, one rule stated.**

## Axis 3 — concurrency

**Instrument.** `grep -rn "setState\|\.set({ *state"` over the modules.

**Output.** `setState` exists nowhere, and five files carry a comment saying why
(the reason ADR-0028 gives: one convenience setter removes the conditional from a
replay, a double-click and two replicas at once). Three `.set({ state: … })`
sites look unconditional in a grep and are not:

- `drizzle-payment.repository.ts` — `state = 'PENDING'` AND a not-SIGNALLED
  predicate, with a comment recording that the caller's guard could not close the
  window and only the write could.
- `drizzle-operation.repository.ts` (lease release) — `state = 'IN_FLIGHT'` AND
  `call_started_at IS NULL`.
- `drizzle-operation.repository.ts` (reconcile verdict) — `state = 'UNKNOWN'`.

**Verdict: no finding.**

## Axis 4 — crash windows

**Instrument one.** `scripts/audit/crash-window-scan.mjs` looks for an awaited
`uow.run` followed within 40 lines by a call to an outbound port.

**Output.** One hit, and it is a false positive: `operation-outcome-announcer.ts`
calls `notifier.notify(…, tx)` INSIDE the callback — an enqueue, not a send.
There is **no commit-then-send anywhere in business code**; every path to Telegram
goes through the lane.

**Instrument two.** The four outbound sinks, and whether each refuses to run
inside a transaction:

```
$ grep -rln "fetch(\|https\.request\|http\.request\|spawn(\|execFile" apps/api/src --include=*.ts
apps/api/src/infrastructure/net/safe-http.ts
apps/api/src/infrastructure/telegram/send-message.ts
apps/api/src/modules/platform/backup/infrastructure/pg-tools.ts
apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery.ts
```

Four sinks, and all four call `assertOutsideTransaction`. The rule is enforced at
the sink rather than at the call site, which is the shape that survives a new
caller — `transaction-boundary.ts` argues this at length and the Architecture
Hardening phase made it runtime rather than documentation.

**So both instruments say the transaction discipline holds — and neither can see
the defect.** The window is not "an effect done too early"; it is an effect
**never done at all**, between two transactions. §"The shape of the one real
finding" above names it. The fix is 4J-1 and its design is §"4J-1" below.

**Verdict: one finding, and it is the phase's main work.**

## Axis 5 — money

**Instruments and output.**

- No money column is anything but `bigint`: the only non-bigint matches in the
  schema are the two `price_currency text` companions themselves.
- Six `bigint` money columns; ten currency columns. Every amount has a companion.
- `balance` appears in the schema only inside comments ARGUING there is no such
  column — plus the boundary check that rejects one.
- CHECK constraints bind the pairs: `orders_total_consistent_check`,
  `orders_discount_bounded_check`, `service_addons_price_pair_check`,
  `service_addons_amount_matches_kind`, `payments_amount_check`,
  `wallet_entries_amount_check` (amount POSITIVE, direction carries the sign).

**Verdict: no finding.**

## Axis 6 — secrets

**Instruments and output.**

- No `logger.*` or `console.*` call anywhere in `apps/api/src` interpolates a
  token, password, secret or API key.
- `bootstrap-bot.cli.ts` REFUSES `--bot-token` rather than ignoring it, with the
  reason in the error text: _"argv is readable by every user on this machine"_.
  stdin and `--bot-token-file` are the two paths, and Phase 4I's
  `bootstrapRemedy` takes a CODE rather than a `NexaError` for the same reason —
  `deployment-smoke.sh` asserts the token never appears in CLI output.
- `secrets.cli.ts` holds no decrypted value beyond the statement that needs it.

**Verdict: no finding.**

## Axis 7 — provider correctness

**Instrument.** Where `capabilities` is declared, and what declares it.

**Output.** `capabilities` lives in `packages/contracts/src/provider.ts`, not in
the adapter: the adapter's `providerDescriptor('marzban') ?? {…}` fallback is
documented unreachable and a unit test proves every `PROVIDER_TYPES` member has a
descriptor. Marzban declares seven and the comment names the acceptance run that
proved each; Sanaei's list carries the `LIMIT_DEVICES` correction and the
sentence explaining that understating an adapter is "the less dangerous direction
of the two but still a lie a surface reads".

So the declare-after-acceptance rule sits where a surface reads it and where a
review can see it — which is what CLAUDE.md's real-panel rule asks for.

**Verdict: no finding.**

## Axis 8 — migrations, update and rollback

**Instrument.** A script over `_journal.json` and the `.sql` files.

**Output.** 60 migrations, 60 journal entries, nothing on disk missing from the
journal or the reverse, `when` monotonic, `idx` contiguous from 0. Exactly ONE
migration in the entire history contains a destructive statement —
`0002_drop_callback_refs.sql`, the documented expand/contract worked example that
`.claude/skills/nexa-migrations` cites. Phase 4I's `0059` is a nullable
`ADD COLUMN`, so the previous release runs against it unharmed; that is the
expand/contract compatibility F5 turned from a claim into a test.

**Verdict: no finding.**

## The decision this phase must STATE rather than leave implied

`operation-outcome-announcer.ts` writes a `customer_notifications` row — tenant-owned
business state — inside `uow.run`, with **no in-transaction activity check**. Every
other business write path in this codebase reads `ScopeActivityReader` inside its
transaction and refuses a scope that has stopped accepting work; CLAUDE.md lists
that among the non-negotiables, and Phase 4I's own self-review found exactly this
omission in fresh code and fixed it.

This is not an oversight to fix by reflex. There are two defensible answers:

**(a) It needs the check.** A stopped tenant stops producing rows, like every
other write path, and the customer hears nothing until the operator restarts it.

**(b) It is a stated exception.** Telling a customer the outcome of work that has
ALREADY been done is not new business work. Suppressing it leaves someone who paid
in silence — which is precisely the gap Phase 4H existed to close, and an operator
stopping a tenant is not asking for its existing customers to be abandoned
mid-provision.

**(b) is the right answer**, and the reason it must be WRITTEN rather than left as
an absent line of code is that an unstated exemption is indistinguishable from an
oversight. That is how it was found: not by reading the announcer, but by asking
the whole tree the question one self-review finding raised. So 4J owes:

1. a comment in the announcer saying which side of the line it is on and why;
2. the exception recorded next to the rule in `docs/conventions.md`, bounded —
   it covers telling a customer about work already completed, and nothing else;
3. a test that fails if someone "fixes" it by adding the check.

Note what (b) does NOT license. The announcer may enqueue; it may not create an
order, a payment, a service or an operation for a stopped tenant. The bound is
what makes the exception an exception rather than a hole.

## OQ-4H-01, and why the resolution it proposed was the expensive one

The open question 4H recorded: durable work commits, the synchronous Telegram
reply gets a 429, and the customer sees nothing. It offers two resolutions —
(a) the lane grows a parameterised payload, or (b) the webhook turn gains its own
bounded retry before acknowledging — and argues (a) is a contracts and schema
decision that ADR 0030 §1 takes the opposite position on.

**That argument is right about the option it describes and wrong about what the
fix needs**, because it assumes the lane must carry the INTERACTIVE REPLY. It does
not have to. It carries the FACT. And the two interactive replies that follow a
committed write are already facts with no values and no buttons:

```
bot-runtime.ts  return { key: 'bot.payment.received_for_review', values: {}, buttons: [], orderId: null };
bot-runtime.ts  return { key: 'bot.order.cancelled',            values: {}, buttons: [], orderId: null };
```

`values: {}` and `buttons: []` in both. So the fallback needs no payload column,
no rendered string, and no new template key — two members on
`CUSTOMER_NOTIFICATION_KINDS`, each mapping to the template the interactive path
already uses:

| kind                        | template                          | subject       | precondition                                       |
| --------------------------- | --------------------------------- | ------------- | -------------------------------------------------- |
| `PAYMENT_TRANSFER_RECORDED` | `bot.payment.received_for_review` | `payments.id` | `false` — terminal; an hour-late one is still true |
| `ORDER_CANCELLED`           | `bot.order.cancelled`             | `orders.id`   | `false` — same                                     |

`BotRuntime` then enqueues the corresponding kind when `messenger.send` answers
`RATE_LIMITED` for one of those two turns. The lane's `subject_key` plus
`onConflictDoNothing` means a customer who taps twice still hears once, and
`PENDING` with `retryAfterMs` and no attempt spent is behaviour the lane already
has. Nothing about ADR 0030 §1 has to move.

**What stays non-retried, and must be SAID rather than left silent.** Every reply
that renders a menu, a catalogue, a service list or a detail screen. Those carry
values, carry buttons, have no subject, and the customer's next tap reproduces
them. Putting a stale menu on a queue delivers it minutes later against state that
has moved on. So the rule this phase states is:

> A reply that is a FACT about an entity the customer just changed falls back to
> the lane. A reply that RENDERS state does not, and is reproduced by the next tap.

Writing that split down is half the deliverable. Without it the next reader
"finishes the job" by queueing the menu renders too, and the symptom — a
customer shown a catalogue from four minutes ago — looks like a caching bug
rather than like this decision.

## Axis 7 addendum — the capability matrix, named rather than assumed

`PROVIDER_CAPABILITIES` has sixteen members. What each provider declares:

| item 9 asks for | capability                  | Marzban   | Sanaei (3X-UI) |
| --------------- | --------------------------- | --------- | -------------- |
| provision       | `CREATE_USER`               | YES       | YES            |
| lookup          | —                           | see below | see below      |
| usage           | `READ_USAGE`                | YES       | YES            |
| suspend         | `DISABLE_USER`              | YES       | no             |
| resume          | `ENABLE_USER`               | YES       | no             |
| terminate       | `DELETE_USER`               | YES       | no             |
| renew           | `RENEW_USER`                | YES       | no             |
| add traffic     | `ADD_VOLUME`                | YES       | no             |
| add time        | `ADD_TIME`                  | YES       | no             |
| (link)          | `DELIVER_SUBSCRIPTION_LINK` | YES       | YES            |
| (health)        | `HEALTH_CHECK`              | YES       | YES            |
| (devices)       | `LIMIT_DEVICES`             | no        | YES            |

Marzban: **ten declared**. Sanaei: **five**, and every one is non-mutating except
`CREATE_USER`, which is exactly the Phase 4 scope the owner fixed — 3X-UI keeps
provisioning and read paths and gains no mutable capability.

**"lookup" is not a capability and should not become one.** There is no
`READ_USER` in the vocabulary; reading a user back is what `READ_USAGE` does, and
the reconcile path uses it. Adding a `LOOKUP` member would be a contract change
with no producer — the thing `check-boundaries.sh` refuses for error codes and
the same argument applies. Item 9 is answered by naming the mapping, not by
inventing a member.

**4J does NOT re-run the real-panel acceptance.** The capabilities were declared
in 4E and 4F only after `tests/acceptance/real-panel-marzban.test.ts` drove the
shipped adapter against a disposable Marzban v0.8.4, and CLAUDE.md's rule is
declare-after-acceptance. 4J changes no adapter and no capability, so there is
nothing new to prove; re-running it needs a disposable panel this session does
not have, and `pnpm test:acceptance` FAILS rather than skips without one. That is
recorded as an acceptance item not exercised, with the reason, rather than
claimed.

## Axis 9 — process readiness

**No finding.** Recorded with its evidence rather than asserted.

Five process roles exist and all five are production compose services:

```
$ ls apps/api/src/main*.ts
main.ts  main.worker.ts  main.monitor.ts  main.recovery.ts  main.provisioner.ts

$ grep -nE "^  [a-z-]+:" deploy/compose.yml
api: worker: monitor: provisioner: recovery: caddy: postgres: redis: web-assets:
```

`NEXA_READY_SERVICES="api worker monitor recovery provisioner caddy"` — every
role plus the edge. `nexa_wait_ready` DIES rather than passing when the compose
file defines none of them: _"Refusing to call this installation ready."_

### The intersection is deliberate, and is NOT the gap item 12 asks about

`nexa_required_services` intersects that list with what the ACTIVE compose file
defines, so a service the topology lacks is not required. That reads like the
hole — and the comment above it is the argument for why it is not: host assets
are release-versioned, so a ROLLBACK activates the target release's compose while
this library is still in memory, and demanding a service that release never had
would make every rollback to it time out and be reported as a failure after the
assets had already moved. Hardcoding the list instead is named as "the opposite
bug: a dead monitor would pass as ready for ever".

So the rule is: readiness requires every role the RUNNING RELEASE defines. That is
the strongest statement available to a wrapper that must also roll backwards, and
`provisioner` and `recovery` were both added to the list with the money argument
attached — _"takes payments, answers every health check, reports a successful
botctl update, and creates nothing"_.

### Application-level readiness

`blocksReadiness` is `dependency.status === 'down' && dependency.required !== false`
— **absent means required**, with the mutation argument written out: `=== true`
would make a probe that forgot the flag silently optional, "down while the
process reports ready".

### What 4J-1 adds, and why it needs no readiness change

The `announceDue` sweep lands inside `ProvisionerLoop`, which runs in the
`provisioner` role — already required. The 4H notification dispatcher runs in
`worker`, also already required. No new process role, so no new readiness entry.

## What 4J must NOT do

- **No Phase 7 work.** Discounts, referral, cashback, affiliate, reseller and
  promotions stay out, per the owner's decision.
- **No new mutable 3X-UI scope.** Marzban remains the supported mutable provider
  for Phase 4. A 3X-UI `SUSPEND`/`RESUME`/`TERMINATE`/`RENEW`/`ADD_TRAFFIC`/
  `ADD_TIME` is not in this run even though the executor would dispatch it.
- **No release, tag or production deploy.**
- **No new capability declared ahead of an acceptance run.**

## The 4J work list, as this audit establishes it

| #    | item                                                                                                                                                                                                                                                                                                               | axis          | size                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------- |
| 4J-1 | the terminalise-then-announce crash window: `announced_at`, the stamp inside the enqueue transaction, and the sweep                                                                                                                                                                                                | crash windows | the phase's main work |
| 4J-2 | OQ-4H-01: lane fallback for replies that follow a committed write; a stated non-retry for the rest                                                                                                                                                                                                                 | crash windows | medium                |
| 4J-3 | the announcer's activity-check exception: comment, convention entry, and a test that fails if it is "fixed"                                                                                                                                                                                                        | tenancy       | small                 |
| 4J-4 | the FOUR scans committed under `scripts/audit/` so the next phase re-runs them rather than re-deriving them. Four, not eight: money, secrets and provider correctness were measured with one-line greps whose output is quoted in full above, and a script that wraps a grep is a script that has to be maintained | all           | small                 |
