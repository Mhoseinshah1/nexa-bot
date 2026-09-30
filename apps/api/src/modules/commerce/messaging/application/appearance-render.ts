import {
  APPEARANCE_MARKER_EXPRESSION_SOURCE,
  APPEARANCE_SLOT_FALLBACKS,
  isAppearanceSlot,
  type AppearanceSlot,
  type TemplateFormat,
} from '@nexa/contracts';

/**
 * Premium UI — the ONE place an appearance marker becomes something Telegram draws
 * (`docs/premium-ui-audit.md` §4).
 *
 * A rendered body arrives with its `{icon:<slot>}` markers intact: the template renderer
 * substitutes declared `{token}`s and leaves a braced expression with a colon exactly as
 * written. This function turns each marker into the slot's fallback emoji and, where the
 * caller's decoration names a custom emoji for the slot, covers that emoji with a
 * Telegram `custom_emoji` entity — offsets and lengths in UTF-16 code units, which is what
 * the Bot API counts ("Offset in UTF-16 code units to the start of the entity", "Length of
 * the entity in UTF-16 code units") and what a JavaScript string indexes.
 *
 * Two wire encodings, one function, because Telegram has two and a template's format
 * decides which one its body is in (`TemplateDefinition.format`):
 *
 *  - `PLAIN_TEXT`: the text plus `entities`, "which can be specified instead of
 *    parse_mode" (sendMessage, editMessageText, and `caption_entities` for a caption);
 *  - `TELEGRAM_HTML`: the Bot API's own tag, `<tg-emoji emoji-id="…">👍</tg-emoji>`, in
 *    the body Telegram parses, since `parse_mode` and `entities` are alternatives and an
 *    HTML body cannot carry the second. "A valid emoji must be used as the content of the
 *    tg-emoji tag" — the fallback is that content.
 *
 * Both carry the fallback emoji as the covered text, as the docs require: "The emoji will
 * be shown instead of the custom emoji in places where a custom emoji cannot be displayed
 * (e.g., system notifications) or if the message is forwarded by a non-premium user."
 *
 * NEVER hand-build an offset anywhere else. A caller that needs decorated text calls this,
 * once, on the whole rendered body, and then cuts or bounds the RESULT with
 * `entitiesWithin` — never the other way round, because a cut before decoration would move
 * every offset after it.
 *
 * Pure and total: any string in, a string and a list out. An unknown slot stays literal —
 * `validateTemplateBody` refuses it before it is stored, and a guess here would hide that
 * refusal's absence.
 */

/** A `custom_emoji` `MessageEntity`, as the Bot API spells it. */
export interface CustomEmojiEntity {
  readonly type: 'custom_emoji';
  readonly offset: number;
  readonly length: number;
  readonly custom_emoji_id: string;
}

/**
 * What a send may decorate with: the custom emoji id per slot, for exactly the slots that
 * are configured, switched on, AND that the sending bot has proved it may use. An empty
 * map is "fallback only", which is what every bot gets until its test says otherwise.
 */
export interface AppearanceDecoration {
  readonly customEmoji: ReadonlyMap<AppearanceSlot, string>;
}

export const NO_DECORATION: AppearanceDecoration = { customEmoji: new Map() };

export interface DecoratedText {
  readonly text: string;
  /** Empty for an HTML body: its custom emoji are `<tg-emoji>` tags inside `text`. */
  readonly entities: readonly CustomEmojiEntity[];
  /** How many markers became a CUSTOM emoji (an entity, or a tag). */
  readonly decorated: number;
}

const MARKER = new RegExp(APPEARANCE_MARKER_EXPRESSION_SOURCE, 'g');

export function decorateAppearance(
  rendered: string,
  format: TemplateFormat,
  decoration: AppearanceDecoration,
): DecoratedText {
  let text = '';
  let decorated = 0;
  const entities: CustomEmojiEntity[] = [];
  let last = 0;
  for (const match of rendered.matchAll(MARKER)) {
    const slot = match[1] as string;
    text += rendered.slice(last, match.index);
    last = match.index + match[0].length;
    if (!isAppearanceSlot(slot)) {
      // Not a slot this release knows: literal, exactly as the renderer left it.
      text += match[0];
      continue;
    }
    const fallback = APPEARANCE_SLOT_FALLBACKS[slot];
    const customEmojiId = decoration.customEmoji.get(slot);
    if (customEmojiId === undefined) {
      text += fallback;
      continue;
    }
    decorated += 1;
    if (format === 'TELEGRAM_HTML') {
      // The id is digits only (`CUSTOM_EMOJI_ID_PATTERN`) and the fallback is an emoji:
      // neither can carry a character Telegram's HTML mode would read as markup.
      text += `<tg-emoji emoji-id="${customEmojiId}">${fallback}</tg-emoji>`;
      continue;
    }
    // The offset is where the fallback STARTS in the output so far, and the length is the
    // fallback's own — `text.length` counts UTF-16 code units, and so does Telegram.
    entities.push({
      type: 'custom_emoji',
      offset: text.length,
      length: fallback.length,
      custom_emoji_id: customEmojiId,
    });
    text += fallback;
  }
  text += rendered.slice(last);
  return { text, entities, decorated };
}

/** The rendered body with every marker as its fallback emoji and nothing decorated. */
export function appearanceFallbackText(rendered: string): string {
  return decorateAppearance(rendered, 'PLAIN_TEXT', NO_DECORATION).text;
}

/**
 * The `<tg-emoji>` tags THIS renderer wrote, undone: each becomes its content again. For
 * the one retry a refused decorated HTML send is allowed — the same text Telegram was
 * given, minus the decoration, and nothing else touched.
 */
export function undoHtmlDecoration(html: string): string {
  return html.replace(/<tg-emoji emoji-id="[0-9]{1,32}">([^<]*)<\/tg-emoji>/g, '$1');
}

/**
 * The entities that lie WHOLLY inside `[start, end)` of the text they were computed on,
 * re-based on `start`. A custom emoji entity is never clipped: it must cover exactly one
 * emoji, and half of one is not that. So a part cut through an emoji (the code-point cut
 * of a very long line can land between `⚠` and its variation selector) drops the entity
 * and keeps the text, which is never wrong — only undecorated.
 */
export function entitiesWithin(
  entities: readonly CustomEmojiEntity[],
  start: number,
  end: number,
): CustomEmojiEntity[] {
  const inside: CustomEmojiEntity[] = [];
  for (const entity of entities) {
    if (entity.offset >= start && entity.offset + entity.length <= end) {
      inside.push({ ...entity, offset: entity.offset - start });
    }
  }
  return inside;
}

/**
 * Where each part of a split body sits in the text it was cut from.
 *
 * `splitMessageBody` returns the parts in order, each an exact substring, dropping only
 * the separators it cut on and parts that were blank; so the first occurrence of each part
 * at or after the previous part's end is its position. A part that cannot be found — which
 * the splitter's contract rules out — yields null, and the caller sends the text plain:
 * an entity at a guessed offset is the one mistake this file exists to make impossible.
 */
export function locateParts(
  text: string,
  parts: readonly string[],
): readonly { readonly start: number; readonly end: number }[] | null {
  const located: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const part of parts) {
    const start = text.indexOf(part, cursor);
    if (start === -1) return null;
    const end = start + part.length;
    located.push({ start, end });
    cursor = end;
  }
  return located;
}
