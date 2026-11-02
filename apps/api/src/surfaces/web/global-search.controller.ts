import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  GLOBAL_SEARCH_ROUTES,
  globalSearchQuerySchema,
  type GlobalSearchResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const query = globalSearchQuerySchema.parse(singleValued(raw));
    return this.container.globalSearch.search(scope, actor, query);
  }
}
