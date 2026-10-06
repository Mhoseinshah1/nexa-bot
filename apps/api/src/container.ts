import { CustomerDirectMessageService } from './modules/commerce/direct-messages/application/customer-direct-message.service.js';
import { DrizzleDirectMessageRepository } from './modules/commerce/direct-messages/infrastructure/drizzle-direct-message.repository.js';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_MENU_BUTTON,
  ADMIN_MENU_COMMAND,
  BACKUP_LEASE_STALE_AFTER_MS,
  BACKUP_SCHEDULE_SETTING_KEYS,
  PAYMENT_GATEWAY_DESCRIPTORS,
  CAMPAIGN_SCHEDULE_INTERVAL_MS,
  CHANNEL_MEMBERSHIP_TIMEOUT_MS,
  COUNTER_CAP,
  MAIN_MENU_BUTTONS,
  MAX_REQUESTS_PER_PROBE,
  OPERATION_LEASE_SECONDS_MIN,
  TICKET_REPLY_FILE_RETENTION_DAYS,
  NOTIFICATION_RULES,
  DIRECT_MESSAGE_FILE_RETENTION_DAYS,
  INCIDENT_SCHEDULER_INTERVAL_MS,
  canAdjustDeviceLimit,
  canChangeLocation,
  // Round N: the mass credit's notification renders the amount the ledger holds.
  money,
  faqNumberMarker,
  isSystemContext,
  systemJobActor,
  type PanelBalancingStrategy,
} from '@nexa/contracts';
import type {
  AdminId,
  AuditWriter,
  TelegramChannel,
  Clock,
  CurrencyCode,
  IdGenerator,
  IdempotencyStore,
  Logger,
  OperationalEventRecorder,
  PasswordHasher,
  SecretCipher,
  TenantId,
} from '@nexa/contracts';
import { CATALOGUE_FA, createTranslator } from '@nexa/i18n';
import type {
  OperationType,
  BotInstanceId,
  PaymentGatewayProvider,
  ProductId,
  TenantContext,
  Translator,
  // Round N: the audience's balance range is written in the selling currency.
  SalesCurrencyCode,
} from '@nexa/contracts';

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
import { PanelPlacementService } from './modules/platform/panels/application/panel-placement.js';
import { DrizzleOrderPlacementRepository } from './modules/platform/panels/infrastructure/drizzle-order-placement.repository.js';
import { PanelHealthDashboardService } from './modules/platform/panels/application/panel-health-dashboard.js';
import { DrizzlePanelFleetStatsReader } from './modules/platform/panels/infrastructure/drizzle-panel-fleet-stats.js';
import { PanelMonitorService } from './modules/platform/panels/application/panel-monitor.service.js';
import type { ProbeCoreDeps } from './modules/platform/panels/application/probe-core.js';
import {
  IMPLEMENTED_PROVIDER_TYPES,
  SERVICE_PROVIDER_TYPES,
  providerAdapter,
  providerServiceAdapter,
} from './modules/platform/providers/infrastructure/adapter-registry.js';
// WP-A8: advanced provider settings.
import { PanelAdvancedService } from './modules/platform/panels/application/panel-advanced.service.js';
import { PanelPolicyReader } from './modules/platform/panels/application/panel-policy.js';
import { DrizzlePanelPolicyRepository } from './modules/platform/panels/infrastructure/drizzle-panel-policy.repository.js';
import { PROVIDER_RULES } from './modules/platform/providers/infrastructure/provider-rules.js';
import { SystemClock } from './infrastructure/clock.js';
import { Uuidv7IdGenerator } from './infrastructure/ids.js';
import { AesGcmSecretCipher } from './infrastructure/crypto/secret-cipher.js';
import { hostname } from 'node:os';
import { resolveKeyring } from './infrastructure/crypto/resolve-keyring.js';
import { InstallationKeyring } from './infrastructure/crypto/installation-keyring.js';
import { FAST_KIT_KDF, PRODUCTION_KIT_KDF } from './infrastructure/crypto/recovery-kit.js';
import { InstallationKeyService } from './modules/platform/recovery/application/installation-key.service.js';
import { DrizzleInstallationKeyRepository } from './modules/platform/recovery/infrastructure/drizzle-installation-key.repository.js';
import {
  FilesystemRetainedArchiveScanner,
  InstallationKeyLoader,
  KeyringRecoveryKeyCoverage,
  PgCandidateKeyStore,
} from './modules/platform/recovery/infrastructure/installation-key-adapters.js';
import { blocksReadiness } from './modules/platform/system/application/readiness.service.js';
import { createLogger, newCorrelationId } from './infrastructure/logging/logger.js';
import { createDatabase, type DatabaseHandle } from './infrastructure/persistence/database.js';
import { createRedis, type RedisHandle } from './infrastructure/redis/redis.js';
import { RedisInteractionCounter } from './infrastructure/redis/redis-interaction-counter.js';
import { AntiSpamService } from './modules/commerce/customers/application/anti-spam.service.js';
import { ChannelMembershipService } from './modules/commerce/customers/application/channel-membership.service.js';
import { TelegramChatMemberReader } from './modules/commerce/customers/infrastructure/telegram-chat-member.reader.js';
import {
  DrizzleUnitOfWork,
  type TransactionScope,
} from './infrastructure/persistence/unit-of-work.js';

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
import {
  DrizzleIdempotencyStore,
  hashRequest,
} from './modules/platform/idempotency/infrastructure/drizzle-idempotency-store.js';
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
import { DrizzleBotManagementRepository } from './modules/platform/tenancy/infrastructure/drizzle-bot-management.repository.js';
import { BotManagementService } from './modules/platform/tenancy/application/bot-management.service.js';
import { BotCommandSyncService } from './modules/platform/tenancy/application/bot-command-sync.service.js';
import { BotCommandSyncConsumer } from './modules/platform/tenancy/application/bot-command-sync.consumer.js';
import { BotCommandSyncLoop } from './modules/platform/tenancy/application/bot-command-sync-loop.js';
import { BotMenuService } from './modules/platform/tenancy/application/bot-menu.service.js';
import { BotMenuBuilderService } from './modules/control/bot-menu-builder/application/bot-menu-builder.service.js';
import { MainMenuSettingGuard } from './modules/control/bot-menu-builder/application/main-menu-setting-guard.js';
import { PublishedMainMenuSource } from './modules/control/bot-menu-builder/application/main-menu-source.js';
import { DrizzleMainMenuBuilderRepository } from './modules/control/bot-menu-builder/infrastructure/drizzle-main-menu-builder.repository.js';
import { CommandMenu } from './modules/platform/tenancy/application/command-menu.js';
import { DrizzleBotCommandSyncRepository } from './modules/platform/tenancy/infrastructure/drizzle-bot-command-sync.repository.js';
import { RetentionSweeper } from './modules/platform/identity/application/retention-sweeper.js';
import { AccountSecurityService } from './modules/platform/identity/application/account-security.service.js';
import {
  DrizzleLoginChallengeRepository,
  DrizzleSecondFactorRepository,
  DrizzleSecurityEventReader,
} from './modules/platform/identity/infrastructure/drizzle-second-factor.repository.js';
import { RecordPingService } from './modules/platform/system/application/record-ping.service.js';
import { PingLogConsumer } from './modules/platform/opslog/application/ping-log.consumer.js';
import {
  DrizzleOperationalConditionReader,
  DrizzleOperationalEventReader,
} from './modules/platform/opslog/infrastructure/drizzle-operational-event.reader.js';
import { MonitorProfileService } from './modules/platform/panels/application/monitor-profile.service.js';
import { DiagnosticsService } from './modules/platform/system/application/diagnostics.service.js';
import { DrizzleDiagnosticsReader } from './modules/platform/system/infrastructure/drizzle-diagnostics.reader.js';
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
import { RoutedBackupDelivery } from './modules/platform/backup/application/routed-backup-delivery.js';
import { BackupSchedulePolicy } from './modules/platform/backup/application/backup-schedule.js';
import { OpsGroupBackupTopicAdapter } from './modules/control/ops-group/application/backup-topic.js';
import { FilesystemBackupWorkspaces } from './modules/platform/backup/infrastructure/workspace.js';
import { OpsLogService } from './modules/platform/opslog/application/opslog.service.js';
import { IncidentService } from './modules/platform/incidents/application/incident.service.js';
import { IncidentSchedulerLoop } from './modules/platform/incidents/application/incident-scheduler-loop.js';
import { DrizzleIncidentRepository } from './modules/platform/incidents/infrastructure/drizzle-incident.repository.js';
import { SupportContextBuilder } from './modules/commerce/support-context/application/support-context.builder.js';
import { DrizzleSupportContextReader } from './modules/commerce/support-context/infrastructure/drizzle-support-context.reader.js';
import { ModuleIncidentEffects } from './modules/platform/incidents/infrastructure/incident-effects.js';
import { NotificationCenterService } from './modules/platform/opslog/application/notification-center.service.js';
import { DrizzleNotificationInboxRepository } from './modules/platform/opslog/infrastructure/drizzle-notification-inbox.repository.js';
import { DrizzleSettingRepository } from './modules/control/settings/infrastructure/drizzle-settings.repository.js';
import { SettingsResolver } from './modules/control/settings/application/settings-resolver.js';
import { SettingsService } from './modules/control/settings/application/settings.service.js';
import { ReminderThresholdsGuard } from './modules/control/settings/application/reminder-thresholds.guard.js';
import { QuietHoursGuard } from './modules/control/settings/application/quiet-hours.guard.js';
import { DrizzleQuietHoursLock } from './modules/control/settings/infrastructure/drizzle-quiet-hours.lock.js';
import { SignupGiftTermsGuard } from './modules/control/settings/application/signup-gift-terms.guard.js';
import { SignupGiftActivationGuard } from './modules/control/features/application/signup-gift-activation.guard.js';
import { TenantMediaService } from './modules/control/media/application/tenant-media.service.js';
import { DrizzleTenantMediaRepository } from './modules/control/media/infrastructure/drizzle-tenant-media.repository.js';
import {
  QrTemplateGuard,
  QrTemplatePreviewService,
} from './modules/control/media/application/qr-template.service.js';
import { ReferralSignupGiftService } from './modules/commerce/referrals/application/referral-signup-gift.service.js';
import { DrizzleReferralSignupGiftRepository } from './modules/commerce/referrals/infrastructure/drizzle-referral-signup-gift.repository.js';
import { CONTROL_ERROR_CODES, SERVICE_REMINDER_DEFAULTS, isNexaError } from '@nexa/contracts';
import { DrizzleFeatureFlagRepository } from './modules/control/features/infrastructure/drizzle-feature-flags.repository.js';
import {
  FeatureFlagResolver,
  FeatureFlagsService,
} from './modules/control/features/application/feature-flags.service.js';
import { DrizzleTemplateRepository } from './modules/control/templates/infrastructure/drizzle-template.repository.js';
import {
  DEFAULT_TEMPLATE_LOCALE,
  TemplateResolver,
} from './modules/control/templates/application/template-resolver.js';
import { CustomerService } from './modules/commerce/customers/application/customer.service.js';
import { CustomerControlService } from './modules/commerce/customers/application/customer-control.service.js';
import { CustomerCrmService } from './modules/commerce/customers/application/customer-crm.service.js';
import { DrizzleCustomerCrmRepository } from './modules/commerce/customers/infrastructure/drizzle-customer-crm.repository.js';
import { CustomerInsightService } from './modules/commerce/customers/application/customer-insight.service.js';
import { CustomerAccountTransferService } from './modules/commerce/customers/application/customer-account-transfer.service.js';
import { DrizzleCustomerInsightReader } from './modules/commerce/customers/infrastructure/drizzle-customer-insight.reader.js';
import { DrizzleCustomerAccountTransferRepository } from './modules/commerce/customers/infrastructure/drizzle-customer-account-transfer.repository.js';
import { ManualOrderService } from './modules/commerce/orders/application/manual-order.service.js';
import { CustomerServicesToggleService } from './modules/commerce/provisioning/application/customer-services-toggle.service.js';
import { DrizzleCustomerRepository } from './modules/commerce/customers/infrastructure/drizzle-customer.repository.js';
import { DrizzleCustomerLocationOverrideRepository } from './modules/commerce/locations/infrastructure/drizzle-customer-location-override.repository.js';
import { TelegramCustomerMessenger } from './modules/commerce/messaging/infrastructure/telegram-customer-messenger.js';
import { ProductService } from './modules/commerce/catalog/application/product.service.js';
import { LegacyProductService } from './modules/commerce/catalog/application/legacy-product.service.js';
import { LegacyTrialEligibilityService } from './modules/commerce/trials/application/legacy-trial-eligibility.service.js';
import { DrizzleLegacyTrialEligibilityRepository } from './modules/commerce/trials/infrastructure/drizzle-legacy-trial-eligibility.repository.js';
import { DrizzleLegacyProductShapeRepository } from './modules/commerce/catalog/infrastructure/drizzle-legacy-product-shape.repository.js';
import { ProductCategoryService } from './modules/commerce/catalog/application/product-category.service.js';
import { ServiceAddonService } from './modules/commerce/catalog/application/addon.service.js';
import { CommercialActionService } from './modules/commerce/commercial/application/commercial-action.service.js';
import { TrialService } from './modules/commerce/trials/application/trial.service.js';
import { TrialProductGuard } from './modules/commerce/trials/application/trial-product.guard.js';
import { MainMenuLayout } from './modules/commerce/messaging/application/main-menu.js';
import { DrizzlePanelTrialConfigRepository } from './modules/commerce/trials/infrastructure/drizzle-panel-trial-config.repository.js';
import { PanelTrialService } from './modules/commerce/trials/application/panel-trial.service.js';
import { trialOffersFor } from './modules/commerce/trials/application/trial-offers.js';
import { DrizzleTrialGrantRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-grant.repository.js';
import { DrizzleTrialOverrideRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-override.repository.js';
import { DrizzleTrialResetRepository } from './modules/commerce/trials/infrastructure/drizzle-trial-reset.repository.js';
import { TrialAdminService } from './modules/commerce/trials/application/trial-admin.service.js';
import { AudienceService } from './modules/commerce/audience/application/audience.service.js';
import { DrizzleAudienceReader } from './modules/commerce/audience/infrastructure/drizzle-audience.reader.js';
import { DrizzleFrozenAudienceRepository } from './modules/commerce/audience/infrastructure/drizzle-frozen-audience.repository.js';
import { BroadcastService } from './modules/commerce/broadcasts/application/broadcast.service.js';
import { BroadcastDispatcher } from './modules/commerce/broadcasts/application/broadcast-dispatcher.js';
import {
  BROADCAST_INTERVAL_MS,
  BroadcastLoop,
} from './modules/commerce/broadcasts/application/broadcast-loop.js';
import { DrizzleBroadcastRepository } from './modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository.js';
import { DrizzleRecipientFactsReader } from './modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader.js';
import { TelegramBroadcastTransport } from './modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport.js';
import { BulkOperationService } from './modules/commerce/bulk-operations/application/bulk-operation.service.js';
import { BulkOperationProcessor } from './modules/commerce/bulk-operations/application/bulk-operation-processor.js';
import {
  BULK_OPERATION_INTERVAL_MS,
  BulkOperationLoop,
} from './modules/commerce/bulk-operations/application/bulk-operation-loop.js';
import { DrizzleBulkOperationRepository } from './modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository.js';
import { DrizzleCommercialActionRepository } from './modules/commerce/commercial/infrastructure/drizzle-commercial-action.repository.js';
import {
  displayedServiceLocation,
  initialLocationOf,
  LocationChangePolicy,
} from './modules/commerce/locations/application/location-change-policy.js';
import { LocationChangeService } from './modules/commerce/locations/application/location-change.service.js';
import { ServiceLocationAdminService } from './modules/commerce/locations/application/service-location-admin.service.js';
import {
  DrizzleLocationChangeRepository,
  DrizzleServiceLocationRepository,
} from './modules/commerce/locations/infrastructure/drizzle-service-location.repository.js';
import { DrizzleServiceAddonRepository } from './modules/commerce/catalog/infrastructure/drizzle-addon.repository.js';
import {
  DrizzlePanelDirectory,
  DrizzleProductCategoryRepository,
  DrizzleProductRepository,
} from './modules/commerce/catalog/infrastructure/drizzle-product.repository.js';
import { DrizzleWalletRepository } from './modules/commerce/wallet/infrastructure/drizzle-wallet.repository.js';
import { WalletService } from './modules/commerce/wallet/application/wallet.service.js';
import { MigrationOpeningBalanceService } from './modules/commerce/wallet/application/migration-opening-balance.service.js';
import { LegacyReviewQueueService } from './modules/platform/legacy-import/application/legacy-review-queue.service.js';
import { LegacyAdoptionService } from './modules/commerce/legacy-adoption/application/legacy-adoption.service.js';
import { DrizzleLegacyAdoptionStore } from './modules/commerce/legacy-adoption/infrastructure/drizzle-legacy-adoption.store.js';
import { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import type { LegacyAdoptionPort } from './modules/platform/legacy-importer/application/ports.js';
import { DrizzleLegacyImporterRepository } from './modules/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository.js';
import { RickpanelInventorySource } from './modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source.js';
import { DrizzleLegacyImportRepository } from './modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository.js';
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
import { DrizzleSupportFaqRepository } from './modules/control/support/infrastructure/drizzle-support-faq.repository.js';
import { SupportFaqService } from './modules/control/support/application/support-faq.service.js';
import { DrizzleSupportKnowledgeRepository } from './modules/control/support-knowledge/infrastructure/drizzle-support-knowledge.repository.js';
import { SupportKnowledgeService } from './modules/control/support-knowledge/application/support-knowledge.service.js';
import { SupportLearningService } from './modules/control/support-knowledge/application/support-learning.service.js';
import { SupportKnowledgeBuildService } from './modules/control/support-knowledge/application/support-knowledge-build.service.js';
import { NexaKnowledgeSources } from './modules/control/support-knowledge/infrastructure/nexa-knowledge-sources.js';
import { DrizzleTermsRepository } from './modules/control/terms/infrastructure/drizzle-terms.repository.js';
import { TermsService } from './modules/control/terms/application/terms.service.js';
import { TermsAcceptanceService } from './modules/control/terms/application/terms-acceptance.service.js';
import { ClientAppVideoService } from './modules/control/client-apps/application/client-app-video.service.js';
import { ClientAppVideoWebService } from './modules/control/client-apps/application/client-app-video-web.service.js';
import { DeliveryTutorialService } from './modules/control/client-apps/application/delivery-tutorial.service.js';
import { DeliveryTutorialSender } from './modules/control/client-apps/application/delivery-tutorial-sender.js';
import { DrizzleDeliveryTutorialRepository } from './modules/control/client-apps/infrastructure/drizzle-delivery-tutorial.repository.js';
import { DrizzleClientAppVideoRepository } from './modules/control/client-apps/infrastructure/drizzle-client-app-video.repository.js';
import { ClientAppService } from './modules/control/client-apps/application/client-app.service.js';
import { ClientAppCatalog } from './modules/control/client-apps/application/client-app-catalog.js';
import { ProvisionedServiceFacts } from './modules/control/client-apps/application/customer-service-facts.js';
import { DrizzleClientAppRepository } from './modules/control/client-apps/infrastructure/drizzle-client-app.repository.js';
import {
  SupportFaqSeeder,
  SupportScreenReader,
} from './modules/control/support/application/support-screen.reader.js';
import type {
  CustomerContactReader,
  DeliveryQrRenderer,
} from './modules/commerce/provisioning/application/ports.js';
import { ReceiptService } from './modules/commerce/payments/application/receipt.service.js';
import { TelegramReceiptFiles } from './modules/commerce/payments/infrastructure/telegram-receipt-files.js';
import { PaymentService } from './modules/commerce/payments/application/payment.service.js';
import { RefundService } from './modules/commerce/payments/application/refund.service.js';
import { ServiceRefundRequestService } from './modules/commerce/payments/application/service-refund-request.service.js';
import { ServiceRefundDecisionService } from './modules/commerce/payments/application/service-refund-decision.service.js';
import { ServiceRefundPushConsumer } from './modules/commerce/payments/application/service-refund-push.consumer.js';
import { ServiceRefundPushService } from './modules/commerce/payments/application/service-refund-push.service.js';
import { DrizzleServiceRefundRequestRepository } from './modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository.js';
import { DrizzleServiceRefundPushRepository } from './modules/commerce/payments/infrastructure/drizzle-service-refund-push.repository.js';
import { ReceiptDispositionService } from './modules/commerce/payments/application/receipt-disposition.service.js';
import { PaymentTimelineService } from './modules/commerce/payments/application/payment-timeline.service.js';
import { DrizzlePaymentTimelineReader } from './modules/commerce/payments/infrastructure/drizzle-payment-timeline.reader.js';
import { ReceiptCreditCaptureService } from './modules/commerce/payments/application/receipt-credit-capture.service.js';
import {
  receiptBlockCaptures,
  receiptRejectCaptures,
  type ReceiptBlockCaptureService,
  type ReceiptRejectCaptureService,
} from './modules/commerce/payments/application/receipt-reason-policies.js';
import { customerBlockCaptures } from './modules/commerce/customers/application/customer-block-capture.js';
import { ReceiptReviewCaption } from './modules/commerce/payments/application/receipt-review-caption.js';
import { FinancialLogConsumer } from './modules/commerce/payments/application/financial-log.consumer.js';
import { ReceiptReviewPushConsumer } from './modules/commerce/payments/application/receipt-review-push.consumer.js';
import { ReceiptReviewPushService } from './modules/commerce/payments/application/receipt-review-push.service.js';
import {
  RECEIPT_PUSH_INTERVAL_MS,
  ReceiptReviewPushLoop,
} from './modules/commerce/payments/application/receipt-review-push-loop.js';
import { DrizzleReceiptReviewPushRepository } from './modules/commerce/payments/infrastructure/drizzle-receipt-review-push.repository.js';
import { DrizzleReceiptReviewFactsReader } from './modules/commerce/payments/infrastructure/drizzle-receipt-review-facts.reader.js';
// WP-A7: the support ticket system.
import { TicketService } from './modules/commerce/tickets/application/ticket.service.js';
import { TicketCategoryService } from './modules/commerce/tickets/application/ticket-category.service.js';
import { TicketScreenComposer } from './modules/commerce/tickets/application/ticket-screens.js';
import { TicketSupportNotifyConsumer } from './modules/commerce/tickets/application/ticket-support-notify.consumer.js';
import { DrizzleTicketRepository } from './modules/commerce/tickets/infrastructure/drizzle-ticket.repository.js';
import { DrizzleTicketCategoryRepository } from './modules/commerce/tickets/infrastructure/drizzle-ticket-category.repository.js';
import { DrizzleTicketContextReader } from './modules/commerce/tickets/infrastructure/drizzle-ticket-context.reader.js';
import {
  notificationButtons,
  receiptReviewButtons,
  refundRequestReviewButtons,
} from './surfaces/telegram/bot-runtime.js';
import { DrizzleAdminAmountCaptureRepository } from './modules/commerce/payments/infrastructure/drizzle-admin-amount-capture.repository.js';
import { DrizzleReceiptCreditRepository } from './modules/commerce/payments/infrastructure/drizzle-receipt-credit.repository.js';
import { DrizzleRefundRepository } from './modules/commerce/payments/infrastructure/drizzle-refund.repository.js';
import { SalesCurrencyChangeGuard } from './modules/commerce/payments/application/sales-currency-change.guard.js';
import { PaymentExpiryService } from './modules/commerce/payments/application/payment-expiry.service.js';
import {
  PaymentExpiryLoop,
  PAYMENT_EXPIRY_INTERVAL_MS,
} from './modules/commerce/payments/application/payment-expiry-loop.js';
import {
  TONPAYS_TIMEOUT_MS,
  TonPaysAdapter,
} from './modules/commerce/payments/infrastructure/tonpays-adapter.js';
import { DrizzleGatewayInvoiceRepository } from './modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository.js';
import type {
  CardTransferGatewayAdapter,
  ExternalGatewayAdapter,
} from './modules/commerce/payments/application/gateway-invoice-ports.js';
import { GatewayReceiptCaptureService } from './modules/commerce/payments/application/gateway-receipt-capture.service.js';
import { DrizzleGatewayCardTransferRepository } from './modules/commerce/payments/infrastructure/drizzle-gateway-card-transfer.repository.js';
import { TonPaysTelegramAdapter } from './modules/commerce/payments/infrastructure/tonpays-telegram-adapter.js';
import { NowPaymentsAdapter } from './modules/commerce/payments/infrastructure/nowpayments-adapter.js';
import { CentralPayAdapter } from './modules/commerce/payments/infrastructure/centralpay-adapter.js';
import { TelegramStarsAdapter } from './modules/commerce/payments/infrastructure/telegram-stars-adapter.js';
import { FxService } from './modules/commerce/fx/application/fx.service.js';
import type { FxSourceAdapter } from './modules/commerce/fx/application/ports.js';
import type {
  CategoryColors,
  CategoryIcons,
  FxSource,
  InlineButtonIcons,
  InlineButtonStyles,
  QrTemplate,
} from '@nexa/contracts';
import {
  FX_REFRESH_INTERVAL_MS,
  FxRefreshLoop,
} from './modules/commerce/fx/application/fx-refresh-loop.js';
import {
  StarsPerUsdtGuard,
  StarsPricingModeGuard,
} from './modules/commerce/fx/application/stars-pricing.guards.js';
import { DrizzleFxQuoteRepository } from './modules/commerce/fx/infrastructure/drizzle-fx.repository.js';
import {
  FX_SOURCE_MAX_RESPONSE_BYTES,
  FX_SOURCE_TIMEOUT_MS,
} from './modules/commerce/fx/infrastructure/fx-source-parsing.js';
import { NobitexFxSource } from './modules/commerce/fx/infrastructure/nobitex-source.js';
import { WallexFxSource } from './modules/commerce/fx/infrastructure/wallex-source.js';
import { TelegramStarsCheckoutAnswerer } from './modules/commerce/payments/infrastructure/telegram-stars-checkout-answerer.js';
import { StarsPaymentService } from './modules/commerce/payments/application/telegram-stars-payment.service.js';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from './modules/commerce/payments/infrastructure/drizzle-gateway-credentials.js';
import {
  GATEWAY_CREATE_BATCH,
  GATEWAY_INQUIRY_BATCH,
  GATEWAY_CARD_CHANGE_BATCH,
  GATEWAY_RECEIPT_BATCH,
  GatewayPaymentService,
  gatewayCallbackUrl,
  gatewayReturnUrl,
} from './modules/commerce/payments/application/gateway-payment.service.js';
import {
  GATEWAY_PAYMENT_INTERVAL_MS,
  GatewayPaymentLoop,
} from './modules/commerce/payments/application/gateway-payment-loop.js';
import { OrderService } from './modules/commerce/orders/application/order.service.js';
import { CustomServiceAdminService } from './modules/commerce/custom-service/application/custom-service-admin.service.js';
import { CustomServiceFlowService } from './modules/commerce/custom-service/application/custom-service-flow.service.js';
import { CustomServicePricer } from './modules/commerce/custom-service/application/custom-service-pricer.js';
import {
  DrizzleCustomServiceLocationRepository,
  DrizzleCustomServiceRuleRepository,
  DrizzleOrderCustomServiceTermsRepository,
} from './modules/commerce/custom-service/infrastructure/drizzle-custom-service.repository.js';
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
import { ReportAccess } from './modules/commerce/reporting/application/report-access.js';
import { ReportingService } from './modules/commerce/reporting/application/reporting.service.js';
import { DrizzleReportingRepository } from './modules/commerce/reporting/infrastructure/drizzle-reporting.repository.js';
import { OperationsOverviewService } from './modules/commerce/reporting/application/operations-overview.service.js';
import { DrizzleOperationsOverviewRepository } from './modules/commerce/reporting/infrastructure/drizzle-operations-overview.repository.js';
import { DefaultReportExportWriter } from './infrastructure/export/report-export-writer.js';
import { DefaultAuditLogExportWriter } from './infrastructure/export/audit-log-export-writer.js';
import { DrizzleAuditLogReader } from './modules/platform/audit/infrastructure/drizzle-audit-log.reader.js';
import { AuditLogService } from './modules/platform/audit/application/audit-log.service.js';
import { IntlReportPeriodResolver } from './infrastructure/time/report-calendar.js';
import {
  PaymentOperationsService,
  type PaymentAttentionReader,
} from './modules/commerce/payments/application/payment-operations.service.js';
import { DrizzlePaymentAttentionReader } from './modules/commerce/payments/infrastructure/drizzle-payment-attention.reader.js';
import { GatewayHealthService } from './modules/commerce/payments/application/gateway-health.service.js';
import { DrizzleGatewayHealthReader } from './modules/commerce/payments/infrastructure/drizzle-gateway-health.reader.js';
import {
  DrizzleReferralCommissionRepository,
  DrizzleReferralRepository,
} from './modules/commerce/referrals/infrastructure/drizzle-referral.repository.js';
import { DrizzleResellerRepository } from './modules/commerce/resellers/infrastructure/drizzle-reseller.repository.js';
import { ResellerService } from './modules/commerce/resellers/application/reseller.service.js';
import { ResellerAdminService } from './modules/commerce/resellers/application/reseller-admin.service.js';
import { ResellerMinimumService } from './modules/commerce/resellers/application/reseller-minimum.service.js';
import { TenantMonthlyPeriods } from './infrastructure/time/monthly-period.js';
import { DrizzleAuditHistoryReader } from './modules/platform/audit/infrastructure/drizzle-audit-history.reader.js';
import { DrizzleDiscountRepository } from './modules/commerce/pricing/infrastructure/drizzle-discount.repository.js';
// Round N, C1: campaigns.
import { CampaignService } from './modules/commerce/campaigns/application/campaign.service.js';
import { CampaignScheduleLoop } from './modules/commerce/campaigns/application/campaign-schedule-loop.js';
import { DrizzleCampaignRepository } from './modules/commerce/campaigns/infrastructure/drizzle-campaign.repository.js';
import { IntlCampaignCalendar } from './modules/commerce/campaigns/infrastructure/intl-campaign-calendar.js';
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
import { PendingPaymentReminderService } from './modules/commerce/payments/application/pending-payment-reminder.service.js';
import { DrizzlePendingPaymentReminderRepository } from './modules/commerce/payments/infrastructure/drizzle-pending-payment-reminder.repository.js';
import { WalletLowBalanceService } from './modules/commerce/wallet/application/wallet-low-balance.service.js';
import { DrizzleWalletThresholdAlertRepository } from './modules/commerce/wallet/infrastructure/drizzle-wallet-threshold-alert.repository.js';
import {
  CUSTOMER_REMINDER_INTERVAL_MS,
  CustomerReminderLoop,
} from './modules/commerce/messaging/application/customer-reminder-loop.js';
import { DrizzleCustomerReminderFactsReader } from './modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader.js';
// R2: the Telegram messages edited in place, and the renewal result's facts.
import { TelegramMessageStateService } from './modules/commerce/messaging/application/telegram-message-state.js';
import { DrizzleTelegramMessageStateRepository } from './modules/commerce/messaging/infrastructure/drizzle-telegram-message-state.repository.js';
import {
  TelegramMessageRetentionLoop,
  TELEGRAM_MESSAGE_RETENTION_BATCH,
  TELEGRAM_MESSAGE_RETENTION_INITIAL_DELAY_MS,
  TELEGRAM_MESSAGE_RETENTION_INTERVAL_MS,
  TELEGRAM_MESSAGE_RETENTION_MAX_BATCHES,
} from './modules/commerce/messaging/application/telegram-message-retention-loop.js';
import { DrizzleRenewalFactsReader } from './modules/commerce/messaging/infrastructure/drizzle-renewal-facts.reader.js';
import { WizardInvoiceScreens } from './surfaces/telegram/wizard-invoice-screens.js';
import { SettingsQuietHoursReader } from './modules/commerce/messaging/infrastructure/settings-quiet-hours.reader.js';
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
import { SubscriptionFileService } from './modules/commerce/provisioning/application/subscription-file.service.js';
import { ServiceRefreshService } from './modules/commerce/provisioning/application/service-refresh.service.js';
import {
  OperationCardEditor,
  type ServiceCardRenderer,
} from './modules/commerce/provisioning/application/operation-card.js';
import { DrizzleOperationCardRepository } from './modules/commerce/provisioning/infrastructure/drizzle-operation-card.repository.js';
import { ServiceTransferService } from './modules/commerce/provisioning/application/service-transfer.service.js';
import { DrizzleServiceTransferRepository } from './modules/commerce/provisioning/infrastructure/drizzle-service-transfer.repository.js';
import { ServiceAdminService } from './modules/commerce/provisioning/application/service-admin.service.js';
import { ServiceGrantService } from './modules/commerce/provisioning/application/service-grant.service.js';
import { decideOperability } from './modules/commerce/provisioning/application/panel-operability.js';
import {
  PURCHASED_AS,
  ProvisionerService,
} from './modules/commerce/provisioning/application/provisioner.service.js';
import { ProvisionerLoop } from './modules/commerce/provisioning/application/provisioner-loop.js';
import { DeliveryService } from './modules/commerce/provisioning/application/delivery.service.js';
import { PngQrCodeEncoder } from './infrastructure/qr/qr-png.js';
import {
  PngDeliveryQrRenderer,
  QrBackgroundContentCheck,
  probeQrTemplate,
} from './infrastructure/qr/qr-template.js';
import { CustomerCaptureService } from './modules/commerce/customers/application/customer-capture.service.js';
import { DrizzleCustomerCaptureRepository } from './modules/commerce/customers/infrastructure/drizzle-customer-capture.repository.js';
import { DrizzleCustomerCountersReader } from './modules/commerce/customers/infrastructure/drizzle-customer-counters.reader.js';
import {
  CustomerScreenComposer,
  serviceStateLabelKey,
} from './modules/commerce/messaging/application/customer-screens.js';
import { TELEGRAM_MESSAGE_MAX } from './modules/commerce/messaging/application/message-split.js';
import { WalletTopupFlowService } from './modules/commerce/payments/application/wallet-topup-flow.service.js';
import { parseCustomerAmount } from './modules/commerce/payments/domain/customer-amount.js';
import { composeFaqScreen } from './modules/control/support/application/faq-screen.js';
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
import { CachedTenantPresentationReader } from './modules/control/templates/infrastructure/cached-tenant-presentation.reader.js';
import { TemplateManagementService } from './modules/control/templates/application/template-management.service.js';
import { DrizzleNotificationRepository } from './modules/control/notifications/infrastructure/drizzle-notification.repository.js';
import { NotificationService } from './modules/control/notifications/application/notification.service.js';
import { UndeliverableOrderRefunder } from './modules/commerce/orders/application/undeliverable-order-refunder.js';
import { NotificationDispatcher } from './modules/control/notifications/application/notification-dispatcher.js';
import { NotifyingOperationalEventRecorder } from './modules/control/notifications/application/operational-event-projector.js';
import { BusinessConnectionService } from './modules/commerce/business-chats/application/business-connection.service.js';
import { BusinessTransport } from './modules/commerce/business-chats/application/business-transport.js';
import { DrizzleBusinessConnectionRepository } from './modules/commerce/business-chats/infrastructure/drizzle-business-connection.repository.js';
import { TelegramBusinessGateway } from './modules/commerce/business-chats/infrastructure/telegram-business.gateway.js';
import type { SupportAiProvider } from '@nexa/contracts';
import { SupportAiChain } from './modules/control/support-ai/application/support-ai-chain.js';
import { SupportAssistService } from './modules/control/support-ai/application/support-assist.service.js';
import {
  SupportAutoEnqueuer,
  SupportAutoReplyService,
} from './modules/control/support-ai/application/support-auto-reply.service.js';
import { BusinessEscalationService } from './modules/commerce/business-chats/application/business-escalation.service.js';
import {
  AssistantLoop,
  ASSISTANT_INTERVAL_MS,
} from './modules/control/support-ai/application/assistant-loop.js';
import { DrizzleSupportAiJobRepository } from './modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.js';
import { TelegramSupportImageSource } from './modules/control/support-ai/infrastructure/telegram-support-image-source.js';
import { TbSupportContextSource } from './modules/control/support-ai/infrastructure/support-context-source.js';
import { SupportAnalyticsService } from './modules/control/support-ai/application/support-analytics.service.js';
import { DrizzleSupportAnalyticsReader } from './modules/control/support-ai/infrastructure/drizzle-support-analytics.reader.js';
import { SupportAiConfigService } from './modules/control/support-ai/application/support-ai-config.service.js';
import type { SupportAiAdapter } from './modules/control/support-ai/application/ports.js';
import {
  DrizzleSupportAiConfigRepository,
  DrizzleSupportAiCredentialStore,
  DrizzleSupportAiRunRecorder,
} from './modules/control/support-ai/infrastructure/drizzle-support-ai.repository.js';
import { OpenAiAdapter } from './infrastructure/ai/openai-adapter.js';
import { AnthropicAdapter } from './infrastructure/ai/anthropic-adapter.js';
import { ZaiAdapter } from './infrastructure/ai/zai-adapter.js';
import { BusinessConversationService } from './modules/commerce/business-chats/application/business-conversation.service.js';
import { BusinessOutboundService } from './modules/commerce/business-chats/application/business-outbound.service.js';
import {
  BUSINESS_OUTBOUND_INTERVAL_MS,
  BusinessOutboundLoop,
} from './modules/commerce/business-chats/application/business-outbound-loop.js';
import {
  DrizzleBusinessConversationRepository,
  DrizzleBusinessEscalationRepository,
  DrizzleBusinessCustomerLookup,
  DrizzleBusinessMessageRepository,
  DrizzleBusinessOutboundRepository,
} from './modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository.js';
// WP-A4: the Telegram operations log group.
import {
  OpsGroupRouter,
  OpsGroupService,
} from './modules/control/ops-group/application/ops-group.service.js';
import {
  OPS_GROUP_MAINTAIN_INTERVAL_MS,
  OpsGroupMaintainer,
} from './modules/control/ops-group/application/ops-group-maintainer.js';
import { OpsTopicProvisioner } from './modules/control/ops-group/application/topic-provisioner.js';
import { DrizzleOpsGroupRepository } from './modules/control/ops-group/infrastructure/drizzle-ops-group.repository.js';
// Premium UI: appearance slots, the messenger's decoration reader and the page's service.
import {
  CachedAppearanceReader,
  DrizzleAppearanceRepository,
} from './modules/control/appearance/infrastructure/drizzle-appearance.repository.js';
import { AppearanceService } from './modules/control/appearance/application/appearance.service.js';
import {
  OpsGroupBotSource,
  TelegramOpsGroup,
} from './modules/control/ops-group/infrastructure/telegram-ops-group.js';
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
export type ProcessRole = 'api' | 'worker' | 'monitor' | 'recovery' | 'provisioner' | 'assistant';

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
  /** HF-A7: clears support's reply files Telegram never took, after their retention. */
  readonly ticketReplyFileSweeper: RetentionSweeper;
  /** Phase A2: clears direct-message files Telegram never took, after their retention. */
  readonly directMessageFileSweeper: RetentionSweeper;
  /**
   * The lane that expires unpaid payments and the orders they were against.
   *
   * Started by the WORKER only. Nothing here dials anything, so it does not belong
   * beside the provisioner, whose whole reason for being a separate role is that a
   * wedged panel must not delay work that needs no panel.
   */
  readonly paymentExpiryLoop: PaymentExpiryLoop;
  /**
   * The external-gateway lane (WP11A): its reads and webhook hints serve the API and the
   * Telegram surface; its loop is started by the worker only.
   */
  readonly gatewayPayments: GatewayPaymentService;
  /** TonPays Telegram: the customer's card-change and receipt commands (database writes). */
  readonly gatewayReceiptCaptures: GatewayReceiptCaptureService;
  readonly gatewayPaymentLoop: GatewayPaymentLoop;
  /** Package FX: the central exchange rate, and the worker's lane that keeps it fresh. */
  readonly fx: FxService;
  readonly fxRefreshLoop: FxRefreshLoop;
  /**
   * Telegram Stars' two payment updates (Package A), answered by the webhook before the
   * customer turn: pre-checkout, and the recording and settling of `successful_payment`.
   */
  readonly starsPayments: StarsPaymentService;
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
   * WP-A9: the timer for the pending-payment and wallet low-balance reminders. Started by
   * the WORKER only, like the service reminder loop, and for the same reason.
   */
  readonly customerReminderLoop: CustomerReminderLoop;
  /** WP-A9: the two sweeps it drives, so a test runs one pass instead of a timer. */
  readonly pendingPaymentReminderSweep: PendingPaymentReminderService;
  readonly walletLowBalanceSweep: WalletLowBalanceService;
  /**
   * The customer notification lane's timer.
   *
   * In EVERY role's container and started only by `main.worker.ts`, for the reason the
   * comment above `paymentExpiryLoop` gives: a member that exists in one role's
   * container and not another's is a member whose absence is discovered at runtime.
   */
  readonly customerNotificationLoop: CustomerNotificationLoop;
  /**
   * R2 (items 3–5): the Telegram messages edited in place — the state, and the invoice screens
   * the gateway worker edits. Exposed so a test drives the SAME instances the roles use.
   */
  readonly telegramMessageState: TelegramMessageStateService;
  readonly wizardScreens: WizardInvoiceScreens;
  /** Retention for the two tables above (`docs/telegram-retention.md`); the worker starts it. */
  readonly telegramMessageRetentionLoop: TelegramMessageRetentionLoop;
  /** The lane's repository, shared so producers enqueue through the same object. */
  readonly customerNotifications: DrizzleCustomerNotificationRepository;
  /** HF-A9: the quiet window the lane defers reminders by — the instance it is given. */
  readonly reminderQuietHours: SettingsQuietHoursReader;
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
  /** Phase D2: an administrator's own second factor, sessions and history; owner recovery. */
  readonly accountSecurity: AccountSecurityService;
  readonly secondFactors: DrizzleSecondFactorRepository;
  readonly loginChallenges: DrizzleLoginChallengeRepository;
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
  /** Customer 360 (§11.4): the per-customer controls an operator sets. */
  readonly customerControls: CustomerControlService;
  /** Program §8: operator-only customer notes and tags. Never held by a customer surface. */
  readonly customerCrm: CustomerCrmService;
  /** Customer 360 (§11.7, §11.10): exact aggregates and the management timeline. */
  readonly customerInsights: CustomerInsightService;
  /** Customer 360 (§11.5): moving a customer's holdings to another Telegram identity. */
  readonly customerAccountTransfers: CustomerAccountTransferService;
  /** Phase A2: «ارسال پیام» — one operator-written message to one customer. */
  readonly customerDirectMessages: CustomerDirectMessageService;
  /** Customer 360 (§11.6): an operator's order for a customer, through the customer's path. */
  readonly manualOrders: ManualOrderService;
  /** Customer 360 (§11.4): suspend or resume all of one customer's configurations. */
  readonly customerServicesToggle: CustomerServicesToggleService;
  readonly products: ProductService;
  /**
   * Program Item 14: hidden legacy product shapes and their current tariff. Migration
   * prerequisites only — no surface calls it yet (P6/P7 are on hold).
   */
  readonly legacyProducts: LegacyProductService;
  readonly productCategories: ProductCategoryService;
  readonly serviceAddons: ServiceAddonService;
  /** Discount rules, as an operator manages them (WP8). */
  readonly discounts: DiscountAdminService;
  /** Cashback rules, as an operator manages them (WP8). */
  readonly cashbackRules: CashbackRuleAdminService;
  /** Round N, C1: campaigns composing the rules, the audience and the mass actions. */
  readonly campaigns: CampaignService;
  /** Round N, C1: the worker lane that starts and completes campaigns on their window. */
  readonly campaignScheduleLoop: CampaignScheduleLoop;
  /** Package D: the custom service's rules, locations and an order's frozen terms. */
  readonly customServiceAdmin: CustomServiceAdminService;
  /** Package D: the customer's flow — the locations, the typed volume and days, the draft. */
  readonly customServiceFlow: CustomServiceFlowService;
  /** The customer's generic text window (customer UX completion §N). */
  readonly customerCaptures: CustomerCaptureService;
  /** Package E: a panel's connection files, fetched and sent to their owner. */
  readonly subscriptionFiles: SubscriptionFileService;
  /** Package F: a customer hands one of their services to another customer. */
  readonly serviceTransfers: ServiceTransferService;
  /** WP-A7: support tickets, for the bot and the Web Admin alike. */
  readonly tickets: TicketService;
  /** WP-A7: the categories a customer files a ticket under. */
  readonly ticketCategories: TicketCategoryService;
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
  /** WP12's business reports, Super Admin only (`docs/wp12-business-analytics-audit.md`). */
  readonly reports: ReportingService;
  /** Round W: the dashboard's operational gauges and the sidebar counters, per permission. */
  readonly operationsOverview: OperationsOverviewService;
  readonly referralSignupGifts: ReferralSignupGiftService;
  readonly tenantMedia: TenantMediaService;
  /** Phase 2 item 4: the Web Admin's preview of the QR on the tenant's background. */
  readonly deliveryQrPreview: QrTemplatePreviewService;
  /** Phase 2 item 4: the one renderer every customer QR the delivery lane sends goes through. */
  readonly deliveryQr: DeliveryQrRenderer;
  /** WP9-B: a reseller's standing, entitlements, pricing layer, credit and purchase record. */
  readonly resellers: ResellerService;
  /** WP9-B: reseller tiers, grants and resellers, as an operator manages them. */
  readonly resellersAdmin: ResellerAdminService;
  /** Round N R2: the reseller monthly minimum — progress and the optional notices. */
  readonly resellerMinimums: ResellerMinimumService;
  readonly commercialActions: CommercialActionService;
  /** WP-A6: the operator's configured locations, and a customer's free location change. */
  readonly serviceLocations: ServiceLocationAdminService;
  readonly locationChanges: LocationChangeService;
  /** A customer's free trial (WP6-A): issued through the purchase path, costs nothing. */
  readonly trials: TrialService;
  /** The operator's trial overrides, global reset and view (WP6-B). */
  readonly trialAdmin: TrialAdminService;
  /**
   * Program Item 15: a migrated customer's legacy trial entitlement, preserved as an
   * ordinary override. Migration prerequisite only — no surface calls it yet (P7 is on hold).
   */
  readonly legacyTrials: LegacyTrialEligibilityService;
  /** R1: each panel's free trial, for an operator. */
  readonly panelTrials: PanelTrialService;
  /**
   * Round N: the SHARED audience — preview for an operator, evaluation for Broadcast, the
   * mass actions and Campaigns. One query implementation (`audience-sql.ts`).
   */
  readonly audience: AudienceService;
  /** Round N (B1): «ارسال همگانی» for an operator — compose, preview, test, launch, steer. */
  readonly broadcasts: BroadcastService;
  /** Round N (B1): the broadcast dispatcher's timer, run by the WORKER role. */
  readonly broadcastLoop: BroadcastLoop;
  /** Round N (B1): the dispatcher itself, exposed so a test drives the pass production runs. */
  readonly broadcastDispatcher: BroadcastDispatcher;
  /** Round N (B2): «عملیات گروهی» — mass wallet credit and mass traffic/time. */
  readonly bulkOperations: BulkOperationService;
  /** Round N (B2): the processor, exposed so a test drives the pass production runs. */
  readonly bulkOperationProcessor: BulkOperationProcessor;
  readonly bulkOperationLoop: BulkOperationLoop;
  readonly wallet: WalletService;
  /**
   * Migration P2: the legacy opening balance. Migration-only — no surface reaches it; the
   * importer (P7, HOLD) is its one intended caller (`docs/migration-opening-balance.md`).
   */
  readonly migrationOpeningBalance: MigrationOpeningBalanceService;
  /**
   * Program 4 Item 9: the legacy-import manual review queue. Migration-only — no surface
   * reaches it; the P7 CLI is its caller (`docs/legacy-import-metadata.md`).
   */
  readonly legacyReviewQueue: LegacyReviewQueueService;
  /**
   * Migration P6: legacy service adoption. Migration-only — no surface reaches it; the P7
   * importer is its one caller (`docs/migration-p6-service-adoption.md`). Holds no provider
   * client: adoption is not provisioning.
   */
  readonly legacyAdoption: LegacyAdoptionService;
  readonly payments: PaymentService;
  readonly paymentAccounts: PaymentAccountService;
  /** WP13 — the Web Admin's management of this tenant's Telegram bot instances. */
  readonly botManagement: BotManagementService;
  /** Round P — the bot's menu: items, desired commands, and every bot's sync state. */
  readonly botMenu: BotMenuService;
  /**
   * Round T: the button builder — the draft, the publish that rewrites `bot.main_menu` as
   * its compatibility projection, and the append-only revisions.
   */
  readonly botMenuBuilder: BotMenuBuilderService;
  /**
   * The customer main menu's ONE evaluator (R1), read by the messenger and the runtime:
   * `keyboardFor` (round T, structured buttons), `rowsFor`, `routesFor`, `describeFor`.
   */
  readonly mainMenu: MainMenuLayout;
  /** Round P — the command-sync lane, exposed so a test drives the pass the worker runs. */
  readonly botCommandSync: BotCommandSyncService;
  readonly botCommandSyncLoop: BotCommandSyncLoop;
  /** Round P — the one desired command menu, shared by the installer, the lane and the pages. */
  readonly commandMenu: CommandMenu;
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
   * WP19: customers' service refund requests — the Web Admin's list and its two decisions,
   * the provisioner tick's settlement, and the Telegram review card's values.
   */
  readonly serviceRefundRequests: ServiceRefundRequestService;
  /** WP19: the Telegram prompts behind a refund request's review card. */
  readonly serviceRefundDecisions: ServiceRefundDecisionService;
  /**
   * A card-to-card receipt's credit-to-wallet disposition (Payment File 02 §12, D2),
   * under `receipts.review` AND `users.wallet.credit`. Called by the Telegram review
   * surface; the Web Admin only READS what it recorded.
   */
  readonly receiptDispositions: ReceiptDispositionService;
  /**
   * One payment's history, assembled from facts other flows recorded (WP17). Read-only,
   * under `payments.view`, with receipts, refunds and wallet movements each behind the
   * permission that already guards them.
   */
  readonly paymentTimeline: PaymentTimelineService;
  /** The Payment Operations Center's queue list and attention counts (program §10). */
  readonly paymentOperations: PaymentOperationsService;
  /**
   * The shared "operational attention" read model (program §10–§12): per-gateway queue
   * counts over a window, with no permission of its own — Gateway Health and the
   * Notification Center read it under their own authority.
   */
  readonly paymentAttention: PaymentAttentionReader;
  /**
   * Gateway Health (program §11): every route's recorded health, and — through `signals` —
   * the typed gateway health signals the Notification Center consumes.
   */
  readonly gatewayHealth: GatewayHealthService;
  /** The Telegram half of the credit-to-wallet disposition: the reviewer's amount capture (D3). */
  readonly receiptCreditCaptures: ReceiptCreditCaptureService;
  /** Block User from the receipt message (WP10 follow-up §4): confirm, reason, block. */
  readonly receiptBlockCaptures: ReceiptBlockCaptureService;
  /** The rejection's mandatory reason (File 01 §7): reason, restated, reject. */
  readonly receiptRejectCaptures: ReceiptRejectCaptureService;
  /**
   * The administrators' receipt push (WP10 follow-up §3, ADR-0031): the lane's repository,
   * its dispatcher (one pass, for a test) and its timer, STARTED only by `main.worker.ts`.
   */
  readonly receiptReviewPushes: DrizzleReceiptReviewPushRepository;
  readonly receiptReviewPush: ReceiptReviewPushService;
  readonly receiptReviewPushLoop: ReceiptReviewPushLoop;
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
  /** WP20: counts every Telegram interaction, including the `/ping` the runtime never sees. */
  readonly antiSpam: Pick<AntiSpamService, 'observe'>;

  // Control plane — Phase 2
  readonly panels: PanelService;
  /** Phase C2: the live fleet's health, load and failures, read-only. */
  readonly panelHealth: PanelHealthDashboardService;
  /** WP-A8: a panel's capability registry, operator policy and diagnostics. */
  readonly panelAdvanced: PanelAdvancedService;
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
  /** Program §13: an operator's free traffic or time grant to one service. */
  readonly serviceGrants: ServiceGrantService;
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
  /** The tenant's FAQ as the operator maintains it (customer UX completion §J). */
  readonly supportFaqs: SupportFaqService;
  /** Program §6: the operator's terms and rules, and the customer's acceptance of them. */
  readonly terms: TermsService;
  readonly termsAcceptance: TermsAcceptanceService;
  /** The customer's support screen: active FAQ in order, and the first support account's URL. */
  readonly supportScreen: SupportScreenReader;
  /** WP-A10: the tenant's client apps as the operator maintains them. */
  readonly clientApps: ClientAppService;
  /** Spec §7: the tutorial videos set from Telegram. */
  readonly clientAppVideos: ClientAppVideoService;
  /** UX Batch 01 item 6: the Web Admin's «افزودن ویدیو از تلگرام» over the same prompt. */
  readonly clientAppVideoWeb: ClientAppVideoWebService;
  /** Phase 2 item 5: one panel's post-delivery tutorial, as the operator maintains it. */
  readonly deliveryTutorials: DeliveryTutorialService;
  /** WP-A10: the customer's read of them, filtered by what their services are. */
  readonly clientAppCatalog: ClientAppCatalog;
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
  /** Premium UI: «ظاهر ربات» — appearance slots and the per-bot custom emoji test. */
  readonly appearance: AppearanceService;
  /** WP-A4: the Nexa-managed operations log group, and the worker pass that keeps it. */
  readonly opsGroups: OpsGroupService;
  /** TB1: Telegram Business connections (ADR-0033). */
  readonly businessConnections: BusinessConnectionService;
  readonly businessTransport: BusinessTransport;
  readonly businessConversations: BusinessConversationService;
  readonly businessOutboundLoop: BusinessOutboundLoop;
  /** TB3: the support agent's read-only, allowlisted context for one conversation. */
  readonly supportContext: SupportContextBuilder;
  /** TB4: the support AI's configuration, keys and provider chain (ADR-0034). */
  readonly supportAiConfig: SupportAiConfigService;
  readonly supportAiChain: SupportAiChain;
  /** TB10: read-only support analytics over a half-open report window. */
  readonly supportAnalytics: SupportAnalyticsService;
  /** TB5: Assist Mode — drafts an operator may edit and send (ADR-0034 §7). */
  readonly supportAssist: SupportAssistService;
  /** TB5: produces drafts. Built in every role, STARTED only by the `assistant` role. */
  readonly assistantLoop: AssistantLoop;
  /** TB7: AUTO_REPLY_SAFE's producer (the `assistant` role runs it through the loop). */
  readonly supportAutoReply: SupportAutoReplyService;
  /** TB8: support knowledge and its review, and controlled learning (ADR-0035). */
  readonly supportKnowledge: SupportKnowledgeService;
  readonly supportLearning: SupportLearningService;
  /** TB9: the one-click knowledge build from NEXA (ADR-0035 §5). */
  readonly supportKnowledgeBuild: SupportKnowledgeBuildService;
  readonly opsGroupMaintainer: OpsGroupMaintainer;
  readonly opsLogService: OpsLogService;
  /** Phase B3: the administrator's notification inbox, a projection of the operations log. */
  readonly notificationCenter: NotificationCenterService;
  /** Phase D1: the audit log browser and its export (`docs/audit-log.md`). */
  readonly auditLog: AuditLogService;
  /** Phase E3: incidents and maintenance windows. */
  readonly incidents: IncidentService;
  /** Phase E3: starts scheduled maintenance windows. Started by the WORKER only. */
  readonly incidentSchedulerLoop: IncidentSchedulerLoop;
  /**
   * What the background monitor is configured to do, and what that
   * configuration can carry. A read of installation configuration plus two
   * pure capacity functions; it touches no repository and not the monitor.
   */
  readonly monitorProfileService: MonitorProfileService;

  /** WP16: outbox backlog and stuck provisioning operations, read-only (`opslog.view`). */
  readonly diagnostics: DiagnosticsService;

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
  /**
   * The Recovery Kit (ADR-0032): the keyring every cipher in this process reads
   * — configured keys plus imported decrypt-only ones — its loader, and the
   * lifecycle service the Web Admin calls.
   */
  readonly keyring: InstallationKeyring;
  readonly installationKeyLoader: InstallationKeyLoader;
  readonly installationKeyRepository: DrizzleInstallationKeyRepository;
  readonly installationKeys: InstallationKeyService;
  /**
   * Migration P7: the legacy importer (`docs/legacy-migration/importer.md`). A factory,
   * because two of its inputs are the CLI's: the P6 adoption port (null until agent
   * ADOPT's service is wired) and the inventory page size. Its provider surface is the
   * read-only RickPanel inventory and nothing else; no surface reaches it.
   */
  readonly legacyImporter: (options?: {
    readonly adoption?: LegacyAdoptionPort | null;
    readonly inventoryPageSize?: number;
  }) => LegacyImporterService;

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

/**
 * Migration P1 (H5): the share of a tenant's probe bucket the SCHEDULED usage sweep must
 * leave behind, as a percentage. Half.
 *
 * A legacy migration brings a fleet (~27k services) whose figures are all stale at once,
 * and the sweep's reads come out of the same bucket a paid create spends from. Without a
 * floor that backlog drains the bucket to zero on every refill, and the customer who has
 * just paid meets `BUDGET_EXHAUSTED`. With a floor of half, the sweep still gets every
 * token above it — its throughput is whatever the refill leaves — and a paid create, a
 * customer's own tap or an operator's "Test connection" always finds the other half.
 *
 * A constant rather than a new environment variable: the knob an operator already has is
 * `PANEL_PROBE_TENANT_LIMIT`/`_WINDOW_MS`, which raises the sweep's throughput and the
 * headroom together. `docs/migration-p1-usage-sync.md` has the arithmetic.
 */
export const USAGE_SYNC_BUDGET_RESERVE_PERCENT = 50;

/**
 * The scheduled sweep's floor in TOKENS: half the capacity, rounded up, and never below
 * the monitor's own floor.
 *
 * The second clause is the ordering: paid and interactive work (floor 0) outrank the
 * monitor (its floor), which outranks the sweep (this). A sweep allowed to dig below the
 * monitor's floor would starve the health checks that decide whether a panel may be
 * sold onto, which is a worse failure than a usage figure that is an hour old.
 *
 * At a capacity of 1 the floor is the whole bucket and the sweep never runs. That is the
 * same direction the monitor's floor takes, for the same reason: housekeeping may lag;
 * a customer who paid must not wait behind it.
 *
 * EXPORTED so the rule has a test (`tests/unit/usage-sync-budget.test.ts`).
 */
export function usageSyncBudgetReserveFor(capacity: number, monitorReserve: number): number {
  const half = Math.max(1, Math.ceil((capacity * USAGE_SYNC_BUDGET_RESERVE_PERCENT) / 100));
  return Math.max(monitorReserve, half);
}

export function createContainer(config: AppConfig, role: ProcessRole): Container {
  const logger = createLogger(config.LOG_LEVEL, role);
  const clock = new SystemClock();
  const ids = new Uuidv7IdGenerator();
  // One resolution of the keyring, used for both the cipher's keys and the
  // v1-acceptance default that depends on which spelling configured them.
  // Resolving it twice would let the two answers come from different parses.
  //
  // Wrapped in the INSTALLATION keyring (ADR-0032), which adds the decrypt-only
  // keys imported from Recovery Kits and changes nothing about which key
  // encrypts: `activeKeyId` is the configured one, read-only. The cipher and the
  // archive read `keys` at the moment of use, so a kit imported later is usable
  // by both without either knowing kits exist.
  const configuredKeyring = resolveKeyring(config);
  const keyring = new InstallationKeyring(configuredKeyring);
  const cipher = new AesGcmSecretCipher(keyring, acceptsV1(config, configuredKeyring));
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
   * Anti-spam's counter (WP20), on its own connection: the shared client waits for ever on
   * a dead Redis, and a webhook turn must never wait on a counter. This one fails fast, and
   * anti-spam fails open.
   */
  const interactionCounter = new RedisInteractionCounter(config.REDIS_URL);

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
  /*
   * WP20: the one anti-spam counter. Shared by the bot runtime and by the webhook's
   * `/ping` branch, which answers before the runtime runs: an interaction the runtime
   * never sees is still an interaction.
   */
  const antiSpam = new AntiSpamService({
    counter: interactionCounter,
    opsEvents: opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    clock,
    logger,
  });

  const hasher = new ScryptPasswordHasher(scryptParamsFor(config.PASSWORD_HASH_PROFILE));
  const admins = new DrizzleAdminRepository(database.db);
  const roles = new DrizzleRoleRepository(database.db, ids);
  const sessions = new DrizzleSessionRepository(database.db);
  const loginThrottle = new DrizzleLoginThrottleRepository(database.db);
  const secondFactors = new DrizzleSecondFactorRepository(database.db);
  const loginChallenges = new DrizzleLoginChallengeRepository(database.db);

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
    { factors: secondFactors, challenges: loginChallenges, cipher },
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
    secondFactors,
    cipher,
  );

  const accountSecurity = new AccountSecurityService({
    uow,
    admins,
    sessions,
    factors: secondFactors,
    events: new DrizzleSecurityEventReader(database.db),
    cipher,
    // The same dependency-free encoder the subscription QR uses; no second QR path.
    qr: new PngQrCodeEncoder(),
    audit,
    opsLog,
    clock,
    ids,
    throttle: credentialThrottle,
    verifyOwnPassword: (scope, actor, password, context, action) =>
      adminManagement.verifyOwnPassword(scope, actor, password, context, action),
  });

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

  /** The administrators' receipt push lane, shared by its consumer and its dispatcher. */
  const receiptReviewPushRepository = new DrizzleReceiptReviewPushRepository(database.db);
  const serviceRefundPushRepository = new DrizzleServiceRefundPushRepository(database.db);

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

  const telegramBotGateway = new TelegramBotBootstrapGateway(
    config.TELEGRAM_API_BASE_URL,
    config.NOTIFICATION_SEND_TIMEOUT_MS,
  );
  /*
   * Round P (COMMAND-MENU) — the ONE answer to "what slash-command menu does this tenant
   * want": `BOT_COMMANDS` rendered through the tenant's own texts, and its digest. The
   * installer's reconcile (below), the Web Admin's bot view, the sync lane and the menu
   * page all read it, so "current" means one thing everywhere.
   *
   * The template resolver is built much later in this function (it needs the feature
   * resolver and the presentation reader), so the menu reaches it through a reference
   * filled in there — the shape `opsLogRef` already uses. Nothing calls the menu before
   * the container is complete.
   */
  const templateResolverRef: { current: TemplateResolver | null } = { current: null };
  const commandMenu = new CommandMenu({
    templates: {
      render: (scope, key, values, tx) => {
        if (templateResolverRef.current === null) {
          throw new Error('CommandMenu was read before the container finished composing.');
        }
        return templateResolverRef.current.render(scope, key, values, DEFAULT_TEMPLATE_LOCALE, tx);
      },
    },
  });
  /*
   * The command-sync lane: per bot, idempotent by digest, retried with back-off, and a
   * WARN in the operations log after repeated failure — through the façade, so it is
   * announced. The SAME gateway as the installer and bot management: one `setMyCommands`.
   */
  const botCommandSync = new BotCommandSyncService({
    repository: new DrizzleBotCommandSyncRepository(database.db),
    bots: botInstances,
    telegram: telegramBotGateway,
    menu: commandMenu,
    uow,
    scopeActivity: tenants,
    audit,
    opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    clock,
    ids,
    telegramCallTimeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
    logger,
  });
  const bootstrapBot = new BotBootstrapService({
    uow,
    bots: botInstances,
    scopeActivity: tenants,
    audit,
    clock,
    ids,
    telegram: telegramBotGateway,
    commandMenu,
    webhookSecret: () => config.TELEGRAM_WEBHOOK_SECRET,
    webhookEnabled: () => config.TELEGRAM_WEBHOOK_ENABLED,
    telegramCallTimeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
  });

  /*
   * WP13 — the Web Admin's management of the same bots. The SAME gateway instance, so a
   * token is judged by one `identify` for both the installer and the Web Admin, and the
   * same `CommandMenu`, so the menu state on the bots page is the lane's answer.
   */
  const botManagement = new BotManagementService({
    repository: new DrizzleBotManagementRepository(database.db, cipher, botInstances),
    telegram: telegramBotGateway,
    commandMenu,
    commandSync: botCommandSync,
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    clock,
    ids,
    webhookSecret: () => config.TELEGRAM_WEBHOOK_SECRET,
    webhookEnabled: () => config.TELEGRAM_WEBHOOK_ENABLED,
    telegramCallTimeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
  });

  let installationTenantId: TenantId | null = null;

  const relay = new OutboxRelay(
    database.db,
    [
      new PingLogConsumer(opsLog),
      // Round P: a changed `bot.command.*` text, a menu setting, a flag, or a bot that
      // became ACTIVE queues a command-menu sync. A DB write with the relay's claim; the
      // Telegram call is the lane's, on its own tick.
      new BotCommandSyncConsumer(botCommandSync),
      /*
       * WHO is pushed a new receipt (WP10 follow-up §3, ADR-0031). A consumer, so the fan-out
       * commits with the relay's claim and never inside the transaction that filed the
       * receipt. Its repositories are built here for the relay alone: stateless, over the
       * same pool.
       */
      new ReceiptReviewPushConsumer({
        pushes: receiptReviewPushRepository,
        payments: new DrizzlePaymentRepository(database.db),
        receipts: new DrizzlePaymentReceiptRepository(database.db),
        reviewers: telegramAdmins,
        clock,
        ids,
      }),
      /*
       * The refund-request review cards (WP19): the receipt push's consumer for a
       * different subject — enqueue one row per administrator holding both decision keys.
       */
      new ServiceRefundPushConsumer({
        pushes: serviceRefundPushRepository,
        requests: new DrizzleServiceRefundRequestRepository(database.db),
        reviewers: telegramAdmins,
        clock,
        ids,
      }),
      /*
       * The financial log (WP18): a committed payment or refund fact, into the operator
       * notification lane's payments topic. A consumer, so no log can reach the money's
       * transaction. The lane is resolved lazily — it is built further down, and this
       * closure is called only once the relay runs.
       */
      new FinancialLogConsumer({
        lane: {
          financialDestination: (scope, tx) => notifications.financialDestination(scope, tx),
          queue: (scope, input, tx) => notifications.queue(scope, input, tx),
        },
        payments: new DrizzlePaymentRepository(database.db),
        customers: new DrizzleCustomerRepository(database.db),
        invoices: new DrizzleGatewayInvoiceRepository(database.db),
        wallet: new DrizzleWalletRepository(database.db),
        refundRequests: new DrizzleServiceRefundRequestRepository(database.db),
      }),
      /*
       * WP-A7: a new ticket or a customer's reply → a support notification in the operator
       * notification lane: the operations destination, and each Telegram-bound administrator
       * who may reply. A consumer, so nothing about it can reach the customer's message. The
       * lane is resolved lazily, as the financial log's is.
       */
      new TicketSupportNotifyConsumer({
        lane: { queue: (scope, input, tx) => notifications.queue(scope, input, tx) },
        tickets: new DrizzleTicketRepository(database.db),
        customers: new DrizzleCustomerRepository(database.db),
        reviewers: telegramAdmins,
      }),
    ],
    clock,
    logger,
    {
      batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
      pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
      maxLagMs: config.OUTBOX_RELAY_MAX_LAG_MS,
    },
    database,
    writeGate,
    // WP20: an exhausted message is announced once in the operations log.
    opsLog,
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
      // Phase D2: the pending sign-ins share this sweep and this cutoff. Sessions first;
      // challenges take whatever is left of the batch, so the sum never exceeds `limit`
      // and the sweeper's "a full batch means keep going" rule still holds.
      purge: async (now, limit) => {
        const cutoff = new Date(now.getTime() - config.SESSION_RETENTION_SECONDS * 1000);
        const ended = await sessions.purgeExpiredBefore(cutoff, limit);
        if (ended >= limit) return ended;
        return ended + (await loginChallenges.purgeExpiredBefore(cutoff, limit - ended));
      },
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
  // R1: the per-panel trial configuration a trial is issued from.
  const panelTrialConfigRepository = new DrizzlePanelTrialConfigRepository(database.db);
  const trialOverrideRepository = new DrizzleTrialOverrideRepository(database.db);
  const trialResetRepository = new DrizzleTrialResetRepository(database.db);

  const settingRepository = new DrizzleSettingRepository(database.db);
  const settingsResolver = new SettingsResolver(settingRepository, opsLog);
  /*
   * Round T: the button builder's rows. Built here, beside the settings it projects into,
   * because three things read it — the `bot.main_menu` change guard, the keyboard's source
   * and the builder service.
   */
  const mainMenuBuilderRepository = new DrizzleMainMenuBuilderRepository(database.db);
  /*
   * Package B — mandatory channel membership. `getChatMember` through the receiving bot's
   * own token, bounded well under the send timeout because a customer's turn waits on it,
   * failing OPEN into an operations condition when Telegram cannot say.
   */
  const channelMembership = new ChannelMembershipService({
    reader: new TelegramChatMemberReader({
      bots: botInstances,
      apiBaseUrl: config.TELEGRAM_API_BASE_URL,
      timeoutMs: Math.min(CHANNEL_MEMBERSHIP_TIMEOUT_MS, config.NOTIFICATION_SEND_TIMEOUT_MS),
    }),
    channels: (scope) => settingsResolver.valueOf<TelegramChannel[]>(scope, 'telegram.channels'),
    opsEvents: opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    clock,
    logger,
  });
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
    // Spec §9: whether a customer may stop promotional messages at all.
    features: featureFlagResolver,
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
  /*
   * WP-A8: a panel's operator policy. ONE reader, handed to every customer-action
   * decision — commercial actions, customer operations, subscription files, delivery —
   * so the question "may a customer do this on this panel" has one answer.
   */
  const panelPolicyRepository = new DrizzlePanelPolicyRepository(database.db);
  const panelPolicyReader = new PanelPolicyReader(panelPolicyRepository);
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
   * Phase C3: automatic balancing over the SAME sales gate — its verdicts are the only
   * "may place here" — read by the draft (where an account goes) and by the catalogue
   * (what may be offered). The flag and the strategy are read in the caller's transaction.
   */
  const panelPlacement = new PanelPlacementService({
    panels: panelRepository,
    sales: panelSalesGate,
    enabled: (scope, tx) => featureFlagResolver.isEnabled(scope, 'panel_auto_balancing', tx),
    strategy: async (scope, tx) =>
      (await settingsResolver.resolve(scope, 'panels.balancing.strategy', tx))
        .value as PanelBalancingStrategy,
    clock,
  });
  const orderPlacementRepository = new DrizzleOrderPlacementRepository(database.db);

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
    placement: panelPlacement,
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
   * Program Item 14 (`docs/legacy-migration/hidden-legacy-products.md`): one hidden product
   * per legacy tariff shape, on the same product repository, so a migrated service renews
   * through the ordinary renewal path and the one pricing boundary.
   */
  const legacyProductService = new LegacyProductService({
    shapes: new DrizzleLegacyProductShapeRepository(database.db),
    products: productRepository,
    settings: settingsResolver,
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
    // WP-A5: an extra-users rate's panel / product scope, checked against THIS tenant.
    scopeTargets: {
      panelExists: async (scope, panelId, tx) =>
        (await panelRepository.find(scope, panelId, tx)) !== null,
      productExists: async (scope, productId, tx) =>
        (await productRepository.findById(scope, productId as ProductId, tx)) !== null,
    },
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
   * WP-A6: the operator's configured locations and the customers' frozen change requests,
   * and the ONE evaluator of what a service may be moved to. One instance of each, shared
   * by the admin surface, the quote, the confirmation, the free request, settlement and
   * the provisioner, so none of them can read a different answer.
   */
  const serviceLocationRepository = new DrizzleServiceLocationRepository(database.db);
  /**
   * Pre-support A6: the operator's label for the initial location of the panel a service
   * is on NOW — what the card and the delivery card say a never-moved service is in.
   */
  const panelInitialLocationLabel = async (
    scope: TenantContext,
    panelId: string,
  ): Promise<string | null> =>
    initialLocationOf(await serviceLocationRepository.forPanel(scope, panelId))?.label ?? null;
  const locationChangeRepository = new DrizzleLocationChangeRepository(database.db);
  const customerLocationOverrides = new DrizzleCustomerLocationOverrideRepository(database.db);
  const locationChangePolicy = new LocationChangePolicy({
    locations: serviceLocationRepository,
    changes: locationChangeRepository,
    overrides: customerLocationOverrides,
    settings: settingsResolver,
    clock,
  });
  const serviceLocationAdminService = new ServiceLocationAdminService({
    repository: serviceLocationRepository,
    targets: {
      panelExists: async (scope, panelId, tx) =>
        (await panelRepository.find(scope, panelId, tx)) !== null,
      productPanel: async (scope, productId, tx) => {
        const product = await productRepository.findById(scope, productId as ProductId, tx);
        return product === null ? undefined : product.panelId;
      },
    },
    /*
     * Where a panel's never-moved services are frozen before its initial location changes.
     * A closure, because the service repository is built further down: it is read when a
     * write runs, never at construction.
     */
    services: {
      recordLocationForUnmoved: (scope, panelId, location, legalFrom, now, tx) =>
        serviceRepository.recordLocationForUnmoved(scope, panelId, location, legalFrom, now, tx),
    },
    settings: settingsResolver,
    guard,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    uow,
    clock,
    ids,
  });

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
  const migrationOpeningBalance = new MigrationOpeningBalanceService({
    repository: walletRepository,
    customers: customerRepository,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    settings: settingsResolver,
    uow,
    outbox,
    clock,
    ids,
  });
  const legacyReviewQueue = new LegacyReviewQueueService({
    repository: new DrizzleLegacyImportRepository(database.db),
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    outbox,
    idempotency,
    clock,
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
    wallet: walletRepository,
    settings: settingsResolver,
    auditHistory: new DrizzleAuditHistoryReader(database.db),
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
  const discountCodeCaptureRepository = new DrizzleDiscountCodeCaptureRepository(database.db);
  const customerCaptureRepository = new DrizzleCustomerCaptureRepository(database.db);
  /*
   * Package D — the custom service. One pricer, asked by the location list, the typed
   * volume, the draft and the confirmation alike, so none of them can price differently.
   */
  const customServiceRuleRepository = new DrizzleCustomServiceRuleRepository(database.db);
  const customServiceLocationRepository = new DrizzleCustomServiceLocationRepository(database.db);
  const orderCustomServiceTermsRepository = new DrizzleOrderCustomServiceTermsRepository(
    database.db,
  );
  const customServicePricer = new CustomServicePricer({
    rules: customServiceRuleRepository,
    locations: customServiceLocationRepository,
    panelSales: panelSalesGate,
    resellers: resellerService,
    features: featureFlagResolver,
    settings: settingsResolver,
  });
  const customServiceAdminService = new CustomServiceAdminService({
    rules: customServiceRuleRepository,
    locations: customServiceLocationRepository,
    terms: orderCustomServiceTermsRepository,
    panels: panelRepository,
    customers: customerRepository,
    tiers: resellerRepository,
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
  const orderService = new OrderService({
    customService: { pricer: customServicePricer, terms: orderCustomServiceTermsRepository },
    placement: panelPlacement,
    placements: orderPlacementRepository,
    pricing: pricingService,
    resellers: resellerService,
    discountCodes: discountCodeCaptureRepository,
    captures: customerCaptureRepository,
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
      checkoutHeldFor: (scope, orderId, now, tx) =>
        paymentRepository.hasCheckoutHeldPendingForOrder(scope, orderId, now, tx),
      providerReviewFor: (scope, orderId, tx) =>
        paymentRepository.hasProviderReviewOrUnknownForOrder(scope, orderId, tx),
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
  // R3 item 10: the service card a customer's disable or enable was asked from.
  const operationCardRepository = new DrizzleOperationCardRepository(database.db);
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
      const decided = decideOperability({
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
      /*
       * WP-A5: extra users are offered, drafted, confirmed and settled only where the
       * adapter has BOTH device-limit methods as well as the declaration the descriptor
       * check above just read — the same three-question guard the executor applies — so a
       * declaration that outran its methods can never draw a button or take money.
       */
      if (
        decided.ok &&
        type === 'ADD_DEVICES' &&
        !canAdjustDeviceLimit(providerServiceAdapter(decided.providerType))
      ) {
        return { ok: false as const, reason: 'CAPABILITY_UNSUPPORTED' as const };
      }
      /*
       * WP-A6: the same three-question guard for a move — the read, the write and the
       * declaration — so a declaration that outran its methods can never draw «🌍 تغییر
       * لوکیشن», quote a price or plan an operation.
       */
      if (
        decided.ok &&
        type === 'CHANGE_LOCATION' &&
        !canChangeLocation(providerServiceAdapter(decided.providerType))
      ) {
        return { ok: false as const, reason: 'CAPABILITY_UNSUPPORTED' as const };
      }
      return decided;
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
    panelPolicy: panelPolicyReader,
    cards: operationCardRepository,
    // WP-A6: a paid move's frozen target, read at settlement by its order.
    locationChanges: locationChangeRepository,
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
    panelPolicy: panelPolicyReader,
    settings: settingsResolver,
    // WP-A6: the paid location change's evaluator and its frozen change request.
    locations: locationChangePolicy,
    locationChanges: locationChangeRepository,
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

  /** WP-A6: a customer's FREE location change — asked for, not bought. */
  const locationChangeService = new LocationChangeService({
    services: serviceRepository,
    policy: locationChangePolicy,
    changes: locationChangeRepository,
    provisioning: provisioningService,
    resellers: resellerService,
    panels: panelOperability,
    panelPolicy: panelPolicyReader,
    guard,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    uow,
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

  /*
   * WP11A — the external gateway. ONE adapter per provider, and TonPays is the only one:
   * the only code that speaks its HTTP. Everything else asks through the provider-neutral
   * port. The callback URL is generated from the tenant's registered public origin.
   */
  const tonpaysAdapter = new TonPaysAdapter();
  /*
   * TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md`): a SEPARATE adapter for the
   * custom API — its own paths, its own key, a payee card instead of a link, a card change
   * and a receipt upload. It shares the website adapter's request and classifier, never a
   * key. Not accepted against the real provider yet (`OQ-WP10-01`).
   */
  const tonpaysTelegramAdapter = new TonPaysTelegramAdapter();
  /*
   * NOWPayments (`docs/nowpayments-gateway-audit.md`): the hosted crypto invoice. Its own
   * adapter, the only code that speaks its HTTP; priced from the central USDT quote; its IPN
   * verified against the tenant's stored secret and still only a hint. Not accepted against
   * the real provider yet (`OQ-NP-01`).
   */
  const nowpaymentsAdapter = new NowPaymentsAdapter();
  /*
   * CentralPay (`docs/centralpay-gateway-audit.md`): redirect + verify. Its own adapter, the
   * only code that speaks its HTTP; `getLink` with the API key, `verify` with the SEPARATE
   * verify key; no webhook. Not accepted against the real provider yet (`OQ-CP-01`).
   */
  const centralpayAdapter = new CentralPayAdapter();
  /*
   * Package A — Telegram Stars. The invoice is sent with the ATTEMPT's bot token through
   * the one Telegram call module, bounded by the same send timeout every customer message
   * uses.
   */
  const starsAdapter = new TelegramStarsAdapter({
    apiBaseUrl: config.TELEGRAM_API_BASE_URL,
    timeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
  });
  const gatewayAdapters = (provider: PaymentGatewayProvider): ExternalGatewayAdapter | null => {
    switch (provider) {
      case 'TONPAYS':
        return tonpaysAdapter;
      case 'TELEGRAM_STARS':
        return starsAdapter;
      case 'TONPAYS_TELEGRAM':
        return tonpaysTelegramAdapter;
      case 'NOWPAYMENTS':
        return nowpaymentsAdapter;
      case 'CENTRALPAY':
        return centralpayAdapter;
      case 'MANUAL_TRANSFER':
        return null;
      default:
        // A provider a LATER release added (seen after a rollback): no adapter, never undefined.
        return null;
    }
  };
  /**
   * The card-transfer capability (audit §5.2), resolved by DESCRIPTOR, never by `instanceof`:
   * only a route whose `invoiceForm` is `CARD_TRANSFER` has one.
   */
  const cardTransferAdapters = (
    provider: PaymentGatewayProvider,
  ): CardTransferGatewayAdapter | null =>
    PAYMENT_GATEWAY_DESCRIPTORS[provider].invoiceForm === 'CARD_TRANSFER' &&
    provider === 'TONPAYS_TELEGRAM'
      ? tonpaysTelegramAdapter
      : null;
  const gatewayCardTransferRepository = new DrizzleGatewayCardTransferRepository(database.db);
  const gatewayInvoiceRepository = new DrizzleGatewayInvoiceRepository(database.db);
  const gatewayCredentialStore = new DrizzleGatewayCredentialStore(database.db, cipher, () =>
    ids.uuid(),
  );
  const publicOrigins = new DrizzlePublicOriginReader(database.db);
  const gatewayCallbackUrlFor = async (
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ): Promise<string | null> => {
    if (gatewayAdapters(provider) === null || scope.tenantId === null) return null;
    const origin = await publicOrigins.originFor(scope);
    // A browser-return route (CentralPay) is sent its RETURN URL base; it takes no webhook.
    return PAYMENT_GATEWAY_DESCRIPTORS[provider].browserReturn
      ? gatewayReturnUrl(origin, provider, scope.tenantId)
      : gatewayCallbackUrl(origin, provider, scope.tenantId);
  };

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
    accounts: paymentAccountRepository,
    credentials: gatewayCredentialStore,
    adapters: gatewayAdapters,
    callbackUrlFor: gatewayCallbackUrlFor,
    // Spec §8: a route priced only by the central rate cannot be enabled while it is off.
    features: featureFlagResolver,
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
  /*
   * The signup gift (customer UX §I): one credit per side of a referral, from the terms
   * in settings, independent of the commission lane above.
   */
  const referralSignupGiftService = new ReferralSignupGiftService({
    gifts: new DrizzleReferralSignupGiftRepository(database.db),
    referrals: referralRepository,
    customers: customerRepository,
    wallet: walletRepository,
    settings: settingsResolver,
    features: featureFlagResolver,
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

  /* The tenant's media slots (customer UX §I): the referral banner, bytes in the database. */
  const tenantMediaRepository = new DrizzleTenantMediaRepository(database.db);
  const tenantMediaService = new TenantMediaService({
    repository: tenantMediaRepository,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    clock,
    // Phase 2 item 4: a QR background must decode, within its bounds, before it is stored.
    contentCheck: new QrBackgroundContentCheck(),
  });

  /*
   * Phase 2 item 4: every customer QR NEXA delivers, drawn on the tenant's QR background when
   * `delivery.qr_template` places it — else exactly the plain QR. A template that cannot be
   * used is logged and the plain QR is sent; a delivery never fails on decoration.
   */
  const deliveryQrRenderer = new PngDeliveryQrRenderer(
    {
      template: (scope) =>
        settingsResolver.valueOf<QrTemplate | null>(scope, 'delivery.qr_template'),
      backgroundDigest: async (scope) =>
        (await tenantMediaRepository.find(scope, 'QR_BACKGROUND'))?.sha256 ?? null,
      background: (scope) => tenantMediaRepository.content(scope, 'QR_BACKGROUND'),
    },
    (scope, reason, error) =>
      logger.warn(
        { tenantId: scope.tenantId, reason, err: error },
        'The QR template was not used; the plain QR was sent.',
      ),
  );
  const deliveryQrPreview = new QrTemplatePreviewService(guard, deliveryQrRenderer);

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
     * The ledger, `append`, `lockCustomer` and `findByReference` only. No balance read: a
     * customer who has already spent a refunded payment is still owed the refund, so
     * nothing here may consult what the wallet currently holds. `findByReference` asks
     * whether one refund's own credit exists, never how much the wallet holds.
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
   * A customer's request to cancel a service for money back (WP19). An administrator
   * approves an amount; the approval reserves it against the source payment and plans the
   * deletion in one transaction, and the provisioner's tick credits the wallet only once the
   * provider account is gone (`settleDue`).
   */
  const serviceRefundRequests = new ServiceRefundRequestService({
    repository: new DrizzleServiceRefundRequestRepository(database.db),
    services: serviceRepository,
    orders: orderRepository,
    payments: paymentRepository,
    refundLedger: refundRepository,
    refunds: refundService,
    termination: provisioningService,
    panels: panelOperability,
    features: featureFlagResolver,
    customers: customerRepository,
    notifier: customerNotifier,
    outbox,
    audit,
    opsLog,
    guard,
    sessions,
    uow,
    scopeActivity: tenants,
    clock,
    ids,
    systemActor: () => systemJobActor('service-refunds', newCorrelationId(ids.uuid())),
    logger,
    idempotency,
  });
  /** The Telegram prompts behind a refund request's review card (WP19). */
  const serviceRefundDecisions = new ServiceRefundDecisionService({
    captures: new DrizzleAdminAmountCaptureRepository(database.db),
    requests: serviceRefundRequests,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    clock,
    ids,
    idempotency,
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

  const paymentTimelineService = new PaymentTimelineService({
    guard,
    reader: new DrizzlePaymentTimelineReader(database.db),
  });

  /** The append-only record of a receipt's credit-to-wallet disposition (D2). */
  const receiptCreditRepository = new DrizzleReceiptCreditRepository(database.db);

  /** Filled once the FX service exists (package FX); see the `fx` dependency below. */
  const fxRef: { current: FxService } = { current: null as unknown as FxService };

  const paymentService = new PaymentService({
    resellers: resellerService,
    undeliverable: undeliverableOrders,
    // The one credit path, for a reconciliation whose order another payment settled.
    refunds: refundService,
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
    // WP11A: the gateway invoice's FIRST state, the adapter's pre-call facts, and
    // whether a key is stored — never the key.
    gatewayInvoices: gatewayInvoiceRepository,
    gatewayAdapters,
    gatewayCredentials: gatewayCredentialStore,
    // TonPays Telegram (§9.6.3 c): what the acknowledgement's own transaction also writes.
    cardTransfer: gatewayCardTransferRepository,
    /*
     * Package FX: the central rate, LATE-BOUND. The FX service is built further down,
     * beside the HTTP client its sources dial through; nothing calls these before the
     * container has finished, and the attempt that does reads a stored quote only.
     */
    fx: {
      quoteFor: (scope, baseAsset, now, tx) => fxRef.current.quoteFor(scope, baseAsset, now, tx),
      recordStaleUse: (scope, quote, tx) => fxRef.current.recordStaleUse(scope, quote, tx),
    },
  });

  /*
   * The external-gateway lane (WP11A): creates invoices, asks the provider what happened,
   * and hands an APPROVED inquiry to `PaymentService.confirmGatewayPayment`. Built in
   * every role — the API's webhook and the Telegram surface use its reads and hints — and
   * its loop STARTED only by the worker, the one role that dials the provider.
   */
  /*
   * R2 (v0.3.5 real-test items 3–5): which Telegram message shows a customer's wizard or an
   * administrator's receipt review. One writer for the turn and the gateway worker alike.
   */
  const telegramMessageState = new TelegramMessageStateService({
    repository: new DrizzleTelegramMessageStateRepository(database.db),
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    scopeActivity: tenants,
    clock,
    ids,
  });
  /*
   * Retention for those two tables (docs/telegram-retention.md). Every rule that makes a
   * deletion safe is in the repository's query and the gates' purge horizon; the loop only
   * paces it — hourly, bounded batches, one condition for a failure streak.
   */
  const telegramMessageRetentionLoop = new TelegramMessageRetentionLoop(telegramMessageState, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: TELEGRAM_MESSAGE_RETENTION_INTERVAL_MS,
    initialDelayMs: TELEGRAM_MESSAGE_RETENTION_INITIAL_DELAY_MS,
    batchSize: TELEGRAM_MESSAGE_RETENTION_BATCH,
    maxBatchesPerTick: TELEGRAM_MESSAGE_RETENTION_MAX_BATCHES,
    now: () => clock.now().getTime(),
    ids,
    // The façade, never the bare writer: only it is wrapped by the notifying recorder, so a
    // failure streak and its recovery reach the operations log group, not just the table.
    opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    logger,
  });
  const gatewayPayments = new GatewayPaymentService({
    invoices: gatewayInvoiceRepository,
    payments: paymentService,
    paymentRecords: paymentRepository,
    adapters: gatewayAdapters,
    credentials: gatewayCredentialStore,
    // TonPays Telegram: the card-change and receipt lanes, and the window sweep.
    cardTransfer: gatewayCardTransferRepository,
    cardAdapters: cardTransferAdapters,
    /*
     * A receipt's bytes, with the token of the bot the photo was sent to, bounded at the
     * provider's 5 MB while streaming. Late-bound: `receiptFiles` is built further down;
     * only the worker's pass calls this, after the container has finished.
     */
    receiptFiles: {
      download: (scope, binding, options) =>
        receiptFiles.download(
          scope,
          { botInstanceId: binding.botInstanceId as BotInstanceId, fileId: binding.fileId },
          options,
        ),
    },
    // The bot the customer is talking to sends a Stars invoice (`BOT_TOKEN` routes).
    botTokens: {
      tokenForBotInstance: (scope, botInstanceId) =>
        botInstances.tokenForBotInstance(scope, botInstanceId as BotInstanceId),
    },
    // The Stars invoice's own text, from the tenant's templates — never a literal.
    presentation: async (scope) => ({
      title: await templateResolver.render(scope, 'bot.payment.stars_invoice_title', {}),
      description: await templateResolver.render(
        scope,
        'bot.payment.stars_invoice_description',
        {},
      ),
      priceLabel: await templateResolver.render(scope, 'bot.payment.stars_price_label', {}),
    }),
    budget: new DrizzleGatewayCallBudget(database.db),
    callbackUrlFor: gatewayCallbackUrlFor,
    customers: customerRepository,
    conditions: new DrizzleOperationalConditionReader(database.db),
    scopeActivity: tenants,
    uow,
    audit,
    opsLog,
    outbox,
    clock,
    ids,
    logger,
    /*
     * R2 (item 4): the worker edits the customer's invoice message the moment the invoice is
     * ready (or refused, or settled). Late-bound: the screens share `customerMessenger`,
     * built further down; nothing calls this before the container has finished.
     */
    invoiceScreens: {
      refresh: (scope, paymentId): Promise<void> => wizardScreens.refresh(scope, paymentId),
    },
    // CentralPay's browser return goes back to the tenant's bot (stored username, no call).
    botLinkFor: (scope) => publicOrigins.botLinkFor(scope),
  });
  /*
   * TonPays Telegram (§8.2, §8.3): the customer's three commands — another card, the receipt
   * window, a photo for it. Database writes under the guard; the worker makes every call.
   */
  const gatewayReceiptCaptures = new GatewayReceiptCaptureService({
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    clock,
    ids,
    payments: paymentRepository,
    invoices: gatewayInvoiceRepository,
    cardTransfer: gatewayCardTransferRepository,
  });
  const starsPayments = new StarsPaymentService({
    invoices: gatewayInvoiceRepository,
    payments: paymentRepository,
    customers: customerRepository,
    orders: orderRepository,
    settlement: gatewayPayments,
    answerer: new TelegramStarsCheckoutAnswerer(
      { render: (scope, key, values) => templateResolver.render(scope, key, values) },
      {
        tokenForBotInstance: (scope, botInstanceId) =>
          botInstances.tokenForBotInstance(scope, botInstanceId as BotInstanceId),
      },
      config.TELEGRAM_API_BASE_URL,
      config.NOTIFICATION_SEND_TIMEOUT_MS,
    ),
    scopeActivity: tenants,
    uow,
    audit,
    opsLog,
    clock,
    ids,
    logger,
  });
  const gatewayPaymentLoop = new GatewayPaymentLoop(gatewayPayments, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: GATEWAY_PAYMENT_INTERVAL_MS,
    // Every call a pass may make, one after another, each allowed its whole timeout — and,
    // since R2, the Telegram edit of the invoice message each of them may be followed by.
    passBoundMs:
      (GATEWAY_CREATE_BATCH +
        GATEWAY_INQUIRY_BATCH +
        GATEWAY_CARD_CHANGE_BATCH +
        GATEWAY_RECEIPT_BATCH) *
        (TONPAYS_TIMEOUT_MS + config.NOTIFICATION_SEND_TIMEOUT_MS) +
      // TonPays Telegram: each receipt is first fetched from Telegram (getFile, then the file).
      GATEWAY_RECEIPT_BATCH * 2 * config.NOTIFICATION_SEND_TIMEOUT_MS,
    now: () => clock.now().getTime(),
    logger,
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

  /*
   * Package FX: the central exchange rate. Its two sources dial through the SAME client
   * class and URL policy as every provider call, with their own tighter bounds; the
   * base URLs are configuration only so the integration suite can stub them. The
   * service is what the payment core was handed above through `fxRef`.
   */
  const fxHttp = new SafeHttpClient({
    ...urlPolicy,
    totalTimeoutMs: FX_SOURCE_TIMEOUT_MS,
    maxResponseBytes: FX_SOURCE_MAX_RESPONSE_BYTES,
    maxRetries: 0,
  });
  const fxService = new FxService({
    repository: new DrizzleFxQuoteRepository(database.db),
    sources: new Map<FxSource, FxSourceAdapter>([
      ['NOBITEX', new NobitexFxSource(fxHttp.forBase(config.FX_NOBITEX_BASE_URL))],
      ['WALLEX', new WallexFxSource(fxHttp.forBase(config.FX_WALLEX_BASE_URL))],
    ]),
    settings: settingsResolver,
    features: featureFlagResolver,
    gateways: paymentGatewayRepository,
    conditions: new DrizzleOperationalConditionReader(database.db),
    guard,
    audit,
    opsLog,
    scopeActivity: tenants,
    uow,
    clock,
    ids,
    logger,
  });
  fxRef.current = fxService;
  const fxRefreshLoop = new FxRefreshLoop(fxService, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    baseAsset: 'USDT',
    intervalMs: FX_REFRESH_INTERVAL_MS,
    // Both sources, each allowed its whole timeout, back to back.
    passBoundMs: 2 * FX_SOURCE_TIMEOUT_MS,
    now: () => clock.now().getTime(),
    logger,
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

  /*
   * WP-A8: the registry, the policy write and the diagnostics over the panel service
   * above — its read, so the diagnostics and the sellability card cannot disagree.
   */
  const panelAdvanced = new PanelAdvancedService({
    panels: panelService,
    repository: panelRepository,
    policies: panelPolicyRepository,
    adapters: (providerType) =>
      IMPLEMENTED_PROVIDER_TYPES.includes(
        providerType as (typeof IMPLEMENTED_PROVIDER_TYPES)[number],
      )
        ? providerAdapter(providerType)
        : null,
    providerRules: (providerType) => PROVIDER_RULES[providerType],
    features: featureFlagResolver,
    guard,
    audit,
    opsLog,
    sessions,
    uow,
    idempotency,
    scopeActivity: tenants,
    clock,
  });

  const monitorBudgetReserve = monitorBudgetReserveFor(
    config.PANEL_PROBE_TENANT_LIMIT,
    config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT,
  );
  /**
   * The background floor: the scheduled usage sweep's, and (pre-support A2) a card's
   * opportunistic read on open. One number on the one bucket, never a second budget.
   */
  const usageSyncBackgroundReserve = usageSyncBudgetReserveFor(
    config.PANEL_PROBE_TENANT_LIMIT,
    monitorBudgetReserve,
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
      // Spec §8: the Stars pricing mode is retired (every change refused), and the ratio
      // cannot be cleared while the Stars route is switched on.
      new StarsPricingModeGuard(),
      new StarsPerUsdtGuard(paymentGatewayRepository),
      // Phase 2 item 4: a QR template needs a background its region lies inside.
      new QrTemplateGuard(tenantMediaRepository, probeQrTemplate),
      // The trial product must be a product of this tenant (WP6-A).
      new TrialProductGuard(productRepository),
      // One per reminder threshold. The five have to agree with one another, and no
      // per-key schema can say so — see `ReminderThresholdsGuard`.
      // WP-A9: plus the week-out slot's own guard, asked only when that key is written.
      ...ReminderThresholdsGuard.withEarly(settingsResolver),
      // HF-A9: the quiet window's start and end may not be equal.
      ...QuietHoursGuard.all(settingsResolver, new DrizzleQuietHoursLock()),
      // The signup gift's three terms have to make a whole while the gift is on.
      ...SignupGiftTermsGuard.all(settingsResolver, featureFlagResolver),
      // Round T: once a layout is published, `bot.main_menu` is the builder's projection and
      // the publish is its one writer.
      new MainMenuSettingGuard(mainMenuBuilderRepository),
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
    configs: panelTrialConfigRepository,
    panels: panelRepository,
    customers: customerRepository,
    wallet: walletRepository,
    usernames: usernameLane,
    panelSales: panelSalesGate,
    provisioning: provisioningService,
    settings: settingsResolver,
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
    configs: panelTrialConfigRepository,
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
  /**
   * Program Item 15 (`docs/legacy-migration/trial-eligibility.md`): the same override
   * repository and the same customer lock as `trialAdminService`, so a migrated customer's
   * claim is decided by the one allowance evaluator like anyone's.
   */
  const legacyTrialEligibilityService = new LegacyTrialEligibilityService({
    records: new DrizzleLegacyTrialEligibilityRepository(database.db),
    overrides: trialOverrideRepository,
    wallet: walletRepository,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
  });
  /**
   * R1: each panel's trial, for an operator — and the overview that asks the SAME offer
   * evaluator the bot does (`trialPanelVerdicts`), read-only.
   */
  const panelTrials = new PanelTrialService({
    configs: panelTrialConfigRepository,
    panels: panelRepository,
    panelSales: panelSalesGate,
    usernames: usernameLane,
    guard,
    audit,
    opsLog,
    sessions,
    uow,
    idempotency,
    scopeActivity: tenants,
    clock,
  });
  /** Round N: the shared audience (`docs/round-n-broadcast-audit.md` §3). */
  const audienceService = new AudienceService({
    reader: new DrizzleAudienceReader(database.db),
    // Round N close (§A): the durable member sets a campaign's confirmation freezes.
    frozen: new DrizzleFrozenAudienceRepository(database.db),
    guard,
    clock,
    sellingCurrency: (scope) =>
      settingsResolver.valueOf<SalesCurrencyCode>(scope, 'sales.currency'),
    ids,
  });
  /*
   * Round N (B2): safe mass actions over the shared audience. The processor writes ledger
   * entries through the wallet repository and PLANS free ADD_TRAFFIC / ADD_TIME operations
   * through `ProvisioningService.planGrant`, which the provisioner executes as it executes a
   * purchased add-on — no new provider write path.
   */
  const bulkOperationRepository = new DrizzleBulkOperationRepository(database.db);
  const bulkSellingCurrency = (scope: TenantContext, tx?: unknown) =>
    settingsResolver.valueOf<SalesCurrencyCode>(scope, 'sales.currency', tx as never);
  const bulkOperationService = new BulkOperationService({
    repository: bulkOperationRepository,
    audience: audienceService,
    panels: panelOperability,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    sellingCurrency: bulkSellingCurrency,
    clock,
    ids,
  });
  const bulkOperationProcessor = new BulkOperationProcessor({
    repository: bulkOperationRepository,
    wallet: walletRepository,
    grants: provisioningService,
    notifier: customerNotifier,
    outbox,
    uow,
    scopeActivity: tenants,
    sellingCurrency: bulkSellingCurrency,
    clock,
    ids,
    logger,
  });
  const bulkOperationLoop = new BulkOperationLoop(bulkOperationProcessor, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: BULK_OPERATION_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
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
    // The vetoes over a flag turning on: the signup gift needs coherent terms first.
    [new SignupGiftActivationGuard(settingsResolver)],
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
  /*
   * Migration P6. After the reminder sweep, whose burst seed it runs inside its own
   * transaction. Deliberately handed NO provider client, adapter or transport.
   */
  const legacyAdoption = new LegacyAdoptionService({
    store: new DrizzleLegacyAdoptionStore(database.db),
    map: new DrizzleLegacyImportRepository(database.db),
    products: productRepository,
    shapes: new DrizzleLegacyProductShapeRepository(database.db),
    capacity: panelCapacity,
    reminders: serviceReminderSweep,
    settings: settingsResolver,
    secrets: serviceSecrets,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    outbox,
    idempotency,
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

  /*
   * WP-A9: the two reminders that are not about a service. Readers, not services, for the
   * settings and flags — the reason `serviceReminderSweep` gives above.
   */
  const pendingPaymentReminderSweep = new PendingPaymentReminderService({
    reminders: new DrizzlePendingPaymentReminderRepository(database.db),
    settings: settingsResolver,
    features: featureFlagResolver,
    notifier: customerNotifier,
    scopeActivity: tenants,
    uow,
    clock,
  });
  const walletLowBalanceSweep = new WalletLowBalanceService({
    alerts: new DrizzleWalletThresholdAlertRepository(database.db),
    settings: settingsResolver,
    features: featureFlagResolver,
    notifier: customerNotifier,
    scopeActivity: tenants,
    uow,
    clock,
    ids,
  });
  /*
   * Round N R2: the reseller monthly minimum. Readers, not services, for the settings and
   * flags — the reason `serviceReminderSweep` gives above. Its sales figure is the reports'
   * own statement (`resellerSalesStatement`) and its months the reports' own resolver.
   */
  const resellerMinimumService = new ResellerMinimumService({
    resellers: resellerRepository,
    sales: new DrizzleReportingRepository(database.db),
    periods: new TenantMonthlyPeriods(),
    presentation: new CachedTenantPresentationReader(tenants, clock),
    settings: settingsResolver,
    features: featureFlagResolver,
    notifier: customerNotifier,
    guard,
    scopeActivity: tenants,
    uow,
    clock,
    ids,
  });
  const customerReminderLoop = new CustomerReminderLoop(
    [
      {
        name: 'pending-payments',
        everyMs: 0,
        runOnce: async (scope) => {
          const report = await pendingPaymentReminderSweep.runOnce(scope);
          return report.payments + report.orders;
        },
      },
      {
        name: 'wallet-low-balance',
        // The service reminder cadence: a fall below a threshold is not a deadline.
        everyMs: SERVICE_REMINDER_INTERVAL_MS,
        runOnce: async (scope) => (await walletLowBalanceSweep.runOnce(scope)).alerts,
      },
      {
        // Round N R2: a month-end reminder is not a deadline to the minute either.
        name: 'reseller-monthly-minimum',
        everyMs: SERVICE_REMINDER_INTERVAL_MS,
        runOnce: async (scope) => resellerMinimumService.runOnce(scope),
      },
    ],
    {
      scope: () =>
        installationTenantId === null
          ? null
          : { tenantId: installationTenantId, botInstanceId: null },
      intervalMs: CUSTOMER_REMINDER_INTERVAL_MS,
      now: () => clock.now().getTime(),
      logger,
    },
  );

  const templateRepository = new DrizzleTemplateRepository(database.db);
  const templateCatalogue = new I18nTemplateCatalogue();
  // One reader for the resolver and the preview, so both show a tenant's dates the
  // same way and share one cache.
  const templatePresentation = new CachedTenantPresentationReader(tenants, clock);

  // The Payment Operations Center (program §10): the reports' own range resolver, in the
  // tenant's timezone and calendar, so a queue's date filter means what a report's does.
  const paymentOpsPeriods = new IntlReportPeriodResolver();
  const paymentAttentionReader = new DrizzlePaymentAttentionReader(database.db);
  const paymentOperationsService = new PaymentOperationsService({
    guard,
    attention: paymentAttentionReader,
    payments: paymentService,
    windows: {
      resolve: async (scope, input) => {
        const resolved = paymentOpsPeriods.resolve(
          input,
          clock.now(),
          await templatePresentation.presentationFor(scope),
        );
        return { start: resolved.current.start, end: resolved.current.end };
      },
    },
  });

  // Gateway Health (program §11): read-only, over the route service's own readiness reads,
  // the recorded facts, and the Payment Operations Center's queues and window.
  const gatewayHealthService = new GatewayHealthService({
    guard,
    routes: {
      routes: (scope) => paymentGatewayRepository.list(scope),
      readinessFacts: (scope, gateway) => paymentGatewayService.readinessFacts(scope, gateway),
      checkSupported: (provider) => paymentGatewayService.checkSupported(provider),
      lastCheck: (scope, provider) => gatewayCredentialStore.lastCheck(scope, provider),
    },
    reader: new DrizzleGatewayHealthReader(database.db),
    attention: paymentAttentionReader,
    operations: paymentOperationsService,
    clock,
  });

  const reportingService = new ReportingService({
    access: new ReportAccess(guard, admins, opsLog),
    repository: new DrizzleReportingRepository(database.db),
    periods: new IntlReportPeriodResolver(),
    presentation: templatePresentation,
    salesCurrency: {
      salesCurrency: (scope) => settingsResolver.valueOf<CurrencyCode>(scope, 'sales.currency'),
    },
    writer: new DefaultReportExportWriter(),
    clock,
  });
  const operationsOverview = new OperationsOverviewService({
    permissions: guard,
    repository: new DrizzleOperationsOverviewRepository(database.db),
    clock,
    counterCap: COUNTER_CAP,
  });
  const templateResolver = new TemplateResolver(
    templateRepository,
    featureFlagResolver,
    templateCatalogue,
    templatePresentation,
  );
  // Round P: the command menu renders through the tenant's resolver from here on.
  templateResolverRef.current = templateResolver;
  /*
   * Composes the destination block behind the application layer.
   *
   * Built after the resolver because it renders through it — four frozen keys, each a
   * tenant override away from being the tenant's own wording. `bot-runtime.ts` is handed
   * this rather than the resolver, so the surface can compose a destination and nothing
   * else.
   */
  const paymentDestinationRenderer = new PaymentDestinationRenderer(templateResolver);

  /*
   * The support FAQ (customer UX completion §J). Built after the template resolver
   * because the seeder renders the nine defaults through it — a tenant override of
   * `bot.faq.default_<n>_*` is the tenant's default. Two objects over one repository:
   * the operator's service, and the customer's reader that charges no permission.
   */
  const supportFaqRepository = new DrizzleSupportFaqRepository(database.db);
  const supportFaqSeeder = new SupportFaqSeeder({
    repository: supportFaqRepository,
    uow,
    templates: templateResolver,
    scopeActivity: tenants,
    ids,
    clock,
  });
  const supportFaqService = new SupportFaqService({
    repository: supportFaqRepository,
    seeder: supportFaqSeeder,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    ids,
    clock,
  });
  const supportScreenReader = new SupportScreenReader({
    repository: supportFaqRepository,
    seeder: supportFaqSeeder,
    settings: settingsResolver,
  });

  /*
   * The customer UX completion's application services (docs/customer-ux-completion-
   * audit.md). The capture service closes the ORDER windows when it opens, through the
   * two lanes that own them; `OrderService` closes captures when it opens its own. One
   * open prompt per customer, across three tables.
   */
  const customerCaptureService = new CustomerCaptureService({
    captures: customerCaptureRepository,
    windows: {
      closeOpenFor: async (scope, botInstanceId, customerId, at, tx) => {
        // The lane types its transaction; the capture port carries it opaquely, as
        // every other repository port does.
        const scoped = tx as TransactionScope;
        const usernameWindow = await usernameLane.openWindowFor(
          scope,
          botInstanceId,
          customerId,
          scoped,
        );
        if (usernameWindow !== null) {
          await usernameLane.closeWindow(scope, usernameWindow.id, 'SUPERSEDED', at, scoped);
        }
        const discountWindow = await discountCodeCaptureRepository.findOpen(
          scope,
          botInstanceId,
          customerId,
          tx,
        );
        if (discountWindow !== null) {
          await discountCodeCaptureRepository.close(scope, discountWindow.id, 'SUPERSEDED', at, tx);
        }
      },
    },
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
  const customServiceFlowService = new CustomServiceFlowService({
    pricer: customServicePricer,
    captures: customerCaptureService,
    orders: orderService,
    terms: orderCustomServiceTermsRepository,
    guard,
  });
  const customerScreens = new CustomerScreenComposer(templateResolver);
  /**
   * Package F — a customer hands one of their services to another customer of the tenant.
   * Only ownership moves: no provider is called, and the order, payment and ledger are left
   * as written. The recipient is told through the notification lane, in the transaction
   * that commits the transfer.
   */
  const serviceTransferService = new ServiceTransferService({
    repository: new DrizzleServiceTransferRepository(database.db),
    services: serviceRepository,
    orders: orderRepository,
    customers: customerRepository,
    captures: customerCaptureService,
    screens: customerScreens,
    /*
     * The location the service card shows, and for a custom service (Package D) the label
     * its order's frozen terms recorded — the one location that order was sold for.
     */
    locationOf: async (scope, service) => {
      // WP-A6: a service that has moved is where it moved to, whatever its product says.
      if (service.locationLabel !== null) return service.locationLabel;
      if (service.productId === null) {
        const terms = await orderCustomServiceTermsRepository.findByOrder(scope, service.orderId);
        return terms?.locationLabel ?? null;
      }
      const product = await productRepository.findById(scope, service.productId);
      return product?.display.serviceLocationLabel ?? null;
    },
    notifier: customerNotifier,
    outbox,
    audit,
    opsLog,
    guard,
    sessions,
    uow,
    scopeActivity: tenants,
    clock,
    ids,
  });
  /*
   * Customer 360 (spec §11, `docs/customer-account-transfer-audit.md`). Each is a thin
   * composition of the services above: the controls write the customer row and the
   * location override, the transfer reuses Package F's ownership rows and evaluator and the
   * wallet ledger, the manual order runs the customer's own four commands under the
   * operator's authority, and the toggle plans each service through the operator's
   * per-service request.
   */
  /*
   * Program §6 — the terms and rules. Two services over one repository: the operator's
   * (versions, publication, statistics) and the customer's (the gate's one question, the
   * accept button, and the standing Customer 360 shows).
   */
  const termsRepository = new DrizzleTermsRepository(database.db);
  const termsService = new TermsService({
    repository: termsRepository,
    flags: featureFlagResolver,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    ids,
    clock,
  });
  const termsAcceptanceService = new TermsAcceptanceService({
    repository: termsRepository,
    flags: featureFlagResolver,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    ids,
    clock,
  });
  const customerControlService = new CustomerControlService({
    customers: customerRepository,
    locationOverrides: customerLocationOverrides,
    guard,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    uow,
    idempotency,
    outbox,
    clock,
    terms: termsAcceptanceService,
  });
  const customerCrmService = new CustomerCrmService({
    crm: new DrizzleCustomerCrmRepository(database.db),
    customers: customerRepository,
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
  const customerInsightService = new CustomerInsightService({
    reader: new DrizzleCustomerInsightReader(database.db),
    customers: customerRepository,
    auditHistory: new DrizzleAuditHistoryReader(database.db),
    guard,
  });
  const customerAccountTransferService = new CustomerAccountTransferService({
    repository: new DrizzleCustomerAccountTransferRepository(database.db),
    customers: customerRepository,
    services: serviceRepository,
    serviceTransfers: new DrizzleServiceTransferRepository(database.db),
    transferability: serviceTransferService,
    wallet: walletRepository,
    sellingCurrency: (scope, tx) =>
      settingsResolver.valueOf<CurrencyCode>(scope, 'sales.currency', tx),
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
  const manualOrderService = new ManualOrderService({
    orders: orderService,
    payments: paymentService,
    guard,
    audit,
    opsLog,
  });
  const customerServicesToggleService = new CustomerServicesToggleService({
    services: serviceRepository,
    provisioning: provisioningService,
    guard,
    audit,
    uow,
    idempotency,
  });
  /*
   * WP-A7 — support tickets. ONE service for the bot and the Web Admin. An administrator's
   * reply enqueues `TICKET_REPLY` on the customer lane in the transaction that writes it,
   * through the same notifier every other producer uses.
   */
  const ticketRepository = new DrizzleTicketRepository(database.db);
  const ticketCategoryRepository = new DrizzleTicketCategoryRepository(database.db);
  const ticketCategoryService = new TicketCategoryService({
    categories: ticketCategoryRepository,
    templates: templateResolver,
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
  // TB7: the business-chat handoffs a ticket carries (written by business-chats below).
  const businessEscalationRepository = new DrizzleBusinessEscalationRepository(database.db);
  const ticketService = new TicketService({
    tickets: ticketRepository,
    categories: ticketCategoryRepository,
    escalations: businessEscalationRepository,
    categorySeeder: ticketCategoryService,
    customers: customerRepository,
    context: new DrizzleTicketContextReader(database.db),
    admins,
    permissions: permissionResolver,
    notifier: customerNotifier,
    outbox,
    audit,
    opsLog,
    guard,
    sessions,
    uow,
    scopeActivity: tenants,
    clock,
    ids,
  });
  const ticketScreens = new TicketScreenComposer(templateResolver);
  /**
   * Phase A2 (`docs/direct-message-audit.md`): a direct message from Customer 360. Its own
   * row and permission; delivered by the customer notification lane below, as
   * `DIRECT_MESSAGE` / `DIRECT_MESSAGE_MEDIA` — no second transport.
   */
  const directMessageRepository = new DrizzleDirectMessageRepository(database.db);
  const customerDirectMessageService = new CustomerDirectMessageService({
    repository: directMessageRepository,
    notifier: customerNotifier,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    outbox,
    clock,
    ids,
  });
  /** Phase A2: the direct-message files Telegram never took, cleared after retention. */
  const directMessageFileSweeper = new RetentionSweeper(
    {
      name: 'direct-message-files',
      purge: (now, limit) =>
        directMessageRepository.purgeFileContentBefore(
          new Date(now.getTime() - DIRECT_MESSAGE_FILE_RETENTION_DAYS * 24 * 3_600_000),
          now,
          limit,
        ),
    },
    clock,
    logger,
    { intervalMs: 3_600_000, initialDelayMs: 95_000, batchSize: 50, maxBatchesPerTick: 100 },
  );
  /**
   * HF-A7: retention for support's staged reply files. A delivered file's bytes are cleared
   * by the delivery itself; this clears what Telegram never took — a customer who blocked
   * the bot, an unconfirmed upload — once it is `TICKET_REPLY_FILE_RETENTION_DAYS` old. The
   * row, and the message it belongs to, stay. Hourly: a held file counts against the
   * tenant's staging bound until it is cleared.
   */
  const ticketReplyFileSweeper = new RetentionSweeper(
    {
      name: 'ticket-reply-files',
      purge: (now, limit) =>
        ticketRepository.purgeReplyFileContentBefore(
          new Date(now.getTime() - TICKET_REPLY_FILE_RETENTION_DAYS * 24 * 3_600_000),
          now,
          limit,
        ),
    },
    clock,
    logger,
    {
      intervalMs: 3_600_000,
      initialDelayMs: 90_000,
      // Small batches: each row cleared can release up to ten megabytes of bytea.
      batchSize: 50,
      maxBatchesPerTick: 100,
    },
  );
  const customerCounters = new DrizzleCustomerCountersReader(database.db);
  /**
   * The FAQ screen, rendered into message parts HERE — application code holds the
   * resolver, the surface does not — and split at item boundaries by `composeFaqScreen`.
   */
  const supportScreenParts = async (
    scope: TenantContext,
  ): Promise<{ readonly parts: readonly string[]; readonly supportUrl: string | null }> => {
    const screen = await supportScreenReader.screenFor(scope);
    if (screen.faqs.length === 0) return { parts: [], supportUrl: screen.supportUrl };
    const heading = await templateResolver.render(scope, 'bot.faq.heading', {});
    const footer = await templateResolver.render(scope, 'bot.faq.footer', {});
    const items = new Map<string, string>();
    for (const [index, faq] of screen.faqs.entries()) {
      const number = faqNumberMarker(index + 1);
      items.set(
        number,
        await templateResolver.render(scope, 'bot.faq.item', {
          number,
          question: faq.question,
          answer: faq.answer,
        }),
      );
    }
    const parts = composeFaqScreen(
      screen.faqs,
      { heading, footer, item: (number) => items.get(number) ?? '' },
      TELEGRAM_MESSAGE_MAX,
    );
    return { parts, supportUrl: screen.supportUrl };
  };

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
  /*
   * The reviewer's caption (File 01 §4): ONE builder, shared by the pull item and the push.
   * The balance through the ledger's own SUM, gated by the guard's one resolution rule; the
   * labels through the tenant's own template overrides.
   */
  const receiptReviewFacts = new DrizzleReceiptReviewFactsReader(database.db);
  const receiptReviewCaption = new ReceiptReviewCaption({
    facts: receiptReviewFacts,
    balances: walletRepository,
    guard,
    labels: templateResolver,
    // F1 (round N): the payment's own wallet movement, for the review message's final record.
    movements: receiptReviewFacts,
  });

  const receiptService = new ReceiptService({
    captures: receiptCaptureRepository,
    receipts: paymentReceiptRepository,
    payments: paymentRepository,
    credits: receiptCreditRepository,
    outbox,
    caption: receiptReviewCaption,
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
    templatePresentation,
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
  /**
   * R1: the customer main menu as each tenant has it — «دکمه‌های ربات». ONE object read by
   * the messenger (the keyboard it draws) and the runtime (the labels a tap is matched
   * against), so the two cannot disagree about a renamed or hidden button.
   */
  /*
   * Round T: the PUBLISHED layout while its projection is current, else the legacy path
   * over `bot.main_menu` — never the draft. One statement per decision; the builder's read
   * shares it (`fromState`).
   */
  const mainMenuSource = new PublishedMainMenuSource(
    mainMenuBuilderRepository,
    settingsResolver,
    opsLog,
  );
  const mainMenuLayout = new MainMenuLayout({
    source: mainMenuSource,
    settings: settingsResolver,
    features: featureFlagResolver,
    templates: templateResolver,
    /*
     * F5: the trial button is drawn while `trialOffersFor` — the evaluator the claim and
     * the operator's overview use — names at least one panel. The keyboard is a tenant's,
     * so this is the tenant-wide answer; the claim decides the customer's own allowance.
     */
    trials: {
      // A system scope draws no customer's keyboard, so it offers no trial.
      anyOffered: async (scope) =>
        !isSystemContext(scope) &&
        (
          await trialOffersFor(
            {
              configs: panelTrialConfigRepository,
              panelSales: panelSalesGate,
              panels: panelRepository,
              usernames: usernameLane,
            },
            scope,
          )
        ).length > 0,
    },
  });
  /*
   * Premium UI: the slot rows and each bot's test verdict, as the messenger reads them —
   * cached per bot for thirty seconds, forgotten at once by this process on a save or a
   * test (`AppearanceService.invalidate`).
   */
  const appearanceRepository = new DrizzleAppearanceRepository(database.db);
  const appearanceReader = new CachedAppearanceReader(appearanceRepository, clock);
  /*
   * Round P: the Web Admin's view of the whole menu — the items with the keyboard's own
   * decision about each, the desired command list, and every bot's sync state — and the
   * two actions on that state. Reads `MainMenuLayout` (one evaluator) and writes the
   * arrangement through nothing of its own.
   */
  const botMenu = new BotMenuService({
    guard,
    audit,
    opsLog,
    idempotency,
    clock,
    settings: settingsResolver,
    mainMenu: mainMenuLayout,
    templates: templateResolver,
    defaultLabel: (key) => templateCatalogue.defaultBody(key, DEFAULT_TEMPLATE_LOCALE),
    commandMenu,
    commandSync: botCommandSync,
  });
  /*
   * Round T: the button builder. Reads the SAME evaluator (`describeFor` for the gate
   * answers, `rowsFor` for the live keyboard) and the SAME appearance rows for per-bot icon
   * eligibility; writes the projection through the setting repository's own conditional
   * write, inside the publish's transaction.
   */
  const botMenuBuilder = new BotMenuBuilderService({
    repository: mainMenuBuilderRepository,
    guard,
    uow,
    audit,
    outbox,
    // The RAW recorder: a denial is written after the transaction, a recovery inside it.
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
    settings: settingsResolver,
    settingRepository,
    mainMenu: mainMenuLayout,
    source: mainMenuSource,
    templates: templateResolver,
    defaultLabel: (key) => templateCatalogue.defaultBody(key, DEFAULT_TEMPLATE_LOCALE),
    bots: appearanceRepository,
  });
  const botCommandSyncLoop = new BotCommandSyncLoop(botCommandSync, {
    now: () => clock.now(),
    logger,
  });
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
    mainMenuLayout,
    appearanceReader,
    // Owner spec §6: the inline buttons' styles, the tenant's `bot.inline_buttons`.
    {
      stylesFor: (scope) =>
        settingsResolver.valueOf<InlineButtonStyles>(scope, 'bot.inline_buttons'),
      // UX Batch 01, item 2: each category's own colour, the tenant's `bot.category_colors`.
      categoryColorsFor: (scope) =>
        settingsResolver.valueOf<CategoryColors>(scope, 'bot.category_colors'),
      // Phase 2 Item 3: each inline button's optional premium icon, `bot.inline_button_icons`.
      iconsFor: (scope) =>
        settingsResolver.valueOf<InlineButtonIcons>(scope, 'bot.inline_button_icons'),
      // Phase 2 Item 2: each category's premium icon and after-emoji, `bot.category_icons`.
      categoryIconsFor: (scope) =>
        settingsResolver.valueOf<CategoryIcons>(scope, 'bot.category_icons'),
    },
  );
  const appearance = new AppearanceService({
    repository: appearanceRepository,
    // The SAME messenger every customer message goes through: the test message is decorated
    // by the same renderer, sent by the same transport, and read by the same classification.
    probe: customerMessenger,
    admins: {
      telegramUserIdOf: async (scope, adminId) =>
        (await admins.findById(scope, adminId as AdminId))?.telegramUserId ?? null,
    },
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    // The condition rows, read from the database as the messenger reads them.
    conditions: new DrizzleOperationalConditionReader(database.db),
    clock,
    ids,
    invalidate: (scope) => appearanceReader.forget(scope),
  });
  /*
   * R2 (items 4 and 11): the invoice screens the gateway worker and the turn both edit, and
   * the renewal's payment screens the notification lane closes before the result.
   */
  const wizardScreens: WizardInvoiceScreens = new WizardInvoiceScreens({
    state: telegramMessageState,
    payments: paymentRepository,
    invoices: gatewayPayments,
    messenger: customerMessenger,
    clock,
    actor: () => systemJobActor('telegram-wizard-screens', newCorrelationId(ids.uuid())),
  });

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
  /*
   * HF-A9: the quiet window, from the flag, its two settings and the tenant's display
   * timezone. Readers only — the reason `serviceReminderSweep` gives — and the same cached
   * presentation reader every rendered date uses, so the window and "expires today" agree
   * about the tenant's local day. Exposed on the container so a test drives the lane with
   * the very reader production uses.
   */
  const reminderQuietHours = new SettingsQuietHoursReader({
    settings: settingsResolver,
    features: featureFlagResolver,
    presentation: templatePresentation,
  });
  /**
   * The customer notification lane: repository, dispatcher and timer.
   *
   * Built after `customerMessenger` because it shares it — one messenger for every
   * customer-facing send in the process, so the bot-token resolution, the template
   * rendering and the 429 classification cannot diverge between the reply path and the
   * background one.
   */
  /**
   * Phase E3 (`docs/incidents.md`): incidents and maintenance. The record is this module's;
   * every effect goes through its owning module's existing write path, as the operator.
   */
  const incidentService = new IncidentService({
    repository: new DrizzleIncidentRepository(database.db),
    effects: new ModuleIncidentEffects({
      panels: {
        drainOf: async (scope, panelId) => {
          const view = await panelRepository.find(scope as TenantContext, panelId);
          if (view === null) return undefined;
          return view.panel.drain === null ? null : { reason: view.panel.drain.reason };
        },
        setDrain: (scope, actor, panelId, input) =>
          panelService.setDrain(scope, actor, panelId, input),
      },
      locations: {
        find: async (scope, id) => {
          const row = await serviceLocationRepository.findById(scope, id);
          return row === null ? null : { enabled: row.enabled, panelId: row.panelId };
        },
        // The location module's own narrow switch, under its lock (Codex, #162): never a
        // full update rebuilt from a row read before the lock.
        setEnabled: (scope, actor, input) =>
          serviceLocationAdminService.setEnabled(scope, actor, input),
      },
      products: {
        statusOf: async (scope, id) =>
          (await productRepository.findById(scope, id))?.status ?? null,
        activate: (scope, actor, input) => productService.activate(scope, actor, input),
        deactivate: (scope, actor, input) => productService.deactivate(scope, actor, input),
      },
      gateways: {
        statusOf: async (scope, provider) =>
          (await paymentGatewayRepository.find(scope, provider as PaymentGatewayProvider))
            ?.status ?? null,
        setStatus: (scope, actor, input) => paymentGatewayService.setStatus(scope, actor, input),
      },
    }),
    notifier: customerNotifier,
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
    logger,
    conditions: new DrizzleOperationalConditionReader(database.db),
  });
  const incidentSchedulerLoop = new IncidentSchedulerLoop(incidentService, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: INCIDENT_SCHEDULER_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
  });

  const customerNotificationLoop = new CustomerNotificationLoop(
    new CustomerNotificationService({
      notifications: customerNotificationRepository,
      // The refund-request sentences (WP19), read from the request row the kind names.
      serviceRefunds: serviceRefundRequests,
      /*
       * Package F: the recipient's sentence, read from the transfer row, and its one button
       * — derived from the subject by the surface that owns the callback vocabulary.
       */
      serviceTransfers: serviceTransferService,
      // WP-A7: support's reply, read from the ticket message the notification names.
      tickets: ticketService,
      // Phase A2: an operator's direct message, read from the message row it names.
      directMessages: customerDirectMessageService,
      // Phase E3: an incident notice's words, read from its communication row.
      incidents: incidentService,
      buttonsFor: notificationButtons,
      /*
       * The ledger reader the refund sentence renders from. The wallet repository
       * itself, because both figures are derived from `wallet_entries` and a
       * second implementation would be a second answer to "how much did we give
       * back" — which is the thing `RefundService`'s one credit path exists to
       * prevent, applied to the reading side.
       */
      refundFigures: walletRepository,
      // The rejection's reason (File 01 §7), from the payment's own row.
      rejectionReasons: paymentRepository,
      // The same repository, for the same reason: the three payment-credit sentences
      // (Payment File 02 §18) read their figure from the entries the payment names.
      paymentCredits: walletRepository,
      // B14: the approved-receipt credit's tracking code, from the payment's own row.
      paymentReferences: paymentRepository,
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
      // WP-A9: the wallet alert's and the two pending reminders' send-time values.
      reminderFacts: new DrizzleCustomerReminderFactsReader(database.db),
      // R2 (item 11): the renewal result's facts, and the payment screens closed before it.
      renewals: new DrizzleRenewalFactsReader(database.db),
      orderScreens: { close: (scope, orderId) => wizardScreens.closeOrder(scope, orderId) },
      // HF-A9: reminders claimed inside the tenant's quiet window wait for its end.
      quietHours: reminderQuietHours,
      // Round N (B2): the mass credit's amount and the grant's service, read from the item.
      massActions: {
        notificationValues: async (scope, kind, itemId) => {
          const facts = await bulkOperationRepository.notificationValues(scope, kind, itemId);
          if (facts === null) return null;
          if (kind === 'WALLET_MASS_CREDITED') {
            return facts.amountMinor === null || facts.currency === null
              ? null
              : { amount: money(facts.amountMinor, facts.currency) };
          }
          if (facts.serviceLabel === null) return null;
          return {
            service: facts.serviceLabel,
            ...(facts.trafficBytes === null ? {} : { traffic: facts.trafficBytes }),
            ...(facts.durationDays === null ? {} : { days: facts.durationDays }),
          };
        },
      },
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

  /*
   * Round N (B1): the broadcast lane. Its own tables and dispatcher — ADR-0030 closes the
   * customer notification lane to operator-authored content — sharing the one Telegram
   * transport (`telegramSend`), the tenant's template renderer and the bot-token source.
   */
  const broadcastRepository = new DrizzleBroadcastRepository(database.db);
  const broadcastTransport = new TelegramBroadcastTransport(
    templateResolver,
    botInstances,
    config.TELEGRAM_API_BASE_URL,
    config.NOTIFICATION_SEND_TIMEOUT_MS,
  );
  const broadcastFacts = new DrizzleRecipientFactsReader(database.db, (scope) =>
    settingsResolver.valueOf<SalesCurrencyCode>(scope, 'sales.currency'),
  );
  /*
   * Spec §9: a customer's stored promotional opt-out is honoured exactly while the
   * `customer_marketing_opt_out` switch is on, decided by the dispatcher's stamp alone: the
   * preview and the launch count and materialise every member (Codex review of #143).
   */
  const marketingOptOutPolicy = {
    honoured: (scope: TenantContext, tx?: unknown) =>
      featureFlagResolver.isEnabled(scope, 'customer_marketing_opt_out', tx),
  };
  const broadcastService = new BroadcastService({
    repository: broadcastRepository,
    audience: audienceService,
    transport: broadcastTransport,
    facts: broadcastFacts,
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
    // Broadcast V2: the preview's opted-out estimate only; the stamp still decides.
    marketingOptOut: marketingOptOutPolicy,
  });
  const broadcastDispatcher = new BroadcastDispatcher({
    repository: broadcastRepository,
    transport: broadcastTransport,
    facts: broadcastFacts,
    outbox,
    uow,
    clock,
    ids,
    scopeIsActive: (scope) => uow.run(scope, async (tx) => tenants.scopeIsActive(scope, tx)),
    logger,
    marketingOptOut: marketingOptOutPolicy,
  });
  const broadcastLoop = new BroadcastLoop(broadcastDispatcher, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: BROADCAST_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
  });

  // Round N, C1: campaigns. A composition over the pricing rules' own repositories and the
  // rules pages' own reference checks; it prices, credits, sends and dials nothing itself.
  const campaignRepository = new DrizzleCampaignRepository(database.db);
  const campaignService = new CampaignService({
    campaigns: campaignRepository,
    discounts: discountRepository,
    cashbackRules: cashbackRuleRepository,
    discountAdmin: discountAdminService,
    cashbackAdmin: cashbackRuleAdminService,
    calendar: new IntlCampaignCalendar(templatePresentation),
    audience: audienceService,
    broadcasts: broadcastService,
    massActions: bulkOperationService,
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
  const campaignScheduleLoop = new CampaignScheduleLoop(campaignService, campaignRepository, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: CAMPAIGN_SCHEDULE_INTERVAL_MS,
    now: () => clock.now(),
    ids,
    logger,
  });

  /*
   * Block User from the receipt message (WP10 follow-up §4). The payment READ, the customer
   * READ, the capture table and the customers section's own block — nothing that decides a
   * payment, and no blocking of its own. Its reason is read through the same capture
   * mechanics as the rejection's, below.
   */
  const reasonCaptureDeps = {
    captures: new DrizzleAdminAmountCaptureRepository(database.db),
    payments: paymentRepository,
    receipts: paymentReceiptRepository,
    customers: customerRepository,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
  };
  const receiptBlockCaptureService = receiptBlockCaptures(reasonCaptureDeps, customerService);
  /*
   * The customers section's block (WP10G, closing OQ-WP10F-03): the same capture deps and the
   * same block, with a CUSTOMER as the capture's target. No path blocks without a typed reason.
   */
  const customerBlockCaptureService = customerBlockCaptures(reasonCaptureDeps, customerService);
  /*
   * The rejection's mandatory reason (File 01 §7). It rejects only through
   * `PaymentService.rejectManualTransfer` — the conditional PENDING→FAILED edge approve and
   * credit race on — so the three dispositions stay mutually exclusive.
   */
  const receiptRejectCaptureService = receiptRejectCaptures(reasonCaptureDeps, paymentService);

  /*
   * The administrators' receipt push (WP10 follow-up §3, ADR-0031): the send half. Built in
   * every role and STARTED only by the worker, like `customerNotificationLoop`. It shares the
   * customer messenger — one `sendFile`, one 429 classification — and takes the pull item's
   * own keyboard builder, so the two messages cannot offer different buttons.
   */
  const receiptReviewPush = new ReceiptReviewPushService({
    pushes: receiptReviewPushRepository,
    payments: paymentRepository,
    receipts: paymentReceiptRepository,
    customers: customerRepository,
    reviewers: telegramAdmins,
    caption: receiptReviewCaption,
    keyboard: (paymentId, permissions) =>
      receiptReviewButtons(paymentId, permissions, { credit: true, block: true }),
    messenger: customerMessenger,
    opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    uow,
    clock,
    scopeIsActive: (scope) => uow.run(scope, async (tx) => tenants.scopeIsActive(scope, tx)),
    correlationId: () => newCorrelationId(ids.uuid()),
    logger,
    // R2 (item 3): a delivered push is a review message the decision edits in place.
    reviewMessages: {
      record: (scope, input) =>
        telegramMessageState.recordReview(
          scope,
          systemJobActor('receipt-push', newCorrelationId(ids.uuid())),
          { ...input, role: 'REVIEW' },
        ),
    },
  });
  /** The refund-request review cards' send half (WP19), in the receipt push's tick. */
  const serviceRefundPush = new ServiceRefundPushService({
    pushes: serviceRefundPushRepository,
    requests: new DrizzleServiceRefundRequestRepository(database.db),
    reviewers: telegramAdmins,
    card: (scope, requestId) => serviceRefundRequests.cardValues(scope, requestId),
    keyboard: refundRequestReviewButtons,
    messenger: customerMessenger,
    opsLog,
    conditions: new DrizzleOperationalConditionReader(database.db),
    uow,
    clock,
    scopeIsActive: (scope) => uow.run(scope, async (tx) => tenants.scopeIsActive(scope, tx)),
    correlationId: () => newCorrelationId(ids.uuid()),
    logger,
  });
  const receiptReviewPushLoop = new ReceiptReviewPushLoop(receiptReviewPush, {
    refundRequests: serviceRefundPush,
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: RECEIPT_PUSH_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
  });

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
    // Program §13: whether an operator could move a service anywhere (a read).
    locationTargets: locationChangeService,
  });
  // Program §13: an operator's free grant to one service, through `planGrant`.
  const serviceGrantService = new ServiceGrantService({
    provisioning: provisioningService,
    services: serviceRepository,
    operations: operationRepository,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
  });

  const walletTopupFlow = new WalletTopupFlowService({
    captures: customerCaptureService,
    routes: paymentGatewayService,
    payments: paymentService,
    parseAmount: parseCustomerAmount,
    settings: settingsResolver,
    uow,
  });

  const deliveryService = new DeliveryService({
    services: serviceRepository,
    contacts: customerContacts,
    messenger: customerMessenger,
    /*
     * The QR is encoded from the EXACT link the row holds at send time; the encoder is
     * a pure function of that string and nothing else (customer UX completion §B). Phase 2
     * item 4: drawn on the tenant's QR background when one is configured.
     */
    qr: deliveryQrRenderer,
    /*
     * The card's facts: the product name frozen on the ORDER (a historical fact), the
     * plan's duration and allowance from the same snapshot, and the product's
     * service-location label read LIVE — marketing display data, never routing. A
     * service whose order or product cannot be read gets the plain link message.
     */
    card: {
      factsFor: async (scope, service) => {
        const order = await orderRepository.findById(scope, service.orderId);
        if (order === null) return null;
        const product =
          service.productId === null
            ? null
            : await productRepository.findById(scope, service.productId);
        return {
          productName: order.line.title,
          // Pre-support A6: the same precedence the service card uses.
          serviceLocation: displayedServiceLocation(
            service.locationLabel,
            service.locationLabel !== null
              ? null
              : await panelInitialLocationLabel(scope, service.panelId),
            product?.display.serviceLocationLabel ?? null,
          ),
          durationDays: order.line.specification.durationDays,
          trafficBytes: order.line.specification.trafficBytes,
        };
      },
    },
    // The same tenant kill switch every other write path reads.
    scopeActivity: tenants,
    uow,
    clock,
    guard,
    panelPolicy: panelPolicyReader,
    /*
     * R3 item 6: every connection file, right after a delivered link, for any purchase
     * kind. `subscriptionFileService` is built further down (it needs the provisioning
     * service); this closure is only called by the sweep, long after the container is.
     */
    files: {
      afterDelivery: (scope, service, contact) =>
        subscriptionFileService.sendAfterDelivery(
          scope,
          systemJobActor('delivery-files', newCorrelationId(ids.uuid())),
          service,
          contact,
        ),
    },
    // R3 item 9: a pending link after a SUCCEEDED rotation is a changed link, not a new service.
    rotations: {
      hasRotated: (scope, serviceId) =>
        operationRepository.hasSucceeded(scope, serviceId, 'ROTATE_SUBSCRIPTION'),
    },
    // Round N (F4): a customer's link change is answered on the card it was asked from.
    cards: operationCardRepository,
    /*
     * Phase 2 item 5: the panel's tutorial after a first delivery. A closure because the
     * sender is built further down, beside the client-app video service it reads.
     */
    tutorial: {
      afterDelivery: (scope, service, contact) =>
        deliveryTutorialSender.afterDelivery(scope, service, contact),
    },
    /*
     * Pre-support A9: the QR under the link view is claimed by the tap's update key, in the
     * TELEGRAM namespace and suffixed so it can never meet the turn's own key.
     */
    linkQr: {
      claim: (scope, key, tx) =>
        idempotency.remember(
          scope,
          'TELEGRAM',
          `${key}:link_qr`,
          hashRequest({ command: 'service.link_qr' }),
          { claimed: true },
          tx,
        ),
    },
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
        return order === null
          ? null
          : { ...order.line.specification, durationHours: order.line.durationHours ?? null };
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
    backgroundBudgetReserve: usageSyncBackgroundReserve,
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
    // WP-A6: the frozen change request a move carries out, for the name it records.
    locationChanges: locationChangeRepository,
  });

  /*
   * Package E: a panel's ready-made connection files, fetched on a customer's tap and
   * sent straight to them. The same panel client, URL policy and tenant probe budget as
   * every other panel read, and the same messenger as every other customer send.
   */
  const subscriptionFileService = new SubscriptionFileService({
    services: provisioningService,
    panels: panelRepository,
    credentials: panelCredentials,
    adapters: providerServiceAdapter,
    implementedProviderTypes: SERVICE_PROVIDER_TYPES,
    http: panelHttp,
    urlPolicy,
    probeBudget: probeCore.probeBudget,
    messenger: customerMessenger,
    guard,
    uow,
    clock,
    panelPolicy: panelPolicyReader,
    /*
     * UX Batch 01 item 4: the caption facts the service row does not hold, read the way the
     * service card reads them — the order line's title, the location the customer was
     * shown, the status as the card words it (derived from the facts, item 3). Never the
     * panel's operator-facing name.
     */
    captionFacts: {
      factsFor: async (scope, service) => {
        const [order, product] = await Promise.all([
          orderRepository.findById(scope, service.orderId),
          service.productId === null
            ? Promise.resolve(null)
            : productRepository.findById(scope, service.productId),
        ]);
        return {
          serviceName: order?.line.title ?? null,
          location: service.locationLabel ?? product?.display?.serviceLocationLabel ?? null,
          status: await templateResolver.render(
            scope,
            serviceStateLabelKey({ ...service, now: clock.now() }),
            {},
          ),
        };
      },
    },
  });

  /*
   * WP-A10: client apps and connection guides. Built after Package E's service because
   * the customer's read asks it — through its own `offered`, the check that draws the
   * files button — whether a service can hand over connection files.
   */
  const clientAppRepository = new DrizzleClientAppRepository(database.db);
  const clientAppService = new ClientAppService({
    repository: clientAppRepository,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    ids,
    clock,
  });
  // Spec §7: the tutorial video set from Telegram («تنظیم ویدیو»), one per app and bot.
  const clientAppVideoRepository = new DrizzleClientAppVideoRepository(database.db);
  const clientAppVideoCaptures = new DrizzleAdminAmountCaptureRepository(database.db);
  const clientAppVideoService = new ClientAppVideoService({
    videos: clientAppVideoRepository,
    apps: clientAppRepository,
    captures: clientAppVideoCaptures,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    ids,
    clock,
  });
  /*
   * Phase 2 item 5: a panel's post-delivery tutorial. Its video is a client app's tutorial
   * video above — the same bot-scoped `file_id`, read through `videoFor` — so there is one
   * video capture flow, not two. The sender is what the delivery sweep calls (a closure
   * there: the sweep is built before this).
   */
  const deliveryTutorialRepository = new DrizzleDeliveryTutorialRepository(database.db);
  const deliveryTutorialService = new DeliveryTutorialService({
    tutorials: deliveryTutorialRepository,
    apps: clientAppRepository,
    panels: panelRepository,
    guard,
    audit,
    opsLog,
    sessions,
    uow,
    idempotency,
    scopeActivity: tenants,
    clock,
  });
  const deliveryTutorialSender = new DeliveryTutorialSender({
    tutorials: deliveryTutorialRepository,
    videos: clientAppVideoService,
    messenger: customerMessenger,
    idempotency,
    scopeActivity: tenants,
    uow,
  });
  const clientAppVideoWebService = new ClientAppVideoWebService({
    videos: clientAppVideoRepository,
    apps: clientAppRepository,
    captures: clientAppVideoCaptures,
    bots: botInstances,
    admins,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    ids,
    clock,
  });
  const provisionedServiceFacts = new ProvisionedServiceFacts({
    services: provisioningService,
    panels: panelRepository,
    subscriptionFiles: subscriptionFileService,
  });
  const clientAppCatalog = new ClientAppCatalog({
    repository: clientAppRepository,
    facts: provisionedServiceFacts,
  });
  /*
   * TB3 (ADR-0034 §4): the support agent's read-only context, from customer-scoped readers
   * only. Nothing here charges a permission and nothing here writes — the FAQ is read
   * straight from its repository, never through `SupportScreenReader`, which seeds.
   */
  /** TB8: the one home of support knowledge; the context reads only what was approved. */
  const supportKnowledgeRepository = new DrizzleSupportKnowledgeRepository(database.db);
  const supportContextReader = new DrizzleSupportContextReader(database.db);
  const supportContext = new SupportContextBuilder({
    customers: customerRepository,
    services: provisioningService,
    reader: supportContextReader,
    clientApps: clientAppRepository,
    serviceFacts: provisionedServiceFacts,
    faqs: supportFaqRepository,
    knowledge: supportKnowledgeRepository,
    settings: settingsResolver,
    clock,
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
          nextAttemptAt: operation.nextAttemptAt,
          // R3 item 10: asked from a service card, whose own edit is the answer.
          answeredOnCard: await operationCardRepository.hasCard(scope, operationId, tx),
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

  /*
   * R3 item 10: the card a disable or enable was asked from, edited to the result in the
   * provisioner's own tick. The card is drawn by the bot runtime itself — the same
   * `serviceDetail` the customer's tap draws — which the container builds last, so the
   * renderer is bound once the container exists (`serviceCardRenderer.current`, below).
   */
  const serviceCardRenderer: { current: ServiceCardRenderer | null } = { current: null };
  const operationCardEditor = new OperationCardEditor({
    cards: operationCardRepository,
    renderer: {
      cardFor: async (scope, customerId, serviceId, notice) =>
        serviceCardRenderer.current === null
          ? null
          : serviceCardRenderer.current.cardFor(scope, customerId, serviceId, notice),
    },
    messenger: customerMessenger,
    scopeActivity: tenants,
    uow,
    clock,
  });

  const provisionerLoop = new ProvisionerLoop(provisioner, deliveryService, outcomeAnnouncer, {
    cards: operationCardEditor,
    cashback: cashbackService,
    referrals: referralCommissionService,
    serviceRefunds: serviceRefundRequests,
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

  /*
   * TB1 (ADR-0033): Telegram Business connections and the send-on-behalf transport. The
   * notifying recorder, so a connection that stops being able to send reaches an operator.
   */
  const businessConnectionRepository = new DrizzleBusinessConnectionRepository(database.db);
  const businessTelegram = new TelegramBusinessGateway({
    apiBaseUrl: config.TELEGRAM_API_BASE_URL,
    timeoutMs: config.NOTIFICATION_SEND_TIMEOUT_MS,
  });
  const businessConnections = new BusinessConnectionService({
    repository: businessConnectionRepository,
    telegram: businessTelegram,
    tokens: botInstances,
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
  const businessTransport = new BusinessTransport({
    repository: businessConnectionRepository,
    connections: businessConnections,
    telegram: businessTelegram,
    tokens: botInstances,
    opsLog,
    clock,
  });

  /*
   * TB4 (ADR-0034): the support AI's provider foundation. Three adapters behind one port,
   * the tenant's configuration and keys, and the fallback chain with its breaker. Nothing
   * here sends a customer anything; TB5 and TB7 are the callers.
   */
  const supportAiAdapters = new Map<SupportAiProvider, SupportAiAdapter>([
    ['OPENAI', new OpenAiAdapter()],
    ['ANTHROPIC', new AnthropicAdapter()],
    ['ZAI', new ZaiAdapter()],
  ]);
  const supportAiCredentials = new DrizzleSupportAiCredentialStore(database.db, cipher, () =>
    ids.uuid(),
  );
  const supportAiConfigs = new DrizzleSupportAiConfigRepository(database.db);
  const supportAiRuns = new DrizzleSupportAiRunRecorder(database.db);
  const supportAiConditions = new DrizzleOperationalConditionReader(database.db);
  const supportAiConfig = new SupportAiConfigService({
    configs: supportAiConfigs,
    credentials: supportAiCredentials,
    runs: supportAiRuns,
    adapters: supportAiAdapters,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    conditions: supportAiConditions,
    clock,
    ids,
  });
  // TB10: support analytics, over the reports' own window resolver (tenant timezone/calendar).
  const supportAnalytics = new SupportAnalyticsService({
    guard,
    reader: new DrizzleSupportAnalyticsReader(database.db),
    windows: {
      resolve: async (scope, query) => {
        const resolved = paymentOpsPeriods.resolve(
          query,
          clock.now(),
          await templatePresentation.presentationFor(scope),
        );
        return { start: resolved.current.start, end: resolved.current.end };
      },
    },
  });
  const supportAiChain = new SupportAiChain({
    adapters: supportAiAdapters,
    credentials: supportAiCredentials,
    configs: supportAiConfigs,
    runs: supportAiRuns,
    conditions: supportAiConditions,
    opsLog,
    clock,
    ids,
  });

  /*
   * TB2 (ADR-0033 §4–§8): conversations, the human takeover, and the outbound lane. The lane
   * is BUILT in every role and STARTED only by the worker, like the customer notification lane.
   */
  const businessConversationRepository = new DrizzleBusinessConversationRepository(database.db);
  const businessOutboundRepository = new DrizzleBusinessOutboundRepository(database.db);
  const businessMessageRepository = new DrizzleBusinessMessageRepository(database.db);
  const supportAiJobs = new DrizzleSupportAiJobRepository(database.db);
  /*
   * TB7: AUTO_REPLY_SAFE. The enqueuer runs inside the webhook's transaction (it only writes a
   * job row); the escalation runs inside every handoff's transaction (record, ticket, signal).
   */
  const supportAutoEnqueuer = new SupportAutoEnqueuer({
    configs: supportAiConfigs,
    jobs: supportAiJobs,
    ids,
  });
  const businessEscalation = new BusinessEscalationService({
    escalations: businessEscalationRepository,
    conversations: businessConversationRepository,
    tickets: ticketService,
    opsLog,
    ids,
  });
  /*
   * TB8: controlled learning. A handback enqueues (inside its transaction); the `assistant`
   * role extracts; only a reviewer's approval publishes.
   */
  const supportLearning = new SupportLearningService({
    repository: supportKnowledgeRepository,
    configs: supportAiConfigs,
    chain: supportAiChain,
    conversations: businessConversationRepository,
    messages: businessMessageRepository,
    outbound: businessOutboundRepository,
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
  const supportKnowledge = new SupportKnowledgeService({
    repository: supportKnowledgeRepository,
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
   * TB9: the build reads ONLY the allowlisted sources, customer-facing fields only, and
   * proposes; a reviewer applies.
   */
  const supportKnowledgeBuild = new SupportKnowledgeBuildService({
    repository: supportKnowledgeRepository,
    sources: new NexaKnowledgeSources({
      catalogue: productService,
      locations: serviceLocationRepository,
      clientApps: clientAppRepository,
      templates: templateResolver,
      faqs: supportFaqRepository,
      terms: termsRepository,
      settings: settingsResolver,
      gateways: paymentGatewayRepository,
    }),
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
  const businessConversations = new BusinessConversationService({
    conversations: businessConversationRepository,
    messages: businessMessageRepository,
    outbound: businessOutboundRepository,
    customers: new DrizzleBusinessCustomerLookup(database.db),
    connections: businessConnections,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    idempotency,
    scopeActivity: tenants,
    clock,
    ids,
    autoTrigger: supportAutoEnqueuer,
    escalation: businessEscalation,
    escalations: businessEscalationRepository,
    learning: supportLearning,
  });
  const supportContextSource = new TbSupportContextSource(supportContext);
  const supportImages = new TelegramSupportImageSource({
    conversations: businessConversationRepository,
    messages: businessMessageRepository,
    bots: botInstances,
    apiBaseUrl: config.TELEGRAM_API_BASE_URL,
    fileBaseUrl: config.TELEGRAM_API_BASE_URL,
  });
  const supportAutoReply = new SupportAutoReplyService({
    jobs: supportAiJobs,
    configs: supportAiConfigs,
    chain: supportAiChain,
    images: supportImages,
    ids,
    context: supportContextSource,
    conversations: businessConversationRepository,
    messages: businessMessageRepository,
    outbound: businessOutboundRepository,
    facts: supportContextReader,
    control: businessConversations,
    uow,
    scopeActivity: tenants,
    clock,
  });
  const supportAssist = new SupportAssistService({
    jobs: supportAiJobs,
    configs: supportAiConfigs,
    chain: supportAiChain,
    context: supportContextSource,
    /*
     * TB6: a customer's photo, by the token of the bot the conversation belongs to, through
     * the one Telegram file download (bounded while streaming, no redirects, outside any
     * transaction). Same configured origin for files as the receipt reader.
     */
    images: supportImages,
    conversations: businessConversationRepository,
    messages: businessMessageRepository,
    sender: businessConversations,
    guard,
    uow,
    audit,
    opsLog,
    sessions,
    scopeActivity: tenants,
    clock,
    ids,
  });
  const assistantLoop = new AssistantLoop(supportAssist, {
    auto: supportAutoReply,
    learning: supportLearning,
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    intervalMs: ASSISTANT_INTERVAL_MS,
    now: () => clock.now(),
    logger,
  });
  const businessOutboundLoop = new BusinessOutboundLoop(
    new BusinessOutboundService({
      outbound: businessOutboundRepository,
      conversations: businessConversationRepository,
      messages: businessMessageRepository,
      control: businessConversations,
      transport: businessTransport,
      autoMode: supportAutoEnqueuer,
      escalations: businessEscalationRepository,
      uow,
      scopeActivity: tenants,
      clock,
      ids,
      logger,
    }),
    {
      scope: () =>
        installationTenantId === null
          ? null
          : { tenantId: installationTenantId, botInstanceId: null },
      intervalMs: BUSINESS_OUTBOUND_INTERVAL_MS,
      now: () => clock.now().getTime(),
      logger,
    },
  );

  // WP-A4: the operations log group. Built before the notification lane, which prefers
  // the connected group over the manual chat id setting, and before the dispatcher, which
  // resolves an intent routed to the group to where the group is at send time.
  const opsGroupRepository = new DrizzleOpsGroupRepository(database.db);
  const opsGroupTelegram = new TelegramOpsGroup(
    config.TELEGRAM_API_BASE_URL,
    config.NOTIFICATION_SEND_TIMEOUT_MS,
  );
  const opsGroupBots = new OpsGroupBotSource(botInstances);
  const opsGroups = new OpsGroupService({
    repository: opsGroupRepository,
    telegram: opsGroupTelegram,
    bots: opsGroupBots,
    provisioner: new OpsTopicProvisioner({
      repository: opsGroupRepository,
      telegram: opsGroupTelegram,
      templates: templateResolver,
      audit,
      // The RAW recorder: a topic event is not projected back into the group it is about.
      opsLog: opsLogWriter,
      clock,
      ids,
      logger,
    }),
    notifications: notificationRepository,
    templates: templateResolver,
    features: featureFlagResolver,
    settings: settingsResolver,
    guard,
    uow,
    audit,
    opsLog: opsLogWriter,
    sessions,
    idempotency,
    scopeActivity: tenants,
    outbox,
    clock,
    ids,
    logger,
  });
  const opsGroupSystemActor = () => systemJobActor('ops-group', newCorrelationId(ids.uuid()));
  const opsGroupRouter = new OpsGroupRouter(opsGroups, opsGroupSystemActor);
  const opsGroupMaintainer = new OpsGroupMaintainer(opsGroups, {
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    actor: opsGroupSystemActor,
    intervalMs: OPS_GROUP_MAINTAIN_INTERVAL_MS,
    now: () => clock.now().getTime(),
    logger,
  });

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
    // WP-A4: the connected group first, the manual chat id only without one.
    opsGroupRouter,
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
    // WP-A4: an intent routed to the group goes where the group is NOW.
    opsGroupRouter,
  );

  const opsLogService = new OpsLogService(guard, new DrizzleOperationalEventReader(database.db));
  /**
   * Phase B3 (`docs/notification-center.md`): the Notification Center reads the same
   * `operational_events` through `NOTIFICATION_RULES`; its one table is per-admin read marks.
   */
  const notificationCenter = new NotificationCenterService({
    repository: new DrizzleNotificationInboxRepository(database.db, NOTIFICATION_RULES),
    guard,
    opsLog,
    scopeActivity: tenants,
    uow,
    clock,
  });
  const auditLogService = new AuditLogService({
    guard,
    reader: new DrizzleAuditLogReader(database.db),
    audit,
    opsLog,
    writer: new DefaultAuditLogExportWriter(),
    clock,
  });
  const diagnostics = new DiagnosticsService({
    guard,
    reader: new DrizzleDiagnosticsReader(database.db),
    clock,
  });
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
  /*
   * The automatic schedule (spec §13.2): the Web Admin's registry values on the
   * installation tenant, the environment as the compatible default. One policy, read by
   * the scheduler on every tick and by the status card, so they cannot disagree.
   */
  const backupSchedule = new BackupSchedulePolicy({
    settings: {
      read: async (scope) => ({
        enabled: await settingsResolver.valueOf<boolean | null>(
          scope,
          BACKUP_SCHEDULE_SETTING_KEYS.enabled,
        ),
        intervalMinutes: await settingsResolver.valueOf<number | null>(
          scope,
          BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes,
        ),
      }),
    },
    scope: () =>
      installationTenantId === null
        ? null
        : { tenantId: installationTenantId, botInstanceId: null },
    environment: {
      enabled: config.BACKUP_SCHEDULE_ENABLED,
      intervalMs: config.BACKUP_INTERVAL_MS,
    },
  });
  const backup = new BackupService({
    runs: backupRuns,
    tools: backupTools,
    // The SAME keyring the secret cipher uses. One active key encrypts, every
    // held key decrypts — so an archive taken before a rotation stays readable
    // after it, which is the property a backup needs more than anything else
    // in this installation does.
    archiver: backupArchiver,
    workspaces: new FilesystemBackupWorkspaces(config.BACKUP_WORK_DIR),
    /*
     * Spec §13.1: the connected operations log group's «💾 بکاپ‌ها» topic first, posted
     * by the group's own bot through the ONE topic provisioner; the environment's
     * dedicated chat only as the explicit fallback. Precedence: `RoutedBackupDelivery`.
     */
    delivery: new RoutedBackupDelivery({
      opsGroup: new OpsGroupBackupTopicAdapter(opsGroups, opsGroupBots, () =>
        systemJobActor('backup-delivery', newCorrelationId(ids.uuid())),
      ),
      scope: () =>
        installationTenantId === null
          ? null
          : { tenantId: installationTenantId, botInstanceId: null },
      channelFor: (target) =>
        new TelegramBackupDelivery({
          apiBaseUrl: config.TELEGRAM_API_BASE_URL,
          token: target.token,
          chatId: target.chatId,
          messageThreadId: target.threadId,
          timeoutMs: config.BACKUP_DELIVERY_TIMEOUT_MS,
        }),
      dedicated: new TelegramBackupDelivery({
        apiBaseUrl: config.TELEGRAM_API_BASE_URL,
        token: config.BACKUP_TELEGRAM_BOT_TOKEN,
        chatId: config.BACKUP_TELEGRAM_CHAT_ID,
        timeoutMs: config.BACKUP_DELIVERY_TIMEOUT_MS,
      }),
      clock,
      logger,
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
  /*
   * The Recovery Kit's key lifecycle (ADR-0032). The loader keeps this
   * process's keyring in step with `installation_keys`; the coverage adapter is
   * what both halves of a recovery ask about keys.
   */
  const installationKeyRepository = new DrizzleInstallationKeyRepository(database.db);
  const installationKeyLoader = new InstallationKeyLoader(
    keyring,
    installationKeyRepository,
    logger,
  );
  const recoveryKeyCoverage = new KeyringRecoveryKeyCoverage(
    keyring,
    installationKeyLoader,
    installationKeyRepository,
    new PgCandidateKeyStore(config.DATABASE_URL, backupTools.liveDatabase),
  );
  const installationKeys = new InstallationKeyService({
    keyring,
    loader: installationKeyLoader,
    keys: installationKeyRepository,
    archives: new FilesystemRetainedArchiveScanner(config.BACKUP_WORK_DIR),
    recoveries: recoveryRequests,
    workspaces: recoveryWorkspaces,
    uow,
    idempotency,
    guard,
    audit,
    opsLog,
    clock,
    ids,
    // The same switch that selects the password hasher's cost, refused in
    // production by the config schema for the same reason.
    kdf: config.PASSWORD_HASH_PROFILE === 'fast' ? FAST_KIT_KDF : PRODUCTION_KIT_KDF,
    verifyStepUp: (scope, actor, stepUp, context, action) =>
      adminManagement.verifyStepUp(scope, actor, stepUp, context, action),
  });
  const recoveryService = new RecoveryService({
    requests: recoveryRequests,
    workspaces: recoveryWorkspaces,
    // The SAME archiver the backup pipeline seals with, so one keyring and one
    // `openArchive`. A recovery that decrypted through its own route would be
    // proving a path nobody restores through.
    archiver: backupArchiver,
    engine: backupTools,
    keys: recoveryKeyCoverage,
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
    schedule: () => backupSchedule.effective(),
  });

  const recoveryExecutor = new RecoveryExecutor({
    requests: recoveryRequests,
    recovery: recoveryService,
    engine: backupTools,
    workspaces: recoveryWorkspaces,
    keys: recoveryKeyCoverage,
    audit,
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
    schedule: () => backupSchedule.effective(),
    tickIntervalMs: config.BACKUP_TICK_MS,
    // A run in flight is alive while its lease heartbeat is — the same rule that decides
    // when another process may reclaim it as abandoned.
    runHeartbeatAt: () => backup.leaseHeartbeatAt(),
    runStaleAfterMs: BACKUP_LEASE_STALE_AFTER_MS,
    logger,
  });

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
        expiryDayEnabled: on(
          'service_expiry_day_reminder',
          SERVICE_REMINDER_DEFAULTS.expiryDayEnabled,
        ),
        usageEnabled: on('service_usage_reminders', SERVICE_REMINDER_DEFAULTS.usageEnabled),
        expiryEarlyDays: number(
          'reminders.expiry_early_days',
          SERVICE_REMINDER_DEFAULTS.expiryEarlyDays,
        ),
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

  const container: Container = {
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
    ticketReplyFileSweeper,
    directMessageFileSweeper,
    paymentExpiryLoop,
    gatewayPayments,
    gatewayReceiptCaptures,
    gatewayPaymentLoop,
    fx: fxService,
    fxRefreshLoop,
    starsPayments,
    /** The sweep itself, so a test runs one pass instead of starting a timer. */
    paymentExpirySweep,
    usernameLane,
    usernameNamespace: serviceUsernameRepository,
    serviceReminderLoop,
    serviceReminderSweep,
    customerReminderLoop,
    pendingPaymentReminderSweep,
    walletLowBalanceSweep,
    customerNotificationLoop,
    telegramMessageState,
    wizardScreens,
    telegramMessageRetentionLoop,
    customerNotifications: customerNotificationRepository,
    reminderQuietHours,
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
    accountSecurity,
    secondFactors,
    loginChallenges,
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
    customerControls: customerControlService,
    customerCrm: customerCrmService,
    customerInsights: customerInsightService,
    customerAccountTransfers: customerAccountTransferService,
    customerDirectMessages: customerDirectMessageService,
    manualOrders: manualOrderService,
    customerServicesToggle: customerServicesToggleService,
    products: productService,
    legacyProducts: legacyProductService,
    productCategories: productCategoryService,
    serviceAddons: serviceAddonService,
    discounts: discountAdminService,
    cashbackRules: cashbackRuleAdminService,
    campaigns: campaignService,
    campaignScheduleLoop,
    customServiceAdmin: customServiceAdminService,
    customServiceFlow: customServiceFlowService,
    customerCaptures: customerCaptureService,
    subscriptionFiles: subscriptionFileService,
    serviceTransfers: serviceTransferService,
    tickets: ticketService,
    ticketCategories: ticketCategoryService,
    pricingRead: pricingReadService,
    cashback: cashbackService,
    referrals: referralProgram,
    referralCommissions: referralCommissionService,
    referralsRead: referralReadService,
    reports: reportingService,
    operationsOverview,
    referralSignupGifts: referralSignupGiftService,
    tenantMedia: tenantMediaService,
    deliveryQrPreview,
    deliveryQr: deliveryQrRenderer,
    resellers: resellerService,
    resellersAdmin: resellerAdminService,
    resellerMinimums: resellerMinimumService,
    commercialActions: commercialActionService,
    serviceLocations: serviceLocationAdminService,
    locationChanges: locationChangeService,
    trials: trialService,
    trialAdmin: trialAdminService,
    legacyTrials: legacyTrialEligibilityService,
    panelTrials,
    audience: audienceService,
    broadcasts: broadcastService,
    broadcastLoop,
    broadcastDispatcher,
    bulkOperations: bulkOperationService,
    bulkOperationProcessor,
    bulkOperationLoop,
    wallet: walletService,
    migrationOpeningBalance,
    legacyReviewQueue,
    legacyAdoption,
    payments: paymentService,
    paymentAccounts: paymentAccountService,
    botManagement,
    botMenu,
    botMenuBuilder,
    mainMenu: mainMenuLayout,
    botCommandSync,
    botCommandSyncLoop,
    commandMenu,
    paymentGateways: paymentGatewayService,
    refunds: refundService,
    serviceRefundRequests,
    serviceRefundDecisions,
    receiptDispositions: receiptDispositionService,
    paymentTimeline: paymentTimelineService,
    paymentOperations: paymentOperationsService,
    paymentAttention: paymentAttentionReader,
    gatewayHealth: gatewayHealthService,
    receiptCreditCaptures: receiptCreditCaptureService,
    receiptBlockCaptures: receiptBlockCaptureService,
    receiptRejectCaptures: receiptRejectCaptureService,
    receiptReviewPushes: receiptReviewPushRepository,
    receiptReviewPush,
    receiptReviewPushLoop,
    paymentGatewayProvisioning: paymentGatewayRepository,
    receipts: receiptService,
    receiptFiles,
    provisioning: provisioningService,
    serviceAdmin,
    serviceGrants: serviceGrantService,
    provisioner,
    provisionerLoop,
    delivery: deliveryService,
    orders: orderService,
    antiSpam,
    botRuntime: new BotRuntime({
      // Best-effort steps are logged here: a card's live read on open that failed
      // unexpectedly (pre-support A2), and a receipt's invoice finalisation that failed
      // after its turn's durable write (A10).
      logger,
      // WP20: more than 20 interactions in 10 s blocks the customer; fails open.
      antiSpam,
      // Package B: the REQUIRED channels, enforced before any business action; fails open.
      membership: channelMembership,
      terms: termsAcceptanceService,
      // WP11A: the external-gateway attempt's customer reads and the check tap.
      gateway: gatewayPayments,
      // TonPays Telegram: «📤 ارسال فیش واریزی» and «🔄 تعویض کارت» (database writes only).
      gatewayReceipts: gatewayReceiptCaptures,
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
      // R1: this tenant's own labels, matched BEFORE the shared ones above so a renamed
      // button routes under its new name — the same object the messenger draws from.
      menuRoutes: mainMenuLayout,
      destinations: paymentDestinationRenderer,
      receipts: receiptService,
      receiptCredits: receiptCreditCaptureService,
      serviceRefunds: serviceRefundRequests,
      serviceRefundDecisions,
      receiptBlocks: receiptBlockCaptureService,
      receiptRejects: receiptRejectCaptureService,
      customerBlocks: customerBlockCaptureService,
      telegramAdmins,
      // The customer UX completion's seams. Each re-reads its facts on the tap.
      captures: customerCaptureService,
      topup: walletTopupFlow,
      screens: customerScreens,
      counters: customerCounters,
      routes: paymentGatewayService,
      support: { partsFor: supportScreenParts },
      panelLocations: { initialLabelFor: panelInitialLocationLabel },
      productDisplay: {
        displayFor: async (scope, productId) => {
          // A custom service (Package D) was bought from no product, so it has no display.
          if (productId === null) return null;
          const product = await productRepository.findById(scope, productId);
          // B1: the description travels with the display data, for the pre-invoice.
          return product === null ? null : { ...product.display, description: product.description };
        },
      },
      resellers: resellerService,
      referralGifts: referralSignupGiftService,
      media: tenantMediaService,
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
      // WP-A6: a customer's free location change.
      locationChanges: locationChangeService,
      trials: trialService,
      customService: customServiceFlowService,
      subscriptionFiles: subscriptionFileService,
      /*
       * R3 item 7: «♻️ بروزرسانی اطلاعات» as one bounded read on the tap, under the same
       * bounds as the files above — the panel budget, SafeHttpClient and the URL policy.
       */
      serviceRefresh: new ServiceRefreshService({
        services: provisioningService,
        rows: serviceRepository,
        panels: panelRepository,
        credentials: panelCredentials,
        adapters: providerServiceAdapter,
        implementedProviderTypes: SERVICE_PROVIDER_TYPES,
        http: panelHttp,
        urlPolicy,
        probeBudget: probeCore.probeBudget,
        // Pre-support A2: a card being opened reads above the background floor, never from it.
        backgroundBudgetReserve: usageSyncBackgroundReserve,
        guard,
        scopeActivity: tenants,
        panelPolicy: panelPolicyReader,
        uow,
        clock,
        // A read is a log-in and a look-up, each bounded by the client's timeout; three
        // of them plus a margin is comfortably longer than any read that is still alive.
        inFlightMs: 3 * config.PANEL_HTTP_TIMEOUT_MS + 30_000,
      }),
      // WP-A10: «📱 دانلود برنامه و آموزش اتصال», the tenant's apps for the customer's services.
      clientApps: clientAppCatalog,
      // Spec §7: the tutorial video — the admin wizard and the customer's app screen.
      clientAppVideos: clientAppVideoService,
      serviceTransfers: serviceTransferService,
      /*
       * WP-A7: the ticket desk. A file answers a ticket window only when that window is open
       * and newer than any open receipt window — the prompt the customer saw last — and the
       * receipt window is read here under ITS lock, inside the capture read's transaction
       * (which already holds the capture lock), so the choice cannot go stale before the read.
       */
      // R2 (items 3–5): edit-in-place state for wizards and receipt reviews.
      messageState: telegramMessageState,
      invoiceScreens: wizardScreens,
      // R2: which order an open typed-answer window names, so a refusal edits ITS wizard.
      answerWindowOrder: async (scope, botInstanceId, customerId, window) => {
        const open =
          window === 'USERNAME'
            ? await usernameLane.openWindowFor(scope, botInstanceId, customerId, {
                tx: database.db,
                scope,
              })
            : await discountCodeCaptureRepository.findOpen(
                scope,
                botInstanceId,
                customerId,
                undefined,
              );
        return open?.orderId ?? null;
      },
      tickets: {
        service: ticketService,
        categories: ticketCategoryService,
        screens: ticketScreens,
        receiptWindowOpenedAt: async (scope, botInstanceId, customerId, tx) => {
          await receiptCaptureRepository.lockForCustomer(scope, botInstanceId, customerId, tx);
          const receipt = await receiptCaptureRepository.findOpen(
            scope,
            botInstanceId,
            customerId,
            tx,
          );
          if (receipt === null || receipt.expiresAt.getTime() <= clock.now().getTime()) {
            return null;
          }
          return receipt.openedAt;
        },
      },
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
     * Over the SAME panel service — its list charges `panels.view` and computes the
     * health, capacity, sellability and drain every other screen shows.
     */
    panelHealth: new PanelHealthDashboardService({
      panels: panelService,
      stats: new DrizzlePanelFleetStatsReader(database.db),
      conditions: new DrizzleOperationalConditionReader(database.db),
      clock,
    }),
    panelAdvanced,
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
    supportFaqs: supportFaqService,
    terms: termsService,
    termsAcceptance: termsAcceptanceService,
    supportScreen: supportScreenReader,
    clientApps: clientAppService,
    clientAppVideos: clientAppVideoService,
    clientAppVideoWeb: clientAppVideoWebService,
    deliveryTutorials: deliveryTutorialService,
    clientAppCatalog,
    templateRepository,
    notifications,
    notificationRepository,
    notificationDispatcher,
    notificationTransport,
    appearance,
    opsGroups,
    businessConnections,
    businessTransport,
    businessConversations,
    businessOutboundLoop,
    supportContext,
    supportAiConfig,
    supportAiChain,
    supportAnalytics,
    supportAssist,
    assistantLoop,
    supportAutoReply,
    supportKnowledge,
    supportLearning,
    supportKnowledgeBuild,
    opsGroupMaintainer,
    opsLogService,
    notificationCenter,
    auditLog: auditLogService,
    incidents: incidentService,
    incidentSchedulerLoop,
    monitorProfileService,
    diagnostics,
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
    keyring,
    installationKeyLoader,
    installationKeyRepository,
    installationKeys,
    legacyImporter: (options = {}) => {
      const importerRepository = new DrizzleLegacyImporterRepository(database.db, (scope) =>
        settingsResolver.valueOf<CurrencyCode>(scope, 'sales.currency'),
      );
      return new LegacyImporterService({
        destination: importerRepository,
        runs: new DrizzleLegacyImportRepository(database.db),
        runInputs: importerRepository,
        customers: importerRepository,
        inventory: new RickpanelInventorySource(
          {
            panel: async (scope, panelId) => {
              const view = await panelRepository.find(scope, panelId);
              return view === null
                ? null
                : { baseUrl: view.panel.baseUrl, providerType: view.panel.providerType };
            },
            credentials: (scope, panelId) => panelCredentials.read(scope, panelId),
            http: (baseUrl) => panelHttp.forBase(baseUrl),
          },
          options.inventoryPageSize === undefined ? {} : { pageSize: options.inventoryPageSize },
          () => clock.now(),
        ),
        openings: migrationOpeningBalance,
        trials: legacyTrialEligibilityService,
        products: legacyProductService,
        // P6 by default (`container.legacyAdoption.adoptCandidate`); only an explicit null
        // runs without it, and its eligible candidates are then reported PENDING.
        adoption:
          options.adoption === undefined
            ? {
                adopt: (scope, actor, candidate) =>
                  legacyAdoption.adoptCandidate(scope, actor, candidate),
              }
            : options.adoption,
        guard,
        uow,
        audit,
        opsLog,
        sessions,
        scopeActivity: tenants,
        outbox,
        clock,
        ids,
        codeVersion: config.BUILD_VERSION,
      });
    },
    async shutdown() {
      installationKeyLoader.stop();
      backupScheduler.stop();
      recoveryExecutor.stop();
      await relay.stop();
      await panelMonitor.stop();
      await notificationDispatcher.stop();
      await throttleSweeper.stop();
      await sessionSweeper.stop();
      await backupRunSweeper.stop();
      await recoveryRequestSweeper.stop();
      await ticketReplyFileSweeper.stop();
      await directMessageFileSweeper.stop();
      await paymentExpiryLoop.stop();
      await gatewayPaymentLoop.stop();
      await serviceReminderLoop.stop();
      await customerReminderLoop.stop();
      await campaignScheduleLoop.stop();
      await telegramMessageRetentionLoop.stop();
      // Round P: a claimed command sync finishes its record or lapses with its lease.
      await botCommandSyncLoop.stop();
      await customerNotificationLoop.stop();
      // TB2: a stamped business send is recorded before the pool closes.
      await businessOutboundLoop.stop();
      // Round N: and the broadcast lane, for the same reason — a stamped send is recorded.
      await broadcastLoop.stop();
      await incidentSchedulerLoop.stop();
      await bulkOperationLoop.stop();
      await receiptReviewPushLoop.stop();
      await opsGroupMaintainer.stop();
      await interactionCounter.close();
      await redis.close();
      await database.close();
    },
  };
  // R3 item 10: the card renderer the provisioner's card editor draws with (above).
  serviceCardRenderer.current = {
    cardFor: (scope, customerId, serviceId, notice) =>
      container.botRuntime.serviceCardFor(
        scope,
        systemJobActor('service-card', newCorrelationId(ids.uuid())),
        customerId,
        serviceId,
        notice,
      ),
  };
  return container;
}

export const CONTAINER = Symbol('CONTAINER');
