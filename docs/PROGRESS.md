# Progress

Where the build actually is. Updated when a phase's state changes — not a plan,
a record.

---

## Phase 0 — Foundation and frozen contracts

**Status: complete.** Branch `claude/nexa-bot-phase-0-xpc0rr`.

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

## Phase 1 — Identity, tenancy, admins, RBAC

**Status: not started.** Blocked on nothing technical; see
`docs/open-questions.md` for the product decisions it needs, most importantly
`UNK-ADM-004` (is an admin global or scoped per bot) and the authentication
model in ADR-0009, which is deliberately left open.

---

## Phases 2–8

Not started. Scope in `docs/architecture.md`.
