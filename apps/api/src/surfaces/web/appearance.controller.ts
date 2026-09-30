import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  APPEARANCE_ROUTES,
  routePattern,
  type AppearanceResponse,
  type AppearanceSlotMutationResponse,
  type AppearanceTestResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';

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
    const { scope, actor } = await this.authenticate(request);
    return this.container.appearance.view(scope, actor);
  }

  @Post(routePattern(APPEARANCE_ROUTES.slot, 'slot'))
  async saveSlot(
    @Req() request: FastifyRequest,
    @Param('slot') slot: string,
    @Body() body: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const { scope, actor } = await this.authenticate(request, true);
    return this.container.appearance.saveSlot(scope, actor, slot, body);
  }

  @Post(routePattern(APPEARANCE_ROUTES.slotReset, 'slot'))
  async resetSlot(
    @Req() request: FastifyRequest,
    @Param('slot') slot: string,
    @Body() body: unknown,
  ): Promise<AppearanceSlotMutationResponse> {
    const { scope, actor } = await this.authenticate(request, true);
    return this.container.appearance.resetSlot(scope, actor, slot, body);
  }

  /** A POST because it sends to Telegram and records what happened. */
  @Post(APPEARANCE_ROUTES.test)
  async test(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AppearanceTestResponse> {
    const { scope, actor } = await this.authenticate(request, true);
    return this.container.appearance.sendTest(scope, actor, body);
  }

  private async authenticate(
    request: FastifyRequest,
    write = false,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }
}
