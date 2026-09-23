# Nexa Bot — working notes for Claude

Tenant-aware Telegram service-sales platform. TypeScript, NestJS, PostgreSQL 16,
Redis, React. One codebase, several process roles. (No queue library and no
Telegram framework are installed yet — the webhook is parsed at the boundary
and the notification dispatcher polls Postgres.)

**Phases 0, 1 and 2 are done: foundation, identity and RBAC, then the control
plane** — templates, settings, feature flags, notifications and the operational
log. **Phase 3 is done**: 3A gave providers, panels, credentials and health; 3B
added the MHSanaei/3x-ui v3.7.0 adapter; 3C a dedicated `monitor` process role
that keeps panel health up to date on a schedule; 3D the Web Admin. **Telegram
Backup V1 is done** — the disaster-recovery pipeline, ADR-0025 and
`docs/backup.md`. **Web Admin Disaster Recovery is done** — one operational
section, a fourth `recovery` process role, and a real cutover by database rename
(ADR-0028).

**Phase 4 is the product, and it is done.** 4A customers; 4B catalogue and
orders; 4C wallet, payments and settlement; 4D the `provisioner` process role
that turns a paid order into an account on a panel; 4E suspend, resume,
terminate and usage; 4F renew, add traffic and add time; 4G the payment
outcomes an operator or a deadline produces; 4H the customer notification lane
(ADR-0030) and the two actions a customer can take on their own order; 4I the
Telegram bootstrap surface; 4J the final hardening pass
(`docs/phase4j-audit.md`).

**An order the installation cannot deliver is refunded, not queued.** The owner
removed `PAID_UNFULFILLED` and everything built on it — the operator retry, the
reassignment, `orders.fulfil` — in favour of one automatic outcome. See the four
money rules below.

**A service's username is per-panel policy, not a derivation.** A panel allows
CUSTOM, RANDOM or both; a customer's chosen name is canonicalised to lowercase,
held by a reservation row in a namespace derived from the provider and host —
deliberately NOT tenant-scoped, because two tenants pointing at one machine
share its account namespace — funded in the transaction that takes the money,
and released only by the transaction that gives it back. A panel with no
template keeps the `nx…` shape. `docs/phase6c-username-falsification.md`.

**Marzban is the supported mutable provider.** 3X-UI keeps the five
capabilities it has — of which only `CREATE_USER` mutates anything — and gains
no new mutable scope: the owner's correction, recorded in
`docs/phase4e-audit.md`.

**Discounts and cashback are built (WP8, `docs/wp8-pricing-audit.md`).** What
remains unbuilt is referral, affiliate, resellers and any other promotion. Do
not add them without an explicit instruction.

Four pricing rules, each a way to charge a customer a number they did not see
or give away money twice:

- There is **one pricing boundary**, `PricingService.price` over the pure
  `pricing-engine.ts`. Checkout, a typed code, the commercial actions and the
  operator's preview all go through it; a second calculation is a second
  answer to "what does this cost".
- A quote is **honoured, never re-priced**. Confirmation re-decides only what
  can make the quote unfulfillable — status, window, limits, first purchase —
  under the rules' row locks in id order, and refuses with
  `DISCOUNT_NO_LONGER_VALID` rather than charging a different figure. A code
  re-quotes a draft from its OWN snapshot, never from today's price.
- A limit counts **live redemptions** (order `AWAITING_PAYMENT` or `PAID`),
  asked of the order at read time; there is no counter. A customer is told one
  sentence for every code refusal — the reason is an oracle for guessing codes.
- Cashback is **earned once, at delivery** (an op of the order's `PURCHASED_AS`
  type `SUCCEEDED`), by the provisioner loop's sweep, never by hooks at each
  success site. A refund reverses it by the cumulative target, so partial
  refunds sum to one full one; what the balance cannot cover is recorded as
  unrecovered and never collected. The reversal judges the promise's state
  only under the customer's wallet lock.

**The deployment checkpoint after Phase 2 is done too**: an immutable image,
a production Compose topology behind Caddy, an Ubuntu installer, and `botctl`
with update and rollback (ADR-0022, `docs/deployment.md`). `v0.2.0` and
`v0.2.1` HAVE been deployed to a real staging server, and the owner's own
acceptance on them is what produced the Telegram main menu and the Phase 5
payment work. What is still unrun is the PRODUCTION checklist —
`docs/vps-acceptance.md` decides that. `BLOCKER-SECRETS-V2` is still open.

Three deployment rules that are easy to break by accident:

- The root `docker-compose.yml` is **development infrastructure**. Production
  is `deploy/`. Never merge the two.
- A release is a **digest**, never a tag. `botctl` resolves a version once and
  addresses the image by digest everywhere afterwards.
- `botctl rollback` never restores the database. The backup predates the
  migration, so restoring it would discard every write made since.

Authentication and authorization are real. Every new write path takes a
`ScopeContext` and an `ActorContext` and checks a permission through the guard —
never by inspecting an actor's type, and never by not drawing a button.

Four Phase 3 rules that are easy to break by accident (ADR-0023):

- A panel credential travels **one way**. The repository projection selects the
  three set-at timestamps and never a ciphertext, so no response builder can
  acquire a value. Never add a masked stand-in either — `********` can be
  resubmitted as the real password.
- A provider type is **code**, not a row, and the adapter is resolved before the
  panel row is written. A panel that cannot be operated must not become a row.
- Health is **latest state only**, and `DISABLED` and `UNCHECKED` are projected
  rather than stored. A probe result changes health and nothing else — never a
  status, never a credential.
- Private addresses are **deliberately reachable**; only destinations that are
  never a panel are refused. Redirects are never followed and the socket is
  pinned to a pre-validated address, which is why that code is on `node:http`
  rather than `fetch`.

Four more from Phase 3C:

- There is **one probe implementation**, `panels/application/probe-core.ts`.
  The operator's connection test and the background monitor are two wrappers
  over it. Never copy it; the copy that would silently keep the old behaviour
  is the unattended one that dials panels on a timer.
- The monitor probes **ACTIVE panels only**, and the rule is enforced in the
  discovery query and again in the core. `DISABLED` means the operator said
  stop using this for now.
- Background work takes the SAME tenant probe budget with a **reserve floor**,
  never a second bucket. A second bucket would raise a tenant's total outbound
  rate, which is the bound's whole purpose.
- Nothing about a probe is decided in a process. The per-panel claim and the
  budget are conditional writes; **two monitor replicas are the normal case**,
  briefly, on every rolling update.

Four Phase 6B rules, each naming a way to oversell or mis-sell a panel:

- A capacity slot is a **RESERVATION ROW**, not a count. Between a confirmation
  and a payment there is no service, so counting services sells the last slot
  twice and the second customer finds out after paying. `reserve` takes the
  panel's row lock FIRST and counts AFTERWARDS — a count issued before the wait,
  or the subqueries of a single `INSERT ... SELECT`, see the state the loser
  started from.
- **Operability and eligibility are different questions** and disagree in both
  directions. `decideOperability` asks whether one operation may run and ignores
  health; `decideEligibility` asks whether we may take money for a new account
  and ignores capabilities. A full panel is operable; a panel whose adapter
  cannot suspend is sellable.
- Eligibility is decided by **one evaluator with four callers** — catalogue,
  confirmation, settlement, release. Catalogue filtering is a courtesy and is
  never trusted: confirmation re-decides inside its transaction under the panel's
  lock, and settlement re-decides again. A predicate copied into four places
  disagrees with itself invisibly.
- **Enabling a panel requires a connection test bound to what it is NOW.**
  `validated_identity` is provider, address, activation and the three credential
  timestamps — deliberately NOT `configurationFingerprint`, which carries
  `status` and `updated_at` and would be invalidated by the act it authorises.
  Lowering a cap below current usage is accepted and terminates nothing.

Four rules about money the owner decided, and each one is a way to lose some:

- An order has **two terminal outcomes and no third**: FULFILLED, or REFUNDED
  for the exact amount to the customer's wallet, automatically, in the
  transaction that discovers it cannot be delivered. `PAID_UNFULFILLED`, the
  operator retry and the reassignment are gone. Never add a state, a queue or a
  button for "paid, undelivered, somebody will decide later" — what that
  produced was a list that only grew and a customer with neither an answer nor
  their money.
- There is **one credit path**, `RefundService.refundUndeliverable`, and the
  settlement lane and the provisioner both call it. It locks the payment, sums
  what is already committed and writes at most one ledger entry. A second writer
  would be a second answer to "how much did we give back", and the point of a
  ledger is that there is one.
- A **wallet purchase is refused, never refunded**. The debit is written in the
  settling transaction and dies with it, so crediting it back would be a credit
  for money that never left. The asymmetry with a bank transfer is deliberate:
  that money has already moved, so it is confirmed and then returned.
- **UNKNOWN is never refunded.** A create whose answer was lost may have taken
  effect, so the service goes to `UNRECONCILED` and a READ decides first.
  Refunding an ambiguous timeout gives money back for an account the customer is
  holding. `PURCHASED_AS` is the other half of that care: an operation carries
  `order_id` whenever its service has one, so a failed SUSPEND names the order
  that created the service, and only an operation matching what the order BOUGHT
  may refund it.

Four Phase 4 rules that are easy to break by accident:

- A customer is told a fact through the **notification lane**, never a string.
  `CUSTOMER_NOTIFICATION_KINDS` is a closed set pinned by a CHECK constraint,
  each kind renders one frozen template, and none of them carries a payload. A
  reply that RENDERS state does not belong there — it would need the
  parameterised payload ADR-0030 §1 refuses, and the lane would become "send
  this customer some text".
- A terminal operation is **answered exactly once**, and `announced_at` is what
  says so. NULL means unanswered, never "no answer was owed", so four of the
  five exits from `announce` stamp — including the three that decide nothing is
  owed. The fifth, a state that is not terminal, must not.
- An outcome that is **UNKNOWN is never retried and never queued again**. A
  429 is not an unknown outcome and a timeout is not a rate limit; the three
  are kept apart at every layer, because every collapse of them costs a
  customer either a duplicate charge or a message they cannot reconcile.
- The announcer is **the one write path that does not check scope activity**,
  and that is a stated exception with a bound and a test — see
  `docs/conventions.md`. Everything else reads `ScopeActivityReader` inside its
  transaction.

Three Phase 2 rules that are easy to break by accident:

- A template body is stored **raw** and rendered nowhere near where it is
  edited. Nothing in this codebase may persist a rendered string.
- A setting is declared in the registry or it does not exist. Unknown keys fail
  closed at the schema, the service and the surface.
- A feature flag is a boolean; its parameters are settings. Neither registry
  grows a field that belongs to the other.

Four backup rules (ADR-0025), because each names a way to produce a file that
looks like a backup and is not:

- The stage order is the contract: **DELIVER is reachable only from a
  VERIFY_RESTORE that passed**. A successful `pg_dump` is a file. Never add a
  path that delivers without verifying, and never verify the plaintext dump
  still on disk — verification decrypts the ENCRYPTED archive through
  `openArchive`, the same function the operator's restore uses.
- The dump **excludes nothing**. Not by table name, not by prefix, not because a
  table looks transient — `processed_messages` looks like a cache and is what
  stops a redelivered outbox message duplicating its effect. An exclusion needs
  a reason inside the manifest, where a restorer can read it.
- Delivery has **three** outcomes, and the third is why the run row exists.
  A 5xx, a 429, a timeout and an unreadable 2xx are `OUTCOME_UNKNOWN`, never
  "retryable": Telegram can reject a request whose upload it accepted. Nothing
  resends automatically. Never fold this into `DELIVERY_OUTCOMES` — that enum is
  the notification dispatcher's and is pinned by a CHECK constraint.
- One backup at a time is a **partial unique index**, not a process. Two worker
  replicas is normal on every rolling update. A stale lease is taken over by
  FAILING the abandoned run, never by adopting it: its files belong to a process
  that may still be writing them.

Five recovery rules (ADR-0028). Each one is a way to produce something that
looks like a restore and is not:

- **No HTTP request restores into the database serving it.** A request may
  upload, verify and confirm; the destructive work belongs to the `recovery`
  process role. Never add a path where a controller calls `pg_restore` against
  the live database — that is the instruction this whole design exists to obey,
  and it is one convenience refactor away from being broken.
- **The cutover is two RENAMES, and nothing drops the displaced database.** The
  candidate is restored into a new database, validated, and only then renamed
  into place; the outgoing one survives as `nexa_pre_restore_<id>` and is the
  rollback. Adding a cleanup that drops it turns a two-rename rollback into a
  restore from an archive — and it is the only copy of what the restore replaced.
  It survives the cutover only because of the pool's `'error'` listener: `pg`
  delivers connection death as an EVENT, and an unlistened one throws.
- **The quiesce is derived from the recovery row's state**, never from a second
  flag, and it is enforced at the two places a durable write actually passes —
  `DrizzleUnitOfWork.run` and `OutboxRelay.processBatch`. `PRE_RESTORE_BACKUP` is
  deliberately outside the window. A surface ALSO checks on arrival: the gate
  alone lets a six-stage pipeline run to COMPLETED with its writes refused one at
  a time, which is how a backup came to be reported as taken during a restore.
- **The confirmation binds to the artifact's SHA-256 and expires**, and both are
  checked again by the executor as it claims the work. The phrase is a constant,
  so storing the phrase proves nothing; the checksum is what makes a confirmation
  for one archive unable to restore another.
- **Every state change is a conditional UPDATE naming its `from` states.** There
  is no `setState`. That one mechanism is what makes a replay, a double-click and
  two executor replicas all safe, and a convenience setter would quietly remove
  it from all three.

One more, learned by running a real panel (`docs/real-panel-acceptance.md`):

- A fake this repository wrote and an adapter this repository wrote can only
  prove they **agree with each other**. Four defects reached `main` that way and
  each shipped behind a green suite: three on the Sanaei create path (two wrong
  routes and a dropped CSRF token), and one on Marzban's, where omitting
  `inbounds` was documented as "every inbound" and actually means NONE — a 200,
  a subscription URL, and a zero-byte subscription for the customer. So a
  provider rule is verified against the real panel binary, and the fake is
  corrected to match it in the same commit. `pnpm test:acceptance` needs a
  disposable panel of each kind and **fails rather than skips** without one; it
  is not in `pnpm verify` and CI does not run it.
- A capability is declared **after** the acceptance proves it, never before.
  `capabilities` is what the product promises an operator, and
  `canDisableUser`/`canEnableUser`/`canDeleteUser` require the method AND the
  declaration, so an implemented-but-unproven operation is refused rather than
  offered.

One more, learned in Phase 3C:

- An operational-event CODE is part of the schema, not a string. `operational_events`
  dedupes and recovers by code, and the append-only guard forbids rewriting
  `code` on an existing row — so splitting or renaming one strands every row
  still open under it, unresolvable, for ever. Do it only in the release that
  introduced the code, or ship a reconciliation that resolves the open rows
  through the ordinary recorder.

## Before you change anything

- `packages/contracts` is the **frozen specification**. Adding a state, event,
  permission, ledger reason, metric or template key is a contract change:
  make it its own commit, and say why in the message. Never fold one into a
  feature change.
- Read `docs/conventions.md`. Every rule there maps to a documented failure in
  the legacy system, and the boundary checks enforce most of them.
- `docs/research/` is **evidence, not specification**. `NOT_EXPOSED` means "the
  UI did not show it", never "it does not exist". Never resolve an `UNKNOWN` by
  guessing — add it to `docs/open-questions.md` instead.

## Layout

```
packages/contracts   frozen spec: types, schemas, catalogs, ports. Depends on nothing.
packages/i18n        the shared Persian catalogue, used by BOTH server and web
apps/api             src/modules/<context>/{domain,application,infrastructure}
                     src/surfaces/{telegram,web}   src/infrastructure/  (adapters)
                     entrypoints: main.ts (api), main.worker.ts (worker),
                                  main.monitor.ts (panel health monitor),
                                  main.recovery.ts (the destructive restore lane),
                                  main.provisioner.ts (creates services on panels)
apps/web             React admin shell; may import @nexa/contracts and @nexa/i18n only
```

Dependencies point inward. Domain and application layers declare ports;
infrastructure implements them. Surfaces call application services and never
touch the database.

## Non-negotiables

- Money is `bigint` minor units plus an explicit currency. Never a float, never
  a bare number, never an amount without a currency.
- Balance is derived from an append-only ledger. **Never add a balance column.**
- Every timestamp is `timestamptz` in UTC, from the `Clock` port. Reporting
  intervals are half-open `[start, end)`.
- Every state-changing command takes an idempotency key.
- Domain events go to the outbox **inside the business transaction**.
- Every write path takes a `ScopeContext` and an `ActorContext`; jobs act as
  `SYSTEM_JOB`. Deny by default.
- Every write path also reads `ScopeActivityReader` **inside its transaction**,
  and refuses a scope that has stopped accepting work. Not in the controller: a
  surface checks activity when the request arrives, and a stop can commit in
  between. Panels was the one module that skipped this, which let a tenant an
  operator had stopped be given new panels and a background monitor.
- Customer-facing text comes from a template key. No string literals in surfaces.
- No fake authentication, no placeholder abstractions, no fabricated actors.

## Commands

```bash
bash scripts/dev-services.sh   # postgres + redis (docker, or native fallback)
pnpm db:migrate:dev && pnpm db:seed:dev   # compiled: pnpm build && pnpm db:migrate
pnpm provision                 # the primary tenant (dev: provision:dev)
pnpm admin:bootstrap           # first owner, from dist (dev: admin:bootstrap:dev)
pnpm backup run|list|verify|restore   # the DR pipeline (dev: backup:dev)
pnpm verify                    # the gate: static, shell, unit, deploy logic, build
pnpm test:integration          # needs the services above
pnpm test:exhaustive           # 1341 notification orderings, ~4 min; nightly in CI
pnpm check:runtime             # dist CLI runs without devDeps; web ships no source maps
pnpm check:shell               # shellcheck; deploy/ at info, scripts/ at warning
pnpm test:deploy               # botctl update/rollback logic against a fake docker
```

With a Docker daemon (the Ubuntu CI job; cloud sessions usually have no
registry egress for base images):

```bash
bash scripts/deployment-smoke.sh          # build, up, migrate, serve, back up
bash scripts/deployment-update-smoke.sh   # A -> B -> failed health -> rollback
```

`pnpm verify` is the gate. If you changed the schema, also run `pnpm db:check`.
`pnpm test:exhaustive` is off the pull-request path on purpose — it is the
search, not the safety net, and every shape it has found has a named regression
in `tests/integration/notification-invariants.test.ts`.

## Reviewing with agents

Five rules. The first two were learned the expensive way on the Phase 2 branch;
the last three on the deployment branch, where four review rounds each found
their defect inside the fix written for the round before.

**A reviewer that mutates code works in its own worktree.** Falsifiability
review — reverting a production rule to watch a test fail — is the standard
here, and it means reviewers edit source. A reviewer sharing the implementation
checkout twice clobbered real fixes mid-edit, once by silently deleting
`claimDue`'s attempt-count backstop while its author was three files away.
Reviewers never mutate the primary feature worktree; give each one
`git worktree add`, or make it read-only and have it write experiments up for
somebody else to run.

**Agents that share PostgreSQL are serialised or given separate databases.**
The integration suite truncates tables between tests. Two suites against one
database produced 122 false failures that looked exactly like real ones.

**A fix is reviewed as hard as the bug.** On the deployment branch the
readiness parser was rewritten three times, and the first two rewrites each
INVERTED the behaviour they were written to protect — the second preferred a
dead container over a healthy one, the third preferred a running one-off
reporting `starting` over the healthy container beside it. Three separate fixes
told the operator to run a command that could not work, each introduced by the
commit that removed the previous one. Reviewing a diff for "does it fix the
bug" catches none of this. Ask instead: what does this fix now do that it did
not do before, and in which state is that wrong?

**A rule with no test is a rule that will be silently reverted.** Five
production rules changed in one commit there had no test at all, so the suite
could not distinguish three successive versions of the same function — every
inversion above passed a green suite. Mutation is the only check that finds
this: revert the single rule a test names and watch that test fail. A test that
stays green under mutation is not a test.

**A claim about testing that leaves no test behind is worse than no claim.** A
commit message on that branch cited eleven parser shapes and twelve guard
probes. Both sets had been run and thrown away, so the next reader believed a
coverage that did not exist. Commit the probe or do not cite it.

**Before any commit that follows agent work**, run `git status`, read every
line of `git diff`, and confirm no reviewer mutation is still in the tree —
deletions especially, because an added line is conspicuous and a removed
predicate is not.

## Git

Work on the session's task branch. **Never push implementation directly to
`main`**, and never force-push anything.

`main` moves only through a pull request that the owner has explicitly approved
after review, with CI green on the exact reviewed head. Phase 1 was merged that
way — reviewed to a clean round, then merged as a merge commit on the owner's
instruction, so the reviewed history stays reachable.

So: normal feature work happens on a branch and reaches `main` through a PR.
Merging one is the owner's call, never a step you take because the work looks
finished. Absent that explicit approval, leave the PR open and say it is
ready.
