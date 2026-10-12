import { sql } from 'drizzle-orm';
import type { Database, Executor } from './database.js';
import type { TransactionScope } from './unit-of-work.js';

/**
 * Phase 7 (review M1) — ONE lock serialising the two confirmations that start a restore of
 * this installation: a NEXA restore's confirm (`RecoveryService.confirm`) and a Mirza import's
 * approval (`LegacyMigrationService.approve`).
 *
 * Each reads whether the OTHER holds the installation and then commits its own state change.
 * Without a common lock that is check-then-act across two transactions: both can read
 * "nothing holds it" and both commit, after which each executor waits for the other. With it,
 * the second waits for the first to commit and then reads its row. A transaction-scoped
 * advisory lock: released with the transaction, never held across a request.
 *
 * Installation-wide, keyed by a fixed name (no tenant): the two things it serialises are
 * installation-wide too.
 */
const RESTORE_EXCLUSION_LOCK_NAME = 'nexa:restore-exclusion:v1';

/** Takes the lock on the caller's transaction (a `TransactionScope`, unwrapped). */
export async function takeRestoreExclusionLock(tx: unknown): Promise<void> {
  const executor = (tx as TransactionScope).tx;
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${RESTORE_EXCLUSION_LOCK_NAME}, 0))`,
  );
}

/**
 * Runs `fn` in its own transaction holding the lock — for a write path that has no unit of
 * work of its own (the recovery confirmation writes through its repository).
 */
export function withRestoreExclusion<T>(
  db: Database,
  fn: (tx: TransactionScope) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx: Executor) => {
    const scope = {
      tx,
      scope: { kind: 'SYSTEM', reason: 'restore-exclusion' },
    } as TransactionScope;
    await takeRestoreExclusionLock(scope);
    return fn(scope);
  });
}
