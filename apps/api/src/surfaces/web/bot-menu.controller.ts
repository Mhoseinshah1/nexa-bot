import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BOT_MENU_ROUTES,
  checkBotMenuRequestSchema,
  syncBotMenuRequestSchema,
  type BotMenuConfigResponse,
  type CheckBotMenuResponse,
  type SyncBotMenuResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The bot's menu — the keyboard's items beside every bot's command-menu sync state — at
 * `/bot-menu` (round P, `docs/command-menu-audit.md`).
 *
 * One read and two acts. The arrangement is NOT written here: the page saves
 * `bot.main_menu` through `/settings/:key`, versioned and audited there, and the labels
 * through `/templates`. Both acts send the bot's credential to Telegram; neither takes a
 * URL, a token or a command list from the request — the list is the tenant's own,
 * rendered server-side from `BOT_COMMANDS`.
 *
 * Authentication happens here; AUTHORIZATION does not — `BotMenuService` charges
 * `settings.view` and `settings.edit` itself.
 */
@Controller(`${API_PREFIX}`)
export class BotMenuController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(BOT_MENU_ROUTES.config)
  async config(@Req() request: FastifyRequest): Promise<BotMenuConfigResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botMenu.config(scope, actor);
  }

  @Post(BOT_MENU_ROUTES.sync)
  async sync(@Req() request: FastifyRequest, @Body() body: unknown): Promise<SyncBotMenuResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = syncBotMenuRequestSchema.parse(body);
    return this.container.botMenu.resync(scope, actor, input);
  }

  /** A POST because it acts — it sends the credential to Telegram — though it writes nothing. */
  @Post(BOT_MENU_ROUTES.check)
  async check(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CheckBotMenuResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = checkBotMenuRequestSchema.parse(body ?? {});
    return this.container.botMenu.check(scope, actor, input);
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
