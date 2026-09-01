import { and, eq, sql } from 'drizzle-orm';
import type { ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { adminLoginThrottle } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
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
function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

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
    return row
      ? {
          failedCount: row.failedCount,
          lockedUntil: row.lockedUntil,
          windowStartedAt: row.windowStartedAt,
        }
      : null;
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
   * An UNEXPIRED lock is never cleared here: otherwise an attacker could wait
   * out the counting WINDOW — configured separately from the lockout — and have
   * the window reset clear a lockout that had not run its course.
   *
   * An EXPIRED lock, by contrast, ends the counting period with it. Without
   * that, a lockout shorter than the window never actually ends: the first
   * attempt after it expires still increments the over-limit count, writes a
   * fresh lock, and is refused before the password is even checked — and every
   * retry renews it. A 30-second lockout inside a 24-hour window was a 24-hour
   * lockout, which is not what the configuration says.
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

    // The counting period restarts when the window has elapsed, and equally
    // when a lockout has run out: the lockout is the penalty, and serving it
    // must clear the record that imposed it.
    const periodEnded = sql`(
        ${adminLoginThrottle.windowStartedAt} <= ${windowCutoff}
        OR (${adminLoginThrottle.lockedUntil} IS NOT NULL
            AND ${adminLoginThrottle.lockedUntil} <= ${now})
      )`;

    const nextCount = sql`CASE WHEN ${periodEnded} THEN 1
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
          windowStartedAt: sql`CASE WHEN ${periodEnded} THEN ${now}
            ELSE ${adminLoginThrottle.windowStartedAt}
          END`,
          // Ordered deliberately: a fresh period that immediately re-reaches
          // the limit (`maxAttempts = 1`) locks again rather than being
          // cleared, and an unexpired lock is carried forward untouched.
          lockedUntil: sql`CASE
            WHEN (${nextCount}) >= ${policy.maxAttempts} THEN ${lockedUntil}
            WHEN ${adminLoginThrottle.lockedUntil} IS NOT NULL
                 AND ${adminLoginThrottle.lockedUntil} <= ${now} THEN NULL
            ELSE ${adminLoginThrottle.lockedUntil}
          END`,
          updatedAt: now,
        },
      })
      .returning({
        failedCount: adminLoginThrottle.failedCount,
        lockedUntil: adminLoginThrottle.lockedUntil,
        windowStartedAt: adminLoginThrottle.windowStartedAt,
      });

    const row = rows[0];
    if (row === undefined) {
      // An upsert with a matching conflict target always returns its row. If it
      // did not, reporting "no failures recorded" would understate the state
      // that protects the account.
      throw new Error('The login throttle upsert returned no row.');
    }
    return {
      failedCount: row.failedCount,
      lockedUntil: row.lockedUntil,
      windowStartedAt: row.windowStartedAt,
    };
  }

  /**
   * Returns one reserved attempt. Never drops below zero, and never touches the
   * window — this undoes a reservation, it does not forgive a failure.
   *
   * It DOES undo a lockout the returned reservation established. The attempt
   * that reaches the limit is still verified and may succeed; leaving its lock
   * standing would refuse every administrator behind that IP for the full
   * lockout period on the strength of a login that worked — and at
   * `LOGIN_MAX_ATTEMPTS_PER_IP=1` the first successful login would poison the
   * address. The lock is lifted only when the decremented count falls back
   * below the limit, so failures accumulated by others still hold it.
   *
   * Applied ONLY to the counting period the reservation was made in. A login
   * can sit in the KDF longer than the whole window — 30 seconds is the
   * configured minimum, and a saturated crypto pool can exceed it — and by the
   * time it releases, a later attempt may have reset the row into a new period.
   * Decrementing then would take away that later attempt instead, and could
   * clear the lock it had just established. A release whose period has passed
   * matches nothing and does nothing, which is the correct outcome: the
   * reservation it was returning no longer exists.
   */
  async releaseAttempt(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    maxAttempts: number,
    reservedWindowStartedAt: Date,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const releasedCount = sql`GREATEST(${adminLoginThrottle.failedCount} - 1, 0)`;
    await executorOf(this.db, tx)
      .update(adminLoginThrottle)
      .set({
        failedCount: releasedCount,
        lockedUntil: sql`CASE
          WHEN (${releasedCount}) < ${maxAttempts} THEN NULL
          ELSE ${adminLoginThrottle.lockedUntil}
        END`,
      })
      .where(
        and(
          eq(adminLoginThrottle.tenantId, tenantId),
          eq(adminLoginThrottle.subjectKind, kind),
          eq(adminLoginThrottle.subject, subject),
          eq(adminLoginThrottle.windowStartedAt, reservedWindowStartedAt),
        ),
      );
  }

  /**
   * Deletes rows nothing is counting any more.
   *
   * A row matters while its window is open or its lockout has not expired.
   * Once both are past, it is a record of an attempt nobody will ever ask
   * about again — and without this, every distinct username an attacker
   * invents leaves one behind for good.
   *
   * Tenant-agnostic on purpose: this is housekeeping over the whole table, run
   * by a background sweep, not a tenant-scoped read. The `LIMIT` keeps one
   * sweep short; the next one continues.
   */
  async purgeExpired(now: Date, olderThanSeconds: number, limit: number): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanSeconds * 1000);
    const deleted = await this.db
      .delete(adminLoginThrottle)
      .where(
        sql`ctid IN (
          SELECT ctid FROM ${adminLoginThrottle}
          WHERE ${adminLoginThrottle.windowStartedAt} <= ${cutoff}
            AND (${adminLoginThrottle.lockedUntil} IS NULL
                 OR ${adminLoginThrottle.lockedUntil} <= ${now})
          LIMIT ${limit}
        )`,
      )
      .returning({ subject: adminLoginThrottle.subject });
    return deleted.length;
  }

  async clear(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
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
