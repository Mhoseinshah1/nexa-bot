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
    });
  } finally {
    await handle.close();
  }
  return { checks };
}
