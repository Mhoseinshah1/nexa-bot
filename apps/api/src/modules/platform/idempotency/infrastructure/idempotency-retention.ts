import { sql } from 'drizzle-orm';
import { IDEMPOTENCY_EXPIRING_NAMESPACES } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requestIdempotency } from '../../../../infrastructure/persistence/schema.js';

/**
 * Retention for the idempotency store (Round 4 PR-E, E3).
 *
 * THE RULE, in the statement: a key is removed only when it is older than `cutoff` AND
 * its namespace is an INTERACTIVE one (`IDEMPOTENCY_EXPIRING_NAMESPACES`: `WEB`,
 * `TELEGRAM`) — a key minted per form submission or per Telegram update, whose only job
 * is to absorb a retry that comes seconds, at most a day, later.
 *
 * Keys in `WORKER`, `SCHEDULER` and `API` are NEVER removed. They are derived, not
 * random — `legacy-import:trial:<run>:<customer>`, `service-refund:<request>` — and they
 * are what stops a re-run of the importer or a money job from applying its effect twice.
 * Expiring one would turn "already done" into "do it again" for a refund.
 *
 * `scope_ref` is `<tenant or SYSTEM>|<namespace>` (`scopeRef`), so the namespace is its
 * suffix after the one `|`.
 */
export async function purgeExpiredIdempotencyBefore(
  db: Database,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const namespaces = sql.join(
    IDEMPOTENCY_EXPIRING_NAMESPACES.map((namespace) => sql`${`%|${namespace}`}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    DELETE FROM ${requestIdempotency}
     WHERE id IN (
       SELECT candidate.id FROM ${requestIdempotency} AS candidate
        WHERE candidate.created_at < ${cutoff}
          AND candidate.scope_ref LIKE ANY (ARRAY[${namespaces}])
        LIMIT ${limit}
     )
  `);
  return result.rowCount ?? 0;
}
