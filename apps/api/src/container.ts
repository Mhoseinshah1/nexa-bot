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

import { acceptsV1, type AppConfig } from './infrastructure/config/config.schema.js';
import { readFileSync } from 'node:fs';
import { SafeHttpClient } from './infrastructure/net/safe-http.js';
import { DrizzlePanelRepository } from './modules/platform/panels/infrastructure/drizzle-panel.repository.js';
import { DrizzlePanelCredentialStore } from './modules/platform/panels/infrastructure/drizzle-panel-credentials.js';
import { PanelService } from './modules/platform/panels/application/panel.service.js';
import { providerAdapter } from './modules/platform/providers/infrastructure/adapter-registry.js';
import { SystemClock } from './infrastructure/clock.js';
import { Uuidv7IdGenerator } from './infrastructure/ids.js';
import { AesGcmSecretCipher } from './infrastructure/crypto/secret-cipher.js';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
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
import { DrizzleBootstrapRecordReader } from './modules/platform/identity/infrastructure/drizzle-bootstrap-record.reader.js';
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
import { DrizzleOperationalEventReader } from './modules/platform/opslog/infrastructure/drizzle-operational-event.reader.js';
import { OpsLogService } from './modules/platform/opslog/application/opslog.service.js';
import { DrizzleSettingRepository } from './modules/control/settings/infrastructure/drizzle-settings.repository.js';
import { SettingsResolver } from './modules/control/settings/application/settings-resolver.js';
import { SettingsService } from './modules/control/settings/application/settings.service.js';
import { DrizzleFeatureFlagRepository } from './modules/control/features/infrastructure/drizzle-feature-flags.repository.js';
import {
  FeatureFlagResolver,
  FeatureFlagsService,
} from './modules/control/features/application/feature-flags.service.js';
import { DrizzleTemplateRepository } from './modules/control/templates/infrastructure/drizzle-template.repository.js';
import { TemplateResolver } from './modules/control/templates/application/template-resolver.js';
import { I18nTemplateCatalogue } from './modules/control/templates/infrastructure/i18n-template-catalogue.js';
import { TemplateManagementService } from './modules/control/templates/application/template-management.service.js';
import { DrizzleNotificationRepository } from './modules/control/notifications/infrastructure/drizzle-notification.repository.js';
import { NotificationService } from './modules/control/notifications/application/notification.service.js';
import { NotificationDispatcher } from './modules/control/notifications/application/notification-dispatcher.js';
import { NotifyingOperationalEventRecorder } from './modules/control/notifications/application/operational-event-projector.js';
import { TelegramNotificationTransport } from './modules/control/notifications/infrastructure/telegram-transport.js';
import { RecordingTransport } from './modules/control/notifications/infrastructure/recording-transport.js';
import type { NotificationTransport } from './modules/control/notifications/application/ports.js';

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
  /**
   * The recorder WITHOUT the notification projection.
   *
   * Exposed because two collaborators must not go through the façade: the
   * settings resolver the projection itself reads, and the dispatcher that
   * drains the queue the projection writes into. Both would otherwise be
   * producers of the work they consume.
   */
  readonly opsLogWriter: OperationalEventRecorder;
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

  // Control plane — Phase 2
  readonly panels: PanelService;
  readonly settingsService: SettingsService;
  readonly settingsResolver: SettingsResolver;
  readonly featureFlags: FeatureFlagsService;
  readonly featureFlagResolver: FeatureFlagResolver;
  readonly templatesService: TemplateManagementService;
  readonly templateResolver: TemplateResolver;
  /** Exposed for the tests that drive the resolver against a substituted catalogue. */
  readonly templateRepository: DrizzleTemplateRepository;
  readonly notifications: NotificationService;
  /**
   * The repository behind it.
   *
   * Exposed so a test can drive the write path directly — the case that matters
   * is a delivery attempt arriving after its lease expired, which no sequence of
   * service calls can produce on purpose.
   */
  readonly notificationRepository: DrizzleNotificationRepository;
  readonly notificationDispatcher: NotificationDispatcher;
  readonly notificationTransport: NotificationTransport;
  readonly opsLogService: OpsLogService;

  shutdown(): Promise<void>;
}

export function createContainer(config: AppConfig, role: ProcessRole): Container {
  const logger = createLogger(config.LOG_LEVEL, role);
  const clock = new SystemClock();
  const ids = new Uuidv7IdGenerator();
  // One resolution of the keyring, used for both the cipher's keys and the
  // v1-acceptance default that depends on which spelling configured them.
  // Resolving it twice would let the two answers come from different parses.
  const keyring = resolveKeyring(config);
  const cipher = new AesGcmSecretCipher(keyring, acceptsV1(config, keyring));
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
  const idempotency = new DrizzleIdempotencyStore(database.db, ids);

  // The recorder everything writes through. It is wrapped further down, once
  // the notification service exists, so that recording an operational event and
  // announcing it are one call rather than two things a call site must remember
  // to do in the right order.
  const opsLogWriter = new DrizzleOperationalEventRecorder(database.db, ids, clock);
  const opsLogRef: { current: OperationalEventRecorder } = { current: opsLogWriter };
  // A stable façade, so everything constructed before the projector still ends
  // up going through it. Without this the guard, the throttle and the resolver
  // would each hold the bare writer and their events would never be announced.
  const opsLog: OperationalEventRecorder = {
    // Every parameter forwarded, `tx` included. Dropping it here silently
    // un-did the atomicity the projector exists to provide: the recorder would
    // open its own connection, and an event written inside a caller's
    // transaction survived that transaction rolling back.
    record: (scope, event, tx) => opsLogRef.current.record(scope, event, tx),
  };

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
    new DrizzleBootstrapRecordReader(database.db),
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

  // ---------------------------------------------------------------------------
  // Control plane
  // ---------------------------------------------------------------------------

  const settingRepository = new DrizzleSettingRepository(database.db);
  const settingsResolver = new SettingsResolver(settingRepository, opsLog);
  /**
   * One HTTP client for every provider call this process makes.
   *
   * Built here with the installation's policy and budgets bound in, so an
   * adapter receives a client it cannot widen. Nothing else in the process
   * constructs one.
   */
  const panelHttp = new SafeHttpClient({
    allowLoopback: config.PANEL_HTTP_ALLOW_LOOPBACK,
    // Read once, at construction. A per-request read would put a filesystem
    // call on every probe, and a bundle that vanished mid-run would turn a
    // configuration mistake into an intermittent TLS failure.
    ...(config.PANEL_HTTP_CA_FILE === undefined
      ? {}
      : { caCertificates: [readFileSync(config.PANEL_HTTP_CA_FILE, 'utf8')] }),
    totalTimeoutMs: config.PANEL_HTTP_TIMEOUT_MS,
    maxResponseBytes: config.PANEL_HTTP_MAX_RESPONSE_BYTES,
    // No retry on an operator-triggered probe. Scheduled probing in 3C owns
    // its own backoff; a client that retried underneath it would multiply the
    // two.
    maxRetries: 0,
  });

  const settingsService = new SettingsService(
    guard,
    uow,
    settingRepository,
    settingsResolver,
    audit,
    outbox,
    idempotency,
    clock,
    ids,
    tenants,
    // The RAW recorder: a repair closes the condition the resolver opened, and
    // the projecting decorator reads settings to decide whether to notify.
    opsLogWriter,
    // For the mutation-time session-revocation check.
    sessions,
  );

  const featureFlagRepository = new DrizzleFeatureFlagRepository(database.db);
  const featureFlagResolver = new FeatureFlagResolver(featureFlagRepository);
  const featureFlags = new FeatureFlagsService(
    guard,
    uow,
    featureFlagRepository,
    featureFlagResolver,
    settingsResolver,
    audit,
    outbox,
    idempotency,
    clock,
    ids,
    tenants,
    // The RAW recorder. A denial's event is written after its transaction has
    // rolled back, so it must not travel through the projector's transaction.
    opsLogWriter,
    // For the mutation-time session-revocation check.
    sessions,
  );

  const templateRepository = new DrizzleTemplateRepository(database.db);
  const templateCatalogue = new I18nTemplateCatalogue();
  const templateResolver = new TemplateResolver(
    templateRepository,
    featureFlagResolver,
    templateCatalogue,
  );
  const templatesService = new TemplateManagementService(
    guard,
    uow,
    templateRepository,
    featureFlagResolver,
    templateCatalogue,
    audit,
    outbox,
    idempotency,
    clock,
    ids,
    tenants,
    // The RAW recorder, for the same reason as above: a denial is recorded
    // after its transaction has already rolled back.
    opsLogWriter,
    // For the mutation-time session-revocation check.
    sessions,
  );

  const notificationRepository = new DrizzleNotificationRepository(database.db, ids);

  // A second resolver, wired to the RAW recorder rather than to the façade.
  //
  // `SettingsResolver` records an operational event when a stored value no
  // longer parses, and the projection below reads settings. Wiring the
  // projection path through the façade would therefore make one bad stored value
  // record an event, which projects, which reads settings, which records an
  // event. This removes the cycle instead of detecting it at runtime.
  const projectionSettings = new SettingsResolver(settingRepository, opsLogWriter);

  const notifications = new NotificationService(
    guard,
    notificationRepository,
    projectionSettings,
    featureFlagResolver,
    clock,
    ids,
    audit,
    idempotency,
    uow,
    // The RAW recorder: a denial is recorded after its transaction has already
    // rolled back.
    opsLogWriter,
    // For the mutation-time session-revocation check.
    sessions,
  );

  // Recording and announcing become one call from here on. Everything that
  // already holds `opsLog` holds the façade, so this reaches them too.
  opsLogRef.current = new NotifyingOperationalEventRecorder(
    opsLogWriter,
    notifications,
    projectionSettings,
    uow,
    logger,
  );

  const notificationTransport: NotificationTransport =
    config.NOTIFICATION_TRANSPORT === 'recording'
      ? new RecordingTransport()
      : new TelegramNotificationTransport(
          botInstances,
          config.TELEGRAM_API_BASE_URL,
          config.NOTIFICATION_SEND_TIMEOUT_MS,
        );

  const notificationDispatcher = new NotificationDispatcher(
    notificationRepository,
    notificationTransport,
    templateResolver,
    settingsResolver,
    clock,
    ids,
    logger,
    // The RAW recorder, on the same argument as `projectionSettings` above: the
    // façade projects an event into a notification intent, and this is the
    // object that drains that queue. A withdrawn sweep would queue a message
    // for the dispatcher that withdrew it.
    opsLogWriter,
    {
      pollIntervalMs: config.NOTIFICATION_DISPATCH_INTERVAL_MS,
      batchSize: config.NOTIFICATION_DISPATCH_BATCH_SIZE,
      leaseMs: config.NOTIFICATION_CLAIM_LEASE_MS,
      baseBackoffMs: config.NOTIFICATION_BACKOFF_BASE_MS,
      maxBackoffMs: config.NOTIFICATION_BACKOFF_MAX_MS,
    },
  );

  const opsLogService = new OpsLogService(guard, new DrizzleOperationalEventReader(database.db));

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
    opsLogWriter,
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
      // The dispatcher runs for the installation but the rate ceiling is a
      // tenant setting. One install serves one customer (ADR-0001), so the
      // primary tenant's ceiling is the installation's — stated here rather
      // than assumed somewhere further down.
      notificationDispatcher.setRateLimitScope(
        tenantId === null ? null : { tenantId, botInstanceId: null },
      );
    },
    recordPing,
    panels: new PanelService({
      repository: new DrizzlePanelRepository(database.db),
      credentials: new DrizzlePanelCredentialStore(database.db, cipher),
      guard,
      audit,
      opsLog,
      sessions,
      uow,
      idempotency,
      clock,
      ids,
      http: panelHttp,
      urlPolicy: { allowLoopback: config.PANEL_HTTP_ALLOW_LOOPBACK },
      adapters: providerAdapter,
    }),
    settingsService,
    settingsResolver,
    featureFlags,
    featureFlagResolver,
    templatesService,
    templateResolver,
    templateRepository,
    notifications,
    notificationRepository,
    notificationDispatcher,
    notificationTransport,
    opsLogService,
    async shutdown() {
      await relay.stop();
      await notificationDispatcher.stop();
      await throttleSweeper.stop();
      await sessionSweeper.stop();
      await redis.close();
      await database.close();
    },
  };
}

export const CONTAINER = Symbol('CONTAINER');
