import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  PRODUCT_ROUTES,
  money,
  productListQuerySchema,
  productStatusRequestSchema,
  productWriteSchema,
  type PanelId,
  type ProductListResponse,
  type ProductResponse,
  type ProductSummaryResponse,
  type ProductWriteRequest,
  type TenantContext,
} from '@nexa/contracts';
import type { ProductId } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ProductCursor,
  ProductDraft,
  ProductRecord,
} from '../../modules/commerce/catalog/application/ports.js';

/**
 * Products over HTTP, at `/products`.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls
 * `ProductService`, which charges `catalog.view` or `catalog.edit` itself — so no
 * endpoint is protected merely by the Web Admin not drawing a button, and a later
 * surface reaches the same answer.
 *
 * `toSummary` is the only `ProductRecord` → JSON conversion here, and what it omits is
 * deliberate: no panel URL, no panel credentials, no provider type. A product names a
 * panel and the panel's configuration belongs to `/panels`, behind its own permission.
 */
@Controller(`${API_PREFIX}`)
export class ProductsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PRODUCT_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<ProductListResponse> {
    const { scope, actor } = await this.authenticate(request);
    // A repeated parameter is an ARRAY, not a string — the same guard every other list
    // on this surface uses rather than trusting the schema to refuse it.
    const query = singleValued(raw);
    const page = productListQuerySchema.parse({
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.audience === undefined ? {} : { audience: query.audience }),
      ...(query.title === undefined ? {} : { title: query.title }),
    });
    const result = await this.container.products.list(scope, actor, {
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      // The shared cursor. A cursor this server did not mint is a 400, never a silent
      // restart of the traversal.
      ...(page.cursor === undefined ? {} : { cursor: productCursorFrom(page.cursor) }),
      search: {
        ...(page.status === undefined ? {} : { status: page.status }),
        ...(page.audience === undefined ? {} : { audience: page.audience }),
        ...(page.title === undefined ? {} : { titlePrefix: page.title }),
      },
    });
    return {
      products: result.items.map(toSummary),
      nextCursor: result.nextCursor === null ? null : encodeKeysetCursor(result.nextCursor),
    };
  }

  @Post(PRODUCT_ROUTES.create)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<ProductResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productWriteSchema.parse(body);
    const product = await this.container.products.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      draft: draftFrom(command),
    });
    return { product: toSummary(product) };
  }

  @Get('products/:id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<ProductResponse> {
    const { scope, actor } = await this.authenticate(request);
    // The id is NOT cast here: `ProductService.get` validates it, so a malformed path
    // segment is a 400 rather than a 500 at the `uuid` cast.
    return { product: toSummary(await this.container.products.get(scope, actor, id)) };
  }

  @Post('products/:id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productWriteSchema.parse(body);
    const product = await this.container.products.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      productId: id,
      edit: draftFrom(command),
    });
    return { product: toSummary(product) };
  }

  @Post('products/:id/activate')
  async activate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    const product = await this.container.products.activate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      productId: id,
    });
    return { product: toSummary(product) };
  }

  @Post('products/:id/deactivate')
  async deactivate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    const product = await this.container.products.deactivate(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      productId: id,
    });
    return { product: toSummary(product) };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // `botInstanceId: null`: a product belongs to the TENANT. A tenant running two bots
    // sells one catalogue, and scoping a product to a bot would make the same plan two
    // rows an operator has to keep in step.
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
 * The wire shape as the application's own draft.
 *
 * The price pair becomes ONE `Money` here, which is the layer where it stops being two
 * fields that could disagree — the schema has already refused a half-price, and below
 * this point nothing can construct one.
 */
function draftFrom(command: ProductWriteRequest): ProductDraft {
  return {
    title: command.title,
    description: command.description,
    audience: command.audience,
    sortOrder: command.sortOrder,
    panelId: command.panelId as PanelId | null,
    specification: {
      durationDays: command.durationDays,
      trafficBytes: BigInt(command.trafficBytes),
      deviceLimit: command.deviceLimit,
    },
    price:
      command.priceAmount === null || command.priceCurrency === null
        ? null
        : money(BigInt(command.priceAmount), command.priceCurrency),
  };
}

/**
 * The shared cursor, branded for this list.
 *
 * `decodeKeysetCursor` refuses anything this server did not mint — a 400 rather than a
 * silent restart at page one — and the brand is applied here because the decoder is
 * shared and knows nothing about which entity it is paging.
 */
function productCursorFrom(raw: string): ProductCursor {
  const position = decodeKeysetCursor(raw);
  return { createdAt: position.createdAt, id: position.id as ProductId };
}

/** The only `ProductRecord` → JSON conversion on this surface. */
function toSummary(record: ProductRecord): ProductSummaryResponse {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    status: record.status,
    audience: record.audience,
    sortOrder: record.sortOrder,
    panelId: record.panelId,
    durationDays: record.specification.durationDays,
    // Text on the wire. A traffic allowance in bytes passes 2^53 at eight petabytes and
    // an amount in minor units well before that, and JSON has one number type.
    trafficBytes: record.specification.trafficBytes.toString(),
    deviceLimit: record.specification.deviceLimit,
    priceAmount: record.price === null ? null : record.price.amountMinor.toString(),
    priceCurrency: record.price === null ? null : record.price.currency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
