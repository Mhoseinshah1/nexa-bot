import { applyRtlMarks } from '@nexa/i18n';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * The text a customer's client receives for a catalogue body that has no variables: its icon
 * markers drawn as their fallback emoji, and — B2 — the RIGHT-TO-LEFT MARK in front of every
 * Persian line that would otherwise start left-aligned. For tests that compare a sent message
 * with a catalogue sentence.
 */
export const customerText = (body: string): string => applyRtlMarks(appearanceFallbackText(body));

/**
 * A customer message without the RIGHT-TO-LEFT MARKs the renderer puts at the start of Persian
 * lines (B2). For golden-text tests that pin a message's WORDING; the marks themselves are
 * pinned by `tests/unit/rtl-marks.test.ts` and by the integration tests that name them.
 */
export const withoutRtlMarks = (text: string): string => text.replace(/‏/gu, '');

/**
 * A recorded Telegram request body with the RIGHT-TO-LEFT MARKs taken out of its `text` and
 * `caption` (B2), for the suites whose subject is a flow and whose assertions pin wording.
 */
export const bodyWithoutRtlMarks = (body: Record<string, unknown>): Record<string, unknown> => {
  for (const field of ['text', 'caption'] as const) {
    const value = body[field];
    if (typeof value === 'string') body[field] = withoutRtlMarks(value);
  }
  return body;
};
