import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type DeliveryTutorialResponse,
  type TenantContext,
  type UpdateDeliveryTutorialResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * Phase 2 item 5: one panel's post-delivery tutorial over HTTP. `panels.view` to read,
 * `panels.edit` to replace — both charged by `DeliveryTutorialService`, and the write
 * refused for a stale revision. No endpoint is protected by the Web Admin not drawing a
 * button.
 */
@Controller(`${API_PREFIX}`)
export class DeliveryTutorialController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('panels/:id/delivery-tutorial')
  async tutorial(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<DeliveryTutorialResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.deliveryTutorials.get(scope, actor, id);
  }

  @Post('panels/:id/delivery-tutorial')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UpdateDeliveryTutorialResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return this.container.deliveryTutorials.update(scope, actor, id, body);
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.container.config.NODE_ENV === 'production');
    if (options.write === true) {
      assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    }
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      // A panel belongs to the TENANT, not to a bot.
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
