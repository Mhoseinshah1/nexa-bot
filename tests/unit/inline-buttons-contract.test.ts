import { describe, expect, it } from 'vitest';
import {
  INLINE_BUTTONS,
  INLINE_BUTTON_KEYS,
  INLINE_BUTTON_STYLES,
  MAIN_MENU_BUTTON_STYLES,
  TEMPLATES,
  inlineButtonIconOf,
  inlineButtonIconsSchema,
  inlineButtonStyleOf,
  inlineButtonStylesSchema,
  parseSettingValue,
  settingDefinition,
} from '@nexa/contracts';

/**
 * Owner spec §6: the inline («شیشه‌ای») button registry and its setting.
 */
describe('the inline button registry', () => {
  it('uses exactly the styles Telegram supports, the same closed set as the reply keyboard', () => {
    expect([...INLINE_BUTTON_STYLES]).toEqual(['default', 'primary', 'success', 'danger']);
    expect(INLINE_BUTTON_STYLES).toBe(MAIN_MENU_BUTTON_STYLES);
  });

  it('declares every key once, and every label template exists and belongs to ONE button', () => {
    expect(new Set(INLINE_BUTTON_KEYS).size).toBe(INLINE_BUTTON_KEYS.length);
    const templates = new Set<string>(TEMPLATES.map((entry) => entry.key));
    const labels = INLINE_BUTTONS.map((entry) => entry.label).filter(
      (label): label is NonNullable<typeof label> => label !== null,
    );
    for (const label of labels) expect(templates.has(label), label).toBe(true);
    // Editing one button's label can never relabel another.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never draws an administrator screen, and ships with every style at its default', () => {
    for (const entry of INLINE_BUTTONS) {
      expect(entry.label?.startsWith('bot.admin.') ?? false, entry.key).toBe(false);
      expect(entry.defaultStyle, entry.key).toBe('default');
    }
  });

  it('resolves a style from the tenant value, else the registry default', () => {
    expect(inlineButtonStyleOf('wallet.topup', {})).toBe('default');
    expect(inlineButtonStyleOf('wallet.topup', { 'wallet.topup': 'success' })).toBe('success');
    expect(inlineButtonStyleOf('payment.cancel', { 'wallet.topup': 'success' })).toBe('default');
  });
});

describe('the bot.inline_buttons setting', () => {
  it('defaults to no override and is managed outside the settings page', () => {
    const definition = settingDefinition('bot.inline_buttons');
    expect(definition.defaultValue).toEqual({});
    expect(definition.consumer).toBe('ACTIVE');
  });

  it('accepts a partial map of known keys to Telegram styles', () => {
    expect(
      parseSettingValue('bot.inline_buttons', { 'payment.sent': 'success', main_menu: 'primary' }),
    ).toEqual({ ok: true, value: { 'payment.sent': 'success', main_menu: 'primary' } });
  });

  it('refuses an unknown button, an unknown style and a colour', () => {
    expect(parseSettingValue('bot.inline_buttons', { 'no.such.button': 'primary' }).ok).toBe(false);
    expect(parseSettingValue('bot.inline_buttons', { 'payment.sent': 'green' }).ok).toBe(false);
    expect(inlineButtonStylesSchema.safeParse({ 'payment.sent': '#00ff00' }).success).toBe(false);
  });
});

/**
 * Phase 2 UX wave, Item 3: the optional premium icon per inline button — its own setting,
 * never a field inside `bot.inline_buttons`.
 */
describe('the bot.inline_button_icons setting', () => {
  const ICON = '5368324170671202286';

  it('defaults to no icon, is managed outside the settings page, and is its own key', () => {
    const definition = settingDefinition('bot.inline_button_icons');
    expect(definition.defaultValue).toEqual({});
    expect(definition.consumer).toBe('ACTIVE');
    expect(definition.schema).toBe(inlineButtonIconsSchema);
    // `bot.inline_buttons` is NOT widened: an icon inside it is still refused, so an older
    // release's strict parser never meets a shape it cannot read.
    expect(parseSettingValue('bot.inline_buttons', { 'payment.sent': ICON }).ok).toBe(false);
  });

  it('accepts a partial map of known keys to custom emoji ids, and the empty map', () => {
    expect(
      parseSettingValue('bot.inline_button_icons', { 'payment.sent': ICON, main_menu: '1' }),
    ).toEqual({ ok: true, value: { 'payment.sent': ICON, main_menu: '1' } });
    expect(parseSettingValue('bot.inline_button_icons', {}).ok).toBe(true);
    expect(inlineButtonIconsSchema.safeParse({ 'payment.sent': '9'.repeat(32) }).success).toBe(
      true,
    );
  });

  it('refuses an unknown button and anything that is not a bounded string of digits', () => {
    const refused = (value: unknown) =>
      parseSettingValue('bot.inline_button_icons', { 'payment.sent': value }).ok;
    expect(parseSettingValue('bot.inline_button_icons', { 'no.such.button': ICON }).ok).toBe(false);
    for (const bad of [
      '',
      ' 5368324170671202286',
      '5368324170671202286 ',
      '-5368324170671202286',
      '5368324170671202286a',
      '0x1f600',
      '1e9',
      '💰',
      '<tg-emoji emoji-id="1">x</tg-emoji>',
      '9'.repeat(33),
      5368324170671202,
      null,
    ]) {
      expect(refused(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('resolves an icon from the tenant value, and null for a button without one', () => {
    expect(inlineButtonIconOf('wallet.topup', {})).toBeNull();
    expect(inlineButtonIconOf('wallet.topup', { 'wallet.topup': ICON })).toBe(ICON);
    expect(inlineButtonIconOf('payment.cancel', { 'wallet.topup': ICON })).toBeNull();
  });
});
