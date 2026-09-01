import type {
  AuditWriter,
  Clock,
  IdGenerator,
  IdempotencyStore,
  Logger,
  OperationalEventRecorder,
  SecretCipher,
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
import {
  NoAdminsPermissionResolver,
  PermissionGuard,
} from './modules/platform/access/application/permission-guard.js';
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
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly idempotency: IdempotencyStore;
  readonly guard: PermissionGuard;
  readonly recordPing: RecordPingService;
  shutdown(): Promise<void>;
}

export function createContainer(config: AppConfig, role: ProcessRole): Container {
  const logger = createLogger(config.LOG_LEVEL, role);
  const clock = new SystemClock();
  const ids = new Uuidv7IdGenerator();
  const cipher = new AesGcmSecretCipher(config.SECRETS_KEK, config.SECRETS_KEK_ID);
  const translator = createTranslator();

  const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const redis = createRedis(config.REDIS_URL);

  const uow = new DrizzleUnitOfWork(database.db);
  const tenants = new DrizzleTenantRepository(database.db);
  const botInstances = new DrizzleBotInstanceRepository(database.db, cipher);

  const outbox = new OutboxWriter(ids, clock);
  const audit = new DrizzleAuditWriter(database.db, ids, clock);
  const opsLog = new DrizzleOperationalEventRecorder(database.db, ids, clock);
  const idempotency = new DrizzleIdempotencyStore(database.db, ids);
  const guard = new PermissionGuard(new NoAdminsPermissionResolver(), opsLog);

  const relay = new OutboxRelay(database.db, [new PingLogConsumer(opsLog)], clock, logger, {
    batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
    pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
    maxLagMs: config.OUTBOX_RELAY_MAX_LAG_MS,
  });

  const recordPing = new RecordPingService(guard, uow, outbox, audit, idempotency, clock);

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
    audit,
    opsLog,
    idempotency,
    guard,
    recordPing,
    async shutdown() {
      await relay.stop();
      await redis.close();
      await database.close();
    },
  };
}

export const CONTAINER = Symbol('CONTAINER');
