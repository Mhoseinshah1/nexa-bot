import type { PlaceholderType, TemplateKey } from '@nexa/contracts';
import {
  PLACEHOLDER_LABEL_OVERRIDES_FA,
  PLACEHOLDER_LABELS_FA,
  PLACEHOLDER_TYPE_LABELS_FA,
  TEMPLATE_COPY_FA,
  TEMPLATE_GROUPS_FA,
  TEMPLATE_OTHER_GROUP_FA,
  type TemplateGroupDefinition,
} from './i18n/templates.fa';

/**
 * How the template screen names, explains and groups a message.
 *
 * The data is in `i18n/templates.fa.ts`; this is the lookup over it, and the only place
 * that decides what happens when an entry is missing. Every lookup DEGRADES rather than
 * throws: a key another package registered without a Persian entry is titled with its
 * raw key and described with its catalogue description, and a token with no label shows
 * the placeholder's catalogue description. A screen that crashed on a missing label would
 * take the whole editor away from an operator because somebody forgot a translation.
 */

export interface TemplatePresentationCopy {
  readonly name: string;
  readonly description: string;
  /** False when the registry has no entry and the fallback is showing. */
  readonly localized: boolean;
}

/** Lookups take a plain string: the server may send a key this build does not know. */
function entryFor<T>(table: Partial<Record<TemplateKey, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? (table as Record<string, T>)[key]
    : undefined;
}

export function templateCopy(key: string, fallbackDescription: string): TemplatePresentationCopy {
  const entry = entryFor(TEMPLATE_COPY_FA, key);
  if (entry === undefined) return { name: key, description: fallbackDescription, localized: false };
  return { name: entry[0], description: entry[1], localized: true };
}

/**
 * The Persian helper shown beside `{token}` in one template.
 *
 * The per-template override first, then the token's general label, then the
 * placeholder's own catalogue description. The token itself is never changed.
 */
export function placeholderLabel(
  templateKey: string,
  token: string,
  fallbackDescription: string,
): string {
  const override = entryFor(PLACEHOLDER_LABEL_OVERRIDES_FA, templateKey);
  if (override !== undefined && Object.prototype.hasOwnProperty.call(override, token)) {
    return override[token] as string;
  }
  if (Object.prototype.hasOwnProperty.call(PLACEHOLDER_LABELS_FA, token)) {
    return PLACEHOLDER_LABELS_FA[token] as string;
  }
  return fallbackDescription;
}

export function placeholderTypeLabel(type: PlaceholderType): string {
  return PLACEHOLDER_TYPE_LABELS_FA[type];
}

export type TemplateGroup = TemplateGroupDefinition;

/** Every section the screen can show, in screen order, the catch-all last. */
export const TEMPLATE_GROUPS: readonly TemplateGroup[] = [
  ...TEMPLATE_GROUPS_FA,
  TEMPLATE_OTHER_GROUP_FA,
];

/**
 * The section a key belongs to: the group with the LONGEST matching prefix.
 *
 * Longest rather than first, so `bot.service.transfer_prompt` lands in the transfer
 * section although `bot.service.` also matches it, whatever order the groups are listed
 * in. A key no prefix matches goes to the catch-all rather than disappearing.
 */
export function templateGroupOf(key: string): TemplateGroup {
  let best: TemplateGroup = TEMPLATE_OTHER_GROUP_FA;
  let bestLength = 0;
  for (const group of TEMPLATE_GROUPS_FA) {
    for (const prefix of group.prefixes) {
      if (prefix.length > bestLength && key.startsWith(prefix)) {
        best = group;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Text as a search compares it.
 *
 * Persian is typed on keyboards that emit the ARABIC yeh and kaf as often as the Persian
 * ones, and the zero-width non-joiner is present or absent at the typist's whim — so
 * «پیش‌فاکتور» typed as «پیش فاکتور» or «پيشفاكتور» must still find the card. Diacritics
 * and the tatweel are dropped for the same reason, digits compare the same in either
 * script, and Latin is case-folded so a raw key
 * is found however it is typed. Written with escapes because a surface file may not carry
 * Persian literals (`scripts/check-i18n-keys.mjs`).
 */
export function normalizeSearchText(text: string): string {
  return (
    text
      .toLowerCase()
      // Arabic yeh and alef maksura to Persian yeh; Arabic kaf to Persian kaf.
      .replace(/[\u064A\u0649]/g, '\u06CC')
      .replace(/\u0643/g, '\u06A9')
      // Teh marbuta and heh-with-yeh-above to heh, so a heh with or without the hamza compares equal.
      .replace(/[\u0629\u06C0]/g, '\u0647')
      // Harakat (the hamza above included) and the tatweel.
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      // Persian and Arabic-Indic digits to Latin ones, so either script finds the other.
      .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
      .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
      // Every kind of space, including the zero-width non-joiner, and the joiner.
      // An alternation rather than a class: a joiner inside a class reads as joining its
      // neighbours (ESLint's no-misleading-character-class). \s already covers U+00A0.
      .replace(/(?:\s|\u200C|\u200D)+/g, '')
  );
}

/**
 * Whether one template matches what the operator typed.
 *
 * Every whitespace-separated word must appear somewhere in the Persian name, the Persian
 * description, the raw key or the message body; an empty query matches everything.
 * Searching the BODY is what lets an operator paste a sentence they saw in the bot and
 * land on the message that sent it.
 */
export function matchesTemplateSearch(query: string, haystack: readonly string[]): boolean {
  const words = query
    .split(/\s+/)
    .map(normalizeSearchText)
    .filter((word) => word !== '');
  if (words.length === 0) return true;
  const text = haystack.map(normalizeSearchText).join('\n');
  return words.every((word) => text.includes(word));
}
