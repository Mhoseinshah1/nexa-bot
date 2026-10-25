import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ERROR_CODES,
  MINIAPP_ROUTES,
  errors,
  miniAppCursorQuerySchema,
  miniAppReceiptRequestSchema,
  orderCodeOf,
  paymentTrackingCode,
  type MiniAppGatewayAttempt,
  type MiniAppPaymentList,
  type MiniAppPaymentStatus,
  type PaymentId,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { PaymentCursor } from '../../modules/commerce/payments/application/ports.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../web/keyset-cursor.js';
import { miniAppCall, miniAppKey, notFound, owned, parseWith } from './miniapp-request.js';
import { attemptWire, wire } from './projections.js';

/**
 * A customer's own payments (Round 9, C5): the status of one, the "I paid" claim, the
 * receipt upload, a gateway's check, and the history list. Every read is the customer's own
 * by id AND owner; another customer's payment is the same "not found" as a missing one.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppPaymentsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /**
   * What the customer may know about their payment, from reads the bot already makes: the
   * payment's own state, the gateway attempt, whether a receipt was filed, and the order.
   * There is no timeline: an outcome reaches the customer through the bot's notifications.
   */
  @Get(MINIAPP_ROUTES.payment)
  async status(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
  ): Promise<MiniAppPaymentStatus> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { scope, customer } = call.context;
    const payment = await owned(() =>
      this.container.payments.paymentForCustomer(scope, call.actor, customer.id, paymentId),
    );
    const attempt =
      payment.method === 'GATEWAY'
        ? await this.container.gatewayPayments.attemptFor(scope, customer.id, payment.id)
        : null;
    const receiptFiled =
      payment.method === 'MANUAL_TRANSFER'
        ? await this.container.receipts.filedForCustomer(
            scope,
            call.actor,
            customer.id,
            payment.id as PaymentId,
          )
        : false;
    const order =
      payment.orderId === null
        ? null
        : await this.container.orders.orderForCustomer(scope, call.actor, {
            customerId: customer.id,
            orderId: payment.orderId,
          });
    return {
      paymentId: payment.id,
      method: payment.method,
      state: payment.state,
      transferPending: payment.method === 'MANUAL_TRANSFER' && payment.state === 'PENDING',
      receiptFiled,
      gateway: attempt === null ? null : attemptWire(attempt),
      order:
        order === null
          ? null
          : {
              id: order.id,
              code: orderCodeOf(order) ?? '',
              state: order.state,
              title: order.line.title,
            },
    };
  }

  /**
   * «پرداخت را انجام دادم»: the claim is recorded and the receipt window opened, exactly the
   * bot's tap. The window belongs to THIS bot and this customer, as the bot's does.
   */
  @Post(MINIAPP_ROUTES.paymentTransferSent)
  async transferSent(@Req() request: FastifyRequest, @Param('paymentId') paymentId: string) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { scope, customer } = call.context;
    const pending = await owned(() =>
      this.container.payments.pendingTransferForCustomer(scope, customer.id, paymentId),
    );
    const { payment, receiptWindow } = await this.container.payments.signalTransferSent(
      scope,
      call.actor,
      customer.id,
      {
        idempotencyKey: `${miniAppKey(request, call, 'transfer-sent')}:pay-sent`,
        paymentId: pending.id,
        botInstanceId: call.context.botInstanceId,
      },
    );
    return {
      receiptWindowMinutes: receiptWindow?.minutes ?? null,
      reference: paymentTrackingCode(payment),
    };
  }

  /**
   * The receipt image, uploaded here (owner correction 2026-10-25) and filed by the bot's
   * own receipt service. See `MiniAppReceiptService` for the order of the checks.
   */
  @Post(MINIAPP_ROUTES.paymentReceipt)
  async receipt(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ) {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppReceiptRequestSchema, body);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.imageBase64) || input.imageBase64.length % 4 !== 0) {
      throw errors.validation(MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_REFUSED, 'Not base64.', {
        reason: 'NOT_AN_IMAGE',
      });
    }
    const bytes = new Uint8Array(Buffer.from(input.imageBase64, 'base64'));
    return this.container.miniApp.receipts.submit(call.context, call.actor, {
      paymentId,
      bytes,
      declaredMimeType: input.mimeType,
      idempotencyKey: miniAppKey(request, call, 'receipt'),
    });
  }

  /** A gateway's check button: brings the next inquiry forward; the worker asks the provider. */
  @Post(MINIAPP_ROUTES.paymentCheck)
  async check(
    @Req() request: FastifyRequest,
    @Param('paymentId') paymentId: string,
  ): Promise<MiniAppGatewayAttempt> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const view = await this.container.gatewayPayments.attemptFor(
      call.context.scope,
      call.context.customer.id,
      paymentId,
    );
    if (view === null) throw notFound();
    await this.container.gatewayPayments.requestCheck(call.context.scope, view);
    return attemptWire(view);
  }

  /** The customer's own payments, newest first (owner correction 2026-10-25). Read-only. */
  @Get(MINIAPP_ROUTES.payments)
  async list(@Req() request: FastifyRequest, @Query() query: unknown): Promise<MiniAppPaymentList> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { cursor } = parseWith(miniAppCursorQuerySchema, query);
    const page = await this.container.payments.historyForCustomer(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      { cursor: cursor === undefined ? null : (decodeKeysetCursor(cursor) as PaymentCursor) },
    );
    return {
      items: page.items.map((payment) => ({
        id: payment.id,
        code: payment.code,
        method: payment.method,
        state: payment.state,
        amount: wire(payment.amount),
        provider: payment.gatewayProvider,
        topup: payment.orderId === null,
        createdAt: payment.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor === null ? null : encodeKeysetCursor(page.nextCursor),
    };
  }
}
