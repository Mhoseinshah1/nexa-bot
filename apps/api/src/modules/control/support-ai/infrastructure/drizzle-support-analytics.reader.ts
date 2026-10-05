import { sql } from 'drizzle-orm';
import type {
  BusinessConversationState,
  BusinessHandoffReason,
  ScopeContext,
  SupportAiAutoOutcome,
  SupportAiJobKind,
  SupportAiJobState,
  SupportAiOutcomeKind,
  SupportAiProvider,
  SupportKnowledgeArticleState,
  SupportKnowledgeSource,
  SupportLearningCandidateState,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SupportAnalyticsFacts, SupportAnalyticsWindow } from '../domain/support-analytics.js';

/**
 * TB10 — the support analytics, read (program §46–§47). Six grouped statements, each
 * TENANT-LEADING and each served by a `(tenant_id, …)` index: the two snapshots by the
 * table's tenant index, the four windowed counts by a `(tenant_id, created_at)` range,
 * half-open — `created_at >= start AND created_at < end`.
 *
 * Counts and token sums only. No statement here selects a text column — not a message, a
 * prompt, a draft, a summary or a title — so nothing a customer wrote can leave through
 * this read.
 *
 * Every statement goes through `db.execute`, so the plan test captures exactly what is sent.
 */
export class DrizzleSupportAnalyticsReader {
  constructor(private readonly db: Pick<Database, 'execute'>) {}

  async read(scope: ScopeContext, window: SupportAnalyticsWindow): Promise<SupportAnalyticsFacts> {
    const tenantId = requireTenantId(scope);
    const start = window.start.toISOString();
    const end = window.end.toISOString();
    const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
      (await this.db.execute(query)).rows as unknown as T[];

    const conversations = await rows<{ state: string; n: number }>(sql`
      SELECT state, count(*)::int AS n
        FROM business_conversations
       WHERE tenant_id = ${tenantId}::uuid
       GROUP BY state`);
    const handoffs = await rows<{ reason: string; n: number }>(sql`
      SELECT reason, count(*)::int AS n
        FROM business_conversation_escalations
       WHERE tenant_id = ${tenantId}::uuid
         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
       GROUP BY reason`);
    const jobs = await rows<{ kind: string; state: string; outcome: string | null; n: number }>(sql`
      SELECT kind, state, outcome, count(*)::int AS n
        FROM support_ai_jobs
       WHERE tenant_id = ${tenantId}::uuid
         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
       GROUP BY kind, state, outcome`);
    const runs = await rows<{
      provider: string;
      outcome: string;
      n: number;
      p50: number | string | null;
      p95: number | string | null;
      input_tokens: number | string;
      output_tokens: number | string;
    }>(sql`
      SELECT provider, outcome, count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
             COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(sum(output_tokens), 0)::bigint AS output_tokens
        FROM support_ai_runs
       WHERE tenant_id = ${tenantId}::uuid
         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
       GROUP BY provider, outcome`);
    const candidates = await rows<{ state: string; n: number }>(sql`
      SELECT state, count(*)::int AS n
        FROM support_learning_candidates
       WHERE tenant_id = ${tenantId}::uuid
         AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
       GROUP BY state`);
    const articles = await rows<{ source: string; state: string; enabled: boolean; n: number }>(sql`
      SELECT source, state, enabled, count(*)::int AS n
        FROM support_knowledge_articles
       WHERE tenant_id = ${tenantId}::uuid
       GROUP BY source, state, enabled`);

    return {
      conversations: conversations.map((row) => ({
        state: row.state as BusinessConversationState,
        count: Number(row.n),
      })),
      handoffs: handoffs.map((row) => ({
        reason: row.reason as BusinessHandoffReason,
        count: Number(row.n),
      })),
      jobs: jobs.map((row) => ({
        kind: row.kind as SupportAiJobKind,
        state: row.state as SupportAiJobState,
        outcome: row.outcome as SupportAiAutoOutcome | null,
        count: Number(row.n),
      })),
      runs: runs.map((row) => ({
        provider: row.provider as SupportAiProvider,
        outcome: row.outcome as SupportAiOutcomeKind,
        runs: Number(row.n),
        p50LatencyMs: Math.round(Number(row.p50 ?? 0)),
        p95LatencyMs: Math.round(Number(row.p95 ?? 0)),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      })),
      candidates: candidates.map((row) => ({
        state: row.state as SupportLearningCandidateState,
        count: Number(row.n),
      })),
      articles: articles.map((row) => ({
        source: row.source as SupportKnowledgeSource,
        state: row.state as SupportKnowledgeArticleState,
        enabled: row.enabled,
        count: Number(row.n),
      })),
    };
  }
}
