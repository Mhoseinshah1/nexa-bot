import type { SupportAiDecisionKind, SupportAiTopic } from '@nexa/contracts';
import type { KnowledgeQueryPart } from '../../../commerce/support-context/domain/knowledge-relevance.js';
import { KNOWLEDGE_QUERY_MESSAGES, type SupportTranscriptLine } from './transcript.js';

/**
 * A8 — what the knowledge a request carries is chosen BY. Before this it was the customer's
 * latest three messages alone, so a customer five steps into a connection problem who wrote
 * «باز هم نشد» («still no») was matched against nothing, and the article the conversation was
 * about fell out of the request just when it was needed.
 *
 * The query is a few weighted parts, each decided by NEXA from rows, never by a model:
 *
 * | Part                         | Source                                                   | Weight |
 * | ---------------------------- | -------------------------------------------------------- | ------ |
 * | the customer's latest words  | the latest three customer messages with text             | 1      |
 * | the last intent              | the latest decided job's `intent` (a short label)        | 0.6    |
 * | the knowledge it cited       | the titles the latest two decided jobs cited             | 0.5    |
 * | the troubleshooting episode  | earlier customer messages, while troubleshooting is open | 0.5    |
 * | the last topic               | a fixed Persian vocabulary per safe topic                | 0.4    |
 *
 * Deterministic and bounded: every part is clipped, at most `KNOWLEDGE_QUERY_PRIOR_JOBS` jobs
 * are read, and the scorer keeps at most `KNOWLEDGE_QUERY_MAX_TERMS` distinct terms, the
 * customer's first. No embedding, no model, no I/O here.
 */

/** One earlier decision of the conversation, as the knowledge query reads it. */
export interface PriorDecisionFact {
  readonly decision: SupportAiDecisionKind | null;
  readonly topic: SupportAiTopic | null;
  /** Purged with the job's text after the retention period: null then. */
  readonly intent: string | null;
  /** The titles of the knowledge entries it cited (ASSIST drafts record them; D3). */
  readonly knowledgeLabels: readonly string[];
}

/** How many of the conversation's latest decided jobs the query reads. */
export const KNOWLEDGE_QUERY_PRIOR_JOBS = 3;

export const KNOWLEDGE_QUERY_WEIGHTS = {
  latestCustomer: 1,
  intent: 0.6,
  citedTitles: 0.5,
  troubleshooting: 0.5,
  topic: 0.4,
} as const;

/** Each part's own character bound, so the query is bounded whatever the rows hold. */
const PART_MAX_CHARS = {
  latestCustomer: 4_500,
  intent: 160,
  citedTitles: 1_200,
  troubleshooting: 3_000,
} as const;

/** How many earlier customer messages an open troubleshooting episode adds. */
export const KNOWLEDGE_QUERY_EPISODE_MESSAGES = 6;

/** The topics a step-by-step troubleshooting conversation is about. */
export const TROUBLESHOOTING_TOPICS: ReadonlySet<SupportAiTopic> = new Set<SupportAiTopic>([
  'CONNECTION_TROUBLESHOOTING',
  'APP_SETUP',
  'SUBSCRIPTION_UPDATE',
  'KNOWN_ERROR',
]);

/**
 * The words a topic means, in the language the articles are written in. Only the SAFE topics:
 * a handoff topic is a person's, and knowledge chosen for it reaches nobody automatically.
 */
export const TOPIC_QUERY_TERMS: Readonly<Partial<Record<SupportAiTopic, string>>> = {
  CONNECTION_TROUBLESHOOTING: 'اتصال وصل قطع',
  APP_SETUP: 'نصب برنامه تنظیم',
  SUBSCRIPTION_UPDATE: 'لینک اشتراک بروزرسانی',
  SERVICE_INFO: 'سرویس',
  TRAFFIC_AND_EXPIRY: 'حجم ترافیک انقضا',
  PLAN_INFO: 'پلن تعرفه',
  KNOWN_ERROR: 'خطا',
};

/**
 * Whether a troubleshooting episode is open: the conversation's latest decision gave a step or
 * asked a question on a troubleshooting topic. While it is open, the customer's latest words
 * («done, still nothing») say less than the description that opened it.
 */
export function troubleshootingState(prior: readonly PriorDecisionFact[]): {
  readonly open: boolean;
  readonly topic: SupportAiTopic | null;
  /** PR #244 (CX2): how many of the latest decisions, in a row, were troubleshooting steps. */
  readonly steps: number;
} {
  const isStep = (job: PriorDecisionFact) =>
    job.topic !== null &&
    TROUBLESHOOTING_TOPICS.has(job.topic) &&
    (job.decision === 'REPLY' || job.decision === 'ASK_CLARIFYING_QUESTION');
  const last = prior[0];
  if (last === undefined || last.topic === null) return { open: false, topic: null, steps: 0 };
  let steps = 0;
  while (steps < prior.length && isStep(prior[steps] as PriorDecisionFact)) steps += 1;
  return { open: steps > 0, topic: last.topic, steps };
}

/** A transcript line as the knowledge query reads it; `author` when the merge decided one. */
type QueryLine = Pick<SupportTranscriptLine, 'origin' | 'text'> & {
  readonly author?: SupportTranscriptLine['author'];
};

/** A line a person or an automatic message wrote: a boundary no AI episode crosses. */
function isPersonOrAutomated(line: QueryLine): boolean {
  if (line.author !== undefined) return line.author === 'STAFF' || line.author === 'AUTOMATED';
  return line.origin === 'HUMAN' || line.origin === 'OFFLINE' || line.origin === 'OTHER_BOT';
}

/**
 * PR #244 (CX2) — the customer's words of the OPEN episode only, oldest first, without the latest
 * `skip`: walking back, the episode spans the `steps` support replies the streak gave and the
 * customer's messages just before the first of them (the description that opened it). It stops at
 * the support reply before the episode, and at any line a person or an automatic message wrote,
 * so an older, unrelated problem never enters at the episode's weight.
 */
function episodeMessages(
  lines: readonly QueryLine[],
  steps: number,
  skip: number,
  count: number,
): string[] {
  const words: string[] = [];
  let supportSeen = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as QueryLine;
    if (line.origin !== 'INBOUND') {
      if (isPersonOrAutomated(line)) break;
      supportSeen += 1;
      if (supportSeen > steps) break;
      continue;
    }
    if (line.text !== null && line.text.trim() !== '') words.unshift(line.text);
  }
  return words.slice(0, Math.max(0, words.length - skip)).slice(-count);
}

/** The customer's messages with text, oldest first, skipping the latest `skip`. */
function customerMessages(
  lines: readonly Pick<SupportTranscriptLine, 'origin' | 'text'>[],
  skip: number,
  count: number,
): string[] {
  const words: string[] = [];
  let seen = 0;
  for (let index = lines.length - 1; index >= 0 && words.length < count; index -= 1) {
    const line = lines[index];
    if (line?.origin !== 'INBOUND' || line.text === null || line.text.trim() === '') continue;
    seen += 1;
    if (seen > skip) words.unshift(line.text);
  }
  return words;
}

/**
 * Messages joined within `max` characters, EACH held to an equal share, so a long older message
 * can never push the newest one out of the part (review of PR #236): clipping the joined text
 * from its start would keep the oldest words and drop the latest question.
 */
export function joinBounded(messages: readonly string[], max: number): string {
  if (messages.length === 0) return '';
  const share = Math.max(1, Math.floor((max - (messages.length - 1)) / messages.length));
  return messages.map((message) => message.slice(0, share)).join('\n');
}

/**
 * The weighted query for one request. `prior` is newest first (`priorDecisions`). Parts with no
 * text are left out; the order is the priority the term bound keeps.
 */
export function knowledgeQueryFor(
  transcript: readonly QueryLine[],
  prior: readonly PriorDecisionFact[],
): KnowledgeQueryPart[] {
  const parts: KnowledgeQueryPart[] = [];
  const add = (text: string, max: number, weight: number) => {
    const clipped = text.slice(0, max).trim();
    if (clipped !== '') parts.push({ text: clipped, weight });
  };
  add(
    joinBounded(
      customerMessages(transcript, 0, KNOWLEDGE_QUERY_MESSAGES),
      PART_MAX_CHARS.latestCustomer,
    ),
    PART_MAX_CHARS.latestCustomer,
    KNOWLEDGE_QUERY_WEIGHTS.latestCustomer,
  );
  const recent = prior.slice(0, KNOWLEDGE_QUERY_PRIOR_JOBS);
  const last = recent[0];
  if (last !== undefined && last.intent !== null) {
    add(last.intent, PART_MAX_CHARS.intent, KNOWLEDGE_QUERY_WEIGHTS.intent);
  }
  add(
    recent
      .slice(0, 2)
      .flatMap((job) => job.knowledgeLabels)
      .join('\n'),
    PART_MAX_CHARS.citedTitles,
    KNOWLEDGE_QUERY_WEIGHTS.citedTitles,
  );
  const episode = troubleshootingState(recent);
  if (episode.open) {
    add(
      joinBounded(
        episodeMessages(
          transcript,
          episode.steps,
          KNOWLEDGE_QUERY_MESSAGES,
          KNOWLEDGE_QUERY_EPISODE_MESSAGES,
        ),
        PART_MAX_CHARS.troubleshooting,
      ),
      PART_MAX_CHARS.troubleshooting,
      KNOWLEDGE_QUERY_WEIGHTS.troubleshooting,
    );
  }
  const topicTerms =
    last === undefined || last.topic === null ? undefined : TOPIC_QUERY_TERMS[last.topic];
  // N4: generic topic words count only in a title or a tag, never in a body.
  if (topicTerms !== undefined) {
    parts.push({ text: topicTerms, weight: KNOWLEDGE_QUERY_WEIGHTS.topic, titleAndTagsOnly: true });
  }
  return parts;
}
