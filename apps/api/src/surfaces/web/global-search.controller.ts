import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  GLOBAL_SEARCH_ROUTES,
  globalSearchQuerySchema,
  type GlobalSearchResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';

/**
 * The top-bar search at `GET /search?q=` (R11 A1): customers, orders and services in one answer.
 *
 * Read-only. Authentication happens here; AUTHORIZATION does not — `GlobalSearchService`
 * returns each kind only when the actor holds that kind's own list permission, and the list
 * services it reads through check it again, so no kind is protected merely by the Web Admin not
 * asking for it. The tenant is the session's, never a parameter.
 */
@Controller(`${API_PREFIX}`)
export class GlobalSearchController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(GLOBAL_SEARCH_ROUTES.search)
  async search(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<GlobalSearchResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = globalSearchQuerySchema.parse(singleValued(raw));
    return this.container.globalSearch.search(scope, actor, query);
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
