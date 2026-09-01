# ADR-0008 — Drizzle ORM with checked-in SQL migrations

**Status:** Accepted. Matches the architecture review's stack decision.

## Decision

Drizzle ORM over `node-postgres`, with `drizzle-kit`-generated SQL migrations
committed to the repository and reviewed like any other code.

## Why not Prisma

Three reasons, in order of weight.

**The outbox INSERT must sit inside the aggregate's transaction**, with the
transaction handle threaded into repositories. Drizzle's `db.transaction(tx => …)`
hands you a plain, passable handle. Prisma's interactive transactions carry
their own timeouts and make a generated client a hard dependency of the
persistence layer.

**Phase 5 needs SQL that stays typed.** `SELECT … FOR UPDATE` for wallet
reservations, `INSERT … ON CONFLICT` for idempotent claims, partial unique
indexes, CHECK constraints, and an `EXCLUDE` constraint so overlapping price
bands become a database error rather than an application concern. Drizzle's
`sql` template keeps those typed; Prisma's `$queryRaw` discards typing.

**Prisma 8 is release-candidate only** at the time of this decision. A
foundation we will live in for a year does not start on an RC.

## Why not raw SQL with a thin query layer

It loses migration diffing and column-level type safety for no gain we need.

## The honest cost

`drizzle-kit`'s migration generation is less mature than Prisma's. Mitigated by
policy rather than hope:

- Migrations are checked-in SQL files, reviewed in the pull request.
- Forward-only: an applied migration is never edited. A destructive change is
  expand/contract across two releases.
- `drizzle-kit push` is banned outside a throwaway local database.
- `pnpm db:check` regenerates from the schema and fails if that produces
  anything new. It runs in CI.

## Hand-written migrations

`drizzle-kit` does not model triggers. `0001_append_only_guards.sql` is
hand-written and registered in the journal so the standard migrator applies it.
Because it adds only triggers and functions — things the schema file does not
describe — it does not affect the drift check.

## Forward-only in practice

`0002_drop_callback_refs.sql` is the worked example of the forward-only rule
under pressure. The table was created in 0000 and turned out to have no producer
and no reader. Editing 0000 would have been smaller and would have left a
cleaner history, and it was not done: an applied migration is never edited, and
that rule does not get an exception because the table happened to be new and
undeployed. The exception is what erodes the rule.
