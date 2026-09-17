import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  COMMERCE_ERROR_CODES,
  PAYMENT_ROUTES,
  confirmPaymentRequestSchema,
  errors,
  paymentIdSchema,
  paymentReceiptIdSchema,
  rejectPaymentRequestSchema,
  paymentListQuerySchema,
  type OrderId,
  type PaymentDestinationView,
  type PaymentDetailResponse,
  type PaymentId,
  type PaymentListResponse,
  type PaymentReceiptListResponse,
  type PaymentReceiptView,
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
import type { PaymentDestinationRecord } from '../../modules/commerce/payments/application/account-ports.js';
import type { PaymentReceiptRecord } from '../../modules/commerce/payments/application/receipt-ports.js';

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
    const [payment, destination] = await Promise.all([
      this.container.payments.get(scope, actor, id),
      this.container.payments.destinationFor(scope, actor, id),
    ]);
    return { payment: toDetail(payment, destination) };
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
    return {
      payment: toDetail(payment, await this.container.payments.destinationFor(scope, actor, id)),
    };
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
    return {
      payment: toDetail(payment, await this.container.payments.destinationFor(scope, actor, id)),
    };
  }

  /**
   * What the customer sent against one payment. Under `receipts.view`.
   *
   * Its own permission rather than `payments.view`, which is what lets the seeded
   * `receipt_reviewer` role read the evidence without holding anything that decides.
   * The records carry `fileId` and this projects it away — `toReceiptView` is the only
   * place a receipt becomes something a browser may hold.
   */
  @Get('payments/:id/receipts')
  async receipts(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<PaymentReceiptListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const records = await this.container.receipts.listForPayment(
      scope,
      actor,
      paymentIdSchema.parse(id),
    );
    return { receipts: records.map(toReceiptView) };
  }

  /**
   * The BYTES of one receipt, fetched by this process with this installation's own bot.
   *
   * Two locks on the identifier, and the second is the one that matters: the receipt is
   * read tenant-scoped, and the payment named on it is read too — so a receipt id from
   * another tenant is a not-found rather than a file. `@Res()` rather than a returned
   * value for the reason the archive download states, and because a returned `Buffer`
   * would be JSON-serialised.
   *
   * `content-disposition: attachment` and `nosniff`, deliberately. A receipt is a file a
   * customer uploaded; rendering it inline in the admin origin would make an SVG or an
   * HTML document sent as a "receipt" a script running on the admin page. The reviewer
   * opens it in their own viewer instead.
   *
   * The payment id is in the path AND checked against the row, so a reviewer cannot
   * reach a receipt by pairing it with a payment they can see.
   */
  @Get('payments/:paymentId/receipts/:receiptId/content')
  async receiptContent(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('paymentId') paymentId: string,
    @Param('receiptId') receiptId: string,
  ): Promise<void> {
    const { scope, actor } = await this.authenticate(request);
    const { receipt } = await this.container.receipts.findForDownload(
      scope,
      actor,
      paymentReceiptIdSchema.parse(receiptId),
    );
    if (receipt.paymentId !== paymentIdSchema.parse(paymentId)) {
      throw errors.notFound(COMMERCE_ERROR_CODES.RECEIPT_NOT_FOUND, 'Unknown receipt.');
    }

    const fetched = await this.container.receiptFiles.download(scope, receipt);
    if (fetched.outcome !== 'SUCCEEDED') {
      /*
       * The honest answer, and the reason `RECEIPT_UNAVAILABLE` exists: the row is
       * intact and the bytes are not reachable. A 404 would tell the reviewer the
       * receipt does not exist, and an empty 200 would show them a blank frame.
       */
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.RECEIPT_UNAVAILABLE,
        'This receipt can no longer be fetched from Telegram.',
      );
    }

    await reply
      /*
       * `application/octet-stream` whatever Telegram or the customer declared. A
       * `mime_type` on a document is a string the UPLOADER chose, and echoing it would
       * let a customer pick the content type the admin origin serves.
       */
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      // The filename is the receipt's UUID, so it carries no quote, newline or
      // semicolon — which is what makes this header safe to assemble.
      .header('content-disposition', `attachment; filename="${receipt.id}"`)
      .header('content-length', String(fetched.bytes.byteLength))
      // A customer's bank receipt must not sit in a proxy or a browser cache.
      .header('cache-control', 'no-store')
      .send(Buffer.from(fetched.bytes));
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
    customerSignalledAt:
      record.customerSignalledAt === null ? null : record.customerSignalledAt.toISOString(),
    expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** A receipt record, minus the one field a browser may not hold. */
function toReceiptView(record: PaymentReceiptRecord): PaymentReceiptView {
  return {
    id: record.id,
    kind: record.kind,
    fileUniqueId: record.fileUniqueId,
    mimeType: record.mimeType,
    /*
     * `Number` is safe here and nowhere near the money rule: a receipt is bounded by
     * `PAYMENT_RECEIPT_MAX_BYTES`, twenty megabytes, which is many orders of magnitude
     * below the 2^53 that makes an amount a string on the wire.
     */
    fileSize: record.fileSize === null ? null : Number(record.fileSize),
    fileName: record.fileName,
    createdAt: record.createdAt.toISOString(),
  };
}

function toDetail(
  record: PaymentRecord,
  destination: PaymentDestinationRecord | null,
): PaymentDetailResponse {
  return {
    ...toSummary(record),
    evidenceNote: record.evidenceNote,
    resolutionNote: record.resolutionNote,
    destination: destination === null ? null : toDestinationView(destination),
  };
}

/**
 * The snapshot, projected for a browser.
 *
 * FOUR digits, never sixteen, and no Sheba — `paymentDestinationViewSchema` states the
 * reason and this is where it is enforced. `slice(-4)` is safe because both the contract
 * and two CHECK constraints keep `card_number` at exactly sixteen digits.
 */
function toDestinationView(destination: PaymentDestinationRecord): PaymentDestinationView {
  return {
    accountId: destination.accountId,
    label: destination.label,
    bankName: destination.bankName,
    holderName: destination.holderName,
    cardLast4: destination.cardNumber.slice(-4),
    hasIban: destination.iban !== null,
  };
}
