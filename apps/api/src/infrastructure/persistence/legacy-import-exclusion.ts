import { sql } from 'drizzle-orm';
import { LEGACY_COMPACTION_ACTIVE_STATES } from '@nexa/contracts';
import type { Executor } from './database.js';

/**
 * A Mirza import and a legacy-data compaction of one tenant exclude each other for the
 * compaction's WHOLE lifetime (Round 4 PR-E, E1).
 *
 * The compaction archives the legacy data and then deletes from it in keyset batches. An
 * import that began after its precondition check would write history rows the archive
 * predates, on either side of the batch cursor, so they would be kept or deleted by
 * chance. A point-in-time check at REQUESTED cannot prevent that; this lock is the shared
 * exclusion both sides take, in the transaction that decides:
 *
 * - the import's row insert takes it, then refuses while a compaction is active;
 * - the compaction's REQUESTED → ARCHIVING takes it, then refuses while an import is in flight.
 *
 * A transaction-scoped advisory lock, keyed by tenant: both deciding statements run after
 * it is held, so under READ COMMITTED each sees the other's committed row. It is released at
 * COMMIT or ROLLBACK, so it is never held across the compaction's long stages; the
 * compaction's active row is what holds the exclusion from then on.
 */
export async function lockLegacyImportExclusion(tx: Executor, tenantId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nexa.legacy-import-compaction:${tenantId}`}, 0))`,
  );
}

/** Whether a compaction of this tenant is active. Read after the lock above is taken. */
export async function legacyCompactionActive(tx: Executor, tenantId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1 FROM legacy_compaction_runs
     WHERE tenant_id = ${tenantId}::uuid
       AND state = ANY(${`{${LEGACY_COMPACTION_ACTIVE_STATES.join(',')}}`}::text[])
     LIMIT 1`);
  return rows.rows.length > 0;
}
