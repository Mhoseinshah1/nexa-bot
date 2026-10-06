import type { ScopeContext } from '@nexa/contracts';
import type {
  BusinessMessageRepository,
  BusinessOutboundRepository,
} from '../../../commerce/business-chats/application/ports.js';
import { mergeTranscript, type SupportTranscriptLine } from '../domain/transcript.js';

/** How many lines are read for one AI request; the prompt shows the most recent of them. */
export const SUPPORT_TRANSCRIPT_READ_LINES = 40;

/**
 * D7 — the transcript an AI request reads: received messages and NEXA's delivered replies
 * (`mergeTranscript`), whether or not Telegram echoed those replies back. Two bounded reads,
 * both tenant-scoped by the repositories.
 */
export async function readSupportTranscript(
  deps: {
    readonly messages: Pick<BusinessMessageRepository, 'recent'>;
    readonly outbound: Pick<BusinessOutboundRepository, 'deliveredSince'>;
  },
  scope: ScopeContext,
  conversationId: string,
  limit: number = SUPPORT_TRANSCRIPT_READ_LINES,
): Promise<readonly SupportTranscriptLine[]> {
  const messages = await deps.messages.recent(scope, conversationId, limit);
  // The replies of the same window (review item 6): when the messages filled their bound, from
  // the oldest of them; DELIVERED only, so pending or failed rows never push one out.
  const since = messages.length >= limit ? (messages[0]?.sentAt ?? null) : null;
  const replies = await deps.outbound.deliveredSince(scope, conversationId, { since, limit });
  return mergeTranscript(messages, replies, limit);
}
