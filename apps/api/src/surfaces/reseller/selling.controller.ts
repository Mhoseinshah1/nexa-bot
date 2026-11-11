import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  RESELLER_API_PREFIX,
  RESELLER_CATALOGUE_PAGE_SIZE,
  RESELLER_SELLING_ROUTES,
  RESELLER_WEB_ERROR_CODES,
  errors,
  resellerCataloguePageQuerySchema,
  resellerPurchaseQuoteRequestSchema,
  type ResellerCategoriesResponse,
  type ResellerCustomOffer,
  type ResellerPlan,
  type ResellerPlansResponse,
  type ResellerPurchaseBatch,
  type ResellerPurchaseQuote,
  type ResellerServersResponse,
  type UserId,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import type { ListedProduct } from '../../modules/commerce/catalog/application/product.service.js';
import { productWire, wire } from '../miniapp/projections.js';
import { parseWith, resellerCall, resellerKey } from './reseller-request.js';

/**
 * PR-5 §5.5 — «خرید» on the reseller panel.
 *
 * The catalogue is EXACTLY the bot's, for this reseller: the server step from
 * `serverSelectionEnabled` + `browseServers` (drawn only with more than one server, as the
 * bot's `serverList`), the categories from `browseCategories` in the tenant's `sort_order`,
 * the plans from `browseCategory(…, customerId, serverId)` priced for this reseller with the
 * list price kept for the strike-through, and «سرویس دلخواه» only when the bot offers it
 * (`offeredLocations`). Nothing is invented here: what the bot would not show is not shown.
 *
 * The purchase is `ResellerWebPurchaseService`: N ordinary orders, one wallet pre-check.
 */
@Controller(RESELLER_API_PREFIX)
export class ResellerSellingController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_SELLING_ROUTES.catalogueServers)
  async servers(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerServersResponse> {
    const context = await resellerCall(this.container, request);
    const { page } = parseWith(resellerCataloguePageQuerySchema, query);
    const enabled = await this.container.products.serverSelectionEnabled(context.scope);
    if (!enabled) return { enabled, step: false, items: [], page, hasMore: false };
    const result = await this.container.products.browseServers(
      context.scope,
      context.actor,
      RESELLER_CATALOGUE_PAGE_SIZE,
      page * RESELLER_CATALOGUE_PAGE_SIZE,
      context.customer.id,
    );
    return {
      enabled,
      step: page > 0 || result.hasMore || result.items.length > 1,
      items: result.items.map((server) => ({ id: server.id, name: server.name })),
      page,
      hasMore: result.hasMore,
    };
  }

  @Get(RESELLER_SELLING_ROUTES.catalogueCategories)
  async categories(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerCategoriesResponse> {
    const context = await resellerCall(this.container, request);
    const { page, serverId } = parseWith(resellerCataloguePageQuerySchema, query);
    const result = await this.container.products.browseCategories(
      context.scope,
      context.actor,
      RESELLER_CATALOGUE_PAGE_SIZE,
      page * RESELLER_CATALOGUE_PAGE_SIZE,
      context.customer.id,
      serverId,
    );
    return {
      items: result.items.map((category) => ({
        id: category.id,
        name: category.name,
        emoji: category.emoji,
      })),
      page,
      hasMore: result.hasMore,
    };
  }

  @Get(RESELLER_SELLING_ROUTES.catalogueCategory)
  async category(
    @Req() request: FastifyRequest,
    @Param('categoryId') categoryId: string,
    @Query() query: unknown,
  ): Promise<ResellerPlansResponse> {
    const context = await resellerCall(this.container, request);
    const { page, serverId } = parseWith(resellerCataloguePageQuerySchema, query);
    if (!/^[0-9a-f-]{36}$/iu.test(categoryId)) {
      throw errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'Not found.');
    }
    const result = await this.container.products.browseCategory(
      context.scope,
      context.actor,
      categoryId,
      RESELLER_CATALOGUE_PAGE_SIZE,
      page * RESELLER_CATALOGUE_PAGE_SIZE,
      context.customer.id,
      serverId,
    );
    return {
      items: result.items.map(planWire).filter((plan): plan is ResellerPlan => plan !== null),
      page,
      hasMore: result.hasMore,
    };
  }

  /** «سرویس دلخواه»: the bot's own offer and ranges for this reseller. */
  @Get(RESELLER_SELLING_ROUTES.catalogueCustom)
  async custom(@Req() request: FastifyRequest): Promise<ResellerCustomOffer> {
    const context = await resellerCall(this.container, request);
    const locations = await this.container.customServiceFlow.offeredWithRanges(
      context.scope,
      context.actor,
      context.customer.id as UserId,
    );
    return {
      offered: locations.length > 0,
      locations: locations.map(({ location, volume, days }) => ({
        panelId: location.panelId,
        label: location.label,
        volume: { min: volume.min.toString(), max: volume.max.toString() },
        days: { min: days.min.toString(), max: days.max.toString() },
      })),
    };
  }

  /** The quote: N drafts under the header's key (the batch key), each priced once. */
  @Post(RESELLER_SELLING_ROUTES.purchaseQuote)
  @HttpCode(200)
  async quote(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerPurchaseQuote> {
    const context = await resellerCall(this.container, request);
    const input = parseWith(resellerPurchaseQuoteRequestSchema, body);
    return this.container.resellerWeb.purchases.quote(
      context,
      input,
      resellerKey(request, context, 'purchase'),
    );
  }

  @Get(RESELLER_SELLING_ROUTES.purchase)
  async purchase(
    @Req() request: FastifyRequest,
    @Param('batchId') batchId: string,
  ): Promise<ResellerPurchaseBatch> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.purchases.get(context, batchId);
  }

  /** «خرید»: the wallet pre-check, then each order paid; the per-service result. */
  @Post(RESELLER_SELLING_ROUTES.purchaseConfirm)
  @HttpCode(200)
  async confirm(
    @Req() request: FastifyRequest,
    @Param('batchId') batchId: string,
  ): Promise<ResellerPurchaseBatch> {
    const context = await resellerCall(this.container, request);
    // The header is still required (a write), but the orders' keys are the batch's own.
    resellerKey(request, context, 'purchase-confirm');
    return this.container.resellerWeb.purchases.confirm(context, batchId);
  }

  @Post(RESELLER_SELLING_ROUTES.purchaseSendLinks)
  @HttpCode(200)
  async sendLinks(
    @Req() request: FastifyRequest,
    @Param('batchId') batchId: string,
  ): Promise<{ sent: number; failed: number }> {
    const context = await resellerCall(this.container, request);
    return this.container.resellerWeb.purchases.sendLinks(context, batchId);
  }
}

/** A plan card: the mini app's product wire, plus the list price struck through. */
function planWire(product: ListedProduct): ResellerPlan | null {
  const base = productWire(product);
  if (base === null) return null;
  return { ...base, listPrice: product.listPrice === null ? null : wire(product.listPrice) };
}
