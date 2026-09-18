import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  REFUND_ROUTES,
  refundCompletionSchema,
  refundFailureSchema,
  refundRequestSchema,
  type RefundListResponse,
  type RefundResponse,
  type RefundView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { RefundRecord } from '../../modules/commerce/payments/application/refund-ports.js';

/**
 * Refunds over HTTP: one read under a payment, and three writes.
 *
 * The read hangs off the payment because a refund is only ever meaningful beside the
 * thing it reverses — and because the refundable amount is a fact about a PAYMENT, not
 * about any one refund. The two completion routes are keyed by refund id instead, since
 * completing is an act on that row.
 *
 * `completion` and `failure` are separate endpoints rather than one state PATCH. They are
 * opposite statements about whether money left, they carry different evidence, and a
 * single endpoint taking a target state would make "who said the transfer happened"
 * answerable only by reading a payload. The same reason the accounts controller splits
 * its two writes.
 *
 * Nothing here decides an amount. The body proposes one; `RefundService` derives the
 * bound inside its transaction under a lock on the payment, and a proposal above it is
 * refused with the server's own figure.
 *
 * Authentication happens here; AUTHORIZATION does not — `RefundService` charges
 * `refunds.view` and `refunds.issue` itself.
 */
@Controller(`${API_PREFIX}`)
export class RefundsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(REFUND_ROUTES.list(':paymentId'))
  async list(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
  ): Promise<RefundListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const view = await this.container.refunds.ledgerFor(scope, actor, paymentId as never);
    return {
      refunds: view.refunds.map(toView),
      paidMinor: view.paid.amountMinor.toString(),
      consumedMinor: view.consumedMinor.toString(),
      refundableMinor: view.refundableMinor.toString(),
      currency: view.paid.currency,
      refundable: view.refundable,
    };
  }

  @Post(REFUND_ROUTES.request(':paymentId'))
  async requestRefund(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ): Promise<RefundResponse> {
    const { scope, actor } = await this.authenticate(request);
    /*
     * The path is authoritative for the payment, and the body's own `paymentId` is
     * ignored rather than trusted or cross-checked.
     *
     * The schema carries it because the same shape is what a non-HTTP caller submits.
     * Here the URL is what the operator navigated to and what the permission was checked
     * against, so preferring the body would let a request authorised against one payment
     * name another — the shape of every path-versus-body confusion in the research.
     */
    const input = refundRequestSchema.parse({ ...(body as object), paymentId });
    const refund = await this.container.refunds.request(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      paymentId,
      amountMinor: BigInt(input.amountMinor),
      reason: input.reason,
    });
    return { refund: toView(refund) };
  }

  @Post(REFUND_ROUTES.complete(':refundId'))
  async complete(
    @Req() request: FastifyRequest,
    @Param('refundId') refundId: string,
    @Body() body: unknown,
  ): Promise<RefundResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = refundCompletionSchema.parse(body);
    const refund = await this.container.refunds.complete(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      refundId,
      note: input.note,
      externalReference: input.externalReference,
    });
    return { refund: toView(refund) };
  }

  @Post(REFUND_ROUTES.fail(':refundId'))
  async fail(
    @Req() request: FastifyRequest,
    @Param('refundId') refundId: string,
    @Body() body: unknown,
  ): Promise<RefundResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = refundFailureSchema.parse(body);
    const refund = await this.container.refunds.fail(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      refundId,
      note: input.note,
    });
    return { refund: toView(refund) };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
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

/**
 * The wire shape.
 *
 * `amountMinor` is a decimal string for the reason every money field on this seam is:
 * JSON has no bigint and a `number` is the float the money model refuses, silently,
 * above 2^53.
 *
 * Every actor and timestamp travels, because a refund read on its own has to answer who
 * decided it and who said the money left. That is the field `/admin/logs` did not have.
 */
function toView(refund: RefundRecord): RefundView {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    orderId: refund.orderId,
    customerId: refund.customerId,
    state: refund.state,
    channel: refund.channel,
    amountMinor: refund.amount.amountMinor.toString(),
    currency: refund.amount.currency,
    reason: refund.reason,
    requestedByAdminId: refund.requestedByAdminId,
    completedByAdminId: refund.completedByAdminId,
    externalReference: refund.externalReference,
    completionNote: refund.completionNote,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
    completedAt: refund.completedAt === null ? null : refund.completedAt.toISOString(),
  };
}
