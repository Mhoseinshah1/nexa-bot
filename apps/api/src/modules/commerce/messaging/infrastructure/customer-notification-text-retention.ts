import { sql } from 'drizzle-orm';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { customerNotifications } from '../../../../infrastructure/persistence/schema.js';
import { withSystemScope } from '../../../../infrastructure/persistence/database-scope.js';

/**
 * Retention for the words the notification centre keeps (R11 B1).
 *
 * THE RULE, in the statement: only `rendered_text` and `customer_read_at` are cleared, and only
 * on a row whose delivery (`resolved_at`) is older than `cutoff`. The row itself stays: its
 * `customer_notifications_subject_key` is the lane's told-once guarantee and data compaction
 * decides, kind by kind, when a row may go. Both columns go in ONE statement because the
 * table's CHECK forbids a read mark on a row with no text. A row without text is not listed.
 * Nothing is sent to anyone.
 *
 * Cross-tenant by nature, so on the system path under a named reason (ADR-0037).
 */
export async function clearExpiredNotificationText(
  db: Database,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const result = await withSystemScope('customer notification text retention', () =>
    db.execute(sql`
    UPDATE ${customerNotifications}
       SET rendered_text = NULL, customer_read_at = NULL
     WHERE id IN (
       SELECT candidate.id FROM ${customerNotifications} AS candidate
        WHERE candidate.rendered_text IS NOT NULL
          AND candidate.resolved_at < ${cutoff}
        LIMIT ${limit}
     )
  `),
  );
  return result.rowCount ?? 0;
}
