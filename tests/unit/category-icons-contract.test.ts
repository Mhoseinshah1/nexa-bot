import { describe, expect, it } from 'vitest';
import {
  CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS,
  CATEGORY_COLORS_MAX,
  categoryButtonIconOf,
  categoryButtonText,
  categoryIconOf,
  categoryIconsSchema,
  isValidCategoryAfterEmoji,
  parseSettingValue,
  settingDefinition,
} from '@nexa/contracts';

/**
 * Phase 2 UX wave, Item 2: each product category's decorations (`bot.category_icons`) — a
 * premium icon BEFORE the name (a custom emoji id) and an ordinary emoji AFTER it.
 */
const A = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0b';
const B = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0c';
const V4 = '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const ICON = '5368324170671202286';
const GENERIC = '5368324170671202287';

describe('the bot.category_icons setting', () => {
  it('is declared, read by the bot, and empty by default', () => {
    const definition = settingDefinition('bot.category_icons');
    expect(definition.defaultValue).toEqual({});
    expect(definition.consumer).toBe('ACTIVE');
    expect(definition.zeroMeaning).toBe('LITERAL');
    expect(definition.mutability).toBe('RUNTIME');
  });

  it('accepts before only, after only and both, for any category id (a version 4 too)', () => {
    const value = {
      [A]: { before: ICON },
      [B]: { after: '🔥' },
      [V4]: { before: ICON, after: '🇮🇷' },
    };
    expect(parseSettingValue('bot.category_icons', value)).toEqual({ ok: true, value });
    expect(parseSettingValue('bot.category_icons', {}).ok).toBe(true);
  });

  it('refuses an id that is not a custom emoji id', () => {
    for (const before of ['', 'abc', '12a', ' 123', '1'.repeat(33), '🔥', '<b>1</b>', '-1']) {
      expect(parseSettingValue('bot.category_icons', { [A]: { before } }).ok, before).toBe(false);
    }
    expect(parseSettingValue('bot.category_icons', { [A]: { before: 123 } }).ok).toBe(false);
  });

  it('refuses an after that is markup, text, too long or not an emoji', () => {
    const refused = [
      '',
      ' ',
      '<b>🔥</b>',
      '&amp;',
      'abc',
      'خرید',
      '🔥 ',
      '🔥\n',
      '#',
      '12',
      '‍',
      '🔥'.repeat(CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS + 1),
      '<tg-emoji emoji-id="1">🔥</tg-emoji>',
    ];
    for (const after of refused) {
      expect(isValidCategoryAfterEmoji(after), JSON.stringify(after)).toBe(false);
      expect(parseSettingValue('bot.category_icons', { [A]: { after } }).ok).toBe(false);
    }
  });

  it('accepts ordinary emoji: a pictograph, VS16, a skin tone, a ZWJ family, a flag, a keycap', () => {
    for (const after of ['🔥', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇮🇷', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '⭐⭐']) {
      expect(isValidCategoryAfterEmoji(after), after).toBe(true);
    }
    expect(isValidCategoryAfterEmoji('🔥'.repeat(CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS))).toBe(true);
  });

  it('refuses an entry with neither, an unknown field, a name or an upper-case id', () => {
    expect(parseSettingValue('bot.category_icons', { [A]: {} }).ok).toBe(false);
    expect(parseSettingValue('bot.category_icons', { [A]: { before: ICON, html: '<b>' } }).ok).toBe(
      false,
    );
    expect(parseSettingValue('bot.category_icons', { عمومی: { after: '🔥' } }).ok).toBe(false);
    expect(parseSettingValue('bot.category_icons', { [A.toUpperCase()]: { after: '🔥' } }).ok).toBe(
      false,
    );
  });

  it('is bounded', () => {
    const many: Record<string, unknown> = {};
    for (let index = 0; index <= CATEGORY_COLORS_MAX; index += 1) {
      many[`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`] = { after: '🔥' };
    }
    expect(categoryIconsSchema.safeParse(many).success).toBe(false);
    delete many['00000000-0000-4000-8000-000000000000'];
    expect(categoryIconsSchema.safeParse(many).success).toBe(true);
  });
});

describe('what a category button is drawn with', () => {
  it("the premium icon is the category's own before, else the generic category icon, else none", () => {
    expect(
      categoryButtonIconOf(A, { [A]: { before: ICON } }, { 'catalog.category': GENERIC }),
    ).toBe(ICON);
    expect(categoryButtonIconOf(A, { [A]: { after: '🔥' } }, { 'catalog.category': GENERIC })).toBe(
      GENERIC,
    );
    expect(categoryButtonIconOf(B, { [A]: { before: ICON } }, {})).toBeNull();
  });

  it('reads an id however it is cased, and is not fooled by an inherited property', () => {
    expect(categoryIconOf(A.toUpperCase(), { [A]: { before: ICON, after: '🔥' } })).toEqual({
      before: ICON,
      after: '🔥',
    });
    expect(categoryIconOf('constructor', {})).toEqual({ before: null, after: null });
    expect(categoryIconOf('__proto__', {})).toEqual({ before: null, after: null });
  });

  it('the text gains " <after>" and is otherwise the label byte for byte', () => {
    expect(categoryButtonText('🌐 بین‌الملل', '🔥')).toBe('🌐 بین‌الملل 🔥');
    expect(categoryButtonText('🌐 بین‌الملل', null)).toBe('🌐 بین‌الملل');
  });
});
