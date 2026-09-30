import {
  addDays,
  civilDateOf,
  formatLocalDate,
  localInstant,
  resolveReportPeriod,
  type ReportPresentation,
} from './report-calendar.js';

const DAY_MS = 86_400_000;

/** A calendar month in the tenant's calendar, as the monthly minimum reads it. */
export interface MonthlyPeriod {
  readonly key: 'THIS_MONTH' | 'PREVIOUS_MONTH';
  /** Half-open `[start, end)`, UTC instants: local midnight of the first day and of the next month's. */
  readonly start: Date;
  readonly end: Date;
  /** `1405/07/01` and `1405/07/30`, Latin digits, the tenant's calendar. */
  readonly startLocal: string;
  readonly endLocalInclusive: string;
  /** True while `now` is inside the month. */
  readonly running: boolean;
}

/**
 * The month boundaries the reseller monthly minimum uses (round N R2,
 * `docs/round-n-reseller-audit.md` §3.3).
 *
 * NOT a second calendar: every boundary comes from `resolveReportPeriod` — the reports' own
 * `THIS_MONTH` / `PREVIOUS_MONTH` in the tenant's `display_timezone` and `calendar` — and
 * every local midnight from `localInstant`, which asks ICU and lands on the right side of a
 * daylight-saving change. The only arithmetic here is on civil dates (`addDays`) and on
 * whole local days between two such midnights.
 */
export class TenantMonthlyPeriods {
  month(
    which: 'THIS_MONTH' | 'PREVIOUS_MONTH',
    now: Date,
    presentation: ReportPresentation,
  ): MonthlyPeriod {
    const resolved = resolveReportPeriod({ range: which }, now, presentation);
    const { start, end, startLocal, endLocalInclusive } = resolved.current;
    return {
      key: which,
      start,
      end,
      startLocal: formatLocalDate(startLocal),
      endLocalInclusive: formatLocalDate(endLocalInclusive),
      running: now.getTime() >= start.getTime() && now.getTime() < end.getTime(),
    };
  }

  /**
   * The local midnight `days` local days before this month ends: from it, `days` days are
   * left, today included. Three days before a month whose last day is the 30th is midnight
   * at the start of the 28th — the 28th, 29th and 30th remain.
   */
  reminderStart(now: Date, days: number, presentation: ReportPresentation): Date {
    const resolved = resolveReportPeriod({ range: 'THIS_MONTH' }, now, presentation);
    const first = addDays(resolved.current.endLocalInclusive, 1 - days, presentation.calendar);
    return localInstant(first, 0, presentation);
  }

  /**
   * How many local days of the month containing `periodEnd − 1` remain at `now`, today
   * included: 1 on the last day, 0 once it has ended. Whole days between two local
   * midnights, rounded, so a 23- or 25-hour day still counts as one.
   */
  daysLeft(now: Date, periodEnd: Date, presentation: ReportPresentation): number {
    if (now.getTime() >= periodEnd.getTime()) return 0;
    const today = localInstant(civilDateOf(now, presentation), 0, presentation);
    return Math.max(0, Math.round((periodEnd.getTime() - today.getTime()) / DAY_MS));
  }
}
