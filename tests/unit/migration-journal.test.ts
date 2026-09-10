import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The migration journal's ordering, which decides what gets applied at all.
 *
 * `drizzle-orm`'s migrator does not compare indexes, tags or hashes to work out
 * what is pending. It reads ONE row — the applied migration with the greatest
 * `created_at` — and runs every journal entry whose `when` is strictly greater
 * than it:
 *
 *     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 *
 * So `when` is not decoration beside the index. It IS the ordering, and the two
 * can disagree. An entry whose `when` lies in the future raises that watermark
 * past every timestamp a later `drizzle-kit generate` will produce, and the next
 * migration — higher index, later tag, correct in every other way — is SILENTLY
 * SKIPPED on any database that already applied the future one. No error, no
 * warning, and `pnpm db:check` still passes because the schema file and the
 * migration files agree with each other; it is only the database that is behind.
 *
 * This is not hypothetical. `0031` was first committed with a `when` of
 * 1789152375597 — a day ahead of the commit, arrived at by adding 86_400_000 to
 * 0030's value to be "safely after" it. Every migration this repository would
 * have generated for the next nineteen hours, Phase 4A's included, would have
 * been skipped on every database that had applied it.
 *
 * A convention with no test is a convention that will be silently reverted, and
 * this one fails invisibly, so it gets these four.
 */
describe('the migration journal', () => {
  const folder = join(__dirname, '../../apps/api/drizzle');
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; when: number; tag: string; version: string }[];
  };

  it('numbers its entries consecutively from zero, in order', () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it('has a strictly increasing `when`, which is what the migrator orders by', () => {
    const outOfOrder = journal.entries
      .map((entry, index) => ({ entry, previous: journal.entries[index - 1] }))
      .filter(({ entry, previous }) => previous !== undefined && entry.when <= previous.when)
      .map(({ entry, previous }) => `${entry.tag} (${entry.when}) <= ${previous?.tag}`);
    expect(
      outOfOrder,
      'an entry that does not advance `when` is an entry the migrator may never reach',
    ).toEqual([]);
  });

  it('never stamps a migration in the future', () => {
    // The test runs later than the commit, always, so this stays true once it is
    // true — and it is the one form of the rule that catches the mistake at
    // authoring time rather than on the database that silently fell behind.
    const now = Date.now();
    const future = journal.entries
      .filter((entry) => entry.when > now)
      .map((entry) => `${entry.tag} is stamped ${new Date(entry.when).toISOString()}`);
    expect(
      future,
      'a future `when` raises the applied watermark past the timestamps later migrations will carry, ' +
        'so the next migration is skipped with no error',
    ).toEqual([]);
  });

  it('names exactly the migration files that exist', () => {
    const onDisk = readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    const named = journal.entries.map((entry) => entry.tag).sort();
    // Both directions. An entry with no file makes the migrator throw; a file
    // with no entry is a migration nothing ever runs, which is the quieter of
    // the two and the one worth a test.
    expect(named).toEqual(onDisk);
  });
});
