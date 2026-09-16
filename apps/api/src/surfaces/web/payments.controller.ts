import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  PAYMENT_ROUTES,
  confirmPaymentRequestSchema,
  rejectPaymentRequestSchema,
  paymentListQuerySchema,
  type OrderId,
  type PaymentDetailResponse,
  type PaymentId,
  type PaymentListResponse,
  type PaymentResponse,
  type PaymentSummaryResponse,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  PaymentCursor,
  PaymentRecord,
} from '../../modules/commerce/payments/application/ports.js';

/**
 * Payments over HTTP, at `/payments`. Two reads and TWO writes.
 *
 * The writes are the two halves of one decision — a confirmation and a rejection —
 * which is what `receipts.review` has said since the permission catalogue was frozen
 * and what this controller could do half of until 4G. Each carries a NOTE and nothing
 * else. There is no amount on either route, no currency, no customer and no order: a
 * confirmation records that money the payment already names arrived, and an operator
 * able to restate the figure at approval time is an operator able to approve a
 * different payment from the one the customer made. `confirmPaymentRequestSchema` has
 * no such field, `PaymentRepository.confirm` takes no such parameter, and
 * `nexa_payments_confirmation_guard` would refuse the write.
 *
 * A rejection is the mirror and moves nothing: no money, and not the ORDER, which stays
 * awaiting payment until its own deadline so the customer may pay another way inside
 * the window they were given.
 *
 * What is deliberately absent: no `POST /payments` (a payment is created by a customer
 * choosing how to pay, never by an operator typing one), no cancel (a withdrawal is the
 * CUSTOMER's act and arrives through the bot, not through an operator's browser), no
 * un-reject, no refund and no retry. `payments.retry` exists as a permission for a
 * gateway that does not ship; a retry button with nothing behind it is the legacy
 * silent-success pattern.
 *
 * Authentication happens here; AUTHORIZATION does not — `PaymentService` charges
 * `payments.view` and `receipts.review` itself.
 */
@Controller(`${API_PREFIX}`)
export class PaymentsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PAYMENT_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<PaymentListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string — the guard every list here uses.
    const query = singleValued(raw);
    const page = paymentListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
      ...(query.reference === undefined ? {} : { reference: query.reference }),
    });
    const result = await this.container.payments.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: paymentCursorFrom(page.cursor) }),
      search: {
        ...(page.state === undefined ? {} : { state: page.state }),
        ...(page.method === undefined ? {} : { method: page.method }),
        ...(page.customerId === undefined ? {} : { customerId: page.customerId as UserId }),
        ...(page.orderId === undefined ? {} : { orderId: page.orderId as OrderId }),
        ...(page.reference === undefined ? {} : { reference: page.reference }),
      },
    });
    return {
      // The LIST omits `evidenceNote`: it is an operator's own text about somebody's
      // bank transfer, and it is returned only on the detail, behind the same
      // permission. A list is the thing most likely to end up on a shared screen.
      payments: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Get('payments/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<PaymentResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { payment: toDetail(await this.container.payments.get(scope, actor, id)) };
  }

  @Post('payments/:id/confirm')
  async confirm(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = confirmPaymentRequestSchema.parse(body);
    const { payment } = await this.container.payments.confirmManualTransfer(scope, actor, id, {
      idempotencyKey: input.idempotencyKey,
      note: input.evidenceNote,
    });
    return { payment: toDetail(payment) };
  }

  @Post('payments/:id/reject')
  async reject(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PaymentResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = rejectPaymentRequestSchema.parse(body);
    const payment = await this.container.payments.rejectManualTransfer(scope, actor, id, {
      idempotencyKey: input.idempotencyKey,
      note: input.resolutionNote,
    });
    return { payment: toDetail(payment) };
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

function paymentCursorFrom(raw: string): PaymentCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as PaymentId };
}

function toSummary(record: PaymentRecord): PaymentSummaryResponse {
  return {
    id: record.id,
    customerId: record.customerId,
    orderId: record.orderId,
    state: record.state,
    method: record.method,
    // Text on the wire: JSON has one number type and a minor-unit amount passes 2^53.
    amount: record.amount.amountMinor.toString(),
    currency: record.amount.currency,
    reference: record.reference,
    evidenceKind: record.evidenceKind,
    confirmedAt: record.confirmedAt === null ? null : record.confirmedAt.toISOString(),
    confirmedByAdminId: record.confirmedByAdminId,
    resolvedAt: record.resolvedAt === null ? null : record.resolvedAt.toISOString(),
    resolvedByAdminId: record.resolvedByAdminId,
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toDetail(record: PaymentRecord): PaymentDetailResponse {
  return {
    ...toSummary(record),
    evidenceNote: record.evidenceNote,
    resolutionNote: record.resolutionNote,
  };
}
