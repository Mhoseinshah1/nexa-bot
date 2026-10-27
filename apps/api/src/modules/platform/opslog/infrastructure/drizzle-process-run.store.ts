import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { processRuns } from '../../../../infrastructure/persistence/schema.js';
import type { ProcessRunRecord, ProcessRunStore } from '../application/process-run-state.js';

/**
 * `process_runs`: the latest life of each process role, one row per role.
 *
 * Installation-wide and not tenant-owned (a role is the deployment's, and the row holds no
 * customer, money or secret), so there is no scope to take or activity to read: the
 * announcement a row leads to is an operational event, recorded through the tenant-scoped
 * recorder, which is where the scope rules apply.
 *
 * `transact` serialises two boots of one role (a replica started beside a restart) on a
 * transaction-scoped advisory lock rather than `SELECT ... FOR UPDATE`, because the first
 * boot of a role has no row to lock.
 */
export class DrizzleProcessRunStore implements ProcessRunStore {
  constructor(private readonly db: Database) {}

  async transact(
    role: string,
    change: (previous: ProcessRunRecord | null) => ProcessRunRecord | null,
  ): Promise<ProcessRunRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`process-runs:${role}`}, 0))`,
      );
      const [row] = await tx.select().from(processRuns).where(eq(processRuns.role, role));
      const previous: ProcessRunRecord | null =
        row === undefined
          ? null
          : {
              runId: row.runId,
              startedAt: row.startedAt,
              stableAt: row.stableAt,
              stoppedAt: row.stoppedAt,
              restarts: row.restarts,
              restartsSince: row.restartsSince,
            };
      const next = change(previous);
      if (next === null) return null;
      const values = {
        runId: next.runId,
        startedAt: next.startedAt,
        stableAt: next.stableAt,
        stoppedAt: next.stoppedAt,
        restarts: next.restarts,
        restartsSince: next.restartsSince,
      };
      await tx
        .insert(processRuns)
        .values({ role, ...values })
        .onConflictDoUpdate({ target: processRuns.role, set: values });
      return next;
    });
  }
}
