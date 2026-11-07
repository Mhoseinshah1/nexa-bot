import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPLICIT_MAIN_MENU,
  DEFAULT_MAIN_MENU_LAYOUT,
  FEATURE_FLAGS,
  MAIN_MENU_BUTTONS,
  REPLACED_MAIN_MENU_LABELS,
  explicitFromLegacy,
  mainMenuButton,
  templateDefinition,
  validateTemplateBody,
  type FeatureFlagKey,
  type MainMenuButtonId,
  type MainMenuLayoutEntry,
  type ScopeContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import {
  MainMenuLayout,
  type MainMenuSourceAnswer,
} from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import { PublishedMainMenuSource } from '../../apps/api/src/modules/control/bot-menu-builder/application/main-menu-source';
import { servicesListControls } from '../../apps/api/src/surfaces/telegram/runtime/service-card-flow';
import { intentOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';

/**
 * NEXA-OWNER-BATCH-1 PR-1: the Mirza-style DEFAULT main menu. Only defaults change: every test
 * about "saved" state pins that an owner's own label, style, layout or published menu is left
 * exactly as it was.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-0000000000aa',
  botInstanceId: null,
} as unknown as ScopeContext;

const LEGACY: MainMenuSourceAnswer = {
  kind: 'LEGACY',
  superseded: false,
  publishedUnreadable: false,
};

function layoutOver(options: {
  readonly legacy?: readonly MainMenuLegacy[];
  readonly legacyIsDefault?: boolean;
  readonly source?: MainMenuSourceAnswer;
  readonly labels?: Record<string, string>;
}): MainMenuLayout {
  const legacy = options.legacy ?? DEFAULT_MAIN_MENU_LAYOUT;
  return new MainMenuLayout({
    source: {
      snapshotFor: () =>
        Promise.resolve({
          source: options.source ?? LEGACY,
          legacy,
          ...(options.legacyIsDefault === undefined
            ? {}
            : { legacyIsDefault: options.legacyIsDefault }),
        }),
    },
    settings: { valueOf: <T>() => Promise.resolve(legacy as T) },
    features: {
      isEnabled: (_scope, key: FeatureFlagKey) => Promise.resolve(key === 'referrals'),
    },
    trials: { anyOffered: () => Promise.resolve(true) },
    templates: {
      render: (_scope, key) =>
        Promise.resolve(options.labels?.[key] ?? (CATALOGUE_FA as Record<string, string>)[key]!),
    },
  });
}
type MainMenuLegacy = MainMenuLayoutEntry;

describe('the default main-menu labels', () => {
  it('are exactly the owner’s characters', () => {
    expect(CATALOGUE_FA['bot.menu.catalog']).toBe('🔐 خرید اشتراک');
    expect(CATALOGUE_FA['bot.menu.services']).toBe('🛍 سرویس های من');
    expect(CATALOGUE_FA['bot.menu.wallet']).toBe('🏦 کیف پول + شارژ');
    expect(CATALOGUE_FA['bot.menu.trial']).toBe('اشتراک رایگان {تست}');
    expect(CATALOGUE_FA['bot.menu.referral']).toBe('👥 زیر مجموعه گیری');
    expect(CATALOGUE_FA['bot.menu.apps']).toBe('📚 آموزش');
    expect(CATALOGUE_FA['bot.menu.help']).toBe('☎️ پشتیبانی');
    expect(CATALOGUE_FA['bot.menu.admin']).toBe('👨‍💼 پنل مدیریت');
    // Mirza's spelling has no ZWNJ in the two compound labels.
    expect(CATALOGUE_FA['bot.menu.services']).not.toContain('‌');
    expect(CATALOGUE_FA['bot.menu.referral']).not.toContain('‌');
  });

  it('leave the ticket desk’s label as it was', () => {
    expect(CATALOGUE_FA['bot.menu.tickets']).toBe('🎫 پشتیبانی / تیکت‌ها');
  });

  it('render «{تست}» literally: the braces are decoration, not a placeholder', () => {
    const definition = templateDefinition('bot.menu.trial');
    expect(definition.placeholders).toEqual([]);
    expect(validateTemplateBody(definition, CATALOGUE_FA['bot.menu.trial'])).toEqual([]);
    expect(renderTemplateBody(definition, CATALOGUE_FA['bot.menu.trial'], {}, 'fa')).toBe(
      'اشتراک رایگان {تست}',
    );
  });

  it('route: the literal «{تست}» label still opens the trial', () => {
    const menu = new Map(
      MAIN_MENU_BUTTONS.map((button) => [CATALOGUE_FA[button.label], `/${button.command}`]),
    );
    expect(intentOf({ message: { text: 'اشتراک رایگان {تست}' } }, menu).intent).toBe('TRIAL_CLAIM');
  });
});

describe('the replaced default labels (the older-defaults list)', () => {
  it('holds every label the seven changed buttons had before, spelled as they were', () => {
    expect(REPLACED_MAIN_MENU_LABELS).toEqual([
      { button: 'catalog', label: '🛒 خرید اشتراک' },
      { button: 'services', label: '📱 سرویس‌های من' },
      { button: 'wallet', label: '💰 کیف پول' },
      { button: 'trial', label: '🧪 دریافت سرویس تست' },
      { button: 'referral', label: '👥 زیرمجموعه‌گیری' },
      { button: 'apps', label: '📱 دانلود برنامه و آموزش اتصال' },
      { button: 'help', label: '💬 پشتیبانی' },
    ]);
  });

  it('never collide with a current default label (a replaced label cannot shadow one)', () => {
    const current = new Set(MAIN_MENU_BUTTONS.map((button) => CATALOGUE_FA[button.label]));
    for (const replaced of REPLACED_MAIN_MENU_LABELS) {
      expect(current.has(replaced.label), replaced.label).toBe(false);
      expect(mainMenuButton(replaced.button).command).toBeTruthy();
    }
  });
});

describe('the default keyboard (nothing saved)', () => {
  it('is Mirza’s order, two to a row, with the owner’s styles', async () => {
    const keyboard = await layoutOver({ legacyIsDefault: true }).keyboardFor(scope);
    expect(keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ['🔐 خرید اشتراک'],
      ['🏦 کیف پول + شارژ', '🛍 سرویس های من'],
      ['اشتراک رایگان {تست}'],
      ['📚 آموزش', '👥 زیر مجموعه گیری'],
      ['☎️ پشتیبانی'],
      ['🎫 پشتیبانی / تیکت‌ها'],
    ]);
    expect(keyboard.map((row) => row.map((button) => button.style))).toEqual([
      ['success'],
      ['success', 'success'],
      ['primary'],
      ['success', 'success'],
      ['success'],
      ['default'],
    ]);
  });

  it('keeps the legacy packing and plain styles for a SAVED bot.main_menu, even the default value', async () => {
    for (const legacyIsDefault of [false, undefined]) {
      const keyboard = await layoutOver({
        ...(legacyIsDefault === undefined ? {} : { legacyIsDefault }),
      }).keyboardFor(scope);
      expect(keyboard.map((row) => row.length)).toEqual([2, 2, 2, 1, 1]);
      expect(keyboard.flat().every((button) => button.style === 'default')).toBe(true);
    }
  });

  it('leaves an owner-published layout exactly as saved (style and rows)', async () => {
    const published = {
      ...DEFAULT_EXPLICIT_MAIN_MENU,
      rows: [['help'], ['catalog', 'wallet']] as MainMenuButtonId[][],
      buttons: DEFAULT_EXPLICIT_MAIN_MENU.buttons.map((config) => ({
        ...config,
        style: 'danger' as const,
      })),
    };
    const keyboard = await layoutOver({
      source: { kind: 'EXPLICIT', layout: published, revision: 2 },
      legacyIsDefault: true,
    }).keyboardFor(scope);
    expect(keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ['☎️ پشتیبانی'],
      ['🔐 خرید اشتراک', '🏦 کیف پول + شارژ'],
    ]);
    expect(keyboard.flat().every((button) => button.style === 'danger')).toBe(true);
  });

  it('draws an owner’s label override over the new default', async () => {
    const keyboard = await layoutOver({
      legacyIsDefault: true,
      labels: { 'bot.menu.catalog': 'فروشگاه من' },
    }).keyboardFor(scope);
    expect(keyboard[0]?.[0]?.text).toBe('فروشگاه من');
    expect(keyboard[1]?.[0]?.text).toBe('🏦 کیف پول + شارژ');
  });

  it('is the seed of the builder: DEFAULT_EXPLICIT_MAIN_MENU, unlike a legacy conversion', () => {
    expect(DEFAULT_EXPLICIT_MAIN_MENU.rows).toEqual([
      ['catalog'],
      ['wallet', 'services'],
      ['trial'],
      ['apps', 'referral'],
      ['help'],
      ['tickets'],
    ]);
    expect(explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT).rows).not.toEqual(
      DEFAULT_EXPLICIT_MAIN_MENU.rows,
    );
  });
});

describe('PublishedMainMenuSource: whether bot.main_menu is a saved value', () => {
  const sourceFor = (settingSource: 'DEFAULT' | 'TENANT') =>
    new PublishedMainMenuSource(
      { readMenuState: () => Promise.resolve({ layout: null, setting: null }) },
      {
        resolveStored: () =>
          Promise.resolve({
            value: DEFAULT_MAIN_MENU_LAYOUT,
            source: settingSource,
            version: settingSource === 'DEFAULT' ? null : 1,
          } as never),
      },
      { record: () => Promise.resolve({} as never) },
    );

  it('marks the default value, and only the default value', async () => {
    expect((await sourceFor('DEFAULT').snapshotFor(scope)).legacyIsDefault).toBe(true);
    expect((await sourceFor('TENANT').snapshotFor(scope)).legacyIsDefault).toBe(false);
  });
});

describe('the services list search row (two flags, both off by default)', () => {
  const buttonKeys = (label: boolean, search: boolean) =>
    servicesListControls(1, 1, { label, search })
      .filter((button) => button.row === 100)
      .map((button) => button.inline);

  it('declares both flags, default off, in the registry', () => {
    for (const key of ['services_search_label_button', 'services_search_button'] as const) {
      const flag = FEATURE_FLAGS.find((one) => one.key === key);
      expect(flag?.defaultEnabled, key).toBe(false);
    }
  });

  it('draws no search row at all by default and with both off', () => {
    expect(servicesListControls(1, 1).filter((button) => button.row === 100)).toEqual([]);
    expect(buttonKeys(false, false)).toEqual([]);
  });

  it('draws only the label button, or only the search button, or both', () => {
    expect(buttonKeys(true, false)).toEqual(['services.search_label']);
    expect(buttonKeys(false, true)).toEqual(['services.search']);
    expect(buttonKeys(true, true)).toEqual(['services.search_label', 'services.search']);
  });

  it('keeps the pager and the way back whatever the row', () => {
    const rows = new Set(servicesListControls(1, 3).map((button) => button.row));
    expect([...rows]).toEqual([101, 102]);
  });
});
