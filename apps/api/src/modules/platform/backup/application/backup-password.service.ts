import {
  errors,
  IDENTITY_ERROR_CODES,
  isNexaError,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type SecretCipher,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';

/**
 * The owner-set backup password (Round 4 PR-E, E4).
 *
 * WHAT IT IS. The one key of every 7-Zip backup archive from the next run on: an operator
 * opens a backup in 7-Zip with it and nothing else. So setting it is CRITICAL — charged on
 * `backup.download` (owner only), which is already the permission that hands out the
 * archive — and behind the same account-password step-up the Recovery Kit export uses.
 *
 * WHAT IT NEVER DOES. Return the password, log it, put it in an audit row, an operational
 * event, the idempotency store (not even a hash of it — an unsalted digest of a password is
 * an offline-guessing target), or argv (`seven-zip.ts` hands it to 7-Zip on stdin). It is
 * sealed with `SecretCipher` under purpose `backup.archive_password`, bound to its own row.
 *
 * A REPLACEMENT SUPERSEDES, never deletes: the archives the previous password sealed must
 * still open here, so every stored password stays (newest first) for `open` to try.
 */

export const BACKUP_PASSWORD_PERMISSION: PermissionKey = 'backup.download';

export interface StoredBackupPassword {
  readonly id: string;
  readonly createdAt: Date;
}

export interface BackupPasswordStore {
  current(scope: TenantContext, tx?: TransactionScope): Promise<StoredBackupPassword | null>;
  /** Supersedes the current row (if any) and inserts the new one, in `tx`. */
  replace(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly ciphertext: string;
      readonly keyId: string;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: TransactionScope,
  ): Promise<{ readonly supersededId: string | null }>;
}

export interface BackupPasswordServiceDeps {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly cipher: SecretCipher;
  readonly store: BackupPasswordStore;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly verifyStepUp: (
    scope: TenantContext,
    actor: ActorContext,
    stepUp: { password: string; code?: string; backupCode?: string },
    context: { ip: string | null },
    action: string,
  ) => Promise<void>;
}

/** Characters 7-Zip's one-line stdin read would cut or mangle. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The idempotency fingerprint. Deliberately NOT derived from the password: a key reused
 * with a different password replays the first answer ("set at …") rather than storing a
 * digest of either. The step-up already ran for the replaying request.
 */
const REQUEST_HASH = 'backup.archive_password.set.v1';

export class BackupPasswordService {
  constructor(private readonly deps: BackupPasswordServiceDeps) {}

  async status(scope: TenantContext): Promise<{ configured: boolean; setAt: Date | null }> {
    const current = await this.deps.store.current(scope);
    return { configured: current !== null, setAt: current?.createdAt ?? null };
  }

  async set(
    scope: TenantContext,
    actor: ActorContext,
    command: {
      readonly idempotencyKey: string;
      readonly password: string;
      readonly stepUp: { password: string; code?: string; backupCode?: string };
    },
    context: { ip: string | null },
  ): Promise<{ setAt: Date; replayed: boolean }> {
    const denial = {
      action: 'backup.archive_password_set',
      entityType: 'BackupArchivePassword',
      entityId: null,
    };
    // The permission BEFORE the step-up: a holder of a session without the permission
    // must not be able to use this endpoint to test account passwords.
    try {
      await this.deps.guard.check(scope, actor, BACKUP_PASSWORD_PERMISSION);
    } catch (denied) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        BACKUP_PASSWORD_PERMISSION,
        denial,
        denied,
      );
      throw denied;
    }
    if (hasControlCharacter(command.password)) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_PASSWORD_INVALID,
        'A backup password cannot contain line breaks or other control characters.',
      );
    }
    try {
      await this.deps.verifyStepUp(scope, actor, command.stepUp, context, denial.action);
    } catch (error) {
      if (
        isNexaError(error) &&
        (error.code === IDENTITY_ERROR_CODES.AUTH_INVALID_CREDENTIALS ||
          error.code === IDENTITY_ERROR_CODES.AUTH_STEP_UP_FAILED)
      ) {
        // A VALIDATION refusal, not a 401: the session is fine, the step-up failed, and a
        // 401 would sign the owner out of the page. The verifier wrote the DENIED row.
        throw errors.validation(
          PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_PASSWORD_REAUTHENTICATION_FAILED,
          'Your account password was not accepted, so the backup password was not changed.',
        );
      }
      throw error;
    }

    const existing = await this.deps.idempotency.find<{ setAt: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      REQUEST_HASH,
    );
    if (existing) return { setAt: new Date(existing.result.setAt), replayed: true };

    const result = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BACKUP_PASSWORD_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        const id = this.deps.ids.uuid();
        const now = this.deps.clock.now();
        const sealed = this.deps.cipher.encrypt(command.password, {
          purpose: 'backup.archive_password',
          tenantId: scope.tenantId,
          entityId: id,
        });
        const replaced = await this.deps.store.replace(
          scope,
          {
            id,
            ciphertext: sealed.ciphertext,
            keyId: sealed.keyId,
            now,
            adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
          },
          tx,
        );
        // Who, when, and that one was replaced. Never the value, never a digest of it.
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'backup.archive_password_set',
            entityType: 'BackupArchivePassword',
            entityId: id,
            before: replaced.supersededId === null ? null : { passwordId: replaced.supersededId },
            after: { passwordId: id, setAt: now.toISOString() },
            reason: 'The owner set the password that seals new backup archives.',
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          REQUEST_HASH,
          { setAt: now.toISOString() },
          tx,
        );
        return { setAt: now };
      },
    );
    return { setAt: result.setAt, replayed: false };
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}
