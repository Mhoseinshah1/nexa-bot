import { z } from 'zod';
import {
  BUSINESS_CONVERSATION_STATES,
  BUSINESS_HANDOFF_REASONS,
  BUSINESS_HANDOFF_WIRE_REASONS,
  businessHandoffWireReason,
  type BusinessHandoffReason,
  type BusinessHandoffWireReason,
} from './business-chats.js';
import { REPORT_RANGES, reportRangeQuerySchema } from './reporting.js';
import {
  SUPPORT_AI_AUTO_OUTCOMES,
  SUPPORT_AI_FAILURE_CLASSES,
  SUPPORT_AI_OPERATIONS,
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
    case 'sent_clarifying':
      return 'SENT';
    case 'dropped_mode':
    case 'dropped_epoch':
    case 'dropped_state':
    case 'dropped_coalesced':
    case 'dropped_connection':
    case 'dropped_scope':
    case 'no_action': // A6: ended silently — nothing sent, nobody handed off.
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
    case 'guard_clarifying_limit':
    case 'handoff_ai_requested':
    case 'handoff_output_invalid':
    case 'handoff_ai_unavailable':
    case 'handoff_stale':
    case 'guard_no_progress':
    case 'guard_repeated_advice':
    case 'guard_inbound_flood':
      return 'HANDED_OFF';
    default: {
      // Compile-time: every outcome this release knows is listed above. Run-time: a NEWER
      // replica's outcome (a rolling deploy) is classified by its family rather than failing
      // the whole analytics read (review of PR #246, m8 — an older classifier threw here).
      const unknown: never = outcome;
      const code = String(unknown);
      if (code.startsWith('sent')) return 'SENT';
      if (code.startsWith('guard_') || code.startsWith('handoff_')) return 'HANDED_OFF';
      return 'DROPPED';
    }
  }
}

export const SUPPORT_ANALYTICS_ROUTES = {
  analytics: '/support-ai/analytics',
} as const;

/**
 * The automatic outcomes a pre-A3 Web Admin bundle accepts in `auto.byOutcome` (review of PR
 * #248, the handoff-reason follow-up to CX1): one value outside it fails its whole analytics page.
 */
export const SUPPORT_AI_AUTO_WIRE_OUTCOMES = [
  'sent',
  'sent_clarifying',
  'dropped_mode',
  'dropped_epoch',
  'dropped_state',
  'dropped_coalesced',
  'dropped_connection',
  'dropped_scope',
  'guard_content',
  'guard_customer_blocked',
  'guard_consecutive',
  'guard_window',
  'guard_decision',
  'guard_handoff_topic',
  'guard_human_requested',
  'guard_topic_allowlist',
  'guard_identity',
  'guard_account_review',
  'guard_confidence',
  'guard_reply_bounds',
  'guard_grounding',
  'guard_clarifying_limit',
  'handoff_ai_requested',
  'handoff_output_invalid',
  'handoff_ai_unavailable',
  'handoff_stale',
] as const;
export type SupportAiAutoWireOutcome = (typeof SUPPORT_AI_AUTO_WIRE_OUTCOMES)[number];

/**
 * The ONE projection of an automatic outcome onto the pre-A3 wire, or null when the old bundle is
 * not told it. The three progress guards go as `guard_consecutive` — the loop guard, as their
 * handoff reason goes as `LOOP_GUARD`. `no_action` (A6, a matter the customer closed) is LEFT OUT
 * of the folded list: no old outcome means "ended silently", and calling it a dropped job of
 * another kind would be a fact nobody recorded. The totals (`auto.dropped`) still count it.
 */
export function supportAutoWireOutcome(
  outcome: SupportAiAutoOutcome,
): SupportAiAutoWireOutcome | null {
  switch (outcome) {
    case 'guard_no_progress':
    case 'guard_repeated_advice':
    case 'guard_inbound_flood':
      return 'guard_consecutive';
    case 'no_action':
      return null;
    default:
      return outcome;
  }
}

/** Largest count first, then by key: the order every count list on the page is sent in. */
function byCountThenKey<T extends { readonly count: number }>(key: (row: T) => string) {
  return (a: T, b: T): number => b.count - a.count || key(a).localeCompare(key(b));
}

/** Folds counts through `project`, summing what lands on one key; a null key is left out. */
function foldCounts<K extends string, W extends string>(
  rows: readonly { readonly key: K; readonly count: number }[],
  project: (key: K) => W | null,
): { readonly key: W; readonly count: number }[] {
  const folded = new Map<W, number>();
  for (const row of rows) {
    const key = project(row.key);
    if (key !== null) folded.set(key, (folded.get(key) ?? 0) + row.count);
  }
  return [...folded]
    .map(([key, count]) => ({ key, count }))
    .filter((row) => row.count > 0)
    .sort(byCountThenKey((row) => row.key));
}

/** The handoff counts for the wire's `handoffsByReason` (`businessHandoffWireReason`). */
export function supportHandoffCountsOnWire(
  rows: readonly { readonly reason: BusinessHandoffReason; readonly count: number }[],
): { readonly reason: BusinessHandoffWireReason; readonly count: number }[] {
  return foldCounts(
    rows.map((row) => ({ key: row.reason, count: row.count })),
    businessHandoffWireReason,
  ).map((row) => ({ reason: row.key, count: row.count }));
}

/** The outcome counts for the wire's `auto.byOutcome` (`supportAutoWireOutcome`). */
export function supportAutoOutcomeCountsOnWire(
  rows: readonly { readonly outcome: SupportAiAutoOutcome; readonly count: number }[],
): { readonly outcome: SupportAiAutoWireOutcome; readonly count: number }[] {
  return foldCounts(
    rows.map((row) => ({ key: row.outcome, count: row.count })),
    supportAutoWireOutcome,
  ).map((row) => ({ outcome: row.key, count: row.count }));
}

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
  /**
   * Keyed by the pre-A3 bundle's reasons only (`supportHandoffCountsOnWire`): the three progress
   * guards are folded into `LOOP_GUARD`, so the old analytics page still parses during a rolling
   * update. The true counts are `handoffsByReasonDetail`; read `supportHandoffCountsOf`.
   */
  handoffsByReason: z.array(z.object({ reason: z.enum(BUSINESS_HANDOFF_WIRE_REASONS), count })),
  /**
   * The same handoffs by their REAL reason. Optional when READ (an older replica does not send
   * it), and absent when it names a reason this bundle does not know — the folded list is then
   * what is shown, never a failed page.
   */
  handoffsByReasonDetail: z
    .array(z.object({ reason: z.enum(BUSINESS_HANDOFF_REASONS), count }))
    .optional()
    .catch(undefined),
  /** `support_ai_jobs` of kind `AUTO_DECISION` created in the window. */
  auto: z.object({
    sent: count,
    handedOff: count,
    dropped: count,
    /** Still queued or in flight: no outcome yet. */
    pending: count,
    /**
     * Keyed by the pre-A3 bundle's outcomes only (`supportAutoOutcomeCountsOnWire`). The true
     * counts are `byOutcomeDetail`; read `supportAutoOutcomeCountsOf`.
     */
    byOutcome: z.array(z.object({ outcome: z.enum(SUPPORT_AI_AUTO_WIRE_OUTCOMES), count })),
    /** By the REAL outcome; tolerant like `handoffsByReasonDetail`. */
    byOutcomeDetail: z
      .array(z.object({ outcome: z.enum(SUPPORT_AI_AUTO_OUTCOMES), count }))
      .optional()
      .catch(undefined),
  }),
  /** `support_ai_jobs` of kind `ASSIST_DRAFT` created in the window, by their state now. */
  assist: z.object({
    requested: count,
    /** Sent by an operator, edited or not (`SENT`). */
    sent: count,
    /** Thrown away by an operator (`DISCARDED` by «کنار گذاشتن»). */
    discarded: count,
    /**
     * L1: replaced by a newer request for the same conversation (`DISCARDED` by the re-request,
     * never by a person). Counted apart, so «کنار گذاشته شد» is what operators threw away.
     */
    superseded: count,
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
  /**
   * `support_ai_runs` created in the window that FAILED, by operation, provider and failure
   * class (`SUPPORT_AI_FAILURE_CLASSES`): why the AI did not answer, without reading any text.
   * A run recorded before the class existed is counted under its outcome only (above).
   */
  aiFailures: z.array(
    z.object({
      operation: z.enum(SUPPORT_AI_OPERATIONS),
      provider: z.enum(SUPPORT_AI_PROVIDERS),
      failureClass: z.enum(SUPPORT_AI_FAILURE_CLASSES),
      runs: count,
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

/** The handoffs by their real reason when the server sent them, else the folded list. */
export function supportHandoffCountsOf(
  data: Pick<SupportAnalyticsResponse, 'handoffsByReason' | 'handoffsByReasonDetail'>,
): readonly { readonly reason: BusinessHandoffReason; readonly count: number }[] {
  return data.handoffsByReasonDetail ?? data.handoffsByReason;
}

/** The automatic outcomes by their real value when the server sent them, else the folded list. */
export function supportAutoOutcomeCountsOf(
  data: Pick<SupportAnalyticsResponse, 'auto'>,
): readonly { readonly outcome: SupportAiAutoOutcome; readonly count: number }[] {
  return data.auto.byOutcomeDetail ?? data.auto.byOutcome;
}
