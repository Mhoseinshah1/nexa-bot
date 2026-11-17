# Nexa Bot — instructions for Codex

Tenant-aware Telegram service-sales platform: TypeScript, NestJS, React,
PostgreSQL 16, Redis and pnpm. One codebase runs several process roles.

## Authority and navigation

Read [CLAUDE.md](CLAUDE.md) before changing code; its project rules also apply
to Codex. [Project status and standing decisions](docs/project-status.md) and
[conventions](docs/conventions.md) are authoritative, not historical notes.
This file is an entry point, not a replacement specification. Apply the
documented exceptions in those sources rather than inventing new ones.

- Use [nexa-code-navigation](.agents/skills/nexa-code-navigation/SKILL.md)
  to locate the implementation. Search first; never read a file over 800 lines
  whole. Read bounded ranges; never open a migration snapshot wholesale.
- `docs/research/` is evidence, not specification. Retain confidence labels;
  `NOT_EXPOSED` means the UI did not show it. Never guess an `UNKNOWN` away;
  consult [open questions](docs/open-questions.md).
- All eleven project skills are shared from `.claude/skills/` through relative
  links in `.agents/skills/`. Read the relevant `SKILL.md` and its references
  before acting. Edit the source, never create an independent Codex copy.
- Client differences, role mappings and validation commands:
  [AI development compatibility](docs/ai-development.md).

## Architecture and implementation

- `packages/contracts` is the frozen specification: types, schemas, catalogs
  and ports. A new state, event, permission, ledger reason, metric or template
  key is a contract change: its own justified commit, never hidden in a feature.
- `packages/i18n` supplies the shared Persian catalogue. `apps/api` uses
  `modules/<plane>/<context>/{domain,application,infrastructure}`; dependencies
  point inward. Domain/application declare ports, infrastructure implements
  them, and HTTP/Telegram/gateway surfaces call application services, not SQL.
- `apps/web` is the React admin; `apps/miniapp` is the Telegram Mini App.
  The admin may import `@nexa/contracts` and `@nexa/i18n` only from workspace
  packages. Follow [nexa-web-design](.agents/skills/nexa-web-design/SKILL.md)
  for Persian RTL, tokens, accessibility, CSP, permissions and real API data.
- Use the repository's pinned Node/pnpm versions, lockfile and package scripts.
  TypeScript is strict; respect the existing ESM `.js` import conventions.
  NestJS controllers adapt requests; application services own business rules.
  React presentation must not introduce a second business or authorization path.
- API, worker, monitor, provisioner, recovery, assistant and migration have
  separate entrypoints. PostgreSQL owns durable state and the transactional
  outbox; Redis is not an alternative ledger or source of authorization.
  See [architecture](docs/architecture.md) and [deployment](docs/deployment.md).

## Isolation, authorization and the write path

Apply [nexa-conventions](.agents/skills/nexa-conventions/SKILL.md) and
[ADR-0037](docs/adr/0037-row-level-security.md):

- Tenant-owned tables have `tenant_id NOT NULL`; composite indexes lead with
  it. Repository methods require a tenant scope; system work uses an explicit
  `SystemContext` with a reason. Preserve RLS and the scoped application role;
  never bypass isolation with the owner connection in application code.
- Tenant ≠ BotInstance; Order ≠ Service; CustomerTier ≠ AdminRole. Payment,
  wallet, receipt, refund and cashback remain distinct concepts.
- Write paths authenticate an `ActorContext`, resolve scope, authorize through
  the guard, validate with zod, enforce idempotency, transact and project the
  persisted result. Deny by default for every actor, including `SYSTEM_JOB`;
  UI visibility is never authorization. Audit denials.
- Read `ScopeActivityReader` inside the business transaction and refuse new
  work for a stopped scope. Only the explicitly bounded exceptions in
  `docs/conventions.md` apply; refusal is not a terminal-state write.
- Every state-changing business command takes a surface-namespaced idempotency
  key. Replay returns the first result; a different payload on the same key
  fails. The documented self-authentication exceptions are not a general bypass.
- Domain changes, audit rows and outbox rows commit in one transaction. Audit
  records contain actor/action/result and before/after values. Domain events,
  audit records and operational events are separate lanes; preserve append-only
  protections and operational code identities. Never report a no-op as success.

## Money, payments, time and secrets

- `Money` is `bigint` minor units plus explicit currency; never floats or bare
  amounts. Balance comes from the append-only ledger, never a balance column.
  Render through `@nexa/i18n`; converted amounts retain their FX snapshot.
- Only provider inquiry/verify settles a gateway payment; callbacks are hints.
  Check deadlines under the payment lock. A lost create is never blindly retried
  or re-keyed; `UNKNOWN` is never refunded before a read reconciles it.
  Use [nexa-gateway-integration](.agents/skills/nexa-gateway-integration/SKILL.md)
  and the standing money rules; never add a parallel settlement/refund path.
- Timestamps are UTC `timestamptz` from the `Clock` port. Reporting windows are
  half-open `[start, end)`. Snapshot historical values when the transaction runs.
- Credentials use `SecretCipher`; no API response exposes one. Use the single
  redaction implementation before durable logs; pass error objects to the logger.
  Never print, commit or copy `.env`, tokens, passwords or production data into
  instructions, fixtures, PRs or handoffs. Check binding names/presence only.
- Customer-facing text uses contract template keys and the Persian catalogue;
  no surface literals. Imports, migrations and backfills send no customer message.

## Migrations and validation

Use [nexa-migrations](.agents/skills/nexa-migrations/SKILL.md): checked-in,
reviewed SQL, forward-only; never edit an applied migration. Destructive schema
changes use expand/contract across releases. `drizzle-kit push` is banned outside
a throwaway database. Rebuild contracts before renumbering; use the repository
renumber helper, verify byte-identical SQL, and run `pnpm db:check` plus affected
migration suites. Never hand-edit generated snapshots or the journal to hide drift.

Use [nexa-test-selection](.agents/skills/nexa-test-selection/SKILL.md) before
running checks and [nexa-log-digest](.agents/skills/nexa-log-digest/SKILL.md)
for output. Its non-money tiers permit focused checks for AI configuration-only
changes; do not repeat the expensive application suites without a relevant change.

```bash
bash .agents/skills/nexa-test-selection/scripts/select-tests.sh
bash scripts/claude/run-gate.sh pnpm typecheck
bash scripts/claude/run-gate.sh pnpm verify
```

`pnpm verify` is the standard gate; schema changes also need `pnpm db:check`.
For selected tests, use `pnpm exec vitest run --project <project> <files>`;
`pnpm test:integration -- <files>` does not narrow the suite. Integration tests
truncate data: use a private test database, both URL bindings set to it, and
serialize runs per database. Never test against production. Read
[CI](docs/ci.md): local checks do not replace green CI on the reviewed head.
Never skip, weaken or quarantine an assertion to obtain green results.

## Git, review and runtime capabilities

Follow [nexa-pr-workflow](.agents/skills/nexa-pr-workflow/SKILL.md) and
[nexa-ci-watch](.agents/skills/nexa-ci-watch/SKILL.md):

- Use a dedicated task branch and the existing isolated cloud checkout. Create
  a worktree only when the task or an applicable multi-agent workflow requires it.
- Never push implementation to `main` or force-push. Production deployments
  and release tags require the owner's explicit authorization. Open a PR when asked.
- Merge only with explicit owner approval, completed review and green CI on the
  exact reviewed head, as a merge commit. Otherwise leave the PR open.
- Read every line of the diff and `git status` before committing, especially
  after agent work. Exclude local helpers, secrets, logs and generated outputs.
- GitHub operations use the existing authentication and REST helpers, not
  GraphQL. Request and read the prescribed review; never substitute a self-review
  for an unavailable external security or code-review plugin.
- Claude agents, permissions, hooks and plugins are not imported by Codex.
  Use the native read-only role adapters when available, otherwise explicitly
  supply the original `.claude/agents/*.md` instructions to an available reviewer.
  For an explicitly invoked round, follow `nexa-round-pipeline`; finish/resume
  with `nexa-handoff`. Client tool names and model tiers require host mapping,
  not weaker project rules.
