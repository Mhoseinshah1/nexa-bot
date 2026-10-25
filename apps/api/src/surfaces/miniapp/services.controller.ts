import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  MINIAPP_SERVICE_ACTIONS,
  miniAppPageQuerySchema,
  miniAppServiceQuoteRequestSchema,
  type MiniAppOrder,
  type MiniAppServiceAction,
  type MiniAppServiceDetail,
  type MiniAppServiceOffer,
  type MiniAppServicesResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { ProvisioningService } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';
import {
  miniAppCall,
  miniAppKey,
  notFound,
  owned,
  parseWith,
  type MiniAppCall,
} from './miniapp-request.js';
import { orderWire, serviceSummaryWire, wire } from './projections.js';

/**
 * The customer's services (Round 9, C5): the list, one service's card data (the same facts
 * the bot's card shows: usage, expiry, link, the actions it offers), its QR, and the renew /
 * extra-traffic / extra-time offers and quotes. A quote is a DRAFT order like the bot's, and
 * it is paid through the same checkout routes as a purchase.
 */
@Controller(MINIAPP_API_PREFIX)
export class MiniAppServicesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(MINIAPP_ROUTES.services)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MiniAppServicesResponse> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const { page } = parseWith(miniAppPageQuerySchema, query);
    // The bot's pages are numbered from one.
    const result = await this.container.provisioning.pageForCustomer(
      call.context.scope,
      call.context.customer.id,
      page + 1,
    );
    const items = [];
    for (const service of result.items) {
      const title = await this.container.miniApp.purchaseTitle(call.context.scope, service.orderId);
      items.push(serviceSummaryWire(service, title ?? service.providerUsername));
    }
    return { items, page: result.page - 1, pages: result.pages, total: result.count };
  }

  @Get(MINIAPP_ROUTES.service)
  async detail(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<MiniAppServiceDetail> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const service = await this.ownService(call, serviceId);
    // The bot's card answers "not found" for a service whose sold plan cannot be read.
    const title = await this.container.miniApp.purchaseTitle(call.context.scope, service.orderId);
    if (title === null) throw notFound();
    const working = await this.container.provisioning.changeInProgress(call.context.scope, service);
    const offered = working
      ? []
      : await this.container.commercialActions.availableFor(
          call.context.scope,
          call.actor,
          service,
        );
    const deliverable = ProvisioningService.isDeliverable(service);
    return {
      ...serviceSummaryWire(service, title),
      subscriptionUrl: deliverable ? service.subscriptionUrl : null,
      working,
      actions: MINIAPP_SERVICE_ACTIONS.filter((kind) => offered.includes(kind)),
      qr: deliverable,
    };
  }

  /** The link's QR, drawn by the one renderer every delivered QR goes through. */
  @Get(MINIAPP_ROUTES.serviceQr)
  async qr(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const service = await this.ownService(call, serviceId);
    if (!ProvisioningService.isDeliverable(service) || service.subscriptionUrl === null) {
      throw notFound();
    }
    const image = await this.container.deliveryQr.render(call.context.scope, {
      kind: 'PAYLOAD',
      text: service.subscriptionUrl,
    });
    await reply.header('Content-Type', 'image/png').send(Buffer.from(image.bytes));
  }

  /** The options of one action, priced by the rows the operator configured. A read. */
  @Get(MINIAPP_ROUTES.serviceOffer)
  async offer(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Param('kind') kind: string,
  ): Promise<MiniAppServiceOffer> {
    const call = await miniAppCall(this.container, request, { gated: true });
    if (!(MINIAPP_SERVICE_ACTIONS as readonly string[]).includes(kind)) throw notFound();
    const action = kind as MiniAppServiceAction;
    const service = await this.ownService(call, serviceId);
    const offer = await this.container.commercialActions.offer(
      call.context.scope,
      call.actor,
      call.context.customer.id,
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
        });
      }
      for (const plan of offer.plans ?? []) {
        if (plan.price === null) continue;
        options.push({
          addonId: null,
          planId: plan.id,
          title: plan.title,
          price: wire(plan.price),
        });
      }
    } else {
      // An unpriced package is never offered at zero (`catalog.ts`: absent means unsellable).
      for (const addon of offer.addons) {
        if (addon.price === null) continue;
        options.push({
          addonId: addon.id,
          planId: null,
          title: addon.title,
          price: wire(addon.price),
        });
      }
    }
    return { kind: action, options };
  }

  /** The quote: a DRAFT order for the action, priced once by `PricingService` and honoured. */
  @Post(MINIAPP_ROUTES.serviceQuote)
  async quote(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<MiniAppOrder> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppServiceQuoteRequestSchema, body);
    const service = await this.ownService(call, serviceId);
    const { order } = await this.container.commercialActions.draft(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      {
        serviceId: service.id,
        kind: input.kind,
        ...(input.addonId === null ? {} : { addonId: input.addonId }),
        ...(input.planId === null ? {} : { productId: input.planId }),
        idempotencyKey: `${miniAppKey(request, call, 'quote')}:${input.kind.toLowerCase()}`,
      },
    );
    const display =
      order.purpose === 'RENEW'
        ? await this.container.miniApp.productDisplay.displayFor(
            call.context.scope,
            order.line.productId,
          )
        : null;
    return orderWire(order, {
      username: service.providerUsername,
      usernameModes: [],
      display,
      serviceId: service.id,
    });
  }

  private ownService(call: MiniAppCall, serviceId: string): Promise<ServiceRecord> {
    return owned(() =>
      this.container.provisioning.getForCustomer(
        call.context.scope,
        call.context.customer.id,
        serviceId,
      ),
    );
  }
}
