import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CAPACITY_ROUTES,
  type CapacityLimitsResponse,
  type CapacitySetLimitResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

/**
 * Phase 6A PR-2: the owner's per-bot capacity limits over HTTP, at `/capacity/limits`.
 *
 * The installation owner only: the service refuses every scope but the installation tenant's
 * and charges `settings.destructive` (`CapacityLimitsService`). Nothing is decided here. The
 * creator panel's page that calls these is PR-3.
 */
@Controller(`${API_PREFIX}`)
export class CapacityController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CAPACITY_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<CapacityLimitsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.capacityLimits.list(scope, actor);
  }

  @Post(CAPACITY_ROUTES.set)
  async set(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CapacitySetLimitResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.capacityLimits.set(scope, actor, body);
  }
}
