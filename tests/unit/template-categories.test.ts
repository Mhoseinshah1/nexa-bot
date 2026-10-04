import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_PREFIXES,
  TEMPLATE_KEYS,
  isTemplateCategory,
  templateCategoryOf,
  type TemplateCategory,
} from '@nexa/contracts';

/**
 * UX Batch 01, item 5: every catalogue key belongs to exactly one domain category, and a key
 * nothing claims fails here rather than drifting into a catch-all on the «متن‌ها» screen.
 */
describe('template categories', () => {
  it('maps every catalogue key to a category', () => {
    const unmapped = TEMPLATE_KEYS.filter((key) => templateCategoryOf(key) === null);
    expect(unmapped, 'claim these keys in TEMPLATE_CATEGORY_PREFIXES').toEqual([]);
  });

  it('never declares one prefix twice, so the longest match is never a tie', () => {
    const seen = new Map<string, TemplateCategory>();
    const duplicated: string[] = [];
    for (const category of TEMPLATE_CATEGORIES) {
      for (const prefix of TEMPLATE_CATEGORY_PREFIXES[category]) {
        const before = seen.get(prefix);
        if (before !== undefined) duplicated.push(`${prefix}: ${before} and ${category}`);
        seen.set(prefix, category);
      }
    }
    expect(duplicated).toEqual([]);
  });

  it('gives each key exactly one category: the single longest matching prefix', () => {
    const ambiguous: string[] = [];
    for (const key of TEMPLATE_KEYS) {
      const lengths = TEMPLATE_CATEGORIES.map((category) =>
        Math.max(
          0,
          ...TEMPLATE_CATEGORY_PREFIXES[category]
            .filter((prefix) => key.startsWith(prefix))
            .map((prefix) => prefix.length),
        ),
      );
      const longest = Math.max(...lengths);
      if (longest === 0 || lengths.filter((length) => length === longest).length !== 1) {
        ambiguous.push(key);
      }
    }
    expect(ambiguous).toEqual([]);
  });

  it('leaves no category empty, so every one the screen offers has texts in it', () => {
    const counts = new Map<TemplateCategory, number>();
    for (const key of TEMPLATE_KEYS) {
      const category = templateCategoryOf(key);
      if (category !== null) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    expect(TEMPLATE_CATEGORIES.filter((category) => !counts.has(category))).toEqual([]);
  });

  it('files the owner-named domains where an operator looks for them', () => {
    expect(templateCategoryOf('bot.start.welcome')).toBe('general');
    expect(templateCategoryOf('bot.order.preinvoice')).toBe('purchase');
    expect(templateCategoryOf('bot.payment.receipt_prompt')).toBe('payment');
    expect(templateCategoryOf('bot.payment.gateway_invoice')).toBe('payment');
    expect(templateCategoryOf('bot.wallet.balance')).toBe('wallet');
    expect(templateCategoryOf('bot.service.card')).toBe('services');
    expect(templateCategoryOf('bot.service.renew_button')).toBe('service_changes');
    expect(templateCategoryOf('bot.service.renewed')).toBe('service_changes');
    expect(templateCategoryOf('bot.service.add_traffic_button')).toBe('service_changes');
    expect(templateCategoryOf('bot.service.add_time_button')).toBe('service_changes');
    expect(templateCategoryOf('error.internal')).toBe('errors');
    expect(templateCategoryOf('bot.ticket.new_button')).toBe('support');
    expect(templateCategoryOf('bot.service.expiry_first')).toBe('notifications');
    expect(templateCategoryOf('bot.wallet.low_balance')).toBe('notifications');
    expect(templateCategoryOf('bot.referral.share_button')).toBe('referral');
    expect(templateCategoryOf('bot.terms.accept_button')).toBe('terms');
    expect(templateCategoryOf('bot.tutorial.android_button')).toBe('tutorials');
    expect(templateCategoryOf('bot.menu.admin')).toBe('admin');
    expect(templateCategoryOf('ops.financial.order_paid')).toBe('operations');
  });

  it('answers null for a key no category claims, rather than guessing', () => {
    expect(templateCategoryOf('something.new')).toBeNull();
    expect(isTemplateCategory('payment')).toBe(true);
    expect(isTemplateCategory('other')).toBe(false);
  });
});
