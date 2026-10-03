import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  type AccountSecurityResponse,
  type AdminSessionListResponse,
  type BackupCodesResponse,
  type RevokeOtherSessionsResponse,
  type RevokeOwnSessionResponse,
  type SecurityEventListResponse,
  type TenantContext,
  type TotpEnrolResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { ipThrottleSubject } from '../../infrastructure/trusted-proxy.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import { adminActor, assertOriginAllowed, requireSessionToken } from './authenticated-request.js';

/**
 * The signed-in administrator's OWN security (Phase D2): two-step sign-in, backup codes,
 * their sessions and their history. Routes in `ACCOUNT_SECURITY_ROUTES`.
 *
 * Presentation only. Every decision — what proof an act needs, whether the session is
 * still live, what is audited — is the application service's, so no endpoint is
 * protected merely by not drawing a button. Every write checks Origin, like every other
 * write on this surface. Nothing a client can name selects the account: it is always
 * the session's own administrator.
 */
@Controller(`${API_PREFIX}/auth`)
export class AccountSecurityController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  @Get('security')
  async overview(@Req() request: FastifyRequest): Promise<AccountSecurityResponse> {
    const { scope, actor } = await this.authenticate(request);
    return this.container.accountSecurity.overview(scope, actor);
  }

  @Get('security/events')
  async events(@Req() request: FastifyRequest): Promise<SecurityEventListResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { events: [...(await this.container.accountSecurity.securityEvents(scope, actor))] };
  }

  /** The secret, once. `Cache-Control: no-store` so no intermediary keeps a copy. */
  @Post('security/totp/enrol')
  @HttpCode(200)
  async enrol(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<TotpEnrolResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    void reply.header('cache-control', 'no-store');
    return this.container.accountSecurity.enrolTotp(
      scope,
      actor,
      body,
      this.throttleContext(request),
    );
  }

  /** Backup codes, once — same `no-store`. */
  @Post('security/totp/activate')
  @HttpCode(200)
  async activate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<BackupCodesResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    void reply.header('cache-control', 'no-store');
    const result = await this.container.accountSecurity.activateTotp(scope, actor, body);
    return { backupCodes: result.backupCodes };
  }

  @Post('security/totp/disable')
  @HttpCode(200)
  async disable(@Req() request: FastifyRequest, @Body() body: unknown): Promise<{ ok: true }> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    await this.container.accountSecurity.disableTotp(
      scope,
      actor,
      body,
      this.throttleContext(request),
    );
    return { ok: true };
  }

  @Post('security/backup-codes/regenerate')
  @HttpCode(200)
  async regenerate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<BackupCodesResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    void reply.header('cache-control', 'no-store');
    return this.container.accountSecurity.regenerateBackupCodes(
      scope,
      actor,
      body,
      this.throttleContext(request),
    );
  }

  @Get('sessions')
  async sessions(@Req() request: FastifyRequest): Promise<AdminSessionListResponse> {
    const { scope, actor } = await this.authenticate(request);
    return { sessions: [...(await this.container.accountSecurity.listOwnSessions(scope, actor))] };
  }

  /**
   * Ends one of the caller's own sessions. When it is the CURRENT one, the cookie is
   * cleared as well — it is a sign-out, and the browser should stop presenting a
   * credential the server now refuses.
   */
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  async revoke(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<RevokeOwnSessionResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    const result = await this.container.accountSecurity.revokeOwnSession(scope, actor, id);
    if (result.current) this.clearSessionCookie(reply);
    return result;
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@Req() request: FastifyRequest): Promise<RevokeOtherSessionsResponse> {
    const { scope, actor } = await this.authenticate(request, { write: true });
    return { revoked: await this.container.accountSecurity.revokeOtherSessions(scope, actor) };
  }

  /** The throttle subject, resolved exactly as login resolves it. */
  private throttleContext(request: FastifyRequest) {
    return { ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS) };
  }

  private clearSessionCookie(reply: FastifyReply): void {
    for (const name of [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME]) {
      const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
      if (this.isProduction) attributes.push('Secure');
      void reply.header('set-cookie', attributes.join('; '));
    }
  }

  private async authenticate(
    request: FastifyRequest,
    options: { write?: boolean } = {},
  ): Promise<{ scope: TenantContext; actor: ReturnType<typeof adminActor> }> {
    const token = requireSessionToken(request, this.isProduction);
    if (options.write) assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    return {
      scope: { tenantId: admin.tenantId, botInstanceId: null },
      actor: adminActor(admin, correlationId, request, session.id),
    };
  }
}
