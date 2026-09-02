import { randomBytes } from 'node:crypto';
import type { ActorContext, AdminId, CorrelationId, RoleId, TenantContext } from '@nexa/contracts';
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
    AUTH_MODE: 'password',
    // Real scrypt, weak parameters. The suite hashes on nearly every test; at
    // production cost it would spend minutes doing nothing else. Production is
    // forbidden this value by the config schema, and a unit test hashes at
    // production strength so the real parameters are still exercised.
    PASSWORD_HASH_PROFILE: 'fast',
    // The suite drives the app directly, with no proxy in front of it. Stated
    // explicitly, because an empty trusted list now means something specific.
    DEPLOYMENT_TOPOLOGY: 'direct',
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
       admin_login_throttle, admin_sessions, admin_permission_overrides,
       admin_roles, role_permissions, roles, admins,
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

// ---------------------------------------------------------------------------
// Identity fixtures
// ---------------------------------------------------------------------------

/**
 * Creates an administrator directly, bypassing the management service.
 *
 * Deliberate: a test that needs "an operator exists" should not have to first
 * authenticate an owner and call an endpoint, and the tests that DO exercise
 * the service must not have their subject created by it. Passwords go through
 * the real hasher, so nothing here stores a credential in a way production
 * would not.
 */
export interface SeededAdmin {
  readonly id: AdminId;
  readonly username: string;
  readonly password: string;
}

export async function createAdmin(
  container: Container,
  scope: TenantContext,
  options: {
    username: string;
    password?: string;
    roleKeys?: readonly string[];
    status?: 'ACTIVE' | 'DISABLED';
    displayName?: string;
    telegramUserId?: string | null;
  },
): Promise<SeededAdmin> {
  const password = options.password ?? 'a-perfectly-fine-password';
  const now = container.clock.now();
  const id = container.ids.uuid() as AdminId;

  await container.roles.ensureSystemRoles(scope);
  await container.admins.create(scope, {
    id,
    username: options.username,
    displayName: options.displayName ?? options.username,
    passwordHash: await container.hasher.hash(password),
    telegramUserId: options.telegramUserId ?? null,
    now,
  });

  const roleKeys = options.roleKeys ?? [];
  if (roleKeys.length > 0) {
    const { found, missing } = await container.roles.idsForKeys(scope, roleKeys);
    if (missing.length > 0) throw new Error(`Unknown seed role(s): ${missing.join(', ')}`);
    await container.roles.setAdminRoles(
      scope,
      id,
      roleKeys.map((key) => found.get(key) as RoleId),
      null,
    );
  }

  if (options.status === 'DISABLED') {
    await container.admins.setStatus(scope, id, 'DISABLED', now);
  }

  return { id, username: options.username, password };
}

/** The actor an authenticated administrator acts as in service-level tests. */
export function adminActorFor(admin: SeededAdmin): ActorContext {
  return {
    type: 'WEB_ADMIN',
    id: admin.id,
    label: admin.username,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
  };
}
