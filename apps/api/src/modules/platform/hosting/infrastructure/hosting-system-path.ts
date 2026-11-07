import {
  withSystemScope,
  withSystemScopeIn,
} from '../../../../infrastructure/persistence/database-scope.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * One cross-tenant statement group of the activation, on the RLS system path (ADR-0037).
 *
 * `reason` is a LITERAL at every call site and pinned in `tests/unit/system-path-allowlist.ts`:
 * it is what `pg_stat_activity` and the server log show for the statement. On the caller's own
 * transaction when it has one (`withSystemScopeIn`: the audit row, the idempotency key and the
 * activation record share that transaction, and row-level security would otherwise confine
 * every statement to the tenant the transaction is bound to), else on the pool.
 *
 * Keep `fn` NARROW: one query, its predicate naming the tenant (or the one row) it is about.
 */
export function acrossTenants<T>(tx: unknown, reason: string, fn: () => Promise<T>): Promise<T> {
  const open = (tx as TransactionScope | undefined)?.tx;
  return open === undefined ? withSystemScope(reason, fn) : withSystemScopeIn(open, reason, fn);
}
