import { z } from 'zod';
import { BUSINESS_CONVERSATION_STATES, BUSINESS_HANDOFF_REASONS } from './business-chats.js';
import { REPORT_RANGES, reportRangeQuerySchema } from './reporting.js';
import {
  SUPPORT_AI_AUTO_OUTCOMES,
  SUPPORT_AI_OUTCOMES,
  SUPPORT_AI_PROVIDERS,
  type SupportAiAutoOutcome,
} from './support-ai.js';
import {
  SUPPORT_KNOWLEDGE_ARTICLE_STATES,
  SUPPORT_KNOWLEDGE_SOURCES,
  SUPPORT_LEARNING_CANDIDATE_STATES,
} from './support-knowledge.js';

/**
 * TB10 — support analytics (program §40, §46): READ-ONLY counts over rows the support agent
 * already writes. Nothing here is a new fact; every figure is a named derivation, and the
 * derivations are stated beside the field so a reader can check one against the table.
 *
 * The window is HALF-OPEN, `[start, end)`, resolved by the reports' own resolver in the
 * tenant's timezone and calendar (`reportRangeQuerySchema`), so «this month» here means
 * what it means on the business reports.
 *
 * What is deliberately absent:
 *
 * - **Cost.** `OQ-TB-07` stands: no price table is hard-coded, and no tenant-entered
 *   per-model price exists yet, so no money figure is reported. Tokens are reported
 *   instead, which is what a cost would be computed from.
 * - **"Resolved by the AI".** `OQ-TB-09` stands: replies and handoffs are counted, never
 *   resolutions.
 * - **Any text.** No prompt, response, message, summary or title is read by these queries.
 */

/**
 * What became of an automatic job, in three classes. Exhaustive by `switch`, so an outcome
 * added to `SUPPORT_AI_AUTO_OUTCOMES` must be classified before it compiles:
 *
 * - `SENT` — a lane row was enqueued (the lane's final check may still supersede it);
 * - `HANDED_OFF` — a guard failed or the model asked for a person / produced nothing usable,
 *   and the conversation went to `HANDOFF_REQUIRED` (TB7: every guard failure hands off);
 * - `DROPPED` — nothing sent and nobody handed off: the mode, epoch, state, connection or
 *   scope moved, or a newer message replaced the job.
 */
export const SUPPORT_AUTO_OUTCOME_CLASSES = ['SENT', 'HANDED_OFF', 'DROPPED'] as const;
export type SupportAutoOutcomeClass = (typeof SUPPORT_AUTO_OUTCOME_CLASSES)[number];

export function supportAutoOutcomeClass(outcome: SupportAiAutoOutcome): SupportAutoOutcomeClass {
  switch (outcome) {
    case 'sent':
      return 'SENT';
    case 'dropped_mode':
    case 'dropped_epoch':
    case 'dropped_state':
    case 'dropped_coalesced':
    case 'dropped_connection':
    case 'dropped_scope':
      return 'DROPPED';
    case 'guard_content':
    case 'guard_customer_blocked':
    case 'guard_consecutive':
    case 'guard_window':
    case 'guard_decision':
    case 'guard_handoff_topic':
    case 'guard_human_requested':
    case 'guard_topic_allowlist':
    case 'guard_identity':
    case 'guard_account_review':
    case 'guard_confidence':
    case 'guard_reply_bounds':
    case 'guard_grounding':
    case 'handoff_ai_requested':
    case 'handoff_output_invalid':
    case 'handoff_ai_unavailable':
    case 'handoff_stale':
      return 'HANDED_OFF';
    default: {
      const unreachable: never = outcome;
      throw new Error(`unclassified automatic outcome ${String(unreachable)}`);
    }
  }
}

export const SUPPORT_ANALYTICS_ROUTES = {
  analytics: '/support-ai/analytics',
} as const;

/** The same period every business report takes; `from`/`to` exactly when CUSTOM. */
export const supportAnalyticsQuerySchema = reportRangeQuerySchema;
export type SupportAnalyticsQuery = z.infer<typeof supportAnalyticsQuerySchema>;

const count = z.number().int().nonnegative();

export const supportAnalyticsResponseSchema = z.object({
  period: z.object({
    range: z.enum(REPORT_RANGES),
    /** Inclusive. */
    start: z.iso.datetime(),
    /** EXCLUSIVE: `[start, end)`. */
    end: z.iso.datetime(),
  }),
  /**
   * A SNAPSHOT, not the window: every conversation of the tenant by its state now. Who holds
   * a conversation is a present fact; counting it "in a period" would mean nothing.
   */
  conversationsNow: z.array(z.object({ state: z.enum(BUSINESS_CONVERSATION_STATES), count })),
  /** `business_conversation_escalations` created in the window, by reason (one per handoff). */
  handoffsByReason: z.array(z.object({ reason: z.enum(BUSINESS_HANDOFF_REASONS), count })),
  /** `support_ai_jobs` of kind `AUTO_DECISION` created in the window. */
  auto: z.object({
    sent: count,
    handedOff: count,
    dropped: count,
    /** Still queued or in flight: no outcome yet. */
    pending: count,
    byOutcome: z.array(z.object({ outcome: z.enum(SUPPORT_AI_AUTO_OUTCOMES), count })),
  }),
  /** `support_ai_jobs` of kind `ASSIST_DRAFT` created in the window, by their state now. */
  assist: z.object({
    requested: count,
    /** Sent by an operator, edited or not (`SENT`). */
    sent: count,
    /** Thrown away, or replaced by a newer draft (`DISCARDED`). */
    discarded: count,
    /** No draft: the chain could not answer (`FAILED`). */
    failed: count,
    /** A draft exists and nobody acted on it yet (`READY`), or it is still queued. */
    open: count,
  }),
  /**
   * `support_ai_runs` created in the window, by provider and outcome: one row per provider
   * CALL (a fallback is a second run). Latency percentiles are continuous (`percentile_cont`)
   * over the group's runs; tokens are the provider's own counts, summed, with a run that
   * reported none counted as zero.
   */
  providerRuns: z.array(
    z.object({
      provider: z.enum(SUPPORT_AI_PROVIDERS),
      outcome: z.enum(SUPPORT_AI_OUTCOMES),
      runs: count,
      p50LatencyMs: count,
      p95LatencyMs: count,
      inputTokens: count,
      outputTokens: count,
    }),
  ),
  /** `support_learning_candidates` created in the window, by their state now. */
  learningByState: z.array(z.object({ state: z.enum(SUPPORT_LEARNING_CANDIDATE_STATES), count })),
  /** A SNAPSHOT: every knowledge article by source, state and whether it is enabled. */
  knowledgeBySource: z.array(
    z.object({
      source: z.enum(SUPPORT_KNOWLEDGE_SOURCES),
      state: z.enum(SUPPORT_KNOWLEDGE_ARTICLE_STATES),
      enabled: z.boolean(),
      count,
    }),
  ),
});
export type SupportAnalyticsResponse = z.infer<typeof supportAnalyticsResponseSchema>;
