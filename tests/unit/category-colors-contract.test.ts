import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS_MAX,
  categoryButtonStyleOf,
  categoryColorsSchema,
  parseSettingValue,
  settingDefinition,
} from '@nexa/contracts';

/**
 * UX Batch 01, item 2: each product category's own colour, keyed by category id.
 */
const A = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0b';
const B = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0c';
// A tenant's first category was created by a migration with gen_random_uuid(): a version 4.
const V4 = '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';

describe('the bot.category_colors setting', () => {
  it('is declared, read by the bot, and empty by default', () => {
    const definition = settingDefinition('bot.category_colors');
    expect(definition.defaultValue).toEqual({});
    expect(definition.consumer).toBe('ACTIVE');
    expect(definition.zeroMeaning).toBe('LITERAL');
  });

  it('accepts any category id, a version 4 included, mapped to a Telegram style', () => {
    expect(parseSettingValue('bot.category_colors', { [A]: 'success', [V4]: 'danger' })).toEqual({
      ok: true,
      value: { [A]: 'success', [V4]: 'danger' },
    });
    expect(parseSettingValue('bot.category_colors', {}).ok).toBe(true);
  });

  it('needs no code change for a category created later: any well-formed id is a key', () => {
    const later = '0190a5d6-9999-7e3f-8a4b-5c6d7e8f9a0b';
    expect(parseSettingValue('bot.category_colors', { [later]: 'primary' }).ok).toBe(true);
  });

  it('refuses a colour outside the palette, a hex colour, a name and an upper-case id', () => {
    expect(parseSettingValue('bot.category_colors', { [A]: 'green' }).ok).toBe(false);
    expect(parseSettingValue('bot.category_colors', { [A]: '#00ff00' }).ok).toBe(false);
    expect(parseSettingValue('bot.category_colors', { عمومی: 'primary' }).ok).toBe(false);
    expect(parseSettingValue('bot.category_colors', { [A.toUpperCase()]: 'primary' }).ok).toBe(
      false,
    );
  });

  it('is bounded', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index <= CATEGORY_COLORS_MAX; index += 1) {
      many[`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`] = 'primary';
    }
    expect(categoryColorsSchema.safeParse(many).success).toBe(false);
    delete many['00000000-0000-4000-8000-000000000000'];
    expect(categoryColorsSchema.safeParse(many).success).toBe(true);
  });
});

describe('the colour a category button is drawn with', () => {
  it("is the category's own colour when it has one", () => {
    expect(categoryButtonStyleOf(A, { [A]: 'success' }, { 'catalog.category': 'primary' })).toBe(
      'success',
    );
  });

  it('keeps an explicit default even when the generic category button is coloured', () => {
    expect(categoryButtonStyleOf(A, { [A]: 'default' }, { 'catalog.category': 'danger' })).toBe(
      'default',
    );
  });

  it('falls back to the generic category button, then to no style', () => {
    expect(categoryButtonStyleOf(B, { [A]: 'success' }, { 'catalog.category': 'primary' })).toBe(
      'primary',
    );
    expect(categoryButtonStyleOf(B, { [A]: 'success' }, {})).toBe('default');
  });

  it('reads an id however it is cased, and is not fooled by an inherited property', () => {
    expect(categoryButtonStyleOf(A.toUpperCase(), { [A]: 'danger' }, {})).toBe('danger');
    expect(categoryButtonStyleOf('constructor', {}, {})).toBe('default');
  });
});
