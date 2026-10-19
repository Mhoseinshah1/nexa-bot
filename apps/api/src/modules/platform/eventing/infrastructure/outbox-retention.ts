import { sql } from 'drizzle-orm';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { outboxMessages } from '../../../../infrastructure/persistence/schema.js';

/**
 * Retention for the transactional outbox (Round 4 PR-E, E3).
 *
 * THE RULE, in the statement and nowhere else: a row is removed only when it is
 * PUBLISHED (`published_at IS NOT NULL`) and was published before `cutoff`. A message
 * that is pending, failing, or exhausted has a NULL `published_at` and is never a
 * candidate, whatever its age — an unpublished message is work, not history.
 *
 * Safe against the outbox's own invariants:
 *   - the append-only guard (`nexa_outbox_guard`) is an UPDATE trigger; a DELETE of a
 *     published row rewrites no content;
 *   - per-aggregate sequences come from `aggregate_sequences`, not from MAX(sequence), so
 *     removing an aggregate's published history does not hand its numbers out again;
 *   - the relay's ordering check (`noEarlierLiveSibling`) looks only at UNPUBLISHED
 *     earlier siblings, which this never removes;
 *   - `processed_messages` is left alone: a published message is never offered to a
 *     consumer again, so its dedupe row there is inert, and deleting the ledger would be a
 *     second policy nobody asked for.
 *
 * Batched: one short DELETE of at most `limit` ids, so no statement holds a long lock.
 */
export async function purgePublishedOutboxBefore(
  db: Database,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ${outboxMessages}
     WHERE id IN (
       SELECT candidate.id FROM ${outboxMessages} AS candidate
        WHERE candidate.published_at IS NOT NULL
          AND candidate.published_at < ${cutoff}
        LIMIT ${limit}
     )
  `);
  return result.rowCount ?? 0;
}
