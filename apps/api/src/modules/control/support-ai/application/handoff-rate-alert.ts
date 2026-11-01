import {
  SUPPORT_AI_HANDOFF_RATE_ALERT_HOURS,
  SUPPORT_AI_HANDOFF_RATE_HIGH_CODE,
  SUPPORT_AI_HANDOFF_RATE_WINDOW,
  businessHandoffKindOf,
  BUSINESS_HANDOFF_REASONS,
  type BusinessHandoffReason,
  type Clock,
  type OperationalEventRecorder,
  type ScopeContext,
  type SettingKey,
} from '@nexa/contracts';

export const SUPPORT_AI_HANDOFF_ALERT_PCT_KEY = 'support.ai.handoff_alert_pct' satisfies SettingKey;

/** One finished automatic job, as the alert reads it: its outcome and handoff reason only. */
export interface AutoResultRow {
  readonly outcome: string | null;
  readonly handoffReason: string | null;
  readonly topic: string | null;
}

/**
 * Phase 4 PR-1 item 9 — whether SOFT handoffs exceed `pct` percent of the last
 * `SUPPORT_AI_HANDOFF_RATE_WINDOW` automatic jobs. Pure. Fewer jobs than the window is too small
 * a sample and never alerts; `pct` 0 is the alert switched off. Hard handoffs (a refund, a
 * person requested) are the policy working and never count.
 */
export function handoffRateVerdict(
  rows: readonly AutoResultRow[],
  pct: number,
): {
  readonly alert: boolean;
  readonly soft: number;
  readonly jobs: number;
  readonly top: readonly { readonly reason: string; readonly count: number }[];
} {
  const window = rows.slice(0, SUPPORT_AI_HANDOFF_RATE_WINDOW);
  const counts = new Map<string, number>();
  let soft = 0;
  for (const row of window) {
    const reason = row.handoffReason;
    if (reason === null || !isHandoffReason(reason)) continue;
    if (businessHandoffKindOf(reason, row.topic) !== 'SOFT') continue;
    soft += 1;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const top = [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 3);
  const alert =
    pct > 0 && window.length >= SUPPORT_AI_HANDOFF_RATE_WINDOW && soft * 100 > pct * window.length;
  return { alert, soft, jobs: window.length, top };
}

/**
 * Phase 4 PR-1 item 9 — «نرخ ارجاع به پشتیبان بالا است»: run by the assistant loop now and then.
 * Rolled up: one row per `SUPPORT_AI_HANDOFF_RATE_ALERT_HOURS` window (its dedupe key names the
 * window), with the top three reasons in Persian in its `reason`. It only REPORTS: nothing is
 * changed, nobody is messaged but the operations log.
 */
export class SupportHandoffRateAlert {
  constructor(
    private readonly deps: {
      readonly jobs: {
        recentAutoResults(scope: ScopeContext, limit: number): Promise<readonly AutoResultRow[]>;
      };
      readonly settings: {
        valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
      };
      readonly opsLog: OperationalEventRecorder;
      readonly clock: Clock;
      /** The Persian label of a handoff reason. */
      readonly reasonLabel: (reason: string) => string;
    },
  ) {}

  async check(scope: ScopeContext): Promise<boolean> {
    const pct = await this.deps.settings.valueOf<number>(scope, SUPPORT_AI_HANDOFF_ALERT_PCT_KEY);
    if (!Number.isInteger(pct) || pct <= 0) return false;
    const rows = await this.deps.jobs.recentAutoResults(scope, SUPPORT_AI_HANDOFF_RATE_WINDOW);
    const verdict = handoffRateVerdict(rows, pct);
    if (!verdict.alert) return false;
    const bucketMs = SUPPORT_AI_HANDOFF_RATE_ALERT_HOURS * 3_600_000;
    const bucket = Math.floor(this.deps.clock.now().getTime() / bucketMs);
    await this.deps.opsLog.record(scope, {
      code: SUPPORT_AI_HANDOFF_RATE_HIGH_CODE,
      severity: 'WARN',
      message:
        'Soft handoffs exceed the configured share of recent automatic support-AI jobs; see the top reasons.',
      dedupeKey: `${SUPPORT_AI_HANDOFF_RATE_HIGH_CODE}:${String(bucket)}`,
      context: {
        reason: verdict.top
          .map((row) => `${this.deps.reasonLabel(row.reason)} (${String(row.count)})`)
          .join('، '),
        soft: verdict.soft,
        jobs: verdict.jobs,
        thresholdPct: pct,
      },
    });
    return true;
  }
}

function isHandoffReason(value: string): value is BusinessHandoffReason {
  return (BUSINESS_HANDOFF_REASONS as readonly string[]).includes(value);
}
