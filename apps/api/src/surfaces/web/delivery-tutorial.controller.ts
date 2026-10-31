import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type DeliveryTutorialResponse,
  type UpdateDeliveryTutorialResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

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
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.deliveryTutorials.get(scope, actor, id);
  }

  @Post('panels/:id/delivery-tutorial')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UpdateDeliveryTutorialResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.deliveryTutorials.update(scope, actor, id, body);
  }
}
