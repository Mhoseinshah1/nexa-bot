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
| Secrets                  | AES-256-GCM envelope encryption with `keyId` for rotation, server-side masking, one redactor shared by the logger, the audit log and the ops log                                                                                                                                                               |
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

## Phases 2–8

Not started. Scope in `docs/architecture.md`.
