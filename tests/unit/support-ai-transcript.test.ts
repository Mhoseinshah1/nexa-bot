import { describe, expect, it } from 'vitest';
import {
  mergeTranscript,
  type TranscriptMessageInput,
  type TranscriptReplyInput,
} from '../../apps/api/src/modules/control/support-ai/domain/transcript';
import { transcriptMessages } from '../../apps/api/src/modules/control/support-ai/domain/prompt';

/**
 * D7 — the transcript the model reads is received messages PLUS NEXA's delivered replies, so it
 * holds the answers whether or not Telegram echoes the bot's own sends (OQ-TB-03 #4).
 */

const at = (second: number, ms = 0) => new Date(Date.UTC(2026, 9, 6, 10, 0, second, ms));

function msg(
  id: string,
  telegramMessageId: number,
  second: number,
  text: string,
  origin: TranscriptMessageInput['origin'] = 'INBOUND',
): TranscriptMessageInput {
  return { id, telegramMessageId, origin, kind: 'TEXT', text, sentAt: at(second) };
}

function reply(
  id: string,
  second: number,
  text: string,
  over: Partial<TranscriptReplyInput> = {},
): TranscriptReplyInput {
  return {
    id,
    origin: 'AUTO',
    state: 'DELIVERED',
    body: text,
    telegramMessageId: 500 + Number(id.replace(/\D/gu, '') || '0'),
    sendStartedAt: at(second, 400),
    resolvedAt: at(second, 900),
    createdAt: at(second - 1),
    ...over,
  };
}

describe('D7 — mergeTranscript', () => {
  it('without an echo, a delivered reply is a line of the transcript, in time order', () => {
    const lines = mergeTranscript(
      [msg('m1', 1, 0, 'وصل نمیشه'), msg('m2', 2, 30, 'باز هم نشد')],
      [reply('r1', 10, 'برنامه را ببندید'), reply('r2', 40, 'سرور دیگری را امتحان کنید')],
      40,
    );
    expect(lines.map((line) => [line.origin, line.text])).toEqual([
      ['INBOUND', 'وصل نمیشه'],
      ['OWN_ECHO', 'برنامه را ببندید'],
      ['INBOUND', 'باز هم نشد'],
      ['OWN_ECHO', 'سرور دیگری را امتحان کنید'],
    ]);
    expect(lines[1]?.id).toBe('outbound:r1');
    expect(transcriptMessages(lines).map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('with the echo, the reply is that message, once — OWN_ECHO, or HUMAN before the relabel', () => {
    const replies = [reply('r1', 10, 'برنامه را ببندید', { telegramMessageId: 77 })];
    for (const origin of ['OWN_ECHO', 'HUMAN'] as const) {
      const lines = mergeTranscript(
        [msg('m1', 1, 0, 'وصل نمیشه'), msg('e1', 77, 10, 'برنامه را ببندید', origin)],
        replies,
        40,
      );
      expect(lines.map((line) => line.id)).toEqual(['m1', 'e1']);
    }
  });

  it('only a DELIVERED reply with text is read: pending, unconfirmed, failed, superseded or purged are not', () => {
    const lines = mergeTranscript(
      [msg('m1', 1, 0, 'سلام')],
      [
        reply('r1', 5, 'pending', { state: 'PENDING' }),
        reply('r2', 6, 'unconfirmed', { state: 'UNCONFIRMED' }),
        reply('r3', 7, 'failed', { state: 'FAILED' }),
        reply('r4', 8, 'superseded', { state: 'SUPERSEDED' }),
        reply('r5', 9, '', {}),
        reply('r6', 10, 'purged', { body: null }),
        reply('r7', 11, 'operator', { origin: 'OPERATOR' }),
      ],
      40,
    );
    expect(lines.map((line) => line.text)).toEqual(['سلام', 'operator']);
  });

  it('a message of the same instant goes first; the limit keeps the most recent lines', () => {
    const lines = mergeTranscript(
      [msg('m1', 1, 0, 'a'), msg('m2', 2, 5, 'b')],
      [reply('r1', 5, 'c', { sendStartedAt: at(5) })],
      2,
    );
    expect(lines.map((line) => line.text)).toEqual(['b', 'c']);
  });

  it('a reply older than a full message window is outside it: no hole in the middle', () => {
    const lines = mergeTranscript(
      [msg('m9', 9, 50, 'x'), msg('m10', 10, 60, 'y')],
      [reply('r1', 10, 'old'), reply('r2', 55, 'new')],
      2,
    );
    expect(lines.map((line) => line.text)).toEqual(['new', 'y']);
    // A window that was not full holds every reply.
    expect(
      mergeTranscript([msg('m10', 10, 60, 'y')], [reply('r1', 10, 'old')], 2).map((l) => l.text),
    ).toEqual(['old', 'y']);
  });
});
