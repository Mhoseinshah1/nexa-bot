import { sql } from 'drizzle-orm';
import type { ScopeContext } from '@nexa/contracts';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { QuietHoursPairLock } from '../application/quiet-hours.guard.js';

/**
 * The advisory-lock class for a tenant's quiet-hours pair ("QH"). One class per purpose, as
 * every lock here has; keyed by tenant within it.
 */
export const QUIET_HOURS_LOCK_CLASS = 0x5148;

/**
 * Serialises writes of `reminders.quiet_hours_start` and `_end` for one tenant (HF-A9, Codex
 * review of PR #107).
 *
 * TRANSACTION-scoped: released by the write's own commit or rollback, never by a process
 * that has to remember to. Taken before the guard reads the other boundary, so the second
 * of two concurrent writes waits for the first to commit and its read — a new statement
 * under READ COMMITTED — sees the value the first one wrote.
 */
export class DrizzleQuietHoursLock implements QuietHoursPairLock {
  async lock(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(${QUIET_HOURS_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }
}
