import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { testConfig } from './harness';

/**
 * `inspectDatabase` reads the WHOLE migration history, however long it is.
 *
 * The history comes back as `psql` output, one 79-byte line per applied
 * migration, and the tool runner used to stop capturing stdout at 16 KiB — at
 * the granularity of whatever chunks the pipe happened to deliver. Past 207
 * migrations the output crosses that line, so the history was either whole (one
 * coalesced read) or cut mid-hash (several reads), and a cut line parsed as "a
 * row this release cannot parse": `migrations: null`, which the executor
 * reports as `recovery.migration_state_unreadable` and refuses the cutover.
 * The repository reached 211 migrations and the recovery suite began failing
 * intermittently on the same commit.
 *
 * Only databases this file creates are touched, by a name no other suite
 * sweeps: `nexa_inspect_*`.
 */
describe('the database inspection', () => {
  let databases: string[];

  const urlFor = (database: string): string => {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    return url.toString();
  };

  async function on(database: string, sql: string): Promise<void> {
    const client = new Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function aDatabase(): Promise<string> {
    const name = `nexa_inspect_${randomBytes(6).toString('hex')}`;
    databases.push(name);
    await on('postgres', `CREATE DATABASE "${name}"`);
    return name;
  }

  /** An engine whose live database is NOT the one being inspected. */
  const engine = (): PostgresDatabaseTools =>
    new PostgresDatabaseTools({
      databaseUrl: urlFor('postgres'),
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      migratorEntrypoint: join(
        process.cwd(),
        'apps/api/dist/infrastructure/persistence/migrate.js',
      ),
    });

  beforeEach(() => {
    databases = [];
  });

  afterEach(async () => {
    for (const name of databases) {
      await on('postgres', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
  });

  it('reads a history far larger than any one pipe read, every row of it', async () => {
    // 3 000 rows is ~237 KB of output: more than a pipe holds, so it CANNOT
    // arrive in one chunk, and a capture cap anywhere below it would show.
    const name = await aDatabase();
    await on(
      name,
      `CREATE SCHEMA drizzle;
       CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
       INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT encode(sha256(i::text::bytea), 'hex'), 1700000000000 + i
           FROM generate_series(1, 3000) AS i;
       CREATE TABLE public.something (id int);`,
    );

    const inspection = await engine().inspectDatabase(name);

    expect(inspection.migrations).not.toBeNull();
    expect(inspection.migrations).toHaveLength(3000);
    expect(inspection.migrations?.[2999]).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
      createdAt: 1700000003000,
    });
  });

  it('refuses a history beyond the stdout bound rather than answering with part of it', async () => {
    // ~120 000 rows is ~9.5 MB, past the 8 MiB bound. A shorter history here
    // would be a confident wrong answer — `behind` or `diverged` — so the only
    // acceptable outcome is an error.
    const name = await aDatabase();
    await on(
      name,
      `CREATE SCHEMA drizzle;
       CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
       INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT encode(sha256(i::text::bytea), 'hex'), 1700000000000 + i
           FROM generate_series(1, 120000) AS i;
       CREATE TABLE public.something (id int);`,
    );

    await expect(engine().inspectDatabase(name)).rejects.toMatchObject({
      code: 'backup.tool_failed',
    });
  });

  it("reads this release's own history whole, as the executor's candidate carries it", async () => {
    const name = await aDatabase();
    await runMigrations(urlFor(name));
    const journal = JSON.parse(
      await readFile(join(process.cwd(), 'apps/api/drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: unknown[] };

    // Repeated, because the defect this pins depended on how the pipe chunked
    // the output: one pass could come back whole by luck.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const inspection = await engine().inspectDatabase(name);
      expect(inspection.migrations).toHaveLength(journal.entries.length);
    }
  });
});
