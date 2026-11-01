import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_SAFE_TOPICS,
  SUPPORT_AI_TOPICS,
  SUPPORT_INSIGHTS_QUESTION_CHARS,
  SUPPORT_INSIGHTS_QUESTION_LIMIT,
  BUSINESS_HANDOFF_KINDS,
  type BusinessHandoffKind,
  type BusinessHandoffReason,
  type ScopeContext,
  type SupportAiTopic,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { KNOWLEDGE_GAP_REASONS, type GapRow } from '../domain/support-gaps.js';

const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
/** Escalations read for the gaps report, newest first. */
const GAP_ROWS_MAX = 500;

const topicOf = (raw: string | null): SupportAiTopic | null =>
  raw !== null && (SUPPORT_AI_TOPICS as readonly string[]).includes(raw)
    ? (raw as SupportAiTopic)
    : null;
const kindOf = (raw: string | null): BusinessHandoffKind | null =>
  raw !== null && (BUSINESS_HANDOFF_KINDS as readonly string[]).includes(raw)
    ? (raw as BusinessHandoffKind)
    : null;

/**
 * Phase 4 PR-5 — READ-ONLY facts for the support pages: the assistant role's latest life, the
 * approved knowledge count, the connected accounts' usernames, and the text behind handoffs.
 * Every statement is tenant-leading and runs in one read-only snapshot; nothing is written.
 *
 * The two text reads (`handoffQuestions`, `knowledgeGapRows`) select the customer's last text
 * message before each handoff, truncated, and nothing else of it: not a name, a phone, an id.
 * That is why they are not part of the analytics reader, whose rule is that no statement
 * selects a text column.
 */
export class DrizzleSupportInsightsReader {
  constructor(private readonly db: Pick<Database, 'transaction'>) {}

  async readiness(scope: ScopeContext): Promise<{
    readonly assistant: {
      readonly startedAt: Date;
      readonly stableAt: Date | null;
      readonly stoppedAt: Date | null;
      readonly restarts: number;
    } | null;
    readonly approvedKnowledge: number;
    readonly connectedUsernames: readonly string[];
  }> {
    const tenantId = requireTenantId(scope);
    return this.db.transaction(async (q) => {
      const role = (
        await q.execute(sql`
          SELECT started_at, stable_at, stopped_at, restarts
            FROM process_runs WHERE role = 'assistant'`)
      ).rows as unknown as {
        started_at: string | Date;
        stable_at: string | Date | null;
        stopped_at: string | Date | null;
        restarts: number;
      }[];
      const knowledge = (
        await q.execute(sql`
          SELECT count(*)::int AS n FROM support_knowledge_articles
           WHERE tenant_id = ${tenantId}::uuid AND state = 'APPROVED' AND enabled`)
      ).rows as unknown as { n: number }[];
      const usernames = (
        await q.execute(sql`
          SELECT DISTINCT c.username
            FROM telegram_business_connections b
            JOIN customers c ON c.tenant_id = b.tenant_id
                            AND c.telegram_user_id = b.owner_telegram_user_id
           WHERE b.tenant_id = ${tenantId}::uuid
             AND b.superseded_at IS NULL AND b.is_enabled
             AND c.username IS NOT NULL`)
      ).rows as unknown as { username: string }[];
      const first = role[0];
      return {
        assistant:
          first === undefined
            ? null
            : {
                startedAt: new Date(first.started_at),
                stableAt: first.stable_at === null ? null : new Date(first.stable_at),
                stoppedAt: first.stopped_at === null ? null : new Date(first.stopped_at),
                restarts: first.restarts,
              },
        approvedKnowledge: knowledge[0]?.n ?? 0,
        connectedUsernames: usernames.map((row) => row.username),
      };
    }, SNAPSHOT);
  }

  /** The newest handoffs of one reason in `[start, end)`, each with the customer's last line. */
  async handoffQuestions(
    scope: ScopeContext,
    input: { reason: BusinessHandoffReason; start: Date; end: Date },
  ): Promise<
    readonly {
      conversationId: string;
      createdAt: Date;
      topic: SupportAiTopic | null;
      kind: BusinessHandoffKind | null;
      question: string | null;
    }[]
  > {
    const tenantId = requireTenantId(scope);
    const rows = await this.db.transaction(
      async (q) =>
        (
          await q.execute(sql`
            SELECT e.conversation_id, e.created_at, e.topic, e.handoff_kind, ${questionBefore()} AS question
              FROM business_conversation_escalations e
             WHERE e.tenant_id = ${tenantId}::uuid
               AND e.reason = ${input.reason}
               AND e.created_at >= ${input.start.toISOString()}::timestamptz
               AND e.created_at < ${input.end.toISOString()}::timestamptz
             ORDER BY e.created_at DESC
             LIMIT ${SUPPORT_INSIGHTS_QUESTION_LIMIT}`)
        ).rows as unknown as {
          conversation_id: string;
          created_at: string | Date;
          topic: string | null;
          handoff_kind: string | null;
          question: string | null;
        }[],
      SNAPSHOT,
    );
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at),
      topic: topicOf(row.topic),
      kind: kindOf(row.handoff_kind),
      question: row.question,
    }));
  }

  /** Handoffs that mean "approved content did not cover it", newest first, with their question. */
  async knowledgeGapRows(
    scope: ScopeContext,
    input: { start: Date; end: Date },
  ): Promise<readonly GapRow[]> {
    const tenantId = requireTenantId(scope);
    const reasons = sql.join(
      KNOWLEDGE_GAP_REASONS.map((reason) => sql`${reason}`),
      sql`, `,
    );
    const rows = await this.db.transaction(
      async (q) =>
        (
          await q.execute(sql`
            SELECT e.reason, e.topic, e.intent, ${questionBefore()} AS question
              FROM business_conversation_escalations e
             WHERE e.tenant_id = ${tenantId}::uuid
               AND e.reason IN (${reasons})
               AND e.created_at >= ${input.start.toISOString()}::timestamptz
               AND e.created_at < ${input.end.toISOString()}::timestamptz
             ORDER BY e.created_at DESC
             LIMIT ${GAP_ROWS_MAX}`)
        ).rows as unknown as {
          reason: BusinessHandoffReason;
          topic: string | null;
          intent: string | null;
          question: string | null;
        }[],
      SNAPSHOT,
    );
    return rows
      .map((row) => ({
        topic: topicOf(row.topic),
        intent: row.intent,
        reason: row.reason,
        question: row.question,
      }))
      .filter(
        // The model asking for a person is a gap only on a topic it may answer; a refund or a
        // wallet question is a person's by design, not a hole in the knowledge.
        (row) =>
          row.reason !== 'AI_REQUESTED' ||
          (row.topic !== null && (SUPPORT_AI_SAFE_TOPICS as readonly string[]).includes(row.topic)),
      );
  }
}

/** The customer's latest text message at or before the escalation, truncated. */
function questionBefore() {
  return sql`(
    SELECT left(m.text, ${SUPPORT_INSIGHTS_QUESTION_CHARS})
      FROM business_messages m
     WHERE m.tenant_id = e.tenant_id AND m.conversation_id = e.conversation_id
       AND m.origin = 'INBOUND' AND m.kind = 'TEXT'
       AND m.deleted_at IS NULL AND m.text IS NOT NULL
       AND m.sent_at <= e.created_at
     ORDER BY m.sent_at DESC, m.telegram_message_id DESC
     LIMIT 1)`;
}
