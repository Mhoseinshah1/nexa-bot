import { fileURLToPath } from 'node:url';
import { MAX_REQUESTS_PER_PROBE, OPERATION_LEASE_SECONDS_MIN } from '@nexa/contracts';
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
import type { OperationType, TenantContext, Translator } from '@nexa/contracts';

import { acceptsV1, type AppConfig } from './infrastructure/config/config.schema.js';
import { readFileSync } from 'node:fs';
import { panelUrlPolicy } from './infrastructure/net/installation-policy.js';
import { SafeHttpClient } from './infrastructure/net/safe-http.js';
import {
  DrizzlePanelMonitorRepository,
  DrizzlePanelRepository,
} from './modules/platform/panels/infrastructure/drizzle-panel.repository.js';
import {
  effectiveProbeCooldownMs,
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
} from './modules/platform/panels/domain/monitor-cadence.js';
import type { MonitorCadence } from './modules/platform/panels/domain/monitor-cadence.js';
import { DrizzlePanelCredentialStore } from './modules/platform/panels/infrastructure/drizzle-panel-credentials.js';
import { PanelService } from './modules/platform/panels/application/panel.service.js';
import { PanelMonitorService } from './modules/platform/panels/application/panel-monitor.service.js';
import type { ProbeCoreDeps } from './modules/platform/panels/application/probe-core.js';
import {
  SERVICE_PROVIDER_TYPES,
  providerAdapter,
  providerServiceAdapter,
} from './modules/platform/providers/infrastructure/adapter-registry.js';
import { SystemClock } from './infrastructure/clock.js';
import { Uuidv7IdGenerator } from './infrastructure/ids.js';
import { AesGcmSecretCipher } from './infrastructure/crypto/secret-cipher.js';
import { hostname } from 'node:os';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
import { blocksReadiness } from './modules/platform/system/application/readiness.service.js';
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
import { ReadinessService } from './modules/platform/system/application/readiness.service.js';
import { DrizzleReadinessProbes } from './modules/platform/system/infrastructure/readiness-probes.js';
import { DrizzleAuditWriter } from './modules/platform/audit/infrastructure/drizzle-audit-writer.js';
import { DrizzleBootstrapRecordReader } from './modules/platform/identity/infrastructure/drizzle-bootstrap-record.reader.js';
import { DrizzleOperationalEventRecorder } from './modules/platform/opslog/infrastructure/drizzle-operational-events.js';
import { DrizzleIdempotencyStore } from './modules/platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import { PermissionGuard } from './modules/platform/access/application/permission-guard.js';
import { AdminPermissionResolver } from './modules/platform/access/infrastructure/admin-permission-resolver.js';
import { ScryptPasswordHasher, scryptParamsFor } from './infrastructure/crypto/password-hasher.js';
import { operationIdFor, sha256Hex } from './infrastructure/crypto/operation-id.js';
import { DrizzleAdminRepository } from './modules/platform/identity/infrastructure/drizzle-admin.repository.js';
import { DrizzleRoleRepository } from './modules/platform/identity/infrastructure/drizzle-role.repository.js';
import { DrizzleSessionRepository } from './modules/platform/identity/infrastructure/drizzle-session.repository.js';
import { DrizzleLoginThrottleRepository } from './modules/platform/identity/infrastructure/drizzle-login-throttle.repository.js';
import { AuthenticationService } from './modules/platform/identity/application/authentication.service.js';
import { CredentialThrottle } from './modules/platform/identity/application/credential-throttle.js';
import { AdminManagementService } from './modules/platform/identity/application/admin-management.service.js';
import { BootstrapOwnerService } from './modules/platform/identity/application/bootstrap-owner.service.js';
import { BotBootstrapService } from './modules/platform/tenancy/application/bot-bootstrap.service.js';
import { TelegramBotBootstrapGateway } from './modules/platform/tenancy/infrastructure/telegram-bot-bootstrap.gateway.js';
import { RetentionSweeper } from './modules/platform/identity/application/retention-sweeper.js';
import { RecordPingService } from './modules/platform/system/application/record-ping.service.js';
import { PingLogConsumer } from './modules/platform/opslog/application/ping-log.consumer.js';
import {
  DrizzleOperationalConditionReader,
  DrizzleOperationalEventReader,
} from './modules/platform/opslog/infrastructure/drizzle-operational-event.reader.js';
import { MonitorProfileService } from './modules/platform/panels/application/monitor-profile.service.js';
import { BackupService } from './modules/platform/backup/application/backup.service.js';
import { BackupScheduler } from './modules/platform/backup/application/backup-scheduler.js';
import { DrizzleBackupRunRepository } from './modules/platform/backup/infrastructure/drizzle-backup-run.repository.js';
import { DrizzleRecoveryRequestRepository } from './modules/platform/recovery/infrastructure/drizzle-recovery-request.repository.js';
import { FilesystemRecoveryWorkspaces } from './modules/platform/recovery/infrastructure/recovery-workspace.js';
import { FileCutoverJournal } from './modules/platform/recovery/infrastructure/cutover-journal.js';
import { RecoveryService } from './modules/platform/recovery/application/recovery.service.js';
import { BackupAdminService } from './modules/platform/recovery/application/backup-admin.service.js';
import { RecoveryExecutor } from './modules/platform/recovery/application/recovery-executor.js';
import { expectedMigrations } from './infrastructure/persistence/migration-state.js';
import type { InstallationWriteGate } from './infrastructure/persistence/write-gate.js';
import { KeyringBackupArchiver } from './modules/platform/backup/infrastructure/archiver.js';
import { PostgresDatabaseTools } from './modules/platform/backup/infrastructure/pg-tools.js';
import { TelegramBackupDelivery } from './modules/platform/backup/infrastructure/telegram-backup-delivery.js';
import { FilesystemBackupWorkspaces } from './modules/platform/backup/infrastructure/workspace.js';
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
import { CustomerService } from './modules/commerce/customers/application/customer.service.js';
import { DrizzleCustomerRepository } from './modules/commerce/customers/infrastructure/drizzle-customer.repository.js';
import { TelegramCustomerMessenger } from './modules/commerce/messaging/infrastructure/telegram-customer-messenger.js';
import { ProductService } from './modules/commerce/catalog/application/product.service.js';
import { ServiceAddonService } from './modules/commerce/catalog/application/addon.service.js';
import { CommercialActionService } from './modules/commerce/commercial/application/commercial-action.service.js';
import { DrizzleCommercialActionRepository } from './modules/commerce/commercial/infrastructure/drizzle-commercial-action.repository.js';
import { DrizzleServiceAddonRepository } from './modules/commerce/catalog/infrastructure/drizzle-addon.repository.js';
import {
  DrizzlePanelDirectory,
  DrizzleProductRepository,
} from './modules/commerce/catalog/infrastructure/drizzle-product.repository.js';
import { DrizzleWalletRepository } from './modules/commerce/wallet/infrastructure/drizzle-wallet.repository.js';
import { WalletService } from './modules/commerce/wallet/application/wallet.service.js';
import { DrizzlePaymentRepository } from './modules/commerce/payments/infrastructure/drizzle-payment.repository.js';
import { PaymentService } from './modules/commerce/payments/application/payment.service.js';
import { PaymentExpiryService } from './modules/commerce/payments/application/payment-expiry.service.js';
import {
  PaymentExpiryLoop,
  PAYMENT_EXPIRY_INTERVAL_MS,
} from './modules/commerce/payments/application/payment-expiry-loop.js';
import { OrderService } from './modules/commerce/orders/application/order.service.js';
import { DrizzleOrderRepository } from './modules/commerce/orders/infrastructure/drizzle-order.repository.js';
import { DrizzleServiceRepository } from './modules/commerce/provisioning/infrastructure/drizzle-service.repository.js';
import { serviceSecrets } from './infrastructure/crypto/service-secrets.js';
import { DrizzleOperationRepository } from './modules/commerce/provisioning/infrastructure/drizzle-operation.repository.js';
import { ProvisioningService } from './modules/commerce/provisioning/application/provisioning.service.js';
import { ServiceAdminService } from './modules/commerce/provisioning/application/service-admin.service.js';
import { decideOperability } from './modules/commerce/provisioning/application/panel-operability.js';
import { ProvisionerService } from './modules/commerce/provisioning/application/provisioner.service.js';
import { ProvisionerLoop } from './modules/commerce/provisioning/application/provisioner-loop.js';
import { DeliveryService } from './modules/commerce/provisioning/application/delivery.service.js';
import { CustomerNotificationService } from './modules/commerce/messaging/application/customer-notification.service.js';
import {
  CustomerNotificationLoop,
  CUSTOMER_NOTIFICATION_INTERVAL_MS,
} from './modules/commerce/messaging/application/customer-notification-loop.js';
import { DrizzleCustomerNotificationRepository } from './modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository.js';
import { CustomerNotifier } from './modules/commerce/messaging/application/customer-notifier.js';
import { OperationOutcomeAnnouncer } from './modules/commerce/messaging/application/operation-outcome-announcer.js';
import { DrizzleNotificationSubjectReader } from './modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader.js';
import { BotRuntime } from './surfaces/telegram/bot-runtime.js';
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

/**
 * Which entrypoint of the SAME image this process is.
 *
 * Not three images and not a flag that turns a subsystem on inside another
 * process: one module graph, three `main` files, and the container's `command`
 * chooses. `monitor` earns its own role because unattended outbound calls to
 * an operator's panels must not share an event loop with the webhook — a slow
 * panel would then be a slow Telegram response — and must not be woken by a
 * request at all.
 */
/**
 * The process roles, one entrypoint each, one module graph.
 *
 * `recovery` is the fourth and it is not the worker, deliberately. A restore
 * QUIESCES the outbox relay and the notification dispatcher, and a loop that
 * shares an event loop with the things it is shutting down has to reason about
 * its own shutdown — which is the one place that reasoning must be simple,
 * because it is the place that renames the production database. ADR-0028.
 */
/**
 * Which `main` this process is running.
 *
 * `provisioner` is the fifth, and it exists for the same reason `monitor` does not
 * live inside `worker`: its calls are outbound HTTPS to somebody else's machine with a
 * timeout measured in seconds. It is separate from `monitor` for the mirror of that
 * argument — the monitor's own comment says a monitor stuck on a hanging panel would
 * delay notification delivery, and a customer waiting for the configuration they paid
 * for must not queue behind a sweep of every panel in the installation.
 */
export type ProcessRole = 'api' | 'worker' | 'monitor' | 'recovery' | 'provisioner';

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
  /**
   * The readiness computation, in the application layer.
   *
   * Surfaces ask this; they do not ask the database, the cache or the relay.
   * See `ReadinessService` and `check-boundaries.sh`.
   */
  readonly readiness: ReadinessService;
  readonly throttleSweeper: RetentionSweeper;
  readonly sessionSweeper: RetentionSweeper;
  readonly backupRunSweeper: RetentionSweeper;
  readonly recoveryRequestSweeper: RetentionSweeper;
  /**
   * The lane that expires unpaid payments and the orders they were against.
   *
   * Started by the WORKER only. Nothing here dials anything, so it does not belong
   * beside the provisioner, whose whole reason for being a separate role is that a
   * wedged panel must not delay work that needs no panel.
   */
  readonly paymentExpiryLoop: PaymentExpiryLoop;
  /**
   * The customer notification lane's timer.
   *
   * In EVERY role's container and started only by `main.worker.ts`, for the reason the
   * comment above `paymentExpiryLoop` gives: a member that exists in one role's
   * container and not another's is a member whose absence is discovered at runtime.
   */
  readonly customerNotificationLoop: CustomerNotificationLoop;
  /** The lane's repository, shared so producers enqueue through the same object. */
  readonly customerNotifications: DrizzleCustomerNotificationRepository;
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
   * The fresh-install Telegram bootstrap. A CLI provisioning step like
   * `bootstrapOwner`, and fenced the same way: `check-boundaries.sh` fails the
   * build if a surface reaches either.
   */
  readonly bootstrapBot: BotBootstrapService;
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
  /**
   * Phase 4 — the customer-facing commerce lane.
   *
   * `botRuntime` is the only thing the Telegram surface needs: it owns the order of
   * operations (commit the state change, then reply outside the transaction) so a
   * controller cannot get it wrong.
   */
  readonly customers: CustomerService;
  readonly products: ProductService;
  readonly serviceAddons: ServiceAddonService;
  readonly commercialActions: CommercialActionService;
  readonly wallet: WalletService;
  readonly payments: PaymentService;
  readonly orders: OrderService;
  readonly botRuntime: BotRuntime;

  // Control plane — Phase 2
  readonly panels: PanelService;
  /**
   * The background health loop. Started only by the `monitor` entrypoint.
   *
   * Constructed in every role because the container is one graph, and started
   * in exactly one: an interval inside the API process would put unattended
   * outbound calls on the event loop that answers the Telegram webhook.
   */
  readonly panelMonitor: PanelMonitorService;
  /** Plans the service a settled order is owed. Held by payments, exposed for surfaces. */
  readonly provisioning: ProvisioningService;
  /**
   * Services as an OPERATOR reads them. Read-only, `services.view`.
   *
   * Separate from `provisioning` rather than a method on it, because that one plans
   * work: a read path that held it would be one call away from planning a provider
   * operation from a GET.
   */
  readonly serviceAdmin: ServiceAdminService;
  /** The lane that creates services on panels. Driven by the `provisioner` role. */
  readonly provisioner: ProvisionerService;
  /**
   * Telling a customer their service is ready.
   *
   * Exposed beside the provisioner and NOT folded into it: the two are deliberately
   * separate objects so that a failed Telegram message cannot reach a provisioning
   * transaction. The sweep is driven by `provisionerLoop`; a customer asking for their
   * configuration again reaches `redeliver` from a surface.
   */
  readonly delivery: DeliveryService;
  /** The timer that drives it, and the readiness signal that timer earns. */
  readonly provisionerLoop: ProvisionerLoop;
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
  /**
   * What the background monitor is configured to do, and what that
   * configuration can carry. A read of installation configuration plus two
   * pure capacity functions; it touches no repository and not the monitor.
   */
  readonly monitorProfileService: MonitorProfileService;

  /**
   * The backup pipeline. ONE service, for the scheduler and the operator alike.
   *
   * Constructed in every role, like the monitor, because the container is one
   * graph. Started — by `backupScheduler` — in exactly one: a dump on the API's
   * event loop would be a two-hour subprocess beside the webhook.
   */
  readonly backup: BackupService;
  readonly backupScheduler: BackupScheduler;
  /** Disaster recovery: the operator's service, and the destructive executor. */
  readonly recoveryService: RecoveryService;
  readonly backupAdmin: BackupAdminService;
  readonly recoveryExecutor: RecoveryExecutor;
  readonly recoveryRequests: DrizzleRecoveryRequestRepository;
  readonly recoveryWorkspaces: FilesystemRecoveryWorkspaces;
  /** Exposed so a test can drive the lock directly, and so `botctl` can list runs. */
  readonly backupRuns: DrizzleBackupRunRepository;
  /**
   * The archive reader and the PostgreSQL tools, for the restore command.
   *
   * The SAME instances the pipeline uses, which is the point: an operator's
   * restore goes through the decryption path the verification proved, not a
   * second one written for the CLI.
   */
  readonly backupArchiver: KeyringBackupArchiver;
  readonly backupTools: PostgresDatabaseTools;

  shutdown(): Promise<void>;
}

/**
 * Retries the panel HTTP client is allowed. Zero, and it is a NAMED zero.
 *
 * `SafeHttpClient` starts its deadline per attempt, so `maxRetries` multiplies
 * the wall time a probe can occupy — and the per-panel claim window is floored
 * on that wall time. Written as a literal in both places, raising one and not
 * the other would let a second probe start while the first is still on the
 * wire, which is precisely what the claim exists to prevent. One constant, two
 * readers.
 */
const PANEL_HTTP_RETRIES = 0;

/**
 * How much of a tenant's bucket the monitor must leave for its operator.
 *
 * Rounded UP, and never down to zero. A percentage of a small capacity floors
 * to nothing — forty percent of two is zero — and a zero reserve is the
 * invariant switched off exactly where it matters most: on a tenant with two
 * tokens, background monitoring would take both and an operator diagnosing an
 * outage would find no capacity to test their own panel with.
 *
 * The consequence at capacity 1 is deliberate and is the right way round: the
 * reserve is 1, the monitor is refused every time, and the single token belongs
 * to the operator. Monitoring is a convenience; being locked out of your own
 * panel is not.
 *
 * Zero percent means zero, and only zero percent does. It is the operator
 * saying they do not want the reserve, which is not the same as a rounding
 * accident producing none.
 *
 * `Math.max(1, ...)` is a floor for a capacity of ZERO, and nothing else:
 * `Math.ceil` of any positive fraction is already at least one, so for every
 * capacity the configuration permits the two are the same number. Mutation says
 * so — removing it changes no answer any test can produce — and it is recorded
 * as that rather than described as the rule. The rule is `ceil`.
 *
 * EXPORTED so it can be tested. It was an expression inside `createContainer`,
 * where every rule above was stated in this comment and enforced by arithmetic
 * that nothing named: the monitor suite passes `budgetReserve` as a literal, so
 * replacing `ceil` with `floor`, or dropping the `max(1, ...)`, left the whole
 * suite green.
 */
export function monitorBudgetReserveFor(capacity: number, percent: number): number {
  if (percent === 0) return 0;
  return Math.max(1, Math.ceil((capacity * percent) / 100));
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

  const database = createDatabase(
    config.DATABASE_URL,
    config.DATABASE_POOL_MAX,
    {
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    // Through the process logger rather than the default stderr line, so a
    // connection death is one structured record beside everything else this
    // process says. See `PoolErrorListener`: without a listener at all, `pg`
    // turns this into an uncaught exception and the process dies.
    (error) => {
      logger.error(
        { err: error.message },
        'a pooled PostgreSQL connection was closed by the server',
      );
    },
  );
  const redis = createRedis(config.REDIS_URL);

  /*
   * The recovery repository is built HERE, above the unit of work, because the
   * unit of work's write gate reads it.
   *
   * That is the only unusual ordering in this container, and it is the shape of
   * the dependency rather than a convenience: the quiesce has to be enforced
   * where transactions are opened (ADR-0028 § 5), so the thing that answers
   * "is the installation quiesced" must exist before the thing that opens them.
   * It takes only the database handle, so there is nothing circular about it.
   */
  const recoveryRequests = new DrizzleRecoveryRequestRepository(database.db);
  /*
   * ONE gate implementation, shared by both chokepoints.
   *
   * The unit of work and the outbox relay both consult it, and they consult the
   * SAME object rather than two closures over the same repository — because two
   * closures is two places the predicate could be written, and the predicate is
   * "are durable writes refused". A relay that answered that question
   * differently from the unit of work would be a relay publishing during a
   * cutover.
   */
  const writeGate: InstallationWriteGate = {
    async quiescedBy(tx) {
      const lock = await recoveryRequests.installationLock(tx);
      return lock !== null && lock.quiescing ? lock.recoveryId : null;
    },
  };
  const uow = new DrizzleUnitOfWork(database.db, writeGate);
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

  const bootstrapBot = new BotBootstrapService({
    uow,
    bots: botInstances,
    scopeActivity: tenants,
    audit,
    clock,
    ids,
    telegram: new TelegramBotBootstrapGateway(
      config.TELEGRAM_API_BASE_URL,
      config.NOTIFICATION_SEND_TIMEOUT_MS,
    ),
    webhookSecret: () => config.TELEGRAM_WEBHOOK_SECRET,
    webhookEnabled: () => config.TELEGRAM_WEBHOOK_ENABLED,
  });

  let installationTenantId: TenantId | null = null;

  const relay = new OutboxRelay(
    database.db,
    [new PingLogConsumer(opsLog)],
    clock,
    logger,
    {
      batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
      pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
      maxLagMs: config.OUTBOX_RELAY_MAX_LAG_MS,
    },
    database,
    writeGate,
  );

  // The readiness computation and the adapters that answer its questions. The
  // composition happens HERE, which is the only place that may know both.
  const readiness = new ReadinessService({
    probes: new DrizzleReadinessProbes(database, redis, relay),
    logger,
    clock,
    maxOutboxLagMs: config.OUTBOX_RELAY_MAX_LAG_MS,
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

  const recordPing = new RecordPingService(
    guard,
    uow,
    outbox,
    audit,
    idempotency,
    clock,
    tenants,
    opsLog,
  );

  /**
   * Customers, and the bot turn that resolves them.
   *
   * Built here rather than inline in the returned object because `BotRuntime` and the
   * container's own `customers` slot must be the SAME instance: two would each hold
   * their own idempotency view, and a replay handled by one would not be seen by the
   * other.
   */
  const customerRepository = new DrizzleCustomerRepository(database.db);
  const productRepository = new DrizzleProductRepository(database.db);

  const customerService = new CustomerService({
    repository: customerRepository,
    guard,
    audit,
    opsLog,
    sessions,
    // The same reader every other write path uses. Panels was the one module that
    // skipped it, which let a stopped tenant be given new panels.
    scopeActivity: tenants,
    uow,
    idempotency,
    outbox,
    clock,
    ids,
  });

  const settingRepository = new DrizzleSettingRepository(database.db);
  const settingsResolver = new SettingsResolver(settingRepository, opsLog);

  /**
   * Products, under the FROZEN `catalog.*` permissions.
   *
   * The same platform dependencies every other write path takes, `scopeActivity`
   * included — the reader panels once skipped, which let a stopped tenant be given new
   * rows. No outbox: the event catalogue declares no product event and
   * `AGGREGATE_TYPES` has no `Product`, so a product mutation's evidence is its audit
   * row.
   */
  const productService = new ProductService({
    repository: productRepository,
    /*
     * Membership only, never a panel projection.
     *
     * A product may not name another tenant's panel. `products_tenant_panel_fk`
     * (migration 0037) is what makes that true; this is what makes the refusal a
     * named 404 rather than an integrity violation reported as a 500.
     */
    panels: new DrizzlePanelDirectory(database.db),
    /* `sales.currency`. A product is priced in what the tenant sells in, or refused. */
    settings: settingsResolver,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    clock,
    ids,
  });

  /**
   * Service add-ons, under the SAME `catalog.*` permissions as products.
   *
   * The same kind of thing — a priced offer an operator curates — so the same pair.
   * Its own permissions would have meant a contracts change, a migration backfilling
   * grants into every existing role, and an operator who can edit the catalogue
   * discovering they cannot edit half of it.
   *
   * No `panels` dependency, and that is not an omission: an add-on names no panel. What
   * decides whether a customer may buy one is the SERVICE's panel and its declared
   * capability, asked by `decideOperability` where the operation is planned.
   */
  const serviceAddonRepository = new DrizzleServiceAddonRepository(database.db);

  const serviceAddonService = new ServiceAddonService({
    repository: serviceAddonRepository,
    /* `sales.currency`. An add-on is priced in what the tenant sells in, or refused. */
    settings: settingsResolver,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    clock,
    ids,
  });

  /**
   * The invoice line a commercial order carries.
   *
   * ONE instance, shared by the service that writes it and the settlement path that
   * reads it, so a replay handled by either is seen by both — the same reason
   * `customerRepository` is built here rather than inline.
   */
  const commercialActionRepository = new DrizzleCommercialActionRepository(database.db);

  /**
   * The wallet, under the FROZEN `users.wallet.*` permissions.
   *
   * `operationId` is bound HERE and not inside the service, for the reason
   * `operation.ts` gives: `packages/contracts` depends on nothing, so the hash is a
   * port the composition root supplies. One binding, so every movement's reference is
   * derived the same way in every process.
   */
  const walletRepository = new DrizzleWalletRepository(database.db);
  const walletService = new WalletService({
    repository: walletRepository,
    customers: customerRepository,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    settings: settingsResolver,
    uow,
    idempotency,
    outbox,
    clock,
    ids,
    operationId: (key) => operationIdFor('payment', key),
  });

  // ---------------------------------------------------------------------------
  // Control plane
  // ---------------------------------------------------------------------------

  /**
   * Orders, up to the boundary where money begins.
   *
   * Constructed HERE, after the settings resolver, because the draft's hold is an
   * operator setting (`sales.order_expiry_minutes`) and a service that hard-coded a
   * window would be a service the setting silently does not configure.
   *
   * It takes the same product and customer repositories the two services above hold —
   * one instance each, so there is one statement of each tenancy rule rather than two
   * that can drift. It takes the outbox because `OrderConfirmed` is a declared event
   * with a declared aggregate, which is exactly what products did not have.
   */
  /*
   * ONE payment repository for the order service, the payment service and the expiry lane.
   *
   * It used to be constructed inline at the payment service. Two instances would work
   * and would be two places for a later change to reach one of, which is how the probe
   * core came to have a copy — and this one is the object holding the conditional
   * UPDATEs that make the whole module's concurrency claims true.
   *
   * Constructed HERE, above the order service, because 4H gives a customer's own order
   * cancellation a narrow lane into it: a cancelled order must not leave a live
   * transfer instruction behind.
   */
  const paymentRepository = new DrizzlePaymentRepository(database.db);

  const orderRepository = new DrizzleOrderRepository(database.db);
  const orderService = new OrderService({
    repository: orderRepository,
    /*
     * The NARROW payment lane, not the repository.
     *
     * Two methods, both scoped to one order. Handing the order service the payment
     * repository would also hand it `confirm`, and an order command able to mark money
     * as received is exactly the boundary `OrderPaymentLane` exists to draw.
     */
    payments: {
      claimedPendingFor: (scope, orderId, tx) =>
        paymentRepository.hasClaimedPendingForOrder(scope, orderId, tx),
      withdrawPendingFor: (scope, orderId, now, tx) =>
        paymentRepository.cancelPendingForOrder(scope, orderId, now, tx),
    },
    products: productRepository,
    customers: customerRepository,
    settings: settingsResolver,
    guard,
    audit,
    opsLog,
    outbox,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    clock,
    ids,
  });
  /**
   * Payments, and the one place `SETTLE` is taken.
   *
   * It holds the ORDER and WALLET repositories rather than their services, and that is
   * deliberate: the debit, the confirmation and the order transition commit in ONE
   * transaction, and a service call would open its own. A payment that moved money but
   * left the order unpaid is the state this wiring makes unrepresentable.
   *
   * The same `operationId` binding the wallet uses, so a reference derived from one
   * idempotency key is the same value in every process.
   */
  /**
   * Services and the operations that create them.
   *
   * Constructed BEFORE payments, because payments holds it: the service a settled
   * order is owed is written in the settling transaction, which is what makes
   * exactly-once a unique index rather than a worker's discipline.
   *
   * The executor that acts on what this plans is built further down, after the panel
   * stack it needs exists.
   */
  /*
   * Constructed here rather than beside the rest of the panel stack, because this is
   * where it is first needed: the provisioning service asks whether a panel can be
   * operated before it plans a retry, and that question must be answerable without
   * decrypting anything.
   */
  const panelRepository = new DrizzlePanelRepository(database.db);
  const serviceRepository = new DrizzleServiceRepository(database.db);
  const operationRepository = new DrizzleOperationRepository(database.db);
  /**
   * A narrow closure, not the panel repository, and ONE of it.
   *
   * It answers from the panel's own fields and a credential SUMMARY — three timestamps,
   * no values — so a surface asking "can this be retried" cannot materialise a password
   * to find out. `decideOperability` is the single place that decision is made, here, in
   * the executor, and now in the commercial path that refuses before any money moves.
   *
   * Shared rather than copied, because two copies would be two chances for a Sanaei
   * service to be refused by one caller and charged by the other.
   */
  const panelOperability = {
    operability: async (
      scope: TenantContext,
      panelId: string,
      type: OperationType,
      tx?: unknown,
    ) => {
      const view = await panelRepository.find(scope, panelId, tx as never);
      return decideOperability({
        panel:
          view === null
            ? null
            : {
                status: view.panel.status,
                providerType: view.panel.providerType,
                baseUrl: view.panel.baseUrl,
                archivedAt: view.panel.archivedAt,
                activation: view.panel.activation,
              },
        credentials: view?.credentials ?? null,
        type,
        // The SERVICE list, not the connection one. `panel-operability.ts` documents
        // this field as "code exists that can create a user", and a provider can
        // legitimately have a connection adapter and no service half.
        serviceAdapterExists:
          view !== null && SERVICE_PROVIDER_TYPES.includes(view.panel.providerType),
      });
    },
  };

  const provisioningService = new ProvisioningService({
    services: serviceRepository,
    operations: operationRepository,
    panels: panelOperability,
    uow,
    guard,
    audit,
    clock,
    ids,
    operationId: (key) => operationIdFor('provider', key),
    // The same tenant kill switch every other write path reads.
    scopeActivity: tenants,
    // From the system CSPRNG, never from the id generator: see the binding's own note.
    secrets: serviceSecrets,
  });

  /**
   * Buying something for a service that already exists.
   *
   * It takes the SAME `panelOperability` closure the executor does, so a Sanaei-backed
   * service is refused here — before an order exists and before any money moves — with
   * the same answer the executor would have given after it. Two copies of that decision
   * would be two chances for a service to be refused by one and charged by the other.
   *
   * It writes the order and the invoice line and nothing else: payment is
   * `PaymentService`, unchanged, because a commercial order is an ordinary
   * `AWAITING_PAYMENT` order and wallet settlement works on it without knowing it is one.
   */
  const commercialActionService = new CommercialActionService({
    services: serviceRepository,
    products: productRepository,
    addons: serviceAddonRepository,
    orders: orderRepository,
    actions: commercialActionRepository,
    panels: panelOperability,
    settings: settingsResolver,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    outbox,
    clock,
    ids,
  });

  /**
   * The one way any producer queues a customer notification.
   *
   * Built here rather than per-producer so that the three parts that are easy to get
   * wrong — the id existing before the insert, the bot being the customer's OWN, and
   * the write landing inside the caller's transaction — have one implementation.
   *
   * The repository is constructed here too and shared with the dispatcher below, so a
   * producer and the lane that drains it cannot disagree about the table.
   */
  const customerNotificationRepository = new DrizzleCustomerNotificationRepository(database.db);
  const customerNotifier = new CustomerNotifier({
    notifications: customerNotificationRepository,
    bots: {
      /*
       * The bot the customer FIRST wrote to, which is the only durable link this
       * release records. `OQ-PROV-02` carries the column that would let a purchase name
       * the bot it came through; until then this is the honest answer rather than an
       * invented one, and it is the same value `DeliveryService` uses.
       */
      botFor: async (scope, customerId, tx) => {
        const found = await customerRepository.findById(scope, customerId, tx);
        return found?.firstBotInstanceId ?? null;
      },
    },
    ids,
  });

  const paymentService = new PaymentService({
    repository: paymentRepository,
    notifier: customerNotifier,
    orders: orderRepository,
    provisioning: provisioningService,
    /*
     * The READ alone, narrowed here rather than by the type.
     *
     * Settlement needs to know which service a commercial order acts on and must never
     * write an invoice line — that happens once, when the order is created, and the
     * table refuses an UPDATE anyway. Passing the whole repository would put the write
     * within reach of the one path that must not take it.
     */
    commercialActions: commercialActionRepository,
    wallet: walletRepository,
    customers: customerRepository,
    guard,
    // Reads `sales.payment_window_minutes` and nothing else — see `PaymentServiceDeps`.
    settings: settingsResolver,
    audit,
    opsLog,
    outbox,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    clock,
    ids,
    operationId: (key) => operationIdFor('payment', key),
  });

  /*
   * The expiry lane, built in every role and STARTED only by the worker.
   *
   * Built everywhere for the reason the recovery executor is: construction is cheap
   * and a member that exists in one role's container and not another's is a member
   * whose absence is discovered at runtime. Starting is the role's decision, and
   * `main.worker.ts` is the only file that calls `start()`.
   */
  const paymentExpiryLoop = new PaymentExpiryLoop(
    new PaymentExpiryService({
      payments: paymentRepository,
      notifier: customerNotifier,
      orders: orderRepository,
      uow,
      audit,
      scopeActivity: tenants,
      clock,
      ids,
    }),
    {
      // Resolved per pass: the installation's tenant is a row, so it is not known
      // while this object is being built. The same closure the backup scheduler and
      // the recovery executor use, and `PaymentExpiryLoop.tick` treats a null as a
      // healthy pass that had nothing to do.
      scope: () =>
        installationTenantId === null
          ? null
          : { tenantId: installationTenantId, botInstanceId: null },
      intervalMs: PAYMENT_EXPIRY_INTERVAL_MS,
      now: () => clock.now().getTime(),
      logger,
    },
  );

  /**
   * One HTTP client for every provider call this process makes.
   *
   * Built here with the installation's policy and budgets bound in, so an
   * adapter receives a client it cannot widen. Nothing else in the process
   * constructs one.
   */
  // One policy object, shared by the client and the service, so the URL a
  // panel is created with and the address the socket goes to are judged by
  // exactly the same rules. Two copies would be two things to keep in step.
  // The installation's own data network first and always, then whatever
  // extra networks the operator listed — see `panelUrlPolicy`, which the
  // deployment smoke test runs inside the real container against the real
  // environment.
  const urlPolicy = panelUrlPolicy(config);

  const panelCredentials = new DrizzlePanelCredentialStore(database.db, cipher);

  const panelHttp = new SafeHttpClient({
    ...urlPolicy,
    // Read once, at construction. A per-request read would put a filesystem
    // call on every probe, and a bundle that vanished mid-run would turn a
    // configuration mistake into an intermittent TLS failure.
    ...(config.PANEL_HTTP_CA_FILE === undefined
      ? {}
      : { caCertificates: [readFileSync(config.PANEL_HTTP_CA_FILE, 'utf8')] }),
    totalTimeoutMs: config.PANEL_HTTP_TIMEOUT_MS,
    maxResponseBytes: config.PANEL_HTTP_MAX_RESPONSE_BYTES,
    // No retry, on either lane. The background monitor owns its own backoff —
    // a shorter interval after a retryable failure, doubling to a bound — and a
    // client that retried underneath it would multiply the two, turning one
    // configured cadence into an unconfigured one.
    maxRetries: PANEL_HTTP_RETRIES,
  });

  /**
   * The cadence every probe writes, whoever asked for it.
   *
   * Built once, here, and handed to both the panel service and the monitor, so
   * an operator's connection test and a background probe schedule the panel
   * the same way. Two constructions of this object would be two policies.
   */
  const monitorCadence: MonitorCadence = {
    healthyIntervalMs: config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
    retryableIntervalMs: config.PANEL_MONITOR_RETRYABLE_INTERVAL_MS,
    nonRetryableIntervalMs: config.PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS,
  };

  /**
   * Everything a probe needs, built once and shared by both lanes.
   *
   * The operator's connection test and the background monitor are two callers
   * of one implementation, so they are two references to one dependency set —
   * not two constructions that could drift.
   */
  const probeCore: ProbeCoreDeps = {
    repository: panelRepository,
    credentials: panelCredentials,
    uow,
    clock,
    http: panelHttp,
    urlPolicy,
    adapters: providerAdapter,
    // Floored at the HTTP budget a probe can actually spend. A cooldown shorter
    // than a probe can run would let a second request start while the first is
    // still on the wire, which is the case the window exists to prevent — and
    // the two values are configured independently, so nothing else keeps them
    // in a sane order.
    //
    // `PANEL_HTTP_RETRIES` is in the arithmetic rather than assumed to be zero.
    // `totalTimeoutMs` bounds ONE attempt — the deadline is started inside the
    // retry loop — so a client allowed two retries can be on the wire for three
    // times the budget, and a floor written as one budget would silently stop
    // being a floor. It is the same constant the client is built with, so the
    // two cannot drift.
    //
    // And `MAX_REQUESTS_PER_PROBE`, because a probe is not one request. That
    // was the assumption this floor was built on and it was wrong: the deadline
    // is per REQUEST, Marzban's probe makes two and 3X-UI's session probe makes
    // four, so at the defaults the floor was ten seconds while a session probe
    // could occupy forty. A second probe of the same panel could therefore be
    // granted while the first login sequence was still on the wire — against a
    // panel that counts failed logins per address and username, which is the
    // account lockout this window exists to prevent. Derived from the
    // descriptors so a new adapter cannot quietly falsify it.
    probeCooldownMs: effectiveProbeCooldownMs({
      configuredMs: config.PANEL_PROBE_COOLDOWN_MS,
      timeoutMs: config.PANEL_HTTP_TIMEOUT_MS,
      retries: PANEL_HTTP_RETRIES,
      requestsPerProbe: MAX_REQUESTS_PER_PROBE,
    }),
    probeBudget: {
      capacity: config.PANEL_PROBE_TENANT_LIMIT,
      refillPerMs: config.PANEL_PROBE_TENANT_LIMIT / config.PANEL_PROBE_TENANT_WINDOW_MS,
    },
    cadence: monitorCadence,
  };

  const monitorBudgetReserve = monitorBudgetReserveFor(
    config.PANEL_PROBE_TENANT_LIMIT,
    config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
  );

  const panelMonitor = new PanelMonitorService(
    {
      discovery: new DrizzlePanelMonitorRepository(database.db),
      // The tenant kill switch the monitor reads before it dials and again
      // before it writes. Same reader the control-plane services use.
      scopeActivity: tenants,
      // Which capacity conditions are open, read from the rows rather than
      // from process memory, so a restart does not strand one open for ever.
      conditions: new DrizzleOperationalConditionReader(database.db),
      probe: probeCore,
      guard,
      audit,
      opsLog,
      sessions,
      uow,
      clock,
      ids,
      logger,
      batchSize: config.PANEL_MONITOR_BATCH_SIZE,
      tenantsPerTick: config.PANEL_MONITOR_TENANTS_PER_TICK,
      concurrency: config.PANEL_MONITOR_CONCURRENCY,
      budgetReserve: monitorBudgetReserve,
      tenantBudgetUpperBound: tenantBudgetFreshPanelUpperBound(
        config.PANEL_PROBE_TENANT_LIMIT,
        config.PANEL_PROBE_TENANT_WINDOW_MS,
        config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      ),
      schedulerUpperBound: schedulerFreshPanelUpperBound(
        config.PANEL_MONITOR_BATCH_SIZE,
        config.PANEL_MONITOR_TICK_MS,
        config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      ),
      capacityAssessmentIntervalMs: config.PANEL_MONITOR_CAPACITY_INTERVAL_MS,
    },
    config.PANEL_MONITOR_TICK_MS,
  );

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

  /**
   * The customer-facing messenger, built ONCE and shared.
   *
   * Two instances would be two copies of the send-failure condition logic reading the
   * same rows, which is harmless, and two different renderer configurations, which is
   * not: a tenant's template override has to land in every message a customer reads,
   * including the one a background sweep sends about a service they have paid for.
   *
   * Built here rather than inline in `botRuntime` because the provisioner role needs it
   * too and does not construct a bot runtime.
   */
  const customerMessenger = new TelegramCustomerMessenger(
    // The tenant's own renderer, so an override lands in exactly the messages a
    // customer reads. It validates values against the key's declaration on the way
    // out, which is what stops a literal `{token}` reaching a customer.
    templateResolver,
    // The token of the bot the customer WROTE to, never the tenant's active bot.
    // `botInstances` owns that lookup; `tenants` would be the wrong object and the
    // wrong question.
    botInstances,
    opsLog,
    // Whether this bot's send-failure condition is still open, read from the
    // row. It decides whether a successful send writes a recovery, so it must
    // not be a field this process set on itself: a replica that restarted, or
    // a second replica, could not then close a condition it did not open.
    new DrizzleOperationalConditionReader(database.db),
    config.TELEGRAM_API_BASE_URL,
    config.NOTIFICATION_SEND_TIMEOUT_MS,
  );

  /**
   * Telling a customer their service is ready, and nothing else.
   *
   * `contacts` is a NARROW closure over the customer repository for the reason
   * `purchases` is one over the order repository: handing the delivery sweep
   * `CustomerRepository` would hand a background worker `setStatus`, and therefore the
   * ability to block a customer.
   *
   * It refuses rather than guesses when `firstBotInstanceId` is null. That column is the
   * only durable record of which bot a customer actually wrote to, and `CustomerMessage`
   * forbids substituting another one: for a tenant running a public bot beside a
   * reseller bot, a message from the wrong account leaks the relationship between them.
   *
   * ## What this is NOT, stated because the sentence above invites the wrong reading
   *
   * `first_bot_instance_id` is the bot the customer FIRST contacted, not the bot they
   * bought through. For a tenant with one bot those are the same and the announcement is
   * correct. For a tenant with two, a customer who first wrote to the public bot and
   * later ordered through the reseller bot is announced to from the public one — the
   * very leak the paragraph above says must not happen.
   *
   * It is not fixed here because there is nothing to fix it WITH: `orders` carries no
   * bot instance, so this release genuinely does not record which bot a purchase came
   * through, and inventing an answer is worse than using the only recorded one. Carried
   * as `OQ-PROV-02` in `docs/open-questions.md` with the column that would close it.
   */
  /**
   * The customer notification lane: repository, dispatcher and timer.
   *
   * Built after `customerMessenger` because it shares it — one messenger for every
   * customer-facing send in the process, so the bot-token resolution, the template
   * rendering and the 429 classification cannot diverge between the reply path and the
   * background one.
   */
  const customerNotificationLoop = new CustomerNotificationLoop(
    new CustomerNotificationService({
      notifications: customerNotificationRepository,
      contacts: {
        contactFor: async (scope, customerId, tx) => {
          const customer = await customerRepository.findById(scope, customerId, tx);
          if (customer === null) return { kind: 'NONE' };
          /*
           * The status of the row just read, not the one the claim matched.
           *
           * `claimDue` joins `customers` and requires `ACTIVE`, which settles the
           * ordinary case and cannot settle the race: an operator blocking a customer
           * between that claim and this read left a leased row whose customer is now
           * blocked. Checked here because here is the last read before the send.
           */
          if (customer.status !== 'ACTIVE') return { kind: 'BLOCKED' };
          return { kind: 'CONTACT', contact: { chatId: customer.telegramUserId } };
        },
      },
      subjects: new DrizzleNotificationSubjectReader(database.db),
      messenger: customerMessenger,
      uow,
      clock,
      // The same tenant kill switch every other path reads. A stopped tenant is a
      // healthy pass that did nothing, never a throw — see `deliverDue`.
      scopeIsActive: (scope) => uow.run(scope, async (tx) => tenants.scopeIsActive(scope, tx)),
      logger,
    }),
    {
      scope: () =>
        installationTenantId === null
          ? null
          : { tenantId: installationTenantId, botInstanceId: null },
      intervalMs: CUSTOMER_NOTIFICATION_INTERVAL_MS,
      now: () => clock.now().getTime(),
      logger,
    },
  );

  const deliveryService = new DeliveryService({
    services: serviceRepository,
    contacts: {
      contactFor: async (scope, customerId, tx) => {
        const customer = await customerRepository.findById(scope, customerId, tx);
        if (customer === null || customer.firstBotInstanceId === null) return { kind: 'NONE' };
        /*
         * The status of the row just read, not the one the claim matched.
         *
         * `claimDeliveryDue` joins `customers` and requires `ACTIVE`, which settles the
         * ordinary case. It cannot settle the race: an operator blocking a customer
         * between that claim and this read left the sweep holding a leased row whose
         * customer is now blocked, and the announcement went out anyway because nothing
         * looked again. Checked here because here is the last read before the send.
         */
        if (customer.status !== 'ACTIVE') return { kind: 'BLOCKED' };
        return {
          kind: 'CONTACT',
          contact: {
            chatId: customer.telegramUserId,
            botInstanceId: customer.firstBotInstanceId,
          },
        };
      },
    },
    messenger: customerMessenger,
    // The same tenant kill switch every other write path reads.
    scopeActivity: tenants,
    uow,
    clock,
  });

  /**
   * The lane that actually creates services on panels.
   *
   * Built HERE and not beside `ProvisioningService`, because it needs the panel stack:
   * the repository, the credential store, the SafeHttpClient bound to the
   * installation's URL policy, and the SAME tenant probe budget the monitor spends
   * from. That shared bucket is the point — a second one would raise a tenant's total
   * outbound rate, which is the bound's whole purpose.
   *
   * `purchases` is a narrow closure over the order repository rather than the
   * repository itself. The executor needs two numbers from a frozen snapshot; handing
   * it `OrderRepository` would also hand a background worker `transition`, and
   * therefore the ability to settle an order.
   *
   * `workerId` names the process instance in a claim, so an operator reading a stuck
   * `IN_FLIGHT` row can tell which replica holds it.
   */
  const provisioner = new ProvisionerService({
    operations: operationRepository,
    services: serviceRepository,
    purchases: {
      specificationFor: async (scope, orderId, tx) => {
        const order = await orderRepository.findById(scope, orderId, tx);
        return order?.line.specification ?? null;
      },
    },
    panels: panelRepository,
    credentials: panelCredentials,
    adapters: providerServiceAdapter,
    implementedProviderTypes: SERVICE_PROVIDER_TYPES,
    http: panelHttp,
    urlPolicy,
    probeBudget: probeCore.probeBudget,
    uow,
    clock,
    ids,
    hash: sha256Hex,
    operationId: (key) => operationIdFor('provider', key),
    audit,
    opsLog,
    outbox,
    scopeActivity: tenants,
    settings: settingsResolver,
    workerId: `${role}:${ids.uuid()}`,
    leaseMs: OPERATION_LEASE_SECONDS_MIN * 1000,
  });

  /**
   * How a customer learns that the thing they asked for happened.
   *
   * Reads the operation's type and the service's customer with two narrow queries, so
   * the loop never holds a repository that could mutate either.
   */
  const outcomeAnnouncer = new OperationOutcomeAnnouncer({
    reader: {
      subjectFor: async (scope, operationId, tx) => {
        const operation = await operationRepository.findById(scope, operationId, tx);
        if (operation === null) return null;
        // The operation's OWN service, not one the caller supplied: an announcement
        // keyed to a service the operation does not belong to is the mismatch this
        // signature removes rather than documents.
        const service = await serviceRepository.findById(scope, operation.serviceId, tx);
        if (service === null) return null;
        return {
          type: operation.type,
          state: operation.state,
          serviceId: operation.serviceId,
          customerId: service.customerId,
        };
      },
      /*
       * Delegated straight through, unlike `subjectFor` above.
       *
       * That one composes two narrow reads so the loop never holds a repository;
       * this is a single bounded query over one table and there is nothing to
       * compose. Passing it through keeps the predicate — terminal, unannounced,
       * past the grace — in the repository where the columns are, rather than
       * splitting it across a layer that would then need the schema.
       */
      dueForAnnouncement: async (scope, before, limit, tx) =>
        operationRepository.dueForAnnouncement(scope, before, limit, tx),
    },
    /*
     * The write, in its own dependency because the reader promises it cannot
     * mutate. `OperationOutcomeReader`'s docblock is that promise, and the
     * arrangement here is what keeps it true rather than aspirational.
     */
    announcements: {
      markAnnounced: async (scope, operationId, now, tx) =>
        operationRepository.markAnnounced(scope, operationId, now, tx),
    },
    notifier: customerNotifier,
    uow,
    clock,
  });

  const provisionerLoop = new ProvisionerLoop(provisioner, deliveryService, outcomeAnnouncer, {
    /*
     * The installation's own tenant.
     *
     * One tenant per installation is the deployment model — `resolveInstallationTenant`
     * establishes it at boot for the worker and the monitor alike — and the loop asks
     * for it per tick rather than capturing it, so a process that started before
     * provisioning was resolved does not hold a stale context for its lifetime.
     */
    scope: () => {
      if (installationTenantId === null) {
        /*
         * No tenant yet.
         *
         * A fresh installation boots before `pnpm provision` runs, and the loop must
         * not invent a tenant id to keep itself busy. Throwing is caught by the tick,
         * which records no progress — so readiness stays false until the installation
         * has a tenant, which is the truth.
         */
        throw new Error('this installation has no tenant yet; nothing can be provisioned');
      }
      return { tenantId: installationTenantId, botInstanceId: null };
    },
    tickMs: config.PROVISIONER_TICK_MS,
    now: () => clock.now().getTime(),
    logger,
  });

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
  const monitorProfileService = new MonitorProfileService(
    guard,
    {
      enabled: config.PANEL_MONITOR_ENABLED,
      tickMs: config.PANEL_MONITOR_TICK_MS,
      healthyIntervalMs: config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      retryableIntervalMs: config.PANEL_MONITOR_RETRYABLE_INTERVAL_MS,
      nonRetryableIntervalMs: config.PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS,
      batchSize: config.PANEL_MONITOR_BATCH_SIZE,
      concurrency: config.PANEL_MONITOR_CONCURRENCY,
      tenantsPerTick: config.PANEL_MONITOR_TENANTS_PER_TICK,
      probeTenantLimit: config.PANEL_PROBE_TENANT_LIMIT,
      probeTenantWindowMs: config.PANEL_PROBE_TENANT_WINDOW_MS,
      // The EFFECTIVE cooldown — the same value `probeCore` is built with, not
      // the raw setting. A deployment with `PANEL_PROBE_COOLDOWN_MS=1000` and a
      // 120s HTTP timeout holds each panel for at least 120s, and this
      // endpoint's whole contract is that it reports what the deployment is
      // actually running; publishing the raw number made it state a cooldown no
      // probe obeys.
      probeCooldownMs: probeCore.probeCooldownMs,
      budgetReservePercent: config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
    },
    new DrizzleOperationalConditionReader(database.db),
  );

  /**
   * This PROCESS's identity, shared by every lease it takes.
   *
   * So two replicas of the same role hold distinguishable leases and a takeover
   * can tell whose lock it is reclaiming. Role plus pid plus randomness: the role
   * alone repeats across replicas, and the pid alone repeats across containers.
   *
   * ONE value for the backup lease and the recovery lease, not two. A process
   * that held two identities could reclaim its own abandoned work under the other
   * one and believe it was taking over from somebody else — and the recovery
   * executor's restart path (`claimOwn`) depends on recognising exactly this
   * string.
   *
   * STABLE ACROSS RESTARTS, which is the whole point and which the first version
   * of this value defeated: it carried the pid and a fresh random suffix, so a
   * restarted process could never recognise its own lease and `claimOwn` matched
   * nothing, ever. The comment above said the restart path depended on this
   * string while the value made the dependency unsatisfiable. The cost was not
   * theoretical — a recovery executor that died mid-restore left the row in a
   * quiescing state with a lease nobody could reclaim for fifteen minutes, and a
   * quiescing state refuses every durable write in the installation. Fifteen
   * minutes of refused writes, on every crash, is exactly what `claimOwn` was
   * written to prevent.
   *
   * The role plus the HOST is the identity that survives a process restart and
   * still separates the four roles from each other. In the deployment each role
   * is its own container and a container's hostname is its id, so two containers
   * of one role never collide; a container REPLACED by an update gets a new
   * hostname and correctly falls through to the stale-lease path instead.
   */
  const leaseOwner = `${role}:${hostname()}`;

  /** The backup graph. */
  const backupRuns = new DrizzleBackupRunRepository(database.db);
  /**
   * Retention for the backup run table — ADR-0027.
   *
   * Constructed HERE rather than beside the other two sweepers because it needs
   * the run repository, which needs the database handle that is built above it.
   * Not gated on `BACKUP_SCHEDULE_ENABLED`: an installation with the schedule off
   * still accumulates rows from manual runs, and a table whose policy depends on
   * a feature flag is a table with no policy on half the installations.
   *
   * Every exclusion that makes this safe is in the QUERY, not here — a predicate
   * a caller has to remember is a predicate some caller will not. See
   * `purgeFinishedBefore`.
   */
  const backupRunSweeper = new RetentionSweeper(
    {
      name: 'backup-runs',
      purge: (now, limit) =>
        backupRuns.purgeFinishedBefore(
          new Date(now.getTime() - config.BACKUP_RUN_RETENTION_DAYS * 24 * 3_600_000),
          limit,
        ),
    },
    clock,
    logger,
    {
      // Daily, not hourly. The other two sweepers bound tables an unauthenticated
      // caller can grow at will; this one bounds a table that gains a row per
      // backup, so hourly would be a thousand no-op passes for every row removed.
      intervalMs: 24 * 3_600_000,
      initialDelayMs: 60_000,
      // Smaller batches than the identity sweepers, because the eligible set here
      // is small by construction and each row carries a subquery for the two
      // "most recent" exclusions.
      batchSize: 500,
      maxBatchesPerTick: 100,
    },
  );

  /**
   * Retention for the recovery request table — ADR-0027's shape, ADR-0028's
   * exclusions.
   *
   * A row that recorded a CUTOVER is excluded in the QUERY and kept for ever: it
   * is the only record of what the displaced database is called, and an operator
   * left with a `nexa_pre_restore_*` database and nothing saying what it is
   * cannot decide whether to drop it.
   */
  const recoveryRequestSweeper = new RetentionSweeper(
    {
      name: 'recovery-requests',
      purge: (now, limit) =>
        recoveryRequests.purgeFinishedBefore(
          new Date(now.getTime() - config.RECOVERY_RETENTION_DAYS * 24 * 3_600_000),
          limit,
        ),
    },
    clock,
    logger,
    {
      // Daily, like the backup run sweeper and for the same reason: the eligible
      // set grows by at most a handful of rows a year on a healthy installation,
      // so anything more frequent is a thousand no-op passes for every row
      // removed.
      intervalMs: 24 * 3_600_000,
      initialDelayMs: 120_000,
      batchSize: 500,
      maxBatchesPerTick: 100,
    },
  );

  const backupTools = new PostgresDatabaseTools({
    databaseUrl: config.DATABASE_URL,
    dumpTimeoutMs: config.BACKUP_DUMP_TIMEOUT_MS,
    restoreTimeoutMs: config.BACKUP_RESTORE_TIMEOUT_MS,
    binDir: config.BACKUP_PG_BIN_DIR === '' ? undefined : config.BACKUP_PG_BIN_DIR,
    /*
     * The migrator THIS release ships, located from this module's own file.
     *
     * Used only to migrate a restored CANDIDATE forward when its schema is
     * behind (ADR-0028 § 7). Resolved relative to `container.js` rather than from
     * the working directory or a configuration value, for the reason the build
     * identity is read from the image: a path an operator could set is a path
     * that can point at a different release's migrator, and migrating a
     * candidate with the wrong release's migrations is how a recovery produces a
     * database no version of this code can serve.
     *
     * `.js` because that is what is on disk at runtime in both modes — `dist`
     * under node, and `tsx`'s loader resolves the same specifier in development.
     */
    migratorEntrypoint: fileURLToPath(
      new URL('./infrastructure/persistence/migrate.js', import.meta.url),
    ),
  });
  const backupArchiver = new KeyringBackupArchiver(keyring);
  const backup = new BackupService({
    runs: backupRuns,
    tools: backupTools,
    // The SAME keyring the secret cipher uses. One active key encrypts, every
    // held key decrypts — so an archive taken before a rotation stays readable
    // after it, which is the property a backup needs more than anything else
    // in this installation does.
    archiver: backupArchiver,
    workspaces: new FilesystemBackupWorkspaces(config.BACKUP_WORK_DIR),
    delivery: new TelegramBackupDelivery({
      apiBaseUrl: config.TELEGRAM_API_BASE_URL,
      token: config.BACKUP_TELEGRAM_BOT_TOKEN,
      chatId: config.BACKUP_TELEGRAM_CHAT_ID,
      timeoutMs: config.BACKUP_DELIVERY_TIMEOUT_MS,
    }),
    clock,
    ids,
    installationId: () => installationTenantId ?? 'unprovisioned',
    // The NOTIFYING recorder, deliberately, unlike the dispatcher's raw one.
    // A backup failure is exactly the kind of thing the projection exists to
    // put in front of a person, and nothing here consumes the queue it writes
    // to, so there is no cycle to avoid.
    opsLog,
    // Resolved per call: the installation's tenant is a row, so it is not known
    // while this object is being built.
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    logger,
    leaseOwner,
    retainedArchiveHint: config.BACKUP_WORK_DIR,
  });
  /*
   * The recovery graph.
   *
   * The workspace factory and the journal are constructed in every role, because
   * the API receives uploads and the executor restores them and both need to
   * address the same directory. The EXECUTOR is constructed everywhere too and
   * STARTED in exactly one role — the same arrangement `backupScheduler` has, and
   * for a sharper version of the same reason: a restore that ran in the API
   * process would quiesce the process serving the operator watching it.
   */
  const recoveryWorkspaces = new FilesystemRecoveryWorkspaces(config.RECOVERY_WORK_DIR);
  const recoveryJournal = new FileCutoverJournal(config.RECOVERY_WORK_DIR);
  const recoveryService = new RecoveryService({
    requests: recoveryRequests,
    workspaces: recoveryWorkspaces,
    // The SAME archiver the backup pipeline seals with, so one keyring and one
    // `openArchive`. A recovery that decrypted through its own route would be
    // proving a path nobody restores through.
    archiver: backupArchiver,
    engine: backupTools,
    guard,
    audit,
    opsLog,
    clock,
    ids,
    /*
     * Read LAZILY, from this release's own migration journal.
     *
     * Eager would make the container fail to construct wherever the migrations
     * directory is not beside the code — which is every unit test. The path is
     * derived from this module's location for the reason the migrator's is: a
     * configurable one could point at another release's journal, and a
     * compatibility verdict computed against the wrong journal is a confident
     * wrong answer about whether a database can be served.
     */
    expected: () => expectedMigrations(fileURLToPath(new URL('../drizzle', import.meta.url))),
    logger,
  });
  /**
   * The Web Admin's view of the backup pipeline: authorisation and scope only.
   *
   * It starts no backup of its own — `run` calls exactly the service the
   * scheduler and the CLI call — and it is the only place that decides whether an
   * archive is still on disk, because the repository must not touch the
   * filesystem and the surface must not build a path.
   */
  const backupAdmin = new BackupAdminService({
    runs: backupRuns,
    recoveries: recoveryRequests,
    backup,
    guard,
    audit,
    opsLog,
    clock,
    workRoot: config.BACKUP_WORK_DIR,
    scheduleEnabled: config.BACKUP_SCHEDULE_ENABLED,
    intervalMs: config.BACKUP_INTERVAL_MS,
  });

  const recoveryExecutor = new RecoveryExecutor({
    requests: recoveryRequests,
    recovery: recoveryService,
    engine: backupTools,
    workspaces: recoveryWorkspaces,
    journal: recoveryJournal,
    // The unmodified pipeline. `PRE_RESTORE` is a trigger VALUE, not a second
    // code path: same lock, same six stages, same mandatory verification.
    backup,
    /*
     * The SAME readiness computation the load balancer gets — MINUS the outbox
     * lag, which is the one probe that cannot mean what it usually means here.
     *
     * `outboxLagMs` is the age of the oldest unpublished message, and a restored
     * database is by construction older than `OUTBOX_RELAY_MAX_LAG_MS` (five
     * minutes by default). Any message that was unpublished when the dump was
     * taken — one written moments before it, one in backoff — comes back with
     * that age, so the lag right after a cutover is the AGE OF THE BACKUP. Worse,
     * it cannot recover while the check is being made: `RESTARTING` still
     * quiesces, so the relay is idle and the lag can only grow.
     *
     * Left in, this reports `recovery.readiness_failed` on a successful restore
     * of any backup older than five minutes — which is every backup — after the
     * renames, with a CRITICAL event, on an installation that is in fact serving.
     * A false failure at that exact point is the most dangerous wrong answer this
     * design can give: an operator reading it will try to undo a restore that
     * worked.
     *
     * The other three probes are what "can this installation serve?" means here:
     * the database answers, Redis answers, and the restored schema matches this
     * release's migration journal. Lag is a freshness metric, and freshness is
     * exactly what a restore is not claiming.
     */
    readiness: async () => {
      const { dependencies } = await readiness.run();
      const blocking = dependencies.filter((dependency) => dependency.name !== 'outbox');
      return { degraded: blocking.some(blocksReadiness) };
    },
    clock,
    opsLog,
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    leaseOwner,
    tickIntervalMs: config.RECOVERY_TICK_MS,
    logger,
  });

  const backupScheduler = new BackupScheduler({
    service: backup,
    runs: backupRuns,
    // The same predicate the write gate and the operator's button read, from the
    // same row. Three readers, one source: a second way to ask would eventually
    // give a third answer.
    quiesced: async () => {
      const lock = await recoveryRequests.installationLock();
      return lock !== null && lock.quiescing;
    },
    clock,
    intervalMs: config.BACKUP_INTERVAL_MS,
    tickIntervalMs: config.BACKUP_TICK_MS,
    logger,
  });

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
    readiness,
    throttleSweeper,
    sessionSweeper,
    backupRunSweeper,
    recoveryRequestSweeper,
    paymentExpiryLoop,
    customerNotificationLoop,
    customerNotifications: customerNotificationRepository,
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
    bootstrapBot,
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
    customers: customerService,
    products: productService,
    serviceAddons: serviceAddonService,
    commercialActions: commercialActionService,
    wallet: walletService,
    payments: paymentService,
    provisioning: provisioningService,
    serviceAdmin: new ServiceAdminService({
      services: serviceRepository,
      operations: operationRepository,
      guard,
    }),
    provisioner,
    provisionerLoop,
    delivery: deliveryService,
    orders: orderService,
    botRuntime: new BotRuntime({
      /*
       * The one write the turn makes after its Telegram send, and the transaction
       * it needs, kept OUT of the surface.
       *
       * `OQ-4H-01`. A surface must not open a transaction — the runtime has no
       * unit of work and gets none here — so the composition root supplies a
       * function that opens one and calls the same notifier the background lanes
       * use. Nothing about the enqueue is different because the caller is
       * interactive; only the decision to make it is.
       */
      queueRateLimitedFact: async (scope, customerId, kind, subjectId) => {
        await uow.run(scope, async (tx) =>
          customerNotifier.notify(scope, customerId, kind, subjectId, clock.now(), tx),
        );
      },
      customers: customerService,
      payments: paymentService,
      wallet: walletService,
      // The SAME instances the container exposes, not new ones. Two order services
      // would each hold their own idempotency view, and a redelivered Telegram update
      // handled by one would not be seen as a replay by the other — which is the whole
      // mechanism that stops a redelivery becoming a second order.
      products: productService,
      commercial: commercialActionService,
      orders: orderService,
      // The SAME messenger the delivery sweep uses, for the reason above it.
      messenger: customerMessenger,
      // And the same provisioning and delivery services, for the same reason: a
      // customer-requested resend and the automatic sweep share `markSendStarted`,
      // and two instances would share nothing.
      services: provisioningService,
      delivery: deliveryService,
      /*
       * The plan a service was SOLD as, from the order's frozen snapshot.
       *
       * The same read the provisioner's `purchases` port makes, narrowed the same way
       * and for the same reason: the runtime gets the title and not `OrderService`.
       * From the ORDER, never from the product — `nexa_orders_snapshot_guard` froze it
       * at confirmation, so it is the only copy that still says what the customer
       * agreed to.
       */
      purchaseTitle: async (scope, orderId) => {
        const order = await orderRepository.findById(scope, orderId);
        return order?.line.title ?? null;
      },
    }),
    panels: new PanelService({
      repository: panelRepository,
      credentials: panelCredentials,
      guard,
      // The same reader settings, templates, feature flags and the ping
      // recorder are given. The panels module was the one write path that did
      // not check whether its scope was still accepting work.
      scopeActivity: tenants,
      audit,
      opsLog,
      // Whether a probe limit is open, so a recovery is recorded when one ends
      // and not after every successful test.
      conditions: new DrizzleOperationalConditionReader(database.db),
      sessions,
      uow,
      idempotency,
      clock,
      ids,
      http: probeCore.http,
      urlPolicy: probeCore.urlPolicy,
      probeCooldownMs: probeCore.probeCooldownMs,
      probeBudget: probeCore.probeBudget,
      adapters: probeCore.adapters,
      cadence: probeCore.cadence,
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
    monitorProfileService,
    panelMonitor,
    backup,
    backupScheduler,
    backupRuns,
    backupArchiver,
    backupTools,
    recoveryService,
    backupAdmin,
    recoveryExecutor,
    recoveryRequests,
    recoveryWorkspaces,
    async shutdown() {
      backupScheduler.stop();
      recoveryExecutor.stop();
      await relay.stop();
      await panelMonitor.stop();
      await notificationDispatcher.stop();
      await throttleSweeper.stop();
      await sessionSweeper.stop();
      await backupRunSweeper.stop();
      await recoveryRequestSweeper.stop();
      await paymentExpiryLoop.stop();
      await customerNotificationLoop.stop();
      await redis.close();
      await database.close();
    },
  };
}

export const CONTAINER = Symbol('CONTAINER');
