import {
  errors,
  isSystemContext,
  PLATFORM_ERROR_CODES,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
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
  constructor(private readonly db: Database) {}

  async run<T>(scope: ScopeContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn({ tx, scope }));
  }

  /** Convenience wrapper for the common tenant-scoped case. */
  async withTenant<T>(tenant: TenantContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return this.run(tenant, fn);
  }
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
