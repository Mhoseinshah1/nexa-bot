import { describe, expect, it } from 'vitest';
import {
  compareMigrations,
  expectedMigrations,
  type AppliedMigration,
  type ExpectedMigration,
} from '../../apps/api/src/infrastructure/persistence/migration-state';
import { migrationsFolder } from '../../apps/api/src/infrastructure/persistence/migrate';

/**
 * What readiness means by "the schema this code expects" (C14).
 *
 * The comparison is by identity — the journal's timestamp and the file's
 * hash, which are the two values drizzle writes into its table — never by
 * count. The tables below are the states a real database can be in and the
 * verdict each must get.
 */

const expected: ExpectedMigration[] = [
  { tag: '0000_a', when: 1000, hash: 'h0' },
  { tag: '0001_b', when: 2000, hash: 'h1' },
  { tag: '0002_c', when: 3000, hash: 'h2' },
];
const applied = (...rows: [number, string][]): AppliedMigration[] =>
  rows.map(([createdAt, hash]) => ({ createdAt, hash }));

describe('the migration state a release expects', () => {
  it('is derived from the journal this release ships, hashed as drizzle hashes it', () => {
    // The real journal, so a migration added to it changes what readiness
    // requires with nobody editing a number anywhere.
    const real = expectedMigrations(migrationsFolder());
    expect(real.length).toBeGreaterThanOrEqual(20);
    expect(real[0]?.tag).toBe('0000_foundation');
    expect(real.at(-1)?.tag).toMatch(/^\d{4}_/);
    for (const migration of real) {
      expect(migration.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(migration.when)).toBe(true);
    }
    // Strictly ordered by time, which the comparison relies on.
    for (let i = 1; i < real.length; i += 1) {
      expect(real[i]!.when).toBeGreaterThan(real[i - 1]!.when);
    }
  });

  it('is not ready with nothing applied', () => {
    expect(compareMigrations([], expected)).toEqual({ state: 'none', expected: 3 });
  });

  it('is not ready with only the first migration applied', () => {
    expect(compareMigrations(applied([1000, 'h0']), expected)).toMatchObject({
      state: 'behind',
      applied: 1,
      expected: 3,
      missing: ['0001_b', '0002_c'],
    });
  });

  it('is not ready one migration short', () => {
    expect(compareMigrations(applied([1000, 'h0'], [2000, 'h1']), expected)).toMatchObject({
      state: 'behind',
      applied: 2,
      expected: 3,
      missing: ['0002_c'],
    });
  });

  it('is ready with exactly the expected set', () => {
    expect(compareMigrations(applied([1000, 'h0'], [2000, 'h1'], [3000, 'h2']), expected)).toEqual({
      state: 'current',
      applied: 3,
      expected: 3,
    });
  });

  it('is ready when the database is AHEAD, which is what a rollback leaves', () => {
    // A newer release's migration is applied and this older code is running.
    // Migrations only add (ADR-0022), so this schema still holds everything
    // this release needs — and refusing it would make rollback impossible.
    expect(
      compareMigrations(applied([1000, 'h0'], [2000, 'h1'], [3000, 'h2'], [4000, 'h3']), expected),
    ).toEqual({ state: 'ahead', applied: 4, expected: 3, extra: 1 });
  });

  it('is not ready when a known migration was applied with different content', () => {
    expect(
      compareMigrations(applied([1000, 'h0'], [2000, 'DIFFERENT'], [3000, 'h2']), expected),
    ).toMatchObject({ state: 'diverged', reason: expect.stringContaining('0001_b') });
  });

  it('is not ready when the history has a gap the migrator could not have made', () => {
    expect(compareMigrations(applied([1000, 'h0'], [3000, 'h2']), expected)).toMatchObject({
      state: 'diverged',
      reason: expect.stringContaining('0001_b'),
    });
  });

  it('is not ready when an unknown migration sits among the expected ones', () => {
    expect(
      compareMigrations(applied([1000, 'h0'], [1500, 'who'], [2000, 'h1'], [3000, 'h2']), expected),
    ).toMatchObject({ state: 'diverged', reason: expect.stringContaining('1500') });
  });

  it('is not ready when two applied rows share a timestamp', () => {
    expect(
      compareMigrations(applied([1000, 'h0'], [1000, 'h0'], [2000, 'h1'], [3000, 'h2']), expected),
    ).toMatchObject({ state: 'diverged' });
  });
});
