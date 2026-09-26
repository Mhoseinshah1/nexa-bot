import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  BOT_ROUTES,
  replaceBotTokenRequestSchema,
  routePattern,
  setBotStatusRequestSchema,
  type BotDiagnosticResponse,
  type BotListResponse,
  type BotMutationResponse,
  type BotResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { adminActor, requireSessionToken } from './authenticated-request.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * This tenant's Telegram bot instances over HTTP, at `/bots` (WP13).
 *
 * Two reads and three acts. What is absent is recorded in
 * `docs/wp13-bots-management-audit.md` §3, and the two that a later convenience would
 * most likely add are the two this controller must never grow:
 *
 *   - a POST that CREATES a bot. The bootstrap is a CLI provisioning step, fenced from
 *     every surface by `scripts/check-boundaries.sh`; exposed here it would be a route
 *     that accepts a new bot token and writes a row.
 *   - a POST that registers a WEBHOOK. The API process does not know the public origin
 *     (ADR-0029), so it could only register a URL it had guessed.
 *
 * Authentication happens here; AUTHORIZATION does not — `BotManagementService` charges
 * `settings.view`, `settings.edit` and `settings.destructive` itself.
 */
@Controller(`${API_PREFIX}`)
export class BotsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(BOT_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<BotListResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botManagement.list(scope, actor);
  }

  @Get(routePattern(BOT_ROUTES.detail, 'id'))
  async detail(@Req() request: FastifyRequest, @Param('id') id: string): Promise<BotResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.botManagement.get(scope, actor, id);
  }

  @Post(routePattern(BOT_ROUTES.status, 'id'))
  async setStatus(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BotMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    const input = setBotStatusRequestSchema.parse(body);
    return this.container.botManagement.setStatus(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botId: id,
      status: input.status,
    });
  }

  /**
   * The token arrives in a JSON body over the session's TLS and goes nowhere but the
   * service. It is never echoed: the answer is the bot's view, which has no credential
   * field to carry it.
   */
  @Post(routePattern(BOT_ROUTES.token, 'id'))
  async replaceToken(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BotMutationResponse> {
    const { scope, actor } = await this.authenticate(request);
    // Only the key is parsed here. The token goes to the service UNPARSED, which
    // authorizes first and validates after, so a caller without `settings.destructive`
    // is answered 403 — and the refusal recorded — whatever the value looks like.
    const { idempotencyKey } = replaceBotTokenRequestSchema
      .pick({ idempotencyKey: true })
      .parse(body);
    return this.container.botManagement.replaceToken(scope, actor, {
      idempotencyKey,
      botId: id,
      token: (body as { readonly token?: unknown } | null)?.token,
    });
  }

  /** A POST because it acts — it sends the credential to Telegram — though it writes nothing. */
  @Post(routePattern(BOT_ROUTES.diagnostics, 'id'))
  async diagnose(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
  ): Promise<BotDiagnosticResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { diagnostic: await this.container.botManagement.diagnose(scope, actor, id) };
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
