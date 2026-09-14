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

  it('refuses a database where one Telegram bot is bound twice, before 0041 runs', async () => {
    /*
     * Migration 0041 makes a non-null `telegram_bot_id` unique, and an
     * installation that applied 0038 and then bound one bot to two rows meets a
     * raw uniqueness error with the migration run half-done — which is the state
     * 0041 exists to make impossible, so it is exactly the database that reaches
     * it. Nothing prevented that shape: `bot_instances_username_key` is not the
     * identity, and a BotFather rename makes the stored username stale
     * (OQ-TG-02).
     */
    await createScratch('nexa_preflight_bots', async (client) => {
      await client.query(
        `CREATE TABLE bot_instances (id uuid PRIMARY KEY, username text NOT NULL, telegram_bot_id text)`,
      );
      await client.query(
        `INSERT INTO bot_instances VALUES
           (gen_random_uuid(), 'acme_bot', '8123456789'),
           (gen_random_uuid(), 'acme_support_bot', '8123456789'),
           (gen_random_uuid(), 'other_bot', '5555555555'),
           (gen_random_uuid(), 'legacy_bot', NULL)`,
      );
    });
    const url = urlFor('nexa_preflight_bots');

    await expect(preflightMigrations(url)).rejects.toBeInstanceOf(MigrationPreflightError);
    await expect(preflightMigrations(url)).rejects.toThrow(/1 Telegram bot id\(s\)/);
    await expect(preflightMigrations(url)).rejects.toThrow(/0041_bot_instance_telegram_id_unique/);
    await expect(preflightMigrations(url)).rejects.toThrow(/Nothing was migrated/);
    // The id itself is NEVER in the message: this text reaches a log, and a
    // Telegram bot id names somebody's installation.
    await expect(preflightMigrations(url)).rejects.not.toThrow(/8123456789/);

    // And nothing was chosen on the operator's behalf. Which tenant keeps a bot
    // decides who goes on receiving messages.
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const count = await client.query(`SELECT count(*)::int AS n FROM bot_instances`);
      expect(count.rows[0]?.n).toBe(4);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('passes a database whose bot ids are distinct, nulls and all', async () => {
    // The other half. A preflight that refuses a healthy database is the same
    // defect from the other side — and several NULLs are the ordinary shape of
    // an installation upgrading from before 0038.
    await createScratch('nexa_preflight_bots_ok', async (client) => {
      await client.query(
        `CREATE TABLE bot_instances (id uuid PRIMARY KEY, username text NOT NULL, telegram_bot_id text)`,
      );
      await client.query(
        `INSERT INTO bot_instances VALUES
           (gen_random_uuid(), 'acme_bot', '8123456789'),
           (gen_random_uuid(), 'other_bot', '5555555555'),
           (gen_random_uuid(), 'legacy_one', NULL),
           (gen_random_uuid(), 'legacy_two', NULL)`,
      );
    });
    const report = await preflightMigrations(urlFor('nexa_preflight_bots_ok'));
    expect(report.checks).toContain('Telegram bot ids bound more than once: 0');
  }, 60_000);

  it('passes a database with no bot_instances table at all', async () => {
    // The check must not become the reason a fresh database cannot migrate.
    await createScratch('nexa_preflight_no_bots', async (client) => {
      await client.query(`CREATE TABLE unrelated (id uuid PRIMARY KEY)`);
    });
    const report = await preflightMigrations(urlFor('nexa_preflight_no_bots'));
    expect(report.checks).toContain('bot_instances.telegram_bot_id: absent, nothing to check');
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
    // By CONTENT, not by position. This asserted `checks.at(-1)`, which was only
    // ever right while there was exactly one check — so adding a second one made
    // it fail for a reason that had nothing to do with what it was checking.
    expect(report.checks.some((check) => /^PRIMARY tenants: [01]$/.test(check))).toBe(true);
    expect(report.checks).toContain('Telegram bot ids bound more than once: 0');
  });
});
