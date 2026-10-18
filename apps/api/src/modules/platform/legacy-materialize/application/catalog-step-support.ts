import { COMMERCE_ERROR_CODES, errors, type PermissionKey, type UnitOfWork } from '@nexa/contracts';
import type { IdGenerator } from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { MaterializeContext, MaterializeStepOutcome } from './ports.js';

/** The catalogue steps run as the migration's SYSTEM_JOB, under the importer's own permission. */
export const CATALOG_MATERIALIZE_PERMISSION = 'maintenance.run' satisfies PermissionKey;

export interface CatalogStepDeps {
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
}

/**
 * What a catalogue step reports beyond the contract: why a carried row is not what a customer
 * can buy, and what was created beside it. Counts only.
 */
export interface CatalogStepOutcome extends MaterializeStepOutcome {
  readonly notes: Readonly<Record<string, number>>;
}

export function bump(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

/**
 * One transaction: the permission, then the scope's activity — both read INSIDE it, as every
 * write path does — then the step's writes. A step that stops mid-way writes nothing.
 */
export async function inCatalogTransaction<T>(
  deps: CatalogStepDeps,
  ctx: MaterializeContext,
  fn: (tx: TransactionScope) => Promise<T>,
): Promise<T> {
  return deps.uow.run(ctx.scope, async (tx) => {
    await deps.guard.check(ctx.scope, ctx.actor, CATALOG_MATERIALIZE_PERMISSION, tx);
    if (!(await deps.scopeActivity.scopeIsActive(ctx.scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
    return fn(tx);
  });
}

export function outcome(
  step: string,
  counts: { written: number; alreadyPresent: number; diverged: number },
  skipped: Record<string, number>,
  notes: Record<string, number>,
): CatalogStepOutcome {
  return { step, ...counts, skipped, notes };
}
