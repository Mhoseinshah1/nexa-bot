# Progress

Where the build actually is. Updated when a phase's state changes — not a plan,
a record.

---

## Phase 0 — Foundation and frozen contracts

**Status: complete and accepted.** Its history is the repository's initial
history on `main`; the task branch it was built on no longer exists.

### What exists

| Area                     | State                                                                                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace, toolchain, CI | pnpm workspaces, Node 22, TypeScript 6.0.2 pinned, ESM throughout, ESLint 10 flat config, Prettier, Vitest with unit and integration projects, GitHub Actions with three jobs                                                                                                                                  |
| `@nexa/contracts`        | Branded ids, `Money`, half-open `TimePeriod`, actor and scope contexts, 45-key permission catalog with 8 role seeds, 25 ledger reasons, event catalog and envelope, error taxonomy, metric registry, state-machine encoding and validator, `ProviderAdapter`, `PriceQuote`, template keys, cross-cutting ports |
| `@nexa/i18n`             | Shared Persian catalogue serving both server and web, raw template storage, declared placeholders, single money formatter                                                                                                                                                                                      |
| Persistence              | Drizzle over `node-postgres`, 5 checked-in SQL migrations, 8 foundation tables, CHECK constraints generated from contract enums, append-only triggers, `int8`→`bigint` type parser                                                                                                                             |
| Tenancy                  | Tenant separate from BotInstance, reseller sub-tenant modelled, repository guard, explicit `SystemContext`                                                                                                                                                                                                     |
| Eventing                 | Transactional outbox, relay with `FOR UPDATE SKIP LOCKED`, per-aggregate sequencing, at-least-once delivery with effectively-once consumer effects, correlation id as a column                                                                                                                                 |
| Idempotency              | Durable store, replay returns the first result, payload mismatch rejected, per-scope keys                                                                                                                                                                                                                      |
| Audit and ops log        | Separate models, both with real producers, database-enforced immutability                                                                                                                                                                                                                                      |
| Access                   | Deny-by-default guard with no actor-type bypass, DENY-wins override resolution, denials audited and recorded as `WARN` operational events                                                                                                                                                                      |
| Secrets                  | AES-256-GCM envelope encryption, with `keyId` RECORDED against each row for a future rotation that v1 cannot yet perform (see BLOCKER-SECRETS-V2), server-side masking, one redactor shared by the logger, the audit log and the ops log                                                                       |
| Surfaces                 | `api` and `worker` entrypoints over one module graph, health live/ready/info, Telegram webhook receiver behind a secret token, React RTL admin shell rendering live readiness                                                                                                                                  |
| Docs                     | Architecture, conventions, glossary, open questions, 12 ADRs, 92 sanitized research files                                                                                                                                                                                                                      |
| Claude config            | SessionStart hook, 2 skills, 2 agents, permission allowlist                                                                                                                                                                                                                                                    |

### Verification

| Check                   | Result                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`        | pass                                                                                                            |
| `pnpm lint`             | pass                                                                                                            |
| `pnpm format:check`     | pass                                                                                                            |
| `pnpm check:boundaries` | 11 checks pass                                                                                                  |
| `pnpm check:i18n`       | 3 checks pass                                                                                                   |
| `pnpm test` (unit)      | 83 passed                                                                                                       |
| `pnpm test:integration` | 62 passed                                                                                                       |
| `pnpm db:check` (drift) | pass                                                                                                            |
| `pnpm build`            | pass                                                                                                            |
| Runtime smoke           | api and worker started from `dist`, full write path exercised through HTTP, relay published, consumer projected |

The Phase 0 exit criterion — a write path running authenticate → authorize →
validate → idempotency → transaction with audit and outbox → relay → consumer,
under a tenant context — is covered by
`tests/integration/write-path.test.ts`.

### Deliberately absent

No purchases, orders, payments, wallet, receipts, refunds, cashback, discounts,
pricing engine, catalog, provider adapters, resellers, broadcasts, reporting,
backups, `botctl`, installer, or authentication. Those are Phases 1–8; see
`docs/architecture.md`.

### Security review

An independent review of the whole foundation ran before the phase closed. It
found **two HIGH, six MEDIUM and eleven LOW** issues. All HIGH and MEDIUM
findings are fixed, along with nine of the LOW ones; each fix carries a
regression test.

The two HIGH findings were both design errors of mine, not oversights:

- **`SYSTEM_JOB` was a permission bypass.** The guard returned early for the
  actor type on the reasoning that background work is our own code — which
  stopped being true the moment an HTTP surface constructed a `SYSTEM_JOB` actor
  for an anonymous caller. Deny-by-default now applies to every actor type;
  jobs hold an explicit `SYSTEM_JOB_PERMISSIONS` set instead.
- **Idempotency keys shared one namespace across surfaces.** Both the HTTP
  endpoint and the Telegram webhook ran under a system scope, so an
  unauthenticated caller could pre-claim `telegram:update:<n>` — guessable,
  because update ids are sequential — and either silently suppress a real update
  or wedge the webhook into a retry loop. Keys are now namespaced per surface.

Notable MEDIUM fixes: the redactor did not traverse arrays (so a credential in a
list reached the audit log in cleartext) and could not assess a non-ASCII key;
`operational_events.dedupe_key` was globally unique, so two tenants collapsed
onto one row and overwrote each other's context — a cross-tenant write no
repository predicate could catch; `/health/ready` returned raw driver messages
to unauthenticated callers; and the error filter suppressed internal messages by
exception class rather than by status, so a framework 500 leaked its message.

The review confirmed clean: envelope encryption, the bot-token path, tenant
isolation in the repositories, SQL injection (none — one `sql.raw`, hardened
anyway), the `AUTH_MODE=none` production guard, the sanitized research corpus,
and the committed CI key (32 zero bytes, read by nothing).

**Deferred, with reasons:** no rate limiting or security headers yet — the HIGH-1
fix removes the exposure that made it urgent, and a throttler is Phase 1 work
alongside real authentication. GitHub Action versions are floating tags rather
than pinned SHAs.

### Decisions taken against the architecture review

Both raised explicitly and recorded, not silent:

- **ADR-0004** — application-level tenant scoping without Postgres RLS, against
  the review's ADR-004. Owner's decision; cost and revisit trigger documented.
- **ADR-0011** — Telegram backup delivery retained as a requirement, against the
  review's ADR-013. Owner's decision; accepted risk and the compensating
  controls the Phase 8 design must carry are documented.

### Corrections made during the build

Worth recording because each contradicted an earlier stated plan:

- **ESM, not CommonJS.** The plan chose CJS for decorator ergonomics. NestJS 12
  ships ESM only and the CJS build fails at `tsc` on every `@nestjs/*` import.
  ADR-0012 records the reversal.
- **The ledger vocabulary has 25 reasons, not 24.** The architecture review calls
  it "the 24-value enum" while its own verbatim list enumerates 25. The list is
  authoritative; recorded as `C-LEDGER-COUNT` in `docs/open-questions.md`.
- **`callback_refs` removed.** Created in migration 0000 with nothing reading or
  writing it — the placeholder infrastructure this project set out to avoid.
  Removed by forward migration 0002 rather than by editing 0000. The decision it
  encoded (Telegram's 64-byte `callback_data` cap) still stands, and the id
  generator and schema for it remain.
- **`SYSTEM_JOB` no longer bypasses authorization.** The guard's premise that
  background work is trusted by construction was false, and the code comment
  asserting it was wrong. See the security review section above.
- **Migrations no longer load application configuration.** The runner required
  `SECRETS_KEK`, which broke CI and would have broken an installer or a restore.
  It now needs only `DATABASE_URL`, guarded by a CI step that unsets the key.

---

## Phase 1 — Identity, authentication, admins, RBAC

**Status: complete, reviewed and merged into `main`.** Merge commit
`d8fa2530e00b8548faa532aa071486e6a74be825`, a merge commit rather than a squash
so the reviewed history stays reachable; the reviewed head was
`14e645a2092e2cdd0e1a3c9f675a69edb947ea3e`.

### What exists

| Area           | State                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema         | 7 tables in migrations 0005–0007, with composite `(tenant_id, id)` foreign keys so the database rejects cross-tenant relationships: `admins`, `roles`, `role_permissions`, `admin_roles`, `admin_permission_overrides`, `admin_sessions`, `admin_login_throttle`                  |
| Retention      | Migrations 0008–0009 add the indexes the sweepers and the outbox relay need. Without them a large enough backlog turned a slow query into a failing one once statement timeouts were introduced                                                                                   |
| Authentication | Username and password, scrypt at the OWASP minimum from Node's own crypto, self-describing hashes with rehash-on-login, one generic failure for every bad credential — unknown username, wrong password, disabled account and stopped tenant are indistinguishable, in timing too |
| Sessions       | 32 random bytes stored only as SHA-256. **Cookie-only**: `httpOnly; SameSite=Strict`, `__Host-` prefixed in production. `Authorization: Bearer` is **not accepted** — nothing can obtain a token to present, so the header would be a way in no legitimate client can use         |
| Throttling     | Durable per-username and per-IP lockout driven by the `Clock` port, keyed on what was submitted rather than on a resolved account. Login and `changeOwnPassword` share one counter per subject, so neither endpoint is a way around the other's lockout                           |
| Concurrency    | The tenant row is the serialization boundary: mutations take `FOR UPDATE`, login and the relay `FOR SHARE`. Waits are bounded by explicit `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` — Postgres defaults all three to "wait forever"           |
| RBAC           | Roles as tenant-scoped editable data seeded from the frozen `ROLE_SEEDS`, `GRANT`/`DENY` overrides with expiry, `(roles ∪ GRANT) − DENY` resolved per request, deny by default                                                                                                    |
| Owner safety   | No self-modification of roles or status, last-active-owner protection under a tenant row lock, owner-role and owner-status changes gated on `admins.permissions.edit`, no granting a permission the actor does not hold — including by re-enabling an account                     |
| Bootstrap      | `pnpm admin:bootstrap`, CLI-only, refuses once any admin exists (re-checked under the tenant lock inside the creating transaction), password read from stdin with terminal echo off and confirmed, fenced from surfaces by a boundary check                                       |
| Surfaces       | `/auth/login`, `/auth/session`, `/auth/logout`, `/auth/password`, `/admins`, `/admins/:id/status`, `/admins/:id/roles`, `/roles` — plus security headers and an Origin check on every state-changing request                                                                      |
| Telegram seam  | `admins.telegram_user_id`, and the webhook route names the bot instance so update identity is `(bot_instance_id, update_id)`                                                                                                                                                      |
| Web admin      | Real sign-in against the real endpoint, session display, admin list drawn only when the session carries `admins.view`                                                                                                                                                             |

### Verification

Measured on the merged state, not on an intermediate commit.

| Check                   | Result         |
| ----------------------- | -------------- |
| `pnpm typecheck`        | pass           |
| `pnpm lint`             | pass           |
| `pnpm format:check`     | pass           |
| `pnpm check:boundaries` | 15 checks pass |
| `pnpm check:i18n`       | 3 checks pass  |
| `pnpm test` (unit)      | 185 passed     |
| `pnpm test:integration` | 297 passed     |
| `pnpm db:check` (drift) | pass           |
| `pnpm build`            | pass           |

`pnpm verify` also runs `format:check`. It did not for most of the phase, while
CI did — so the gate this file and `CLAUDE.md` both call "the gate" was weaker
than the one that actually blocked the branch, and it cost a red CI on
formatting alone.

### Decisions taken

- **ADR-0013** — username and password, not the Telegram Login Widget. It would
  make Telegram an availability dependency of fixing Telegram, and account
  recovery would stop being something an operator can do locally. Also records
  cookie-only sessions, the trusted-proxy model, compare-and-set rotation, the
  tenant kill switch, the measured cost of the locks, and what the mandatory
  production reverse proxy must set.
- **ADR-0014** — roles are tenant-scoped editable data; administrators belong to
  the tenant, not to a bot instance, because that scope can be narrowed later
  and a wrong one cannot be removed.
- **ADR-0015** — trial allowance semantics recorded as product policy and
  deliberately **not** implemented. A `trial_allowance` table with no producer
  would be the placeholder pattern this codebase exists to avoid.

### Corrections made during the build

- **scrypt, not Argon2id.** Argon2id is the first recommendation. Every Node
  binding for it is a native build or a single-maintainer prebuilt binary, and
  neither belongs on the path between an operator and their own admin panel.
  The stored hash names its algorithm, so the choice is reversible without a
  migration.
- **Bearer tokens removed entirely.** An earlier version returned the session
  token in the login body and accepted `Authorization: Bearer`, which handed
  that credential to every script on the admin page. Removing it from the body
  also made bearer a path no legitimate client could obtain a credential for.
- **The cache-control header matched nothing.** It was conditioned on
  `request.url.startsWith('/api/')`, and the raw URL seen in middleware is
  prefix-stripped by the mount — so the header was absent from exactly the
  responses it was written for.
- **Role seeds became creation defaults.** Reasserting them at boot restored
  permissions an operator had deliberately withdrawn. Failing to extend a role
  is visible; silently handing authority back is not.

### Review

Four independent security reviews ran first, each on the previous one's output.
The first reproduced a **HIGH**: the self-modification guard compared ids with
`===` while Postgres compares `uuid` case-insensitively, so an upper-cased copy
of the caller's own id looked like a different administrator to the guard and
resolved back to the caller in every query afterwards. Fixed at the boundary
and again inside the transaction.

Then **twenty-one rounds of automated review (Codex)**, each against a green
head. **Round 21 came back clean.** Ninety findings across the rounds, **none
rejected — every one a real defect**. Severity fell from P1s in the first two
rounds to P2 only from round 3, and the count fell 6, 5, 5, 2, 0 across the
last five.

The dominant family, which took five rounds to exhaust, was a check that held
when it ran but not through the write it authorised. Login, all three
administrator mutations, password rotation, the webhook write and the outbox
relay now each hold their status under a lock for the duration.

Two things worth recording rather than smoothing over:

- **The last six rounds found nothing in the original Phase 1 work.** Identity,
  authorization and concurrency were quiet from round 14 onward. Everything
  after that was in two components introduced late — a shared credential
  throttle and a hand-rolled terminal reader — each corrected several times
  before settling. Work added at the end of a cycle was measurably the least
  reliable work in it.
- **`pnpm admin:bootstrap` with piped input created no owner and exited 0.**
  Found by running the CLI rather than trusting the unit tests beside it:
  readline buffered ahead and swallowed the password line. That is the legacy
  system's "returns success and writes nothing", reproduced here — and it
  predated the phase's password work rather than being caused by it.

Every fix carries a regression test verified to fail against the pre-fix code,
with the few exceptions stated on the pull request where that was not possible
or not safe.

### Deliberately absent

No commerce, products, providers, payments, wallet, orders, reseller bots or
reseller admin scoping. No self-service password reset and no second factor —
recovery is another owner, or the bootstrap CLI against a database with no
administrators. Both are additive and both are recorded in ADR-0013.

### Deferred hardening

Recorded so they are decisions rather than oversights:

- **A process-wide KDF admission limiter.** The login throttle reserves before
  it hashes, so a burst is refused before it queues work — but that is a
  per-subject bound, not a global one, and enough distinct subjects can still
  saturate the crypto pool. A semaphore or admission queue in front of scrypt
  changes runtime capacity and denial-of-service behaviour, so it needs its own
  measurement and design rather than being bolted on. `UV_THREADPOOL_SIZE` is
  deliberately left alone for the same reason.
- **Security headers on the SPA document.** A CSP on an API JSON response does
  not govern the document that loaded the app, and nothing in this repository
  serves `index.html`. ADR-0013 names what the production reverse proxy must
  set instead.
- **The write cost of the retention indexes.** Migrations 0008–0009 add three
  indexes to tables written on every login, every failed login and every domain
  event. The read side of all three is measured; the write side is not.

## Phase 2 — The control plane

**Status: complete, pending review.** Built on `feat/phase2-control-plane`.

Templates, settings, feature flags, notifications and a read model over the
operational log. No product features: nothing here buys, charges, provisions or
messages a customer.

### What exists

| Area               | State                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Templates          | Raw bodies, per-key format and placeholder declarations, one shared validator, tenant overrides with optimistic versions, append-only revisions, revert-by-removal, preview that stores nothing                                            |
| Settings           | A typed registry of six keys — schema, default, mutability, classification, and a mandatory declaration of what `0` or empty means. Reads return the value, its resolved source and that declaration. Unknown keys fail closed everywhere. |
| Feature flags      | A separate registry of two boolean flags, each naming the settings it parameterises, checked symmetric by a test. `TENANT_WIDE` toggles require a typed confirmation and a reason.                                                         |
| Notifications      | Intent and delivery attempt as two tables; a dispatcher that claims with `FOR UPDATE SKIP LOCKED`, sends outside every transaction, and records what happened; a real Telegram transport honouring `retry_after`                           |
| Operational events | The recorder now reports whether it opened a condition or repeated one; recovery links rather than deletes; a filtered read model behind `opslog.view`                                                                                     |
| Surfaces           | One HTTP controller and five Web Admin screens, all drawing from the session's permissions and all re-checked server-side                                                                                                                  |
| Migrations         | 0010 (six tables, two columns, one partial index) and 0011 (append-only triggers, the extended immutability guard, one backfill)                                                                                                           |

### What was found rather than built

Five things went in wrong first. They are listed because the commits that fixed
them are the useful part of this phase's history.

- **The retention sweep could not exist.** ADR-0020 was drafted saying
  operational events would be swept on a configurable window, and a setting and
  a feature flag were written to configure it. `operational_events` carries a
  `BEFORE DELETE` trigger from migration 0001. The guard did not move; the
  setting and the flag were removed and the unbounded-growth question is
  recorded as a DECISION in `docs/open-questions.md`.
- **The notification dispatcher could not be an outbox consumer.** The relay
  runs consumers INSIDE its claim transaction, so a consumer that sent would
  hold a transaction open across a Telegram call. The `NotificationQueued` event
  was removed and the dispatcher became a poller.
- **A re-entrancy flag was not concurrency-safe.** The projector guarded against
  the settings resolver's own error reporting looping back into it with a
  boolean; two events arriving together would find it set and the second would
  be recorded and never announced. The cycle is now removed structurally.
- **A lock on a row that does not exist locks nothing.** The operational-event
  dedupe path used `SELECT ... FOR UPDATE` before inserting, so two first
  reports of one condition both inserted and one died on the unique index. It
  surfaced as an unexplained login failure.
- **Drizzle cannot round-trip a JSON string through `jsonb`.** `pg` parses the
  column and `mapFromDriverValue` parses it again, so a stored `"-1001234567890"`
  came back as a number, failed its own schema, and the resolver fell back to
  the default — while the API answered 201. Every string-valued setting was
  affected. Both directions are now explicit in the repository.

### Deliberately absent

No customer-facing notifications, because the things they would notify about do
not exist. No retention or archival for operational events (above). No bulk
operation, so ADR-0010's dry-run and counted-preview steps have nothing to apply
to yet. No second locale, though overrides are keyed by one from the first
migration.

**No retention or archive for notifications either**, and it is worth saying
separately because the tables are the ones that grow fastest. A notification
intent is never deleted and a delivery attempt is append-only evidence — the
question a stuck notification provokes is "what did the third attempt fail
with", and a row removed on a schedule cannot answer it. So both tables grow
without bound on a long-lived installation. That is an accepted Phase 2
tradeoff, not an oversight: no duration is invented here, and ADR-0018 lists
what a future policy must decide (archival, duration, evidence and history,
referential integrity, storage bounds, and any change to the append-only rule).

### Not deployable, and two things block Phase 3

The secret envelope is still v1: ciphertext is not bound to its context, and a
single configured KEK means rotation cannot decrypt what the previous key
wrote. That is `BLOCKER-SECRETS-V2` in `docs/open-questions.md` and must land
before Phase 3 introduces provider credentials.

`BLOCKER-DEPLOY` is closed by the checkpoint below.

### Deferred

- **Keyset pagination on the operational log and the notification list.** Both
  take a limit and the log takes a `before` cursor, but neither surface pages
  yet. The index that would serve it exists.
- **The rate ceiling is read from the primary tenant.** The dispatcher is
  installation-wide and the setting is tenant-scoped. One install serves one
  customer (ADR-0001), so this is right today and explicitly wrong the day an
  installation serves several tenants at volume.

## Deployment / Installer MVP — done, and never run for real

The checkpoint between Phase 2 and Phase 3. It exists because nothing in this
repository deployed: the legacy product is installed by pasting a shell
one-liner that clones a repository and runs it in place, so the running version
is whatever `git pull` last produced and an update cannot be undone.

**What it delivers.** One immutable image with the base pinned by digest, four
process roles selected by command, and a Web Admin bundle copied out to the
edge. A production Compose topology in `deploy/` where Caddy is the only
container publishing a host port and the database is on a network the edge is
not attached to. An idempotent Ubuntu installer that preflights everything
before it writes anything, installs Docker from a signed apt repository, and
generates its secrets exactly once. `botctl` with status, version, backup,
update and rollback.

**Update** holds an exclusive lock, resolves a version to a digest once, pulls
by that digest, backs up, migrates using the _target_ release's own compiled
migrator, waits for a real readiness check, and only then writes the
current-release pointer. Every failure before that leaves the previous release
running. **Rollback** switches the application image back and does not restore
the database — the backup predates the migration, so restoring it would turn an
outage into data loss.

`provision-installation` was added because a fresh production install could not
create an owner at all: the only code that had ever created a tenant was the
development seed, and `bootstrap-owner` refuses without one.

**It has never been run against a real server.** CI builds the image, brings
the stack up, migrates, serves the panel through the edge, backs up, and drives
update → failed-health back-out → rollback against a local registry. It cannot
issue a certificate, reboot a host, or prove DNS points anywhere.
`docs/vps-acceptance.md` is the checklist that decides whether this model can
carry a customer, and nothing here claims it has passed.

### Deliberately not done

- **No backup rotation.** Dumps accumulate; retention is an operator decision
  and no duration is invented, exactly as for the notification tables.
- **No secret rotation procedure.** Rotating the database password or the KEK
  on a live installation is unsupported; the KEK half belongs to
  `BLOCKER-SECRETS-V2`.
- **No Redis persistence.** Redis stores nothing through Phase 2, so a volume
  would persist an empty dataset and imply a guarantee nothing relies on. The
  compose file says where that has to be revisited.

## Phase 3 — Providers, panels and health

Three slices, of which two are merged and the third is this branch.

### What exists

**3A — providers, panels, credentials, health.** A provider type is code rather
than a row: the adapter is resolved before the panel is written, so a panel
nobody can operate never becomes one. A panel's credential travels one way — the
repository projection selects three set-at timestamps and never a ciphertext, so
no response builder can acquire a value, and there is deliberately no masked
stand-in either, because `********` can be resubmitted as a real password.
Health is latest state only; `DISABLED` and `UNCHECKED` are projected rather
than stored, and a probe result changes health and nothing else. Outbound
requests go through `SafeHttpClient`, which refuses only destinations that are
never a panel, never follows a redirect, and pins the socket to a
pre-validated address — which is why it is written on `node:http` rather than
`fetch`.

**3B — the MHSanaei/3x-ui v3.7.0 adapter.** Bearer token when one is
configured, session cookie and CSRF otherwise, and a wrong token does not fall
back to a username and password. Verified against a deterministic real-socket
fake server rather than a mocked client.

**3C — the monitor process role (this branch).** A third entrypoint over the
same module graph keeps panel health current on a schedule. Discovery is two
bounded index range scans — a rotation claim over tenants, then one `LATERAL`
per claimed tenant — so a tick's work does not grow with the due population,
measured with `EXPLAIN (ANALYZE, BUFFERS)` rather than argued. Scheduling state
lives in its own table, separate from health, which is what lets a panel with no
usable credential be deferred without inventing a provider state it never
reported. Authorization precedes every side effect. Liveness is progress, not
uptime.

### What was found rather than built

The two-phase scan replaced a `row_number()` ranking that returned a bounded
number of rows while doing work proportional to every due panel. `LIMIT 50` in
the SQL is not a bound on the database's work, and reading fifty rows back in a
test does not measure one. Two further design changes — dropping a `panels`
join that made the planner abandon the bounded path, and adding `panel_id` as
the index's third column so a tie group is not sorted — came out of the
measurement rather than out of reasoning about it.

Falsification found one test that could not reach the code it named: it drove a
back-dated probe, which the per-panel claim refuses long before the rule under
test runs. Rewriting it as the interleaving that actually happens showed the
guard was in the wrong place, so a result the storage had refused still rewrote
the panel's schedule.

One defect outside Phase 3 was found and fixed on the way: an operational-event
recovery resolved open rows by `(scope, code)` across a whole tenant, so
repairing one setting resolved every other setting's open complaint.

### Deliberately absent

Nothing consumes a panel yet. There are no purchases, payments, wallet,
resellers or customer-facing Telegram operations, and no product feature reads a
panel's health.

## Phase 3D — the production Web Admin V2

On a branch, in review. The approved V2 design as the real Web Admin: panels,
providers, settings, feature flags, templates, notifications, management
alerts, system status and administrators, against the production APIs and the
real authorization model.

The rule the phase is built around is that **no screen asserts a capability the
server does not have**, and most of the branch's history is the discovery that
earlier versions of it were not honest enough. Nine navigation entries lead to
a page that says what is missing and draws no control at all — not a disabled
button, which would assert "this exists and you lack permission", and not a
greyed sample table, which would assert "here is your data".

Two independent reviews found the same class of defect the phase exists to
prevent, in the phase's own work:

- The management-alerts scope declared ten codes, four of which nothing could
  ever surface — two never recorded as operational events at all, and two
  recorded under `SYSTEM_SCOPE` with a null tenant where the tenant-scoped
  reader cannot reach them. An `admin.` PREFIX matched the audit log's `action`
  vocabulary rather than any event code, so the owner revision it was there to
  satisfy was claimed and not delivered. Every test over the classification had
  invented its own codes, so none of it was visible.
- The dashboard's "needs attention" card filled permanently with permission
  denials: a fresh row per denial, no dedupe key, no recovery, and no "mark as
  seen" by design. The scope is now split, and that card carries only
  conditions something closes.
- The one write control on the surface drawn without consulting the caller's
  permission was also the one that WROTE on refusal — an audit `DENIED` row and
  an unresolvable alert per press.

Three defects were reachable only in production: `style-src 'self'` blocks
element `style` attributes, so four components rendered wrongly under the
deployed policy while jsdom, the build and every test stayed green; an
ambiguous 5xx retired an idempotency key, so a proxy timeout on a test-send
would queue a second Telegram message; and notification history had no
continuation past its first page.

### What this phase changed about how the work is checked

Three regression tests could not fail when first written, and each is recorded
rather than quietly repaired: a cursor test passed twice with the tie-break
reverted, because intents queued normally get distinct timestamps and both
implementations walk those correctly; a CSP test asserted on a card header that
renders while the query is still in flight, so it photographed a skeleton; and
a permission test looped over elements that do not exist without the
permission.

`scripts/visual/` is committed because a commit message cited a 69-capture
visual pass and left no probe behind. It writes its summary beside the captures
it describes, after a `verification.json` from an earlier run was found on disk
looking current — the numbers from a stale file were very nearly reported as a
clean pass.

### Deliberately absent

No Phase 4 Telegram runtime. No purchases, payments, wallet, resellers, orders,
products, discounts or reports — the nine planned pages describe them and
implement none of them. Owner revision 24's per-gateway minimum top-up is
BLOCKED, not deferred: no gateway registry exists for an override to be keyed
by, and ADR-0024 records that rather than inventing one.

## Telegram Backup V1 — done

The disaster-recovery pipeline. ADR-0025 records the design; `docs/backup.md` is
the operational half.

Six stages, in an order that IS the guarantee — `DUMP → CHECKSUM → ENCRYPT →
VERIFY_RESTORE → DELIVER → CLEANUP`, with `DELIVER` reachable only from a
verification that passed. Every run this system calls successful has been
decrypted through the operator's own restore path and restored into a real,
empty PostgreSQL database that then had tables in it.

The dump is the whole database with nothing excluded, and the manifest carries
an `exclusions` array so that any future exclusion has to justify itself inside
the artifact. The checksum is SHA-256 over the plaintext dump, which is what
makes it verifiable years later by anyone holding the key and the manifest.

A new streaming archive format, because `SecretCipher` was inspected and cannot
carry a dump: its port takes a string, its `'utf8'` decode corrupts binary
(a 64-byte gzip buffer round-trips to 96), its `base64url` envelope throws above
~384 MiB, and it holds three copies of the payload in memory. Everything that
makes it trustworthy is reused — the keyring, the wrapped per-archive data key,
AES-256-GCM, the associated-data discipline. No new cryptography.

One backup at a time, enforced by a partial unique index rather than by any
process, because two worker replicas is normal on every rolling update. The
claim is a lease; a stale one is taken over by FAILING the abandoned run, never
by adopting it.

Delivery carries three outcomes on its own enum. `OUTCOME_UNKNOWN` is the one
the codebase did not previously have and the reason a durable run row exists:
Telegram can reject a request whose upload it accepted, so nothing resends on an
outcome nobody observed.

### What the falsification run changed

Four rules had no test, and two comments claimed guarantees the code did not
have. `docs/backup-falsification.md` carries all of it. The archive's docblock
said the header is bound by the payload's associated data; removing that binding
left every test green, because the key-unwrap AAD binds it too — two redundant
mechanisms, and the claim was corrected to match. A comment said a second
decrypt path prevented a tautological verification; it does not, and now says
what it actually buys. Four further rules are recorded as NOT falsifiable, with
the reason, rather than as claims.

### Deliberately absent

ADR-0011 asked for seven compensating controls; five are satisfied and two are
not, stated rather than implied. There is **no off-server copy** — the archive
sits on the same host as the database it protects. And there is **no retention
anywhere**: nothing prunes `BACKUP_WORK_DIR` and nothing deletes an old document
from the Telegram channel. Those two are the next backup work.

No automatic reconciliation of an `OUTCOME_UNKNOWN` delivery, on purpose.

## Web Admin Disaster Recovery — done

One OPERATIONAL section — **بکاپ و بازیابی** under **سامانه و عملیات** — plus the
backend that makes it real: an authorized administrator can read the backup
history, inspect a run, take a backup, download an ENCRYPTED archive, upload one,
have it verified and restore-tested against real PostgreSQL, and then, behind a
CRITICAL permission and a typed phrase bound to that artifact's checksum, restore
the whole installation. ADR-0028 records the design; `docs/backup.md` is the
operator's account of it.

### The rule the whole design is arranged around

**No HTTP request ever restores into the database serving it.** A request can
upload, verify and confirm; a separate process role — `main.recovery.ts`, the
fourth — does the destructive work, claims it with a durable lease, and survives
the browser, the API and itself being restarted, because every step is state on a
`recovery_requests` row rather than a step in a wizard.

### Cutover by rename

The candidate is restored into a NEW database, validated, and only then does
production change: `REVOKE CONNECT`, terminate other sessions, rename live to
`nexa_pre_restore_<id>`, rename the candidate into its place, `GRANT CONNECT` in
a `finally`. No configuration changes, the irreversible window is two metadata
statements rather than the length of a restore, and the outgoing database SURVIVES
under a recorded name — which makes a rollback two more renames instead of another
restore. Nothing drops it, ever, and `docs/backup.md` says so where an operator
looks for their disk.

It is survivable only because of the pool error listener Architecture Hardening
added: `pg` delivers connection death as an `'error'` EVENT, and an unlistened
`'error'` on an `EventEmitter` throws. ADR-0028 § 3 records that cross-file
dependency rather than leaving the next reader to rediscover it.

### Quiesce, derived rather than flagged

While a recovery holds the installation, durable writes are refused at the two
chokepoints every write actually passes — the unit of work and the outbox relay —
and the refusal is derived from the recovery row's own state, not from a second
flag that could disagree with it. Reads keep working: an operator supervising a
restore is reading. `PRE_RESTORE_BACKUP` is deliberately OUTSIDE the window,
because that stage has to write the backup that makes everything after it
recoverable.

### What the tests found

Three things the implementation claimed and did not do, each found by writing the
test the owner's matrix asked for rather than by reasoning:

1. **A confirmation never expired.** `confirmationExpiresAt` was written at
   confirm time, projected to the Web Admin, and read by nothing — so a request
   confirmed and abandoned could replace a production database an hour later. The
   executor now checks it once, as it claims the work.
2. **A manual backup succeeded during a restore.** The write gate refused the
   pipeline's individual writes one at a time, the operational-event recorder fell
   back to its degraded path, and the run still returned COMPLETED. The operator's
   path now refuses on arrival with `recovery.quiesced`; the gate stays the
   authority underneath it.
3. **Two failure codes and two stages had no producer.** `recovery.manifest_invalid`
   now names a real check — the payload must BE a `pg_dump` custom archive, which
   is the owner's "pg_dump-format validation" step and was missing — and
   `recovery.candidate_validation_failed` now names an inspection that could not
   run, which previously surfaced as the unclassified code in the one stage where
   an operator most needs to know production was never touched.

### Deliberately absent

**A foreign installation's archive cannot be restored**, and the Web Admin says
«پشتیبانی نمی‌شود» with the reason rather than omitting the control. The workaround
is to add that installation's KEK to `SECRETS_KEYS` out of band. There is no form
that accepts a pasted key and there will not be one; `docs/open-questions.md`
records why, and what a real key-import feature would have to carry.

**Nothing restarts the worker or the monitor after a cutover.** Their pools
recover, and a `botctl` restart is still the tidier operational choice.

**Nothing cleans up a displaced database, a candidate a refusal left, or a
successful upload's workspace.** Debris is reported on the row and in the
operational log; a recovery that removed its own evidence would be one nobody
could audit.

## Phases 4–8

Not started. Scope in `docs/architecture.md`.
