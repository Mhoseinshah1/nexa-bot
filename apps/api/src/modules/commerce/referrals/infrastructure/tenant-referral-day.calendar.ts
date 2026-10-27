import { eq } from 'drizzle-orm';
import type { Calendar, TenantContext, TimePeriod } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { tenants } from '../../../../infrastructure/persistence/schema.js';
import { IntlTimePeriodResolver } from '../../../../infrastructure/time/report-calendar.js';
import type { ReferralDayCalendar } from '../application/ports.js';

/**
 * R10 D5 (b): the referral caps' "day" — `TODAY` in the tenant's display time zone and
 * calendar, from the ONE `TimePeriodResolver` implementation, half-open `[start, end)`.
 *
 * The resolver is asked with the CALLER's instant (`at`), never a second clock reading, so a
 * claim made at 23:59:59.999 local is counted in the day it was decided in. The tenant row is
 * read through the caller's transaction, like the reseller minimum's presentation read.
 */
export class TenantReferralDayCalendar implements ReferralDayCalendar {
  constructor(private readonly db: Database) {}

  async dayOf(scope: TenantContext, at: Date, tx?: unknown): Promise<TimePeriod> {
    const tenantId = requireTenantId(scope);
    const executor: Executor = (tx as TransactionScope | undefined)?.tx ?? this.db;
    const [row] = await executor
      .select({ timezone: tenants.displayTimezone, calendar: tenants.calendar })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (row === undefined) throw new Error(`tenant ${tenantId} not found`);
    return new IntlTimePeriodResolver({ now: () => at }).resolve('TODAY', {
      timezone: row.timezone,
      calendar: row.calendar as Calendar,
    });
  }
}
