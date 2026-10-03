import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  AUTH_ROUTES,
  errors,
  IDENTITY_ERROR_CODES,
  LOGIN_CHALLENGE_TTL_SECONDS,
  SECOND_FACTOR_COOKIE_NAME,
  SECOND_FACTOR_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  type AdminSummary,
  type LoginOutcomeResponse,
  type LoginResponse,
  type LogoutResponse,
  type SessionResponse,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { ipThrottleSubject } from '../../infrastructure/trusted-proxy.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import {
  adminActor,
  anonymousActor,
  assertOriginAllowed,
  readChallengeToken,
  requireSessionToken,
} from './authenticated-request.js';
import type { LoginResult } from '../../modules/platform/identity/application/authentication.service.js';

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
  ): Promise<LoginOutcomeResponse> {
    // Login is state-changing: it mints a session and sets a cookie. It was the
    // one such route not checking Origin, on the reasoning that the classic
    // login-CSRF vectors are already closed — no CORS is configured, so a
    // cross-origin JSON POST fails preflight, and Fastify parses none of the
    // form content types a plain HTML form can send, so those get 415.
    //
    // That reasoning is correct and it is still the wrong place to rely on it.
    // It depends on two unrelated absences staying absent: add a CORS plugin or
    // a form-body parser for any reason, and login quietly becomes forgeable —
    // an attacker who knows any administrator's credentials could sign a
    // victim's browser into THEIR account and watch what the victim then does.
    // The invariant is cheaper to hold than to reason about per-route.
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);

    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const actor = anonymousActor(correlationId, request);
    const scope = this.installationScope();

    const outcome = await this.container.auth.signIn(
      scope,
      actor,
      body,
      this.loginContext(request),
    );

    if (outcome.kind === 'SECOND_FACTOR_REQUIRED') {
      // Phase D2. No session: a challenge, carried like the session — an httpOnly,
      // SameSite=Strict cookie the page script cannot read — and good for one short
      // window. The body says only that a code is owed, and until when.
      this.setChallengeCookie(reply, outcome.challengeToken);
      return { secondFactorRequired: true, expiresAt: outcome.expiresAt.toISOString() };
    }
    return this.signedIn(reply, outcome.result);
  }

  /**
   * The second step of a sign-in whose account has a second factor (Phase D2). The
   * challenge comes from the cookie the first step set; the body carries the code.
   */
  @Post('login/second-factor')
  async loginSecondFactor(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<LoginResponse> {
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);
    const challenge = readChallengeToken(request, this.isProduction);
    if (challenge === null) {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID,
        'The sign-in has expired. Enter your password again.',
      );
    }
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const result = await this.container.auth.completeSecondFactor(
      challenge,
      anonymousActor(correlationId, request),
      body,
      this.loginContext(request),
    );
    return this.signedIn(reply, result);
  }

  private loginContext(request: FastifyRequest) {
    return {
      // Null when the address cannot be believed as a client's — absent,
      // unparseable, or our own proxy's, which is what an installation running
      // behind Caddy with no TRUSTED_PROXY_IPS looks like. Throttling on that
      // would lock out every administrator on one attacker's failures.
      ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS),
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    };
  }

  private signedIn(reply: FastifyReply, result: LoginResult): LoginResponse {
    // The token leaves this method in exactly one place: the Set-Cookie header.
    // It is deliberately absent from the body — see loginResponseSchema.
    this.setSessionCookie(reply, result.token, result.session.expiresAt);
    // A challenge, if one was pending, is finished with either way.
    this.clearChallengeCookie(reply);
    return {
      expiresAt: result.session.expiresAt.toISOString(),
      admin: toSummary(result.admin, result.roleKeys),
      permissions: [...result.permissions],
    };
  }

  @Get('session')
  async session(@Req() request: FastifyRequest): Promise<SessionResponse> {
    const described = await this.container.auth.describeSession(
      requireSessionToken(request, this.isProduction),
    );
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
    const token = requireSessionToken(request, this.isProduction);
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);

    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };

    await this.container.auth.logout(
      scope,
      adminActor(admin, correlationId, request, session.id),
      session.id,
    );
    this.clearSessionCookie(reply);
    return { ok: true };
  }

  @Post('password')
  async changePassword(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const token = requireSessionToken(request, this.isProduction);
    assertOriginAllowed(request, this.container.config.WEB_ADMIN_ORIGINS);

    const { admin, session } = await this.container.auth.authenticate(token);
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };

    await this.container.adminManagement.changeOwnPassword(
      scope,
      adminActor(admin, correlationId, request, session.id),
      body,
      {
        // The same subject login throttles by, resolved the same way: null when
        // the address cannot be believed as a client's. The actor keeps the raw
        // address for the audit row; the counter must not.
        ip: ipThrottleSubject(request.ip, this.container.config.TRUSTED_PROXY_IPS),
      },
    );

    // A successful rotation revokes every session for this administrator,
    // including this one. Clearing the cookie is not the revocation — that
    // already committed with the password — it stops the browser presenting a
    // credential the server will now refuse, so the user sees a login form
    // instead of an unexplained 401 on their next click.
    this.clearSessionCookie(reply);
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

  /**
   * The name this deployment issues the session under.
   *
   * `__Host-` in production, where `Secure` is set and the prefix's conditions
   * can all be met. A plain-HTTP development server cannot offer `Secure`, and
   * a browser silently refuses a `__Host-` cookie without it — which would
   * present as "login succeeds and then nothing is signed in".
   */
  private get isProduction(): boolean {
    return this.container.config.NODE_ENV === 'production';
  }

  private get sessionCookieName(): string {
    return this.isProduction ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME;
  }

  private setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    const attributes = [
      `${this.sessionCookieName}=${encodeURIComponent(token)}`,
      // Required by the `__Host-` prefix, and correct without it: a narrower
      // path is what lets a shadowing cookie sort ahead of the real one.
      'Path=/',
      'HttpOnly',
      // Strict rather than Lax: this cookie authorises administrative writes,
      // and there is no cross-site navigation into the admin that needs it.
      'SameSite=Strict',
      `Expires=${expiresAt.toUTCString()}`,
    ];
    // Omitted outside production so a plain-HTTP development server can log in.
    // In production the config schema refuses any admin origin that is not
    // https, so a browser can always store this — an http origin would leave
    // login succeeding and authenticating nothing.
    if (this.isProduction) attributes.push('Secure');
    // Deliberately no `Domain`: it is what the prefix forbids, and what would
    // let a sibling host under a shared parent domain claim this cookie.
    void reply.header('set-cookie', attributes.join('; '));
  }

  /**
   * The login challenge (Phase D2): the session cookie's attributes, a five-minute
   * lifetime, and its own name — so nothing that reads the session cookie can ever be
   * handed a challenge instead.
   */
  private setChallengeCookie(reply: FastifyReply, token: string): void {
    const name = this.isProduction ? SECOND_FACTOR_COOKIE_NAME_SECURE : SECOND_FACTOR_COOKIE_NAME;
    const attributes = [
      `${name}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${LOGIN_CHALLENGE_TTL_SECONDS}`,
    ];
    if (this.isProduction) attributes.push('Secure');
    void reply.header('set-cookie', attributes.join('; '));
  }

  private clearChallengeCookie(reply: FastifyReply): void {
    for (const name of [SECOND_FACTOR_COOKIE_NAME_SECURE, SECOND_FACTOR_COOKIE_NAME]) {
      const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
      if (this.isProduction) attributes.push('Secure');
      void reply.header('set-cookie', attributes.join('; '));
    }
  }

  private clearSessionCookie(reply: FastifyReply): void {
    // Both spellings, because a deployment that has just moved to production
    // may still have the unprefixed cookie in a browser, and clearing only the
    // one it now issues would leave the old one presented on every request.
    for (const name of [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME]) {
      const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
      if (this.isProduction) attributes.push('Secure');
      void reply.header('set-cookie', attributes.join('; '));
    }
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
