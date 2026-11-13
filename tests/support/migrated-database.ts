import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';

/**
 * A throwaway database with every migration applied, cloned from one template.
 *
 * The recovery and restore suites need a fresh live database per case (the executor renames
 * the database it runs against). Running all of `apps/api/drizzle` into each took ~7 s a case;
 * `CREATE DATABASE ... TEMPLATE` copies the migrated schema in a fraction of a second. The
 * template is keyed by a hash of the migration files and of the persistence code `runMigrations`
 * runs after them (indexes, policies, grants), so a change to either builds a new one,
 * and it is built under a temporary name and renamed when complete, so a crashed build is never
 * mistaken for a template. Building and cloning both happen under one session advisory lock:
 * PostgreSQL refuses to clone a template another session is cloning or connected to.
 *
 * The cloned database is exactly what `runMigrations` would have produced (the clone is of its
 * result): same journal rows, same objects. The caller drops it, as it did before.
 */
const LOCK_KEY = 7_204_117_331;
const TEMPLATE_PREFIX = 'nexa_tpl_';

function migrationHash(): string {
  const folder = join(__dirname, '../../apps/api/drizzle');
  const hash = createHash('sha256');
  const files = readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) hash.update(name).update(readFileSync(join(folder, name)));
  hash.update(readFileSync(join(folder, 'meta/_journal.json')));
  // runMigrations also builds objects outside the SQL files (online indexes, row-level
  // security policies and grants, backfills), from the persistence code. Any change there
  // must build a new template too, or a persistent local database would keep a stale one.
  const persistence = join(__dirname, '../../apps/api/src/infrastructure/persistence');
  const sources = (readdirSync(persistence, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort();
  for (const name of sources) hash.update(name).update(readFileSync(join(persistence, name)));
  return hash.digest('hex').slice(0, 16);
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Creates `name` with every migration applied; returns its connection URL. */
export async function createMigratedDatabase(baseUrl: string, name: string): Promise<string> {
  const template = `${TEMPLATE_PREFIX}${migrationHash()}`;
  const client = new Client({ connectionString: urlFor(baseUrl, 'postgres') });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [template]);
      if (exists.rowCount === 0) {
        const building = `${template}_b${String(process.pid)}`;
        await client.query(`DROP DATABASE IF EXISTS "${building}"`);
        await client.query(`CREATE DATABASE "${building}"`);
        await runMigrations(urlFor(baseUrl, building));
        await client.query(`ALTER DATABASE "${building}" RENAME TO "${template}"`);
      }
      await client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
  return urlFor(baseUrl, name);
}
