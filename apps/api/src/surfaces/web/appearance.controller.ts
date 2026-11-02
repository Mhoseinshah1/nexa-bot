import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  APPEARANCE_ROUTES,
  routePattern,
  type AppearanceResponse,
  type AppearanceSlotMutationResponse,
  type AppearanceTestResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

/**
 * «ظاهر ربات» over HTTP (Premium UI), at `/appearance`.
 *
 * One read and three acts. Authentication happens here; AUTHORIZATION does not —
 * `AppearanceService` charges `settings.view` and `settings.edit` itself. The test send
 * goes to the signed-in administrator's OWN Telegram chat, resolved from their binding,
 * never from a chat id in the request.
 */
@Controller(`${API_PREFIX}`)
export class AppearanceController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(APPEARANCE_ROUTES.view)
  async view(@Req() request: FastifyRequest): Promise<AppearanceResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.appearance.view(scope, actor);
  }

  @Post(routePattern(APPEARANCE_ROUTES.slot, 'slot'))
  async saveSlot(
    @Req() request: FastifyRequest,
    @Param('slot') slot: string,
    @Body() body: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.appearance.saveSlot(scope, actor, slot, body);
  }

  @Post(routePattern(APPEARANCE_ROUTES.slotReset, 'slot'))
  async resetSlot(
    @Req() request: FastifyRequest,
    @Param('slot') slot: string,
    @Body() body: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.appearance.resetSlot(scope, actor, slot, body);
  }

  /** A POST because it sends to Telegram and records what happened. */
  @Post(APPEARANCE_ROUTES.test)
  async test(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AppearanceTestResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.appearance.sendTest(scope, actor, body);
  }
}
