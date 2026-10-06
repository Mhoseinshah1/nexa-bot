import type {
  BusinessMessageKind,
  BusinessMessageOrigin,
  BusinessOutboundOrigin,
  BusinessOutboundState,
} from '@nexa/contracts';

/**
 * D7 — the conversation the model reads: what Telegram delivered to us (`business_messages`)
 * PLUS what we delivered (`business_outbound_messages` DELIVERED), in time order.
 *
 * NEXA's own replies reach `business_messages` only if Telegram echoes this bot's sends back
 * to it (OQ-TB-03 #4, unobserved). Without the echo every call after the first saw a
 * conversation with no answers in it, and repeated step one of troubleshooting for ever. With
 * it, the echo is the reply: a delivered row whose Telegram message id is already a received
 * message — `OWN_ECHO`, or `HUMAN` if it arrived before the lane wrote the id (TB2 review F2)
 * — is that message, never a second line.
 */

/** One line of the model's transcript; a reply line's id is never a message id. */
export interface SupportTranscriptLine {
  readonly id: string;
  readonly origin: BusinessMessageOrigin;
  readonly kind: BusinessMessageKind;
  readonly text: string | null;
  readonly sentAt: Date;
}

export interface TranscriptMessageInput extends SupportTranscriptLine {
  readonly telegramMessageId: number;
}

export interface TranscriptReplyInput {
  readonly id: string;
  readonly origin: BusinessOutboundOrigin;
  readonly state: BusinessOutboundState;
  readonly body: string | null;
  readonly telegramMessageId: number | null;
  readonly sendStartedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

/** The prefix a reply line's id carries: an image or a citation can never name it. */
export const TRANSCRIPT_REPLY_ID_PREFIX = 'outbound:';

/**
 * `messages` and `replies` as one transcript of at most `limit` lines, oldest first.
 *
 * - Only a DELIVERED reply with text is a line: a pending, unconfirmed, failed or superseded
 *   one is not something the customer read.
 * - A reply whose Telegram id is a received message is that message (the echo), once.
 * - Ordered by time: a message's `sentAt` is Telegram's date (whole seconds, truncated, so
 *   never later than the message really was); a reply's is when its send started. On a tie the
 *   message goes first. A question is seconds older than its answer (the settle delay and the
 *   provider call, or an operator typing), so the only tie this can misplace is a customer
 *   writing in the very second our reply left — two messages that crossed, in either order.
 * - When `messages` filled its window, a reply older than the oldest message in it is outside
 *   the window too, so the transcript never has a hole in the middle.
 */
export function mergeTranscript(
  messages: readonly TranscriptMessageInput[],
  replies: readonly TranscriptReplyInput[],
  limit: number,
): SupportTranscriptLine[] {
  const received = new Set(messages.map((message) => message.telegramMessageId));
  const windowStart = messages.length >= limit ? (messages[0]?.sentAt ?? null) : null;
  const lines: { readonly line: SupportTranscriptLine; readonly rank: number }[] = [];
  for (const message of messages) {
    lines.push({
      line: {
        id: message.id,
        origin: message.origin,
        kind: message.kind,
        text: message.text,
        sentAt: message.sentAt,
      },
      rank: 0,
    });
  }
  for (const reply of replies) {
    if (reply.state !== 'DELIVERED' || reply.body === null || reply.body.trim() === '') continue;
    if (reply.telegramMessageId !== null && received.has(reply.telegramMessageId)) continue;
    const at = reply.sendStartedAt ?? reply.resolvedAt ?? reply.createdAt;
    if (windowStart !== null && at.getTime() < windowStart.getTime()) continue;
    lines.push({
      line: {
        id: `${TRANSCRIPT_REPLY_ID_PREFIX}${reply.id}`,
        origin: 'OWN_ECHO',
        kind: 'TEXT',
        text: reply.body,
        sentAt: at,
      },
      rank: 1,
    });
  }
  // A stable sort: messages keep their stored order among themselves.
  return lines
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) =>
        a.line.sentAt.getTime() - b.line.sentAt.getTime() ||
        // A tie: the message first; each kind keeps the order it was read in.
        a.rank - b.rank ||
        a.index - b.index,
    )
    .map((entry) => entry.line)
    .slice(-limit);
}

/** How many of the customer's latest messages choose the knowledge a request carries (D2). */
export const KNOWLEDGE_QUERY_MESSAGES = 3;

/**
 * D2 — the words the knowledge is chosen by: the customer's latest `count` messages with text,
 * oldest first, one per line. Empty when the customer has written nothing readable.
 */
export function latestCustomerWords(
  lines: readonly Pick<SupportTranscriptLine, 'origin' | 'text'>[],
  count: number = KNOWLEDGE_QUERY_MESSAGES,
): string {
  const words: string[] = [];
  for (let index = lines.length - 1; index >= 0 && words.length < count; index -= 1) {
    const line = lines[index];
    if (line?.origin === 'INBOUND' && line.text !== null && line.text.trim() !== '') {
      words.unshift(line.text);
    }
  }
  return words.join('\n');
}
