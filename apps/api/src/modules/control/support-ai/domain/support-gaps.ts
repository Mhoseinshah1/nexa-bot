import {
  SUPPORT_INSIGHTS_QUESTION_CHARS,
  SUPPORT_KNOWLEDGE_GAPS_MAX,
  SUPPORT_KNOWLEDGE_GAP_EXAMPLES,
  type BusinessHandoffReason,
  type SupportAiTopic,
  type SupportKnowledgeGapsResponse,
} from '@nexa/contracts';

/**
 * Phase 4 PR-5 — the knowledge-gaps report, pure. A gap is a question the AI could not answer
 * from approved content: the job ended on grounding, confidence or "no reply" - or the model
 * itself asked for a person on a topic that is safe to answer. Gaps are clustered by what the
 * model said was asked (its operator-only `intent`, normalised) within a topic, biggest first.
 * No embeddings, no guessing: two questions are one gap only when their labels agree.
 */
export interface GapRow {
  readonly topic: SupportAiTopic | null;
  readonly intent: string | null;
  readonly reason: BusinessHandoffReason;
  /** The customer's question; null once retention purged it. */
  readonly question: string | null;
}

/** The reasons that mean "approved content did not cover it". */
export const KNOWLEDGE_GAP_REASONS: readonly BusinessHandoffReason[] = [
  'INSUFFICIENT_GROUNDING',
  'LOW_CONFIDENCE',
  'DECISION_NOT_REPLY',
  'AI_REQUESTED',
];

export function normalizeIntent(intent: string | null): string {
  if (intent === null) return '';
  return intent
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}‌‏‎]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function clusterKnowledgeGaps(rows: readonly GapRow[]): SupportKnowledgeGapsResponse {
  const clusters = new Map<
    string,
    {
      topic: SupportAiTopic | null;
      intent: string | null;
      count: number;
      reasons: Map<BusinessHandoffReason, number>;
      examples: string[];
    }
  >();
  for (const row of rows) {
    const key = `${row.topic ?? ''}|${normalizeIntent(row.intent)}`;
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = {
        topic: row.topic,
        intent: row.intent,
        count: 0,
        reasons: new Map(),
        examples: [],
      };
      clusters.set(key, cluster);
    }
    cluster.count += 1;
    cluster.reasons.set(row.reason, (cluster.reasons.get(row.reason) ?? 0) + 1);
    const example = row.question?.trim().slice(0, SUPPORT_INSIGHTS_QUESTION_CHARS) ?? '';
    if (
      example !== '' &&
      cluster.examples.length < SUPPORT_KNOWLEDGE_GAP_EXAMPLES &&
      !cluster.examples.includes(example)
    ) {
      cluster.examples.push(example);
    }
  }
  const gaps = [...clusters.values()]
    .sort((a, b) => b.count - a.count || (a.intent ?? '').localeCompare(b.intent ?? ''))
    .slice(0, SUPPORT_KNOWLEDGE_GAPS_MAX)
    .map((cluster) => ({
      topic: cluster.topic,
      intent: cluster.intent,
      count: cluster.count,
      reasons: [...cluster.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason),
      examples: cluster.examples,
    }));
  return { gaps };
}
