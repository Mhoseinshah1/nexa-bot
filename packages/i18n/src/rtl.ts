/**
 * RLM insertion for customer-facing Persian bot text (B2).
 *
 * Telegram (iOS especially) picks a line's direction from what the line starts with. A
 * line that starts with an emoji, an `{icon:…}` marker, a digit or a Latin word and ends in
 * digits («🕒 ساعت: 14:05») is drawn left-aligned although its words are Persian. A
 * RIGHT-TO-LEFT MARK (U+200F) in front of such a line makes it RTL without being visible.
 *
 * Done once, in the renderer, so no template has to remember it:
 *
 * - only a line that contains an RTL letter (a Latin-only line, a bare link or an id stays
 *   as written);
 * - only when the line's first character is not already an RTL letter or a direction mark
 *   (idempotent: a second pass inserts nothing);
 * - never in front of a line that starts with `<code>`, `<pre>` or a URL, and never inside a
 *   multi-line `<pre>`/`<code>` block;
 * - leading HTML tags other than those (`<b>`, `<i>`, `<a …>`) are looked through, and the
 *   mark goes before them.
 */
export const RLM = '\u200F';

const NOT_A_DIGIT = '(?![\\u0660-\\u066C\\u06F0-\\u06F9])';
const RTL_RANGE = '[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC]';
const RTL_LETTER = new RegExp(NOT_A_DIGIT + RTL_RANGE, 'u');
/** An RTL letter or an explicit direction mark: the line already has its direction. */
const HAS_DIRECTION = new RegExp(
  `^(?:${NOT_A_DIGIT}${RTL_RANGE}|[\\u200E\\u200F\\u061C\\u202A-\\u202E\\u2066-\\u2069])`,
  'u',
);
const URL_START = /^(?:https?:\/\/|tg:\/\/|www\.)/iu;
const OPEN_VERBATIM = /<(?:code|pre)(?:\s[^>]*)?>/giu;
const CLOSE_VERBATIM = /<\/(?:code|pre)>/giu;

export type RtlFormat = 'PLAIN_TEXT' | 'TELEGRAM_HTML';

function startsWithVerbatim(line: string): boolean {
  return /^\s*<(?:code|pre)(?:\s[^>]*)?>/iu.test(line);
}

/** The line with leading whitespace and (for HTML) leading non-verbatim tags removed. */
function significantStart(line: string, format: RtlFormat): string {
  let rest = line.replace(/^\s+/u, '');
  if (format === 'TELEGRAM_HTML') {
    for (;;) {
      const tag = /^<(?!\/?(?:code|pre)[\s>])\/?[a-z][^>]*>\s*/iu.exec(rest);
      if (tag === null) break;
      rest = rest.slice(tag[0].length);
    }
  }
  return rest;
}

export function applyRtlMarks(text: string, format: RtlFormat = 'PLAIN_TEXT'): string {
  if (!RTL_LETTER.test(text)) return text;
  const html = format === 'TELEGRAM_HTML';
  let depth = 0;
  return text
    .split('\n')
    .map((line) => {
      const insideBefore = html && depth > 0;
      if (html) {
        depth += (line.match(OPEN_VERBATIM) ?? []).length;
        depth -= (line.match(CLOSE_VERBATIM) ?? []).length;
        if (depth < 0) depth = 0;
      }
      if (insideBefore) return line;
      if (!RTL_LETTER.test(line)) return line;
      if (html && startsWithVerbatim(line)) return line;
      const start = significantStart(line, format);
      if (start === '' || HAS_DIRECTION.test(start) || URL_START.test(start)) return line;
      return `${RLM}${line}`;
    })
    .join('\n');
}
