import type { PoolClient } from 'pg';
import { createDatabase } from './database.js';
import { compareMigrations, expectedMigrations, migrationsFolder } from './migration-state.js';

/**
 * Conditions a database can be in that a migration will not survive, checked
 * BEFORE any migration runs.
 *
 * Migration 0015 creates a partial unique index that requires at most one
 * tenant with `kind = 'PRIMARY'`. A database seeded by an early development
 * build can hold more than one, and against such a database 0015 fails inside
 * PostgreSQL with a raw `23505` — after the update has taken its backup and
 * committed to migrating. 0015 is applied on every installation that exists
 * and is therefore immutable, and a later migration cannot help: execution
 * never reaches it.
 *
 * So the check lives here, in the path that runs before the migrator, and it
 * says what the migration would have said in words an operator can act on.
 * It never repairs anything: which tenant is the real one is not a decision
 * a script may take on production data.
 *
 * It reads with the database URL alone — no application secret — because the
 * contexts that migrate (an installer before first boot, a CI step, `botctl
 * update`) legitimately have nothing else.
 */

export class MigrationPreflightError extends Error {
  override readonly name = 'MigrationPreflightError';
}

export interface PreflightReport {
  /** What was examined, for the operator's log. Never a value from the data. */
  readonly checks: readonly string[];
}

export async function preflightMigrations(
  databaseUrl: string,
  options: {
    /** The journal the migrator is about to apply; the release's own unless a test names one. */
    readonly migrationsFolder?: string;
  } = {},
): Promise<PreflightReport> {
  const handle = createDatabase(databaseUrl, 1);
  const checks: string[] = [];
  try {
    await handle.withClient(async (client) => {
      // FIRST: every other check reads a schema this release can account for.
      await checkMigrationHistory(client, checks, options.migrationsFolder ?? migrationsFolder());
      // TWO checks, run independently.
      //
      // The primary-tenant check `return`s early when the tenants table is
      // absent, so writing the second one after it inside the same callback
      // would have skipped it silently on exactly the databases that most need
      // checking. A preflight that quietly stops checking is the shape this file
      // exists to refuse.
      await checkSinglePrimaryTenant(client, checks);
      await checkDistinctTelegramBotIds(client, checks);
    });
  } finally {
    await handle.close();
  }
  return { checks };
}

/**
 * The database's migration history is one this release's journal can account for.
 *
 * drizzle's migrator compares ONE number — the greatest `created_at` applied — with each journal
 * entry's `when`, and applies the entries newer than it. Nothing compares tags or hashes. So a
 * database migrated from a branch this release does not descend from is migrated WRONG, in
 * silence: the database that applied the roadmap branch's pre-sync `0219`–`0221` (stamped later
 * than main's `0219`–`0235`, which the sync placed before them and renumbered the roadmap's
 * three to `0236`–`0238`) had main's seventeen skipped as "already applied", and `0229` then
 * failed with `relation "legacy_read_set_runs" does not exist` and nothing saying why (final
 * review of PR #248).
 *
 * Refused by the SAME comparison readiness and the restore validation use
 * (`compareMigrations`): an applied row whose `created_at` the journal does not name (and is not
 * newer than all of it — the rollback shape, which stays allowed), a known `created_at` with a
 * different hash, or a gap. A database at any commit of main is a prefix of the journal and
 * passes; a fresh one has no table and passes.
 */
async function checkMigrationHistory(
  client: PoolClient,
  checks: string[],
  folder: string,
): Promise<void> {
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (table.rows[0]?.present !== true) {
    checks.push('migration history: none recorded, nothing to check');
    return;
  }
  const rows = await client.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations',
  );
  const verdict = compareMigrations(
    rows.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) })),
    expectedMigrations(folder),
  );
  checks.push(`migration history: ${verdict.state}`);
  if (verdict.state === 'diverged') {
    throw new MigrationPreflightError(
      "Migration preflight failed: this database's migration history does not match this " +
        `release's migration journal (${verdict.reason}). It was migrated by a build this ` +
        'release does not descend from — typically a branch before it was merged, whose ' +
        'migrations were later renumbered — and the migrator, which orders by timestamp alone, ' +
        'would skip migrations it believes applied and then fail on a missing relation. ' +
        'Nothing was migrated. A development or test database: drop it and migrate it from ' +
        'scratch. A database whose data matters: stop, and restore it to a release on main. ' +
        "See docs/deployment.md, 'Migration preflight'.",
    );
  }
}

/** Migration 0015 requires exactly one PRIMARY tenant. */
async function checkSinglePrimaryTenant(client: PoolClient, checks: string[]): Promise<void> {
  // Older than the tenants table, or newer than a schema that has one:
  // nothing to check, and saying so is the correct answer for both.
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.tenants') IS NOT NULL AS present`,
  );
  if (table.rows[0]?.present !== true) {
    checks.push('tenants table: absent, nothing to check');
    return;
  }
  const column = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'kind'
         ) AS present`,
  );
  if (column.rows[0]?.present !== true) {
    checks.push('tenants.kind: absent, nothing to check');
    return;
  }
  const primaries = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.tenants WHERE kind = 'PRIMARY'`,
  );
  const count = Number(primaries.rows[0]?.n ?? '0');
  checks.push(`PRIMARY tenants: ${count}`);
  if (count > 1) {
    throw new MigrationPreflightError(
      `Migration preflight failed: this database has ${count} tenants with kind = 'PRIMARY', ` +
        'and migration 0015_single_primary_tenant requires exactly one. ' +
        'This is the shape an early development seed leaves behind. ' +
        'Nothing was migrated. Decide which tenant is the real one and remove or re-kind the ' +
        'others — or, for a legacy development database, reset it — then retry. ' +
        "See docs/deployment.md, 'Migration preflight'.",
    );
  }
}

/**
 * Migration 0041 makes a non-null `telegram_bot_id` unique, and a duplicate
 * blocks it.
 *
 * Reachable on an installation that applied 0038 and then bound one bot to two
 * rows — which nothing prevented, because `bot_instances_username_key` is not
 * the identity and a BotFather rename makes the stored username stale
 * (OQ-TG-02). That is precisely the state 0041 exists to make impossible, so an
 * installation already in it would otherwise meet a raw uniqueness error with
 * the migration run half-done and nothing saying what to do about it.
 *
 * Reported, never repaired. Choosing which of two tenants keeps a bot decides
 * who goes on receiving messages, and a migration guessing would silently cut
 * one of them off — which is the harm 0041 is about.
 */
async function checkDistinctTelegramBotIds(client: PoolClient, checks: string[]): Promise<void> {
  const column = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bot_instances'
          AND column_name = 'telegram_bot_id'
     ) AS present`,
  );
  if (column.rows[0]?.present !== true) {
    checks.push('bot_instances.telegram_bot_id: absent, nothing to check');
    return;
  }
  // The COUNT of offending ids, never the ids themselves: this text reaches a
  // log, and a Telegram bot id names somebody's installation.
  const duplicates = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT telegram_bot_id FROM public.bot_instances
        WHERE telegram_bot_id IS NOT NULL
        GROUP BY telegram_bot_id HAVING count(*) > 1
     ) AS d`,
  );
  const count = Number(duplicates.rows[0]?.n ?? '0');
  checks.push(`Telegram bot ids bound more than once: ${count}`);
  if (count > 0) {
    throw new MigrationPreflightError(
      `Migration preflight failed: ${count} Telegram bot id(s) in this database are bound to ` +
        'more than one bot instance, and migration 0041_bot_instance_telegram_id_unique requires ' +
        "each to be bound once. Telegram delivers a bot's updates to ONE webhook, so those rows " +
        "were never all receiving anything — one was taking the other's messages. Nothing was " +
        'migrated. Decide which tenant keeps each bot, give the others their own, and retry. ' +
        "See docs/deployment.md, 'Migration preflight'.",
    );
  }
}
