import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BOT_MENU_BUILDER_ROUTES,
  type BotMenuBuilderResponse,
  type MainMenuBuilderMutationResponse,
  type MainMenuRevisionListResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * Round T — the button builder at `/bot-menu/builder` (`docs/round-t-button-builder-audit.md`
 * §11.10). One read of the draft, the published layout and the server's gate answers; four
 * writes — save the draft, publish it, reset the draft, restore a revision INTO the draft —
 * and the paginated revision history.
 *
 * Authentication happens here; AUTHORIZATION, validation of the layout and the scope's
 * activity do not — `BotMenuBuilderService` charges `settings.view` / `settings.edit`
 * itself, inside the write's transaction. The labels are not written here: they stay the
 * `bot.menu.*` texts, saved through `/templates` and live immediately (OQ-T-1).
 */
@Controller(`${API_PREFIX}`)
export class BotMenuBuilderController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(BOT_MENU_BUILDER_ROUTES.view)
  async view(@Req() request: FastifyRequest): Promise<BotMenuBuilderResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.view(scope, actor);
  }

  @Put(BOT_MENU_BUILDER_ROUTES.draft)
  async saveDraft(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.saveDraft(scope, actor, body);
  }

  @Post(BOT_MENU_BUILDER_ROUTES.publish)
  async publish(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.publish(scope, actor, body);
  }

  @Post(BOT_MENU_BUILDER_ROUTES.reset)
  async reset(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.reset(scope, actor, body);
  }

  @Get(BOT_MENU_BUILDER_ROUTES.revisions)
  async revisions(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<MainMenuRevisionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.revisions(scope, actor, query);
  }

  @Post(BOT_MENU_BUILDER_ROUTES.restorePattern)
  async restore(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MainMenuBuilderMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenuBuilder.restore(scope, actor, id, body);
  }

  private async authenticate(
    request: FastifyRequest,
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
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
