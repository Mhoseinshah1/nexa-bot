import {
  adminUsernameSchema,
  errors,
  IDENTITY_ERROR_CODES,
  NexaError,
  loginRequestSchema,
  type ActorContext,
  type Admin,
  type AdminId,
  type AdminSession,
  type AdminSessionId,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type LoginFailureReason,
  type OperationalEventRecorder,
  type PasswordHasher,
  type PermissionKey,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type {
  AdminRepository,
  LoginThrottleRepository,
  RoleRepository,
  SessionRepository,
} from './ports.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';

/**
 * Web Admin authentication: username and password.
 *
 * The Telegram Login Widget is deliberately NOT the Web Admin credential
 * (ADR-0013). Everything here follows from three rules:
 *
 *   1. A failed login reports ONE thing. Unknown username, wrong password and
 *      disabled account produce the same error, the same status and — because
 *      an unknown username still spends a full hash — close to the same time.
 *      The audit row records which it actually was.
 *   2. Throttling is keyed on what was SUBMITTED, so it cannot become the
 *      account oracle that the error text refuses to be.
 *   3. Sessions carry identity, never authority. Permissions are resolved per
 *      request, so a revoked role stops applying immediately.
 */

export interface LoginContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuthenticatedAdmin {
  readonly admin: Admin;
  readonly session: AdminSession;
  readonly permissions: readonly PermissionKey[];
  readonly roleKeys: readonly string[];
}

export interface LoginResult extends AuthenticatedAdmin {
  /** Returned exactly once. Only its hash is ever stored. */
  readonly token: string;
}

export interface ThrottlePolicy {
  readonly windowSeconds: number;
  readonly maxAttemptsPerUsername: number;
  readonly maxAttemptsPerIp: number;
  readonly lockoutSeconds: number;
}

export class AuthenticationService {
  constructor(
    private readonly admins: AdminRepository,
    private readonly roles: RoleRepository,
    private readonly sessions: SessionRepository,
    private readonly throttle: LoginThrottleRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly opsLog: OperationalEventRecorder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly sessionTtlSeconds: number,
    private readonly policy: ThrottlePolicy,
  ) {}

  async login(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    context: LoginContext,
  ): Promise<LoginResult> {
    const command = loginRequestSchema.parse(input);
    // Case-folded at the boundary, so `Owner` and `owner` are one account and
    // one throttle subject rather than two of each.
    const username = command.username.trim().toLowerCase();
    const now = this.clock.now();

    await this.assertNotThrottled(scope, actor, username, context.ip);

    // A username that could never exist is rejected before touching the
    // database, but only AFTER the throttle check — otherwise the cheap
    // rejection is itself a signal about which strings are worth trying.
    const shaped = adminUsernameSchema.safeParse(username);
    if (!shaped.success) {
      await this.hasher.spendDummyWork();
      return this.failLogin(scope, actor, username, context, 'NO_SUCH_ADMIN');
    }

    const credentials = await this.admins.findCredentialsByUsername(scope, username);

    if (credentials === null) {
      // Spend the same work a real verification costs. Without this, "no such
      // username" returns as fast as the database can say no while "wrong
      // password" takes a full hash, and the difference is a username oracle
      // that identical error text does nothing to hide.
      await this.hasher.spendDummyWork();
      return this.failLogin(scope, actor, username, context, 'NO_SUCH_ADMIN');
    }

    const passwordMatches = await this.hasher.verify(command.password, credentials.passwordHash);
    if (!passwordMatches) {
      return this.failLogin(scope, actor, username, context, 'BAD_PASSWORD');
    }

    // Checked AFTER the password, so a disabled account cannot be distinguished
    // from an active one without already knowing the password.
    if (credentials.admin.status !== 'ACTIVE') {
      return this.failLogin(scope, actor, username, context, 'ADMIN_DISABLED');
    }

    // The password was correct and the cost profile has since been raised, so
    // re-store it at current strength. The only moment the plaintext exists is
    // the only moment this is possible.
    if (this.hasher.needsRehash(credentials.passwordHash)) {
      const rehashed = await this.hasher.hash(command.password);
      await this.admins.setPasswordHash(scope, credentials.admin.id, rehashed, now);
    }

    await Promise.all([
      this.throttle.clear(scope, 'USERNAME', username),
      context.ip === null ? Promise.resolve() : this.throttle.clear(scope, 'IP', context.ip),
    ]);

    const token = generateSessionToken();
    const sessionId = this.ids.uuid() as AdminSessionId;
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000);

    await this.sessions.create(scope, {
      id: sessionId,
      adminId: credentials.admin.id,
      tokenHash: hashSessionToken(token),
      issuedAt: now,
      expiresAt,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await this.admins.recordLogin(scope, credentials.admin.id, now);

    const identifiedActor = actorFor(actor, credentials.admin);
    await this.audit.record(scope, identifiedActor, {
      action: 'auth.login',
      entityType: 'Admin',
      entityId: credentials.admin.id,
      before: null,
      // No token, no hash, no password material of any kind.
      after: { sessionId, expiresAt: expiresAt.toISOString() },
      result: 'SUCCESS',
    });

    const [permissions, roleKeys] = await Promise.all([
      this.roles.permissionsForAdmin(scope, credentials.admin.id),
      this.admins.roleKeysFor(scope, credentials.admin.id),
    ]);

    return {
      token,
      admin: credentials.admin,
      session: {
        id: sessionId,
        tenantId: scope.tenantId,
        adminId: credentials.admin.id,
        issuedAt: now,
        expiresAt,
        lastSeenAt: now,
        revokedAt: null,
      },
      permissions,
      roleKeys,
    };
  }

  /**
   * Resolves a presented session token to an authenticated administrator.
   *
   * Called on every authenticated request. An expired, revoked or unknown token
   * and a disabled admin all produce the same UNAUTHENTICATED failure.
   */
  async authenticate(token: string): Promise<{ session: AdminSession; admin: Admin }> {
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));
    const now = this.clock.now();

    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }

    const scope: TenantContext = { tenantId: session.tenantId, botInstanceId: null };
    const admin = await this.admins.findById(scope, session.adminId);

    if (admin === null || admin.status !== 'ACTIVE') {
      // Disabling revokes on the spot rather than at session expiry: authority
      // is resolved per request, and so is the right to hold a session at all.
      await this.sessions.revoke(session.id, now, 'admin_not_active');
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
        'The session is not valid. Sign in again.',
      );
    }

    await this.sessions.touch(session.id, now);
    return { session, admin };
  }

  /**
   * Everything a surface needs to render a signed-in administrator.
   *
   * The permission list here is for DISPLAY — hiding chrome the admin cannot
   * use. It is deliberately produced by this service rather than assembled in a
   * controller, so no surface calls a permission resolver directly and the
   * boundary check can say so without exceptions. Every endpoint still
   * re-checks server-side; a UI that hides a button has authorized nothing.
   */
  async describeSession(token: string): Promise<AuthenticatedAdmin> {
    const { admin, session } = await this.authenticate(token);
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };

    const [permissions, roleKeys] = await Promise.all([
      this.roles.permissionsForAdmin(scope, admin.id),
      this.admins.roleKeysFor(scope, admin.id),
    ]);

    return { admin, session, permissions, roleKeys };
  }

  async logout(scope: ScopeContext, actor: ActorContext, sessionId: AdminSessionId): Promise<void> {
    const now = this.clock.now();
    await this.sessions.revoke(sessionId, now, 'logout');
    await this.audit.record(scope, actor, {
      action: 'auth.logout',
      entityType: 'Admin',
      entityId: actor.id,
      before: null,
      after: { sessionId },
      result: 'SUCCESS',
    });
  }

  private async assertNotThrottled(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    ip: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    const subjects: ['USERNAME' | 'IP', string][] = [['USERNAME', username]];
    if (ip !== null) subjects.push(['IP', ip]);

    for (const [kind, subject] of subjects) {
      const state = await this.throttle.find(scope, kind, subject);
      if (state?.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
        const retryAfterSeconds = Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000);
        await this.audit.record(scope, actor, {
          action: 'auth.login',
          entityType: 'Admin',
          entityId: null,
          before: null,
          after: { username, reason: 'THROTTLED' satisfies LoginFailureReason, subjectKind: kind },
          result: 'DENIED',
        });
        throw new NexaError({
          kind: 'RATE_LIMITED',
          code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED,
          message: 'Too many attempts. Try again later.',
          details: { retryAfterSeconds },
        });
      }
    }
  }

  /**
   * Records the failure and throws the single generic error.
   *
   * `reason` reaches the audit log and the operational log. It never reaches
   * the caller: the returned type is `never` precisely so no call site can
   * accidentally branch on which kind of failure it was.
   */
  private async failLogin(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    context: LoginContext,
    reason: LoginFailureReason,
  ): Promise<never> {
    const now = this.clock.now();

    const usernameState = await this.throttle.recordFailure(scope, 'USERNAME', username, now, {
      windowSeconds: this.policy.windowSeconds,
      maxAttempts: this.policy.maxAttemptsPerUsername,
      lockoutSeconds: this.policy.lockoutSeconds,
    });
    if (context.ip !== null) {
      await this.throttle.recordFailure(scope, 'IP', context.ip, now, {
        windowSeconds: this.policy.windowSeconds,
        maxAttempts: this.policy.maxAttemptsPerIp,
        lockoutSeconds: this.policy.lockoutSeconds,
      });
    }

    await this.audit.record(scope, actor, {
      action: 'auth.login',
      entityType: 'Admin',
      entityId: null,
      before: null,
      // The submitted username is recorded; the submitted password never is,
      // not even hashed and not even its length.
      after: { username, reason, failedCount: usernameState.failedCount },
      result: 'DENIED',
    });

    if (usernameState.lockedUntil !== null) {
      // Repeated failures against one account are worth alerting on, and cannot
      // be if nothing records them. Deduped per subject so a sustained attack
      // is one row with a counter rather than thousands.
      await this.opsLog.record(scope, {
        code: 'auth.login_locked_out',
        severity: 'WARN',
        message: 'Login attempts for an administrator username were locked out.',
        context: { username, failedCount: usernameState.failedCount },
        dedupeKey: `auth.login_locked_out:${username}`,
        correlationId: actor.correlationId,
      });
    }

    throw errors.unauthenticated(
      IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      'The username or password is incorrect.',
    );
  }
}

/** Re-labels an actor once the login has identified who they are. */
function actorFor(actor: ActorContext, admin: Admin): ActorContext {
  return { ...actor, type: 'WEB_ADMIN', id: admin.id, label: admin.username };
}

/** Narrow helper so a resolved admin id keeps its brand at call sites. */
export function adminIdOf(actor: ActorContext): AdminId | null {
  return actor.id === null ? null : (actor.id as AdminId);
}
