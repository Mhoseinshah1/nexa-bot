import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What "the schema this code expects" means, stated once.
 *
 * Readiness used to ask `count(*) > 0` of the migrations table, which proves
 * that SOME migration has ever been applied and nothing else: a database
 * migrated to 0001 answered "ready" to a release that expects 0019, and a
 * migration that failed half-way through a release's set left the process
 * serving against a schema it was never built for.
 *
 * The authority is the migration journal the release ships — the same
 * `meta/_journal.json` drizzle's migrator reads, hashed the same way drizzle
 * hashes each file when it records it. So the expected set is derived, never
 * declared: a migration added to the journal advances what readiness requires
 * without anybody remembering to bump a number here.
 *
 * The comparison is by identity, not by count. Each applied row records the
 * journal entry's `when` as `created_at` and the file's sha256 as `hash`, and
 * that pair is what is checked.
 */

export interface ExpectedMigration {
  readonly tag: string;
  /** The journal's `when`, which drizzle stores as `created_at`. */
  readonly when: number;
  /** sha256 of the migration file, exactly as drizzle records it. */
  readonly hash: string;
}

export interface AppliedMigration {
  readonly hash: string;
  readonly createdAt: number;
}

export type MigrationVerdict =
  /** Every expected migration is applied with the expected content. */
  | { readonly state: 'current'; readonly applied: number; readonly expected: number }
  /**
   * Every expected migration is applied, and the database carries more that
   * this release does not know about — the shape a rollback leaves, because a
   * release's migrations only add (ADR-0022). Ready: the schema this code
   * needs is there.
   */
  | {
      readonly state: 'ahead';
      readonly applied: number;
      readonly expected: number;
      readonly extra: number;
    }
  /** Nothing has ever been applied. */
  | { readonly state: 'none'; readonly expected: number }
  /** A strict prefix of what is expected: the release's migration has not run, or died part-way. */
  | {
      readonly state: 'behind';
      readonly applied: number;
      readonly expected: number;
      readonly missing: readonly string[];
    }
  /**
   * The database records a migration this release knows by timestamp but with
   * DIFFERENT content, or one interleaved among the expected ones that the
   * journal does not name. Neither has a safe reading, so neither is ready.
   */
  | { readonly state: 'diverged'; readonly reason: string };

/**
 * The migrations this release expects, from its own journal.
 *
 * Hashed exactly as drizzle's `readMigrationFiles` hashes them — the whole
 * file, before it is split on statement breakpoints — because that is the
 * value the migrator writes into the table and the only thing the comparison
 * can be made against.
 */
export function expectedMigrations(migrationsFolder: string): ExpectedMigration[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256')
      .update(readFileSync(join(migrationsFolder, `${entry.tag}.sql`)))
      .digest('hex'),
  }));
}

export function compareMigrations(
  applied: readonly AppliedMigration[],
  expected: readonly ExpectedMigration[],
): MigrationVerdict {
  if (applied.length === 0) return { state: 'none', expected: expected.length };

  const byWhen = new Map<number, AppliedMigration>();
  for (const row of applied) {
    if (byWhen.has(row.createdAt)) {
      return {
        state: 'diverged',
        reason: `two applied migrations share the timestamp ${row.createdAt}`,
      };
    }
    byWhen.set(row.createdAt, row);
  }

  const missing: string[] = [];
  for (const migration of expected) {
    const row = byWhen.get(migration.when);
    if (row === undefined) {
      missing.push(migration.tag);
      continue;
    }
    if (row.hash !== migration.hash) {
      return {
        state: 'diverged',
        reason: `${migration.tag} was applied with different content than this release ships`,
      };
    }
  }

  // Anything applied that the journal does not name. Newer than everything
  // expected is the rollback shape and is fine; anything else is a history
  // this release cannot account for.
  const known = new Set(expected.map((migration) => migration.when));
  const newest = expected.at(-1)?.when ?? 0;
  let extra = 0;
  for (const row of applied) {
    if (known.has(row.createdAt)) continue;
    if (row.createdAt > newest) {
      extra += 1;
      continue;
    }
    return {
      state: 'diverged',
      reason: `an applied migration at ${row.createdAt} is not in this release's journal`,
    };
  }

  if (missing.length > 0) {
    // A prefix that stops early is "behind". A gap — later ones applied while
    // an earlier one is missing — cannot have been produced by the migrator,
    // which applies in order, so it is a history this release cannot explain.
    const firstMissing = expected.findIndex((migration) => migration.tag === missing[0]);
    const appliedAfterGap = expected
      .slice(firstMissing)
      .some((migration) => byWhen.has(migration.when));
    if (appliedAfterGap) {
      return {
        state: 'diverged',
        reason: `${missing[0]} is missing while a later migration is applied`,
      };
    }
    return { state: 'behind', applied: applied.length, expected: expected.length, missing };
  }

  if (extra > 0) {
    return { state: 'ahead', applied: applied.length, expected: expected.length, extra };
  }
  return { state: 'current', applied: applied.length, expected: expected.length };
}
