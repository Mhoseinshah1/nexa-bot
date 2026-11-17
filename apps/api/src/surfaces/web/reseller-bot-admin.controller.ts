import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type HostedActivationResponse,
  type ResellerBotRequestAdminResponse,
  type ResellerBotRequestsAdminResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin, readHostingSectionToken } from './authenticated-request.js';

/**
 * Reseller-phase PR-6: «میزبانی‌ها» → «درخواست‌های نماینده‌ها» over HTTP
 * (`RESELLER_BOT_ADMIN_ROUTES`), under the creator panel's prefix.
 *
 * Presentation only. The installation owner, the section session, the fresh code, the wallet
 * debit and the idempotency are `ResellerBotRequestService`'s. No response carries a token.
 */
@Controller(`${API_PREFIX}/hosting/reseller-bot-requests`)
export class ResellerBotAdminController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerBotRequestsAdminResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.resellerBots.adminList(scope, actor, this.token(request), query);
  }

  @Post(':requestId/approve')
  @HttpCode(200)
  async approve(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ResellerBotRequestAdminResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.resellerBots.approve(scope, actor, this.token(request), requestId, body);
  }

  @Post(':requestId/reject')
  @HttpCode(200)
  async reject(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ResellerBotRequestAdminResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.resellerBots.reject(scope, actor, this.token(request), requestId, body);
  }

  @Post(':requestId/configure')
  @HttpCode(200)
  async configure(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<HostedActivationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    void reply.header('cache-control', 'no-store');
    return this.container.resellerBots.configureActivation(
      scope,
      actor,
      this.token(request),
      requestId,
      body,
    );
  }

  private token(request: FastifyRequest): string | null {
    return readHostingSectionToken(request, this.container.config.NODE_ENV === 'production');
  }
}
