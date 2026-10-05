import {
  CONTROL_ERROR_CODES,
  errors,
  type ActorContext,
  type ScopeContext,
  type SupportAnalyticsQuery,
  type SupportAnalyticsResponse,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  assembleSupportAnalytics,
  type SupportAnalyticsFacts,
  type SupportAnalyticsWindow,
} from '../domain/support-analytics.js';
import { SUPPORT_AI_CONFIGURE_PERMISSION } from './support-ai-config.service.js';

export interface SupportAnalyticsDeps {
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly reader: {
    read(scope: ScopeContext, window: SupportAnalyticsWindow): Promise<SupportAnalyticsFacts>;
  };
  /** The reports' own resolver, in the tenant's timezone and calendar: `[start, end)`. */
  readonly windows: {
    resolve(scope: ScopeContext, query: SupportAnalyticsQuery): Promise<SupportAnalyticsWindow>;
  };
}

/**
 * The longest CUSTOM window the support analytics read, in local days: a leap year, the span
 * of the longest preset (`THIS_YEAR`). PR #205 review, N5: the provider-run statement computes
 * `percentile_cont` p50 and p95 per provider and outcome, which SORTS every run in the window;
 * the reports' own CUSTOM bound (731 days) would let one request sort two years of a busy
 * tenant's calls. Capping CUSTOM at the longest preset bounds that sort by what a preset can
 * already ask for; the per-statement `statement_timeout` bounds the rest.
 */
export const SUPPORT_ANALYTICS_CUSTOM_MAX_DAYS = 366;
/** One local day of DST slack: a window of N local days may be N × 24 h ± 1 h long. */
const MAX_CUSTOM_SPAN_MS = SUPPORT_ANALYTICS_CUSTOM_MAX_DAYS * 86_400_000 + 3_600_000;

/**
 * TB10 — support analytics (program §40, §46). Read-only: it writes nothing, audits nothing
 * and records no event, so it needs no idempotency key and no scope-activity check (a
 * stopped tenant's history is still its history).
 *
 * Charged `support_ai.configure`: usage and cost are folded into that key (`tb0-audit.md`
 * §7), and the figures here are the AI's usage beside what it led to. The check is made
 * before anything is read, so a refusal reads nothing.
 */
export class SupportAnalyticsService {
  constructor(private readonly deps: SupportAnalyticsDeps) {}

  async analytics(
    scope: ScopeContext,
    actor: ActorContext,
    query: SupportAnalyticsQuery,
  ): Promise<SupportAnalyticsResponse> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    const window = await this.deps.windows.resolve(scope, query);
    if (
      query.range === 'CUSTOM' &&
      window.end.getTime() - window.start.getTime() > MAX_CUSTOM_SPAN_MS
    ) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        `A custom range for the support analytics is at most ${SUPPORT_ANALYTICS_CUSTOM_MAX_DAYS} days.`,
        { from: query.from ?? null, to: query.to ?? null },
      );
    }
    const facts = await this.deps.reader.read(scope, window);
    return assembleSupportAnalytics(query.range, window, facts);
  }
}
