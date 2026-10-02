import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  customerChannelExemptionRequestSchema,
  customerLocationOverrideRequestSchema,
  customerManualOrderRequestSchema,
  customerNotificationsRequestSchema,
  customerPhoneVerificationRequestSchema,
  customerServicesToggleRequestSchema,
  customerTransferPreviewRequestSchema,
  customerTransferRequestSchema,
  type CurrencyCode,
  type CustomerFinancialSummaryResponse,
  type CustomerManualOrderResponse,
  type CustomerOverviewResponse,
  type CustomerServicesToggleResponse,
  type CustomerTimelineResponse,
  type CustomerTransferPreviewResponse,
  type CustomerTransferResultResponse,
  type LedgerDirection,
  type LedgerReason,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { CustomerOverview } from '../../modules/commerce/customers/application/customer-control.service.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import type {
  AccountTransferPlan,
  AccountTransferResult,
} from '../../modules/commerce/customers/application/customer-account-transfer.service.js';

/**
 * Customer 360 over HTTP (spec §11), under `/users/:id/…` like every per-customer route.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls a service that
 * charges its own permission through the guard — `users.channel_membership.exempt`,
 * `users.phone.verify`, `users.location.edit`, `users.notifications.edit`, `users.transfer`,
 * `orders.manual.create`, `services.edit`, `audit.view` — so no control is protected merely
 * by the Web Admin not drawing it. Every write carries its idempotency key in the body and
 * is refused from an origin the installation does not list.
 */
@Controller(`${API_PREFIX}`)
export class Customer360Controller {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('users/:id/overview')
  async overview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<{ overview: CustomerOverviewResponse }> {
    const { scope, actor } = await this.authenticate(request);
    return {
      overview: toOverview(await this.container.customerControls.overview(scope, actor, id)),
    };
  }

  @Post('users/:id/channel-exemption')
  async channelExemption(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ overview: CustomerOverviewResponse; changed: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerChannelExemptionRequestSchema.parse(body);
    const result = await this.container.customerControls.setChannelExemption(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      exempt: command.exempt,
      reason: command.reason,
    });
    return { overview: toOverview(result.overview), changed: result.changed };
  }

  @Post('users/:id/phone')
  async phone(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ overview: CustomerOverviewResponse; changed: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerPhoneVerificationRequestSchema.parse(body);
    const result = await this.container.customerControls.setVerifiedPhone(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      phoneNumber: command.phoneNumber,
      reason: command.reason,
    });
    return { overview: toOverview(result.overview), changed: result.changed };
  }

  @Post('users/:id/location-override')
  async locationOverride(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ overview: CustomerOverviewResponse; changed: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerLocationOverrideRequestSchema.parse(body);
    const result = await this.container.customerControls.setLocationOverride(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      limits: command.limits,
      reason: command.reason,
    });
    return { overview: toOverview(result.overview), changed: result.changed };
  }

  @Post('users/:id/notifications')
  async notifications(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ overview: CustomerOverviewResponse; changed: boolean }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerNotificationsRequestSchema.parse(body);
    const result = await this.container.customerControls.setMarketingPreference(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      optedOut: command.marketingOptedOut,
      reason: command.reason,
    });
    return { overview: toOverview(result.overview), changed: result.changed };
  }

  @Post('users/:id/services/toggle')
  async servicesToggle(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerServicesToggleResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerServicesToggleRequestSchema.parse(body);
    const results = await this.container.customerServicesToggle.toggle(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      action: command.action,
    });
    return { action: command.action, results: [...results] };
  }

  /** A read, through POST only because the destination id travels in the body. */
  @Post('users/:id/transfer/preview')
  async transferPreview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ preview: CustomerTransferPreviewResponse }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTransferPreviewRequestSchema.parse(body);
    const plan = await this.container.customerAccountTransfers.preview(scope, actor, {
      sourceId: id,
      destinationTelegramUserId: command.destinationTelegramUserId,
    });
    return { preview: toPreview(plan) };
  }

  @Post('users/:id/transfer')
  async transfer(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ transfer: CustomerTransferResultResponse }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerTransferRequestSchema.parse(body);
    const result = await this.container.customerAccountTransfers.transfer(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      sourceId: id,
      destinationTelegramUserId: command.destinationTelegramUserId,
      fingerprint: command.fingerprint,
      confirmTelegramUserId: command.confirmTelegramUserId,
      reason: command.reason,
    });
    return { transfer: toTransfer(result) };
  }

  @Post('users/:id/manual-order')
  async manualOrder(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerManualOrderResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = customerManualOrderRequestSchema.parse(body);
    const { order, payment } = await this.container.manualOrders.place(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      customerId: id,
      productId: command.productId,
      username: command.username,
      reason: command.reason,
    });
    return {
      orderId: order.id,
      paymentId: payment.id,
      totalAmount: order.totals.total.amountMinor.toString(),
      currency: order.totals.currency,
    };
  }

  @Get('users/:id/financial-summary')
  async financialSummary(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<{ summary: CustomerFinancialSummaryResponse }> {
    const { scope, actor } = await this.authenticate(request);
    const summary = await this.container.customerInsights.financialSummary(scope, actor, id);
    const perCurrency = (
      rows: readonly { currency: string; count: number; amount: bigint }[],
    ): { currency: CurrencyCode; count: number; amount: string }[] =>
      rows.map((row) => ({
        currency: row.currency as CurrencyCode,
        count: row.count,
        amount: row.amount.toString(),
      }));
    return {
      summary: {
        orders:
          summary.orders === null
            ? null
            : {
                purchases: perCurrency(summary.orders.purchases),
                discounts: perCurrency(summary.orders.discounts),
                refunded: perCurrency(summary.orders.refunded),
                awaitingPayment: summary.orders.awaitingPayment,
                orderCount: summary.orders.orderCount,
              },
        payments:
          summary.payments === null
            ? null
            : {
                confirmed: perCurrency(summary.payments.confirmed),
                pending: summary.payments.pending,
                paymentCount: summary.payments.paymentCount,
              },
        ledger:
          summary.ledger === null
            ? null
            : summary.ledger.map((row) => ({
                reason: row.reason as LedgerReason,
                direction: row.direction as LedgerDirection,
                currency: row.currency as CurrencyCode,
                count: row.count,
                amount: row.total.toString(),
              })),
        services:
          summary.services === null
            ? null
            : {
                byState: [...summary.services.byState],
                serviceCount: summary.services.serviceCount,
              },
        denied: [...summary.denied],
      },
    };
  }

  @Get('users/:id/timeline')
  async timeline(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<CustomerTimelineResponse> {
    const { scope, actor } = await this.authenticate(request);
    const rows = await this.container.customerInsights.timeline(scope, actor, id);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorType: row.actorType,
        actorLabel: row.actorLabel,
        surface: row.surface,
        result: row.result,
        occurredAt: row.occurredAt.toISOString(),
        reason: row.reason,
        before: row.before === null ? null : { ...row.before },
        after: row.after === null ? null : { ...row.after },
      })),
    };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      // A customer belongs to the TENANT, not to a bot: see `CustomersController`.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

function toOverview(overview: CustomerOverview): CustomerOverviewResponse {
  const { customer, locationOverride } = overview;
  return {
    customerId: customer.id,
    channelMembershipExemptAt: customer.channelMembershipExemptAt?.toISOString() ?? null,
    phone:
      customer.phoneNumber === null || customer.phoneVerifiedAt === null
        ? null
        : { number: customer.phoneNumber, verifiedAt: customer.phoneVerifiedAt.toISOString() },
    locationOverride:
      locationOverride === null
        ? null
        : { ...locationOverride.limits, setAt: locationOverride.setAt.toISOString() },
    marketingOptOutAt: customer.marketingOptOutAt?.toISOString() ?? null,
    terms: { available: false },
  };
}

function party(customer: CustomerRecord) {
  return {
    id: customer.id,
    telegramUserId: customer.telegramUserId,
    username: customer.username,
    firstName: customer.firstName,
    lastName: customer.lastName,
    status: customer.status,
  };
}

function toPreview(plan: AccountTransferPlan): CustomerTransferPreviewResponse {
  return {
    source: party(plan.source),
    destination: plan.destination === null ? null : party(plan.destination),
    moves: {
      services: plan.moves.services.map((service) => ({
        id: service.id,
        providerUsername: service.providerUsername,
        state: service.state,
        expiresAt: service.expiresAt?.toISOString() ?? null,
      })),
      walletAmount: plan.moves.walletAmount.toString(),
      currency: plan.moves.currency,
    },
    stays: { ...plan.stays },
    blockers: [...plan.blockers],
    warnings: [...plan.warnings],
    fingerprint: plan.fingerprint,
  };
}

function toTransfer(result: AccountTransferResult): CustomerTransferResultResponse {
  return {
    transferId: result.transfer.id,
    fromCustomerId: result.transfer.fromCustomerId,
    toCustomerId: result.transfer.toCustomerId,
    servicesMoved: result.transfer.serviceIds.length,
    walletMovedAmount: result.transfer.walletAmount.toString(),
    currency: result.transfer.currency,
    createdAt: result.transfer.createdAt.toISOString(),
    replayed: result.replayed,
  };
}
