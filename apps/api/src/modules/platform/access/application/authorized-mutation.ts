import { errors, isNexaError } from '@nexa/contracts';
import type {
  ActorContext,
  AuditWriter,
  Clock,
  OperationalEventRecorder,
  PermissionKey,
  ScopeContext,
  UnitOfWork,
} from '@nexa/contracts';
import { IDENTITY_ERROR_CODES } from '@nexa/contracts';
import type { AdminSessionId } from '@nexa/contracts';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from './permission-guard.js';

export interface MutationDenial {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
}

export interface AuthorizedMutationDeps {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

/**
 * Runs a protected mutation whose authority is established INSIDE the
 * transaction that commits it.
 *
 * The check a surface makes before the transaction is an early rejection and
 * nothing more — ADR-0014 says so, and Phase 1's administrator mutations
 * already act on it. Between that check and the commit there is a window with
 * database reads, validation and an idempotency lookup in it, and an owner
 * revoking a role or disabling an administrator inside that window was losing
 * the race: the mutation, its SUCCESS audit row, its outbox event and its
 * idempotency completion all committed on authority that no longer existed.
 *
 * So the decision that counts is re-run here, before the callback does
 * anything, and it is the POSITION that carries the guarantee: nothing this
 * transaction will commit has happened yet, so a revocation that committed
 * before this read cannot be overtaken.
 *
 * Passing `tx` is not what makes the check authoritative, and an earlier
 * version of this comment claimed it was. The unit of work runs at READ
 * COMMITTED and this is its first statement, so at this instant a pool read
 * would see the same committed rows and hold the same locks — which is to say,
 * none. `tx` is here for two other reasons, both real: it keeps the read on
 * the connection this transaction already holds rather than taking a second
 * one from the pool while holding one, and it puts `PermissionGuard.check` on
 * its transactional branch, so the guard does not write its denial event from
 * inside a transaction. The guard's own docblock records what that costs — at
 * pool exhaustion, every connection held by a transaction waiting for a
 * connection that never comes.
 *
 * A no-op is authorized like any other outcome. "Nothing changed" is still the
 * answer to a protected command, it still consumes an idempotency key, and an
 * actor who has lost the permission is not entitled to it.
 *
 * The denial is recorded AFTER the transaction has unwound. The guard
 * deliberately writes no operational event from inside a transaction — it
 * would take a second pool connection while holding one, which deadlocks the
 * process at pool exhaustion — and the row would roll back with the denial
 * anyway. Recording it here, on the pool, is the same division of labour
 * `AdminManagementService.runLockedMutation` uses.
 */
export async function runAuthorizedMutation<T>(
  deps: AuthorizedMutationDeps,
  scope: ScopeContext,
  actor: ActorContext,
  permission: PermissionKey,
  denial: MutationDenial,
  fn: (tx: TransactionScope) => Promise<T>,
): Promise<T> {
  try {
    return await deps.uow.run(scope, async (tx) => {
      await assertSessionStillLive(deps, scope, actor, tx);
      await deps.guard.check(scope, actor, permission, tx);
      return fn(tx);
    });
  } catch (error) {
    // This permission's denial, not any denial. `PERMISSION_DENIED` is also
    // how a missing tenant context surfaces, and recording that as
    // "deniedPermission: settings.edit" would put a false statement in the
    // audit log — the one place that must not contain one.
    if (
      isNexaError(error) &&
      error.kind === 'PERMISSION_DENIED' &&
      error.details['permission'] === permission
    ) {
      await deps.opsLog.record(scope, deps.guard.denialEvent(actor, permission));
      await deps.audit.record(scope, actor, {
        action: denial.action,
        entityType: denial.entityType,
        entityId: denial.entityId,
        before: null,
        after: { deniedPermission: permission, reason: error.code },
        result: 'DENIED',
      });
    }
    throw error;
  }
}

/**
 * Refuses if the session authorising this request has been revoked.
 *
 * Permissions and sessions are two different revocations and this used to
 * honour only one. `authenticated-request.ts` states that `sessionId` is
 * required *"so a mutation can confirm, under the lock it takes anyway, that
 * this session has not been revoked since the request arrived"* — and Phase 1's
 * administrator mutations do exactly that. The control plane did not, so
 * "changing an administrator's roles stops their in-flight write" was true
 * while "revoking their sessions stops it" was false, and a signed-out or
 * password-rotated administrator's write still committed.
 *
 * Read on the transaction's connection, for the same reason the permissions
 * are.
 */
async function assertSessionStillLive(
  deps: AuthorizedMutationDeps,
  scope: ScopeContext,
  actor: ActorContext,
  tx: TransactionScope,
): Promise<void> {
  const sessionId = actor.sessionId;
  // System work has no session. It is fenced by the boundary check and by
  // holding only what the contract grants `SYSTEM_JOB`, not by this.
  if (sessionId === undefined) return;

  const live = await deps.sessions.isLive(scope, sessionId as AdminSessionId, deps.clock.now(), tx);
  if (!live) {
    throw errors.unauthenticated(
      IDENTITY_ERROR_CODES.AUTH_SESSION_INVALID,
      'The session is not valid. Sign in again.',
    );
  }
}
