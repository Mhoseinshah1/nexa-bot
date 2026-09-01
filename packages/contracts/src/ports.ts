import type { ActorContext, SourceSurface } from './actor.js';
import type { ScopeContext } from './tenant.js';
import type { CorrelationId } from './ids.js';

/**
 * Ports.
 *
 * The abstractions the domain and application layers depend on. Infrastructure
 * implements them and depends inward; nothing here knows about Postgres, Redis,
 * Nest or Telegram. A lint rule stops domain and application code from importing
 * a framework, which is what keeps this honest rather than decorative.
 */

/** Generates identifiers. UUIDv7, so the id exists before the INSERT. */
export interface IdGenerator {
  uuid(): string;
  /** A short opaque reference that fits Telegram's 64-byte callback_data cap. */
  callbackRef(): string;
}

/**
 * Envelope encryption for stored secrets.
 *
 * Bot tokens — and later panel and gateway credentials — are encrypted with a
 * data key that is itself wrapped by a key-encryption key held outside the
 * database. `keyId` travels with the ciphertext so keys can rotate.
 *
 * No API response ever contains a decrypted secret. In the legacy system the
 * panel detail page rendered dots followed by the real stored secret in the DOM,
 * and panel tokens were typed as plain chat messages into Telegram.
 */
export interface EncryptedSecret {
  readonly keyId: string;
  readonly ciphertext: string;
}

export interface SecretCipher {
  encrypt(plaintext: string): EncryptedSecret;
  decrypt(secret: EncryptedSecret): string;
  /** A stable, non-reversible display form, computed server-side. */
  mask(secret: EncryptedSecret): string;
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  trace(context: Record<string, unknown>, message: string): void;
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/**
 * The unit of work.
 *
 * Domain changes, the audit row and the outbox rows commit together or not at
 * all. Everything a write path does happens inside one of these.
 */
export interface UnitOfWork<TTransaction = unknown> {
  run<T>(scope: ScopeContext, fn: (tx: TTransaction) => Promise<T>): Promise<T>;
}

/**
 * Durable idempotency.
 *
 * Telegram retries webhooks, BullMQ redelivers jobs and gateways double-post
 * callbacks. A command carrying an idempotency key executes once; a replay
 * returns the first result rather than performing the work again.
 */
export interface IdempotencyRecord<TResult = unknown> {
  readonly key: string;
  readonly requestHash: string;
  readonly result: TResult;
  readonly createdAt: Date;
}

/**
 * Which surface minted a key. Keys are unique within a namespace, never across
 * them: two surfaces must not be able to consume each other's keys, even when
 * both run under the same scope.
 */
export type IdempotencyNamespace = SourceSurface;

export interface IdempotencyStore {
  /**
   * Returns the stored result when this key has already completed. Throws a
   * CONFLICT when the key was used with a different request payload — a reused
   * key with different input is a bug, never a replay.
   */
  find<TResult>(
    scope: ScopeContext,
    namespace: IdempotencyNamespace,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyRecord<TResult> | null>;
  remember<TResult>(
    scope: ScopeContext,
    namespace: IdempotencyNamespace,
    key: string,
    requestHash: string,
    result: TResult,
    tx?: unknown,
  ): Promise<void>;
}

export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * An audit entry.
 *
 * `action` is a machine code, never a prose sentence. `before` and `after` hold
 * VALUES, not references, so the record still means something after the
 * referenced row changes. Denials are audited too.
 */
export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  /** Mandatory for high-risk actions. */
  readonly reason?: string;
  readonly result: AuditResult;
}

export interface AuditWriter {
  record(scope: ScopeContext, actor: ActorContext, entry: AuditEntry, tx?: unknown): Promise<void>;
}

export const OPERATIONAL_SEVERITIES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;
export type OperationalSeverity = (typeof OPERATIONAL_SEVERITIES)[number];

/**
 * An operational event: what the system did, as opposed to who changed what.
 *
 * `dedupeKey` collapses repeats into one row with an occurrence counter — the
 * legacy log group recorded 60 identical TLS errors in a single day with no way
 * to suppress them. A recovery event is emitted explicitly when the condition
 * clears, so a resolved problem stops looking unresolved.
 */
export interface OperationalEventInput {
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly dedupeKey?: string;
  readonly correlationId?: CorrelationId;
  /** Set when this event records recovery from an earlier failure code. */
  readonly recoversCode?: string;
}

export interface OperationalEventRecorder {
  record(scope: ScopeContext, event: OperationalEventInput): Promise<void>;
}

/**
 * Password hashing.
 *
 * `encoded` carries the algorithm and its parameters alongside the digest, so a
 * stored hash is self-describing and the cost can be raised — or the algorithm
 * replaced — without a migration: `needsRehash` reports that a verified
 * password should be re-stored, and the only moment the plaintext exists is the
 * moment it can be re-hashed.
 *
 * There is no `compare(hashA, hashB)`. Verification takes the plaintext and the
 * stored string, so no caller can be tempted to compare two digests with `===`.
 */
export interface PasswordHasher {
  /** Returns the self-describing encoded hash to store. Never reversible. */
  hash(plaintext: string): Promise<string>;
  /** Constant-time within the algorithm. False for any malformed stored value. */
  verify(plaintext: string, encoded: string): Promise<boolean>;
  /** True when `encoded` was produced with weaker parameters than current policy. */
  needsRehash(encoded: string): boolean;
  /**
   * Spends the same work as a real verification against a value that cannot
   * match. Called when no account exists, so the response time of "no such
   * username" and "wrong password" do not differ.
   */
  spendDummyWork(): Promise<void>;
}
