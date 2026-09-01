import { randomBytes } from 'node:crypto';
import { createContainer, type Container } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import type { AppConfig } from '../../apps/api/src/infrastructure/config/config.schema';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';

/**
 * Integration tests run against a real PostgreSQL and a real Redis.
 *
 * There is no mocked database anywhere in this suite, deliberately: the
 * invariants being tested live IN the database — CHECK constraints, unique
 * partial indexes, append-only triggers, FOR UPDATE SKIP LOCKED semantics — and
 * a mock cannot express any of them.
 *
 * Connection details come from the environment when it supplies them, so the
 * same suite runs against `docker compose up` locally, against natively started
 * services in a cloud session, and against service containers in CI.
 */

export const TEST_KEK = randomBytes(32).toString('base64');

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://nexa:nexa@127.0.0.1:5432/nexa_test',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    SECRETS_KEK: TEST_KEK,
    SECRETS_KEK_ID: 'test-1',
    AUTH_MODE: 'none',
    OUTBOX_RELAY_ENABLED: 'false',
    OUTBOX_RELAY_POLL_INTERVAL_MS: '50',
    ...overrides,
  });
}

let migrated = false;

export async function migrateOnce(databaseUrl: string): Promise<void> {
  if (migrated) return;
  await runMigrations(databaseUrl);
  migrated = true;
}

/**
 * Truncates every table between tests.
 *
 * `audit_logs` and `processed_messages` refuse DELETE by trigger, which is the
 * point of them — TRUNCATE bypasses row triggers, so the guard stays in force
 * for application code while tests can still reset.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    `TRUNCATE TABLE
       audit_logs, operational_events, outbox_messages, processed_messages,
       request_idempotency, aggregate_sequences,
       bot_instances, tenants
     RESTART IDENTITY CASCADE` as never,
  );
}

export interface TestContext {
  readonly container: Container;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestContext(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<TestContext> {
  const config = testConfig(overrides);
  await migrateOnce(config.DATABASE_URL);

  const container = createContainer(config, 'worker');

  return {
    container,
    async reset() {
      await resetDatabase(container.database.db);
      await seed(container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
    },
    async close() {
      await container.shutdown();
    },
  };
}

export { SEED_IDS };

export const tenantA = { tenantId: SEED_IDS.tenantA as never, botInstanceId: null };
export const tenantB = { tenantId: SEED_IDS.tenantB as never, botInstanceId: null };
