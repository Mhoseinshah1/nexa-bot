import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { testConfig } from './harness';

/**
 * The two refusals that stand between a recovery and a destroyed database.
 *
 * Both are properties of the ENGINE rather than of its callers, and that is the
 * design: `restoreIntoEmpty` refuses the live database by name and refuses a
 * populated target, so neither depends on every call site remembering to check.
 * Three call sites pass it a name — the restore-test's scratch, the executor's
 * candidate, and the operator's own `backup restore` — and a guard at the call
 * sites would be three guards, one of which would eventually be forgotten.
 *
 * Tested against real PostgreSQL because both questions are PostgreSQL's to
 * answer: what `pg_restore` does to a populated database is not something this
 * codebase can assert about itself, and the emptiness check reads `pg_class`.
 */
describe('the restore engine refuses', () => {
  let databases: string[];
  let workRoot: string;

  const maintenanceUrl = (): string => {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = '/postgres';
    return url.toString();
  };

  async function maintenance(sql: string): Promise<void> {
    const client = new Client({ connectionString: maintenanceUrl() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  /** An engine whose LIVE database is `live`. */
  function engineFor(live: string): PostgresDatabaseTools {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${live}`;
    return new PostgresDatabaseTools({
      databaseUrl: url.toString(),
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      migratorEntrypoint: join(
        process.cwd(),
        'apps/api/dist/infrastructure/persistence/migrate.js',
      ),
    });
  }

  beforeEach(async () => {
    databases = [];
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-engine-'));
  });

  afterEach(async () => {
    for (const name of databases) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  /** A real custom-format dump of a real, tiny database. */
  async function aRealDump(): Promise<string> {
    const source = `nexa_engsrc_${randomBytes(5).toString('hex')}`;
    databases.push(source);
    await maintenance(`CREATE DATABASE "${source}"`);
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${source}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query('CREATE TABLE widgets (id int primary key)');
      await client.query('INSERT INTO widgets (id) VALUES (1)');
    } finally {
      await client.end();
    }
    const dumpPath = join(workRoot, 'source.dump');
    const outcome = await engineFor(source).dump(dumpPath);
    expect(outcome.databaseName).toBe(source);
    return dumpPath;
  }

  it('a restore into the LIVE database, by name', async () => {
    const live = `nexa_englive_${randomBytes(5).toString('hex')}`;
    databases.push(live);
    await maintenance(`CREATE DATABASE "${live}"`);
    const dumpPath = await aRealDump();

    // The one target that must never be reachable from this method, asked for
    // explicitly. A caller that computed the live name wrongly — a prefix
    // constant edited, a truncation collision — arrives here exactly like this.
    await expect(engineFor(live).restoreIntoEmpty(live, dumpPath)).rejects.toThrow();

    // And it did not half-restore before refusing: the database a refusal
    // protected is untouched, which is the property and not the error type.
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${live}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('a restore into a database that is not empty', async () => {
    const live = `nexa_englive_${randomBytes(5).toString('hex')}`;
    const target = `nexa_engtgt_${randomBytes(5).toString('hex')}`;
    databases.push(live, target);
    await maintenance(`CREATE DATABASE "${live}"`);
    await maintenance(`CREATE DATABASE "${target}"`);

    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${target}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // ONE table. The check is "is anything here", not "is this a Nexa
      // database": a half-restored candidate from a previous attempt is the real
      // case, and it has some of the right tables rather than none.
      await client.query('CREATE TABLE leftover (id int)');
    } finally {
      await client.end();
    }
    const dumpPath = await aRealDump();

    await expect(engineFor(live).restoreIntoEmpty(target, dumpPath)).rejects.toThrow();

    // Nothing was merged in. `pg_restore` into a populated database exits
    // non-zero having created whatever it managed first, which is two damaged
    // copies wearing the look of a restore that nearly worked.
    const after = new Client({ connectionString: url.toString() });
    await after.connect();
    try {
      const { rows } = await after.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY c.relname`,
      );
      expect(rows.map((row) => row.relname)).toEqual(['leftover']);
    } finally {
      await after.end();
    }
  });

  it('but DOES restore into an empty database that is not the live one', async () => {
    /*
     * The positive control, and the reason the two cases above can fail.
     *
     * A `restoreIntoEmpty` that threw unconditionally would pass both refusals
     * and make the whole recovery pipeline non-functional — and this project has
     * shipped that exact shape: a readiness parser rewritten three times, twice
     * inverted, each inversion green.
     */
    const live = `nexa_englive_${randomBytes(5).toString('hex')}`;
    const target = `nexa_engtgt_${randomBytes(5).toString('hex')}`;
    databases.push(live, target);
    await maintenance(`CREATE DATABASE "${live}"`);
    await maintenance(`CREATE DATABASE "${target}"`);
    const dumpPath = await aRealDump();

    await engineFor(live).restoreIntoEmpty(target, dumpPath);

    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${target}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: number }>('SELECT id FROM widgets');
      expect(rows.map((row) => row.id)).toEqual([1]);
    } finally {
      await client.end();
    }
  });

  it('reports a file that is not a pg_dump archive without reading it all', async () => {
    const live = `nexa_englive_${randomBytes(5).toString('hex')}`;
    databases.push(live);
    await maintenance(`CREATE DATABASE "${live}"`);
    const engine = engineFor(live);

    const plain = join(workRoot, 'plain.sql');
    await writeFile(plain, '-- PostgreSQL database dump\nCREATE TABLE t (id int);\n');
    expect(await engine.isCustomFormatDump(plain)).toBe(false);

    const tiny = join(workRoot, 'tiny.bin');
    await writeFile(tiny, 'PG');
    expect(await engine.isCustomFormatDump(tiny)).toBe(false);

    // Absent is `false`, not a throw: the caller's next move is the same.
    expect(await engine.isCustomFormatDump(join(workRoot, 'nothing-here.dump'))).toBe(false);

    // And the real thing, so `false` is not this method's only answer.
    expect(await engine.isCustomFormatDump(await aRealDump())).toBe(true);
  });
});
