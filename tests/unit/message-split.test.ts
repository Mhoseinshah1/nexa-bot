import { describe, expect, it } from 'vitest';
import {
  splitMessageBody,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MESSAGE_MAX,
  worstOutcome,
} from '../../apps/api/src/modules/commerce/messaging/application/message-split';
import { TELEGRAM_CAPTION_MAX as TRANSPORT_CAPTION_MAX } from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * How a body longer than Telegram allows is cut.
 *
 * Each rule below is one a green suite would otherwise let drift: the boundary
 * preference, the bound on every part, the surrogate pair that is never halved, and
 * the reconstruction that says nothing but separators was lost.
 */
describe('splitMessageBody', () => {
  /** Everything but the newlines that were consumed at cuts survives, in order. */
  const sameLettersAs = (text: string, parts: string[]) => {
    expect(parts.join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
    // At most two newline characters are consumed per cut, never more.
    const lost = text.length - parts.join('').length;
    expect(lost).toBeLessThanOrEqual(2 * Math.max(parts.length - 1, 0));
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(max);
  };
  const max = 20;

  it('returns a body within the bound as one part, untouched', () => {
    expect(splitMessageBody('short\n\ntext', 100)).toEqual(['short\n\ntext']);
    const exact = 'a'.repeat(max);
    expect(splitMessageBody(exact, max)).toEqual([exact]);
  });

  it('returns no parts for an empty or blank body', () => {
    expect(splitMessageBody('', max)).toEqual([]);
    expect(splitMessageBody('\n\n\n', max)).toEqual([]);
  });

  it('cuts between paragraphs first, packing as many as fit', () => {
    const text = 'aaaaa\n\nbbbbb\n\nccccc\n\nddddd\n\neeeee';
    const parts = splitMessageBody(text, max);
    expect(parts).toEqual(['aaaaa\n\nbbbbb\n\nccccc', 'ddddd\n\neeeee']);
    expect(parts.join('\n\n')).toBe(text);
    sameLettersAs(text, parts);
  });

  it('cuts between lines only inside a paragraph that does not fit', () => {
    const text = 'l1 aaaa\nl2 bbbb\nl3 cccc\nl4 dddd\n\nsecond';
    const parts = splitMessageBody(text, max);
    expect(parts).toEqual(['l1 aaaa\nl2 bbbb', 'l3 cccc\nl4 dddd', 'second']);
    sameLettersAs(text, parts);
  });

  it('cuts a single over-long line between characters, and only then', () => {
    const line = 'x'.repeat(45);
    const text = `head\n\n${line}\n\ntail`;
    const parts = splitMessageBody(text, max);
    expect(parts).toEqual(['head', 'x'.repeat(20), 'x'.repeat(20), 'x'.repeat(5), 'tail']);
    sameLettersAs(text, parts);
  });

  it('never cuts inside a surrogate pair', () => {
    // 19 units then an emoji (2 units): the pair straddles the bound and moves whole.
    const text = `${'a'.repeat(19)}😀${'b'.repeat(5)}`;
    const parts = splitMessageBody(text, max);
    expect(parts).toEqual(['a'.repeat(19), `😀${'b'.repeat(5)}`]);
    for (const part of parts) {
      expect(part).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
      expect(part).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    }
    expect(parts.join('')).toBe(text);
  });

  it('is deterministic and keeps every part within the bound on a mixed body', () => {
    const text = [
      'para one line one\npara one line two',
      'p'.repeat(50),
      'short',
      `emoji ${'😀'.repeat(15)}`,
    ].join('\n\n');
    const first = splitMessageBody(text, max);
    expect(splitMessageBody(text, max)).toEqual(first);
    sameLettersAs(text, first);
  });

  it('refuses a bound that is not a positive integer', () => {
    expect(() => splitMessageBody('x', 0)).toThrow();
    expect(() => splitMessageBody('x', 2.5)).toThrow();
  });

  it('declares the two Telegram bounds once, and the transport re-exports the caption one', () => {
    expect(TELEGRAM_MESSAGE_MAX).toBe(4096);
    expect(TELEGRAM_CAPTION_MAX).toBe(1024);
    expect(TRANSPORT_CAPTION_MAX).toBe(TELEGRAM_CAPTION_MAX);
  });
});

describe('worstOutcome', () => {
  it('orders UNKNOWN over REFUSED over RATE_LIMITED over DELIVERED', () => {
    expect(worstOutcome('DELIVERED', 'RATE_LIMITED')).toBe('RATE_LIMITED');
    expect(worstOutcome('RATE_LIMITED', 'REFUSED')).toBe('REFUSED');
    expect(worstOutcome('REFUSED', 'UNKNOWN')).toBe('UNKNOWN');
    expect(worstOutcome('UNKNOWN', 'DELIVERED')).toBe('UNKNOWN');
    expect(worstOutcome('DELIVERED', 'DELIVERED')).toBe('DELIVERED');
  });
});
