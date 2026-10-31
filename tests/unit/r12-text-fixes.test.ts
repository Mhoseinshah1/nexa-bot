import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';

/**
 * R12 F3 item 6: customer texts that NAME the wrong button, or are factually wrong. Each case
 * derives the right name from the catalogue (the button's own label), so renaming a button
 * without the sentence that points at it fails here.
 */
const text = (key: keyof typeof CATALOGUE_FA): string => CATALOGUE_FA[key];

describe('R12 F3 item 6: texts that name wrong buttons or are wrong', () => {
  it('the manual payment instruction names the real receipt button', () => {
    const body = text('bot.payment.manual_instructions');
    expect(body).toContain(`«${text('bot.payment.sent_button')}»`);
    expect(body).not.toContain('پرداخت را انجام دادم');
  });

  it('the default welcome names no brand and no button the menu may not draw', () => {
    const body = text('bot.start.welcome');
    expect(body).not.toMatch(/ZED/iu);
    expect(body).not.toContain('━');
    // The buy button it names is the main menu's own label; the trial one is not promised.
    expect(body).toContain(`«${text('bot.menu.catalog')}»`);
    expect(body).not.toContain('سرویس تست');
    expect(body).not.toContain('«🧪');
  });

  it('the FAQ default points at the real apps and tutorial button', () => {
    expect(text('bot.faq.default_6_answer')).toContain(`«${text('bot.menu.apps')}»`);
    expect(text('bot.faq.default_6_answer')).not.toContain('📚 آموزش»');
  });

  it('the refund notice names no command', () => {
    const body = text('bot.refund.completed');
    expect(body).not.toContain('/wallet');
    expect(body).toContain('کیف پول');
  });

  it('both delivery cards: the connection sentence is whole and spelled with its half-spaces', () => {
    for (const key of ['bot.service.delivered', 'bot.service.delivered_files_only'] as const) {
      const body = text(key);
      expect(body, key).not.toContain('میتوانید');
      expect(body, key).toContain('می‌توانید');
      // The sentence used to break after «و» with a hard newline.
      expect(body, key).not.toMatch(/ و\n/u);
      expect(body, key).toContain('سیستم‌عامل');
    }
  });

  it('the customer-facing percent sign is the Persian one', () => {
    for (const [key, body] of Object.entries(CATALOGUE_FA)) {
      if (!key.startsWith('bot.')) continue;
      // Placeholders and tenant-facing comments aside, a literal ASCII % in customer copy.
      expect(body.replaceAll(/\{[^}]*\}/gu, ''), key).not.toContain('%');
    }
    expect(text('bot.service.remaining_value')).toBe('{bytes} ({percent}٪)');
  });

  it('the search label carries its ezafe', () => {
    expect(text('bot.service.search_label_button')).toBe('جستجوی نام کاربری');
  });
});
