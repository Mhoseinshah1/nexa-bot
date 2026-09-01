import { and, eq, sql } from 'drizzle-orm';
import type { ScopeContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { adminLoginThrottle } from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  LoginThrottleRepository,
  ThrottleState,
  ThrottleSubjectKind,
} from '../application/ports.js';

/**
 * Durable login throttling.
 *
 * In the database rather than in Redis for two reasons. An attacker must not be
 * able to clear their own counter by waiting out a cache eviction or a restart;
 * and the window advances by an injected Clock, so the tests assert lockout and
 * expiry without sleeping.
 *
 * Keyed by SUBJECT — the submitted username, or the client IP — never by admin
 * id. A username that does not exist is throttled exactly like one that does,
 * because throttling only real accounts turns the lockout into a username
 * oracle that identical error text does not hide.
 */
export class DrizzleLoginThrottleRepository implements LoginThrottleRepository {
  constructor(private readonly db: Database) {}

  async find(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
  ): Promise<ThrottleState | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(adminLoginThrottle)
      .where(
        and(
          eq(adminLoginThrottle.tenantId, tenantId),
          eq(adminLoginThrottle.subjectKind, kind),
          eq(adminLoginThrottle.subject, subject),
        ),
      )
      .limit(1);
    return row ? { failedCount: row.failedCount, lockedUntil: row.lockedUntil } : null;
  }

  /**
   * Counts one attempt as a single atomic statement.
   *
   * The previous version read the row `FOR UPDATE`, computed the next count in
   * JavaScript, then upserted it. That serialises correctly only when the row
   * already exists — `FOR UPDATE` on a missing row locks nothing, so every
   * concurrent transaction computed `1` and they all wrote `1`. Ten simultaneous
   * failed logins registered as one, and since a successful login DELETES the
   * row, that no-row state recurs constantly. An attacker who sent guesses in
   * bursts rather than sequentially spent one attempt from a budget of five.
   *
   * The count is therefore computed inside the statement, from the row version
   * the conflict actually resolves against, so concurrent inserts serialise on
   * the unique index and each increments what the previous one wrote.
   *
   * An existing lock is never cleared here: `locked_until` is only ever moved
   * forward. Otherwise an attacker could wait out the counting WINDOW — which is
   * configured separately from the lockout — and have the reset clear a lockout
   * that had not expired.
   */
  async reserveAttempt(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    now: Date,
    policy: { windowSeconds: number; maxAttempts: number; lockoutSeconds: number },
  ): Promise<ThrottleState> {
    const tenantId = requireTenantId(scope);
    // A window that started at or before this instant has expired.
    const windowCutoff = new Date(now.getTime() - policy.windowSeconds * 1000);
    const lockedUntil = new Date(now.getTime() + policy.lockoutSeconds * 1000);

    const nextCount = sql`CASE
        WHEN ${adminLoginThrottle.windowStartedAt} <= ${windowCutoff} THEN 1
        ELSE ${adminLoginThrottle.failedCount} + 1
      END`;

    const rows = await this.db
      .insert(adminLoginThrottle)
      .values({
        tenantId,
        subjectKind: kind,
        subject,
        failedCount: 1,
        windowStartedAt: now,
        lockedUntil: policy.maxAttempts <= 1 ? lockedUntil : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          adminLoginThrottle.tenantId,
          adminLoginThrottle.subjectKind,
          adminLoginThrottle.subject,
        ],
        set: {
          failedCount: nextCount,
          windowStartedAt: sql`CASE
            WHEN ${adminLoginThrottle.windowStartedAt} <= ${windowCutoff} THEN ${now}
            ELSE ${adminLoginThrottle.windowStartedAt}
          END`,
          lockedUntil: sql`CASE
            WHEN (${nextCount}) >= ${policy.maxAttempts} THEN ${lockedUntil}
            ELSE ${adminLoginThrottle.lockedUntil}
          END`,
          updatedAt: now,
        },
      })
      .returning({
        failedCount: adminLoginThrottle.failedCount,
        lockedUntil: adminLoginThrottle.lockedUntil,
      });

    const row = rows[0];
    if (row === undefined) {
      // An upsert with a matching conflict target always returns its row. If it
      // did not, reporting "no failures recorded" would understate the state
      // that protects the account.
      throw new Error('The login throttle upsert returned no row.');
    }
    return { failedCount: row.failedCount, lockedUntil: row.lockedUntil };
  }

  /**
   * Returns one reserved attempt. Never drops below zero, and never touches the
   * window or an existing lockout — this undoes a reservation, it does not
   * forgive a failure.
   */
  async releaseAttempt(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(adminLoginThrottle)
      .set({ failedCount: sql`GREATEST(${adminLoginThrottle.failedCount} - 1, 0)` })
      .where(
        and(
          eq(adminLoginThrottle.tenantId, tenantId),
          eq(adminLoginThrottle.subjectKind, kind),
          eq(adminLoginThrottle.subject, subject),
        ),
      );
  }

  async clear(scope: ScopeContext, kind: ThrottleSubjectKind, subject: string): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .delete(adminLoginThrottle)
      .where(
        and(
          eq(adminLoginThrottle.tenantId, tenantId),
          eq(adminLoginThrottle.subjectKind, kind),
          eq(adminLoginThrottle.subject, subject),
        ),
      );
  }
}
