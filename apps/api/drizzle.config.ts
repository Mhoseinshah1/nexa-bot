import type { Config } from 'drizzle-kit';

/**
 * Migrations are checked-in SQL files, generated from `schema.ts` and then
 * reviewed like any other code. They are forward-only: an applied migration is
 * never edited. Destructive changes go through expand/contract in two releases.
 *
 * `drizzle-kit push` is banned outside a throwaway local database — CI asserts
 * that the schema and the migration files agree (`scripts/check-migration-drift.sh`).
 */
export default {
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://nexa:nexa@127.0.0.1:5432/nexa_dev',
  },
  strict: true,
  verbose: false,
} satisfies Config;
