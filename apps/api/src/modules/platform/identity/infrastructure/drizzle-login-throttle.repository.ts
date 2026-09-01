import { and, eq } from 'drizzle-orm';
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

  async recordFailure(
    scope: ScopeContext,
    kind: ThrottleSubjectKind,
    subject: string,
    now: Date,
    policy: { windowSeconds: number; maxAttempts: number; lockoutSeconds: number },
  ): Promise<ThrottleState> {
    const tenantId = requireTenantId(scope);

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(adminLoginThrottle)
        .where(
          and(
            eq(adminLoginThrottle.tenantId, tenantId),
            eq(adminLoginThrottle.subjectKind, kind),
            eq(adminLoginThrottle.subject, subject),
          ),
        )
        .for('update')
        .limit(1);

      const windowExpired =
        existing !== undefined &&
        now.getTime() - existing.windowStartedAt.getTime() >= policy.windowSeconds * 1000;

      const failedCount = existing === undefined || windowExpired ? 1 : existing.failedCount + 1;
      const windowStartedAt =
        existing === undefined || windowExpired ? now : existing.windowStartedAt;

      const lockedUntil =
        failedCount >= policy.maxAttempts
          ? new Date(now.getTime() + policy.lockoutSeconds * 1000)
          : null;

      await tx
        .insert(adminLoginThrottle)
        .values({
          tenantId,
          subjectKind: kind,
          subject,
          failedCount,
          windowStartedAt,
          lockedUntil,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            adminLoginThrottle.tenantId,
            adminLoginThrottle.subjectKind,
            adminLoginThrottle.subject,
          ],
          set: { failedCount, windowStartedAt, lockedUntil, updatedAt: now },
        });

      return { failedCount, lockedUntil };
    });
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
