import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  legacyCustomerAdoptionsQuerySchema,
  type LegacyCustomerAdoptionsResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = legacyCustomerAdoptionsQuerySchema.parse(query ?? {});
    const adoptions = await this.container.legacyHistoryRead.adoptionsForCustomer(
      scope,
      actor,
      id,
      input,
    );
    return { adoptions: adoptions.map((row) => ({ ...row })) };
  }
}
