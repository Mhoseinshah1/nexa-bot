import type { ScopeContext } from '@nexa/contracts';
import type {
  BusinessMessageRepository,
  BusinessOutboundRepository,
} from '../../../commerce/business-chats/application/ports.js';
import { mergeTranscript, type SupportTranscriptLine } from '../domain/transcript.js';

/**
 * How many lines are read for one AI request (A7: 60, was 40); the prompt shows the most recent
 * `SUPPORT_AI_TRANSCRIPT_MESSAGES` (40) of them. The rest is read so the merge places every
 * reply of the window and the knowledge query can reach an earlier description of a problem.
 * Nothing is stored: the rows are the transcript, read each time (no second copy of it).
 */
export const SUPPORT_TRANSCRIPT_READ_LINES = 60;

/**
 * D7 — the transcript an AI request reads: received messages and NEXA's delivered replies
 * (`mergeTranscript`), whether or not Telegram echoed those replies back. Two bounded reads,
 * both tenant-scoped by the repositories. In `tx` when given: the auto-reply reads it again inside
 * its final enqueue transaction (review of PR #248, CX5).
 */
export async function readSupportTranscript(
  deps: {
    readonly messages: Pick<BusinessMessageRepository, 'recent'>;
    readonly outbound: Pick<BusinessOutboundRepository, 'deliveredSince'>;
  },
  scope: ScopeContext,
  conversationId: string,
  limit: number = SUPPORT_TRANSCRIPT_READ_LINES,
  tx?: unknown,
): Promise<readonly SupportTranscriptLine[]> {
  const messages = await deps.messages.recent(scope, conversationId, limit, tx);
  // The replies of the same window (review item 6): when the messages filled their bound, from
  // the oldest of them; DELIVERED only, so pending or failed rows never push one out.
  const since = messages.length >= limit ? (messages[0]?.sentAt ?? null) : null;
  const replies = await deps.outbound.deliveredSince(scope, conversationId, { since, limit }, tx);
  return mergeTranscript(messages, replies, limit);
}
