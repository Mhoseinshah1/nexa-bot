import type {
  ActorContext,
  ScopeContext,
  SupportAnalyticsQuery,
  SupportAnalyticsResponse,
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
    const facts = await this.deps.reader.read(scope, window);
    return assembleSupportAnalytics(query.range, window, facts);
  }
}
