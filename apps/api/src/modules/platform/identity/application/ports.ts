import type {
  Admin,
  AdminId,
  AdminSession,
  AdminSessionId,
  AdminStatus,
  PermissionKey,
  PermissionOverride,
  Role,
  RoleId,
  ScopeContext,
} from '@nexa/contracts';

/**
 * Ports owned by the identity module.
 *
 * The application layer declares what it needs; infrastructure implements it
 * and depends inward. Nothing here knows about Drizzle, and every method takes
 * a `ScopeContext` — a repository call without a tenant does not compile.
 */

/** An admin plus the credential material only the auth service may see. */
export interface AdminCredentials {
  readonly admin: Admin;
  readonly passwordHash: string;
}

export interface AdminRepository {
  /**
   * Credential lookup for login. Tenant-scoped like everything else: a username
   * is unique within a tenant, never across the installation.
   */
  findCredentialsByUsername(
    scope: ScopeContext,
    username: string,
  ): Promise<AdminCredentials | null>;
  /**
   * `tx` is not optional decoration. A read taken after the tenant lock but on
   * the POOL does not participate in that lock's serialisation: it can observe
   * a different snapshot from the one the transaction is about to write into,
   * which is exactly the stale-state decision the lock exists to prevent.
   */
  findById(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<Admin | null>;
  findByTelegramUserId(scope: ScopeContext, telegramUserId: string): Promise<Admin | null>;
  /**
   * Existence check by username, without the credential.
   *
   * Separate from `findCredentialsByUsername` so a uniqueness check never pulls
   * a password hash into scope it has no use for.
   */
  findByUsername(scope: ScopeContext, username: string, tx?: unknown): Promise<Admin | null>;
  list(scope: ScopeContext, tx?: unknown): Promise<Admin[]>;
  roleKeysFor(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<string[]>;
  /** Role keys for many admins at once, so listing is not N+1. */
  roleKeysForAll(scope: ScopeContext, ids: readonly AdminId[]): Promise<Map<string, string[]>>;
  create(
    scope: ScopeContext,
    input: {
      readonly id: AdminId;
      readonly username: string;
      readonly displayName: string;
      readonly passwordHash: string;
      readonly telegramUserId: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void>;
  setStatus(
    scope: ScopeContext,
    id: AdminId,
    status: AdminStatus,
    now: Date,
    tx?: unknown,
  ): Promise<void>;
  /**
   * Compare-and-set on the password hash.
   *
   * Returns false when the stored hash is no longer `expectedHash` — i.e. the
   * password changed between the moment this request verified it and the moment
   * it tried to write. The caller must then abort everything, because a request
   * that validated against a superseded credential has no authority to replace
   * the current one.
   *
   * This is what makes rotation safe WITHOUT holding a transaction open across
   * scrypt. Verification and hashing stay outside the transaction, where they
   * belong; the check that the world did not move happens atomically in the
   * UPDATE's own predicate.
   */
  compareAndSetPasswordHash(
    scope: ScopeContext,
    id: AdminId,
    expectedHash: string,
    newHash: string,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
  /**
   * Locks the admin row and reports whether its password hash is still the one
   * given. False means the credential this request verified has been replaced.
   *
   * `FOR UPDATE` is what makes it a decision rather than an observation: it
   * serialises against the rotation's own compare-and-set, so whichever runs
   * first, the other sees the committed outcome instead of a snapshot.
   */
  lockIfPasswordHashMatches(
    scope: ScopeContext,
    id: AdminId,
    expectedHash: string,
    tx: unknown,
  ): Promise<boolean>;
  /**
   * Unconditional write, for the two paths with nothing to compare against:
   * installation bootstrap, and rehashing a verified password at a raised cost
   * factor. Never use it for a rotation — that is what the CAS above is for.
   */
  setPasswordHash(
    scope: ScopeContext,
    id: AdminId,
    hash: string,
    now: Date,
    tx?: unknown,
  ): Promise<void>;
  recordLogin(scope: ScopeContext, id: AdminId, now: Date): Promise<void>;
  /**
   * Locks the tenant row for the duration of the transaction.
   *
   * Owner protection counts rows, and a count is only a decision if nothing can
   * change underneath it: without this, two transactions each disabling a
   * different owner both count two and both commit. The database trigger is a
   * backstop for a forgotten call, not a substitute for this lock.
   */
  lockTenantForAdminChange(scope: ScopeContext, tx: unknown): Promise<void>;
  /** Active admins holding the owner role. The number the guards defend. */
  countActiveOwners(scope: ScopeContext, tx?: unknown): Promise<number>;
}

export interface RoleRepository {
  list(scope: ScopeContext, tx?: unknown): Promise<Role[]>;
  findByKey(scope: ScopeContext, key: string, tx?: unknown): Promise<Role | null>;
  /** Seeds the frozen ROLE_SEEDS for a tenant. Idempotent. */
  ensureSystemRoles(scope: ScopeContext, tx?: unknown): Promise<void>;
  setAdminRoles(
    scope: ScopeContext,
    adminId: AdminId,
    roleIds: readonly RoleId[],
    assignedBy: AdminId | null,
    tx?: unknown,
  ): Promise<void>;
  permissionsForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<PermissionKey[]>;
  overridesForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    tx?: unknown,
  ): Promise<PermissionOverride[]>;
}

export interface SessionRepository {
  create(
    scope: ScopeContext,
    session: {
      readonly id: AdminSessionId;
      readonly adminId: AdminId;
      readonly tokenHash: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
      readonly ip: string | null;
      readonly userAgent: string | null;
    },
    tx?: unknown,
  ): Promise<void>;
  /**
   * Resolves a presented token. Unscoped by necessity — the token is presented
   * before any tenant is known, and the tenant comes OUT of this lookup. It is
   * the one place that is allowed to be, and it returns the tenant so every
   * subsequent call is scoped.
   */
  findByTokenHash(tokenHash: string): Promise<AdminSession | null>;
  touch(id: AdminSessionId, now: Date): Promise<void>;
  revoke(id: AdminSessionId, now: Date, reason: string): Promise<void>;
  revokeAllForAdmin(
    scope: ScopeContext,
    adminId: AdminId,
    now: Date,
    reason: string,
    tx?: unknown,
  ): Promise<number>;
}

/** The durable login throttle. Keyed by subject, never by admin id. */
export const THROTTLE_SUBJECTS = ['USERNAME', 'IP'] as const;
export type ThrottleSubjectKind = (typeof THROTTLE_SUBJECTS)[number];

export interface ThrottleState {
  readonly failedCount: number;
  readonly lockedUntil: Date | null;
  /**
   * The counting period this state belongs to.
   *
   * Carried so a release can name the reservation it is returning. A login can
   * sit in the KDF longer than the throttle window allows for — 30 seconds is
   * the configured minimum and a saturated crypto pool can exceed it — and by
   * the time it releases, a later attempt may have started a new period. An
   * unconditional decrement would then take away the later attempt instead,
   * and could clear the lock that attempt had just established.
   */
  readonly windowStartedAt: Date;
}

export interface LoginThrottleRepository {
  find(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
  ): Promise<ThrottleState | null>;
  /**
   * Counts an attempt BEFORE it is verified, advancing or resetting the window.
   *
   * Reserved rather than recorded afterwards, because the verification in
   * between is a deliberately slow, memory-heavy KDF. Counting only failures
   * meant a concurrent burst all passed the pre-check while the counters were
   * empty and every one of them queued a production-cost derivation — an
   * unauthenticated caller could saturate the crypto pool long after the
   * configured limit had been crossed. Reserving makes the Nth request in a
   * burst see its own increment and be refused before hashing.
   */
  reserveAttempt(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    now: Date,
    policy: { windowSeconds: number; maxAttempts: number; lockoutSeconds: number },
  ): Promise<ThrottleState>;
  /**
   * Gives back one reserved attempt without erasing earlier failures.
   *
   * Used for the IP subject on a successful login. Clearing it outright would
   * let anyone holding one valid account spray guesses across administrator
   * names and periodically reset the breadth limiter by signing into their own.
   *
   * `maxAttempts` is needed because the reservation being returned may be the
   * one that ESTABLISHED a lockout — the attempt that reaches the limit is
   * still verified, and it can succeed. Returning the count while leaving the
   * lock would refuse every administrator behind that IP for the full lockout
   * on the strength of a login that worked. The lock is therefore lifted when,
   * and only when, the returned count falls back below the limit.
   */
  releaseAttempt(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    maxAttempts: number,
    reservedWindowStartedAt: Date,
  ): Promise<void>;
  /** Erases a subject's counter entirely. For the USERNAME that just succeeded. */
  clear(scope: ScopeContext, kind: ThrottleSubjectKind, subject: string): Promise<void>;
}
