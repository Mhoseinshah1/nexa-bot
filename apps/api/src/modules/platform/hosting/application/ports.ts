import type {
  AdminId,
  BotInstanceStatus,
  CapacityResource,
  HostedBotState,
  ScopeContext,
  SystemContext,
  TenantStatus,
} from '@nexa/contracts';

/**
 * Phase 6A PR-3 — the creator panel's ports.
 *
 * Two of them, split by WHOSE rows they touch, because that is the line row-level security
 * (ADR-0037, PR-1) draws:
 *
 * - `HostingRepository` reads and writes the INSTALLATION tenant's own rows (the register of
 *   hosted bots, the section's factor, recovery codes and sessions, the owner's pressure
 *   alerts). Every method takes the installation scope, like any tenant-scoped repository.
 *
 * - `HostedTenantSystemPath` is every CROSS-TENANT read and write the panel needs: the
 *   hosted tenants' directory rows, their customer counts, their bot and owner usernames,
 *   provisioning a new hosted tenant's first owner, and closing one. Every method takes an
 *   explicit `SystemContext` whose reason names the operation (`hosting.<what>`), so at the
 *   merge with RLS the lead can route exactly these through the system path
 *   (`SET ROLE nexa_system`, `app.system_reason`) and nothing else. Nothing in this module
 *   reads another tenant's rows except through it.
 */

export interface HostedBotRow {
  readonly tenantId: string;
  readonly hostedTenantId: string;
  readonly state: HostedBotState;
  readonly expiresAt: Date | null;
  readonly ownerAdminId: string;
  readonly createdByAdminId: string;
  readonly createdAt: Date;
  readonly stateChangedAt: Date;
  readonly deletedAt: Date | null;
  readonly purgedAt: Date | null;
}

export interface HostingFactorRow {
  readonly id: string;
  readonly adminId: string;
  readonly state: 'PENDING' | 'ACTIVE';
  readonly ciphertext: string;
  readonly keyId: string;
  readonly lastUsedStep: number | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  readonly enrolledSessionId: string | null;
  readonly createdAt: Date;
}

export interface HostingSessionRow {
  readonly id: string;
  readonly adminId: string;
  readonly adminSessionId: string;
  readonly expiresAt: Date;
}

export interface HostingRepository {
  // --- the register -------------------------------------------------------------------
  listHosted(scope: ScopeContext, tx?: unknown): Promise<readonly HostedBotRow[]>;
  /** One row; `lock` takes it FOR UPDATE inside `tx`. */
  findHosted(
    scope: ScopeContext,
    hostedTenantId: string,
    tx?: unknown,
    lock?: boolean,
  ): Promise<HostedBotRow | null>;
  insertHosted(
    scope: ScopeContext,
    row: Omit<HostedBotRow, 'tenantId' | 'deletedAt' | 'purgedAt' | 'stateChangedAt'>,
    tx: unknown,
  ): Promise<void>;
  /**
   * THE state change: one conditional UPDATE naming its `from` states. Null when the row was
   * not in one of them (a concurrent change won); the updated row otherwise.
   */
  transition(
    scope: ScopeContext,
    hostedTenantId: string,
    from: readonly HostedBotState[],
    to: HostedBotState,
    now: Date,
    tx: unknown,
  ): Promise<HostedBotRow | null>;
  setExpiry(
    scope: ScopeContext,
    hostedTenantId: string,
    expiresAt: Date | null,
    now: Date,
    tx: unknown,
  ): Promise<void>;
  /** ACTIVE rows whose expiry is at or before `now`, locked, skipping rows another holds. */
  claimExpired(
    scope: ScopeContext,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<readonly HostedBotRow[]>;

  // --- the section's factor ----------------------------------------------------------
  findFactor(scope: ScopeContext, adminId: string, tx?: unknown): Promise<HostingFactorRow | null>;
  lockFactor(scope: ScopeContext, adminId: string, tx: unknown): Promise<HostingFactorRow | null>;
  /** Replaces any PENDING factor (never an ACTIVE one) with a fresh pending secret. */
  replaceWithPending(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly adminId: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly enrolledSessionId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  deleteFactor(scope: ScopeContext, factorId: string, tx: unknown): Promise<void>;
  activate(
    scope: ScopeContext,
    factorId: string,
    step: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** Records `step` as used iff it is after the last one (the replay rule). */
  consumeStep(
    scope: ScopeContext,
    factorId: string,
    step: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /**
   * The section's code throttle, written under the factor's lock by the transaction that
   * checked the code (so a wrong code's count commits with the verdict).
   */
  setFailures(
    scope: ScopeContext,
    factorId: string,
    input: {
      readonly failedAttempts: number;
      readonly lockedUntil: Date | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;

  // --- recovery codes ------------------------------------------------------------------
  replaceRecoveryCodes(
    scope: ScopeContext,
    adminId: string,
    codes: readonly { readonly id: string; readonly hash: string }[],
    now: Date,
    tx: unknown,
  ): Promise<void>;
  /** Spends one unused code by its hash; false when there is none. */
  consumeRecoveryCode(
    scope: ScopeContext,
    adminId: string,
    hash: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  countUnusedRecoveryCodes(scope: ScopeContext, adminId: string, tx?: unknown): Promise<number>;

  // --- section sessions ----------------------------------------------------------------
  createSession(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly adminId: string;
      readonly adminSessionId: string;
      readonly tokenHash: string;
      readonly now: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The unrevoked, unexpired session with this token, for this admin and Web Admin session. */
  findLiveSession(
    scope: ScopeContext,
    input: {
      readonly adminId: string;
      readonly adminSessionId: string;
      readonly tokenHash: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<HostingSessionRow | null>;
  revokeSessions(
    scope: ScopeContext,
    input: { readonly adminId: string; readonly adminSessionId?: string; readonly now: Date },
    tx?: unknown,
  ): Promise<number>;

  // --- the owner's readings --------------------------------------------------------------
  /** Per hosted tenant and resource, how many pressure alerts the owner was sent since `since`. */
  limitHitsSince(
    scope: ScopeContext,
    since: Date,
  ): Promise<ReadonlyMap<string, ReadonlyMap<CapacityResource, number>>>;
  /** The newest SUCCEEDED installation backup's finish time, or null. */
  lastSucceededBackupAt(scope: ScopeContext): Promise<Date | null>;
}

export interface HostedTenantFacts {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly customerCount: number;
  readonly ownerUsername: string | null;
  readonly bot: { readonly username: string; readonly status: BotInstanceStatus } | null;
}

/**
 * Every cross-tenant operation of the creator panel. See the module note: each takes an
 * explicit `SystemContext` with a reason, and is the ONE place the RLS merge has to route.
 */
export interface HostedTenantSystemPath {
  /** The directory rows and per-tenant counts the owner's list shows. */
  facts(
    context: SystemContext,
    hosted: readonly { readonly tenantId: string; readonly ownerAdminId: string }[],
  ): Promise<ReadonlyMap<string, HostedTenantFacts>>;
  slugTaken(context: SystemContext, slug: string, tx?: unknown): Promise<boolean>;
  /**
   * Creates the hosted TENANT (kind HOSTED, child of `parentTenantId`, the parent's locale,
   * timezone, calendar and currency), its system roles, and its first Web Admin owner — in
   * the caller's transaction. Writes NOTHING to the hosted tenant's audit log (D5: the
   * owner's actions are recorded in his own).
   */
  provision(
    context: SystemContext,
    input: {
      readonly tenantId: string;
      readonly parentTenantId: string;
      readonly slug: string;
      readonly displayName: string;
      readonly ownerAdminId: AdminId;
      readonly ownerUsername: string;
      readonly ownerDisplayName: string;
      readonly ownerPasswordHash: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The hosted tenant's status, conditionally: `from` → `to`. False when it was not `from`. */
  setTenantStatus(
    context: SystemContext,
    hostedTenantId: string,
    from: TenantStatus,
    to: TenantStatus,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** A purge: every Web Admin session of the tenant revoked, every bot of it DISABLED. */
  closeForPurge(
    context: SystemContext,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<{ readonly sessionsRevoked: number; readonly botsDisabled: number }>;
  purgePreview(
    context: SystemContext,
    hostedTenantId: string,
  ): Promise<{
    readonly customers: number;
    readonly orders: number;
    readonly services: number;
    readonly payments: number;
    readonly admins: number;
  }>;
}

/** What the server card reads. Null where it cannot tell. */
export interface HostingServerProbe {
  cores(): number;
  loadAverage1m(): number;
  totalMemoryBytes(): number;
  availableMemoryBytes(): Promise<number | null>;
  disk(
    path: string,
  ): Promise<{ readonly totalBytes: number; readonly availableBytes: number } | null>;
}
