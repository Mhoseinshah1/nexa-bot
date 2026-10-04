import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SERVICE_REFUND_REQUEST_PAGE_MAX,
  SERVICE_REFUND_REQUEST_ROUTES,
  routePattern,
  serviceRefundApproveRequestSchema,
  serviceRefundRejectRequestSchema,
  SERVICE_REFUND_REQUEST_ATTENTION_STATES,
  serviceRefundRequestListQuerySchema,
  serviceDeleteWithRefundRequestSchema,
  uuidV7Schema,
  type Money,
  type ServiceDeleteRefundQuote,
  type ServiceRefundRequestListResponse,
  type ServiceRefundRequestResponse,
  type ServiceRefundRequestView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ServiceRefundRequestListItem,
  ServiceRefundRequestRecord,
} from '../../modules/commerce/payments/application/service-refund-request-ports.js';

/**
 * Customers' service refund requests over HTTP (WP19): the smallest durable fallback the
 * brief asks for (§2.10) — the open requests are discoverable here whatever happened to the
 * Telegram review card — and the same two decisions the card offers.
 *
 * Nothing here decides anything. `ServiceRefundRequestService` charges `refunds.view` for a
 * read and `refunds.issue` AND `services.terminate` for a decision, inside its transaction;
 * the approval re-decides eligibility and the bound under the payment's lock. The body's
 * `confirm: true` is the one destructive confirmation, required by the schema itself.
 */
@Controller(`${API_PREFIX}`)
export class ServiceRefundRequestsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(SERVICE_REFUND_REQUEST_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ServiceRefundRequestListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = serviceRefundRequestListQuerySchema.parse(query ?? {});
    const limit = input.limit ?? SERVICE_REFUND_REQUEST_PAGE_MAX;
    // One row past the page, so "there is another page" is read, never guessed from a full one.
    const items = await this.container.serviceRefundRequests.list(scope, actor, {
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.attention === 'true' ? { states: SERVICE_REFUND_REQUEST_ATTENTION_STATES } : {}),
      ...(input.before === undefined || input.beforeId === undefined
        ? {}
        : { before: { at: new Date(input.before), id: input.beforeId } }),
      limit: limit + 1,
    });
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      requests: page.map(toView),
      nextCursor:
        items.length > limit && last !== undefined
          ? { at: last.request.createdAt.toISOString(), id: last.request.id }
          : null,
    };
  }

  @Get(routePattern(SERVICE_REFUND_REQUEST_ROUTES.forService, 'serviceId'))
  async forService(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<ServiceRefundRequestListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const items = await this.container.serviceRefundRequests.list(scope, actor, {
      serviceId: uuidV7Schema.parse(serviceId),
      limit: SERVICE_REFUND_REQUEST_PAGE_MAX,
    });
    // Not paged. A service has at most one active request, and it is always the service's
    // newest row — another cannot be filed while it stands — so the first page holds it.
    return { requests: items.map(toView), nextCursor: null };
  }

  @Post(routePattern(SERVICE_REFUND_REQUEST_ROUTES.approve, 'requestId'))
  async approve(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ServiceRefundRequestResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = serviceRefundApproveRequestSchema.parse(body);
    const approved = await this.container.serviceRefundRequests.approve(scope, actor, {
      requestId: uuidV7Schema.parse(requestId),
      amountMinor: BigInt(input.amountMinor),
      idempotencyKey: input.idempotencyKey,
    });
    return { request: await this.viewOf(scope, actor, approved) };
  }

  @Post(routePattern(SERVICE_REFUND_REQUEST_ROUTES.reject, 'requestId'))
  async reject(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ServiceRefundRequestResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = serviceRefundRejectRequestSchema.parse(body);
    const rejected = await this.container.serviceRefundRequests.reject(scope, actor, {
      requestId: uuidV7Schema.parse(requestId),
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    return { request: await this.viewOf(scope, actor, rejected) };
  }

  /**
   * Item 11: what the «حذف سرویس و بازگشت وجه» summary shows — the customer whose wallet is
   * credited and the bound, read now. Both decision keys, like the command.
   */
  @Get(routePattern(SERVICE_REFUND_REQUEST_ROUTES.deleteWithRefund, 'serviceId'))
  async deleteWithRefundQuote(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<ServiceDeleteRefundQuote> {
    const { scope, actor } = await this.authenticate(request);
    const quote = await this.container.serviceRefundRequests.quoteDeleteWithRefund(
      scope,
      actor,
      serviceId,
    );
    const customer = quote.customer;
    const name = [customer?.firstName ?? null, customer?.lastName ?? null]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join(' ');
    const source = quote.eligibility.eligible ? quote.eligibility.source : null;
    return {
      serviceId: quote.service.id,
      serviceUsername: quote.service.providerUsername,
      customerId: quote.service.customerId,
      customerTelegramUserId: customer?.telegramUserId ?? null,
      customerUsername: customer?.username ?? null,
      customerDisplayName: name === '' ? null : name,
      eligible: quote.eligibility.eligible,
      reason: quote.eligibility.eligible ? null : quote.eligibility.reason,
      principalMinor: source?.payment.amount.amountMinor.toString() ?? null,
      remainingMinor: source?.remaining.amountMinor.toString() ?? null,
      currency: source?.payment.amount.currency ?? null,
      paymentId: source?.payment.id ?? null,
    };
  }

  /**
   * Item 11: delete the service, and credit the amount to the customer's wallet once the
   * deletion is confirmed. The answer is the request as it stands — EXECUTING, never "done":
   * the credit waits for the provisioner's deletion and the sweep after it.
   */
  @Post(routePattern(SERVICE_REFUND_REQUEST_ROUTES.deleteWithRefund, 'serviceId'))
  async deleteWithRefund(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<ServiceRefundRequestResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const input = serviceDeleteWithRefundRequestSchema.parse(body);
    const created = await this.container.serviceRefundRequests.deleteWithRefund(scope, actor, {
      serviceId: uuidV7Schema.parse(serviceId),
      amountMinor: BigInt(input.amountMinor),
      idempotencyKey: input.idempotencyKey,
    });
    return { request: await this.viewOf(scope, actor, created) };
  }

  /**
   * The decided row, as the list renders it — read under the decision keys the decider
   * already holds, never `refunds.view`: the decision has committed by now.
   */
  private async viewOf(
    scope: TenantContext,
    actor: ReturnType<typeof adminActor>,
    record: ServiceRefundRequestRecord,
  ): Promise<ServiceRefundRequestView> {
    const found = await this.container.serviceRefundRequests.decidedView(scope, actor, record);
    /* istanbul ignore next -- the row was just written in this tenant. */
    if (found === null) {
      return toView({
        request: record,
        serviceUsername: null,
        customerTelegramUserId: null,
        customerUsername: null,
        operationState: null,
        remaining: record.principal,
      });
    }
    return toView(found);
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    // Item 11's write is cookie-authenticated and destructive: only from a configured origin.
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}

/** The wire shape. Money as decimal strings of minor units, as on every money field here. */
function toView(
  item: ServiceRefundRequestListItem & { readonly remaining: Money },
): ServiceRefundRequestView {
  const request = item.request;
  return {
    id: request.id,
    serviceId: request.serviceId,
    serviceUsername: item.serviceUsername,
    customerId: request.customerId,
    customerTelegramUserId: item.customerTelegramUserId,
    customerUsername: item.customerUsername,
    paymentId: request.paymentId,
    orderId: request.orderId,
    state: request.state,
    origin: request.origin,
    reason: request.reason,
    principalMinor: request.principal.amountMinor.toString(),
    remainingMinor: item.remaining.amountMinor.toString(),
    currency: request.principal.currency,
    approvedAmountMinor: request.approvedAmount?.amountMinor.toString() ?? null,
    refundId: request.refundId,
    operationId: request.operationId,
    operationState: item.operationState,
    decidedByAdminId: request.decidedByAdminId,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    failureKind: request.failureKind,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
  };
}
