import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_PRODUCT_REVIEW_ROUTES,
  legacyProductReviewListQuerySchema,
  routePattern,
  uuidV7Schema,
  type LegacyProductReviewListResponse,
  type LegacyProductReviewResponse,
  type LegacyProductReviewView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { LegacyProductReviewListItem } from '../../modules/commerce/legacy-product-review/application/ports.js';

/**
 * Mirza migration PR2 — the legacy product review over HTTP
 * (`docs/legacy-product-review-design.md` §8).
 *
 * Its OWN service, `LegacyProductReviewService`: a review row carries no Telegram id,
 * username or balance, unlike the importer's terminal-only Manual Review Queue, which no
 * surface may reach (`tests/unit/legacy-review-queue-boundary.test.ts`). Nothing here
 * decides anything: the service charges `legacy.products.view` to read and
 * `legacy.products.decide` (plus `catalog.edit` for approve-as-new) to decide, inside its
 * transaction, and every decision binds to the facts checksum the operator saw.
 */
@Controller(`${API_PREFIX}`)
export class LegacyProductsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_PRODUCT_REVIEW_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyProductReviewListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyProductReviewListQuerySchema.parse(query ?? {});
    const page = await this.service.list(scope, actor, input);
    return { reviews: page.items.map((item) => this.toView(item)), nextCursor: page.nextCursor };
  }

  @Get(routePattern(LEGACY_PRODUCT_REVIEW_ROUTES.detail, 'id'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyProductReviewResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { review: this.toView(await this.service.get(scope, actor, uuidV7Schema.parse(id))) };
  }

  @Post(routePattern(LEGACY_PRODUCT_REVIEW_ROUTES.approveExisting, 'id'))
  async approveExisting(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyProductReviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const item = await this.service.approveExisting(scope, actor, uuidV7Schema.parse(id), body);
    return { review: this.toView(item) };
  }

  @Post(routePattern(LEGACY_PRODUCT_REVIEW_ROUTES.approveNew, 'id'))
  async approveNew(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyProductReviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const item = await this.service.approveNew(scope, actor, uuidV7Schema.parse(id), body);
    return { review: this.toView(item) };
  }

  @Post(routePattern(LEGACY_PRODUCT_REVIEW_ROUTES.reject, 'id'))
  async reject(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyProductReviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const item = await this.service.reject(scope, actor, uuidV7Schema.parse(id), body);
    return { review: this.toView(item) };
  }

  @Post(routePattern(LEGACY_PRODUCT_REVIEW_ROUTES.reopen, 'id'))
  async reopen(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyProductReviewResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const item = await this.service.reopen(scope, actor, uuidV7Schema.parse(id), body);
    return { review: this.toView(item) };
  }

  private get service() {
    return this.container.legacyProductReviews;
  }

  /** The wire shape: bigints as decimal strings, dates as ISO, the parsed fields beside the raw facts. */
  private toView(item: LegacyProductReviewListItem): LegacyProductReviewView {
    const r = item.review;
    return {
      id: r.id,
      codeProduct: r.codeProduct,
      legacyProductId: r.legacyProductId,
      state: r.state,
      facts: r.facts.map((row) => ({ ...row })),
      factsChecksum: r.factsChecksum,
      sourceConflict: r.sourceConflict,
      title: r.title,
      trafficBytes: r.trafficBytes === null ? null : r.trafficBytes.toString(),
      durationDays: r.durationDays,
      historicalPriceRaw: r.historicalPriceRaw,
      historicalPriceMinor:
        r.historicalPriceMinor === null ? null : r.historicalPriceMinor.toString(),
      historicalPriceCurrency: r.historicalPriceCurrency,
      parseNotes: { ...r.parseNotes },
      liveInvoiceCount: r.liveInvoiceCount,
      approvedProductId: r.approvedProductId,
      approvedProductTitle: item.approvedProductTitle,
      approvedFactsChecksum: r.approvedFactsChecksum,
      priorState: r.priorState,
      decisionReason: r.decisionReason,
      decidedByAdminId: r.decidedByAdminId,
      decidedAt: r.decidedAt === null ? null : r.decidedAt.toISOString(),
      readFingerprint: r.readFingerprint,
      sourceFingerprint: r.sourceFingerprint,
      missingSinceReadFingerprint: r.missingSinceReadFingerprint,
      exportable: this.service.exportable(r),
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
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
