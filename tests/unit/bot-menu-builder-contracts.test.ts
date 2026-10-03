import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_SLOTS,
  DEFAULT_EXPLICIT_MAIN_MENU,
  DEFAULT_MAIN_MENU_LAYOUT,
  EXPLICIT_MAIN_MENU_VERSION,
  MAIN_MENU_BUTTONS,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_BUTTON_STYLES,
  MAIN_MENU_ROW_LENGTH_MAX,
  MAIN_MENU_ROWS_MAX,
  MENU_APPEARANCE_SLOTS,
  customerRowsOf,
  defaultMainMenuButtonConfig,
  explicitFromLegacy,
  explicitMainMenuSchema,
  explicitMainMenusEqual,
  legacyProjectionOf,
  mainMenuButton,
  mainMenuButtonIsGated,
  mainMenuLayoutEntrySchema,
  mainMenuLayoutSchema,
  mainMenuTargetOf,
  normalizeExplicitMainMenu,
  packMainMenuRows,
  resolveMainMenuLayout,
  settingDefinition,
  unplacedMainMenuButtons,
  type ExplicitMainMenu,
  type MainMenuButtonId,
  type MainMenuGateOpenById,
  type MainMenuLayoutEntry,
} from '@nexa/contracts';
import { frozenEntrySchema, frozenLayoutSchema } from '../support/frozen-main-menu-schema';

/**
 * Round T (T1) — the explicit main-menu model in contracts: its schema, the legacy
 * conversion, the compatibility projection and the one rendering rule
 * (`docs/round-t-button-builder-audit.md` §11, tests C-1..C-3).
 */

/** A small deterministic PRNG, so a generated case that fails is the same case next run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** A random VALID explicit layout. */
function randomExplicit(random: () => number): ExplicitMainMenu {
  for (;;) {
    const order = shuffle(MAIN_MENU_BUTTON_IDS, random);
    const placedCount = Math.floor(random() * (order.length + 1));
    const placed = order.slice(0, placedCount);
    const rows: MainMenuButtonId[][] = [];
    let open: MainMenuButtonId[] = [];
    for (const id of placed) {
      open.push(id);
      if (open.length === MAIN_MENU_ROW_LENGTH_MAX || random() < 0.4) {
        rows.push(open);
        open = [];
      }
    }
    if (open.length > 0) rows.push(open);
    const candidate = {
      v: EXPLICIT_MAIN_MENU_VERSION,
      rows,
      buttons: shuffle(MAIN_MENU_BUTTON_IDS, random).map((id) => ({
        button: id,
        enabled: random() < 0.75,
        style: MAIN_MENU_BUTTON_STYLES[Math.floor(random() * 4)] ?? 'default',
        iconSlot: random() < 0.5 ? null : (APPEARANCE_SLOTS[Math.floor(random() * 5)] ?? null),
        appearanceSlot:
          random() < 0.6 ? null : (MENU_APPEARANCE_SLOTS[Math.floor(random() * 6)] ?? null),
      })),
    };
    const parsed = explicitMainMenuSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
}

/** A random VALID legacy value, in either historical shape. */
function randomLegacy(random: () => number): MainMenuLayoutEntry[] {
  for (;;) {
    const named = shuffle(MAIN_MENU_BUTTON_IDS, random).slice(
      0,
      Math.floor(random() * (MAIN_MENU_BUTTON_IDS.length + 1)),
    );
    const roundP = random() < 0.5;
    const candidate: MainMenuLayoutEntry[] = named.map((id) => ({
      button: id,
      enabled: random() < 0.7,
      ...(roundP ? { target: mainMenuTargetOf(id), appearanceSlot: null } : {}),
    }));
    if (mainMenuLayoutSchema.safeParse(candidate).success) return candidate;
  }
}

/** The legacy keyboard's ids, as `MainMenuLayout.rowsFor` draws them with every gate open. */
function legacyRowsAllOpen(stored: readonly MainMenuLayoutEntry[]): MainMenuButtonId[][] {
  const shown = resolveMainMenuLayout(stored)
    .filter((item) => item.enabled)
    .map((item) => mainMenuButton(item.button));
  return packMainMenuRows(shown).map((row) => row.map((button) => button.id));
}

const allOpen: MainMenuGateOpenById = { trial: true, referral: true };
const idsOf = (rows: readonly (readonly { button: MainMenuButtonId }[])[]) =>
  rows.map((row) => row.map((one) => one.button));

describe('C-1 legacy → explicit: identical keyboard with every gate open', () => {
  const fixtures: Record<string, MainMenuLayoutEntry[]> = {
    empty: [],
    default: [...DEFAULT_MAIN_MENU_LAYOUT],
    'R1 shape (no target, no slot)': [
      { button: 'wallet', enabled: true },
      { button: 'trial', enabled: false },
    ],
    'round P shape': DEFAULT_MAIN_MENU_LAYOUT.map((entry) => ({
      ...entry,
      appearanceSlot: entry.button === 'wallet' ? 'payment' : null,
    })),
    reordered: [
      { button: 'tickets', enabled: true },
      { button: 'referral', enabled: true },
      { button: 'catalog', enabled: true },
      { button: 'apps', enabled: true },
      { button: 'help', enabled: true },
    ],
    disabled: [
      { button: 'catalog', enabled: false },
      { button: 'services', enabled: false },
      { button: 'apps', enabled: false },
    ],
    'odd before wide': [
      { button: 'catalog', enabled: true },
      { button: 'apps', enabled: true },
      { button: 'services', enabled: true },
    ],
  };

  for (const [name, stored] of Object.entries(fixtures)) {
    it(`${name}`, () => {
      expect(mainMenuLayoutSchema.safeParse(stored).success).toBe(true);
      const explicit = explicitFromLegacy(stored);
      expect(explicitMainMenuSchema.safeParse(explicit).success).toBe(true);
      expect(idsOf(customerRowsOf(explicit, allOpen))).toEqual(legacyRowsAllOpen(stored));
    });
  }

  it('holds for 500 generated legacy values too', () => {
    const random = rng(20261001);
    for (let index = 0; index < 500; index += 1) {
      const stored = randomLegacy(random);
      const explicit = explicitFromLegacy(stored);
      expect(explicitMainMenuSchema.safeParse(explicit).success).toBe(true);
      expect(idsOf(customerRowsOf(explicit, allOpen))).toEqual(legacyRowsAllOpen(stored));
    }
  });

  it('converts adding nothing an operator did not choose: default style, no icon, slot kept', () => {
    const explicit = explicitFromLegacy([
      { button: 'wallet', enabled: true, appearanceSlot: 'payment' },
      { button: 'catalog', enabled: false },
    ]);
    for (const config of explicit.buttons) {
      expect(config.style).toBe('default');
      expect(config.iconSlot).toBeNull();
    }
    expect(explicit.buttons.find((one) => one.button === 'wallet')?.appearanceSlot).toBe('payment');
    // A legacy "off" is unplaced: in the pool, not on a row.
    expect(unplacedMainMenuButtons(explicit)).toEqual(['catalog']);
    expect(explicit.buttons.map((one) => one.button)).toEqual([...MAIN_MENU_BUTTON_IDS]);
  });

  it('the registry default converts to the default keyboard', () => {
    expect(DEFAULT_EXPLICIT_MAIN_MENU.rows).toEqual([
      ['catalog', 'services'],
      ['wallet', 'help'],
      ['trial', 'referral'],
      ['apps'],
      ['tickets'],
    ]);
  });
});

describe('C-2 the compatibility projection parses under the PREVIOUS release’s parser', () => {
  it('the live bot.main_menu schema still behaves exactly like the frozen copy', () => {
    const random = rng(7);
    const fixtures: unknown[] = [
      [],
      DEFAULT_MAIN_MENU_LAYOUT,
      [{ button: 'wallet', enabled: true }],
      [{ button: 'wallet', enabled: true, target: 'catalog' }],
      [{ button: 'wallet', enabled: true, style: 'primary' }],
      [{ button: 'wallet', enabled: true, iconSlot: 'wallet' }],
      [{ button: 'wallet', enabled: true, row: 0 }],
      [{ button: 'lottery', enabled: true }],
      [
        { button: 'trial', enabled: true },
        { button: 'referral', enabled: true },
        ...MAIN_MENU_BUTTON_IDS.filter((id) => id !== 'trial' && id !== 'referral').map((id) => ({
          button: id,
          enabled: false,
        })),
      ],
      { v: 1, rows: [], buttons: [] },
      ...Array.from({ length: 200 }, () => randomLegacy(random)),
      ...Array.from({ length: 50 }, () => legacyProjectionOf(randomExplicit(random))),
    ];
    for (const fixture of fixtures) {
      const live = mainMenuLayoutSchema.safeParse(fixture);
      const frozen = frozenLayoutSchema.safeParse(fixture);
      expect(live.success, JSON.stringify(fixture)).toBe(frozen.success);
      if (live.success && frozen.success) expect(live.data).toEqual(frozen.data);
    }
    // And the registry still holds the setting under that schema, keys unchanged.
    expect(settingDefinition('bot.main_menu').schema).toBe(mainMenuLayoutSchema);
    expect(Object.keys(mainMenuLayoutEntrySchema.shape).sort()).toEqual(
      Object.keys(frozenEntrySchema.shape).sort(),
    );
  });

  it('every generated explicit layout projects to a value the frozen parser accepts', () => {
    const random = rng(42);
    for (let index = 0; index < 1000; index += 1) {
      const explicit = randomExplicit(random);
      const projection = legacyProjectionOf(explicit);
      const parsed = frozenLayoutSchema.safeParse(projection);
      expect(parsed.success, JSON.stringify(explicit)).toBe(true);
      // Every declared button once; targets explicit; the visible set and order agree.
      expect(projection.map((entry) => entry.button).sort()).toEqual(
        [...MAIN_MENU_BUTTON_IDS].sort(),
      );
      const drawnExplicit = customerRowsOf(explicit, allOpen)
        .flat()
        .map((one) => one.button);
      const drawnByOld = resolveMainMenuLayout(projection)
        .filter((item) => item.enabled)
        .map((item) => item.button);
      expect(drawnByOld).toEqual(drawnExplicit);
    }
  });

  it('projects no style, no icon and no row break, and a default slot as null', () => {
    const explicit = explicitMainMenuSchema.parse({
      v: 1,
      rows: [['wallet', 'catalog', 'services'], ['help']],
      buttons: [
        {
          button: 'wallet',
          enabled: true,
          style: 'danger',
          iconSlot: 'wallet',
          appearanceSlot: 'payment',
        },
        {
          button: 'catalog',
          enabled: false,
          style: 'primary',
          iconSlot: null,
          appearanceSlot: 'purchase',
        },
        {
          button: 'services',
          enabled: true,
          style: 'default',
          iconSlot: null,
          appearanceSlot: null,
        },
        {
          button: 'help',
          enabled: true,
          style: 'success',
          iconSlot: 'support',
          appearanceSlot: null,
        },
      ],
    });
    expect(legacyProjectionOf(explicit)).toEqual([
      { button: 'wallet', enabled: true, target: 'wallet', appearanceSlot: 'payment' },
      { button: 'catalog', enabled: false, target: 'catalog', appearanceSlot: null },
      { button: 'services', enabled: true, target: 'services', appearanceSlot: null },
      { button: 'help', enabled: true, target: 'help', appearanceSlot: null },
      { button: 'trial', enabled: false, target: 'trial', appearanceSlot: null },
      { button: 'referral', enabled: false, target: 'referral', appearanceSlot: null },
      { button: 'apps', enabled: false, target: 'apps', appearanceSlot: null },
      { button: 'tickets', enabled: false, target: 'tickets', appearanceSlot: null },
    ]);
  });
});

describe('C-3 placement safety', () => {
  const config = (id: MainMenuButtonId) => defaultMainMenuButtonConfig(id);
  const base = {
    v: 1,
    rows: [['catalog', 'services']],
    buttons: MAIN_MENU_BUTTON_IDS.map(config),
  };
  const refused = (value: unknown) => explicitMainMenuSchema.safeParse(value).success;

  it('accepts the base case', () => {
    expect(refused(base)).toBe(true);
  });

  it('refuses a button placed twice, on one row or across rows', () => {
    expect(refused({ ...base, rows: [['catalog', 'catalog']] })).toBe(false);
    expect(refused({ ...base, rows: [['catalog'], ['services', 'catalog']] })).toBe(false);
  });

  it('refuses an unknown id, style or icon slot, and any undeclared key', () => {
    expect(refused({ ...base, rows: [['catalog', 'lottery']] })).toBe(false);
    expect(
      refused({
        ...base,
        buttons: [...base.buttons.slice(1), { ...config('catalog'), style: 'blue' }],
      }),
    ).toBe(false);
    expect(
      refused({
        ...base,
        buttons: [...base.buttons.slice(1), { ...config('catalog'), iconSlot: '🔥' }],
      }),
    ).toBe(false);
    expect(
      refused({
        ...base,
        buttons: [...base.buttons.slice(1), { ...config('catalog'), callback: 'x' }],
      }),
    ).toBe(false);
    expect(refused({ ...base, url: 'https://example.test' })).toBe(false);
    expect(refused({ ...base, v: 2 })).toBe(false);
  });

  it('refuses an empty row and too many rows, and accepts every row length up to the registry', () => {
    expect(refused({ ...base, rows: [['catalog'], []] })).toBe(false);
    expect(MAIN_MENU_ROWS_MAX).toBe(MAIN_MENU_BUTTON_IDS.length);
    expect(
      refused({
        ...base,
        rows: [...MAIN_MENU_BUTTON_IDS.map((id) => [id]), ['catalog']],
      }),
    ).toBe(false);
    expect(refused({ ...base, rows: MAIN_MENU_BUTTON_IDS.map((id) => [id]) })).toBe(true);
    // The bounds are Nexa's own, derived from the registry — not a Telegram maximum: one
    // button per row is always legal, and so is every button on one row.
    expect(MAIN_MENU_ROW_LENGTH_MAX).toBe(MAIN_MENU_BUTTON_IDS.length);
    for (const length of [1, 2, 3, 4, 5, MAIN_MENU_BUTTON_IDS.length]) {
      const ids = ['catalog', ...MAIN_MENU_BUTTON_IDS.filter((id) => id !== 'catalog')].slice(
        0,
        length,
      );
      expect(refused({ ...base, rows: [ids] }), `a row of ${String(length)}`).toBe(true);
    }
    // Past the registry, a row can only be made by repeating a button — refused.
    expect(refused({ ...base, rows: [[...MAIN_MENU_BUTTON_IDS, 'catalog']] })).toBe(false);
  });

  it('refuses a layout with no placed, enabled, ungated button', () => {
    expect(refused({ ...base, rows: [] })).toBe(false);
    expect(refused({ ...base, rows: [['trial', 'referral']] })).toBe(false);
    expect(
      refused({
        ...base,
        buttons: base.buttons.map((one) =>
          one.button === 'catalog' || one.button === 'services' ? { ...one, enabled: false } : one,
        ),
      }),
    ).toBe(false);
  });

  it('refuses a placed button with no configuration, and a configuration given twice', () => {
    expect(
      refused({ ...base, buttons: base.buttons.filter((one) => one.button !== 'services') }),
    ).toBe(false);
    expect(refused({ ...base, buttons: [...base.buttons, config('wallet')] })).toBe(false);
  });

  it('completes an UNPLACED button with no configuration into the pool (a later release’s button, OQ-T-2)', () => {
    const missing = explicitMainMenuSchema.parse({
      ...base,
      buttons: base.buttons.filter((one) => one.button !== 'tickets'),
    });
    const normalized = normalizeExplicitMainMenu(missing);
    expect(normalized.buttons.map((one) => one.button)).toEqual([...MAIN_MENU_BUTTON_IDS]);
    expect(normalized.buttons.find((one) => one.button === 'tickets')).toEqual(
      defaultMainMenuButtonConfig('tickets'),
    );
    expect(unplacedMainMenuButtons(normalized)).toContain('tickets');
    expect(
      customerRowsOf(normalized, allOpen)
        .flat()
        .map((one) => one.button),
    ).not.toContain('tickets');
  });

  it('compares on meaning: config order and a default slot written out are no change', () => {
    const reordered = explicitMainMenuSchema.parse({
      ...base,
      buttons: [...base.buttons]
        .reverse()
        .map((one) =>
          one.button === 'wallet'
            ? { ...one, appearanceSlot: mainMenuButton('wallet').appearanceSlot }
            : one,
        ),
    });
    expect(explicitMainMenusEqual(explicitMainMenuSchema.parse(base), reordered)).toBe(true);
    expect(
      explicitMainMenusEqual(explicitMainMenuSchema.parse(base), {
        ...explicitMainMenuSchema.parse(base),
        rows: [['services', 'catalog']],
      }),
    ).toBe(false);
  });
});

describe('the retired button icon (owner order 2026-10-02)', () => {
  const stored = explicitMainMenuSchema.parse({
    v: 1,
    rows: [['wallet', 'catalog'], ['help']],
    buttons: MAIN_MENU_BUTTON_IDS.map((id) => ({
      ...defaultMainMenuButtonConfig(id),
      iconSlot: id === 'wallet' ? 'wallet' : id === 'help' ? 'support' : null,
      appearanceSlot: id === 'wallet' ? 'payment' : null,
    })),
  });

  it('still PARSES a snapshot an earlier release wrote with icons (no layout becomes unreadable)', () => {
    expect(stored.buttons.find((one) => one.button === 'wallet')?.iconSlot).toBe('wallet');
  });

  it('canonicalises every icon to null, and keeps the screen slot exactly as stored', () => {
    const normalized = normalizeExplicitMainMenu(stored);
    expect(normalized.buttons.every((one) => one.iconSlot === null)).toBe(true);
    expect(normalized.buttons.find((one) => one.button === 'wallet')?.appearanceSlot).toBe(
      'payment',
    );
    // The key is still WRITTEN: the previous release's strict parser requires it.
    expect(normalized.buttons.every((one) => 'iconSlot' in one)).toBe(true);
    expect(explicitMainMenuSchema.safeParse(normalized).success).toBe(true);
  });

  it('decides "nothing changed" without the icon, so an icon alone is never a pending change', () => {
    const without = {
      ...stored,
      buttons: stored.buttons.map((one) => ({ ...one, iconSlot: null })),
    };
    expect(explicitMainMenusEqual(stored, without)).toBe(true);
  });

  it('never draws an icon: the rendering rule has nowhere to put one', () => {
    for (const button of customerRowsOf(stored, allOpen).flat()) {
      expect(Object.keys(button).sort()).toEqual(['button', 'style']);
    }
  });
});

describe('customerRowsOf — the one rendering rule (runtime and preview)', () => {
  const layout = explicitMainMenuSchema.parse({
    v: 1,
    rows: [['trial', 'referral'], ['catalog', 'services', 'wallet'], ['help']],
    buttons: [
      ...MAIN_MENU_BUTTON_IDS.map((id) => ({
        ...defaultMainMenuButtonConfig(id),
        enabled: id !== 'services',
        style: id === 'wallet' ? ('success' as const) : ('default' as const),
        iconSlot: id === 'wallet' ? ('wallet' as const) : null,
      })),
    ],
  });

  it('keeps disabled and gated-closed buttons out WITHOUT reflowing, and drops an emptied row', () => {
    // Both gates closed: the first row is emptied and dropped; `services` is off and
    // leaves its row shorter; nothing from row three moves up.
    expect(customerRowsOf(layout, { trial: false, referral: null })).toEqual([
      [
        { button: 'catalog', style: 'default' },
        { button: 'wallet', style: 'success' },
      ],
      [{ button: 'help', style: 'default' }],
    ]);
    // One gate open: its button is drawn alone on its row.
    expect(idsOf(customerRowsOf(layout, { trial: true }))).toEqual([
      ['trial'],
      ['catalog', 'wallet'],
      ['help'],
    ]);
  });

  it('decides gates only from the answer it is given (no gate logic of its own)', () => {
    // Anything but `true` is closed for a gated button; an ungated button is never asked.
    for (const answer of [false, null, undefined]) {
      expect(
        idsOf(customerRowsOf(layout, { trial: answer, referral: answer })).flat(),
      ).not.toContain('trial');
    }
    expect(
      idsOf(customerRowsOf(layout, { catalog: false } as MainMenuGateOpenById)).flat(),
    ).toContain('catalog');
  });

  it('every registry button is gated exactly as the registry says', () => {
    expect(MAIN_MENU_BUTTONS.filter(mainMenuButtonIsGated).map((one) => one.id)).toEqual([
      'trial',
      'referral',
    ]);
  });
});
