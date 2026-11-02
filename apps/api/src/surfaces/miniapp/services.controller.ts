import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  MINIAPP_SERVICE_ACTIONS,
  COMMERCE_ERROR_CODES,
  errors,
  fromWire,
  miniAppAutoRenewRequestSchema,
  miniAppPageQuerySchema,
  miniAppServiceLocationRequestSchema,
  miniAppServiceQuoteRequestSchema,
  type MiniAppAutoRenew,
  type MiniAppOrder,
  type MiniAppServiceAction,
  type MiniAppServiceDetail,
  type MiniAppServiceLocationResult,
  type MiniAppServiceLocations,
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
import { listedPersonalDiscountWire, orderWire, serviceSummaryWire, wire } from './projections.js';

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
    /*
     * R11 A4: on a «فقط فایل، بدون لینک ساب» panel the link is NOT in the payload at all —
     * not hidden by the screen, not sent and ignored — and the QR the link would draw is
     * not offered. The field stays in the schema as null, the answer for "no link to show".
     */
    const deliverable = ProvisioningService.isDeliverable(service);
    const showLink =
      deliverable && !(await this.container.delivery.isFilesOnly(call.context.scope, service));
    // R11 A4, «نوع بارکد»: the QRs the sheet offers (none while the link is hidden).
    const qrKinds = deliverable
      ? (await this.container.delivery.qrPayloadsFor(call.context.scope, service)).map(
          (payload) => payload.kind,
        )
      : [];
    return {
      ...serviceSummaryWire(service, title),
      subscriptionUrl: showLink ? service.subscriptionUrl : null,
      working,
      actions: MINIAPP_SERVICE_ACTIONS.filter((kind) => offered.includes(kind)),
      qr: qrKinds.length > 0,
      qrKinds,
      canChangeLocation: offered.includes('CHANGE_LOCATION'),
      // R11 B4: the same count the enforcement uses; null (nothing shown) with the feature off
      // or no limit set, and still answered at 0, where the button above is already gone.
      locationRemaining: await this.container.commercialActions.locationChangesLeft(
        call.context.scope,
        call.actor,
        service,
      ),
      autoRenew: await this.autoRenewOf(call, service),
    };
  }

  /**
   * Round 10, D1: switch «تمدید خودکار» on (the server quotes the renewal and records that
   * total as the consent) or off. The bot's own service, the same refusals in Persian.
   */
  @Post(MINIAPP_ROUTES.serviceAutoRenew)
  async autoRenew(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<MiniAppAutoRenew> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppAutoRenewRequestSchema, body);
    const service = await this.ownService(call, serviceId);
    const state = await this.container.serviceAutoRenew.set(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      {
        serviceId: service.id,
        enabled: input.enabled,
        // The total the confirmation showed: the consent is bound to it (Codex, PR 338).
        expected: input.expected === undefined ? null : fromWire(input.expected),
        idempotencyKey: `${miniAppKey(request, call, 'auto-renew')}:${input.enabled ? 'on' : 'off'}`,
      },
    );
    return { ...state, price: state.price === null ? null : wire(state.price) };
  }

  private async autoRenewOf(call: MiniAppCall, service: ServiceRecord): Promise<MiniAppAutoRenew> {
    const state = await this.container.serviceAutoRenew.stateFor(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      service,
    );
    return { ...state, price: state.price === null ? null : wire(state.price) };
  }

  /** The service's first QR, drawn by the one renderer every delivered QR goes through. */
  @Get(MINIAPP_ROUTES.serviceQr)
  async qr(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.drawQr(request, serviceId, null, reply);
  }

  /** R11 A4: one named QR (`SUB_LINK` or `SINGBOX`) of a panel that offers more than one. */
  @Get(MINIAPP_ROUTES.serviceQrKind)
  async qrOfKind(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Param('kind') kind: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.drawQr(request, serviceId, kind, reply);
  }

  private async drawQr(
    request: FastifyRequest,
    serviceId: string,
    kind: string | null,
    reply: FastifyReply,
  ): Promise<void> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const service = await this.ownService(call, serviceId);
    if (!ProvisioningService.isDeliverable(service) || service.subscriptionUrl === null) {
      throw notFound();
    }
    /*
     * R11 A4: what may be drawn is decided by the panel — none on a files-only panel (the
     * link is never shown, so neither is a QR of it), the plain link's, the sing-box import
     * string, or both. A kind the panel does not offer is the same 404 as no QR.
     */
    const payloads = await this.container.delivery.qrPayloadsFor(call.context.scope, service);
    const payload = kind === null ? payloads[0] : payloads.find((one) => one.kind === kind);
    if (payload === undefined) throw notFound();
    const image = await this.container.deliveryQr.render(call.context.scope, {
      kind: 'PAYLOAD',
      text: payload.text,
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
          // R11 A9: the price the quote charges when the personal discount wins it.
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
      // An unpriced package is never offered at zero (`catalog.ts`: absent means unsellable).
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

  /**
   * The location sheet's read: where the service is and what it may be moved to, priced.
   * `CommercialActionService.offer` is the bot's own read and refuses for every reason a
   * move would (state, panel, policy, nothing configured); the cooldown and the rolling
   * limit have already removed the targets they refuse. R11 B4 adds the changes left, from
   * the offer's own evaluation (null with no limit set). Nothing else is exposed.
   */
  @Get(MINIAPP_ROUTES.serviceLocations)
  async locations(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
  ): Promise<MiniAppServiceLocations> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const service = await this.ownService(call, serviceId);
    const offer = await this.container.commercialActions.offer(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      service.id,
      'CHANGE_LOCATION',
    );
    const locations = offer.locations ?? null;
    if (locations === null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service cannot be moved right now.',
      );
    }
    return {
      current: { label: locations.current.label },
      remaining: locations.remaining,
      targets: locations.targets.map((target) => ({
        id: target.id,
        label: target.label,
        price: wire(target.price),
      })),
    };
  }

  /**
   * A move asked for, as the bot's target tap and confirm are: `locationTarget` decides
   * first (not offered, already there, cooldown, limit, the panel: each refused with its own
   * code, passed through). A PRICED target becomes the ordinary DRAFT quote, paid through
   * the same checkout; a FREE one is requested through `LocationChangeService.requestFree`,
   * which decides everything again in its own transaction. The page asks the customer to
   * confirm a free move before it calls this.
   */
  @Post(MINIAPP_ROUTES.serviceLocation)
  async location(
    @Req() request: FastifyRequest,
    @Param('serviceId') serviceId: string,
    @Body() body: unknown,
  ): Promise<MiniAppServiceLocationResult> {
    const call = await miniAppCall(this.container, request, { gated: true });
    const input = parseWith(miniAppServiceLocationRequestSchema, body);
    const service = await this.ownService(call, serviceId);
    const decided = await this.container.commercialActions.locationTarget(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      service.id,
      input.locationId,
    );
    const idempotencyKey = `${miniAppKey(request, call, 'location')}:change_location`;
    if (decided.target.price.amountMinor !== 0n) {
      const { order } = await this.container.commercialActions.draft(
        call.context.scope,
        call.actor,
        call.context.customer.id,
        {
          serviceId: service.id,
          kind: 'CHANGE_LOCATION',
          locationId: input.locationId,
          idempotencyKey,
        },
      );
      return {
        outcome: 'ORDER',
        order: orderWire(order, {
          username: service.providerUsername,
          usernameModes: [],
          display: null,
          serviceId: service.id,
        }),
      };
    }
    await this.container.locationChanges.requestFree(
      call.context.scope,
      call.actor,
      call.context.customer.id,
      { serviceId: service.id, locationId: input.locationId, idempotencyKey },
    );
    return { outcome: 'REQUESTED' };
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
