import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  TERMS_ROUTES,
  createTermsDraftRequestSchema,
  publishTermsDraftRequestSchema,
  routePattern,
  updateTermsDraftRequestSchema,
  type TermsOverviewResponse,
  type TermsVersionResponse,
  type TermsVersionWriteResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import type { TermsVersionRecord } from '../../modules/control/terms/application/ports.js';

/**
 * The terms and rules over HTTP, at `/terms` (program §6).
 *
 * One read and three writes. Authentication happens here; AUTHORIZATION does not —
 * `TermsService` charges `terms.view`, `terms.edit` and `terms.publish` itself. Turning
 * enforcement on or off is the `terms_enforcement` feature flag, through `/features`.
 */
@Controller(`${API_PREFIX}`)
export class TermsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(TERMS_ROUTES.overview)
  async overview(@Req() request: FastifyRequest): Promise<TermsOverviewResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const overview = await this.container.terms.overview(scope, actor);
    const counts = overview.acceptanceCounts;
    const currentId = overview.history[0]?.id ?? null;
    const view = (row: TermsVersionRecord) => toView(row, currentId, counts.get(row.id) ?? 0);
    const acceptedCurrent = currentId === null ? 0 : (counts.get(currentId) ?? 0);
    return {
      enforcement: overview.enforcement,
      current: overview.history[0] === undefined ? null : view(overview.history[0]),
      draft: overview.draft === null ? null : view(overview.draft),
      history: overview.history.map(view),
      statistics: {
        customers: overview.customers,
        acceptedCurrent,
        pendingCurrent: currentId === null ? 0 : Math.max(0, overview.customers - acceptedCurrent),
      },
    };
  }

  @Post(TERMS_ROUTES.createDraft)
  async createDraft(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<TermsVersionWriteResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = createTermsDraftRequestSchema.parse(body);
    return {
      version: toView(await this.container.terms.createDraft(scope, actor, input), null, 0),
    };
  }

  @Post(routePattern(TERMS_ROUTES.updateDraft, 'id'))
  async updateDraft(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TermsVersionWriteResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = updateTermsDraftRequestSchema.parse(body);
    const row = await this.container.terms.updateDraft(scope, actor, { ...input, id });
    return { version: toView(row, null, 0) };
  }

  @Post(routePattern(TERMS_ROUTES.publish, 'id'))
  async publish(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TermsVersionWriteResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = publishTermsDraftRequestSchema.parse(body);
    const row = await this.container.terms.publish(scope, actor, { ...input, id });
    // Just published, so it is the current version, and nobody has accepted it yet.
    return { version: toView(row, row.id, 0) };
  }
}

function toView(
  row: TermsVersionRecord,
  currentId: string | null,
  acceptanceCount: number,
): TermsVersionResponse {
  return {
    id: row.id,
    status: row.status,
    versionNumber: row.versionNumber,
    title: row.title,
    body: row.body,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdByUsername,
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedByUsername,
    current: row.id === currentId,
    acceptanceCount,
  };
}
