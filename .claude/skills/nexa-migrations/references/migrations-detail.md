# Migrations in full (moved verbatim from SKILL.md, token diet)

`SKILL.md` keeps the rule and the commands; this is the rationale, the worked examples and the manual fallback.

## The journal's `when` IS the ordering

`drizzle-orm`'s migrator does not compare indexes, tags or hashes to decide what
is pending. It reads ONE row — the greatest `created_at` in
`drizzle.__drizzle_migrations` — and applies every journal entry whose `when`
exceeds it.

So when you register a hand-written migration, stamp `when` with the CURRENT
time. Never "the previous value plus a day" to be safely after it: a `when` in
the future raises that watermark past every timestamp `drizzle-kit generate` will
produce until that instant arrives, and the next migration is SKIPPED in silence
— no error, and `pnpm db:check` still passes, because the schema file and the
migration files agree with each other. Only the database is behind. `0031` was
committed nineteen hours ahead of itself and would have swallowed the migration
after it.

    node -e 'console.log(Date.now())'

`tests/unit/migration-journal.test.ts` refuses a future stamp, a `when` that does
not advance, and a journal that disagrees with the files on disk.
`tests/integration/migration-ordering.test.ts` demonstrates the skip against a
real PostgreSQL, because the rule is a convention and a convention whose
consequence lives only in a comment is one somebody relaxes.

If a database has already applied a bad stamp, removing its row from
`drizzle.__drizzle_migrations` is what lets the corrected entry apply.

## Renumbering when two PRs claim the same number — script behaviour and manual steps

It finds the branch's migrations that are not on the base and does steps 1–3
below for each: a generated one is regenerated with `drizzle-kit`, a
hand-written one is `git mv`ed and registered with `when` = `Date.now()`; it
proves the SQL **byte-identical** (otherwise it exits non-zero and prints the
diff — the schemas diverged: stop and read it), and updates references to the
old number outside `apps/api/drizzle/`. Its last line is
`renumbered=N identical=yes|no`. Step 4 is still yours: `pnpm db:check` and the
migration suites. The PR body says the SQL is byte-identical.

**Rebuild `packages/contracts` before renumbering, every time** (and after any
merge that brought in contract changes): drizzle-kit reads the _built_ package,
so with stale `dist` constants it regenerates from the wrong enums (for example a
CHECK list without a state main added) and the SQL is no longer
byte-identical. Use a private test database too (`TEST_DATABASE_URL` and
`DATABASE_URL` both set) for the `db:check` and migration suites that follow.

A branch that renumbered inside its "merge origin/main" commit is renumbered
again correctly when main moves on: the script reads snapshots added by merge
commits (`git log -m`) and only drops the ones that are main's own blobs.

The manual steps — what the script does, and the fallback when it cannot run:

0. `pnpm --filter @nexa/contracts build`.
1. Save the branch's SQL: `cp apps/api/drizzle/NNNN_name.sql "$SCRATCH/"`.
2. Generated migration: remove the branch's `NNNN_name.sql`, its
   `meta/NNNN_snapshot.json` and its `_journal.json` entry (take main's journal
   and snapshots in the merge), then regenerate with the tooling —
   `pnpm --filter @nexa/api exec drizzle-kit generate --name name` — so the
   snapshot chain and journal follow main's head. Hand-written migration: `git mv`
   it to the next number and register it as § Things drizzle-kit does not model
   says, with `when` = `Date.now()`.
3. `diff "$SCRATCH/NNNN_name.sql" apps/api/drizzle/MMMM_name.sql` must be empty:
   the SQL stays **byte-identical**, and the PR body says so. A non-empty diff
   means the schemas diverged — stop and read it.
4. `pnpm db:check`, then the migration integration suites on a fresh private
   database (`nexa-test-selection`). Fix any doc or test that cites the old number.

Never renumber a generated migration by hand-editing its journal entry or
snapshot; only a hand-written migration's entry is written by hand.

## Forward-only, even when editing would be tidier

`0002_drop_callback_refs.sql` is the worked example. A table added in 0000
turned out to have no producer and no reader, and was removed by a new
migration rather than by editing 0000 — even though nothing had deployed it and
editing would have left a cleaner history. The rule does not get an exception
because the case looks harmless; the exception is what erodes it.

## Append-only tables

`audit_logs` refuses UPDATE and DELETE. `operational_events` refuses DELETE and
identity changes but allows its occurrence counter to advance.
`outbox_messages` freezes its content while allowing delivery bookkeeping.

Tests reset with `TRUNCATE`, which bypasses row triggers. That is deliberate:
the guard stays in force for application code.
