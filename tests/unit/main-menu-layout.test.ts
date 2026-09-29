import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_BUTTONS,
  mainMenuLayoutSchema,
  packMainMenuRows,
  parseTrafficInput,
  resolveMainMenuLayout,
  settingDefinition,
  trafficInputOf,
  type FeatureFlagKey,
  type MainMenuLayoutEntry,
  type ScopeContext,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { MainMenuLayout } from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import { expiryFor } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';

/**
 * R1: «دکمه‌های ربات» — the main menu an operator arranges, and the one object the keyboard
 * and the route table are both read from; plus the two small rules the per-panel trial
 * adds (MB traffic, hours of expiry).
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-0000000000aa',
  botInstanceId: null,
} as unknown as ScopeContext;

function layoutWith(options: {
  readonly stored?: readonly MainMenuLayoutEntry[];
  readonly flags?: Partial<Record<FeatureFlagKey, boolean>>;
  readonly labels?: Partial<Record<TemplateKey, string>>;
}): MainMenuLayout {
  return new MainMenuLayout({
    settings: {
      valueOf: <T>() => Promise.resolve((options.stored ?? DEFAULT_MAIN_MENU_LAYOUT) as T),
    },
    features: { isEnabled: (_scope, key) => Promise.resolve(options.flags?.[key] ?? false) },
    templates: {
      render: (_scope, key) =>
        Promise.resolve(
          options.labels?.[key] ?? (CATALOGUE_FA as Record<string, string>)[key] ?? '',
        ),
    },
  });
}

describe('the main-menu arrangement (bot.main_menu)', () => {
  it('packs two to a row and puts a wide button alone', () => {
    expect(
      packMainMenuRows(MAIN_MENU_BUTTONS).map((row) => row.map((button) => button.id)),
    ).toEqual([
      ['catalog', 'services'],
      ['wallet', 'help'],
      ['trial', 'referral'],
      ['apps'],
      ['tickets'],
    ]);
    // An odd button before a wide one keeps its row to itself rather than pairing across.
    const [catalog, , , , , , apps, tickets] = MAIN_MENU_BUTTONS;
    if (catalog === undefined || apps === undefined || tickets === undefined) throw new Error();
    expect(packMainMenuRows([catalog, apps, tickets]).map((row) => row.length)).toEqual([1, 1, 1]);
  });

  it('completes a stored arrangement with every button it does not name, switched on', () => {
    const stored: MainMenuLayoutEntry[] = [
      { button: 'wallet', enabled: true },
      { button: 'trial', enabled: false },
    ];
    const resolved = resolveMainMenuLayout(stored);
    expect(resolved.map((entry) => entry.button)).toEqual([
      'wallet',
      'trial',
      'catalog',
      'services',
      'help',
      'referral',
      'apps',
      'tickets',
    ]);
    expect(resolved.find((entry) => entry.button === 'trial')?.enabled).toBe(false);
    expect(resolved.filter((entry) => entry.enabled)).toHaveLength(MAIN_MENU_BUTTON_IDS.length - 1);
  });

  it('refuses a duplicate, an unknown id, and an arrangement that could leave no button', () => {
    expect(mainMenuLayoutSchema.safeParse(DEFAULT_MAIN_MENU_LAYOUT).success).toBe(true);
    expect(
      mainMenuLayoutSchema.safeParse([
        { button: 'wallet', enabled: true },
        { button: 'wallet', enabled: false },
      ]).success,
    ).toBe(false);
    expect(mainMenuLayoutSchema.safeParse([{ button: 'lottery', enabled: true }]).success).toBe(
      false,
    );
    // Only the feature-gated buttons left on: a flag switched off would empty the keyboard.
    const onlyGated = MAIN_MENU_BUTTONS.map((button) => ({
      button: button.id,
      enabled: button.feature !== null,
    }));
    expect(mainMenuLayoutSchema.safeParse(onlyGated).success).toBe(false);
    // The registry holds it under this schema, with the default in force.
    expect(settingDefinition('bot.main_menu').schema.safeParse(onlyGated).success).toBe(false);
    expect(settingDefinition('bot.main_menu').defaultValue).toEqual(DEFAULT_MAIN_MENU_LAYOUT);
  });
});

describe('MainMenuLayout — the keyboard and the route table from one object', () => {
  it('draws the operator’s order, without switched-off buttons, and a gated one only while its flag is on', async () => {
    const stored: MainMenuLayoutEntry[] = [
      { button: 'referral', enabled: true },
      { button: 'catalog', enabled: true },
      { button: 'services', enabled: false },
      { button: 'trial', enabled: true },
    ];
    const off = layoutWith({ stored });
    expect(await off.rowsFor(scope)).toEqual([
      [CATALOGUE_FA['bot.menu.catalog'], CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.help']],
      [CATALOGUE_FA['bot.menu.apps']],
      [CATALOGUE_FA['bot.menu.tickets']],
    ]);
    const on = layoutWith({ stored, flags: { trials: true, referrals: true } });
    expect(await on.rowsFor(scope)).toEqual([
      [CATALOGUE_FA['bot.menu.referral'], CATALOGUE_FA['bot.menu.catalog']],
      [CATALOGUE_FA['bot.menu.trial'], CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.help']],
      [CATALOGUE_FA['bot.menu.apps']],
      [CATALOGUE_FA['bot.menu.tickets']],
    ]);
  });

  it('labels the keyboard with the tenant’s text, and routes that same text', async () => {
    const layout = layoutWith({
      flags: { trials: true },
      labels: { 'bot.menu.trial': '🎁 تست رایگان' },
    });
    expect((await layout.rowsFor(scope)).flat()).toContain('🎁 تست رایگان');
    const routes = await layout.routesFor(scope);
    expect(routes.get('🎁 تست رایگان')).toBe('/trial');
    expect(routes.get(CATALOGUE_FA['bot.menu.referral'])).toBe('/referral');
    // A hidden button still routes: a keyboard already in a chat keeps working.
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });

  it('gives a label two buttons share to the first declared one', async () => {
    const layout = layoutWith({ labels: { 'bot.menu.wallet': CATALOGUE_FA['bot.menu.catalog'] } });
    expect((await layout.routesFor(scope)).get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });
});

describe('the per-panel trial’s two small rules', () => {
  it('reads MB with the GB grammar, and shows a stored figure back in the unit it fits', () => {
    expect(parseTrafficInput('100', 'MB')).toBe(104_857_600n);
    expect(parseTrafficInput('0.5', 'GB')).toBe(536_870_912n);
    expect(parseTrafficInput('1.5', 'MB')).toBe(1_572_864n);
    for (const bad of ['-1', '1e3', '.5', '1,5', '']) {
      expect(parseTrafficInput(bad, 'MB'), bad).toBeNull();
    }
    expect(trafficInputOf(104_857_600n)).toEqual({ amount: '100', unit: 'MB' });
    expect(trafficInputOf(1_073_741_824n)).toEqual({ amount: '1', unit: 'GB' });
  });

  it('computes an expiry from hours when an order carries them', () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    expect(expiryFor(now, 3, 72)?.toISOString()).toBe('2026-10-02T10:00:00.000Z');
    expect(expiryFor(now, 1, 12)?.toISOString()).toBe('2026-09-29T22:00:00.000Z');
    // Without hours, days as before — and zero days is still unlimited.
    expect(expiryFor(now, 2)?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(expiryFor(now, 0)).toBeNull();
  });
});
