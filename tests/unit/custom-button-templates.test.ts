import { describe, expect, it } from 'vitest';
import {
  INLINE_BUTTONS,
  TEMPLATE_KEYS,
  templateCategoryOf,
  templateDefinition,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';

/**
 * R10 D2 — the five templates an owner-defined main-menu button answers with, and the one
 * inline button under a link answer. The operator's text is a VALUE of a PLAIN_TEXT key, never
 * part of the template, so no markup the operator typed is interpreted.
 */

const KEYS = [
  'bot.custom_button.text',
  'bot.custom_button.caption',
  'bot.custom_button.link',
  'bot.custom_button.open_link_button',
  'bot.custom_button.unavailable',
] as const satisfies readonly TemplateKey[];

const render = (key: (typeof KEYS)[number], values: Record<string, string>) =>
  renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values, 'fa');

describe('the custom-button templates', () => {
  it('are declared, Persian, plain text and in the general category', () => {
    for (const key of KEYS) {
      expect(TEMPLATE_KEYS).toContain(key);
      expect(templateDefinition(key).format, key).toBe('PLAIN_TEXT');
      expect(CATALOGUE_FA[key].length, key).toBeGreaterThan(0);
      expect(templateCategoryOf(key), key).toBe('general');
    }
  });

  it('carry the operator’s words verbatim, markup and placeholders included', () => {
    const typed = '<b>not html</b> {firstName} *x* _y_';
    expect(render('bot.custom_button.text', { text: typed })).toBe(typed);
    expect(render('bot.custom_button.caption', { caption: typed })).toBe(typed);
    expect(render('bot.custom_button.link', { text: typed })).toContain(typed);
  });

  it('drop the note line of a link answer when the operator wrote none', () => {
    const bare = render('bot.custom_button.link', {});
    expect(bare).not.toContain('{text}');
    // The fixed sentence stays; only the note's own line goes.
    expect(bare).toContain('دکمهٔ زیر را بزنید');
    expect(bare.trim().split('\n')).toHaveLength(1);
    expect(render('bot.custom_button.link', { text: 'کانال ما' })).toContain('کانال ما');
  });

  it('label the one inline button under a link answer, as a URL button', () => {
    const open = INLINE_BUTTONS.find((one) => one.key === 'custom.link_open');
    expect(open?.label).toBe('bot.custom_button.open_link_button');
    expect(open?.action).toBe('URL');
  });
});
