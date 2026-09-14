import type { PoolClient } from 'pg';
import { createDatabase } from './database.js';

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

export async function preflightMigrations(databaseUrl: string): Promise<PreflightReport> {
  const handle = createDatabase(databaseUrl, 1);
  const checks: string[] = [];
  try {
    await handle.withClient(async (client) => {
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
