import {
  adminUsernameSchema,
  errors,
  IDENTITY_ERROR_CODES,
  isNexaError,
  LOGIN_CHALLENGE_MAX_ATTEMPTS,
  LOGIN_CHALLENGE_TTL_SECONDS,
  loginRequestSchema,
  secondFactorProofSchema,
  type SecondFactorMethod,
  type SecretCipher,
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
  LoginChallengeRepository,
  LoginThrottleRepository,
  RoleRepository,
  SecondFactorRepository,
  SessionRepository,
} from './ports.js';
import {
  credentialFingerprint,
  verifySecondFactorProof,
  type ProofVerdict,
} from './second-factor-proof.js';
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
 * What a correct password produces (Phase D2): a session, or — for an account with an
 * active second factor — a challenge that only a valid code turns into one.
 */
export type SignInOutcome =
  | { readonly kind: 'SIGNED_IN'; readonly result: LoginResult }
  | {
      readonly kind: 'SECOND_FACTOR_REQUIRED';
      /** Returned exactly once, for the challenge cookie. Only its hash is stored. */
      readonly challengeToken: string;
      readonly expiresAt: Date;
    };

/** The rows the second factor needs. One object so the constructor stays legible. */
export interface SecondFactorDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: LoginChallengeRepository;
  readonly cipher: SecretCipher;
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
    private readonly secondFactor: SecondFactorDependencies,
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

  /**
   * Password-only sign-in, for callers that cannot carry a second step (the tests' and
   * scripts' convenience). An account with an active second factor is REFUSED here with
   * `auth.second_factor_required` — never signed in — so this method cannot become the
   * door that skips the factor. The HTTP surface calls `signIn`.
   */
  async login(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    context: LoginContext,
  ): Promise<LoginResult> {
    // `issueChallenge: false` (D2 review): for a 2FA account this answers
    // `auth.second_factor_required` having written NOTHING — no orphan challenge and no
    // SUCCESS audit row for a sign-in that did not happen.
    const outcome = await this.signIn(scope, actor, input, context, { issueChallenge: false });
    if (outcome.kind === 'SIGNED_IN') return outcome.result;
    throw secondFactorRequired();
  }

  async signIn(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    context: LoginContext,
    options: { readonly issueChallenge: boolean } = { issueChallenge: true },
  ): Promise<SignInOutcome> {
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
        options.issueChallenge,
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
    issueChallenge: boolean,
  ): Promise<SignInOutcome> {
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
      return await this.failLogin(
        scope,
        actor,
        username,
        reserved,
        'BAD_PASSWORD',
        credentials.admin.id,
      );
    }

    // Checked AFTER the password, so a disabled account cannot be distinguished
    // from an active one without already knowing the password.
    if (credentials.admin.status !== 'ACTIVE') {
      verdict();
      return await this.failLogin(
        scope,
        actor,
        username,
        reserved,
        'ADMIN_DISABLED',
        credentials.admin.id,
      );
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

      /*
       * Phase D2: an active second factor means this password opens a CHALLENGE, not a
       * session. Read on the locked connection, under the admin row lock taken just
       * above — activation takes the same lock, so a login and an activation serialise:
       * either the session exists first and activation's revocation ends it, or the
       * factor is active first and this sees it.
       */
      const factor = await this.secondFactor.factors.findFactor(scope, credentials.admin.id, tx);
      if (factor !== null && factor.state === 'ACTIVE') {
        /*
         * The password reservation is GIVEN BACK, not cleared. Clearing would erase
         * earlier second-factor failures, and somebody holding the password could then
         * reset the guess counter for six digits by signing in again between guesses.
         * Given back, a correct password costs nothing and every wrong CODE stays
         * counted; the counter is cleared only when the second factor succeeds.
         */
        await this.throttle.releaseAttempt(
          scope,
          'USERNAME',
          username,
          this.credentialThrottle.maxAttemptsPerUsername,
          reserved.username.windowStartedAt,
          tx,
        );
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
        if (!issueChallenge) return { outcome: 'FACTOR_REQUIRED' as const };
        const challengeToken = generateSessionToken();
        const challengeExpiresAt = new Date(now.getTime() + LOGIN_CHALLENGE_TTL_SECONDS * 1000);
        await this.secondFactor.challenges.create(
          scope,
          {
            id: this.ids.uuid(),
            adminId: credentials.admin.id,
            tokenHash: hashSessionToken(challengeToken),
            credentialFingerprint: credentialFingerprint(rehashed ?? credentials.passwordHash),
            issuedAt: now,
            expiresAt: challengeExpiresAt,
            ip: context.ip,
            userAgent: context.userAgent,
          },
          tx,
        );
        await this.audit.record(
          scope,
          actorFor(actor, credentials.admin),
          {
            action: 'auth.login_challenge',
            entityType: 'Admin',
            entityId: credentials.admin.id,
            before: null,
            after: { challengeExpiresAt: challengeExpiresAt.toISOString() },
            result: 'SUCCESS',
          },
          tx,
        );
        return { outcome: 'CHALLENGE' as const, challengeToken, challengeExpiresAt };
      }

      const issuedSession = await this.issueSessionInTransaction(
        scope,
        actor,
        credentials.admin,
        username,
        context,
        reserved,
        { sessionId, token, now, expiresAt, method: null },
        tx,
      );
      return { outcome: 'ISSUED' as const, ...issuedSession };
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

    if (issued.outcome === 'FACTOR_REQUIRED') {
      // Reservations given back in the transaction; nothing else was written.
      verdict();
      throw secondFactorRequired();
    }

    if (issued.outcome === 'CHALLENGE') {
      // The reservations went back inside the transaction that issued the challenge.
      verdict();
      return {
        kind: 'SECOND_FACTOR_REQUIRED',
        challengeToken: issued.challengeToken,
        expiresAt: issued.challengeExpiresAt,
      };
    }

    // Issued: the transaction cleared the username counter and returned the IP
    // reservation as part of the same commit, so there is nothing left to
    // release and nothing after this point can fail.
    verdict();

    const { permissions, roleKeys } = issued;

    return {
      kind: 'SIGNED_IN',
      result: sessionResult(token, credentials.admin, scope, sessionId, now, expiresAt, {
        permissions,
        roleKeys,
      }),
    };
  }

  /**
   * Inside the transaction that mints a session: the row, the throttle bookkeeping, the
   * last-login stamp, the SUCCESS audit and the display permissions — all committing
   * together. Shared by the password-only sign-in and the second-factor completion, so
   * there is one definition of what "signed in" writes.
   */
  private async issueSessionInTransaction(
    scope: TenantContext,
    actor: ActorContext,
    admin: Admin,
    username: string,
    context: LoginContext,
    reserved: Reservation,
    session: {
      readonly sessionId: AdminSessionId;
      readonly token: string;
      readonly now: Date;
      readonly expiresAt: Date;
      /** The second factor that completed this sign-in, or null for a password-only one. */
      readonly method: SecondFactorMethod | null;
    },
    tx: TransactionScope,
  ): Promise<{ permissions: readonly PermissionKey[]; roleKeys: string[] }> {
    const { sessionId, token, now, expiresAt } = session;
    const credentials = { admin };
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
        after: {
          sessionId,
          expiresAt: expiresAt.toISOString(),
          ...(session.method === null ? {} : { method: session.method }),
        },
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

    return { permissions, roleKeys };
  }

  /**
   * The second step of a sign-in whose account has an active second factor (Phase D2).
   *
   * `challengeToken` is the value the first step set in the challenge cookie. The proof
   * is a current TOTP code or an unused backup code. Every way this can fail is answered
   * with one of two codes: `auth.second_factor_invalid` (try another code) and
   * `auth.challenge_invalid` (start again from the password). Which of the many reasons
   * it actually was is in the audit row, never the response.
   *
   * ## Throttling
   *
   * Each guess is RESERVED on the same credential throttle a password guess is — same
   * subjects, same counters — before it is checked, exactly as `signIn` reserves before
   * the KDF. A wrong code keeps its reservation; success clears the username counter and
   * gives back the IP reservation, in the transaction that mints the session. On top of
   * that, one challenge allows `LOGIN_CHALLENGE_MAX_ATTEMPTS` guesses, counted in a
   * write that commits on its own so a failed guess cannot roll its own count back.
   */
  async completeSecondFactor(
    challengeToken: string,
    actor: ActorContext,
    input: unknown,
    context: LoginContext,
  ): Promise<LoginResult> {
    const proof = secondFactorProofSchema.parse(input);
    const method: SecondFactorMethod = proof.code !== undefined ? 'TOTP' : 'BACKUP_CODE';
    const now = this.clock.now();
    const challenge = await this.secondFactor.challenges.findByTokenHash(
      hashSessionToken(challengeToken),
    );
    // Unknown token: there is no tenant to audit in, and nothing to say.
    if (challenge === null) throw challengeInvalid();

    const scope: TenantContext = {
      tenantId: challenge.tenantId as TenantId,
      botInstanceId: null,
    };
    const admin = await this.admins.findById(scope, challenge.adminId);
    if (
      admin === null ||
      admin.status !== 'ACTIVE' ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS
    ) {
      await this.recordSecondFactorDenial(
        scope,
        actor,
        challenge.adminId,
        method,
        'CHALLENGE_INVALID',
      );
      throw challengeInvalid();
    }
    const username = admin.username;

    // Counted on the credential throttle BEFORE the code is checked.
    let reserved: Reservation;
    try {
      reserved = await this.credentialThrottle.reserve(scope, actor, username, context.ip);
    } catch (error) {
      if (isNexaError(error) && error.code === IDENTITY_ERROR_CODES.AUTH_RATE_LIMITED) {
        await this.recordSecondFactorDenial(scope, actor, admin.id, method, 'THROTTLED');
      }
      throw error;
    }

    let judged = false;
    try {
      // The per-challenge bound, in its own commit. Past the bound the challenge is
      // spent: the reservation goes back (the code was never checked) and the caller
      // starts again from the password.
      const attempts = await this.secondFactor.challenges.countAttempt(scope, challenge.id);
      if (attempts > LOGIN_CHALLENGE_MAX_ATTEMPTS) {
        await this.credentialThrottle.release(scope, username, context.ip, reserved);
        judged = true;
        await this.recordSecondFactorDenial(scope, actor, admin.id, method, 'CHALLENGE_INVALID');
        throw challengeInvalid();
      }

      const token = generateSessionToken();
      const sessionId = this.ids.uuid() as AdminSessionId;

      const outcome = await this.uow.run(scope, async (tx) => {
        if ((await this.admins.lockTenantForRead(scope, tx)) !== 'ACTIVE') {
          return { kind: 'STALE' as const, reason: 'TENANT_INACTIVE' as const };
        }
        // The password the first step verified must still be the password. A rotation,
        // a reset or a disable between the two steps voids the challenge, exactly as it
        // voids a login in flight.
        const passwordHash = await this.admins.lockActiveCredential(scope, admin.id, tx);
        if (
          passwordHash === null ||
          credentialFingerprint(passwordHash) !== challenge.credentialFingerprint
        ) {
          return { kind: 'STALE' as const, reason: 'CHALLENGE_INVALID' as const };
        }
        const locked = await this.secondFactor.challenges.lock(scope, challenge.id, tx);
        // The instant is read AFTER the throttle and the lock waits (D2 review): a
        // challenge that expired while this request queued is expired, and the code is
        // judged against the step it is checked in, not the one the request arrived in.
        const lockedNow = this.clock.now();
        const expiresAt = new Date(lockedNow.getTime() + this.sessionTtlSeconds * 1000);
        if (
          locked === null ||
          locked.consumedAt !== null ||
          locked.expiresAt.getTime() <= lockedNow.getTime()
        ) {
          return { kind: 'STALE' as const, reason: 'CHALLENGE_INVALID' as const };
        }
        // The factor can have been removed between the steps (an operator reset, the
        // recovery CLI). There is then nothing to check a code against, and the right
        // answer is to start again — which signs in with the password alone.
        const factor = await this.secondFactor.factors.lockFactor(scope, admin.id, tx);
        if (factor === null || factor.state !== 'ACTIVE') {
          return { kind: 'STALE' as const, reason: 'CHALLENGE_INVALID' as const };
        }

        const verdict = await verifySecondFactorProof(
          this.secondFactor,
          scope,
          admin.id,
          factor,
          proof,
          lockedNow,
          tx,
        );
        if (!verdict.accepted) return { kind: 'REJECTED' as const, verdict };

        if (!(await this.secondFactor.challenges.consume(scope, challenge.id, lockedNow, tx))) {
          // Unreachable under the row lock above; kept as the single-use guarantee.
          throw challengeInvalid();
        }
        const display = await this.issueSessionInTransaction(
          scope,
          actor,
          admin,
          username,
          {
            ip: context.ip,
            userAgent: context.userAgent,
          },
          reserved,
          { sessionId, token, now: lockedNow, expiresAt, method: verdict.method },
          tx,
        );
        return { kind: 'ISSUED' as const, display, issuedAt: lockedNow, expiresAt };
      });

      if (outcome.kind === 'STALE') {
        // Not a guess at the code: the reservation goes back.
        await this.credentialThrottle.release(scope, username, context.ip, reserved);
        judged = true;
        await this.recordSecondFactorDenial(scope, actor, admin.id, method, outcome.reason);
        throw challengeInvalid();
      }
      if (outcome.kind === 'REJECTED') {
        // A judged wrong code: the reservation STAYS — that is the guess being counted.
        judged = true;
        await this.recordSecondFactorDenial(
          scope,
          actor,
          admin.id,
          method,
          'BAD_SECOND_FACTOR',
          outcome.verdict,
          attempts,
        );
        throw errors.unauthenticated(
          IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_INVALID,
          'The code is not valid.',
        );
      }
      judged = true;
      return sessionResult(
        token,
        admin,
        scope,
        sessionId,
        outcome.issuedAt,
        outcome.expiresAt,
        outcome.display,
      );
    } catch (error) {
      // Anything that failed before a verdict judged nothing, so it is not counted.
      if (!judged) await this.credentialThrottle.release(scope, username, context.ip, reserved);
      throw error;
    }
  }

  private async recordSecondFactorDenial(
    scope: TenantContext,
    actor: ActorContext,
    adminId: AdminId,
    method: SecondFactorMethod,
    reason: LoginFailureReason,
    verdict?: ProofVerdict,
    attempts?: number,
  ): Promise<void> {
    await this.audit.record(scope, actor, {
      action: 'auth.second_factor',
      entityType: 'Admin',
      entityId: adminId,
      before: null,
      // The method and WHY — never the code, and never a hint of how close it was.
      after: {
        reason,
        method,
        ...(verdict !== undefined && !verdict.accepted ? { detail: verdict.reason } : {}),
        ...(attempts === undefined ? {} : { challengeAttempts: attempts }),
      },
      result: 'DENIED',
    });
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
    /**
     * The administrator the attempt was against, when one exists — so a wrong password
     * appears in that account's own security history (Phase D2). Never set for an
     * unknown username: there is no account to attach it to, and the caller is told
     * nothing either way.
     */
    adminId: AdminId | null = null,
  ): Promise<never> {
    const usernameState = reserved.username;
    await this.audit.record(scope, actor, {
      action: 'auth.login',
      entityType: 'Admin',
      entityId: adminId,
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

function secondFactorRequired() {
  return errors.unauthenticated(
    IDENTITY_ERROR_CODES.AUTH_SECOND_FACTOR_REQUIRED,
    'This account needs a second factor to sign in.',
  );
}

function challengeInvalid() {
  return errors.unauthenticated(
    IDENTITY_ERROR_CODES.AUTH_CHALLENGE_INVALID,
    'The sign-in has expired. Enter your password again.',
  );
}

/** The `LoginResult` a freshly minted session is reported as. */
function sessionResult(
  token: string,
  admin: Admin,
  scope: TenantContext,
  sessionId: AdminSessionId,
  now: Date,
  expiresAt: Date,
  display: { permissions: readonly PermissionKey[]; roleKeys: readonly string[] },
): LoginResult {
  return {
    token,
    admin,
    session: {
      id: sessionId,
      tenantId: scope.tenantId,
      adminId: admin.id,
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
      revokedAt: null,
    },
    permissions: display.permissions,
    roleKeys: display.roleKeys,
  };
}

/** Re-labels an actor once the login has identified who they are. */
function actorFor(actor: ActorContext, admin: Admin): ActorContext {
  return { ...actor, type: 'WEB_ADMIN', id: admin.id, label: admin.username };
}

/** Narrow helper so a resolved admin id keeps its brand at call sites. */
export function adminIdOf(actor: ActorContext): AdminId | null {
  return actor.id === null ? null : (actor.id as AdminId);
}
