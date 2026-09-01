---
name: nexa-migrations
description: How to write, generate and verify a database migration in this repository. Use whenever changing apps/api/src/infrastructure/persistence/schema.ts or adding anything under apps/api/drizzle.
---

# Migrations

Migrations are checked-in SQL, generated from the schema, reviewed like code,
and **forward-only**.

## The normal path

1. Edit `apps/api/src/infrastructure/persistence/schema.ts`.
2. `pnpm db:generate` — this runs `drizzle-kit generate`. Give the migration a
   meaningful name: `pnpm --filter @nexa/api exec drizzle-kit generate --name add_wallet_entries`.
3. **Read the generated SQL.** It is the artifact under review, not the schema
   file.
4. `pnpm db:migrate` to apply, then `pnpm test:integration`.
5. `pnpm db:check` must pass — it regenerates and fails if anything new appears.

## Rules

- **Never edit an applied migration.** Write a new one.
- **`drizzle-kit push` is banned** outside a throwaway local database. It skips
  the migration files entirely, which is how a schema drifts from its history.
- **Destructive changes are expand/contract**, across two releases: add the new
  shape and backfill in one, remove the old shape in the next. Never drop a
  column in the same release that stops writing it.
- **Every status column gets a CHECK constraint** built from the contract enum
  via `enumCheck()`. Never a free-text status.
- **Every tenant-owned table gets `tenant_id uuid NOT NULL`**, and composite
  indexes lead with it.
- **Every timestamp is `timestamptz`.** An integration test fails otherwise.
- **Never add a `balance` column.** The boundary check rejects the migration.
- Money columns are `bigint` minor units with a companion `currency` column.

## Things drizzle-kit does not model

Triggers, functions, grants and exclusion constraints. Write those by hand as a
new numbered `.sql` file under `apps/api/drizzle/`, then register it in
`drizzle/meta/_journal.json` with the next `idx` and a `when` greater than the
previous entry. `0001_append_only_guards.sql` is the worked example.

Because such a file adds only things the schema file does not describe, it does
not affect the drift check.

## Append-only tables

`audit_logs` refuses UPDATE and DELETE. `operational_events` refuses DELETE and
identity changes but allows its occurrence counter to advance.
`outbox_messages` freezes its content while allowing delivery bookkeeping.

Tests reset with `TRUNCATE`, which bypasses row triggers. That is deliberate:
the guard stays in force for application code.

## Checklist before committing a migration

- [ ] The generated SQL was read, not just produced.
- [ ] `pnpm db:check` passes.
- [ ] `pnpm test:integration` passes against the applied migration.
- [ ] No column named anything like `balance`.
- [ ] Every new status column has a CHECK constraint from a contract enum.
- [ ] Every new tenant-owned table has `tenant_id NOT NULL` and a leading index.
- [ ] If a column was removed, the release that stopped writing it has shipped.
