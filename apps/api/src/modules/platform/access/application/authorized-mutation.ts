import { isNexaError } from '@nexa/contracts';
import type {
  ActorContext,
  AuditWriter,
  OperationalEventRecorder,
  PermissionKey,
  ScopeContext,
  UnitOfWork,
} from '@nexa/contracts';
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
 * So the decision that counts is re-run here, on the transaction's own
 * connection, before the callback does anything. A permission read on the pool
 * would not participate in the caller's transaction — it neither sees the
 * transaction's snapshot nor holds its locks — so `tx` is not an optimisation,
 * it is the difference between checking the authority that will commit and
 * checking some other authority.
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
      await deps.guard.check(scope, actor, permission, tx);
      return fn(tx);
    });
  } catch (error) {
    if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') {
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
