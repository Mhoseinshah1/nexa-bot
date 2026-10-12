import { Inject, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONTAINER, type Container } from './container.js';
import { ReadinessProbe } from './surfaces/web/readiness.probe.js';
import { HealthController } from './surfaces/web/health.controller.js';
import { AuthController } from './surfaces/web/auth.controller.js';
import { AccountSecurityController } from './surfaces/web/account-security.controller.js';
import { RbacController } from './surfaces/web/rbac.controller.js';
import { AdminsController } from './surfaces/web/admins.controller.js';
import { ControlController } from './surfaces/web/control.controller.js';
import { CustomersController } from './surfaces/web/customers.controller.js';
import { Customer360Controller } from './surfaces/web/customer-360.controller.js';
import { NotificationCenterController } from './surfaces/web/notification-center.controller.js';
import { CustomerDirectMessagesController } from './surfaces/web/customer-direct-messages.controller.js';
import { IncidentsController } from './surfaces/web/incidents.controller.js';
import { CustomerCrmController } from './surfaces/web/customer-crm.controller.js';
import { TrialsController } from './surfaces/web/trials.controller.js';
import { ProductsController } from './surfaces/web/products.controller.js';
import { ProductCategoriesController } from './surfaces/web/product-categories.controller.js';
import { ServiceAddonsController } from './surfaces/web/service-addons.controller.js';
import { ServiceLocationsController } from './surfaces/web/service-locations.controller.js';
import { PricingController } from './surfaces/web/pricing.controller.js';
import { CustomServiceController } from './surfaces/web/custom-service.controller.js';
import { ReferralsController } from './surfaces/web/referrals.controller.js';
// Round N, C1.
import { CampaignsController } from './surfaces/web/campaigns.controller.js';
import { ReportsController } from './surfaces/web/reports.controller.js';
import { DashboardController } from './surfaces/web/dashboard.controller.js';
import { TenantMediaController } from './surfaces/web/tenant-media.controller.js';
import { ResellersController } from './surfaces/web/resellers.controller.js';
import { OrdersController } from './surfaces/web/orders.controller.js';
import { WalletController } from './surfaces/web/wallet.controller.js';
import { PaymentsController } from './surfaces/web/payments.controller.js';
import { PaymentAccountsController } from './surfaces/web/payment-accounts.controller.js';
import { BotsController } from './surfaces/web/bots.controller.js';
import { BotMenuController } from './surfaces/web/bot-menu.controller.js';
import { BotMenuBuilderController } from './surfaces/web/bot-menu-builder.controller.js';
import { OpsGroupController } from './surfaces/web/ops-group.controller.js';
// Premium UI: «ظاهر ربات».
import { AppearanceController } from './surfaces/web/appearance.controller.js';
import { PaymentGatewaysController } from './surfaces/web/payment-gateways.controller.js';
import { FxController } from './surfaces/web/fx.controller.js';
import { SupportFaqController } from './surfaces/web/support-faq.controller.js';
import { TermsController } from './surfaces/web/terms.controller.js';
import { ClientAppController } from './surfaces/web/client-app.controller.js';
import { DeliveryTutorialController } from './surfaces/web/delivery-tutorial.controller.js';
import { TicketsController } from './surfaces/web/tickets.controller.js';
import { BusinessChatsController } from './surfaces/web/business-chats.controller.js';
import { SupportAiController } from './surfaces/web/support-ai.controller.js';
import { SupportKnowledgeController } from './surfaces/web/support-knowledge.controller.js';
import { AuditLogController } from './surfaces/web/audit-log.controller.js';
import { RefundsController } from './surfaces/web/refunds.controller.js';
import { ServiceRefundRequestsController } from './surfaces/web/service-refund-requests.controller.js';
import { LegacyProductsController } from './surfaces/web/legacy-products.controller.js';
import { LegacyDebtsController } from './surfaces/web/legacy-debts.controller.js';
import { LegacyServicesController } from './surfaces/web/legacy-services.controller.js';
import { LegacyCutoverController } from './surfaces/web/legacy-cutover.controller.js';
import { LegacyMigrationController } from './surfaces/web/legacy-migration.controller.js';
import { LegacyInvoicesController } from './surfaces/web/legacy-invoices.controller.js';
import { LegacyHistoryController } from './surfaces/web/legacy-history.controller.js';
import { ServicesController } from './surfaces/web/services.controller.js';
import { PanelsController } from './surfaces/web/panels.controller.js';
import { RecoveryController } from './surfaces/web/recovery.controller.js';
import { RecoveryKitController } from './surfaces/web/recovery-kit.controller.js';
import { SystemController } from './surfaces/web/system.controller.js';
import { AudienceController } from './surfaces/web/audience.controller.js';
import { BroadcastsController } from './surfaces/web/broadcasts.controller.js';
import { BulkOperationsController } from './surfaces/web/bulk-operations.controller.js';
import { TelegramWebhookController } from './surfaces/telegram/webhook.controller.js';
import { GatewayWebhookController } from './surfaces/gateway/webhook.controller.js';
import { GatewayReturnController } from './surfaces/gateway/return.controller.js';
import { CorrelationMiddleware } from './surfaces/web/correlation.middleware.js';
import { securityHeaders } from './surfaces/web/security-headers.middleware.js';
import { DomainErrorFilter } from './surfaces/web/error.filter.js';

/**
 * The API process's module graph.
 *
 * The Telegram webhook controller is registered only when the feature is on, so
 * a deployment that has not configured a bot does not expose the route at all —
 * it returns 404 rather than 401, and there is nothing to probe.
 */
@Module({})
export class AppModule implements NestModule {
  /**
   * The container this module graph was built for.
   *
   * Injected rather than stashed on a static. `isProduction` used to be a
   * mutable class property assigned by `forContainer` and read back in
   * `configure` — process-global state keyed to nothing, so two applications
   * constructed in one process shared it. The second construction rewrote the
   * first's value, and whichever `configure` ran later decided the security
   * headers for BOTH. In a test run that silently swaps HSTS on or off; the
   * shape is the problem regardless of whether production ever does it.
   */
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  static forContainer(container: Container) {
    const controllers = [HealthController];

    // The authenticated admin surface. Registered whenever real authentication
    // is configured — unlike the ping endpoint below, these endpoints check a
    // session and a permission on every call, so there is nothing to gate.
    if (container.config.AUTH_MODE === 'password') {
      controllers.push(
        AuthController as never,
        // Phase D2: the signed-in administrator's own second factor, sessions and history.
        AccountSecurityController as never,
        // Phase D3: role management over the existing authorization model.
        RbacController as never,
        AdminsController as never,
        ControlController as never,
        CustomersController as never,
        Customer360Controller as never,
        // Phase B3: the administrator's notification inbox.
        NotificationCenterController as never,
        // Phase A2: «ارسال پیام» from Customer 360.
        CustomerDirectMessagesController as never,
        // Phase E3: incidents and maintenance.
        IncidentsController as never,
        // Program §8: operator-only notes and tags.
        CustomerCrmController as never,
        TrialsController as never,
        ProductsController as never,
        ProductCategoriesController as never,
        ServiceAddonsController as never,
        // WP-A6: the operator's service locations.
        ServiceLocationsController as never,
        PricingController as never,
        CustomServiceController as never,
        ReferralsController as never,
        CampaignsController as never,
        ReportsController as never,
        DashboardController as never,
        TenantMediaController as never,
        ResellersController as never,
        OrdersController as never,
        WalletController as never,
        PaymentsController as never,
        PaymentAccountsController as never,
        BotsController as never,
        // Round P: the bot's menu and its command-menu sync.
        BotMenuController as never,
        BotMenuBuilderController as never,
        OpsGroupController as never,
        AppearanceController as never,
        PaymentGatewaysController as never,
        // Package FX: the central exchange rate's status and manual refresh.
        FxController as never,
        SupportFaqController as never,
        TermsController as never,
        ClientAppController as never,
        // Phase 2 item 5: a panel's post-delivery tutorial.
        DeliveryTutorialController as never,
        // WP-A7: support tickets.
        TicketsController as never,
        BusinessChatsController as never,
        SupportAiController as never,
        // TB8: support knowledge and the learning queue.
        SupportKnowledgeController as never,
        RefundsController as never,
        ServiceRefundRequestsController as never,
        LegacyProductsController as never,
        LegacyDebtsController as never,
        LegacyServicesController as never,
        LegacyCutoverController as never,
        LegacyMigrationController as never,
        LegacyInvoicesController as never,
        LegacyHistoryController as never,
        ServicesController as never,
        PanelsController as never,
        RecoveryController as never,
        RecoveryKitController as never,
        // Round N: the shared audience.
        AudienceController as never,
        BroadcastsController as never,
        BulkOperationsController as never,
        // Phase D1: the audit log browser and its export.
        AuditLogController as never,
      );
    }

    // The system ping endpoint runs the canonical write path over HTTP with no
    // authentication, because Phase 0 has none. That is acceptable as a
    // development affordance and unacceptable anywhere else: it would let an
    // anonymous caller write rows into append-only tables. Registered only in
    // development, the same way the webhook is registered only when configured.
    if (container.config.NODE_ENV === 'development') {
      controllers.push(SystemController as never);
    }

    if (container.config.TELEGRAM_WEBHOOK_ENABLED) {
      controllers.push(TelegramWebhookController as never);
    }

    // External payment gateway webhooks (WP11A). Always registered: the route acts only
    // on an attempt this installation created, and only by scheduling an inquiry — it
    // can settle nothing, so there is nothing to gate behind a flag.
    controllers.push(GatewayWebhookController as never);
    // A provider's browser return (CentralPay): a GET that only brings a verify forward.
    controllers.push(GatewayReturnController as never);

    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: CONTAINER, useValue: container },
        // Shared by the anonymous `/health/ready` and the authenticated
        // readiness detail, so there is one readiness computation rather than
        // two that can disagree.
        ReadinessProbe,
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
    // Read from THIS module's own container, so the answer belongs to this
    // application rather than to whichever one was constructed most recently.
    consumer
      .apply(securityHeaders(this.container.config.NODE_ENV === 'production'))
      .forRoutes('*path');
  }
}
