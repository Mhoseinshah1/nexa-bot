import {
  SUPPORT_INSIGHTS_WINDOW_DAYS,
  supportHandoffQuestionsQuerySchema,
  type ActorContext,
  type Clock,
  type ScopeContext,
  type SupportAiConfigResponse,
  type SupportAiMode,
  type SupportHandoffQuestionsResponse,
  type SupportKnowledgeGapsResponse,
  type SupportReadinessResponse,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { BusinessConnectionService } from '../../../commerce/business-chats/application/business-connection.service.js';
import { clusterKnowledgeGaps } from '../domain/support-gaps.js';
import { supportReadiness } from '../domain/support-readiness.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type { DrizzleSupportInsightsReader } from '../infrastructure/drizzle-support-insights.reader.js';
import { SUPPORT_AI_CONFIGURE_PERMISSION } from './support-ai-config.service.js';
import { SUPPORT_ASSISTANT_STALLED_DEDUPE_KEY } from './assistant-watch.js';

export interface SupportInsightsDeps {
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly reader: Pick<
    DrizzleSupportInsightsReader,
    'readiness' | 'handoffQuestions' | 'knowledgeGapRows'
  >;
  /** The configuration page's own read (it charges `support_ai.configure` itself). */
  readonly config: {
    view(scope: ScopeContext, actor: ActorContext): Promise<SupportAiConfigResponse>;
  };
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly connections: Pick<BusinessConnectionService, 'list'>;
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: 'support.accounts'): Promise<T>;
  };
  readonly conditions: {
    conditionIsOpen(scope: ScopeContext, dedupeKey: string): Promise<boolean>;
  };
  readonly clock: Clock;
}

/**
 * Phase 4 PR-5 — what the support page needs to tell the owner "ready or not" and "what are
 * customers asking that we cannot answer". Read-only: writes nothing, audits nothing, needs no
 * idempotency key, and is charged `support_ai.configure` like the analytics beside it. The
 * check is made before anything is read.
 */
export class SupportInsightsService {
  constructor(private readonly deps: SupportInsightsDeps) {}

  /**
   * The mode as stored, for the inbox to say what the AI really does. No permission of its
   * own: the mode is not a secret, and the caller already holds `business_chats.view`.
   */
  async aiMode(scope: ScopeContext): Promise<SupportAiMode> {
    return (await this.deps.configs.get(scope)).config.mode;
  }

  async readiness(scope: ScopeContext, actor: ActorContext): Promise<SupportReadinessResponse> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    const [view, facts, connections, handles, stalled] = await Promise.all([
      this.deps.config.view(scope, actor),
      this.deps.reader.readiness(scope),
      this.deps.connections.list(scope),
      this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts'),
      this.deps.conditions.conditionIsOpen(scope, SUPPORT_ASSISTANT_STALLED_DEDUPE_KEY),
    ]);
    return supportReadiness({
      config: view.config,
      credentials: view.credentials,
      capabilities: view.capabilities,
      connections,
      supportHandles: handles,
      connectedUsernames: facts.connectedUsernames,
      assistant: facts.assistant,
      assistantStalled: stalled,
      approvedKnowledge: facts.approvedKnowledge,
    });
  }

  async handoffQuestions(
    scope: ScopeContext,
    actor: ActorContext,
    query: unknown,
  ): Promise<SupportHandoffQuestionsResponse> {
    const { reason } = supportHandoffQuestionsQuerySchema.parse(query);
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    // The customer's own words: the inbox permission that already shows them.
    await this.deps.guard.check(scope, actor, 'business_chats.view');
    const { start, end } = this.window();
    const items = await this.deps.reader.handoffQuestions(scope, { reason, start, end });
    return {
      reason,
      items: items.map((item) => ({
        conversationId: item.conversationId,
        createdAt: item.createdAt.toISOString(),
        topic: item.topic,
        kind: item.kind,
        question: item.question,
      })),
    };
  }

  async knowledgeGaps(
    scope: ScopeContext,
    actor: ActorContext,
  ): Promise<SupportKnowledgeGapsResponse> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION);
    await this.deps.guard.check(scope, actor, 'business_chats.view');
    const rows = await this.deps.reader.knowledgeGapRows(scope, this.window());
    return clusterKnowledgeGaps(rows);
  }

  /** The last `SUPPORT_INSIGHTS_WINDOW_DAYS` days, half-open; `end` is one second past now. */
  private window(): { start: Date; end: Date } {
    const now = this.deps.clock.now();
    return {
      start: new Date(now.getTime() - SUPPORT_INSIGHTS_WINDOW_DAYS * 86_400_000),
      end: new Date(now.getTime() + 1_000),
    };
  }
}
