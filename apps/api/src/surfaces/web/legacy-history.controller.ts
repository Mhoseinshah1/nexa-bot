import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  legacyCustomerAdoptionsQuerySchema,
  type LegacyCustomerAdoptionsResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The one route kept from the archive-only Mirza views: which of a customer's services were
 * adopted from Mirza (`legacy.services.view`). Read-only.
 */
@Controller(`${API_PREFIX}`)
export class LegacyHistoryController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  /** Which of the given services of the customer were adopted from Mirza (`legacy.services.view`). */
  @Get('users/:id/legacy-adopted-services')
  async adoptions(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<LegacyCustomerAdoptionsResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = legacyCustomerAdoptionsQuerySchema.parse(query ?? {});
    const adoptions = await this.container.legacyHistoryRead.adoptionsForCustomer(
      scope,
      actor,
      id,
      input,
    );
    return { adoptions: adoptions.map((row) => ({ ...row })) };
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      // A customer belongs to the TENANT, not to a bot (as on every Customer 360 route).
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
