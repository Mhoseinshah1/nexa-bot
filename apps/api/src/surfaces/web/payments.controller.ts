import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  COMMERCE_ERROR_CODES,
  COMPENSATION_ROUTES,
  PAYMENT_ROUTES,
  compensationListQuerySchema,
  errors,
  paymentIdSchema,
  paymentReceiptIdSchema,
  paymentListQuerySchema,
  type CompensationListResponse,
  type CompensationView,
  type OrderId,
  type PaymentDestinationView,
  type PaymentDetailResponse,
  type PaymentId,
  type PaymentListResponse,
  type PaymentReceiptListResponse,
  type PaymentReceiptView,
  type PaymentResponse,
  type PaymentSummaryResponse,
  type PaymentTimelineResponse,
  type ReceiptCreditView,
  type ReceiptDisposition,
  type RefundId,
  type TenantContext,
  type UserId,
  type GatewayInvoiceView,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  PaymentCursor,
  PaymentCustomerIdentity,
  PaymentRecord,
} from '../../modules/commerce/payments/application/ports.js';
import type { ReceiptCreditRecord } from '../../modules/commerce/payments/application/receipt-credit-ports.js';
import type {
  CompensationCursor,
  CompensationRecord,
} from '../../modules/commerce/payments/application/refund-ports.js';
import type { PaymentDestinationRecord } from '../../modules/commerce/payments/application/account-ports.js';
import type { PaymentReceiptRecord } from '../../modules/commerce/payments/application/receipt-ports.js';
import type { GatewayInvoiceRecord } from '../../modules/commerce/payments/application/gateway-invoice-ports.js';

/**
 * Payments over HTTP, at `/payments`, and the compensation list at `/compensations`.
 * READS ONLY.
 *
 * Payment File 02 §10 is the rule: card-to-card review happens in Telegram, and the Web
 * Admin is read-only for it. So the two writes this controller used to carry — the
 * confirmation and the rejection — are removed, with their contract routes, rather than
 * hidden: a route that exists is a route a client can call (D3). The Telegram panel
 * calls the same `PaymentService` and `ReceiptDispositionService` the routes did.
 *
 * What stays is every read: the list with File 02 §21's diagnostic columns, the
 * current-state detail, its read-only timeline (WP17), the receipts' metadata and their bytes — which is
 * not a mutation, and which §10 says only "does not need to be" shown — and the
 * compensations. Operator refunds are not receipt review and live on their own
 * controller, unchanged.
 *
 * Authentication happens here; AUTHORIZATION does not — the services charge
 * `payments.view` and `receipts.view` themselves.
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
      ...(query.disposition === undefined ? {} : { disposition: query.disposition }),
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
        ...(page.disposition === undefined ? {} : { disposition: page.disposition }),
      },
    });
    // Who paid, as Telegram knows them — one read for the page (D7).
    const identities = await this.container.payments.customerIdentities(scope, actor, result.items);
    // How each receipt left review (WP10 follow-up §5): a credited FAILED is not a rejection.
    const dispositions = await this.container.payments.receiptDispositions(
      scope,
      actor,
      result.items,
    );
    return {
      // The LIST omits `evidenceNote`: it is an operator's own text about somebody's
      // bank transfer, and it is returned only on the detail, behind the same
      // permission. A list is the thing most likely to end up on a shared screen.
      payments: result.items.map((record) =>
        toSummary(record, identities.get(record.customerId), dispositions.get(record.id) ?? null),
      ),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Get('payments/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<PaymentResponse> {
    const { scope, actor } = await this.authenticate(request);
    const [payment, destination, credit] = await Promise.all([
      this.container.payments.get(scope, actor, id),
      this.container.payments.destinationFor(scope, actor, id),
      // The receipt's credit-to-wallet disposition, when that is how it was decided (D2).
      this.container.receiptDispositions.creditFor(scope, actor, id),
    ]);
    const identities = await this.container.payments.customerIdentities(scope, actor, [payment]);
    const dispositions = await this.container.payments.receiptDispositions(scope, actor, [payment]);
    // The external gateway's side (WP11A), read only after `get` charged `payments.view`.
    const invoice =
      payment.method === 'GATEWAY'
        ? await this.container.gatewayPayments.invoiceForPayment(scope, payment.id)
        : null;
    return {
      payment: toDetail(
        payment,
        invoice,
        destination,
        credit,
        identities.get(payment.customerId),
        dispositions.get(payment.id) ?? null,
      ),
    };
  }

  /**
   * What has happened to one payment, oldest first (WP17). Read-only: the service assembles
   * facts other flows recorded, and withholds — by name — each section the viewer lacks the
   * permission for.
   */
  @Get('payments/:id/timeline')
  async timeline(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<PaymentTimelineResponse> {
    const { scope, actor } = await this.authenticate(request);
    const view = await this.container.paymentTimeline.timeline(scope, actor, id);
    return {
      paymentId: id,
      entries: [...view.entries],
      withheld: [...view.withheld],
      truncated: view.truncated,
    };
  }

  /**
   * The compensation list (Payment File 02 §21, D7): every automatic refund of an order
   * that could not be delivered, credited to the wallet. Read-only, under `payments.view`.
   */
  @Get(COMPENSATION_ROUTES.list)
  async compensations(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<CompensationListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const page = compensationListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const result = await this.container.refunds.compensations(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: compensationCursorFrom(page.cursor) }),
    });
    return {
      compensations: result.items.map(toCompensationView),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
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

function compensationCursorFrom(raw: string): CompensationCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as RefundId };
}

function toSummary(
  record: PaymentRecord,
  identity: PaymentCustomerIdentity | undefined,
  receiptDisposition: ReceiptDisposition | null,
): PaymentSummaryResponse {
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
    // Payment File 02 §21 (D7): the route, the external reference and who paid.
    gatewayProvider: record.gatewayProvider,
    externalReference: record.externalReference,
    customerTelegramUserId: identity?.telegramUserId ?? null,
    customerUsername: identity?.username ?? null,
    receiptDisposition,
  };
}

/**
 * The gateway side of a payment, for an operator (WP11A). Ids, states and the provider's
 * amounts as provider metadata; never a payment link — a link is a way to pay.
 */
function toGatewayInvoiceView(invoice: GatewayInvoiceRecord): GatewayInvoiceView {
  const iso = (value: Date | null) => (value === null ? null : value.toISOString());
  const amount = (value: bigint | null) => (value === null ? null : value.toString());
  return {
    provider: invoice.provider,
    providerOrderId: invoice.providerOrderId,
    providerInvoiceId: invoice.providerInvoiceId,
    creationState: invoice.creationState,
    creationErrorCode: invoice.creationErrorCode,
    providerStatus: invoice.providerStatus,
    providerPaid: invoice.providerPaid,
    lastInquiryAt: iso(invoice.lastInquiryAt),
    lastInquiryErrorCode: invoice.lastInquiryErrorCode,
    webhookStatusHint: invoice.webhookStatusHint,
    lastWebhookAt: iso(invoice.lastWebhookAt),
    webhookCount: invoice.webhookCount,
    providerUnit: invoice.providerUnit,
    sentAmount: invoice.sentAmount.toString(),
    requestAmount: amount(invoice.requestAmount),
    finalAmount: amount(invoice.finalAmount),
    creditAmount: amount(invoice.creditAmount),
    outcome: invoice.outcome,
    lateCompletionObservedAt: iso(invoice.lateCompletionObservedAt),
    createdAt: invoice.createdAt.toISOString(),
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
  invoice: GatewayInvoiceRecord | null,
  destination: PaymentDestinationRecord | null,
  credit: ReceiptCreditRecord | null,
  identity: PaymentCustomerIdentity | undefined,
  receiptDisposition: ReceiptDisposition | null,
): PaymentDetailResponse {
  return {
    ...toSummary(record, identity, receiptDisposition),
    evidenceNote: record.evidenceNote,
    resolutionNote: record.resolutionNote,
    destination: destination === null ? null : toDestinationView(destination),
    receiptCredit: credit === null ? null : toReceiptCreditView(credit),
    topupCashbackPercent: record.topupCashbackPercent,
    gatewayInvoice: invoice === null ? null : toGatewayInvoiceView(invoice),
  };
}

/** A receipt's credit-to-wallet disposition, read-only (D2). */
function toReceiptCreditView(credit: ReceiptCreditRecord): ReceiptCreditView {
  return {
    amountMinor: credit.amount.amountMinor.toString(),
    currency: credit.amount.currency,
    walletEntryId: credit.walletEntryId,
    decidedByAdminId: credit.decidedByAdminId,
    decidedAt: credit.decidedAt.toISOString(),
    note: credit.note,
  };
}

/** One compensation, amounts as decimal strings with their currency (D7). */
function toCompensationView(record: CompensationRecord): CompensationView {
  return {
    refundId: record.refundId,
    paymentId: record.paymentId,
    orderId: record.orderId,
    customerId: record.customerId,
    customerTelegramUserId: record.customerTelegramUserId,
    customerUsername: record.customerUsername,
    principalMinor: record.principal.amountMinor.toString(),
    creditedMinor: record.credited.amountMinor.toString(),
    currency: record.credited.currency,
    reason: record.reason,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt === null ? null : record.completedAt.toISOString(),
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
