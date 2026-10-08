import { describe, expect, it } from 'vitest';
import { RECEIPT_CAPTURE_MINUTES } from '@nexa/contracts';
import { CatalogueTranslator } from '@nexa/i18n';
import {
  receiptWindowExpiry,
  receiptWindowMinutes,
} from '../../apps/api/src/modules/commerce/payments/application/payment.service';

/**
 * Roadmap E6 — the receipt window and the sentence that states it.
 *
 * The customer is told «تا {minutes} دقیقه فرصت دارید», and the window closes at the sooner
 * of thirty minutes and the payment's own deadline. What this file defends: thirty minutes
 * is said as thirty, a shorter deadline is said as what is left of it (rounded UP, never to
 * zero), and no window is promised for a payment already past its deadline — so the number
 * in the sentence and the deadline the server enforces cannot disagree.
 */

const NOW = new Date('2026-10-07T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('the receipt window', () => {
  it('is thirty minutes, said as thirty, when the payment has longer or no deadline', () => {
    expect(RECEIPT_CAPTURE_MINUTES).toBe(30);
    for (const deadline of [null, at(60 * 60_000), at(30 * 60_000 + 1)]) {
      const closes = receiptWindowExpiry(NOW, deadline);
      expect(closes?.toISOString()).toBe(at(30 * 60_000).toISOString());
      expect(receiptWindowMinutes(closes as Date, NOW)).toBe(30);
    }
  });

  it('closes with the payment when the payment’s deadline is sooner, and says what is left', () => {
    const closes = receiptWindowExpiry(NOW, at(12 * 60_000));
    expect(closes?.toISOString()).toBe(at(12 * 60_000).toISOString());
    expect(receiptWindowMinutes(closes as Date, NOW)).toBe(12);
  });

  it('rounds a part-minute UP, so the customer is never told less than they have', () => {
    expect(receiptWindowMinutes(at(12 * 60_000 + 1_000), NOW)).toBe(13);
    expect(receiptWindowMinutes(at(29 * 60_000 + 59_999), NOW)).toBe(30);
    // Never a truthful but useless zero.
    expect(receiptWindowMinutes(at(10_000), NOW)).toBe(1);
  });

  it('promises no window for a payment already at or past its deadline', () => {
    expect(receiptWindowExpiry(NOW, NOW)).toBeNull();
    expect(receiptWindowExpiry(NOW, at(-1))).toBeNull();
  });

  it('renders the prompt with the minutes the server computed, and asks for an image', () => {
    const fa = new CatalogueTranslator('fa');
    const text = fa.translate('bot.payment.receipt_prompt', { minutes: 30 });
    expect(text).toMatch(/(30|۳۰) دقیقه/u);
    expect(text).toContain('تصویر رسید');
    expect(text).not.toContain('{minutes}');
  });
});
