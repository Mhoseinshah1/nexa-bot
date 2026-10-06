import {
  BUSINESS_CONVERSATION_STATES,
  SUPPORT_LEARNING_CANDIDATE_STATES,
  supportAutoOutcomeClass,
  type BusinessConversationState,
  type BusinessHandoffReason,
  type ReportRange,
  type SupportAiAutoOutcome,
  type SupportAiJobKind,
  type SupportAiJobState,
  type SupportAiOutcomeKind,
  type SupportAiProvider,
  type SupportAnalyticsResponse,
  type SupportKnowledgeArticleState,
  type SupportKnowledgeSource,
  type SupportLearningCandidateState,
} from '@nexa/contracts';

/**
 * TB10 — the grouped counts the reader returns, before they become the response. Each list
 * is what one `GROUP BY` produced; nothing here has been classified yet.
 */
export interface SupportAnalyticsFacts {
  readonly conversations: readonly {
    readonly state: BusinessConversationState;
    readonly count: number;
  }[];
  readonly handoffs: readonly { readonly reason: BusinessHandoffReason; readonly count: number }[];
  readonly jobs: readonly {
    readonly kind: SupportAiJobKind;
    readonly state: SupportAiJobState;
    readonly outcome: SupportAiAutoOutcome | null;
    /** L1: a draft a newer request replaced (`job.superseded`), never an operator's discard. */
    readonly superseded?: boolean;
    readonly count: number;
  }[];
  readonly runs: readonly {
    readonly provider: SupportAiProvider;
    readonly outcome: SupportAiOutcomeKind;
    readonly runs: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }[];
  readonly candidates: readonly {
    readonly state: SupportLearningCandidateState;
    readonly count: number;
  }[];
  readonly articles: readonly {
    readonly source: SupportKnowledgeSource;
    readonly state: SupportKnowledgeArticleState;
    readonly enabled: boolean;
    readonly count: number;
  }[];
}

/** The half-open window the figures were counted in. */
export interface SupportAnalyticsWindow {
  readonly start: Date;
  readonly end: Date;
}

const byCountThenKey =
  <T extends { readonly count: number }>(key: (row: T) => string) =>
  (a: T, b: T): number =>
    b.count - a.count || key(a).localeCompare(key(b));

/**
 * The response from the facts. Pure, so every classification is a unit test:
 *
 * - every conversation state and every learning state appears, zero when absent, so a state
 *   that has no rows reads as 0 rather than as missing;
 * - an AUTO job is SENT, HANDED_OFF or DROPPED by `supportAutoOutcomeClass`, and one with no
 *   outcome yet is PENDING — never counted as a send;
 * - an Assist job is counted by the state it is in NOW: requested = every one.
 */
export function assembleSupportAnalytics(
  range: ReportRange,
  window: SupportAnalyticsWindow,
  facts: SupportAnalyticsFacts,
): SupportAnalyticsResponse {
  const conversations = new Map(facts.conversations.map((row) => [row.state, row.count]));
  const candidates = new Map(facts.candidates.map((row) => [row.state, row.count]));

  const auto = { sent: 0, handedOff: 0, dropped: 0, pending: 0 };
  const autoByOutcome = new Map<SupportAiAutoOutcome, number>();
  const assist = { requested: 0, sent: 0, discarded: 0, superseded: 0, failed: 0, open: 0 };
  for (const job of facts.jobs) {
    if (job.kind === 'AUTO_DECISION') {
      if (job.outcome === null) {
        auto.pending += job.count;
        continue;
      }
      autoByOutcome.set(job.outcome, (autoByOutcome.get(job.outcome) ?? 0) + job.count);
      switch (supportAutoOutcomeClass(job.outcome)) {
        case 'SENT':
          auto.sent += job.count;
          break;
        case 'HANDED_OFF':
          auto.handedOff += job.count;
          break;
        case 'DROPPED':
          auto.dropped += job.count;
          break;
      }
      continue;
    }
    assist.requested += job.count;
    switch (job.state) {
      case 'SENT':
        assist.sent += job.count;
        break;
      case 'DISCARDED':
        // L1: what a re-request replaced is not what an operator threw away.
        if (job.superseded === true) assist.superseded += job.count;
        else assist.discarded += job.count;
        break;
      case 'FAILED':
        assist.failed += job.count;
        break;
      case 'READY':
      case 'QUEUED':
        assist.open += job.count;
        break;
    }
  }

  return {
    period: { range, start: window.start.toISOString(), end: window.end.toISOString() },
    conversationsNow: BUSINESS_CONVERSATION_STATES.map((state) => ({
      state,
      count: conversations.get(state) ?? 0,
    })),
    handoffsByReason: [...facts.handoffs]
      .filter((row) => row.count > 0)
      .sort(byCountThenKey((row) => row.reason)),
    auto: {
      ...auto,
      byOutcome: [...autoByOutcome]
        .map(([outcome, count]) => ({ outcome, count }))
        .sort(byCountThenKey((row) => row.outcome)),
    },
    assist,
    providerRuns: [...facts.runs].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        b.runs - a.runs ||
        a.outcome.localeCompare(b.outcome),
    ),
    learningByState: SUPPORT_LEARNING_CANDIDATE_STATES.map((state) => ({
      state,
      count: candidates.get(state) ?? 0,
    })),
    knowledgeBySource: [...facts.articles].sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.state.localeCompare(b.state) ||
        Number(b.enabled) - Number(a.enabled),
    ),
  };
}
