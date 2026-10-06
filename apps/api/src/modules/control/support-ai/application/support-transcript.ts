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
    readonly outbound: Pick<BusinessOutboundRepository, 'recent'>;
  },
  scope: ScopeContext,
  conversationId: string,
  limit: number = SUPPORT_TRANSCRIPT_READ_LINES,
): Promise<readonly SupportTranscriptLine[]> {
  const [messages, replies] = await Promise.all([
    deps.messages.recent(scope, conversationId, limit),
    deps.outbound.recent(scope, conversationId, limit),
  ]);
  return mergeTranscript(messages, replies, limit);
}
