import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/load-config.js';
import { createDatabase } from './database.js';

/**
 * Applies pending migrations. Forward-only: an applied migration is never
 * edited, and a destructive change is expressed as expand/contract across two
 * releases rather than as an in-place ALTER.
 */
/** Resolved from this module's own location so it works from src and from dist. */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../../drizzle');
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDatabase(databaseUrl, 1);
  try {
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  console.warn(`Migrations applied to ${redact(config.DATABASE_URL)}`);
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
