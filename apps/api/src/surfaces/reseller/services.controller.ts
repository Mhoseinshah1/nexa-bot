import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  COMMERCE_ERROR_CODES,
  MINIAPP_SERVICE_ACTIONS,
  NexaError,
  QR_PAYLOAD_KINDS,
  RESELLER_API_PREFIX,
  RESELLER_PANEL_ROUTES,
  RESELLER_WEB_ERROR_CODES,
  errors,
  miniAppServiceQuoteRequestSchema,
  resellerServiceNoteRequestSchema,
  resellerServicesQuerySchema,
  type MiniAppOrder,
  type MiniAppServiceAction,
  type MiniAppServiceOffer,
  type QrPayloadKind,
  type ResellerConnectionFilesResponse,
  type ResellerServiceDetail,
  type ResellerServicesResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import {
  attachmentDisposition,
  buildZip,
  contentTypeFor,
  sanitizeFileName,
  uniqueNames,
} from '../../modules/commerce/reseller-panel/domain/connection-files.js';
import type { ResellerWebContext } from '../../modules/commerce/reseller-panel/application/reseller-web-access.service.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import { listedPersonalDiscountWire, orderWire, wire } from '../miniapp/projections.js';
import { parseWith, resellerCall, resellerKey } from './reseller-request.js';

/** The connection-file download headers (§5.2): never cached, never sniffed. */
export const RESELLER_DOWNLOAD_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** The renewal and add-on kinds the drawer offers (its renewal and extra-traffic tabs). */
const PANEL_ACTION_KINDS: readonly MiniAppServiceAction[] = MINIAPP_SERVICE_ACTIONS.filter(
  (kind) => kind === 'RENEW' || kind === 'ADD_TRAFFIC' || kind === 'ADD_TIME',
);

/**
 * PR-4 §5.2 «سرویس‌های من» and the «مدیریت» drawer. Ownership is the application's
 * (`ResellerWebServicesService.own` → `getForCustomer`); every money step is the bot's own:
 * a quote is the commercial action's DRAFT priced once by `PricingService`, and paying it is
 * `CheckoutService.payFromWallet` → `settleFromWallet`, which refuses an insufficient or
 * negative wallet — there is no credit.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerServicesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_PANEL_ROUTES.services)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerServicesResponse> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerServicesQuerySchema, query);
    return this.container.resellerWeb.services.list(context, {
      filter: input.filter,
      page: input.page,
      ...(input.q === undefined ? {} : { q: input.q }),
    });
  }

  @Get(RESELLER_PANEL_ROUTES.service)
  async detail(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<ResellerServiceDetail> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.services.detail(context, serviceId);
  }

  @Put(RESELLER_PANEL_ROUTES.serviceNote)
  async note(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<{ note: string | null }> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerServiceNoteRequestSchema, body);
    return this.container.resellerWeb.services.setNote(context, serviceId, input.note);
  }

  /** One QR (`SUB_LINK` or `SINGBOX`) drawn by the renderer every delivered QR goes through. */
  @Get(RESELLER_PANEL_ROUTES.serviceQr)
  async qr(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Param('kind') kind: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const context = await resellerCall(this.container, request);
    if (!(QR_PAYLOAD_KINDS as readonly string[]).includes(kind)) throw notFound();
    const text = await this.container.resellerWeb.services.qrPayload(
      context,
      serviceId,
      kind as QrPayloadKind,
    );
    const image = await this.container.deliveryQr.render(context.scope, { kind: 'PAYLOAD', text });
    await reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', RESELLER_DOWNLOAD_HEADERS['Cache-Control'])
      .send(Buffer.from(image.bytes));
  }

  @Post(RESELLER_PANEL_ROUTES.serviceSendConnection)
  @HttpCode(200)
  async sendConnection(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<{ sent: number }> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.services.sendConnection(context, serviceId);
  }

  @Post(RESELLER_PANEL_ROUTES.serviceRotateLink)
  @HttpCode(200)
  async rotate(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<{ ok: true }> {
    const context = await resellerCall(this.container, request);
    await this.container.resellerWeb.services.rotateLink(
      context,
      serviceId,
      resellerKey(request, context, 'rotate'),
    );
    return { ok: true };
  }

  // --- Connection files: fetched on request, sent once, never stored ------------------------

  @Get(RESELLER_PANEL_ROUTES.serviceFiles)
  async files(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResellerConnectionFilesResponse> {
    const context = await resellerCall(this.container, request);
    const files = await this.container.resellerWeb.services.fetchFiles(context, serviceId, 'LIST');
    void reply.header('Cache-Control', RESELLER_DOWNLOAD_HEADERS['Cache-Control']);
    return {
      files: files.map((file, index) => ({
        index,
        fileName: sanitizeFileName(file.fileName),
        sizeBytes: file.bytes.length,
      })),
    };
  }

  @Get(RESELLER_PANEL_ROUTES.serviceFile)
  async file(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Param('index') index: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const context = await resellerCall(this.container, request);
    const at = /^\d{1,3}$/u.test(index) ? Number(index) : -1;
    const files = await this.container.resellerWeb.services.fetchFiles(
      context,
      serviceId,
      'DOWNLOAD',
    );
    const chosen = files[at];
    if (chosen === undefined) throw notFound();
    const name = sanitizeFileName(chosen.fileName);
    await this.download(reply, name, contentTypeFor(name), Buffer.from(chosen.bytes));
  }

  @Get(RESELLER_PANEL_ROUTES.serviceFilesZip)
  async zip(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const context = await resellerCall(this.container, request);
    const service = await this.container.resellerWeb.services.own(context, serviceId);
    const files = await this.container.resellerWeb.services.fetchFiles(context, serviceId, 'ZIP');
    const names = uniqueNames(files.map((file) => sanitizeFileName(file.fileName)));
    const archive = buildZip(
      files.map((file, index) => ({
        name: names[index] ?? `file-${String(index)}`,
        bytes: file.bytes,
      })),
    );
    const name = sanitizeFileName(`${service.providerUsername}.zip`, 'connection-files.zip');
    await this.download(reply, name, 'application/zip', archive);
  }

  @Post(RESELLER_PANEL_ROUTES.serviceFilesSend)
  @HttpCode(200)
  async sendFiles(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<{ sent: number }> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.services.sendFiles(context, serviceId);
  }

  // --- «تمدید» and «حجم اضافه»: the bot's offer, quote and wallet payment --------------------

  @Get(RESELLER_PANEL_ROUTES.serviceOffer)
  async offer(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Param('kind') kind: string,
  ): Promise<MiniAppServiceOffer> {
    const context = await resellerCall(this.container, request);
    if (!(PANEL_ACTION_KINDS as readonly string[]).includes(kind)) throw notFound();
    const action = kind as MiniAppServiceAction;
    const service = await this.container.resellerWeb.services.own(context, serviceId);
    const offer = await this.container.commercialActions.offer(
      context.scope,
      context.actor,
      context.customer.id,
      service.id,
      action,
    );
    const options: MiniAppServiceOffer['options'][number][] = [];
    if (action === 'RENEW') {
      if (offer.product !== null && offer.product.price !== null) {
        options.push({
          addonId: null,
          planId: null,
          title: offer.product.title,
          price: wire(offer.product.price),
          personalDiscount: listedPersonalDiscountWire(offer.product.personalDiscount),
        });
      }
      for (const plan of offer.plans ?? []) {
        if (plan.price === null) continue;
        options.push({
          addonId: null,
          planId: plan.id,
          title: plan.title,
          price: wire(plan.price),
          personalDiscount: listedPersonalDiscountWire(plan.personalDiscount),
        });
      }
    } else {
      for (const addon of offer.addons) {
        if (addon.price === null) continue;
        options.push({
          addonId: addon.id,
          planId: null,
          title: addon.title,
          price: wire(addon.price),
          personalDiscount: listedPersonalDiscountWire(addon.personalDiscount),
        });
      }
    }
    return { kind: action, options };
  }

  /** The quote: a DRAFT priced once by `PricingService`, honoured when paid. */
  @Post(RESELLER_PANEL_ROUTES.serviceQuote)
  @HttpCode(200)
  async quote(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<MiniAppOrder> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(miniAppServiceQuoteRequestSchema, body);
    if (!(PANEL_ACTION_KINDS as readonly string[]).includes(input.kind)) throw notFound();
    const service = await this.container.resellerWeb.services.own(context, serviceId);
    const { order } = await this.container.commercialActions.draft(
      context.scope,
      context.actor,
      context.customer.id,
      {
        serviceId: service.id,
        kind: input.kind,
        ...(input.addonId === null ? {} : { addonId: input.addonId }),
        ...(input.planId === null ? {} : { productId: input.planId }),
        idempotencyKey: `${resellerKey(request, context, 'quote')}:${input.kind.toLowerCase()}`,
      },
    );
    return this.orderView(order, service.providerUsername, service.id);
  }

  /**
   * Pay a renewal or add-on quote from the wallet — `CheckoutService.payFromWallet`, the bot's
   * own. A balance that does not cover the quote (or is negative) is refused; nothing is lent.
   */
  @Post(RESELLER_PANEL_ROUTES.orderPayWallet)
  @HttpCode(200)
  async payWallet(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
  ): Promise<{ order: MiniAppOrder; paymentId: string }> {
    const context = await resellerCall(this.container, request);
    const key = resellerKey(request, context, 'pay-wallet');
    const before = await this.ownOrder(context, orderId);
    const paid = await this.container.miniApp.checkout.payFromWallet(
      context.scope,
      context.actor,
      context.customer.id,
      before,
      key,
    );
    if (paid.outcome === 'SHORT') {
      throw errors.conflict(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, 'Insufficient funds.', {
        shortfallMinor: paid.shortfall.amountMinor.toString(),
        currency: paid.shortfall.currency,
      });
    }
    return {
      order: this.orderView(paid.order, null, null),
      paymentId: paid.payment.id,
    };
  }

  // -------------------------------------------------------------------------------------------

  private async download(
    reply: FastifyReply,
    name: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<void> {
    await reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', attachmentDisposition(name))
      .header('Cache-Control', RESELLER_DOWNLOAD_HEADERS['Cache-Control'])
      .header('X-Content-Type-Options', RESELLER_DOWNLOAD_HEADERS['X-Content-Type-Options'])
      .header('Content-Length', String(bytes.length))
      .send(bytes);
  }

  /** The reseller's own order, by id and owner in one read: another's is "not found". */
  private async ownOrder(context: ResellerWebContext, orderId: string): Promise<OrderRecord> {
    let order: OrderRecord | null;
    try {
      order = await this.container.orders.orderForCustomer(context.scope, context.actor, {
        customerId: context.customer.id,
        orderId,
      });
    } catch (error) {
      if (
        error instanceof NexaError &&
        (error.kind === 'NOT_FOUND' || error.kind === 'VALIDATION')
      ) {
        throw notFound();
      }
      throw error;
    }
    if (order === null) throw notFound();
    return order;
  }

  private orderView(
    order: OrderRecord,
    username: string | null,
    serviceId: string | null,
  ): MiniAppOrder {
    return orderWire(order, {
      username,
      usernameModes: [],
      display: null,
      serviceId,
    });
  }
}

function notFound(): NexaError {
  return errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');
}
