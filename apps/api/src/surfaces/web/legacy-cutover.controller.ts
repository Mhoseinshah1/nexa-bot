import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  LEGACY_CUTOVER_ROUTES,
  legacyCutoverListQuerySchema,
  routePattern,
  uuidV7Schema,
  type LegacyCutoverApplyRunListResponse,
  type LegacyCutoverApprovalListResponse,
  type LegacyCutoverApprovalResponse,
  type LegacyCutoverApprovalView,
  type LegacyCutoverReadSetListResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { LegacyCutoverApprovalRecord } from '../../modules/platform/legacy-cutover/application/ports.js';

/**
 * Mirza migration PR6 — the owner's cutover approval over HTTP (owner constraint 3).
 *
 * Its own service, `LegacyCutoverService`, which charges `legacy.cutover.view` to read and the
 * CRITICAL `legacy.cutover.approve` to record or revoke, inside its transaction. An approval
 * imports NOTHING: it is the authenticated owner's consent, bound to seven exact values, that
 * the importer (SYSTEM_JOB, `maintenance.run`) reads and refuses without. Fingerprints, digests
 * and NEXA ids only — no legacy row crosses this surface.
 */
@Controller(`${API_PREFIX}`)
export class LegacyCutoverController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(LEGACY_CUTOVER_ROUTES.approvals)
  async approvals(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyCutoverApprovalListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCutoverListQuerySchema.parse(query ?? {});
    const page = await this.service.listApprovals(scope, actor, input);
    return { approvals: page.items.map(toView), nextCursor: page.nextCursor };
  }

  @Get(LEGACY_CUTOVER_ROUTES.readSets)
  async readSets(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyCutoverReadSetListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCutoverListQuerySchema.parse(query ?? {});
    const page = await this.service.listReadSets(scope, actor, input);
    return {
      readSets: page.items.map((r) => ({
        id: r.id,
        readSet: r.readSet,
        fingerprintVersion: r.fingerprintVersion,
        readSetFingerprint: r.readSetFingerprint,
        sourceFingerprint: r.sourceFingerprint,
        synthetic: r.synthetic,
        tableCount: r.tableCount,
        rowCount: r.rowCount.toString(),
        recordedAt: r.recordedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Get(LEGACY_CUTOVER_ROUTES.applyRuns)
  async applyRuns(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<LegacyCutoverApplyRunListResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCutoverListQuerySchema.parse(query ?? {});
    const page = await this.service.listApplyRuns(scope, actor, input);
    return {
      runs: page.items.map((r) => ({
        id: r.id,
        status: r.status,
        sourceFingerprint: r.sourceFingerprint,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt === null ? null : r.finishedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(LEGACY_CUTOVER_ROUTES.approvals)
  async approve(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<LegacyCutoverApprovalResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { approval: toView(await this.service.approve(scope, actor, body)) };
  }

  @Post(routePattern(LEGACY_CUTOVER_ROUTES.revoke, 'id'))
  async revoke(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LegacyCutoverApprovalResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return {
      approval: toView(await this.service.revoke(scope, actor, uuidV7Schema.parse(id), body)),
    };
  }

  private get service() {
    return this.container.legacyCutover;
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

/** The wire shape: dates as ISO. Fingerprints, digests and NEXA ids only. */
export function toView(r: LegacyCutoverApprovalRecord): LegacyCutoverApprovalView {
  return {
    id: r.id,
    kind: r.kind,
    sourceFingerprint: r.sourceFingerprint,
    panelMapFingerprint: r.panelMapFingerprint,
    inventoryFingerprint: r.inventoryFingerprint,
    productsFingerprint: r.productsFingerprint,
    invoiceArchiveFingerprint: r.invoiceArchiveFingerprint,
    freezeProofSha256: r.freezeProofSha256,
    finalDumpSha256: r.finalDumpSha256,
    priorSourceFingerprint: r.priorSourceFingerprint,
    synthetic: r.synthetic,
    reason: r.reason,
    approvedByAdminId: r.approvedByAdminId,
    approvedAt: r.approvedAt.toISOString(),
    revocation:
      r.revocation === null
        ? null
        : {
            revokedByAdminId: r.revocation.revokedByAdminId,
            revokedAt: r.revocation.revokedAt.toISOString(),
            reason: r.revocation.reason,
          },
  };
}
