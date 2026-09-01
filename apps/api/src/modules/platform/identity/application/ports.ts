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
  findById(scope: ScopeContext, id: AdminId): Promise<Admin | null>;
  findByTelegramUserId(scope: ScopeContext, telegramUserId: string): Promise<Admin | null>;
  list(scope: ScopeContext): Promise<Admin[]>;
  roleKeysFor(scope: ScopeContext, id: AdminId): Promise<string[]>;
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
  list(scope: ScopeContext): Promise<Role[]>;
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
  permissionsForAdmin(scope: ScopeContext, adminId: AdminId): Promise<PermissionKey[]>;
  overridesForAdmin(scope: ScopeContext, adminId: AdminId): Promise<PermissionOverride[]>;
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
}

export interface LoginThrottleRepository {
  find(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
  ): Promise<ThrottleState | null>;
  /** Records a failure, advancing or resetting the window. Returns the new state. */
  recordFailure(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    now: Date,
    policy: { windowSeconds: number; maxAttempts: number; lockoutSeconds: number },
  ): Promise<ThrottleState>;
  clear(scope: ScopeContext, kind: ThrottleSubjectKind, subject: string): Promise<void>;
}
