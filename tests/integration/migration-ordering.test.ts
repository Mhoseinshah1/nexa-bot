import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { testConfig } from './harness';

/**
 * What a journal timestamp in the future actually costs.
 *
 * `tests/unit/migration-journal.test.ts` refuses one. This is why: the refusal
 * is a convention, and a convention whose consequence is only described in a
 * comment is a convention somebody relaxes. So the consequence is demonstrated
 * against a real PostgreSQL and the real `drizzle-orm` migrator, on a scratch
 * database and a throwaway migrations folder.
 *
 * The migrator selects ONE row — the greatest `created_at` in
 * `drizzle.__drizzle_migrations` — and applies every journal entry whose `when`
 * exceeds it. Nothing compares indexes, tags or hashes. A future `when`
 * therefore raises that watermark past the timestamps later migrations will
 * carry, and those migrations are skipped in silence: no error, no warning, and
 * `pnpm db:check` still passes, because the schema file and the migration files
 * agree with each other. Only the database is behind.
 *
 * `0031` was first committed nineteen hours ahead of itself, which would have
 * done exactly this to Phase 4A's migration.
 */
describe('migration ordering is decided by `when`, not by index', () => {
  const scratch = `nexa_ordering_${Date.now()}`;
  const adminUrl = () => testConfig().DATABASE_URL;
  const scratchUrl = () => {
    const u = new URL(adminUrl());
    u.pathname = `/${scratch}`;
    return u.toString();
  };

  let folder: string;

  /**
   * A migrations folder holding the entries given, each creating a table named
   * after itself.
   *
   * Written per RELEASE rather than once, because the skip needs two migrate
   * invocations and the first version of this test did not give it them. On a
   * virgin database `lastDbMigration` is undefined and the migrator's condition
   * short-circuits to true, so EVERY entry runs whatever its `when` — the future
   * stamp costs nothing on a fresh install, which is exactly why the defect is
   * invisible in CI and only bites a database that already applied it. Release
   * one applies the future migration alone; release two adds the next one beside
   * it, and that is the run where the watermark decides.
   */
  const writeFolder = (entries: { tag: string; when: number }[]) => {
    mkdirSync(join(folder, 'meta'), { recursive: true });
    for (const { tag } of entries) {
      writeFileSync(
        join(folder, `${tag}.sql`),
        `CREATE TABLE IF NOT EXISTS ${tag.replace(/^\d+_/, 'ordering_')} (n int)`,
      );
    }
    writeFileSync(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: entries.map(({ tag, when }, idx) => ({
          idx,
          version: '7',
          when,
          tag,
          breakpoints: true,
        })),
      }),
    );
  };

  const applyFolder = async () => {
    const handle = createDatabase(scratchUrl(), 1);
    try {
      await migrate(handle.db, { migrationsFolder: folder });
    } finally {
      await handle.close();
    }
  };

  /** The single row the migrator's pending test reads. */
  const appliedWatermark = async (): Promise<number | null> => {
    const client = new Client(scratchUrl());
    await client.connect();
    try {
      const result = await client.query(
        `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
      );
      return result.rows[0] ? Number(result.rows[0].created_at) : null;
    } finally {
      await client.end();
    }
  };

  const tableExists = async (name: string): Promise<boolean> => {
    const client = new Client(scratchUrl());
    await client.connect();
    try {
      const result = await client.query(`SELECT to_regclass($1) AS oid`, [name]);
      return result.rows[0].oid !== null;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    const admin = new Client(adminUrl());
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.query(`CREATE DATABASE ${scratch}`);
    await admin.end();
    folder = mkdtempSync(join(tmpdir(), 'nexa-ordering-'));
  }, 120_000);

  afterAll(async () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    const admin = new Client(adminUrl());
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.end();
  });

  it('SKIPS a later migration whose `when` is below an applied future one, with no error', async () => {
    const now = Date.now();
    // The release that ships the mistake: ONE migration, stamped a day ahead of
    // itself. That is the arithmetic that produced 0031's original value — take
    // the previous entry's `when` and add a day to be "safely after" it.
    const future = now + 24 * 3_600_000;
    writeFolder([{ tag: '0000_first', when: future }]);
    await applyFolder();
    expect(await tableExists('ordering_first')).toBe(true);
    expect(await appliedWatermark()).toBe(future);

    // The next release, correct in every respect: higher index, later tag, and a
    // `when` stamped by `drizzle-kit generate` at the moment it was generated.
    writeFolder([
      { tag: '0000_first', when: future },
      { tag: '0001_second', when: now },
    ]);

    // No throw. That is the finding: the migrator reports success.
    await applyFolder();

    expect(
      await tableExists('ordering_second'),
      'the later migration ran, so this database cannot demonstrate the skip',
    ).toBe(false);

    // And it stays skipped. Re-running does not recover it, which is what makes
    // the failure permanent rather than a one-off, and what would have made
    // Phase 4A's table simply absent on every database that applied 0031.
    await applyFolder();
    expect(await tableExists('ordering_second')).toBe(false);
  });

  it('applies it when every `when` is in the past and ascending, which is the fix', async () => {
    const now = Date.now();
    // The corrected shape. The database still carries the future row the
    // previous case inserted, so the watermark is cleared first — which is
    // exactly what the fix on this branch had to do to the dev and test
    // databases that had already applied the bad stamp.
    const client = new Client(scratchUrl());
    await client.connect();
    await client.query(`DELETE FROM drizzle.__drizzle_migrations`);
    await client.end();

    writeFolder([
      { tag: '0000_first', when: now - 2_000 },
      { tag: '0001_second', when: now - 1_000 },
    ]);
    await applyFolder();

    expect(await tableExists('ordering_second')).toBe(true);
    expect(await appliedWatermark()).toBe(now - 1_000);
  });
});
