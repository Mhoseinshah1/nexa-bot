---
name: nexa-migrations
description: How to write, generate, renumber and verify a database migration in this repository. Use whenever changing apps/api/src/infrastructure/persistence/schema.ts, adding anything under apps/api/drizzle, or resolving a migration-number collision between PRs.
---

# Migrations

Checked-in SQL, generated from the schema, reviewed like code, **forward-only**.
Read `references/migrations-detail.md` for the `when` stamp story, the
renumber script's behaviour and manual fallback, and the worked examples.

## The normal path

1. Edit `apps/api/src/infrastructure/persistence/schema.ts`.
2. `pnpm db:generate` — named: `pnpm --filter @nexa/api exec drizzle-kit generate --name add_wallet_entries`.
3. **Read the generated SQL.** It is the artifact under review.
4. `pnpm db:migrate`, then the affected integration files through
   `run-gate.sh --integration` (`nexa-test-selection`). Full suite: CI.
5. `pnpm db:check` must pass — it regenerates and fails on anything new.

## Rules

- **Never edit an applied migration.** Write a new one (forward-only, even
  when editing would be tidier).
- **`drizzle-kit push` is banned** outside a throwaway local database: it skips
  the migration files and the schema drifts from its history.
- **Destructive changes are expand/contract**, across two releases: add the
  new shape and backfill, remove the old one in the next. Never drop a column
  in the release that stops writing it.
- **Every status column gets a CHECK constraint** from the contract enum via
  `enumCheck()`. Never a free-text status.
- **Every tenant-owned table gets `tenant_id uuid NOT NULL`**; composite
  indexes lead with it. **Every timestamp is `timestamptz`.**
- **Never add a `balance` column.** Money columns are `bigint` minor units with
  a companion `currency` column.
- Append-only tables: `audit_logs` refuses UPDATE/DELETE; `operational_events`
  refuses DELETE and identity changes; `outbox_messages` freezes its content.
  Tests reset with `TRUNCATE`, which bypasses row triggers, on purpose.

## The journal's `when` IS the ordering

The migrator applies every journal entry whose `when` exceeds the greatest
`created_at` in `drizzle.__drizzle_migrations`. Registering a hand-written
migration, stamp `when` with the CURRENT time, never a future one (it makes the
next migration SKIP silently; `pnpm db:check` still passes):

    node -e 'console.log(Date.now())'

`tests/unit/migration-journal.test.ts` refuses a future or non-advancing stamp.
A bad applied stamp is fixed by removing its row from
`drizzle.__drizzle_migrations`.

## Renumbering when two PRs claim the same number

On the branch that merges **second**, after merging `origin/main` into it:

```bash
git merge origin/main
pnpm --filter @nexa/contracts build                        # FIRST, every time
bash scripts/claude/renumber-migration.sh --dry-run        # the plan
bash scripts/claude/renumber-migration.sh [--base <ref>]   # renumber, regenerate, verify
```

**Rebuild `packages/contracts` before renumbering, every time** (drizzle-kit
reads the built package; stale constants regenerate wrong SQL). The script
proves the SQL **byte-identical** (otherwise non-zero exit: the schemas
diverged — stop and read the diff); last line `renumbered=N identical=yes|no`.
Then `pnpm db:check` and the migration suites on a private database
(`TEST_DATABASE_URL` and `DATABASE_URL` both set). The PR body says the SQL is
byte-identical. Never hand-edit a generated migration's journal entry or
snapshot.

## Things drizzle-kit does not model

Triggers, functions, grants, exclusion constraints: a hand-written numbered
`.sql` under `apps/api/drizzle/`, registered in `drizzle/meta/_journal.json`
with the next `idx` and `when` = `Date.now()`. `0001_append_only_guards.sql` is
the worked example; it does not affect the drift check.

## Checklist before committing a migration

- [ ] Generated SQL read; `pnpm db:check` passes.
- [ ] `tests/integration/migration-*` and the suites touching the changed
      tables pass (affected files, `run-gate.sh --integration`).
- [ ] No column like `balance`; new status columns have a CHECK from a contract
      enum; new tenant-owned tables have `tenant_id NOT NULL` and a leading index.
- [ ] A removed column's stop-writing release has shipped.
- [ ] A hand-registered journal entry carries `Date.now()`, not a future stamp.
