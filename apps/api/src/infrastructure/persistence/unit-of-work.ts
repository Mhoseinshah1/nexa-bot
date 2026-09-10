import {
  errors,
  isSystemContext,
  PLATFORM_ERROR_CODES,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { withinTransaction } from '../transaction-boundary.js';
import { assertInstallationWritable, type InstallationWriteGate } from './write-gate.js';
import type { Database, Executor } from './database.js';

/**
 * The unit of work.
 *
 * Domain changes, the audit row and the outbox rows commit together or not at
 * all. Every business write runs inside one of these.
 *
 * `withTenant(tenantId, fn)` is deliberately shaped the way Postgres row-level
 * security would need it — a transaction with the tenant bound for its whole
 * duration. Phase 0 enforces tenant scoping in the repository layer only
 * (see docs/adr/0004-tenant-isolation.md); if RLS is adopted later, it becomes
 * one `SET LOCAL app.current_tenant_id` inside this method rather than a sweep
 * over every read in the codebase.
 */

export interface TransactionScope {
  readonly tx: Executor;
  readonly scope: ScopeContext;
}

export class DrizzleUnitOfWork implements UnitOfWork<TransactionScope> {
  /**
   * The write gate is a constructor dependency, not a parameter.
   *
   * So that "this unit of work does not gate writes" cannot be the accidental
   * result of a call site omitting an argument. A process that genuinely has no
   * recovery module — the migrator — passes `UNGATED` explicitly, which is a
   * decision a reader can see rather than an `undefined` they have to interpret.
   */
  constructor(
    private readonly db: Database,
    private readonly gate: InstallationWriteGate,
  ) {}

  async run<T>(scope: ScopeContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    // Marked, so a network sink can refuse. See `transaction-boundary.ts`: the
    // no-network-inside-a-transaction rule was documented in four places and
    // enforced in none, and the outbox relay runs consumers inside its claim
    // transaction by design.
    return withinTransaction(transactionLabelFor(scope), () =>
      this.db.transaction(async (tx) => {
        /*
         * THE QUIESCE GATE, and this is the only place it could go.
         *
         * ADR-0028 § 5. Every durable write in this codebase opens its
         * transaction here, so a recovery that has shut the installation is
         * enforced by construction rather than by ten call sites remembering to
         * ask. `CLAUDE.md` records what the alternative costs: panels was the one
         * module that skipped the scope-activity check, and a tenant an operator
         * had stopped was given new panels and a background monitor.
         *
         * INSIDE the transaction, as its first statement, for the same reason
         * `runAuthorizedMutation` re-checks the permission here: nothing this
         * transaction will commit has happened yet, so a quiesce that committed
         * before this read cannot be overtaken.
         *
         * `runSnapshot` below is deliberately NOT gated. It is the
         * consistent-READ path, and an operator supervising a recovery is
         * reading.
         */
        await assertInstallationWritable(this.gate, scope, { tx, scope });
        return fn({ tx, scope });
      }),
    );
  }

  /**
   * A transaction whose statements all see ONE snapshot.
   *
   * `run` is READ COMMITTED, which is the connection default and the right
   * choice for a write: each statement sees the newest committed state, which
   * is what an optimistic predicate needs. It is the wrong choice for a
   * multi-statement READ that has to be internally consistent — two reads in a
   * `run` can straddle somebody else's commit and produce a reply describing a
   * state that never existed.
   *
   * That distinction is why this is a separate method rather than an option:
   * the previous code wrapped two reads in `run` under a comment saying they
   * were therefore atomic, and they were not.
   */
  async runSnapshot<T>(scope: ScopeContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return withinTransaction(transactionLabelFor(scope), () =>
      this.db.transaction(async (tx) => fn({ tx, scope }), {
        isolationLevel: 'repeatable read',
      }),
    );
  }

  /**
   * A savepoint inside the caller's transaction.
   *
   * Drizzle turns a nested `transaction()` into `SAVEPOINT` / `ROLLBACK TO`,
   * which is the only thing that makes "this part may fail and the rest
   * stands" true in Postgres. A plain try/catch does not: the failed statement
   * has already aborted the transaction, so the catch keeps nothing and the
   * caller's write dies with `current transaction is aborted` instead of with
   * the error that actually happened.
   */
  async runNested<T>(
    scope: ScopeContext,
    tx: TransactionScope,
    fn: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    // A SAVEPOINT requires a live transaction. Drizzle's `transaction()` exists
    // on the pooled database too, where it opens an independent `BEGIN` — and
    // an independent transaction commits on its own, so a caller believing it
    // had a savepoint would silently have a second, unrelated write. The
    // callers here reach this through a `tx?: unknown` parameter and an
    // unchecked cast, so the type system is not what keeps that from happening.
    if (!isTransactionScope(tx)) {
      throw new Error(
        'runNested was given something that is not a transaction scope; a SAVEPOINT needs a live transaction.',
      );
    }
    // Not re-marked: a SAVEPOINT runs inside the caller's transaction, which is
    // already marked. Re-entering would only change the label, and the label of
    // the outermost transaction is the one an operator needs.
    return tx.tx.transaction(async (nested) => fn({ tx: nested, scope }));
  }

  /**
   * Convenience wrapper for the common tenant-scoped case.
   *
   * DELIBERATELY UNUSED, and not to be removed as dead code.
   *
   * This is the seam Postgres row-level security would attach to: a transaction
   * with the tenant bound for its whole duration, so adopting RLS becomes one
   * `SET LOCAL app.current_tenant_id` here rather than a sweep over every read
   * in the codebase (ADR-0004). Callers use `run` with an explicit scope today
   * because the repository layer enforces scoping; the value of this method is
   * the shape it holds open, not the line it saves.
   *
   * A dead-code sweep will find it. It has been found and kept on purpose —
   * twice now. If such a check is ever automated, exempt this method by name
   * and cite ADR-0004 rather than deleting it and rediscovering why it existed.
   */
  async withTenant<T>(tenant: TenantContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return this.run(tenant, fn);
  }
}

/**
 * A name for the transaction a refusal happened inside.
 *
 * The tenant, or the system scope's own reason. Not the SQL and not a stack: the
 * sentence an operator needs is "the Telegram transport sent inside the
 * tenant:01a0... transaction", and a scope is what identifies that.
 */
function transactionLabelFor(scope: ScopeContext): string {
  return isSystemContext(scope) ? `system:${scope.reason}` : `tenant:${scope.tenantId}`;
}

/**
 * The repository guard.
 *
 * Every tenant-scoped query resolves its tenant through this. A repository
 * method that forgets to call it does not compile against `TenantScoped`, and a
 * call that arrives with a system scope where a tenant is required fails loudly
 * rather than returning another tenant's rows.
 */
export function requireTenantId(scope: ScopeContext): string {
  if (isSystemContext(scope)) {
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
      `This operation requires a tenant context, but ran under the system scope (${scope.reason}). ` +
        'Cross-tenant reads must go through an explicit cross-tenant query service.',
    );
  }
  return scope.tenantId;
}

/**
 * The value written to `scope_ref` columns, which cannot be null.
 *
 * The namespace is part of the key, not decoration. Without it every
 * system-scoped caller shares one `'SYSTEM'` namespace, and an idempotency key
 * minted by one surface collides with a key minted by another — which is
 * exactly how an HTTP caller could once suppress or wedge a Telegram update by
 * guessing its sequential `update_id`.
 */
export function scopeRef(scope: ScopeContext, namespace: string): string {
  const scopeToken = isSystemContext(scope) ? 'SYSTEM' : scope.tenantId;
  return `${scopeToken}|${namespace}`;
}

/** The nullable `tenant_id` column value for a scope. */
export function scopeTenantId(scope: ScopeContext): string | null {
  return isSystemContext(scope) ? null : scope.tenantId;
}

/**
 * Whether a value really is a live transaction scope.
 *
 * Structural, because the shape is what matters: `tx.tx` must be a Drizzle
 * transaction object rather than the pool. A pooled `Database` also has
 * `transaction`, which is exactly why `typeof tx.tx.transaction === 'function'`
 * is not sufficient on its own — the discriminator is the `rollback` method
 * that only a transaction carries.
 */
function isTransactionScope(value: unknown): value is TransactionScope {
  if (typeof value !== 'object' || value === null) return false;
  const inner = (value as { tx?: unknown }).tx;
  return (
    typeof inner === 'object' &&
    inner !== null &&
    typeof (inner as { rollback?: unknown }).rollback === 'function'
  );
}
