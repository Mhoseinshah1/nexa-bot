import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { createDatabase } from './database.js';
import { MigrationPreflightError, preflightMigrations } from './preflight.js';

/**
 * Applies pending migrations. Forward-only: an applied migration is never
 * edited, and a destructive change is expressed as expand/contract across two
 * releases rather than as an in-place ALTER.
 *
 * This deliberately does NOT load the full application configuration. Migrations
 * run in contexts that legitimately have no application secrets — a CI step, an
 * installer before first boot, a restore from backup — and requiring the
 * key-encryption key here would make those fail for no reason. A database URL is
 * the only thing a migration needs.
 */

/** Resolved from this module's own location so it works from src and from dist. */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../../drizzle');
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  // Before the migrator, every time, whoever the caller is. `botctl update`
  // runs the preflight as its own step so it can say the update stopped
  // BEFORE migrating; this keeps the installer, CI and a developer's shell
  // under the same rule without each remembering to.
  await preflightMigrations(databaseUrl);
  const handle = createDatabase(databaseUrl, 1);
  try {
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
  } finally {
    await handle.close();
  }
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url || !url.startsWith('postgres')) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
      message: 'DATABASE_URL must be set to a postgres:// connection string to run migrations.',
    });
  }
  return url;
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (process.argv.includes('--preflight')) {
    // The check alone. `botctl update` runs this between the backup and the
    // migration so a refusal is reported as "the update stopped before
    // migrating" rather than as a migration that failed.
    const report = await preflightMigrations(databaseUrl);
    for (const check of report.checks) console.warn(`preflight: ${check}`);
    console.warn(`Migration preflight passed for ${redact(databaseUrl)}`);
    return;
  }
  await runMigrations(databaseUrl);
  console.warn(`Migrations applied to ${redact(databaseUrl)}`);
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    // A refusal this code decided on is printed as the sentence it wrote, and
    // exits 2 so a caller can tell "refused before migrating" from "the
    // migration failed". Anything else is a real error and keeps its detail.
    if (error instanceof MigrationPreflightError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof NexaError ? error.message : error);
    process.exitCode = 1;
  });
}
