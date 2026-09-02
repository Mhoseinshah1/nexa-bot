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

**Status: complete.** Branch `feat/identity-rbac`.

### What exists

| Area           | State                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema         | 7 tables in migrations 0005–0007, with composite `(tenant_id, id)` foreign keys so the database rejects cross-tenant relationships: `admins`, `roles`, `role_permissions`, `admin_roles`, `admin_permission_overrides`, `admin_sessions`, `admin_login_throttle` |
| Authentication | Username and password, scrypt at the OWASP minimum from Node's own crypto, self-describing hashes with rehash-on-login, one generic failure for every bad credential                                                                                             |
| Sessions       | 32 random bytes stored only as SHA-256, httpOnly `SameSite=Strict` cookie plus bearer, permissions resolved per request so a role change lands immediately                                                                                                       |
| Throttling     | Durable per-username and per-IP lockout driven by the `Clock` port, keyed on what was submitted rather than on a resolved account                                                                                                                                |
| RBAC           | Roles as tenant-scoped editable data seeded from the frozen `ROLE_SEEDS`, `GRANT`/`DENY` overrides with expiry, `(roles ∪ GRANT) − DENY` resolved per request, deny by default                                                                                   |
| Owner safety   | No self-modification of roles or status, last-active-owner protection under a tenant row lock, owner-role changes gated on `admins.permissions.edit`, deferred triggers as a backstop                                                                            |
| Bootstrap      | `pnpm admin:bootstrap`, CLI-only, refuses once any admin exists, password from stdin, fenced from surfaces by a boundary check                                                                                                                                   |
| Surfaces       | `/auth/login`, `/auth/session`, `/auth/logout`, `/auth/password`, `/admins`, `/admins/:id/status`, `/admins/:id/roles`, `/roles` — plus security headers and an Origin check                                                                                     |
| Telegram seam  | `admins.telegram_user_id`, and the webhook route now names the bot instance so update identity is `(bot_instance_id, update_id)`                                                                                                                                 |
| Web admin      | Real sign-in against the real endpoint, session display, admin list drawn only when the session carries `admins.view`                                                                                                                                            |

### Verification

| Check                   | Result         |
| ----------------------- | -------------- |
| `pnpm typecheck`        | pass           |
| `pnpm lint`             | pass           |
| `pnpm format:check`     | pass           |
| `pnpm check:boundaries` | 14 checks pass |
| `pnpm check:i18n`       | 3 checks pass  |
| `pnpm test` (unit)      | 112 passed     |
| `pnpm test:integration` | 139 passed     |
| `pnpm db:check` (drift) | pass           |
| `pnpm build`            | pass           |

### Decisions taken

- **ADR-0013** — username and password, not the Telegram Login Widget. It would
  make Telegram an availability dependency of fixing Telegram, and account
  recovery would stop being something an operator can do locally.
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
- **The cache-control header matched nothing.** It was conditioned on
  `request.url.startsWith('/api/')`, and the raw URL seen in middleware is
  prefix-stripped by the mount — so the header was absent from exactly the
  responses it was written for. Now unconditional; this process serves JSON and
  nothing else.
- **`describeSession` extracted.** The session endpoint assembled a permission
  list in the controller, which meant the new "no surface resolves permissions"
  boundary check needed a per-file exception. Removing the reason for the
  exception was better than writing one.

### Security review

An independent review of the branch ran before the phase closed. It confirmed
clean: the session path (expiry and revocation both enforced, verified
empirically), the Origin/CSRF check on every cookie-reachable write, permission
resolution (no actor type or scope returns a full set), tenant scoping in every
identity repository, the last-owner lock, the bootstrap fence, the Telegram
webhook, credential leakage, and injection.

It found **one HIGH**, reproduced end-to-end, and raised one design question
that turned out to be the same hole from another direction. Both are fixed, each
with a regression test.

- **The self-modification guard was bypassable by re-casing an id.** It compared
  two strings with `===`. Postgres compares `uuid` values case-insensitively, so
  an upper-cased copy of the caller's own admin id looked like a different
  administrator to the guard and resolved back to the caller in every query
  afterwards — letting an admin rewrite their own roles and disable themselves
  through paths the service explicitly refuses. Fixed at the boundary
  (`uuidV7Schema` now canonicalises, which fixes the class) and again inside the
  transaction, where the guard re-runs against the id the database returned.
- **`admins.edit` implicitly conferred every assignable role's permissions.**
  Not reported as a finding — but the self-guard never stopped it, because a
  puppet account is somebody else: create an administrator with the `finance`
  role, set its password, sign in as it. An administrator may now not grant a
  permission they do not hold themselves. Removing a role stays exempt; taking
  authority away is not amplification. An owner holds the whole catalog, so this
  constrains only a delegated admin manager.

The first one is worth stating plainly: the guard was written, reviewed,
described in a commit message as load-bearing, and covered by a passing test —
and it did not work, because the test only ever exercised the canonical form. A
check that decides in the application about a row the database resolves is only
as good as the two agreeing on identity.

### Deliberately absent

No commerce, products, providers, payments, wallet, orders, reseller bots or
reseller admin scoping. No self-service password reset and no second factor —
recovery is another owner, or the bootstrap CLI against a database with no
administrators. Both are additive and both are recorded in ADR-0013.

---

## Phases 2–8

Not started. Scope in `docs/architecture.md`.
