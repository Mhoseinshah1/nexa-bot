import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  DASHBOARD_ROUTES,
  reportRangeQuerySchema,
  type DashboardOperationsResponse,
  type DashboardSummaryResponse,
  type NavCountersResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { singleValued } from './query.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The dashboard and the sidebar counters, over HTTP (`docs/web-redesign/dashboard.md`).
 *
 * Three GETs and no write. Authentication happens here; AUTHORITY does not. The business
 * summary is charged by `ReportingService` — `reports.view` AND the owner role, the reports'
 * own gate — before it reads anything. The operational sections and the counters are each
 * computed only for a viewer holding the permission of the page they summarise, decided by
 * the guard's resolution rule inside `OperationsOverviewService`. The tenant always comes
 * from the session.
 */
@Controller(`${API_PREFIX}`)
export class DashboardController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(DASHBOARD_ROUTES.summary)
  async summary(
    @Req() request: FastifyRequest,
    @Query() raw: Record<string, unknown>,
  ): Promise<DashboardSummaryResponse> {
    const { scope, actor } = await this.authenticate(request);
    const query = singleValued(raw);
    const parsed = reportRangeQuerySchema.parse({
      ...(query.range === undefined ? {} : { range: query.range }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });
    return this.container.reports.dashboard(scope, actor, {
      range: parsed.range,
      ...(parsed.from === undefined ? {} : { from: parsed.from }),
      ...(parsed.to === undefined ? {} : { to: parsed.to }),
    });
  }

  @Get(DASHBOARD_ROUTES.operations)
  async operations(@Req() request: FastifyRequest): Promise<DashboardOperationsResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.operationsOverview.operations(scope, actor);
  }

  @Get(DASHBOARD_ROUTES.navCounters)
  async navCounters(@Req() request: FastifyRequest): Promise<NavCountersResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.operationsOverview.navCounters(scope, actor);
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    // The tenant's figures: every bot it runs sells into the same orders and panels.
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
