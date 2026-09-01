import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  AUTH_ROUTES,
  errors,
  IDENTITY_ERROR_CODES,
  SESSION_COOKIE_NAME,
  type AdminSummary,
  type LoginResponse,
  type LogoutResponse,
  type SessionResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import {
  adminActor,
  anonymousActor,
  assertOriginAllowed,
  requireSessionToken,
  usedCookieAuth,
} from './authenticated-request.js';

/**
 * The Web Admin authentication surface.
 *
 * A controller stays presentation: read the request, call the service, map the
 * result. Every security decision — whether the credentials are right, whether
 * the account is usable, whether the caller is being throttled — is taken by
 * the application service, so the Telegram admin surface added later gets the
 * same answers without reimplementing any of them.
 */
@Controller(`${API_PREFIX}/auth`)
export class AuthController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('login')
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<LoginResponse> {
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const actor = anonymousActor(correlationId, request);
    const scope = this.installationScope();

    const result = await this.container.auth.login(scope, actor, body, {
      ip: request.ip ?? null,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });

    this.setSessionCookie(reply, result.token, result.session.expiresAt);

    return {
      token: result.token,
      expiresAt: result.session.expiresAt.toISOString(),
      admin: toSummary(result.admin, result.roleKeys),
      permissions: [...result.permissions],
    };
  }

  @Get('session')
  async session(@Req() request: FastifyRequest): Promise<SessionResponse> {
    const described = await this.container.auth.describeSession(requireSessionToken(request));
    return {
      admin: toSummary(described.admin, described.roleKeys),
      // Sent so the UI can hide chrome it cannot use. It is never the basis of
      // an authorization decision: every endpoint re-checks server-side.
      permissions: [...described.permissions],
      expiresAt: described.session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResponse> {
    const token = requireSessionToken(request);
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS, usedCookieAuth(request));

    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };

    await this.container.auth.logout(scope, adminActor(admin, correlationId, request), session.id);
    this.clearSessionCookie(reply);
    return { ok: true };
  }

  @Post('password')
  async changePassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const token = requireSessionToken(request);
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS, usedCookieAuth(request));

    const { admin } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };

    await this.container.adminManagement.changeOwnPassword(
      scope,
      adminActor(admin, correlationId, request),
      body,
    );
    return { ok: true };
  }

  /**
   * The tenant a Web Admin login belongs to.
   *
   * One installation serves one primary tenant (ADR-0001), so the login surface
   * resolves it rather than taking it from the request. A tenant id supplied by
   * the caller would let anyone choose which tenant to attack.
   */
  private installationScope(): TenantContext {
    const tenantId = this.container.installationTenantId;
    if (tenantId === null) {
      throw errors.configuration(
        IDENTITY_ERROR_CODES.AUTH_REQUIRED,
        'No primary tenant is provisioned for this installation.',
      );
    }
    return { tenantId, botInstanceId: null };
  }

  private setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    const attributes = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      // Strict rather than Lax: this cookie authorises administrative writes,
      // and there is no cross-site navigation into the admin that needs it.
      'SameSite=Strict',
      `Expires=${expiresAt.toUTCString()}`,
    ];
    // Omitted outside production so a plain-HTTP development server can log in;
    // the config schema requires TLS-fronted origins in production.
    if (this.container.config.NODE_ENV === 'production') attributes.push('Secure');
    void reply.header('set-cookie', attributes.join('; '));
  }

  private clearSessionCookie(reply: FastifyReply): void {
    void reply.header(
      'set-cookie',
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  }
}

export function toSummary(
  admin: {
    id: string;
    username: string;
    displayName: string;
    status: string;
    telegramUserId: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  },
  roleKeys: readonly string[],
): AdminSummary {
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    status: admin.status as AdminSummary['status'],
    telegramUserId: admin.telegramUserId,
    roleKeys: [...roleKeys],
    createdAt: admin.createdAt.toISOString(),
    lastLoginAt: admin.lastLoginAt === null ? null : admin.lastLoginAt.toISOString(),
  };
}

/** Route constants are exported for the tests, so a rename cannot silently pass. */
export const AUTH_PATHS = AUTH_ROUTES;
