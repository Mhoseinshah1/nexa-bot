import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { testConfig } from './harness';
import {
  MigrationPreflightError,
  preflightMigrations,
} from '../../apps/api/src/infrastructure/persistence/preflight';
import {
  migrationsFolder,
  runMigrations,
} from '../../apps/api/src/infrastructure/persistence/migrate';

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

/*
 * Final review of PR #248 — a database migrated from a branch this release does not descend
 * from. The roadmap branch, before it was synced with main, shipped its three support-AI
 * migrations as 0219–0221 with the `when` stamps below. The sync put main's 0219–0235 (older
 * stamps) before them and renumbered the roadmap's three to 0236–0238 with new stamps, the SQL
 * unchanged. drizzle's migrator orders by the greatest applied `created_at` alone, so on such a
 * database it skips main's earlier-stamped migrations as "applied" and fails at 0229 on a
 * relation one of them creates. The preflight refuses it first, and says why.
 *
 * Both journals are rebuilt here from this tree, so the test needs no git history: the pre-sync
 * roadmap journal is the merged one up to 0218 plus those three entries under their OLD tags and
 * stamps, and main's head is the merged one without 0236–0238.
 */
const PRE_SYNC_ROADMAP = [
  {
    tag: '0219_support_ai_session_budget',
    when: 1791401305405,
    now: '0236_support_ai_session_budget',
  },
  {
    tag: '0220_support_ai_progress_handoff',
    when: 1791406164078,
    now: '0237_support_ai_progress_handoff',
  },
  {
    tag: '0221_support_ai_handoff_context_age',
    when: 1791431732630,
    now: '0238_support_ai_handoff_context_age',
  },
] as const;

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

describe('the migration preflight refuses a history this release cannot account for', () => {
  const source = migrationsFolder();
  const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
    readonly version: string;
    readonly dialect: string;
    readonly entries: readonly JournalEntry[];
  };
  const index = (tag: string) => journal.entries.findIndex((entry) => entry.tag === tag);
  let root: string;

  /** A migrations folder holding `entries`, each file copied from this tree under `from`. */
  const folderOf = (name: string, entries: readonly (JournalEntry & { from: string })[]) => {
    const folder = join(root, name);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    for (const entry of entries) {
      copyFileSync(join(source, `${entry.from}.sql`), join(folder, `${entry.tag}.sql`));
    }
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: journal.version,
        dialect: journal.dialect,
        entries: entries.map(({ from: _from, ...entry }, idx) => ({ ...entry, idx })),
      }),
    );
    return folder;
  };
  const applyFolder = async (url: string, folder: string) => {
    const handle = createDatabase(url, 1);
    try {
      await migrate(handle.db, { migrationsFolder: folder });
    } finally {
      await handle.close();
    }
  };

  const ROADMAP_DB = 'nexa_preflight_roadmap';
  const MAIN_DB = 'nexa_preflight_main';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'nexa-preflight-'));
    for (const name of [ROADMAP_DB, MAIN_DB]) await dropScratch(name);
  }, 60_000);
  afterAll(async () => {
    for (const name of [ROADMAP_DB, MAIN_DB, 'nexa_preflight_fresh']) await dropScratch(name);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('the journal this test rebuilds from is the one the sync produced', () => {
    // The anchors the rebuild relies on; if a later change moves them, this says so first.
    expect(journal.entries[index('0219_legacy_read_set_runs')]?.tag).toBe(
      '0219_legacy_read_set_runs',
    );
    expect(index('0235_legacy_cutover_grants')).toBe(235);
    expect(journal.entries.slice(236, 239).map((entry) => entry.tag)).toEqual(
      PRE_SYNC_ROADMAP.map((entry) => entry.now),
    );
  });

  it('refuses a database migrated from the pre-sync roadmap branch, before anything is migrated', async () => {
    const roadmap = folderOf('roadmap', [
      ...journal.entries.slice(0, index('0219_legacy_read_set_runs')).map((entry) => ({
        ...entry,
        from: entry.tag,
      })),
      ...PRE_SYNC_ROADMAP.map(({ tag, when, now }) => ({
        idx: 0,
        version: '7',
        when,
        tag,
        breakpoints: true,
        from: now,
      })),
    ]);
    await createScratch(ROADMAP_DB, async () => {});
    const url = urlFor(ROADMAP_DB);
    await applyFolder(url, roadmap);

    // What the migrator does to it on its own: skips main's earlier-stamped migrations and
    // fails on a relation one of them creates. This is the failure with no explanation.
    await expect(applyFolder(url, source)).rejects.toThrow(/legacy_read_set_runs/);

    // The preflight names it instead, and `runMigrations` stops on it before the migrator.
    await expect(preflightMigrations(url)).rejects.toBeInstanceOf(MigrationPreflightError);
    await expect(preflightMigrations(url)).rejects.toThrow(
      /does not match this release's migration journal/,
    );
    await expect(preflightMigrations(url)).rejects.toThrow(/not in this release's journal/);
    await expect(preflightMigrations(url)).rejects.toThrow(/Nothing was migrated/);
    await expect(runMigrations(url)).rejects.toBeInstanceOf(MigrationPreflightError);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const rows = await client.query(
        `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      );
      expect(rows.rows[0]?.n).toBe(index('0219_legacy_read_set_runs') + PRE_SYNC_ROADMAP.length);
    } finally {
      await client.end();
    }
  }, 300_000);

  it('passes a database at main’s head, which then migrates to this release', async () => {
    const main = folderOf(
      'main',
      journal.entries.slice(0, index('0235_legacy_cutover_grants') + 1).map((entry) => ({
        ...entry,
        from: entry.tag,
      })),
    );
    await createScratch(MAIN_DB, async () => {});
    const url = urlFor(MAIN_DB);
    await applyFolder(url, main);

    const before = await preflightMigrations(url);
    expect(before.checks).toContain('migration history: behind');
    await expect(runMigrations(url)).resolves.toBeUndefined();
    const after = await preflightMigrations(url);
    expect(after.checks).toContain('migration history: current');
  }, 300_000);

  it('passes the ordinary test database, and a fresh one, by their history', async () => {
    expect((await preflightMigrations(config.DATABASE_URL)).checks).toContain(
      'migration history: current',
    );
    await createScratch('nexa_preflight_fresh', async () => {});
    expect((await preflightMigrations(urlFor('nexa_preflight_fresh'))).checks).toContain(
      'migration history: none recorded, nothing to check',
    );
  }, 60_000);
});
