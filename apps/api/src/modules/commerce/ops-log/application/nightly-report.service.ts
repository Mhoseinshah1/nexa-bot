import {
  type Clock,
  type CurrencyCode,
  type FeatureFlagKey,
  type OpsLogTypeId,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type TimePeriod,
  type TimePeriodResolver,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import { nightlyReports } from './nightly-report.js';
import { publish } from './publish.js';
import type { NightlyReportReader, OpsLogLane, OpsLogWords } from './ports.js';

/** The zone and calendar the report day is cut in (the owner's: Tehran, Jalali). */
export const NIGHTLY_REPORT_PRESENTATION = { timezone: 'Asia/Tehran', calendar: 'jalali' } as const;

/**
 * How long after its time a report is still posted. A worker that was down at the report time
 * posts the report when it returns, up to this long afterwards; a report older than that is
 * never posted late — a report arriving half a day after its time reads as a different day's.
 */
export const NIGHTLY_REPORT_CATCH_UP_MS = 12 * 60 * 60_000;

const REPORT_TYPES: readonly OpsLogTypeId[] = [
  'REPORT_SUMMARY',
  'REPORT_FINANCIAL',
  'REPORT_PANELS',
];

export interface NightlyReportServiceDeps {
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly reader: NightlyReportReader;
  readonly lane: OpsLogLane;
  readonly words: OpsLogWords;
  readonly settings: { valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T> };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly periods: TimePeriodResolver;
  readonly clock: Clock;
}

/**
 * The nightly reports (Round 4 PR-D, L27-L29), posted to the REPORTS topic at the configured
 * Tehran time (`ops.log.nightly_report_time`, default 00:05).
 *
 * A report is always of a COMPLETED day (Codex review of #301): at the configured time on a
 * Tehran day, it reports the PREVIOUS Tehran day `[00:00, next 00:00)` — the one
 * `TimePeriodResolver` calls YESTERDAY; this class cuts no date range of its own. Posting the
 * running day at 23:59 left its last minute out, and every sale settled in it was reported by
 * no report at all. Every figure is read from the ledger and the orders by
 * `NightlyReportReader`. It is idempotent by construction: each report's
 * notification carries a dedupe key made of its type and the day's start instant, so two
 * replicas, a retried tick and a restarted worker post it once; and once every enabled type
 * of a day has been queued, a tick for that day does one indexed lookup and nothing more.
 *
 * The cleanup line (L30) is part of the summary, never a message of its own.
 */
export class NightlyReportService {
  constructor(private readonly deps: NightlyReportServiceDeps) {}

  /** One pass: queues every report that is due and not yet queued. Returns how many. */
  async runOnce(scope: TenantContext): Promise<number> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
      if (!(await this.deps.features.isEnabled(scope, 'ops_notifications', tx))) return 0;

      const disabled = await this.deps.settings.valueOf<readonly string[]>(
        scope,
        'ops.log.disabled_types' as SettingKey,
        tx,
      );
      const enabled = REPORT_TYPES.filter((id) => !disabled.includes(id));
      if (enabled.length === 0) return 0;

      const time = await this.deps.settings.valueOf<string>(
        scope,
        'ops.log.nightly_report_time' as SettingKey,
        tx,
      );
      const minutes = minutesOfDay(time);
      const currency = await this.deps.settings.valueOf<CurrencyCode>(
        scope,
        'sales.currency' as SettingKey,
        tx,
      );

      /*
       * The report of day D is due at the configured time on the day AFTER D: D's end plus the
       * minutes. Two days can be due: yesterday (due today) and the day before it (due
       * yesterday, still inside the catch-up bound just after midnight for a late time such
       * as 23:59). Tehran observes no summer time, so a day is 24 hours and the day before
       * yesterday is yesterday shifted by its own length.
       */
      const yesterday = this.deps.periods.resolve('YESTERDAY', NIGHTLY_REPORT_PRESENTATION);
      const length = yesterday.end.getTime() - yesterday.start.getTime();
      const dayBefore: TimePeriod = {
        ...yesterday,
        start: new Date(yesterday.start.getTime() - length),
        end: yesterday.start,
      };
      let queued = 0;
      for (const day of [dayBefore, yesterday]) {
        const dueAt = day.end.getTime() + minutes * 60_000;
        // Due once its time has come, and only for a while after: see the catch-up bound.
        if (now.getTime() < dueAt || now.getTime() - dueAt > NIGHTLY_REPORT_CATCH_UP_MS) continue;
        queued += await this.post(scope, day, enabled, currency, tx);
      }
      return queued;
    });
  }

  private async post(
    scope: TenantContext,
    day: TimePeriod,
    enabled: readonly OpsLogTypeId[],
    currency: CurrencyCode,
    tx: TransactionScope,
  ): Promise<number> {
    const keyOf = (id: OpsLogTypeId): string => `report:${id}:${day.start.toISOString()}`;
    let pending = 0;
    for (const id of enabled) {
      if (!(await this.deps.reader.alreadyPosted(scope, keyOf(id), tx))) pending += 1;
    }
    if (pending === 0) return 0;

    // The previous day is the same length immediately before it: Tehran observes no summer
    // time, so a day is twenty-four hours and this is exact.
    const length = day.end.getTime() - day.start.getTime();
    const data = await this.deps.reader.read(
      scope,
      {
        start: day.start,
        end: day.end,
        previousStart: new Date(day.start.getTime() - length),
        previousEnd: day.start,
        currency,
        timezone: NIGHTLY_REPORT_PRESENTATION.timezone,
      },
      tx,
    );
    let queued = 0;
    for (const built of nightlyReports({ ...data, day: day.start }, this.deps.words)) {
      if (!enabled.includes(built.logType)) continue;
      if (await this.deps.reader.alreadyPosted(scope, keyOf(built.logType), tx)) continue;
      await publish(this.deps.lane, scope, tx, built, { dedupeKey: keyOf(built.logType) });
      queued += 1;
    }
    return queued;
  }
}

/** `00:05` as minutes into the day; anything unreadable is the default time (00:05). */
export function minutesOfDay(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (match === null) return 5;
  return Number(match[1]) * 60 + Number(match[2]);
}
