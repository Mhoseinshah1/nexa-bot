import { errors } from '@nexa/contracts';

/**
 * Telegram's two length bounds on what this installation sends a customer, in ONE
 * place. `send-message.ts` re-exports the caption bound for the transport's own use;
 * nothing else may declare either number, because two copies of a bound are two
 * answers to "will Telegram accept this", and the copy nobody updates is the one that
 * lets a message out that Telegram refuses.
 */

/** Telegram's bound on a message's text: 4,096 characters after entity parsing. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * Telegram's bound on a media CAPTION: 1,024 characters after entity parsing.
 *
 * Four times shorter than a message, and a caption over it is not truncated by Telegram
 * but REFUSED — the whole send fails with a 400, image and buttons with it.
 */
export const TELEGRAM_CAPTION_MAX = 1024;

/**
 * Where a message may be cut, in order of preference. The transport's own bound is
 * in UTF-16 code units, which is never fewer than the characters Telegram counts, so a
 * part that fits here fits there.
 */
const PARAGRAPH = '\n\n';
const LINE = '\n';

/**
 * A rendered body cut into parts Telegram will accept, each at most `max` code units.
 *
 * Boundaries are tried in order: between paragraphs (`\n\n`) first, then between
 * lines, and only when a single line is itself longer than `max` between characters —
 * at a CODE POINT, never inside a surrogate pair, because half an emoji is a
 * malformed string and Telegram refuses those with the same 400 as a long one.
 *
 * The separator a cut lands on is consumed: it belonged between two parts that are now
 * two messages, and keeping it would put a blank line at the top of the next one or,
 * for a part of exactly `max`, push it over the bound. So the parts joined with the
 * empty string equal the original text minus those separators, and nothing else.
 *
 * Parts that are only whitespace are dropped. Telegram refuses an empty or blank
 * message, and a blank part would end the sequence early with a REFUSED that nothing
 * about the original text explains. Empty input therefore yields no parts.
 *
 * Deliberately NOT HTML-aware. A `TELEGRAM_HTML` body long enough to split is a list
 * of many items, and an item does not span a paragraph boundary; a tag that did would
 * make its part fail to parse, which Telegram reports as a refusal the caller sees.
 * Closing and reopening tags across parts is a second renderer, and the catalogue is
 * rendered in one place on purpose.
 *
 * Deterministic: the same text and bound always produce the same parts.
 */
export function splitMessageBody(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max < 1) {
    throw errors.validation(
      'messaging.split_bound_invalid',
      'A message bound is a positive integer.',
      {
        max,
      },
    );
  }
  return splitBy(text, max, 0).filter((part) => part.trim() !== '');
}

const SEPARATORS: readonly string[] = [PARAGRAPH, LINE];

function splitBy(text: string, max: number, level: number): string[] {
  if (text.length <= max) return [text];
  const separator = SEPARATORS[level];
  if (separator === undefined) return splitCodePoints(text, max);

  const parts: string[] = [];
  let current = '';
  for (const segment of text.split(separator)) {
    if (segment.length > max) {
      // A segment no cut at this level can fit: flush what is packed, then cut the
      // segment at the next, finer, boundary. Its pieces are not merged back with the
      // segments around them — a piece is already the largest thing that fits.
      if (current !== '') parts.push(current);
      current = '';
      parts.push(...splitBy(segment, max, level + 1));
      continue;
    }
    if (current === '') {
      current = segment;
    } else if (current.length + separator.length + segment.length <= max) {
      current = `${current}${separator}${segment}`;
    } else {
      parts.push(current);
      current = segment;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * The last resort: fixed-width pieces measured in code units but cut only between
 * code points. A pair straddling the bound goes whole into the next piece, so a piece
 * may be one unit short of `max` and is never one unit over.
 */
function splitCodePoints(text: string, max: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const point of text) {
    if (current.length + point.length > max) {
      parts.push(current);
      current = point;
    } else {
      current += point;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * The worse of two send outcomes, for a message that went out as several parts.
 *
 * The order is what a caller must assume about the WHOLE message. `UNKNOWN` is worst:
 * a part may or may not have arrived, and nothing here may retry it (ADR-0030 §2). A
 * definite `REFUSED` is next — the customer certainly did not get all of it. A
 * `RATE_LIMITED` part was declined and can be sent later. `DELIVERED` is only true of
 * the whole when it is true of every part.
 */
const OUTCOME_SEVERITY = { DELIVERED: 0, RATE_LIMITED: 1, REFUSED: 2, UNKNOWN: 3 } as const;

export type SplitSendOutcome = keyof typeof OUTCOME_SEVERITY;

export function worstOutcome<T extends SplitSendOutcome>(left: T, right: T): T {
  return OUTCOME_SEVERITY[right] > OUTCOME_SEVERITY[left] ? right : left;
}
