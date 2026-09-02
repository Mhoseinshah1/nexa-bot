import type {
  AuditWriter,
  Clock,
  IdGenerator,
  IdempotencyStore,
  Logger,
  OperationalEventRecorder,
  PasswordHasher,
  SecretCipher,
  TenantId,
} from '@nexa/contracts';
import { createTranslator } from '@nexa/i18n';
import type { Translator } from '@nexa/contracts';

import type { AppConfig } from './infrastructure/config/config.schema.js';
import { SystemClock } from './infrastructure/clock.js';
import { Uuidv7IdGenerator } from './infrastructure/ids.js';
import { AesGcmSecretCipher } from './infrastructure/crypto/secret-cipher.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { createDatabase, type DatabaseHandle } from './infrastructure/persistence/database.js';
import { createRedis, type RedisHandle } from './infrastructure/redis/redis.js';
import { DrizzleUnitOfWork } from './infrastructure/persistence/unit-of-work.js';

import {
  DrizzleBotInstanceRepository,
  DrizzleTenantRepository,
} from './modules/platform/tenancy/infrastructure/drizzle-tenant.repository.js';
import { OutboxWriter } from './modules/platform/eventing/infrastructure/outbox-writer.js';
import { OutboxRelay } from './modules/platform/eventing/infrastructure/outbox-relay.js';
import { DrizzleAuditWriter } from './modules/platform/audit/infrastructure/drizzle-audit-writer.js';
import { DrizzleOperationalEventRecorder } from './modules/platform/opslog/infrastructure/drizzle-operational-events.js';
import { DrizzleIdempotencyStore } from './modules/platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { PermissionGuard } from './modules/platform/access/application/permission-guard.js';
import { AdminPermissionResolver } from './modules/platform/access/infrastructure/admin-permission-resolver.js';
import { ScryptPasswordHasher, scryptParamsFor } from './infrastructure/crypto/password-hasher.js';
import { DrizzleAdminRepository } from './modules/platform/identity/infrastructure/drizzle-admin.repository.js';
import { DrizzleRoleRepository } from './modules/platform/identity/infrastructure/drizzle-role.repository.js';
import { DrizzleSessionRepository } from './modules/platform/identity/infrastructure/drizzle-session.repository.js';
import { DrizzleLoginThrottleRepository } from './modules/platform/identity/infrastructure/drizzle-login-throttle.repository.js';
import { AuthenticationService } from './modules/platform/identity/application/authentication.service.js';
import { CredentialThrottle } from './modules/platform/identity/application/credential-throttle.js';
import { AdminManagementService } from './modules/platform/identity/application/admin-management.service.js';
import { BootstrapOwnerService } from './modules/platform/identity/application/bootstrap-owner.service.js';
import { RetentionSweeper } from './modules/platform/identity/application/retention-sweeper.js';
import { RecordPingService } from './modules/platform/system/application/record-ping.service.js';
import { PingLogConsumer } from './modules/platform/opslog/application/ping-log.consumer.js';

/**
 * The composition root.
 *
 * Ports are declared in `@nexa/contracts` and in each module's application
 * layer; adapters live in infrastructure. This is the single place they are
 * bound together, which is what keeps the dependency-inversion rule real rather
 * than aspirational — nothing else in the codebase constructs an adapter.
 */

export type ProcessRole = 'api' | 'worker';

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly cipher: SecretCipher;
  readonly translator: Translator;
  readonly database: DatabaseHandle;
  readonly redis: RedisHandle;
  readonly uow: DrizzleUnitOfWork;
  readonly tenants: DrizzleTenantRepository;
  readonly botInstances: DrizzleBotInstanceRepository;
  readonly outbox: OutboxWriter;
  readonly relay: OutboxRelay;
  readonly throttleSweeper: RetentionSweeper;
  readonly sessionSweeper: RetentionSweeper;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly idempotency: IdempotencyStore;
  readonly guard: PermissionGuard;
  readonly hasher: PasswordHasher;
  readonly admins: DrizzleAdminRepository;
  readonly roles: DrizzleRoleRepository;
  readonly sessions: DrizzleSessionRepository;
  readonly loginThrottle: DrizzleLoginThrottleRepository;
  readonly auth: AuthenticationService;
  readonly adminManagement: AdminManagementService;
  readonly bootstrapOwner: BootstrapOwnerService;
  /**
   * The primary tenant this installation serves.
   *
   * Resolved once at boot rather than taken from a request: one install serves
   * one customer (ADR-0001), and a caller-supplied tenant id on the login
   * surface would let anyone choose which tenant to attack. Null until a tenant
   * is provisioned, which the login surface reports as a configuration error
   * rather than authenticating against nothing.
   */
  readonly installationTenantId: TenantId | null;
  setInstallationTenant(tenantId: TenantId | null): void;
  readonly recordPing: RecordPingService;
  shutdown(): Promise<void>;
}

export function createContainer(config: AppConfig, role: ProcessRole): Container {
  const logger = createLogger(config.LOG_LEVEL, role);
  const clock = new SystemClock();
  const ids = new Uuidv7IdGenerator();
  const cipher = new AesGcmSecretCipher(config.SECRETS_KEK, config.SECRETS_KEK_ID);
  const translator = createTranslator();

  const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX, {
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
    idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
  const redis = createRedis(config.REDIS_URL);

  const uow = new DrizzleUnitOfWork(database.db);
  const tenants = new DrizzleTenantRepository(database.db);
  const botInstances = new DrizzleBotInstanceRepository(database.db, cipher);

  const outbox = new OutboxWriter(ids, clock);
  const audit = new DrizzleAuditWriter(database.db, ids, clock);
  const opsLog = new DrizzleOperationalEventRecorder(database.db, ids, clock);
  const idempotency = new DrizzleIdempotencyStore(database.db, ids);

  const hasher = new ScryptPasswordHasher(scryptParamsFor(config.PASSWORD_HASH_PROFILE));
  const admins = new DrizzleAdminRepository(database.db);
  const roles = new DrizzleRoleRepository(database.db, ids);
  const sessions = new DrizzleSessionRepository(database.db);
  const loginThrottle = new DrizzleLoginThrottleRepository(database.db);

  // The real resolver replaces Phase 0's placeholder, which granted nothing
  // because there were no admins. `SYSTEM_JOB` still holds only its explicit
  // contract set: nothing here reintroduces an actor-type bypass.
  const guard = new PermissionGuard(new AdminPermissionResolver(admins, roles, clock), opsLog);

  // One counter per subject for every path that checks a password: login and
  // `changeOwnPassword` both go through this, so an attacker locked out of one
  // cannot keep guessing the same credential on the other.
  const credentialThrottle = new CredentialThrottle(
    loginThrottle,
    opsLog,
    clock,
    {
      windowSeconds: config.LOGIN_THROTTLE_WINDOW_SECONDS,
      maxAttemptsPerUsername: config.LOGIN_MAX_ATTEMPTS_PER_USERNAME,
      maxAttemptsPerIp: config.LOGIN_MAX_ATTEMPTS_PER_IP,
      lockoutSeconds: config.LOGIN_LOCKOUT_SECONDS,
    },
    uow,
  );

  const auth = new AuthenticationService(
    admins,
    roles,
    sessions,
    loginThrottle,
    uow,
    hasher,
    audit,
    opsLog,
    clock,
    ids,
    config.SESSION_TTL_SECONDS,
    credentialThrottle,
    tenants,
    guard,
  );

  const adminManagement = new AdminManagementService(
    guard,
    uow,
    admins,
    roles,
    sessions,
    hasher,
    audit,
    opsLog,
    outbox,
    clock,
    ids,
    credentialThrottle,
  );

  const bootstrapOwner = new BootstrapOwnerService(
    uow,
    admins,
    roles,
    hasher,
    audit,
    outbox,
    clock,
    ids,
  );

  let installationTenantId: TenantId | null = null;

  const relay = new OutboxRelay(database.db, [new PingLogConsumer(opsLog)], clock, logger, {
    batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
    pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
    maxLagMs: config.OUTBOX_RELAY_MAX_LAG_MS,
  });

  // Comfortably past the longest window plus lockout the schema permits, so a
  // sweep can never remove a row something is still counting.
  const throttleRetentionSeconds =
    config.LOGIN_THROTTLE_WINDOW_SECONDS + config.LOGIN_LOCKOUT_SECONDS + 3_600;

  const throttleSweeper = new RetentionSweeper(
    {
      name: 'login-throttle',
      purge: (now, limit) => loginThrottle.purgeExpired(now, throttleRetentionSeconds, limit),
    },
    clock,
    logger,
    {
      // Hourly is ample: the rows this removes are already expired, and each
      // tick now drains the backlog rather than taking one batch off it.
      intervalMs: 3_600_000,
      // A minute after the worker starts, so a short-lived process still
      // sweeps once and a restart loop does not disable housekeeping.
      initialDelayMs: 60_000,
      batchSize: 5_000,
      // 5m rows in one pass is far past any plausible backlog; the ceiling
      // exists so housekeeping is bounded, not to ration it.
      maxBatchesPerTick: 1_000,
    },
  );

  const sessionSweeper = new RetentionSweeper(
    {
      name: 'admin-sessions',
      purge: (now, limit) =>
        sessions.purgeExpiredBefore(
          new Date(now.getTime() - config.SESSION_RETENTION_SECONDS * 1000),
          limit,
        ),
    },
    clock,
    logger,
    { intervalMs: 3_600_000, initialDelayMs: 60_000, batchSize: 5_000, maxBatchesPerTick: 1_000 },
  );

  const recordPing = new RecordPingService(guard, uow, outbox, audit, idempotency, clock, tenants);

  return {
    config,
    logger,
    clock,
    ids,
    cipher,
    translator,
    database,
    redis,
    uow,
    tenants,
    botInstances,
    outbox,
    relay,
    throttleSweeper,
    sessionSweeper,
    audit,
    opsLog,
    idempotency,
    guard,
    hasher,
    admins,
    roles,
    sessions,
    loginThrottle,
    auth,
    adminManagement,
    bootstrapOwner,
    get installationTenantId() {
      return installationTenantId;
    },
    setInstallationTenant(tenantId: TenantId | null) {
      installationTenantId = tenantId;
    },
    recordPing,
    async shutdown() {
      await relay.stop();
      await throttleSweeper.stop();
      await sessionSweeper.stop();
      await redis.close();
      await database.close();
    },
  };
}

export const CONTAINER = Symbol('CONTAINER');
