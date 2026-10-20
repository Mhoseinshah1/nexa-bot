import { eq, sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customerNotificationRateWindows,
  customerReminderRaiseCounters,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ReminderRaiseCounter,
  ReminderRateWindow,
  ReminderRateWindowStore,
} from '../application/reminder-rate.js';

/**
 * Round 4 PR-H: the reminder ceiling's one row per tenant, read under `FOR UPDATE` and
 * written back in the claim's own transaction. A second replica blocks on the lock and then
 * reads what the first one wrote, so the two share one ceiling rather than one each.
 */
export class DrizzleReminderRateWindowStore implements ReminderRateWindowStore {
  /**
   * Ensures the row, then locks it. The insert comes FIRST so the very first pass of an
   * installation has a row to lock too: a second replica's `ON CONFLICT DO NOTHING` waits on
   * the first one's uncommitted insert, and then its `FOR UPDATE` reads what the first one
   * committed — never two empty windows counted side by side.
   */
  async lock(scope: TenantContext, now: Date, tx: TransactionScope): Promise<ReminderRateWindow> {
    const tenantId = requireTenantId(scope);
    await tx.tx
      .insert(customerNotificationRateWindows)
      .values({
        tenantId,
        minuteStartedAt: now,
        minuteClaimed: 0,
        hourStartedAt: now,
        hourFresh: 0,
        burstOpen: false,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const [row] = await tx.tx
      .select()
      .from(customerNotificationRateWindows)
      .where(eq(customerNotificationRateWindows.tenantId, tenantId))
      .for('update');
    if (row === undefined) {
      throw new Error('the reminder rate window row vanished inside its own transaction');
    }
    return {
      minuteStartedAt: row.minuteStartedAt,
      minuteClaimed: row.minuteClaimed,
      hourStartedAt: row.hourStartedAt,
      hourFresh: row.hourFresh,
      burstOpen: row.burstOpen,
      raisedSeen: row.raisedSeen,
    };
  }

  async save(
    scope: TenantContext,
    window: ReminderRateWindow,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx
      .update(customerNotificationRateWindows)
      .set({
        minuteStartedAt: window.minuteStartedAt,
        minuteClaimed: window.minuteClaimed,
        hourStartedAt: window.hourStartedAt,
        hourFresh: window.hourFresh,
        burstOpen: window.burstOpen,
        raisedSeen: window.raisedSeen,
        updatedAt: now,
      })
      .where(eq(customerNotificationRateWindows.tenantId, tenantId));
  }
}

/**
 * Codex review of PR #296: the producers' raise counter. `add` is an upsert in the
 * producer's transaction (two sweeps are serialised by the row); `total` is a plain read
 * with no lock, so the dispatcher never waits on a sweep — see the table for why that
 * matters.
 */
export class DrizzleReminderRaiseCounter implements ReminderRaiseCounter {
  async add(scope: TenantContext, count: number, now: Date, tx: TransactionScope): Promise<void> {
    if (count <= 0) return;
    const tenantId = requireTenantId(scope);
    await tx.tx
      .insert(customerReminderRaiseCounters)
      .values({ tenantId, raisedTotal: BigInt(count), updatedAt: now })
      .onConflictDoUpdate({
        target: customerReminderRaiseCounters.tenantId,
        set: {
          raisedTotal: sql`${customerReminderRaiseCounters.raisedTotal} + ${BigInt(count)}`,
          updatedAt: now,
        },
      });
  }

  async total(scope: TenantContext, tx: TransactionScope): Promise<bigint> {
    const tenantId = requireTenantId(scope);
    const [row] = await tx.tx
      .select({ total: customerReminderRaiseCounters.raisedTotal })
      .from(customerReminderRaiseCounters)
      .where(eq(customerReminderRaiseCounters.tenantId, tenantId));
    return row?.total ?? 0n;
  }
}
