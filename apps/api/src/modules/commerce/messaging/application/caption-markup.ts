import { TELEGRAM_CAPTION_MAX } from './message-split.js';

/**
 * Round N (F2): a provider's ready-made caption, shown as the provider wrote it.
 *
 * RickPanel's `/files` answer carries a `caption` per file written for Telegram's HTML parse
 * mode — the real panel's captions arrived with `<code>` around the values
 * (`docs/r3-service-card-audit.md` §1). Sent as plain text the customer read the raw tags;
 * sent with `parse_mode: HTML` a single stray `<` or an unbalanced tag from somebody else's
 * machine turns the whole send — every file of the group — into a 400.
 *
 * So the caption is never handed to Telegram's HTML parser. It is read HERE, by a closed
 * grammar, into the text a customer sees plus Telegram `MessageEntity` ranges for the
 * formatting it asked for, and sent as plain text with `caption_entities`:
 *
 * - the Telegram HTML tags that carry no attribute become entities — bold, italic,
 *   underline, strikethrough, spoiler, code, pre and blockquote — and every other tag
 *   Telegram's HTML mode knows (`<a href>`, `<tg-emoji>`, …) is dropped with its text kept:
 *   a provider's link or custom emoji is not something this installation vouches for;
 * - anything that is not one of those tags is TEXT, character for character — a `<3` or a
 *   `a < b` reads as written;
 * - the five named entities Telegram's HTML mode decodes (`&lt; &gt; &amp; &quot;` and
 *   numeric `&#…;`) are decoded; any other `&` is text;
 * - a closing tag with no open partner is dropped, an unclosed one ends at the text's end,
 *   and inside `code` / `pre` no further formatting is opened (Telegram forbids it).
 *
 * Offsets and lengths are UTF-16 code units, which is what Telegram counts and what a
 * JavaScript string indexes. Pure and total: any string in, a caption out.
 */

export const CAPTION_ENTITY_TYPES = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'code',
  'pre',
  'blockquote',
] as const;
export type CaptionEntityType = (typeof CAPTION_ENTITY_TYPES)[number];

/** One Telegram `MessageEntity`, in UTF-16 code units. */
export interface CaptionEntity {
  readonly type: CaptionEntityType;
  readonly offset: number;
  readonly length: number;
}

export interface CaptionMarkup {
  readonly text: string;
  readonly entities: readonly CaptionEntity[];
}

/** The attribute-free Telegram HTML tags, and the entity each one is. */
const FORMATTING_TAGS: Readonly<Record<string, CaptionEntityType>> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strikethrough',
  strike: 'strikethrough',
  del: 'strikethrough',
  'tg-spoiler': 'spoiler',
  code: 'code',
  pre: 'pre',
  blockquote: 'blockquote',
};

/**
 * Telegram HTML tags whose meaning this installation does not pass on: the tag goes, its
 * text stays. `span` is only Telegram's spoiler spelling (`class="tg-spoiler"`), and is
 * dropped with the rest rather than read for its attribute.
 */
const DROPPED_TAGS: ReadonlySet<string> = new Set(['a', 'span', 'tg-emoji', 'tg-time']);

/** One tag, as Telegram's HTML mode spells it: a name, optional attributes, nothing more. */
const TAG = /^<(\/?)([a-z][a-z0-9-]*)(\s[^<>]*)?>/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
};
const ENTITY = /^&(?:(lt|gt|amp|quot)|#(\d{1,7})|#x([0-9a-f]{1,6}));/i;

interface OpenTag {
  readonly name: string;
  readonly type: CaptionEntityType;
  readonly offset: number;
}

function isCodeLike(type: CaptionEntityType): boolean {
  return type === 'code' || type === 'pre';
}

/** A decoded numeric reference, or null for one that names no character JavaScript can hold. */
function codePointText(value: number): string | null {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

export function parseCaptionMarkup(raw: string): CaptionMarkup {
  let text = '';
  const entities: CaptionEntity[] = [];
  const open: OpenTag[] = [];
  let index = 0;

  const close = (at: number): void => {
    const tag = open[at];
    if (tag === undefined) return;
    // Every tag opened after it closes with it: Telegram entities nest, they do not overlap.
    for (let inner = open.length - 1; inner >= at; inner -= 1) {
      const current = open[inner] as OpenTag;
      const length = text.length - current.offset;
      if (length > 0) entities.push({ type: current.type, offset: current.offset, length });
    }
    open.length = at;
  };

  while (index < raw.length) {
    const rest = raw.slice(index);
    const char = raw[index] as string;
    if (char === '<') {
      const match = TAG.exec(rest);
      if (match !== null) {
        const closing = match[1] === '/';
        const name = (match[2] as string).toLowerCase();
        const hasAttributes = match[3] !== undefined && match[3].trim().length > 0;
        const type = FORMATTING_TAGS[name];
        if (type !== undefined || DROPPED_TAGS.has(name)) {
          index += match[0].length;
          if (type === undefined) continue;
          if (closing) {
            // The innermost open tag of this name; a stray closing tag is dropped.
            for (let at = open.length - 1; at >= 0; at -= 1) {
              if ((open[at] as OpenTag).name === name) {
                close(at);
                break;
              }
            }
            continue;
          }
          // `<pre>` may carry a language attribute and `<blockquote>` `expandable`; the
          // formatting is kept, the attribute is not read. Any other tag with attributes
          // is not a Telegram formatting tag: its text stays, its markup goes.
          if (hasAttributes && name !== 'pre' && name !== 'blockquote') continue;
          // Nothing opens inside code or pre, which Telegram refuses.
          if (open.some((tag) => isCodeLike(tag.type))) continue;
          open.push({ name, type, offset: text.length });
          continue;
        }
      }
    } else if (char === '&') {
      const match = ENTITY.exec(rest);
      if (match !== null) {
        const decoded =
          match[1] !== undefined
            ? (NAMED_ENTITIES[match[1].toLowerCase()] ?? null)
            : codePointText(
                match[2] !== undefined ? Number(match[2]) : Number.parseInt(match[3] ?? '', 16),
              );
        if (decoded !== null) {
          text += decoded;
          index += match[0].length;
          continue;
        }
      }
    }
    // A surrogate pair travels whole: half an emoji is a malformed string.
    const code = raw.charCodeAt(index);
    const width = code >= 0xd800 && code <= 0xdbff && index + 1 < raw.length ? 2 : 1;
    text += raw.slice(index, index + width);
    index += width;
  }
  close(0);

  return trimmed(text, entities);
}

/**
 * The text without leading or trailing whitespace, and the entities moved and clipped to
 * match. A caption that was only markup is the empty caption.
 */
function trimmed(text: string, entities: readonly CaptionEntity[]): CaptionMarkup {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (end <= start) return { text: '', entities: [] };
  return { text: text.slice(start, end), entities: clipEntities(entities, start, end) };
}

/** The entities that fall inside `[start, end)`, re-based on `start`, clipped at both ends. */
export function clipEntities(
  entities: readonly CaptionEntity[],
  start: number,
  end: number,
): CaptionEntity[] {
  const clipped: CaptionEntity[] = [];
  for (const entity of entities) {
    const from = Math.max(entity.offset, start);
    const to = Math.min(entity.offset + entity.length, end);
    if (to > from) clipped.push({ type: entity.type, offset: from - start, length: to - from });
  }
  // Telegram wants them ordered by offset; an outer entity before the inner one it holds.
  return clipped.sort((a, b) => a.offset - b.offset || b.length - a.length);
}

/**
 * A rendered caption and its entities, within Telegram's caption bound.
 *
 * `value` is the provider text the entities are relative to, and `rendered` the tenant's
 * template with that text inside it. The entities are placed only when the value occurs in
 * the rendered caption EXACTLY ONCE — then that occurrence is the substituted one, whatever
 * else the operator wrote around it; otherwise they are dropped and the text goes plain,
 * which is never wrong, only unformatted.
 *
 * Over the bound, the caption is cut with a visible ellipsis (never inside a surrogate
 * pair) and every entity is clipped to what is left — Telegram refuses an entity that runs
 * past the text.
 */
export function placeCaptionEntities(
  rendered: string,
  value: string,
  entities: readonly CaptionEntity[],
): { readonly caption: string; readonly entities: readonly CaptionEntity[] } {
  let placed: CaptionEntity[] = [];
  if (entities.length > 0 && value.length > 0) {
    const first = rendered.indexOf(value);
    const unique = first !== -1 && rendered.indexOf(value, first + 1) === -1;
    if (unique) {
      placed = entities.map((entity) => ({ ...entity, offset: entity.offset + first }));
    }
  }
  if (rendered.length <= TELEGRAM_CAPTION_MAX) return { caption: rendered, entities: placed };
  let cut = TELEGRAM_CAPTION_MAX - 1;
  const last = rendered.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { caption: `${rendered.slice(0, cut)}…`, entities: clipEntities(placed, 0, cut) };
}
