import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { testConfig } from './harness';
import {
  MigrationPreflightError,
  preflightMigrations,
} from '../../apps/api/src/infrastructure/persistence/preflight';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';

/**
 * The pre-migration preflight (B-EXTRA-1), against real databases.
 *
 * The condition it exists for cannot be constructed in the ordinary test
 * database: migration 0015 is applied there, and its partial unique index is
 * exactly what makes a second PRIMARY tenant impossible. So each case gets a
 * scratch database shaped like the LEGACY schema the preflight has to read —
 * created and dropped here, on the same server the suite already uses.
 */

const config = testConfig();
const admin = () => new Client({ connectionString: config.DATABASE_URL });

/** The test database's URL, pointed at a different database name. */
function urlFor(database: string): string {
  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createScratch(name: string, shape: (client: Client) => Promise<void>) {
  const control = admin();
  await control.connect();
  await control.query(`DROP DATABASE IF EXISTS ${name}`);
  await control.query(`CREATE DATABASE ${name}`);
  await control.end();
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    await shape(client);
  } finally {
    await client.end();
  }
}

async function dropScratch(name: string) {
  const control = admin();
  await control.connect();
  await control.query(`DROP DATABASE IF EXISTS ${name}`);
  await control.end();
}

const SCRATCH = [
  'nexa_preflight_two',
  'nexa_preflight_one',
  'nexa_preflight_notable',
  'nexa_preflight_nokind',
  'nexa_preflight_fresh',
];

describe('the migration preflight', () => {
  beforeAll(async () => {
    for (const name of SCRATCH) await dropScratch(name);
  }, 60_000);

  afterAll(async () => {
    for (const name of SCRATCH) await dropScratch(name);
  }, 60_000);

  it('refuses a legacy database with two PRIMARY tenants, before any migration runs', async () => {
    await createScratch('nexa_preflight_two', async (client) => {
      // The legacy shape: the tenants table 0015 will index, without the
      // index 0015 adds. Two PRIMARY rows is the seed an early dev build left.
      await client.query(`CREATE TABLE tenants (id uuid PRIMARY KEY, kind text NOT NULL)`);
      await client.query(
        `INSERT INTO tenants VALUES (gen_random_uuid(), 'PRIMARY'), (gen_random_uuid(), 'PRIMARY'), (gen_random_uuid(), 'RESELLER')`,
      );
    });
    const url = urlFor('nexa_preflight_two');

    await expect(preflightMigrations(url)).rejects.toBeInstanceOf(MigrationPreflightError);
    await expect(preflightMigrations(url)).rejects.toThrow(/2 tenants with kind = 'PRIMARY'/);
    await expect(preflightMigrations(url)).rejects.toThrow(/0015_single_primary_tenant/);
    await expect(preflightMigrations(url)).rejects.toThrow(/Nothing was migrated/);

    // And `runMigrations` — the path every caller shares — stops for the same
    // reason before the migrator is entered: no migrations table appears.
    await expect(runMigrations(url)).rejects.toBeInstanceOf(MigrationPreflightError);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const table = await client.query(
        `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
      );
      expect(table.rows[0]?.present).toBe(false);
      // The data was not touched: nothing chose a tenant on the operator's behalf.
      const count = await client.query(
        `SELECT count(*)::int AS n FROM tenants WHERE kind = 'PRIMARY'`,
      );
      expect(count.rows[0]?.n).toBe(2);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('passes a legacy database with exactly one PRIMARY tenant', async () => {
    await createScratch('nexa_preflight_one', async (client) => {
      await client.query(`CREATE TABLE tenants (id uuid PRIMARY KEY, kind text NOT NULL)`);
      await client.query(
        `INSERT INTO tenants VALUES (gen_random_uuid(), 'PRIMARY'), (gen_random_uuid(), 'RESELLER')`,
      );
    });
    const report = await preflightMigrations(urlFor('nexa_preflight_one'));
    expect(report.checks).toContain('PRIMARY tenants: 1');
  }, 60_000);

  it('passes a database with no tenants table at all', async () => {
    // Older than the table, or a brand-new empty database: both are fine, and
    // the preflight must not be the thing that breaks a fresh install.
    await createScratch('nexa_preflight_notable', async () => {});
    const report = await preflightMigrations(urlFor('nexa_preflight_notable'));
    expect(report.checks).toContain('tenants table: absent, nothing to check');
  }, 60_000);

  it('passes a tenants table that has no kind column yet', async () => {
    await createScratch('nexa_preflight_nokind', async (client) => {
      await client.query(`CREATE TABLE tenants (id uuid PRIMARY KEY, name text)`);
      await client.query(
        `INSERT INTO tenants VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b')`,
      );
    });
    const report = await preflightMigrations(urlFor('nexa_preflight_nokind'));
    expect(report.checks).toContain('tenants.kind: absent, nothing to check');
  }, 60_000);

  it('lets a fresh database migrate all the way, preflight included', async () => {
    await createScratch('nexa_preflight_fresh', async () => {});
    await expect(runMigrations(urlFor('nexa_preflight_fresh'))).resolves.toBeUndefined();
    // And a second run — the migrated shape now has exactly one or zero
    // PRIMARY rows by construction — passes again.
    const report = await preflightMigrations(urlFor('nexa_preflight_fresh'));
    expect(report.checks).toContain('PRIMARY tenants: 0');
  }, 120_000);

  it('passes the ordinary test database, which is migrated and has one PRIMARY at most', async () => {
    const report = await preflightMigrations(config.DATABASE_URL);
    expect(report.checks.at(-1)).toMatch(/^PRIMARY tenants: [01]$/);
  });
});
