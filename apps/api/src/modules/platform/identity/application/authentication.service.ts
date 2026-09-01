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
  type UnitOfWork,
} from '@nexa/contracts';
import type {
  AdminRepository,
  LoginThrottleRepository,
  RoleRepository,
  SessionRepository,
  ThrottleState,
} from './ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
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
  /**
   * The subject to throttle by IP, already resolved against the trusted-proxy
   * configuration — null when the address is unusable (absent, unparseable, or
   * our own proxy's). The surface resolves it, because deciding whether an
   * address can be believed is a transport question.
   */
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
    private readonly uow: UnitOfWork<TransactionScope>,
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

    // The attempt is counted NOW, before the verification, not after it fails.
    //
    // The check above only reads. A concurrent burst therefore all passed it
    // while the counters were still empty, and every request queued a
    // production-cost scrypt derivation — deliberately memory-heavy — so one
    // unauthenticated burst could saturate the crypto pool long after the
    // configured limit had been crossed. Reserving first makes the Nth request
    // in that burst see its own increment and be refused before it hashes.
    //
    // A successful login gives the reservation back below.
    const reserved = await this.reserveAttempt(scope, actor, username, context.ip);

    // A username that could never exist is rejected before touching the
    // database, but only AFTER the throttle check — otherwise the cheap
    // rejection is itself a signal about which strings are worth trying.
    const shaped = adminUsernameSchema.safeParse(username);
    if (!shaped.success) {
      await this.hasher.spendDummyWork();
      return this.failLogin(scope, actor, username, reserved, 'NO_SUCH_ADMIN');
    }

    const credentials = await this.admins.findCredentialsByUsername(scope, username);

    if (credentials === null) {
      // Spend the same work a real verification costs. Without this, "no such
      // username" returns as fast as the database can say no while "wrong
      // password" takes a full hash, and the difference is a username oracle
      // that identical error text does nothing to hide.
      await this.hasher.spendDummyWork();
      return this.failLogin(scope, actor, username, reserved, 'NO_SUCH_ADMIN');
    }

    const passwordMatches = await this.hasher.verify(command.password, credentials.passwordHash);
    if (!passwordMatches) {
      // A stored hash below current cost verifies FASTER than the dummy work an
      // unknown username spends, so after a cost increase the difference says
      // which usernames exist — until each one happens to log in and be
      // rehashed. Topping the cheap verification up to a full current-profile
      // derivation removes the signal.
      if (this.hasher.needsRehash(credentials.passwordHash)) {
        await this.hasher.spendDummyWork();
      }
      return this.failLogin(scope, actor, username, reserved, 'BAD_PASSWORD');
    }

    // Checked AFTER the password, so a disabled account cannot be distinguished
    // from an active one without already knowing the password.
    if (credentials.admin.status !== 'ACTIVE') {
      return this.failLogin(scope, actor, username, reserved, 'ADMIN_DISABLED');
    }

    // The password was correct and the cost profile has since been raised, so
    // re-store it at current strength. The only moment the plaintext exists is
    // the only moment this is possible.
    //
    // Compare-and-set, for exactly the reason `changeOwnPassword` uses one: the
    // hash below takes as long as scrypt is configured to take, and a rotation
    // can commit inside that window. An unconditional write here would replace
    // the freshly rotated credential with a re-hash of the OLD password —
    // silently reverting a rotation whose audit row and event both say SUCCESS,
    // and leaving live the credential the administrator believed they had
    // replaced.
    //
    // A rehash that loses simply does not need to happen: the winning rotation
    // already stored a hash at current cost.
    if (this.hasher.needsRehash(credentials.passwordHash)) {
      const rehashed = await this.hasher.hash(command.password);
      await this.admins.compareAndSetPasswordHash(
        scope,
        credentials.admin.id,
        credentials.passwordHash,
        rehashed,
        now,
      );
    }

    const token = generateSessionToken();
    const sessionId = this.ids.uuid() as AdminSessionId;
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000);

    // The session is bound to the credential that authorised it.
    //
    // Verification happened outside any transaction — scrypt is slow by design
    // — so a rotation can commit in the gap. It revokes every session that
    // EXISTS at that moment; a session inserted afterwards from the old
    // password was not one of them, and survived. Rotation would then have
    // failed at the one thing it is for: ending access by a compromised
    // credential.
    //
    // `FOR UPDATE` on the predicate serialises this against the rotation's own
    // compare-and-set, so whichever runs first, the other sees the committed
    // outcome rather than a snapshot: either the session is created before the
    // rotation and then revoked by it, or the credential is already gone and no
    // session is created at all.
    const issued = await this.uow.run(scope, async (tx) => {
      const stillCurrent = await this.admins.lockIfPasswordHashMatches(
        scope,
        credentials.admin.id,
        credentials.passwordHash,
        tx,
      );
      if (!stillCurrent) return false;

      await this.sessions.create(
        scope,
        {
          id: sessionId,
          adminId: credentials.admin.id,
          tokenHash: hashSessionToken(token),
          issuedAt: now,
          expiresAt,
          ip: context.ip,
          userAgent: context.userAgent,
        },
        tx,
      );
      return true;
    });

    if (!issued) {
      // The password changed under us. Reported as an ordinary credential
      // failure, because from the caller's side that is exactly what it is:
      // the password they presented is no longer the account's password.
      return this.failLogin(scope, actor, username, reserved, 'BAD_PASSWORD');
    }

    // Only now, having actually authenticated. The USERNAME counter is erased —
    // the account holder proved who they are. The IP reservation is merely
    // GIVEN BACK: clearing it would let anyone with one valid account spray
    // guesses across administrator names and reset the breadth limiter by
    // periodically signing into their own.
    await this.throttle.clear(scope, 'USERNAME', username);
    if (context.ip !== null) await this.throttle.releaseAttempt(scope, 'IP', context.ip);

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
  /**
   * Counts this attempt against both subjects and refuses if it crosses a limit.
   *
   * Called before the verification, so the reservation is what stops a burst
   * rather than the count that follows it.
   */
  private async reserveAttempt(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    ip: string | null,
  ): Promise<ThrottleState> {
    const now = this.clock.now();

    const usernameState = await this.throttle.reserveAttempt(scope, 'USERNAME', username, now, {
      windowSeconds: this.policy.windowSeconds,
      maxAttempts: this.policy.maxAttemptsPerUsername,
      lockoutSeconds: this.policy.lockoutSeconds,
    });
    const ipState =
      ip === null
        ? null
        : await this.throttle.reserveAttempt(scope, 'IP', ip, now, {
            windowSeconds: this.policy.windowSeconds,
            maxAttempts: this.policy.maxAttemptsPerIp,
            lockoutSeconds: this.policy.lockoutSeconds,
          });

    // This attempt is the one that crossed the line. Refused here, before the
    // KDF runs, which is the whole point of reserving.
    for (const [kind, state] of [
      ['USERNAME', usernameState],
      ['IP', ipState],
    ] as const) {
      if (state?.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
        await this.recordThrottleDenial(scope, actor, username);
        // Recorded here rather than on the failure path, because the failure
        // path is no longer reached once a subject locks: reserving refuses the
        // attempt before it is verified. Repeated lockouts are worth alerting
        // on and cannot be if nothing writes them down.
        await this.opsLog.record(scope, {
          code: 'auth.login_locked_out',
          severity: 'WARN',
          message: `Login attempts were locked out for a ${kind.toLowerCase()} subject.`,
          context: { username, subjectKind: kind, failedCount: state.failedCount },
          dedupeKey: `auth.login_locked_out:${kind}:${kind === 'USERNAME' ? username : (ip ?? '')}`,
          correlationId: actor.correlationId,
        });
        throw new NexaError({
          kind: 'RATE_LIMITED',
          code: IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED,
          message: 'Too many attempts. Try again later.',
          details: {
            retryAfterSeconds: Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000),
          },
        });
      }
    }

    return usernameState;
  }

  private async recordThrottleDenial(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
  ): Promise<void> {
    await this.audit.record(scope, actor, {
      action: 'auth.login',
      entityType: 'Admin',
      entityId: null,
      before: null,
      after: { username, reason: 'THROTTLED' satisfies LoginFailureReason },
      result: 'DENIED',
    });
  }

  private async failLogin(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    usernameState: ThrottleState,
    reason: LoginFailureReason,
  ): Promise<never> {
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
