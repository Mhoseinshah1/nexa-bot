import { fileURLToPath } from 'node:url';
import {
  ADMIN_MENU_BUTTON,
  ADMIN_MENU_COMMAND,
  MAIN_MENU_BUTTONS,
  MAX_REQUESTS_PER_PROBE,
  OPERATION_LEASE_SECONDS_MIN,
} from '@nexa/contracts';
import type {
  AuditWriter,
  Clock,
  IdGenerator,
  IdempotencyStore,
  Logger,
  OperationalEventRecorder,
  PasswordHasher,
  PaymentId,
  PermissionKey,
  SecretCipher,
  TenantId,
} from '@nexa/contracts';
import { CATALOGUE_FA, createTranslator } from '@nexa/i18n';
import type { OperationType, TenantContext, Translator } from '@nexa/contracts';

import { acceptsV1, type AppConfig } from './infrastructure/config/config.schema.js';
import { readFileSync } from 'node:fs';
import { panelUrlPolicy } from './infrastructure/net/installation-policy.js';
import { SafeHttpClient } from './infrastructure/net/safe-http.js';
import {
  DrizzlePanelMonitorRepository,
  DrizzlePanelRepository,
} from './modules/platform/panels/infrastructure/drizzle-panel.repository.js';
import { DrizzlePanelCapacityRepository } from './modules/platform/panels/infrastructure/drizzle-panel-capacity.repository.js';
import { PanelSalesGate } from './modules/platform/panels/application/panel-sales-gate.js';
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
import { createLogger, newCorrelationId } from './infrastructure/logging/logger.js';
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
import { TelegramAdminService } from './modules/platform/identity/application/telegram-admin.service.js';
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
import { ReminderThresholdsGuard } from './modules/control/settings/application/reminder-thresholds.guard.js';
import { CONTROL_ERROR_CODES, SERVICE_REMINDER_DEFAULTS, isNexaError } from '@nexa/contracts';
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
import { ProductCategoryService } from './modules/commerce/catalog/application/product-category.service.js';
import { ServiceAddonService } from './modules/commerce/catalog/application/addon.service.js';
import { CommercialActionService } from './modules/commerce/commercial/application/commercial-action.service.js';
import { TrialService } from './modules/commerce/trials/application/trial.service.js';
import { TrialProductGuard } from './modules/commerce/trials/application/trial-product.guard.js';
import { DrizzleTrialGrantRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-grant.repository.js';
import { DrizzleTrialOverrideRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-override.repository.js';
import { DrizzleTrialResetRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-reset.repository.js';
import { TrialAdminService } from './modules/commerce/trials/application/trial-admin.service.js';
import { DrizzleCommercialActionRepository } from './modules/commerce/commercial/infrastructure/drizzle-commercial-action.repository.js';
import { DrizzleServiceAddonRepository } from './modules/commerce/catalog/infrastructure/drizzle-addon.repository.js';
import {
  DrizzlePanelDirectory,
  DrizzleProductCategoryRepository,
  DrizzleProductRepository,
} from './modules/commerce/catalog/infrastructure/drizzle-product.repository.js';
import { DrizzleWalletRepository } from './modules/commerce/wallet/infrastructure/drizzle-wallet.repository.js';
import { WalletService } from './modules/commerce/wallet/application/wallet.service.js';
import { DrizzlePaymentRepository } from './modules/commerce/payments/infrastructure/drizzle-payment.repository.js';
import {
  DrizzlePaymentAccountRepository,
  DrizzlePaymentDestinationRepository,
} from './modules/commerce/payments/infrastructure/drizzle-payment-account.repository.js';
import {
  DrizzlePaymentReceiptRepository,
  DrizzleReceiptCaptureRepository,
} from './modules/commerce/payments/infrastructure/drizzle-receipt.repository.js';
import { PaymentDestinationRenderer } from './modules/commerce/payments/infrastructure/destination-renderer.js';
import {
  DrizzleGatewayAudienceReader,
  DrizzlePaymentGatewayRepository,
} from './modules/commerce/payments/infrastructure/drizzle-payment-gateway.repository.js';
import { PaymentAccountService } from './modules/commerce/payments/application/payment-account.service.js';
import { PaymentGatewayService } from './modules/commerce/payments/application/payment-gateway.service.js';
import type { PaymentGatewayRepository } from './modules/commerce/payments/application/gateway-ports.js';
import type { CustomerContactReader } from './modules/commerce/provisioning/application/ports.js';
import { ReceiptService } from './modules/commerce/payments/application/receipt.service.js';
import { TelegramReceiptFiles } from './modules/commerce/payments/infrastructure/telegram-receipt-files.js';
import { PaymentService } from './modules/commerce/payments/application/payment.service.js';
import { RefundService } from './modules/commerce/payments/application/refund.service.js';
import { ReceiptDispositionService } from './modules/commerce/payments/application/receipt-disposition.service.js';
import { ReceiptCreditCaptureService } from './modules/commerce/payments/application/receipt-credit-capture.service.js';
import { DrizzleAdminAmountCaptureRepository } from './modules/commerce/payments/infrastructure/drizzle-admin-amount-capture.repository.js';
import { DrizzleReceiptCreditRepository } from './modules/commerce/payments/infrastructure/drizzle-receipt-credit.repository.js';
import { DrizzleRefundRepository } from './modules/commerce/payments/infrastructure/drizzle-refund.repository.js';
import { SalesCurrencyChangeGuard } from './modules/commerce/payments/application/sales-currency-change.guard.js';
import { PaymentExpiryService } from './modules/commerce/payments/application/payment-expiry.service.js';
import {
  PaymentExpiryLoop,
  PAYMENT_EXPIRY_INTERVAL_MS,
} from './modules/commerce/payments/application/payment-expiry-loop.js';
import { OrderService } from './modules/commerce/orders/application/order.service.js';
import { DrizzleOrderRepository } from './modules/commerce/orders/infrastructure/drizzle-order.repository.js';
import { DiscountAdminService } from './modules/commerce/pricing/application/discount-admin.service.js';
import { CashbackRuleAdminService } from './modules/commerce/pricing/application/cashback-rule-admin.service.js';
import { PricingReadService } from './modules/commerce/pricing/application/pricing-read.service.js';
import { PricingService } from './modules/commerce/pricing/application/pricing.service.js';
import { CashbackService } from './modules/commerce/pricing/application/cashback.service.js';
import { ReferralProgram } from './modules/commerce/referrals/application/referral-program.js';
import { TelegramBotUsernames } from './modules/commerce/referrals/infrastructure/telegram-bot-username.js';
import { ReferralCommissionService } from './modules/commerce/referrals/application/referral-commission.service.js';
import { ReferralReadService } from './modules/commerce/referrals/application/referral-read.service.js';
import {
  DrizzleReferralCommissionRepository,
  DrizzleReferralRepository,
} from './modules/commerce/referrals/infrastructure/drizzle-referral.repository.js';
import { DrizzleResellerRepository } from './modules/commerce/resellers/infrastructure/drizzle-reseller.repository.js';
import { ResellerService } from './modules/commerce/resellers/application/reseller.service.js';
import { ResellerAdminService } from './modules/commerce/resellers/application/reseller-admin.service.js';
import { DrizzleDiscountRepository } from './modules/commerce/pricing/infrastructure/drizzle-discount.repository.js';
import {
  DrizzleCashbackRuleRepository,
  DrizzleOrderCashbackRepository,
} from './modules/commerce/pricing/infrastructure/drizzle-cashback.repository.js';
import { DrizzleDiscountCodeCaptureRepository } from './modules/commerce/pricing/infrastructure/drizzle-discount-code-capture.repository.js';
import { DrizzleServiceRepository } from './modules/commerce/provisioning/infrastructure/drizzle-service.repository.js';
import {
  DrizzleServiceReminderRepository,
  DrizzleServiceReminderSnapshotReader,
} from './modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository.js';
import { ServiceReminderService } from './modules/commerce/provisioning/application/service-reminder.service.js';
import {
  ServiceReminderLoop,
  SERVICE_REMINDER_INTERVAL_MS,
} from './modules/commerce/provisioning/application/service-reminder-loop.js';
import { serviceSecrets } from './infrastructure/crypto/service-secrets.js';
import { UsernameAllocator } from './modules/commerce/provisioning/application/username-allocator.js';
import { PanelUsernameLane } from './modules/commerce/provisioning/application/username-lane.js';
import { DrizzleServiceUsernameRepository } from './modules/commerce/provisioning/infrastructure/drizzle-service-username.repository.js';
import type { PanelNamespaceRebinder } from './modules/platform/panels/application/ports.js';
import { DrizzleUsernameCaptureRepository } from './modules/commerce/provisioning/infrastructure/drizzle-username-capture.repository.js';
import { DrizzleOperationRepository } from './modules/commerce/provisioning/infrastructure/drizzle-operation.repository.js';
import { ProvisioningService } from './modules/commerce/provisioning/application/provisioning.service.js';
import { ServiceAdminService } from './modules/commerce/provisioning/application/service-admin.service.js';
import { decideOperability } from './modules/commerce/provisioning/application/panel-operability.js';
import {
  PURCHASED_AS,
  ProvisionerService,
} from './modules/commerce/provisioning/application/provisioner.service.js';
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
import type { BotRuntimeDeps } from './surfaces/telegram/bot-runtime.js';
import { I18nTemplateCatalogue } from './modules/control/templates/infrastructure/i18n-template-catalogue.js';
import { TemplateManagementService } from './modules/control/templates/application/template-management.service.js';
import { DrizzleNotificationRepository } from './modules/control/notifications/infrastructure/drizzle-notification.repository.js';
import { NotificationService } from './modules/control/notifications/application/notification.service.js';
import { UndeliverableOrderRefunder } from './modules/commerce/orders/application/undeliverable-order-refunder.js';
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
  /**
   * The panel sales gate and the capacity repository, exposed for the same
   * reason `uow` and `tenants` are: a test that must drive two tenants builds
   * the service itself, and it has to be given the SAME collaborators
   * production uses or it proves nothing about production.
   */
  readonly panelSales: PanelSalesGate;
  readonly panelCapacity: DrizzlePanelCapacityRepository;
  readonly paymentExpirySweep: PaymentExpiryService;
  /**
   * The username reservation lane.
   *
   * Exposed because a test that builds its own `PaymentExpiryService` — the two-tenant
   * isolation cases in `payments.test.ts` do — still needs the real lane, and a second
   * `PanelUsernameLane` wired by hand would be a second answer to what a hold is.
   */
  readonly usernameLane: PanelUsernameLane;
  /**
   * The same repository, as the narrow port `PanelService` takes.
   *
   * Exposed so a test building its own `PanelService` wires the REAL rebinder rather
   * than a stub — a stub here would let a panel move without its holds and the suite
   * would not notice, which is the defect this port exists for.
   */
  readonly usernameNamespace: PanelNamespaceRebinder;
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
   * The lane that warns a customer before their service runs out of days or traffic.
   *
   * Started by the WORKER only, for the reason above it: both halves read columns this
   * installation already maintains and neither dials a panel.
   */
  readonly serviceReminderLoop: ServiceReminderLoop;
  /** The sweep itself, so a test runs one pass instead of starting a timer. */
  readonly serviceReminderSweep: ServiceReminderService;
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
  /**
   * The Telegram admin seam (Phase 5T): a binding resolved to the SAME administrator
   * identity the Web Admin authenticates, with no second role model behind it.
   */
  readonly telegramAdmins: TelegramAdminService;
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
  readonly productCategories: ProductCategoryService;
  readonly serviceAddons: ServiceAddonService;
  /** Discount rules, as an operator manages them (WP8). */
  readonly discounts: DiscountAdminService;
  /** Cashback rules, as an operator manages them (WP8). */
  readonly cashbackRules: CashbackRuleAdminService;
  /** The operator's price preview and an order's pricing detail (WP8). */
  readonly pricingRead: PricingReadService;
  /** Cashback from promise to credit to reversal (WP8 P9); driven by the provisioner loop. */
  readonly cashback: CashbackService;
  /** WP9: attribution, the customer's invite and the commission promise. */
  readonly referrals: ReferralProgram;
  /** WP9: the commission lane, earned on delivery and reversed by refunds. */
  readonly referralCommissions: ReferralCommissionService;
  /** WP9: the operator's read-only view of attributions and commissions. */
  readonly referralsRead: ReferralReadService;
  /** WP9-B: a reseller's standing, entitlements, pricing layer, credit and purchase record. */
  readonly resellers: ResellerService;
  /** WP9-B: reseller tiers, grants and resellers, as an operator manages them. */
  readonly resellersAdmin: ResellerAdminService;
  readonly commercialActions: CommercialActionService;
  /** A customer's free trial (WP6-A): issued through the purchase path, costs nothing. */
  readonly trials: TrialService;
  /** The operator's trial overrides, global reset and view (WP6-B). */
  readonly trialAdmin: TrialAdminService;
  readonly wallet: WalletService;
  readonly payments: PaymentService;
  readonly paymentAccounts: PaymentAccountService;
  /**
   * The payment ROUTES an operator offers (Phase 5C).
   *
   * Configuration, not settlement: a route names the `PaymentMethod` it settles through
   * and `PaymentService` still does the settling.
   */
  readonly paymentGateways: PaymentGatewayService;
  /**
   * Money going back (Phase 5E).
   *
   * Separate from `payments` because the two are opposite decisions over one row and
   * only one of them may hold `refunds.issue`: settling a payment is `payments.*`, and
   * reversing one is a finance permission an operator can be granted on its own.
   */
  readonly refunds: RefundService;
  /**
   * A card-to-card receipt's credit-to-wallet disposition (Payment File 02 §12, D2),
   * under `receipts.review` AND `users.wallet.credit`. Called by the Telegram review
   * surface; the Web Admin only READS what it recorded.
   */
  readonly receiptDispositions: ReceiptDispositionService;
  /** The Telegram half of the credit-to-wallet disposition: the reviewer's amount capture (D3). */
  readonly receiptCreditCaptures: ReceiptCreditCaptureService;
  /**
   * The route repository, exposed for ONE caller: the boot-time reconcile.
   *
   * `resolveInstallationTenant` creates a tenant's routes in the same transaction as
   * `ensureSystemRoles`, and it does so through the repository because there is no actor
   * at boot — see the comment there. Nothing else may reach past the service.
   */
  readonly paymentGatewayProvisioning: PaymentGatewayRepository;
  readonly receipts: ReceiptService;
  readonly receiptFiles: TelegramReceiptFiles;
  readonly orders: OrderService;
  readonly botRuntime: BotRuntime;

  // Control plane — Phase 2
  readonly panels: PanelService;
  /** The Telegram admin section's reminder seam. See the construction site. */
  readonly reminderConfig: BotRuntimeDeps['reminderConfig'];
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
  const permissionResolver = new AdminPermissionResolver(admins, roles, clock);
  const guard = new PermissionGuard(permissionResolver, opsLog);

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
    idempotency,
  );

  /*
   * The Telegram admin seam (Phase 5T).
   *
   * It shares the resolver the guard uses and delegates every write to
   * `AdminManagementService`, so there is exactly one place that decides what an
   * administrator may do and exactly one that changes their roles or their binding.
   * The Mirza research is why that matters: its Telegram panel and its web panel hold
   * four role names against seven for one column, and whether either is enforced is
   * still NOT_TESTED.
   */
  /*
   * The permission a receipt decision takes, named once here.
   *
   * `receipts.review` is charged by `PaymentService.confirmManualTransfer` and
   * `rejectManualTransfer`, and it is ALSO the filter for who gets told a receipt is
   * waiting: telling somebody who could do nothing about it is noise, and telling
   * nobody is a receipt that sits there.
   */
  const RECEIPTS_REVIEW_PERMISSION = 'receipts.review' as PermissionKey;

  const telegramAdmins = new TelegramAdminService({
    admins,
    permissions: permissionResolver,
    management: adminManagement,
  });

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
  /*
   * A reseller's standing (WP9-B), built here because the catalogue asks it too: whose
   * catalogue a customer browses is a reseller question, and there is one service for it.
   */
  const resellerRepository = new DrizzleResellerRepository(database.db);
  const resellerService = new ResellerService({
    resellers: resellerRepository,
    products: productRepository,
  });
  const trialGrantRepository = new DrizzleTrialGrantRepository(database.db);
  const trialOverrideRepository = new DrizzleTrialOverrideRepository(database.db);
  const trialResetRepository = new DrizzleTrialResetRepository(database.db);

  const settingRepository = new DrizzleSettingRepository(database.db);
  const settingsResolver = new SettingsResolver(settingRepository, opsLog);
  // Read by provisioning (WP6-C) as well as by the trial, so it is built with the
  // settings resolver rather than beside the service that first needed it.
  const featureFlagRepository = new DrizzleFeatureFlagRepository(database.db);
  const featureFlagResolver = new FeatureFlagResolver(featureFlagRepository);

  /*
   * The referral program (WP9, `docs/wp9-referral-audit.md`). Built before the customer
   * service because attribution happens INSIDE the transaction that registers a
   * customer, and before pricing because a confirmation promises the commission.
   */
  const referralRepository = new DrizzleReferralRepository(database.db);
  const referralCommissionRepository = new DrizzleReferralCommissionRepository(database.db);
  const referralProgram = new ReferralProgram({
    referrals: referralRepository,
    commissions: referralCommissionRepository,
    customers: customerRepository,
    settings: settingsResolver,
    features: featureFlagResolver,
    bots: botInstances,
    // The invite link's bot name, from Telegram rather than the row (a rename leaves the
    // row stale). The send timeout is reused: it is one Telegram call under a customer's
    // nose, and a second knob for the same bound is a second thing to get wrong.
    botUsernames: new TelegramBotUsernames({
      bots: botInstances,
      apiBaseUrl: config.TELEGRAM_API_BASE_URL,
      timeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
    }),
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
  const referralReadService = new ReferralReadService({
    referrals: referralRepository,
    commissions: referralCommissionRepository,
    customers: customerRepository,
    guard,
  });

  const customerService = new CustomerService({
    referrals: referralProgram,
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

  /**
   * Products, under the FROZEN `catalog.*` permissions.
   *
   * The same platform dependencies every other write path takes, `scopeActivity`
   * included — the reader panels once skipped, which let a stopped tenant be given new
   * rows. No outbox: the event catalogue declares no product event and
   * `AGGREGATE_TYPES` has no `Product`, so a product mutation's evidence is its audit
   * row.
   */
  /*
   * The panel stack's two repositories and the sales gate, constructed HERE
   * because this is the first place they are needed: the customer catalogue
   * hides a product whose panel cannot take one more service, and an order
   * confirmation takes the slot before any money moves.
   */
  const panelRepository = new DrizzlePanelRepository(database.db);
  const panelCapacity = new DrizzlePanelCapacityRepository(database.db);
  const panelSalesGate = new PanelSalesGate({
    panels: panelRepository,
    capacity: panelCapacity,
    ids,
    clock,
    /*
     * The SERVICE list, and the same one `panelOperability` below passes for the
     * same reason: a provider can legitimately have a connection adapter — enough
     * to probe it and report it healthy — and no code that can create a user.
     *
     * Sharing the constant rather than the closure keeps the two evaluators
     * independent, which they must stay; sharing the LIST is what stops them
     * disagreeing about which providers this release can actually deliver on.
     */
    serviceAdapterExists: (providerType) =>
      SERVICE_PROVIDER_TYPES.includes(providerType as (typeof SERVICE_PROVIDER_TYPES)[number]),
  });

  /*
   * Constructed HERE rather than beside `OrderService`, which was its only reader
   * until the admin surfaces existed. Two consumers now share this one instance for
   * the reason the Telegram wiring states below: two repositories are two views of
   * the same rows, and nothing in the type system would notice them diverging.
   */
  const productCategoryRepository = new DrizzleProductCategoryRepository(database.db);

  const productService = new ProductService({
    resellers: resellerService,
    panelSales: panelSalesGate,
    repository: productRepository,
    /*
     * Membership only, never a panel projection.
     *
     * A product may not name another tenant's panel. `products_tenant_panel_fk`
     * (migration 0037) is what makes that true; this is what makes the refusal a
     * named 404 rather than an integrity violation reported as a 500.
     */
    panels: new DrizzlePanelDirectory(database.db),
    /* The category a product names, checked to exist in the tenant under a SHARE lock. */
    categories: productCategoryRepository,
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
   * Categories, under the SAME `catalog.*` permissions as products.
   *
   * `permissions.ts` labels those two keys "View products and categories" and "Create
   * or edit products and categories", so an operator holding them can already do this
   * by the product's own promise. A `categories.edit` invented here would have meant a
   * contracts change and a migration backfilling grants into every existing role, to
   * deliver a separation nobody asked for.
   *
   * It takes `productRepository` as well, for the one write that moves a product
   * between categories — the CATEGORY owns that, because what it has to be atomic with
   * is the destination category's continued existence.
   */
  const productCategoryService = new ProductCategoryService({
    categories: productCategoryRepository,
    products: productRepository,
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
  const paymentAccountRepository = new DrizzlePaymentAccountRepository(database.db);
  const paymentDestinationRepository = new DrizzlePaymentDestinationRepository(database.db);
  const receiptCaptureRepository = new DrizzleReceiptCaptureRepository(database.db);
  const paymentReceiptRepository = new DrizzlePaymentReceiptRepository(database.db);

  const orderRepository = new DrizzleOrderRepository(database.db);
  /*
   * The username lane, built before the order service that takes it.
   *
   * Three pieces, and each is a different question: the repository holds the rows, the
   * allocator decides the name, and the lane is the narrow port the orders module sees
   * — so `OrderService` does not acquire a panel repository to answer a question that
   * is not about orders. Same argument as `PanelSalesGate` beside it.
   */
  const serviceUsernameRepository = new DrizzleServiceUsernameRepository(database.db);
  const usernameLane = new PanelUsernameLane({
    allocator: new UsernameAllocator({
      repository: serviceUsernameRepository,
      ids,
      secrets: serviceSecrets,
      // The SAME hasher the operation ids use. `{customer4}` and `{order4}` have to
      // be stable across processes and replays, and two hashers is two answers.
      hash: sha256Hex,
    }),
    repository: serviceUsernameRepository,
    captures: new DrizzleUsernameCaptureRepository(database.db),
    ids,
    panels: panelRepository,
    customers: customerRepository,
  });
  /*
   * The pricing engine's door (WP8), built before the two services that price through
   * it. `docs/wp8-pricing-audit.md` P1: checkout, a customer's code, the commercial
   * actions and the operator's preview all come through this one object.
   */
  /*
   * Resellers (WP9-B, `docs/wp9-reseller-audit.md`): one runtime service every commercial
   * path asks — standing, entitlements, pricing layer, credit, purchase record — and the
   * operator's administration beside it.
   */
  const resellerAdminService = new ResellerAdminService({
    resellers: resellerRepository,
    customers: customerRepository,
    products: productRepository,
    categories: productCategoryRepository,
    panels: panelRepository,
    bots: botInstances,
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
  const discountRepository = new DrizzleDiscountRepository(database.db);
  const cashbackRuleRepository = new DrizzleCashbackRuleRepository(database.db);
  const orderCashbackRepository = new DrizzleOrderCashbackRepository(database.db);
  const pricingService = new PricingService({
    referrals: referralProgram,
    resellers: resellerService,
    discounts: discountRepository,
    cashbackRules: cashbackRuleRepository,
    orderCashback: orderCashbackRepository,
    outbox,
    ids,
  });
  /*
   * The operator's half of pricing (P12): the two rule catalogues and the read-only
   * preview. The preview is handed `pricingService` itself, so what an operator is
   * shown is what checkout would charge.
   */
  const discountAdminService = new DiscountAdminService({
    discounts: discountRepository,
    products: productRepository,
    categories: productCategoryRepository,
    customers: customerRepository,
    /* `sales.currency`: a fixed amount in any other currency would never apply. */
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
  const cashbackRuleAdminService = new CashbackRuleAdminService({
    rules: cashbackRuleRepository,
    products: productRepository,
    categories: productCategoryRepository,
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
  const pricingReadService = new PricingReadService({
    pricing: pricingService,
    products: productRepository,
    addons: serviceAddonRepository,
    customers: customerRepository,
    orders: orderRepository,
    discounts: discountRepository,
    orderCashback: orderCashbackRepository,
    resellerTerms: resellerRepository,
    guard,
    clock,
  });
  const orderService = new OrderService({
    pricing: pricingService,
    resellers: resellerService,
    discountCodes: new DrizzleDiscountCodeCaptureRepository(database.db),
    panelSales: panelSalesGate,
    categories: productCategoryRepository,
    usernames: usernameLane,
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
    panelSales: panelSalesGate,
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
    usernames: serviceUsernameRepository,
    // A customer's own rotation (WP6-C): its flag, its cooldown, and the block check.
    features: featureFlagResolver,
    settings: settingsResolver,
    customers: customerRepository,
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
    resellers: resellerService,
    pricing: pricingService,
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

  const paymentGatewayRepository = new DrizzlePaymentGatewayRepository(database.db);

  const paymentGatewayService = new PaymentGatewayService({
    repository: paymentGatewayRepository,
    audience: new DrizzleGatewayAudienceReader(database.db),
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    settings: settingsResolver,
  });

  /**
   * The reporter that says this installation took money it could not deliver for.
   *
   * Its notification lane is reached through a REF for the reason `opsLogRef` above
   * is: `NotificationService` is constructed further down — it needs the projection
   * settings and the feature resolver — and payment settlement is constructed here.
   * A façade with a stable identity is what lets both hold the same lane without
   * reordering half this file. The forwarding drops nothing, `tx` included, because
   * dropping it is exactly how a notification queued inside a settling transaction
   * came to survive that transaction rolling back.
   */
  const notificationsRef: { current: NotificationService | null } = { current: null };

  /*
   * One instance, shared by the refund service and the `sales.currency` guard.
   *
   * The guard asks it how much money could still go back in the currency an operator
   * is trying to leave; the service is what would write those credits. Same reader,
   * same answer.
   */
  const refundRepository = new DrizzleRefundRepository(database.db);

  /*
   * The cashback lane (WP8 P9): earned by the provisioner loop on delivery, reversed by
   * a refund in the refund's own transaction. Built here, before the refund service that
   * takes it.
   */
  const cashbackService = new CashbackService({
    orderCashback: orderCashbackRepository,
    wallet: walletRepository,
    payments: paymentRepository,
    refunds: refundRepository,
    outbox,
    uow,
    scopeActivity: tenants,
    clock,
    ids,
  });
  /*
   * The referral commission lane (WP9 F7, F8): the cashback lane's twin, decided for the
   * REFERRER's wallet — earned by the provisioner loop on delivery, reversed by a refund
   * in the refund's own transaction.
   */
  const referralCommissionService = new ReferralCommissionService({
    commissions: referralCommissionRepository,
    wallet: walletRepository,
    payments: paymentRepository,
    refunds: refundRepository,
    outbox,
    uow,
    scopeActivity: tenants,
    clock,
    ids,
  });
  const refundService = new RefundService({
    cashback: cashbackService,
    referrals: referralCommissionService,
    repository: refundRepository,
    /*
     * The payment READ only, narrowed by `RefundServiceDeps`.
     *
     * A refund is bounded by what a payment says was paid, and a module that could also
     * write a payment could move that bound — so the one thing this module must not
     * reach is the write half of the repository it derives its limit from.
     */
    payments: paymentRepository,
    /*
     * The ledger, `append` and `lockCustomer` only. No balance read: a customer who has
     * already spent a refunded payment is still owed the refund, so nothing here may
     * consult what the wallet currently holds.
     */
    wallet: walletRepository,
    /*
     * The order's lock, read and one edge (P3): an operator's refund that completes the
     * payment moves the order `PAID -> REFUNDED`.
     */
    orders: orderRepository,
    /*
     * Whether the operation that DELIVERS what the order bought is still undecided. The
     * type comes from `PURCHASED_AS`, the table the cashback earner and the provisioner
     * already share, so "the purchase operation" means one thing everywhere.
     */
    deliveries: {
      purchaseInProgress: (scope, order, tx) =>
        operationRepository.hasUnresolvedForOrder(scope, order.id, PURCHASED_AS[order.purpose], tx),
    },
    outbox,
    notifier: customerNotifier,
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });

  /**
   * The order's second terminal outcome, wired once and used by both lanes.
   *
   * After `refundService`, because it calls the one credit path rather than writing
   * a ledger entry of its own, and before `paymentService`, because settlement is
   * the first of the two lanes that reaches it. The provisioner is the second.
   */
  const undeliverableOrders = new UndeliverableOrderRefunder({
    /*
     * The order READ and the one edge, narrowed by the dependency's own type, so the
     * lane that gives money back cannot become a second place orders are managed
     * from.
     */
    orders: orderRepository,
    // `refundUndeliverable` alone: the money, and nothing about the order.
    refunds: refundService,
    // `release` alone. A refunded order holds no capacity.
    panelSales: panelSalesGate,
    usernames: usernameLane,
    // `release` alone: an undelivered trial stops counting against its customer.
    trials: trialGrantRepository,
    notifier: customerNotifier,
    opsLog,
    outbox,
    clock,
  });

  /** The append-only record of a receipt's credit-to-wallet disposition (D2). */
  const receiptCreditRepository = new DrizzleReceiptCreditRepository(database.db);

  const paymentService = new PaymentService({
    resellers: resellerService,
    undeliverable: undeliverableOrders,
    repository: paymentRepository,
    /*
     * The two READ methods only. This module consults a route and cannot configure one
     * — `payments.gateways.edit` is Finance's, and a customer-initiated command must
     * not reach the tenant's own eligibility rules.
     */
    gateways: paymentGatewayService,
    notifier: customerNotifier,
    orders: orderRepository,
    provisioning: provisioningService,
    /*
     * The READ half of the account repository, narrowed by the dependency's own type.
     *
     * A payment path that could create or edit an account would put a card number within
     * reach of a customer-initiated command. Managing them is
     * `PaymentAccountService`'s, under `payments.accounts.edit`.
     */
    accounts: paymentAccountRepository,
    destinations: paymentDestinationRepository,
    /*
     * The window a customer's "I have sent it" opens, in that tap's own transaction.
     *
     * Here rather than in `ReceiptService` because the tap and the window are one fact:
     * the reply asks for a file, and a reply that asked with no window on record would
     * be answered with `RECEIPT_NOT_EXPECTED` — the refusal for a file nobody asked
     * for, given to a customer who was asked.
     */
    receiptCaptures: receiptCaptureRepository,
    // The COUNT only. `PaymentServiceDeps` narrows it, so this module cannot file one.
    receipts: paymentReceiptRepository,
    // The READ only: a rejection's loser is told a credit won (D2).
    receiptCredits: receiptCreditRepository,
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
   * A receipt's third disposition (D2). The payment's read, lock and `resolve` edge, the
   * receipt COUNT, the ledger's `append` and `lockCustomer`, and its own table — narrowed
   * by its dependency type, so it cannot confirm a payment or file a receipt.
   */
  const receiptDispositionService = new ReceiptDispositionService({
    payments: paymentRepository,
    receipts: paymentReceiptRepository,
    credits: receiptCreditRepository,
    wallet: walletRepository,
    settings: settingsResolver,
    notifier: customerNotifier,
    outbox,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });

  /*
   * The reviewer's amount capture (D3). It holds the payment READ, the receipt COUNT and
   * the customer READ, and reaches money only through `creditToWallet` above.
   */
  const receiptCreditCaptureService = new ReceiptCreditCaptureService({
    captures: new DrizzleAdminAmountCaptureRepository(database.db),
    payments: paymentRepository,
    receipts: paymentReceiptRepository,
    customers: customerRepository,
    dispositions: receiptDispositionService,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });

  /*
   * The expiry lane, built in every role and STARTED only by the worker.
   *
   * Built everywhere for the reason the recovery executor is: construction is cheap
   * and a member that exists in one role's container and not another's is a member
   * whose absence is discovered at runtime. Starting is the role's decision, and
   * `main.worker.ts` is the only file that calls `start()`.
   */
  /*
   * Named, so a test can run ONE sweep rather than start a timer.
   *
   * The loop owns the schedule and the progress bookkeeping; the service is the
   * work. A suite that wants the work has no business starting a timer it then
   * has to stop.
   */
  const paymentExpirySweep = new PaymentExpiryService({
    panelSales: panelSalesGate,
    usernames: usernameLane,
    payments: paymentRepository,
    notifier: customerNotifier,
    orders: orderRepository,
    uow,
    audit,
    scopeActivity: tenants,
    clock,
    ids,
  });
  const paymentExpiryLoop = new PaymentExpiryLoop(paymentExpirySweep, {
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
  });

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

  /*
   * The panel operations service, constructed HERE rather than inline in the
   * container literal.
   *
   * It has TWO consumers now: the Web Admin's controller reads `container.panels`, and
   * the Telegram runtime is handed the same instance as `panelAdmin` (narrowed by a
   * `Pick` that excludes `setCredentials`). Two `new PanelService({...})` calls would be
   * two probe cooldown decisions and two idempotency stores over one panel — which is
   * the shape of defect the monitor's own comment warns about — so there is one.
   */
  const panelService = new PanelService({
    repository: panelRepository,
    capacity: panelCapacity,
    credentials: panelCredentials,
    /*
     * The same repository the allocator writes through, given to panels as the
     * narrow port it declares. One implementation, so the namespace key an address
     * change moves rows TO is derived by the function that derived the key they were
     * written with.
     */
    usernameNamespace: serviceUsernameRepository,
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
    serviceAdapterExists: (providerType) =>
      SERVICE_PROVIDER_TYPES.includes(providerType as (typeof SERVICE_PROVIDER_TYPES)[number]),
    cadence: probeCore.cadence,
  });

  const monitorBudgetReserve = monitorBudgetReserveFor(
    config.PANEL_PROBE_TENANT_LIMIT,
    config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
  );

  const panelMonitor = new PanelMonitorService(
    {
      discovery: new DrizzlePanelMonitorRepository(database.db),
      // How full each panel is, so the tick can say so. The SAME repository the
      // sales gate and the Web Admin's capacity card read — one set of counts,
      // three readers, so an alert cannot disagree with the card beside it.
      capacity: panelCapacity,
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
    /*
     * The vetoes other modules hold over one key each.
     *
     * `control` declares the port and knows nothing about money; commerce knows why
     * `sales.currency` cannot move while refundable payments are denominated in it.
     * Here is the only place the two meet, which is what keeps the dependency
     * pointing inward.
     */
    [
      new SalesCurrencyChangeGuard(refundRepository),
      // The trial product must be a product of this tenant (WP6-A).
      new TrialProductGuard(productRepository),
      // One per reminder threshold. The five have to agree with one another, and no
      // per-key schema can say so — see `ReminderThresholdsGuard`.
      ...ReminderThresholdsGuard.all(settingsResolver),
    ],
  );

  /**
   * The trial (WP6-A). After the flag resolver, which it reads, and after provisioning,
   * which it hands the granted order to — a trial is provisioned by the purchase path
   * and by nothing of its own. `docs/wp6-audit.md` §2.
   */
  const trialService = new TrialService({
    grants: trialGrantRepository,
    overrides: trialOverrideRepository,
    orders: orderRepository,
    products: productRepository,
    customers: customerRepository,
    wallet: walletRepository,
    usernames: usernameLane,
    panelSales: panelSalesGate,
    provisioning: provisioningService,
    settings: settingsResolver,
    features: featureFlagResolver,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    clock,
    ids,
  });
  /**
   * The operator's side of trials (WP6-B): ADR-0015's override, its global reset and
   * the view of both. It reads the same allowance evaluator `trialService` decides with,
   * and takes the same customer lock. `docs/wp6-audit.md` §7.
   */
  const trialAdminService = new TrialAdminService({
    grants: trialGrantRepository,
    overrides: trialOverrideRepository,
    resets: trialResetRepository,
    customers: customerRepository,
    wallet: walletRepository,
    settings: settingsResolver,
    features: featureFlagResolver,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });
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

  const serviceReminderSweep = new ServiceReminderService({
    reminders: new DrizzleServiceReminderRepository(database.db),
    notifier: customerNotifier,
    // The RESOLVERS, not the services. A background loop that could write a setting or
    // a flag is a background loop that could turn itself on, and the write paths are
    // where the permission check, the audit row and the combination validation live.
    settings: settingsResolver,
    features: featureFlagResolver,
    scopeActivity: tenants,
    uow,
    clock,
    ids,
  });
  const serviceReminderLoop = new ServiceReminderLoop(serviceReminderSweep, {
    // The same per-pass closure the payment expiry loop uses, and for the same
    // reason: the installation's tenant is a row, so it is not known while this
    // object is being built.
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: SERVICE_REMINDER_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
  });

  const templateRepository = new DrizzleTemplateRepository(database.db);
  const templateCatalogue = new I18nTemplateCatalogue();
  const templateResolver = new TemplateResolver(
    templateRepository,
    featureFlagResolver,
    templateCatalogue,
  );
  /*
   * Composes the destination block behind the application layer.
   *
   * Built after the resolver because it renders through it — four frozen keys, each a
   * tenant override away from being the tenant's own wording. `bot-runtime.ts` is handed
   * this rather than the resolver, so the surface can compose a destination and nothing
   * else.
   */
  const paymentDestinationRenderer = new PaymentDestinationRenderer(templateResolver);

  const paymentAccountService = new PaymentAccountService({
    repository: paymentAccountRepository,
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });

  /**
   * The receipt lane.
   *
   * It holds the WHOLE capture port, because it closes a window the payment path opens;
   * the payment READ alone, narrowed by its own type, because nothing here may confirm,
   * reject or settle anything — the addendum's own words, enforced by the dependency
   * rather than only by the permission.
   */
  const receiptService = new ReceiptService({
    captures: receiptCaptureRepository,
    receipts: paymentReceiptRepository,
    payments: paymentRepository,
    customers: customerRepository,
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  });

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
   * The bytes of a receipt, fetched with the token of the bot that received it.
   *
   * INFRASTRUCTURE injected into the controller, so the surface holds no network sink
   * and no token: what it gets back is bytes or `UNAVAILABLE`, and it cannot ask for
   * anything else.
   *
   * `botInstances` is the token lookup for the reason the messenger states two objects
   * up — a `file_id` is scoped to the bot that received it, and the receipt row records
   * which one that was. `NOTIFICATION_SEND_TIMEOUT_MS` is reused rather than given a key
   * of its own: both are one Telegram HTTP call under an operator's or a customer's
   * nose, and a second knob for the same bound is a second thing to get wrong. The FILE
   * base is the same configured origin, which is what Telegram itself uses and what lets
   * a local stand-in serve both in a test.
   */
  const receiptFiles = new TelegramReceiptFiles({
    bots: botInstances,
    apiBaseUrl: config.TELEGRAM_API_BASE_URL,
    fileBaseUrl: config.TELEGRAM_API_BASE_URL,
    timeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
  });

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
      /*
       * The ledger reader the refund sentence renders from. The wallet repository
       * itself, because both figures are derived from `wallet_entries` and a
       * second implementation would be a second answer to "how much did we give
       * back" — which is the thing `RefundService`'s one credit path exists to
       * prevent, applied to the reading side.
       */
      refundFigures: walletRepository,
      // The same repository, for the same reason: the three payment-credit sentences
      // (Payment File 02 §18) read their figure from the entries the payment names.
      paymentCredits: walletRepository,
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
      reminderSnapshots: new DrizzleServiceReminderSnapshotReader(database.db),
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

  /**
   * Where one customer's service announcement goes, or nothing.
   *
   * ONE definition, shared by the delivery lane that sends automatically and by
   * `ServiceAdminService`, which needs the same answer to decide whether to OFFER a
   * resend. Two copies would let the screen promise a send the sweep's own rule refuses
   * — and the rule that would drift is the `BLOCKED` one, which exists because an
   * operator blocking a customer between the claim and the send is a real race.
   */
  const customerContacts: CustomerContactReader = {
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
  };

  /**
   * The operator's READ of a service, with its action verdicts.
   *
   * A local rather than an inline construction, because TWO surfaces hold it now: the
   * Web Admin's HTTP controller and the Telegram management panel. One instance, so the
   * two cannot disagree about which actions a service allows — which is the whole point
   * of the verdicts being computed in one evaluator.
   */
  const serviceAdmin = new ServiceAdminService({
    services: serviceRepository,
    operations: operationRepository,
    guard,
    // Read-only, both: "can this panel do X" and "is there anywhere to send this".
    panels: panelOperability,
    contacts: customerContacts,
  });

  const deliveryService = new DeliveryService({
    services: serviceRepository,
    contacts: customerContacts,
    messenger: customerMessenger,
    // The same tenant kill switch every other write path reads.
    scopeActivity: tenants,
    uow,
    clock,
    guard,
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
    /*
     * The order READ and the confirmed payment READ, both narrowed.
     *
     * The provisioner asks two questions when a paid operation definitively fails —
     * what was bought, and what was paid for it — and answers them by giving the
     * money back through the same collaborator settlement uses. It must not be able
     * to settle an order or confirm a payment: nothing a panel says is evidence that
     * money arrived.
     */
    orders: orderRepository,
    payments: paymentRepository,
    undeliverable: undeliverableOrders,
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
          requestedByCustomerId: operation.requestedByCustomerId,
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
    cashback: cashbackService,
    referrals: referralCommissionService,
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

  // And the stranded-order reporter's lane, for the same reason and in the same
  // breath: constructed above, wired here, used only from a request or a worker
  // tick — both of which happen after this line.
  notificationsRef.current = notifications;

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

  /**
   * Tells the administrators who may decide a receipt that one is waiting (Phase 5T).
   *
   * ONE transaction for the whole fan-out, so a reviewer list read halfway through a
   * role change cannot produce a message for authority somebody no longer holds.
   * Addressed to each administrator's own chat through the lane's destination override,
   * snapshotted into the row — a message sent today still says which chat it went to
   * after that binding is revoked tomorrow. The dedupe key names the payment AND the
   * reviewer: one receipt is one message per person, and a redelivered upload is none.
   */
  const notifyReviewersOf = async (scope: TenantContext, paymentId: PaymentId): Promise<void> => {
    await uow.run(scope, async (tx) => {
      const payment = await paymentRepository.findById(scope, paymentId, tx);
      if (payment === null) return;
      const reviewers = await telegramAdmins.reviewers(
        scope,
        RECEIPTS_REVIEW_PERMISSION,
        newCorrelationId(ids.uuid()),
        tx,
      );
      for (const reviewer of reviewers) {
        const chatId = reviewer.admin.telegramUserId;
        /* istanbul ignore next -- `listTelegramBound` selects only bound rows. */
        if (chatId === null) continue;
        await notifications.queue(
          scope,
          {
            kind: 'RECEIPT_AWAITING_REVIEW',
            dedupeKey: `receipt.awaiting:${payment.id}:${reviewer.admin.id}`,
            templateKey: 'bot.admin.receipt_awaiting',
            values: { reference: payment.reference, total: payment.amount },
            destination: { transport: 'TELEGRAM', chatId, topicId: null },
          },
          tx,
        );
      }
    });
  };

  /**
   * The reminder configuration seam, named so BOTH surfaces and the test can hold it.
   *
   * Both halves go through the SAME application services the Web Admin uses, so the
   * two surfaces cannot drift: `list` charges `settings.view` — the key flags are
   * read under too, see `FeatureFlagsService.FEATURES_VIEW` —
   * `set` charges `settings.edit` and runs `ReminderThresholdsGuard` inside its own
   * transaction. Nothing here re-implements a rule, and nothing here is authorized by
   * holding the port — every call still takes the caller's actor.
   *
   * A named const rather than an inline literal on `BotRuntime`, because an
   * integration test that asserts "both surfaces obey one path" has to be able to
   * read the bot's path, and reading it through a hand-built copy would assert
   * nothing about the one the bot actually uses.
   */
  const reminderConfig: BotRuntimeDeps['reminderConfig'] = {
    read: async (scope, actor) => {
      const [values, flags] = await Promise.all([
        settingsService.list(scope, actor),
        featureFlags.list(scope, actor),
      ]);
      const number = (key: string, fallback: number): number => {
        const found = values.find((one) => one.key === key);
        return typeof found?.value === 'number' ? found.value : fallback;
      };
      const on = (key: string, fallback: boolean): boolean =>
        flags.find((one) => one.key === key)?.enabled ?? fallback;
      return {
        expiryEnabled: on('service_expiry_reminders', SERVICE_REMINDER_DEFAULTS.expiryEnabled),
        expiredNoticeEnabled: on(
          'service_expired_notice',
          SERVICE_REMINDER_DEFAULTS.expiredNoticeEnabled,
        ),
        usageEnabled: on('service_usage_reminders', SERVICE_REMINDER_DEFAULTS.usageEnabled),
        expiryFirstDays: number(
          'reminders.expiry_first_days',
          SERVICE_REMINDER_DEFAULTS.expiryFirstDays,
        ),
        expirySecondDays: number(
          'reminders.expiry_second_days',
          SERVICE_REMINDER_DEFAULTS.expirySecondDays,
        ),
        usageFirstPercent: number(
          'reminders.usage_first_percent',
          SERVICE_REMINDER_DEFAULTS.usageFirstPercent,
        ),
        usageSecondPercent: number(
          'reminders.usage_second_percent',
          SERVICE_REMINDER_DEFAULTS.usageSecondPercent,
        ),
        usageFinalPercent: number(
          'reminders.usage_final_percent',
          SERVICE_REMINDER_DEFAULTS.usageFinalPercent,
        ),
      };
    },
    write: async (scope, actor, key, value, idempotencyKey) => {
      try {
        await settingsService.set(scope, actor, {
          idempotencyKey,
          key,
          value,
          expectedVersion: null,
        });
        return { ok: true };
      } catch (error: unknown) {
        /*
         * ONLY the combination refusal becomes a value.
         *
         * `INVALID_VALUE` is what `ReminderThresholdsGuard` raises, and its message
         * is the Persian sentence an operator has to read. Everything else — a
         * denial, a stopped tenant, a lost connection — rethrows and is handled the
         * way it is everywhere else, because swallowing those would report a write
         * that did not happen as one that did, which is `SOURCE_BUG-002` exactly.
         */
        if (isNexaError(error) && error.code === CONTROL_ERROR_CODES.INVALID_VALUE) {
          return { ok: false, reason: error.message };
        }
        throw error;
      }
    },
  };

  return {
    config,
    logger,
    clock,
    ids,
    /*
     * Exposed so a test that constructs a service directly — because the
     * container's own loop resolves one tenant and the test drives two — can
     * hand it the SAME gate production uses rather than a stand-in that agrees
     * with nothing.
     */
    panelSales: panelSalesGate,
    panelCapacity,
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
    /** The sweep itself, so a test runs one pass instead of starting a timer. */
    paymentExpirySweep,
    usernameLane,
    usernameNamespace: serviceUsernameRepository,
    serviceReminderLoop,
    serviceReminderSweep,
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
    telegramAdmins,
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
    productCategories: productCategoryService,
    serviceAddons: serviceAddonService,
    discounts: discountAdminService,
    cashbackRules: cashbackRuleAdminService,
    pricingRead: pricingReadService,
    cashback: cashbackService,
    referrals: referralProgram,
    referralCommissions: referralCommissionService,
    referralsRead: referralReadService,
    resellers: resellerService,
    resellersAdmin: resellerAdminService,
    commercialActions: commercialActionService,
    trials: trialService,
    trialAdmin: trialAdminService,
    wallet: walletService,
    payments: paymentService,
    paymentAccounts: paymentAccountService,
    paymentGateways: paymentGatewayService,
    refunds: refundService,
    receiptDispositions: receiptDispositionService,
    receiptCreditCaptures: receiptCreditCaptureService,
    paymentGatewayProvisioning: paymentGatewayRepository,
    receipts: receiptService,
    receiptFiles,
    provisioning: provisioningService,
    serviceAdmin,
    provisioner,
    provisionerLoop,
    delivery: deliveryService,
    orders: orderService,
    botRuntime: new BotRuntime({
      /*
       * The main menu's routing table, built HERE because this is the only layer
       * that may read the catalogue on this path: the boundary check refuses
       * `@nexa/i18n` in a surface, and `TelegramCustomerMessenger` draws the same
       * keyboard from the same constant. One source, two consumers, no drift.
       */
      mainMenu: new Map([
        ...MAIN_MENU_BUTTONS.map(
          (button) => [CATALOGUE_FA[button.label], `/${button.command}`] as const,
        ),
        /*
         * The management panel's label, and it has to be HERE or the button does not
         * work at all.
         *
         * `TelegramCustomerMessenger` appends this row for a bound administrator, and
         * a tap on a reply keyboard arrives as ordinary TEXT — so without the route
         * `intentOf` cannot turn «پنل مدیریت» into `/admin` and answers
         * `bot.unknown_command`. That is precisely the failure the keyboard comment
         * warns about one constant over: a visible button matching nothing.
         *
         * The map carries NO authority. It translates a label into a command; whether
         * that command opens anything is decided by `adminTurn`, which resolves the
         * binding and finds nothing for a customer who types the same words.
         */
        [CATALOGUE_FA[ADMIN_MENU_BUTTON.label], `/${ADMIN_MENU_COMMAND}`] as const,
      ]),
      destinations: paymentDestinationRenderer,
      receipts: receiptService,
      receiptCredits: receiptCreditCaptureService,
      telegramAdmins,
      /*
       * The reviewers' poke, Phase 5T.
       *
       * The transaction is opened HERE because a surface must not open one, and one
       * transaction covers the whole fan-out so a reviewer list read halfway through a
       * role change cannot produce a message for authority somebody no longer holds.
       *
       * Addressed to each administrator's OWN chat through the lane's destination
       * override — snapshotted into the row, so a message sent today still says which
       * chat it went to after that binding is revoked tomorrow. The dedupe key names
       * the payment AND the reviewer: one receipt produces one message per person, and
       * a redelivered upload produces none.
       */
      notifyReviewers: async (scope, paymentId) => {
        /*
         * Swallowed HERE, and recorded, because the surface awaits this.
         *
         * `submitReceipt` calls it inside the try whose catch is `refusal`, and
         * `refusal` RETHROWS anything it has no reply for — so a failed settings read
         * or notification insert would have cost the customer their
         * "receipt received" answer for a receipt that is already committed, and
         * Telegram's redelivery answers `filed: false`, which skips the poke for ever.
         * The queue in the panel is the durable record; this is the poke, and a poke
         * that failed is a log line rather than a customer left in silence.
         */
        try {
          await notifyReviewersOf(scope, paymentId);
        } catch (error) {
          logger.error(
            { err: error instanceof Error ? error.name : 'unknown', paymentId },
            'Could not tell the reviewers a receipt is waiting.',
          );
        }
      },
      /*
       * The one write the turn makes after its Telegram send, and the transaction
       * it needs, kept OUT of the surface.
       *
       * `OQ-4H-01`. A surface must not open a transaction — the runtime has no
       * unit of work and gets none here — so the composition root supplies a
       * function that opens one and calls the same notifier the background lanes
       * use. Nothing about the enqueue is different because the caller is
       * interactive; only the decision to make it is.
       *
       * No activity check, and it is the SAME stated exception
       * `OperationOutcomeAnnouncer` takes — `docs/conventions.md` names both.
       * The command this stands in for already checked activity inside its own
       * transaction and committed, so the scope was accepting work when it ran;
       * a stop landing between that commit and Telegram's 429 must not turn a
       * recorded transfer into silence. It may enqueue and nothing else.
       */
      queueRateLimitedFact: async (scope, customerId, kind, subjectId, retryAfterMs) => {
        await uow.run(scope, async (tx) => {
          const now = clock.now();
          // Telegram's own deadline becomes the row's floor. `undefined` means it
          // sent no `retry_after`, and then the row is due now like every other.
          const notBefore =
            retryAfterMs === undefined ? null : new Date(now.getTime() + retryAfterMs);
          return customerNotifier.notify(scope, customerId, kind, subjectId, now, tx, notBefore);
        });
      },
      customers: customerService,
      payments: paymentService,
      wallet: walletService,
      referrals: referralProgram,
      // The SAME instances the container exposes, not new ones. Two order services
      // would each hold their own idempotency view, and a redelivered Telegram update
      // handled by one would not be seen as a replay by the other — which is the whole
      // mechanism that stops a redelivery becoming a second order.
      products: productService,
      commercial: commercialActionService,
      trials: trialService,
      orders: orderService,
      // The SAME messenger the delivery sweep uses, for the reason above it.
      messenger: customerMessenger,
      // And the same provisioning and delivery services, for the same reason: a
      // customer-requested resend and the automatic sweep share `markSendStarted`,
      // and two instances would share nothing.
      services: provisioningService,
      // The operator's READ of a service, for the admin panel's services section.
      serviceAdmin,
      /*
       * The panels section's four operations, Phase 6B.
       *
       * The SAME `PanelService` the Web Admin's controller holds, narrowed by the
       * `Pick` on `BotRuntimeDeps` — so the permission each operation charges, the
       * audit row it writes and the probe budget it spends are one implementation with
       * two callers. `setCredentials` is outside that `Pick`, which is how "credentials
       * are the Web Admin's" becomes a type error rather than a convention.
       */
      panelAdmin: panelService,
      /*
       * The SAME `ProductCategoryService` the Web Admin's `/product-categories`
       * controller holds, so a category has one set of rules on both surfaces.
       */
      productCategories: productCategoryService,
      clock,
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
      /*
       * The reminder configuration seam for the Telegram admin section.
       *
       * Both halves go through the SAME application services the Web Admin uses, so the
       * two surfaces cannot drift: `list` charges `settings.view` — the key flags are
       * read under too, see `FeatureFlagsService.FEATURES_VIEW` —
       * `set` charges `settings.edit` and runs `ReminderThresholdsGuard` inside its own
       * transaction. Nothing here re-implements a rule, and nothing here is authorized
       * by holding the port.
       */
      reminderConfig,
      purchaseTitle: async (scope, orderId) => {
        const order = await orderRepository.findById(scope, orderId);
        return order?.line.title ?? null;
      },
    }),
    panels: panelService,
    /*
     * The bot's own reminder-configuration seam, exposed so a test can read the path
     * the SURFACE uses rather than a copy of it. Nothing else holds it: the HTTP
     * surface reaches the same services directly.
     */
    reminderConfig,
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
      await serviceReminderLoop.stop();
      await customerNotificationLoop.stop();
      await redis.close();
      await database.close();
    },
  };
}

export const CONTAINER = Symbol('CONTAINER');
