import {
  adminUsernameSchema,
  errors,
  IDENTITY_ERROR_CODES,
  isNexaError,
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
  type TenantId,
  type TenantStatus,
  type UnitOfWork,
} from '@nexa/contracts';
import type {
  AdminRepository,
  LoginThrottleRepository,
  RoleRepository,
  SessionRepository,
} from './ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import type { CredentialThrottle, Reservation } from './credential-throttle.js';
export type { ThrottlePolicy } from './credential-throttle.js';

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

/**
 * The slice of the tenant repository authentication needs.
 *
 * Declared here rather than depending on the whole repository: this module has
 * one question to ask about a tenant, and stating it as one method keeps the
 * dependency honest and the test double small.
 */
export interface TenantStatusReader {
  findById(id: TenantId): Promise<{ status: TenantStatus } | null>;
}

/**
 * The guard's own view of effective permissions, narrowed to what this module
 * asks of it: what does this actor hold, by the rule that will be enforced.
 */
export interface EffectivePermissionReader {
  permissionsOf(
    scope: ScopeContext,
    actor: ActorContext,
    tx?: unknown,
  ): Promise<ReadonlySet<PermissionKey>>;
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
    private readonly credentialThrottle: CredentialThrottle,
    private readonly tenants: TenantStatusReader,
    private readonly permissions: EffectivePermissionReader,
  ) {}

  /**
   * The permissions a surface may use to decide what chrome to render.
   *
   * Resolved by the SAME rule the guard enforces — `(roles ∪ GRANT) − DENY` —
   * rather than by reading the role union. The union ignores overrides in both
   * directions, so a granted administrator saw a button hidden and a denied one
   * saw a button that then answered 403. It authorizes nothing either way, but
   * a surface computing a concept differently from the layer that enforces it
   * is exactly the divergence this codebase is built to avoid.
   */
  private async displayPermissions(admin: Admin, tx?: unknown): Promise<readonly PermissionKey[]> {
    const scope: TenantContext = { tenantId: admin.tenantId, botInstanceId: null };
    const actor: ActorContext = {
      type: 'WEB_ADMIN',
      id: admin.id,
      label: admin.username,
      surface: 'WEB',
      correlationId: 'display-permissions' as never,
    };
    return [...(await this.permissions.permissionsOf(scope, actor, tx))].sort();
  }

  /**
   * Whether the tenant this request belongs to is still open for business.
   *
   * `STOPPED` and `DISABLED` were a tenant status that changed nothing: the
   * installation's tenant id was cached at boot, the permission resolver never
   * read the tenant row, and `TENANT_INACTIVE` was declared in the contracts
   * with no code that could ever emit it. A status nothing enforces is not a
   * kill switch, it is a label.
   */
  private async tenantIsActive(scope: TenantContext): Promise<boolean> {
    const tenant = await this.tenants.findById(scope.tenantId);
    return tenant !== null && tenant.status === 'ACTIVE';
  }

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
    // Everything from here to a credential VERDICT is wrapped: if it fails for
    // any other reason — the lookup times out, the KDF throws — the attempt was
    // never judged, so counting it is wrong. A transient database error would
    // otherwise be recorded as a failed login by somebody who never submitted
    // one, and at `LOGIN_MAX_ATTEMPTS_PER_USERNAME=1` would rate-limit the
    // correct user the moment the database recovered. The statement timeout
    // added for the tenant lock makes exactly this failure more likely, not
    // less.
    //
    // A verdict that IS reached keeps its reservation, including "no such
    // username": that is the failure the counter exists to count.
    let verdictReached = false;
    try {
      return await this.completeLogin(
        scope,
        actor,
        command,
        context,
        username,
        reserved,
        now,
        () => {
          verdictReached = true;
        },
      );
    } catch (error) {
      if (!verdictReached) {
        await this.releaseReservations(scope, username, context.ip, reserved);
      }
      throw error;
    }
  }

  /** The part of `login` that runs once an attempt has been reserved. */
  private async completeLogin(
    scope: TenantContext,
    actor: ActorContext,
    command: { username: string; password: string },
    context: LoginContext,
    username: string,
    reserved: Reservation,
    now: Date,
    verdict: () => void,
  ): Promise<LoginResult> {
    const shaped = adminUsernameSchema.safeParse(username);
    if (!shaped.success) {
      await this.hasher.spendDummyWork();
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'NO_SUCH_ADMIN');
    }

    const credentials = await this.admins.findCredentialsByUsername(scope, username);

    if (credentials === null) {
      // Spend the same work a real verification costs. Without this, "no such
      // username" returns as fast as the database can say no while "wrong
      // password" takes a full hash, and the difference is a username oracle
      // that identical error text does nothing to hide.
      await this.hasher.spendDummyWork();
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'NO_SUCH_ADMIN');
    }

    // A stored hash below current cost verifies FASTER than the dummy work an
    // unknown username spends, so after a cost increase the difference says
    // which usernames exist — until each happens to log in and be rehashed.
    //
    // Equalised by running the dummy derivation CONCURRENTLY with the real one
    // rather than after it: total elapsed becomes max(legacy, current) ≈ one
    // current-profile derivation, which is what an unknown username costs. An
    // earlier version added a full derivation afterwards, which made the total
    // nearly twice the unknown-username path — the same oracle, pointing the
    // other way.
    const belowCurrentCost = this.hasher.needsRehash(credentials.passwordHash);
    const [passwordMatches] = await Promise.all([
      this.hasher.verify(command.password, credentials.passwordHash),
      belowCurrentCost ? this.hasher.spendDummyWork() : Promise.resolve(),
    ]);

    // `verdict()` is NOT called here.
    //
    // It used to be, on the reasoning that the credential had been judged — but
    // a judged credential is not a disposed reservation. Everything below can
    // still throw for reasons that have nothing to do with the password: the
    // tenant read, the rehash, opening the transaction. Marking the attempt
    // judged here left those failures holding the count, so at a limit of 1 a
    // CORRECT password plus one transient error established a lock and rate
    // limited the administrator's retry once it cleared.
    //
    // Each outcome below therefore marks itself judged at the point it disposes
    // of its own reservation — keeping it, returning it, or clearing it with
    // the session — and anything unexpected in between still releases.
    if (!passwordMatches) {
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'BAD_PASSWORD');
    }

    // Checked AFTER the password, so a disabled account cannot be distinguished
    // from an active one without already knowing the password.
    if (credentials.admin.status !== 'ACTIVE') {
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'ADMIN_DISABLED');
    }

    // Same placement, same reason: an installation that has been stopped must
    // not answer differently before the password is known. Reported as the one
    // generic failure like every other reason; the audit row says which it was.
    if (!(await this.tenantIsActive(scope))) {
      // The reservations go back first. This attempt presented the RIGHT
      // password — the refusal is about the installation being paused, not
      // about them — and keeping it counted would lock an operator out of a
      // maintenance window by trying during it. At a limit of one, a single
      // correct attempt while stopped would leave them rate limited the moment
      // the tenant came back.
      //
      // A wrong password, or a disabled administrator, keeps its reservation:
      // those are failures against a real credential and are what the counter
      // exists to count.
      await this.releaseReservations(scope, username, context.ip, reserved);
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'TENANT_INACTIVE');
    }

    // The password was correct and the cost profile has since been raised, so
    // re-store it at current strength. Computed here, outside the transaction,
    // because it is intentionally slow; written below under the row lock, where
    // the old hash has just been confirmed still current.
    const rehashed = belowCurrentCost ? await this.hasher.hash(command.password) : null;

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
      // The tenant, before the credential. Checked earlier too, but that was
      // outside any transaction and the hash below is deliberately slow — a
      // stop can commit in between, return to the operator, and this would
      // still mint a session.
      //
      // I argued the other way one commit ago: that such a session is inert
      // because `authenticate` refuses it. That was wrong, and wrong against my
      // own decision — sessions are REFUSED, not revoked, precisely so they
      // survive a restart, which means one minted after the stop works the
      // moment the tenant comes back. Two decisions that contradicted each
      // other, and the ADR paragraph defending the boundary did not notice.
      //
      // `FOR SHARE`, so concurrent sign-ins do not queue behind one another;
      // only a status change waits.
      if ((await this.admins.lockTenantForRead(scope, tx)) !== 'ACTIVE') return 'TENANT_STOPPED';

      const stillCurrent = await this.admins.lockIfPasswordHashMatches(
        scope,
        credentials.admin.id,
        credentials.passwordHash,
        tx,
      );
      if (!stillCurrent) return 'CREDENTIAL_STALE';

      // Safe unconditionally here: the row is locked and its hash was just
      // confirmed to be the one this login verified. Doing it as a second
      // compare-and-set outside the transaction is what broke legacy accounts —
      // the rehash replaced the stored value, and the session predicate then
      // demanded the hash it had just overwritten, so every below-cost account
      // was refused its own correct password.
      if (rehashed !== null) {
        await this.admins.setPasswordHash(scope, credentials.admin.id, rehashed, now, tx);
      }

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
      // The bookkeeping commits WITH the session, not after it.
      //
      // Done afterwards, a transient failure in any of these left a live
      // session persisted while the caller got an error and never received the
      // token — and the throttle half made that user-visible rather than merely
      // untidy: at a limit of one, a failed `clear` leaves the successful
      // login's own lock standing, discards the only copy of the token, and
      // refuses the retry until the lockout expires.
      //
      // The USERNAME counter is erased — the account holder proved who they
      // are. The IP reservation is merely GIVEN BACK: clearing it would let
      // anyone with one valid account spray guesses across administrator names
      // and reset the breadth limiter by periodically signing into their own.
      await this.throttle.clear(scope, 'USERNAME', username, tx);
      if (context.ip !== null) {
        await this.throttle.releaseAttempt(
          scope,
          'IP',
          context.ip,
          this.credentialThrottle.maxAttemptsPerIp,
          (reserved.ip ?? reserved.username).windowStartedAt,
          tx,
        );
      }
      await this.admins.recordLogin(scope, credentials.admin.id, now, tx);

      // The SUCCESS audit commits with the session too.
      //
      // The previous round moved the throttle and `recordLogin` in and stopped
      // there, which left the most important row of the three outside: a login
      // whose audit insert failed committed a live session and recorded no
      // trace of it. "The database is the log" is not a property the happy path
      // can hold on its own.
      const identifiedActor = actorFor(actor, credentials.admin);
      await this.audit.record(
        scope,
        identifiedActor,
        {
          action: 'auth.login',
          entityType: 'Admin',
          entityId: credentials.admin.id,
          before: null,
          // No token, no hash, no password material of any kind.
          after: { sessionId, expiresAt: expiresAt.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );

      // Read on the locked connection, and SEQUENTIALLY: a transaction is one
      // connection, so issuing both at once on `Promise.all` would interleave
      // two statements on it. Read here rather than after the commit because
      // the response cannot be built without them — a failure out there
      // returned an error to a caller whose session had already been created,
      // and who therefore never received the token to a session that exists.
      const permissions = await this.displayPermissions(credentials.admin, tx);
      const roleKeys = await this.admins.roleKeysFor(scope, credentials.admin.id, tx);

      return { outcome: 'ISSUED' as const, permissions, roleKeys };
    });

    if (issued === 'TENANT_STOPPED' || issued === 'CREDENTIAL_STALE') {
      // Either the password changed under us, or the tenant stopped while we
      // hashed. Both are reported as an ordinary credential failure, because
      // from the caller's side the first is exactly that and the second must
      // not be distinguishable from it.
      //
      // WHICH of the two happened comes out of the transaction that decided it,
      // not from a second read afterwards. An earlier version re-read tenant
      // status here, outside the lock: a restart in that gap made a refusal
      // caused by the stop look like a wrong password, and the operator kept
      // the throttle reservations for a credential that was correct. Inferring
      // a locked decision from an unlocked read is the exact mistake the lock
      // was added to stop.
      if (issued === 'TENANT_STOPPED') {
        await this.releaseReservations(scope, username, context.ip, reserved);
        verdict();
        return await this.failLogin(scope, actor, username, reserved, 'TENANT_INACTIVE');
      }
      verdict();
      return await this.failLogin(scope, actor, username, reserved, 'BAD_PASSWORD');
    }

    // Issued: the transaction cleared the username counter and returned the IP
    // reservation as part of the same commit, so there is nothing left to
    // release and nothing after this point can fail.
    verdict();

    const { permissions, roleKeys } = issued;

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

    // A tenant that is stopped or disabled ends existing access too, not only
    // new logins — otherwise stopping an installation leaves every session
    // already open still able to mutate it until expiry. NOT revoked, unlike a
    // disabled administrator: a tenant can be started again, and the sessions
    // its operators held are not the thing that was suspended.
    if (!(await this.tenantIsActive(scope))) {
      // A DIFFERENT code from an invalid session, because the two call for
      // opposite responses: sign in again versus wait. Reported only to a
      // caller who already presented a valid session, so it tells them nothing
      // about an installation they could not already reach. The login path
      // stays generic.
      throw errors.unauthenticated(
        IDENTITY_ERROR_CODES.AUTH_TENANT_SUSPENDED,
        'This installation is paused. Try again once it has been started.',
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
      this.displayPermissions(admin),
      this.admins.roleKeysFor(scope, admin.id),
    ]);

    return { admin, session, permissions, roleKeys };
  }

  async logout(scope: ScopeContext, actor: ActorContext, sessionId: AdminSessionId): Promise<void> {
    const now = this.clock.now();
    // The revocation and its audit row commit together.
    //
    // Done in sequence, a failing audit insert returned an error to a caller
    // whose session was ALREADY revoked — so the surface never cleared the
    // cookie, the operator saw a failure, and the one record of a state change
    // that did happen was missing. Same shape as the login audit, in the method
    // beside it, which I fixed and did not look across at.
    await this.uow.run(scope, async (tx) => {
      await this.sessions.revoke(sessionId, now, 'logout', tx);
      await this.audit.record(
        scope,
        actor,
        {
          action: 'auth.logout',
          entityType: 'Admin',
          entityId: actor.id,
          before: null,
          after: { sessionId },
          result: 'SUCCESS',
        },
        tx,
      );
    });
  }

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
  ): Promise<Reservation> {
    try {
      return await this.credentialThrottle.reserve(scope, actor, username, ip);
    } catch (error) {
      // The refusal itself is shared; the AUDIT row is not. A refused login and
      // a refused password rotation are different actions and recording them as
      // the same one would make the trail lie about what was attempted.
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED) {
        const subjectKind = error.details['subjectKind'];
        await this.recordThrottleDenial(
          scope,
          actor,
          username,
          typeof subjectKind === 'string' ? subjectKind : null,
        );
      }
      throw error;
    }
  }

  /**
   * Returns both reservations this call made.
   *
   * Used only where the attempt is abandoned without being verified. A failure
   * that WAS verified keeps its reservation — that is the failure being counted.
   */
  private async releaseReservations(
    scope: TenantContext,
    username: string,
    ip: string | null,
    reserved: Reservation,
  ): Promise<void> {
    await this.credentialThrottle.release(scope, username, ip, reserved);
  }

  private async recordThrottleDenial(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    subjectKind: string | null,
  ): Promise<void> {
    await this.audit.record(scope, actor, {
      action: 'auth.login',
      entityType: 'Admin',
      entityId: null,
      before: null,
      after: {
        username,
        reason: 'THROTTLED' satisfies LoginFailureReason,
        ...(subjectKind === null ? {} : { subjectKind }),
      },
      result: 'DENIED',
    });
  }

  private async failLogin(
    scope: TenantContext,
    actor: ActorContext,
    username: string,
    reserved: Reservation,
    reason: LoginFailureReason,
  ): Promise<never> {
    const usernameState = reserved.username;
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
