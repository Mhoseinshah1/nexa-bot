import type {
  ResellerPreferences,
  ResellerWebSessionEndReason,
  ResellerWebSessionState,
  ResellerWebTotpState,
  TenantContext,
} from '@nexa/contracts';

/** A one-time link, as the exchange reads it under lock. */
export interface ResellerWebLinkRecord {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface ResellerWebSessionRecord {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly state: ResellerWebSessionState;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly endedAt: Date | null;
  readonly deviceFingerprint: string;
  readonly deviceLabel: string;
  readonly network: string | null;
  readonly secondFactorAttempts: number;
}

export interface ResellerWebTotpFactorRecord {
  readonly id: string;
  readonly customerId: string;
  readonly state: ResellerWebTotpState;
  readonly ciphertext: string;
  readonly keyId: string;
  readonly lastUsedStep: number | null;
  readonly activationAttempts: number;
  readonly createdAt: Date;
}

export interface ResellerActivityRow {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly result: string;
  readonly occurredAt: Date;
}

/**
 * PR-4 — everything the reseller panel stores, in its tenant's scope (row-level security
 * binds every statement). `tx` is the caller's transaction; the methods without one read on
 * the pool.
 */
export interface ResellerWebRepository {
  /** The reseller row, FOR UPDATE: serialises link issuing and file fetches per reseller. */
  lockReseller(scope: TenantContext, customerId: string, tx: unknown): Promise<boolean>;

  countLinksSince(
    scope: TenantContext,
    customerId: string,
    since: Date,
    tx: unknown,
  ): Promise<number>;
  insertLink(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly tokenHash: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The link with this hash, FOR UPDATE, whatever its state; null when there is none. */
  lockLinkByHash(
    scope: TenantContext,
    tokenHash: string,
    tx: unknown,
  ): Promise<ResellerWebLinkRecord | null>;
  /** ONE conditional UPDATE: unused and unexpired at `now`. False when it was not. */
  spendLink(
    scope: TenantContext,
    input: { readonly id: string; readonly sessionId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  insertSession(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly botInstanceId: string;
      readonly tokenHash: string;
      readonly state: ResellerWebSessionState;
      readonly now: Date;
      readonly absoluteExpiresAt: Date;
      readonly deviceFingerprint: string;
      readonly deviceLabel: string;
      readonly network: string | null;
    },
    tx: unknown,
  ): Promise<void>;
  findSessionByHash(
    scope: TenantContext,
    tokenHash: string,
  ): Promise<ResellerWebSessionRecord | null>;
  lockSession(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ResellerWebSessionRecord | null>;
  touchSession(scope: TenantContext, id: string, now: Date): Promise<void>;
  /** PENDING_SECOND_FACTOR → ACTIVE, conditionally. */
  activateSession(
    scope: TenantContext,
    input: { readonly id: string; readonly now: Date; readonly absoluteExpiresAt: Date },
    tx: unknown,
  ): Promise<boolean>;
  /** Counts one wrong code on a session (pending or, for 2FA changes, active); the new count. */
  countSecondFactorAttempt(scope: TenantContext, id: string, tx: unknown): Promise<number>;
  /** Ends ONE live session of this customer; false when it was not live or not theirs. */
  endSession(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly reason: ResellerWebSessionEndReason;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean>;
  /** Ends every live session of this customer except `keep`; answers how many. */
  endSessionsOf(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly reason: ResellerWebSessionEndReason;
      readonly now: Date;
      readonly keep: string | null;
    },
    tx: unknown,
  ): Promise<number>;
  /** The customer's sessions that are not ended, newest first (liveness is the caller's). */
  openSessionsOf(
    scope: TenantContext,
    customerId: string,
  ): Promise<readonly ResellerWebSessionRecord[]>;
  /** When the last ACTIVE session opened, null if never. */
  lastLoginAt(scope: TenantContext, customerId: string): Promise<Date | null>;

  /** True when this fingerprint is new for the customer (and is now recorded). */
  recordDevice(
    scope: TenantContext,
    input: { readonly customerId: string; readonly fingerprint: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  findFactor(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerWebTotpFactorRecord | null>;
  lockFactor(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerWebTotpFactorRecord | null>;
  /** Replaces any PENDING factor with a fresh one (never an ACTIVE one). */
  replacePendingFactor(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly customerId: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** Counts one wrong activation code on the PENDING factor; the new count, null if none. */
  countActivationAttempt(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<number | null>;
  activateFactor(
    scope: TenantContext,
    input: { readonly id: string; readonly step: number; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;
  /** Records a used step, ONLY if it is after the last one (the replay rule). */
  consumeStep(
    scope: TenantContext,
    input: { readonly id: string; readonly step: number },
    tx: unknown,
  ): Promise<boolean>;
  deleteFactor(scope: TenantContext, customerId: string, tx: unknown): Promise<boolean>;

  findPreferences(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerPreferences | null>;
  upsertPreferences(
    scope: TenantContext,
    input: { readonly customerId: string; readonly value: ResellerPreferences; readonly now: Date },
    tx: unknown,
  ): Promise<void>;

  countFileFetchesSince(
    scope: TenantContext,
    input: { readonly customerId: string; readonly serviceId: string; readonly since: Date },
    tx: unknown,
  ): Promise<number>;
  insertFileFetch(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly serviceId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void>;

  /**
   * The customer's own audit rows: `actions` on the customer itself, or on one of their own
   * services or orders. Newest first, keyset by (occurred_at, id).
   */
  activityPage(
    scope: TenantContext,
    input: {
      readonly customerId: string;
      readonly actions: readonly string[];
      readonly before: { readonly at: Date; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly ResellerActivityRow[]>;
}
