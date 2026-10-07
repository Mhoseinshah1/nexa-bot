import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_SERVICE_REVIEW_ROUTES,
  legacyServiceCandidateListQuerySchema,
  routePattern,
  uuidV7Schema,
  type LegacyServiceCandidateDetailResponse,
  type LegacyServiceCandidateListResponse,
  type LegacyServiceCandidateResponse,
  type LegacyServiceCandidateSummaryResponse,
  type LegacyServiceCandidateView,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { LegacyServiceCandidateRecord } from '../../modules/platform/legacy-service-review/application/ports.js';

/**
 * Mirza migration PR5 — legacy service candidates over HTTP (Area D; owner decision 8).
 *
 * Its OWN service, `LegacyServiceReviewService`: the list of live legacy invoices with the
 * one outcome the importer gave each, the evidence behind it, and the operator's review —
 * acknowledge, keep as history, reopen, and an explicit ADOPT approval. Never the terminal
 * review queue nor the P6 adoption (their boundary tests forbid naming either here): an
 * approval adopts nothing; the next import run executes it after every check again. The
 * service charges `legacy.services.view` to read and `legacy.services.decide` to decide,
 * inside its transaction.
 */
@Controller(`${API_PREFIX}`)
export class LegacyServicesController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_SERVICE_REVIEW_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyServiceCandidateListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyServiceCandidateListQuerySchema.parse(query ?? {});
    const page = await this.service.list(scope, actor, input);
    return { candidates: page.items.map(toView), nextCursor: page.nextCursor };
  }

  @Get(LEGACY_SERVICE_REVIEW_ROUTES.summary)
  async summary(@Req() request: FastifyRequest): Promise<LegacyServiceCandidateSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.service.summary(scope, actor);
  }

  @Get(routePattern(LEGACY_SERVICE_REVIEW_ROUTES.detail, 'id'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<LegacyServiceCandidateDetailResponse> {
    const { scope, actor } = await this.authenticate(request);
    const d = await this.service.get(scope, actor, uuidV7Schema.parse(id));
    return {
      candidate: toView(d.candidate),
      archive:
        d.archive === null
          ? null
          : {
              id: d.archive.id,
              revision: d.archive.revision,
              classification: d.archive.classification,
              status: d.archive.status,
              panelCode: d.archive.panelCode,
              productCode: d.archive.productCode,
              productName: d.archive.productName,
              priceRaw: d.archive.priceRaw,
              priceMinor: d.archive.priceMinor === null ? null : d.archive.priceMinor.toString(),
              soldAt: d.archive.soldAt === null ? null : d.archive.soldAt.toISOString(),
              sourceFingerprint: d.archive.sourceFingerprint,
            },
      importOutcome: d.importOutcome,
      adoptPanels: [...d.adoptPanels],
    };
  }

  @Post(routePattern(LEGACY_SERVICE_REVIEW_ROUTES.decide, 'id'))
  async decide(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyServiceCandidateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return {
      candidate: toView(await this.service.decide(scope, actor, uuidV7Schema.parse(id), body)),
    };
  }

  @Post(routePattern(LEGACY_SERVICE_REVIEW_ROUTES.adopt, 'id'))
  async adopt(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyServiceCandidateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return {
      candidate: toView(
        await this.service.approveAdoption(scope, actor, uuidV7Schema.parse(id), body),
      ),
    };
  }

  @Post(routePattern(LEGACY_SERVICE_REVIEW_ROUTES.reopen, 'id'))
  async reopen(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyServiceCandidateResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return {
      candidate: toView(await this.service.reopen(scope, actor, uuidV7Schema.parse(id), body)),
    };
  }

  private get service() {
    return this.container.legacyServiceReview;
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}

/** The wire shape: dates as ISO. Codes, NEXA ids and counts only — no personal data. */
export function toView(r: LegacyServiceCandidateRecord): LegacyServiceCandidateView {
  return {
    id: r.id,
    invoiceKey: r.invoiceKey,
    outcome: r.outcome,
    blocker: r.blocker,
    reviewState: r.reviewState,
    panelCode: r.panelCode,
    productCode: r.productCode,
    evidence: r.evidence,
    archiveId: r.archiveId,
    serviceId: r.serviceId,
    approvedPanelId: r.approvedPanelId,
    lastApprovalRefusal: r.lastApprovalRefusal,
    decisionReason: r.decisionReason,
    decidedByAdminId: r.decidedByAdminId,
    decidedAt: r.decidedAt === null ? null : r.decidedAt.toISOString(),
    runId: r.runId,
    sourceFingerprint: r.sourceFingerprint,
    invoiceChecksum: r.invoiceChecksum,
    synthetic: r.synthetic,
    observedAt: r.observedAt === null ? null : r.observedAt.toISOString(),
    version: r.version,
    firstDecidedAt: r.firstDecidedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
