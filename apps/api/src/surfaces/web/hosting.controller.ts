import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  HOSTING_SESSION_COOKIE_NAME,
  HOSTING_SESSION_COOKIE_NAME_SECURE,
  type CapacityLimitsResponse,
  type CapacitySetLimitResponse,
  type HostedBotPurgePreviewResponse,
  type HostedBotPurgeResponse,
  type HostedBotResponse,
  type HostedBotsResponse,
  type HostingActivateResponse,
  type HostingEnrolResponse,
  type HostingRecoveryCodesResponse,
  type HostingServerResponse,
  type HostingSessionResponse,
  type HostingStatusResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { ipThrottleSubject } from '../../infrastructure/trusted-proxy.js';
import { authenticateAdmin, readHostingSectionToken } from './authenticated-request.js';

/**
 * Phase 6A PR-3 (D1): the creator panel, «میزبانی‌ها», over HTTP (`HOSTING_ROUTES`).
 *
 * Presentation only. Every decision — the installation owner, the section session, the
 * fresh code, the state machine, the release gate — is `HostingSectionService` /
 * `HostingService`'s. The section session travels as its own httpOnly cookie, set here
 * and nowhere else, with the Web Admin session cookie's attributes.
 */
@Controller(`${API_PREFIX}/hosting`)
export class HostingController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get('status')
  async status(@Req() request: FastifyRequest): Promise<HostingStatusResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const section = await this.container.hostingSection.status(scope, actor, this.token(request));
    return { ...section, create: this.container.hosting.createGate() };
  }

  @Post('2fa/enrol')
  @HttpCode(200)
  async enrol(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<HostingEnrolResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    // The shared secret is in this body: never cached anywhere.
    void reply.header('cache-control', 'no-store');
    return this.container.hostingSection.enrol(scope, actor, body, {
      ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS),
    });
  }

  @Post('2fa/activate')
  @HttpCode(200)
  async activate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<HostingActivateResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const { opened, ...response } = await this.container.hostingSection.activate(
      scope,
      actor,
      body,
    );
    void reply.header('cache-control', 'no-store');
    this.setCookie(reply, opened.token, opened.expiresAt);
    return response;
  }

  @Post('2fa/recovery-codes')
  @HttpCode(200)
  async recoveryCodes(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<HostingRecoveryCodesResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    void reply.header('cache-control', 'no-store');
    return this.container.hostingSection.regenerateRecoveryCodes(
      scope,
      actor,
      this.token(request),
      body,
    );
  }

  @Post('session')
  @HttpCode(200)
  async openSession(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<HostingSessionResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const { opened, ...response } = await this.container.hostingSection.openSession(
      scope,
      actor,
      body,
    );
    this.setCookie(reply, opened.token, opened.expiresAt);
    return response;
  }

  @Post('session/close')
  @HttpCode(200)
  async closeSession(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ closed: number }> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const result = await this.container.hostingSection.closeSession(scope, actor);
    this.clearCookie(reply);
    return result;
  }

  @Get('bots')
  async list(@Req() request: FastifyRequest): Promise<HostedBotsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.list(scope, actor, this.token(request));
  }

  @Post('bots')
  @HttpCode(200)
  async create(@Req() request: FastifyRequest, @Body() body: unknown): Promise<HostedBotResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.create(scope, actor, this.token(request), body);
  }

  @Post('bots/:tenantId/suspend')
  @HttpCode(200)
  async suspend(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBotResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.suspend(scope, actor, this.token(request), tenantId, body);
  }

  @Post('bots/:tenantId/activate')
  @HttpCode(200)
  async activateBot(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBotResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.activate(scope, actor, this.token(request), tenantId, body);
  }

  @Post('bots/:tenantId/delete')
  @HttpCode(200)
  async delete(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBotResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.delete(scope, actor, this.token(request), tenantId, body);
  }

  @Get('bots/:tenantId/purge-preview')
  async purgePreview(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
  ): Promise<HostedBotPurgePreviewResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.purgePreview(scope, actor, this.token(request), tenantId);
  }

  @Post('bots/:tenantId/purge')
  @HttpCode(200)
  async purge(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBotPurgeResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.purge(scope, actor, this.token(request), tenantId, body);
  }

  @Post('bots/:tenantId/expiry')
  @HttpCode(200)
  async expiry(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<HostedBotResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.setExpiry(scope, actor, this.token(request), tenantId, body);
  }

  @Get('limits')
  async limits(@Req() request: FastifyRequest): Promise<CapacityLimitsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.limits(scope, actor, this.token(request));
  }

  @Post('bots/:tenantId/limits')
  @HttpCode(200)
  async setLimit(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<CapacitySetLimitResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.setLimit(scope, actor, this.token(request), tenantId, body);
  }

  @Post('bots/:tenantId/enter')
  @HttpCode(200)
  async enter(
    @Req() request: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<never> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.enter(scope, actor, this.token(request), tenantId, body);
  }

  @Get('server')
  async server(@Req() request: FastifyRequest): Promise<HostingServerResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.hosting.server(scope, actor, this.token(request));
  }

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  private token(request: FastifyRequest): string | null {
    return readHostingSectionToken(request, this.isProduction);
  }

  /** The Web Admin session cookie's attributes (`auth.controller.ts`), its own name. */
  private setCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    const name = this.isProduction
      ? HOSTING_SESSION_COOKIE_NAME_SECURE
      : HOSTING_SESSION_COOKIE_NAME;
    const attributes = [
      `${name}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Expires=${expiresAt.toUTCString()}`,
    ];
    if (this.isProduction) attributes.push('Secure');
    void reply.header('set-cookie', attributes.join('; '));
  }

  private clearCookie(reply: FastifyReply): void {
    for (const name of [HOSTING_SESSION_COOKIE_NAME_SECURE, HOSTING_SESSION_COOKIE_NAME]) {
      const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
      if (this.isProduction) attributes.push('Secure');
      void reply.header('set-cookie', attributes.join('; '));
    }
  }
}
