import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  PRODUCT_CATEGORY_ROUTES,
  productCategoryAssignSchema,
  productCategoryCreateSchema,
  productCategoryReorderSchema,
  productCategoryWriteSchema,
  productStatusRequestSchema,
  type ProductCategoryListResponse,
  type ProductCategoryListingResponse,
  type ProductCategoryResponse,
  type ProductCategorySummaryResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type {
  ProductCategoryListing,
  ProductCategoryRecord,
} from '../../modules/commerce/catalog/application/ports.js';

/**
 * Categories over HTTP, at `/product-categories`.
 *
 * Authentication happens here; AUTHORIZATION does not. Every method calls
 * `ProductCategoryService`, which charges `catalog.view` or `catalog.edit` itself — so
 * no endpoint is protected merely by the Web Admin not drawing a button, and the
 * Telegram admin surface reaches the same answer through the same service.
 *
 * `/product-categories` rather than `/products/categories`: a category is its own
 * aggregate with its own lifecycle, and nesting it under products would make it look
 * like a property of one.
 */
@Controller(`${API_PREFIX}`)
export class ProductCategoriesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(PRODUCT_CATEGORY_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<ProductCategoryListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const categories = await this.container.productCategories.list(scope, actor);
    return { categories: categories.map(toListing) };
  }

  @Post(PRODUCT_CATEGORY_ROUTES.create)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productCategoryCreateSchema.parse(body);
    const category = await this.container.productCategories.create(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      draft: {
        name: command.name,
        description: command.description,
        emoji: command.emoji,
        sortOrder: command.sortOrder,
      },
    });
    return { category: toSummary(category) };
  }

  /**
   * Declared BEFORE `product-categories/:id`, because Nest matches in declaration order
   * and `reorder` would otherwise be read as an id — answered 400 by the uuid check,
   * which is a confusing way to be told a route exists.
   */
  @Post(PRODUCT_CATEGORY_ROUTES.reorder)
  async reorder(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ProductCategoryListResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productCategoryReorderSchema.parse(body);
    const categories = await this.container.productCategories.reorder(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      positions: command.positions,
    });
    return { categories: categories.map(toListing) };
  }

  @Get('product-categories/:id')
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ProductCategoryResponse> {
    const { scope, actor } = await this.authenticate(request);
    // The id is NOT cast here: the service validates it, so a malformed path segment is
    // a 400 rather than a 500 at the `uuid` cast.
    const category = await this.container.productCategories.get(scope, actor, id);
    return { category: toSummary(category) };
  }

  @Post('product-categories/:id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productCategoryWriteSchema.parse(body);
    const category = await this.container.productCategories.update(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      categoryId: id,
      edit: {
        name: command.name,
        description: command.description,
        emoji: command.emoji,
      },
    });
    return { category: toSummary(category) };
  }

  /**
   * DELETE, and it carries a body.
   *
   * Unusual, and deliberate: every mutation on this surface takes an idempotency key,
   * and a delete is the one where a lost response most needs one — the operator presses
   * again, and without a key the second press either deletes something recreated since
   * or reports a failure for work that succeeded.
   */
  @Delete('product-categories/:id')
  async remove(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly deleted: true }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    return this.container.productCategories.remove(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      categoryId: id,
    });
  }

  @Post('product-categories/:id/activate')
  async activate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    return this.transition(request, id, body, 'activate');
  }

  @Post('product-categories/:id/deactivate')
  async deactivate(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    return this.transition(request, id, body, 'deactivate');
  }

  @Post('product-categories/:id/show')
  async show(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    return this.transition(request, id, body, 'show');
  }

  @Post('product-categories/:id/hide')
  async hide(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductCategoryResponse> {
    return this.transition(request, id, body, 'hide');
  }

  /**
   * Files a product under this category.
   *
   * On the CATEGORY's route rather than the product's, because what the write depends on
   * is the destination category still existing — which is this aggregate's business, and
   * is why the service takes its row lock.
   */
  @Post('product-categories/:id/products')
  async assign(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ readonly productId: string; readonly categoryId: string }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productCategoryAssignSchema.parse(body);
    return this.container.productCategories.reassignProduct(scope, actor, {
      idempotencyKey: command.idempotencyKey,
      productId: command.productId,
      categoryId: id,
    });
  }

  /** One authenticate-parse-call path for the four flag endpoints. */
  private async transition(
    request: FastifyRequest,
    id: string,
    body: unknown,
    which: 'activate' | 'deactivate' | 'show' | 'hide',
  ): Promise<ProductCategoryResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const command = productStatusRequestSchema.parse(body);
    const category = await this.container.productCategories[which](scope, actor, {
      idempotencyKey: command.idempotencyKey,
      categoryId: id,
    });
    return { category: toSummary(category) };
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
    // `botInstanceId: null`, for the reason `ProductsController` gives: a category
    // belongs to the TENANT, and a tenant running two bots sells one catalogue.
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
 * The only `ProductCategoryRecord` → JSON conversion on this surface.
 *
 * No `productCount`, because a single-category response does not compute one and a zero
 * here would be a number an operator can act on — "this is empty, I may delete it" —
 * that is not a fact about anything. The list has its own shape, below, which carries
 * the count it actually asked the database for.
 */
function toSummary(category: ProductCategoryRecord): ProductCategorySummaryResponse {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    emoji: category.emoji,
    status: category.status,
    visibility: category.visibility,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function toListing(category: ProductCategoryListing): ProductCategoryListingResponse {
  return { ...toSummary(category), productCount: category.productCount };
}
