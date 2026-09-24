import { faqNumberMarker } from '@nexa/contracts';

/** What the composer needs rendered: the three frozen keys, already resolved for the tenant. */
export interface RenderedFaqParts {
  readonly heading: string;
  readonly footer: string;
  /** `bot.faq.item` for one entry: the position marker, the question, the answer. */
  readonly item: (number: string, question: string, answer: string) => string;
}

/** Items are separated by a blank line, as the legacy screen separates them. */
const ITEM_SEPARATOR = '\n\n';

/**
 * The FAQ screen as message parts.
 *
 * Pure: the caller renders the templates and this decides only the SPLIT. The rules:
 *
 * - the heading opens the first part, the footer closes the last, and every entry is
 *   rendered through `bot.faq.item` with `faqNumberMarker(position)` — 1️⃣ to 🔟, then
 *   `11.`;
 * - a part never exceeds `max`, and the split is at item boundaries ONLY: an entry is
 *   never cut in the middle of its answer, because half an answer reads as the whole
 *   answer;
 * - an entry that alone exceeds `max` is its own part, whole. Truncating it would send
 *   the customer a sentence that stops, and the operator's editor already bounds a
 *   question at 300 and an answer at 2 000, so the case is a tenant override of
 *   `bot.faq.item` and not an ordinary row.
 *
 * Nothing is lost: the concatenation of the parts contains every question and every
 * answer, which `tests/unit/faq-screen.test.ts` asserts directly.
 */
export function composeFaqScreen(
  faqs: readonly { readonly question: string; readonly answer: string }[],
  rendered: RenderedFaqParts,
  max: number,
): string[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('a message bound is a positive integer');
  }

  const parts: string[] = [];
  let current = rendered.heading;

  const flush = () => {
    if (current.length > 0) parts.push(current);
    current = '';
  };

  faqs.forEach((faq, index) => {
    const entry = rendered.item(faqNumberMarker(index + 1), faq.question, faq.answer);
    const candidate = current.length === 0 ? entry : `${current}${ITEM_SEPARATOR}${entry}`;
    if (candidate.length <= max || current.length === 0) {
      // Fits, or nothing precedes it in this part — an oversize entry is then its own
      // part rather than a truncated one.
      current = candidate;
      return;
    }
    flush();
    current = entry;
  });

  const withFooter =
    current.length === 0 ? rendered.footer : `${current}${ITEM_SEPARATOR}${rendered.footer}`;
  if (withFooter.length <= max || current.length === 0) {
    current = withFooter;
  } else {
    flush();
    current = rendered.footer;
  }
  flush();

  return parts;
}
