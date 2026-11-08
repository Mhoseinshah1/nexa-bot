import {
  OPS_ERROR_CLASS_POLICY,
  SECRET_READ_FAILED_CODE,
  SECRET_READ_OK_CODE,
  asId,
  secretUnreadableConditionKey,
  unreadableSecretKindOf,
  type Clock,
  type EncryptedSecret,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type SecretCipher,
  type SecretContext,
  type TenantContext,
  type UnreadableSecretKind,
} from '@nexa/contracts';
import { isUnreadableSecretError } from '../../../../infrastructure/lifecycle/unreadable-secret.js';
import { recordQuietly } from './error-events.js';

/**
 * How often a secret that STAYS unreadable is recorded again: silently, on its open row (the
 * counter grows, nothing is announced). It exists for one case: another process (or this one's
 * previous life) saw a DIFFERENT secret of the same kind read and closed the shared condition;
 * this re-record reopens it within the window instead of leaving a broken secret unreported.
 */
export const UNREADABLE_SECRET_RERECORD_MS = 15 * 60_000;

/**
 * A failing row not seen failing for this long no longer holds its kind's condition open: it
 * was deleted, or replaced by a new row, and nothing reads it any more. Longer than the slowest
 * lane that retries an unreadable secret (a daily backup schedule; the panel monitor's hour).
 */
export const UNREADABLE_SECRET_FORGET_MS = 26 * 60 * 60_000;

interface FailingSecret {
  /** The ciphertext as last seen failing. A different one is a re-entered value. */
  readonly stamp: string;
  /** `purpose|row`: which secret, as the condition's `unreadable` list names it. */
  readonly secret: string;
  readonly kind: UnreadableSecretKind;
  readonly tenantId: string;
  recordedAt: number;
  lastSeenAt: number;
}

export interface UnreadableSecretReporterDeps {
  readonly recorder: Pick<OperationalEventRecorder, 'record'>;
  readonly conditions: {
    /** The context of the open condition with this dedupe key, or null when none is open. */
    openConditionContext(
      scope: TenantContext,
      dedupeKey: string,
    ): Promise<Record<string, unknown> | null>;
  };
  readonly clock: Clock;
  readonly logger: {
    warn: (context: Record<string, unknown>, message: string) => void;
    info: (context: Record<string, unknown>, message: string) => void;
  };
  /** Overrides `UNREADABLE_SECRET_RERECORD_MS`; production never sets it. */
  readonly rerecordMs?: number;
}

/** A condition whose `unreadable` list this process cannot read is never closed by it. */
const UNLISTED = '\u0000unlisted';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.6: what a running installation does when a stored secret stops
 * decrypting (`platform.secret_auth_failed`, or a key id it does not hold).
 *
 * Before this, every background loop that needed the secret — the operations-group
 * maintainer every 15 s, the notification sender, the panel monitor, the gateway lanes, the
 * backup run — logged the full error on every tick, and nothing reached the owner: the group
 * that should have told them depends on the bot token that could not be read.
 *
 * Now, per secret (tenant, purpose, row):
 * - the FIRST failure of a given ciphertext logs one line (no stack, no value) and records
 *   `secrets.read_failed` on the tenant's condition for that KIND — one Web Admin alert per
 *   kind, however many rows and loops hit it. The row's context lists every secret it was
 *   raised for (`unreadable`, `purpose|row`), merged with what the open row already listed, so
 *   two processes failing on two rows both appear;
 * - every later failure of the SAME ciphertext is silent (re-recorded on the open row at most
 *   every `UNREADABLE_SECRET_RERECORD_MS`); callers check `isUnreadableSecretError` and log
 *   nothing of their own;
 * - a DIFFERENT ciphertext that still fails is a new state: one more line, one more record
 *   (the dedupe key keeps it the same alert);
 * - `secrets.read_ok` closes the condition only once nothing of that kind fails in this
 *   process AND every secret the open row lists has been read successfully HERE. A healthy
 *   read of another row of the same kind (panel 2, when panel 1 is the broken one) leaves it
 *   open: closing on it let a process that never saw the failure close another's condition,
 *   which then reopened and was announced again (lead review of this round).
 *
 * The state is per process and in memory; the condition row is what survives a restart. It
 * never throws: reporting must not change what the caller's decrypt does.
 */
export class UnreadableSecretReporter {
  private readonly failing = new Map<string, FailingSecret>();
  /** `tenant|kind` → the secrets read successfully in this process. */
  private readonly readOk = new Map<string, Set<string>>();
  /** `tenant|kind` → listed secrets not yet read here, for an open condition. */
  private readonly remaining = new Map<string, Set<string>>();
  /** `tenant|kind` pairs known to have no open condition this process must close. */
  private readonly settled = new Set<string>();
  private readonly looking = new Set<string>();
  private readonly closing = new Set<string>();
  /** `tenant|kind` → this process's failure record in flight; a look-up waits for it. */
  private readonly recording = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: UnreadableSecretReporterDeps) {}

  /**
   * A decrypt of `secret` for `context` threw `error`. True when it was an unreadable secret
   * (reported, or already reported for this ciphertext); false for any other error, which the
   * caller handles as before.
   */
  failed(context: SecretContext, secret: EncryptedSecret, error: unknown): boolean {
    if (!isUnreadableSecretError(error)) return false;
    try {
      const key = secretKey(context);
      const stamp = `${secret.keyId}\u0000${secret.ciphertext}`;
      const now = this.deps.clock.now().getTime();
      const kind = unreadableSecretKindOf(context.purpose);
      const pair = `${context.tenantId}|${kind}`;
      this.readOk.get(pair)?.delete(secretId(context));
      // Whatever this process concluded about the open row no longer holds.
      this.settled.delete(pair);
      this.remaining.delete(pair);
      const prior = this.failing.get(key);
      const rerecordMs = this.deps.rerecordMs ?? UNREADABLE_SECRET_RERECORD_MS;
      if (prior !== undefined && prior.stamp === stamp) {
        prior.lastSeenAt = now;
        if (now - prior.recordedAt < rerecordMs) return true;
        prior.recordedAt = now;
        this.record(prior, context, error);
        return true;
      }
      const entry: FailingSecret = {
        stamp,
        secret: secretId(context),
        kind,
        tenantId: context.tenantId,
        recordedAt: now,
        lastSeenAt: now,
      };
      this.failing.set(key, entry);
      // ONE line per change of state: no stack, no value, no ciphertext.
      this.deps.logger.warn(
        {
          purpose: context.purpose,
          kind: entry.kind,
          tenantId: context.tenantId,
          entityId: context.entityId,
          keyId: secret.keyId,
          code: errorCode(error),
        },
        "a stored secret cannot be read with this installation's keys; raised on the Web Admin " +
          'alerts page, quiet until the value is re-entered',
      );
      this.record(entry, context, error);
    } catch {
      // Reporting never changes what the decrypt does.
    }
    return true;
  }

  /** A decrypt for `context` succeeded. Cheap: map lookups on the hot path. */
  readable(context: SecretContext): void {
    try {
      const key = secretKey(context);
      const id = secretId(context);
      const kind = unreadableSecretKindOf(context.purpose);
      const pair = `${context.tenantId}|${kind}`;
      let ok = this.readOk.get(pair);
      if (ok === undefined) {
        ok = new Set();
        this.readOk.set(pair, ok);
      }
      ok.add(id);
      const was = this.failing.get(key);
      if (was !== undefined) {
        this.failing.delete(key);
        this.deps.logger.info(
          {
            purpose: context.purpose,
            kind,
            tenantId: context.tenantId,
            entityId: context.entityId,
          },
          'a stored secret that could not be read reads again',
        );
      } else if (this.settled.has(pair)) {
        return;
      }
      const remaining = this.remaining.get(pair);
      if (remaining !== undefined) {
        remaining.delete(id);
        this.maybeClose(pair, context.tenantId, kind);
        return;
      }
      if (this.kindFailing(context.tenantId, kind) || this.looking.has(pair)) return;
      this.lookUp(pair, context.tenantId, kind);
    } catch {
      // Reporting never changes what the decrypt does.
    }
  }

  /** Waits for the recordings in flight. For tests and orderly shutdown. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Reads the open condition's list of secrets, less those already read here. */
  private lookUp(pair: string, tenantId: string, kind: UnreadableSecretKind): void {
    this.looking.add(pair);
    this.track(
      (async () => {
        try {
          // A failure this process is still recording would otherwise read as "none open".
          await this.recording.get(pair);
          const context = await this.deps.conditions.openConditionContext(
            tenantScope(tenantId),
            secretUnreadableConditionKey(kind),
          );
          if (context === null) {
            this.settled.add(pair);
            return;
          }
          const listed = unreadableList(context);
          const remaining = new Set(listed.length === 0 ? [UNLISTED] : listed);
          for (const id of this.readOk.get(pair) ?? []) remaining.delete(id);
          this.remaining.set(pair, remaining);
          this.maybeClose(pair, tenantId, kind);
        } catch {
          // Looked up again on the next successful read.
        } finally {
          this.looking.delete(pair);
        }
      })(),
    );
  }

  private maybeClose(pair: string, tenantId: string, kind: UnreadableSecretKind): void {
    const remaining = this.remaining.get(pair);
    if (remaining === undefined || remaining.size > 0) return;
    if (this.kindFailing(tenantId, kind) || this.closing.has(pair)) return;
    this.closing.add(pair);
    this.track(
      this.writeClose(tenantId, kind)
        .then((closed) => {
          // Not closed: the next read looks the condition up again.
          if (closed) this.settled.add(pair);
          this.remaining.delete(pair);
        })
        .finally(() => this.closing.delete(pair)),
    );
  }

  private kindFailing(tenantId: string, kind: UnreadableSecretKind): boolean {
    const now = this.deps.clock.now().getTime();
    let failing = false;
    for (const [key, entry] of this.failing) {
      if (now - entry.lastSeenAt >= UNREADABLE_SECRET_FORGET_MS) {
        this.failing.delete(key);
      } else if (entry.tenantId === tenantId && entry.kind === kind) {
        failing = true;
      }
    }
    return failing;
  }

  private record(entry: FailingSecret, context: SecretContext, error: unknown): void {
    const scope = tenantScope(entry.tenantId);
    const dedupeKey = secretUnreadableConditionKey(entry.kind);
    const pair = `${entry.tenantId}|${entry.kind}`;
    const previous = this.recording.get(pair);
    const work = (async () => {
      await previous?.catch(() => undefined);
      // Merged with the open row's list: the dedupe update replaces the context, and a
      // secret another process listed must stay listed until it is read again.
      const open = await this.deps.conditions
        .openConditionContext(scope, dedupeKey)
        .catch(() => null);
      const listed = new Set(open === null ? [] : unreadableList(open));
      for (const other of this.failing.values()) {
        if (other.tenantId === entry.tenantId && other.kind === entry.kind) {
          listed.add(other.secret);
        }
      }
      const event: OperationalEventInput = {
        code: SECRET_READ_FAILED_CODE,
        severity: OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity,
        message:
          `A stored ${context.purpose} secret cannot be read with this installation's keys ` +
          `(${errorCode(error)}); it has to be re-entered.`,
        dedupeKey,
        // Not `secret…`: the redactor blanks any context key that names a secret.
        context: {
          kind: entry.kind,
          purpose: context.purpose,
          entityId: context.entityId,
          errorCode: errorCode(error),
          unreadable: [...listed].sort(),
        },
      };
      const recorded = await recordQuietly(this.deps.recorder, scope, event, this.deps.logger);
      // Not recorded: try again on the next failure rather than waiting out the window.
      if (recorded === null) entry.recordedAt = Number.NEGATIVE_INFINITY;
    })();
    this.recording.set(pair, work);
    void work
      .catch(() => undefined)
      .finally(() => {
        if (this.recording.get(pair) === work) this.recording.delete(pair);
      });
    this.track(work);
  }

  private async writeClose(tenantId: string, kind: UnreadableSecretKind): Promise<boolean> {
    const recorded = await recordQuietly(
      this.deps.recorder,
      tenantScope(tenantId),
      {
        code: SECRET_READ_OK_CODE,
        severity: OPS_ERROR_CLASS_POLICY.INFO.storedSeverity,
        message: `Stored ${kind} secrets read again with this installation's keys.`,
        context: { kind },
        recoversCode: SECRET_READ_FAILED_CODE,
        recoversDedupeKey: secretUnreadableConditionKey(kind),
      },
      this.deps.logger,
    );
    return recorded !== null;
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined);
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }
}

/**
 * The cipher the background lanes read their credentials through: the installation's own
 * cipher, unchanged, with every decrypt reported to `UnreadableSecretReporter`.
 *
 * It rethrows the original error untouched — a caller that switches on the code (the
 * bootstrap remedy, a token comparison) behaves exactly as before — and returns the
 * plaintext untouched. Encryption and masking are the inner cipher's.
 */
export class ReportingSecretCipher implements SecretCipher {
  constructor(
    private readonly inner: SecretCipher,
    private readonly reporter: Pick<UnreadableSecretReporter, 'failed' | 'readable'>,
  ) {}

  encrypt(plaintext: string, context: SecretContext): EncryptedSecret {
    return this.inner.encrypt(plaintext, context);
  }

  decrypt(secret: EncryptedSecret, context: SecretContext): string {
    let plaintext: string;
    try {
      plaintext = this.inner.decrypt(secret, context);
    } catch (error) {
      this.reporter.failed(context, secret, error);
      throw error;
    }
    this.reporter.readable(context);
    return plaintext;
  }

  mask(secret: EncryptedSecret): string {
    return this.inner.mask(secret);
  }
}

/**
 * One entry per stored secret. The backup password is the exception: a re-entered password is
 * a NEW row (the old one is superseded, never updated), so keyed by row the old failure would
 * hold the condition open after the fix. There is one current password per tenant, so the
 * purpose alone names it.
 */
function secretKey(context: SecretContext): string {
  return `${context.tenantId}|${secretId(context)}`;
}

/** `purpose|row` — the tenant is the condition's own scope. */
function secretId(context: SecretContext): string {
  const entity = context.purpose === 'backup.archive_password' ? 'current' : context.entityId;
  return `${context.purpose}|${entity}`;
}

function unreadableList(context: Record<string, unknown>): string[] {
  const list = context['unreadable'];
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

function tenantScope(tenantId: string): TenantContext {
  return { tenantId: asId<'TenantId'>(tenantId), botInstanceId: null };
}

function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('platform.secret_')) return code;
    current = current.cause;
  }
  return 'platform.secret_auth_failed';
}
