import { describe, expect, it } from 'vitest';
import { faqNumberMarker } from '@nexa/contracts';
import {
  composeFaqScreen,
  type RenderedFaqParts,
} from '../../apps/api/src/modules/control/support/application/faq-screen';

/**
 * The FAQ screen composer (customer UX completion §J), on its own.
 *
 * The rules a customer would notice broken: the numbering runs 1️⃣…🔟 then `11.`, the
 * entries keep the operator's order, a long FAQ is split ONLY between entries, the
 * footer is on the last part, and nothing the operator wrote is lost on the way.
 */

const rendered: RenderedFaqParts = {
  heading: 'HEADING',
  footer: 'FOOTER',
  item: (number, question, answer) => `${number} ${question}\n\n✅ ${answer}`,
};

const faq = (n: number, size = 1) => ({
  question: `Q${String(n)}`.padEnd(size, 'q'),
  answer: `A${String(n)}`.padEnd(size, 'a'),
});

describe('composeFaqScreen', () => {
  it('numbers entries with keycaps to ten and plain figures afterwards, in order', () => {
    const faqs = Array.from({ length: 12 }, (_, index) => faq(index + 1));
    const [part] = composeFaqScreen(faqs, rendered, 4096);
    expect(part).toBeDefined();
    const text = part as string;

    expect(text.startsWith('HEADING\n\n1️⃣ Q1')).toBe(true);
    expect(text.endsWith('\n\nFOOTER')).toBe(true);
    expect(text).toContain('🔟 Q10');
    expect(text).toContain('11. Q11');
    expect(text).toContain('12. Q12');
    // Order is the caller's, not re-sorted here.
    expect(text.indexOf('Q3')).toBeLessThan(text.indexOf('Q4'));
    expect(text.indexOf('Q11')).toBeLessThan(text.indexOf('Q12'));
  });

  it('renders heading and footer alone for an empty FAQ', () => {
    expect(composeFaqScreen([], rendered, 4096)).toEqual(['HEADING\n\nFOOTER']);
  });

  it('splits only at item boundaries, keeps the footer on the last part, and loses nothing', () => {
    // Each entry is about 1 200 characters, so three fit a 4 096 part and the fourth does not.
    const faqs = Array.from({ length: 7 }, (_, index) => faq(index + 1, 600));
    const parts = composeFaqScreen(faqs, rendered, 4096);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);

    // Every part starts at an entry boundary (or the heading) and no entry is cut: the
    // marker of every entry appears exactly once, at the start of a line.
    const joined = parts.join('\n');
    for (const [index, entry] of faqs.entries()) {
      const marker = faqNumberMarker(index + 1);
      expect(joined).toContain(`${marker} ${entry.question}\n\n✅ ${entry.answer}`);
      expect(joined.split(`${marker} `).length).toBe(2);
    }

    expect(parts[0]?.startsWith('HEADING')).toBe(true);
    expect(parts.at(-1)?.endsWith('FOOTER')).toBe(true);
    // The footer is on the LAST part only.
    expect(parts.filter((part) => part.includes('FOOTER'))).toHaveLength(1);
  });

  it('gives an entry that alone exceeds the bound its own part, whole, never truncated', () => {
    const oversize = faq(2, 3000); // ~6 000 characters as an item
    const faqs = [faq(1), oversize, faq(3)];
    const parts = composeFaqScreen(faqs, rendered, 4096);

    const own = parts.find((part) => part.includes(oversize.question));
    expect(own).toBeDefined();
    expect(own).toContain(oversize.answer);
    expect(own).toBe(rendered.item('2️⃣', oversize.question, oversize.answer));
    // Its neighbours are still there, on either side.
    expect(parts.join('\n')).toContain('1️⃣ Q1');
    expect(parts.join('\n')).toContain('3️⃣ Q3');
    expect(parts.at(-1)?.endsWith('FOOTER')).toBe(true);
  });

  it('moves the footer to its own part when the last entry leaves no room', () => {
    const max = 40;
    const parts = composeFaqScreen([faq(1, 12)], { ...rendered, heading: 'H' }, max);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(max);
    expect(parts.at(-1)).toBe('FOOTER');
  });

  it('refuses a bound that is not a positive integer', () => {
    expect(() => composeFaqScreen([], rendered, 0)).toThrow();
    expect(() => composeFaqScreen([], rendered, 1.5)).toThrow();
  });
});
