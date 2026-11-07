import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  type HostedActivationLinkResponse,
  type HostedActivationResponse,
  type HostedActivationView,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin, readHostingSectionToken } from './authenticated-request.js';

/**
 * Phase 6A PR-4 (D2): the creator panel's activation of a hosted bot over HTTP
 * (`HOSTING_ACTIVATION_ROUTES`), beside `HostingController` and under the same prefix.
 *
 * Presentation only. The installation owner, the section session, the fresh code, the steps and
 * their idempotency are `HostedActivationService`'s. The responses carry statuses and closed
 * error codes; the one that carries a secret (the link) is never cached.
 */
@Controller(`${API_PREFIX}/hosting`)
export class HostingActivationController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('bots/:tenantId/activation')
  async status(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
  ): Promise<HostedActivationView> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedActivation.status(scope, actor, this.token(request), tenantId);
  }

  @Post('bots/:tenantId/activation/configure')
  @HttpCode(200)
  async configure(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedActivationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    // The request body carries a bot token; nothing about it is ever cached.
    void reply.header('cache-control', 'no-store');
    return this.container.hostedActivation.configure(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  @Post('bots/:tenantId/activation/steps/:step')
  @HttpCode(200)
  async runStep(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Param('step') step: string,
    @Body() body: unknown,
  ): Promise<HostedActivationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hostedActivation.runStep(
      scope,
      actor,
      this.token(request),
      tenantId,
      step,
      body,
    );
  }

  @Post('bots/:tenantId/activation/link')
  @HttpCode(200)
  async link(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedActivationLinkResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    // The one-time link is in this response: shown once, never cached.
    void reply.header('cache-control', 'no-store');
    return this.container.hostedActivation.issueLink(
      scope,
      actor,
      this.token(request),
      tenantId,
      body,
    );
  }

  private token(request: FastifyRequest): string | null {
    return readHostingSectionToken(request, this.container.config.NODE_ENV === 'production');
  }
}
