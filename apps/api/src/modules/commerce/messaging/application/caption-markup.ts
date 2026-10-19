import type { TemplateValues } from '@nexa/contracts';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';

/**
 * The caption grammar's SHAPES, and the port the application layer reads captions through.
 *
 * The grammar itself — `parseCaptionMarkup`, which reads a provider's or an operator's
 * Telegram-HTML caption by a closed grammar into text plus entities, never handing it to
 * Telegram's HTML parser — and the connection-file caption renderer live in `@nexa/i18n`
 * since Track 3 §2, so the Web Admin's preview and the bot share one implementation. An
 * application file may not import that package (`check-boundaries.sh`), so it asks
 * `CaptionText`; `messaging/infrastructure/caption-markup.ts` implements it and
 * `container.ts` binds it. These declarations are structurally identical to `@nexa/i18n`'s.
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

export interface CaptionText {
  /** A provider's caption, read by the closed grammar into text and entities. */
  parse(raw: string): CaptionMarkup;
  /**
   * One connection-file caption from a RAW template body: values HTML-escaped, the closed
   * grammar, Telegram's 1024-unit bound (truncated with an ellipsis). Empty means none.
   */
  renderConnectionFileCaption(
    body: string,
    values: TemplateValues,
    presentation: TemplatePresentation,
  ): CaptionMarkup;
  /** An instant's calendar date in the Jalali calendar and the given zone: `1405/07/28`. */
  jalaliDate(date: Date, timezone: string): string;
}
