import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MENU_BUTTONS_MAX,
  CUSTOM_MENU_LABEL_MAX,
  EXPLICIT_MAIN_MENU_VERSION,
  EXPLICIT_MAIN_MENU_VERSION_V2,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_ROWS_MAX,
  MAIN_MENU_ROW_LENGTH_MAX,
  createCustomMenuButtonRequestSchema,
  customMenuButtonVisible,
  customMenuIdOfRef,
  customMenuIdOfRoute,
  customMenuRefOf,
  customMenuRouteValue,
  customerRowsOf,
  defaultMainMenuButtonConfig,
  explicitMainMenuSchema,
  explicitMainMenuV2Schema,
  explicitMainMenusEqual,
  isCustomMenuRef,
  legacyProjectionOf,
  normalizeCustomMenuBody,
  normalizeCustomMenuLabel,
  normalizeCustomMenuUrl,
  normalizeExplicitMainMenu,
  parseExplicitMainMenu,
  placedCustomRefs,
  unplacedMainMenuButtons,
  type CustomMenuRef,
} from '@nexa/contracts';
import { frozenLayoutSchema } from '../support/frozen-main-menu-schema';

/**
 * R10 D2 — the `v: 2` layout and the custom-button helpers in contracts. The `v: 1` schema
 * is untouched (its own suite is `bot-menu-builder-contracts.test.ts`); what is pinned here
 * is what a custom reference may and may not do around it.
 */

const A: CustomMenuRef = customMenuRefOf('0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b');
const B: CustomMenuRef = customMenuRefOf('0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c');

const registryConfigs = MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id));
const customConfig = (ref: CustomMenuRef, enabled = true) => ({
  ref,
  enabled,
  style: 'default' as const,
});

function v2(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    rows: [['catalog', 'services'], [A]],
    buttons: registryConfigs,
    customButtons: [customConfig(A)],
    ...overrides,
  };
}

describe('D2 layout v2 — placement safety', () => {
  it('accepts a layout that places a custom button beside registry buttons', () => {
    expect(explicitMainMenuSchema.safeParse(v2()).success).toBe(false);
    const parsed = explicitMainMenuV2Schema.safeParse(v2());
    expect(parsed.success).toBe(true);
  });

  it('keeps the v1 schema closed: a v1 layout cannot hold a custom reference', () => {
    const asV1 = { v: 1, rows: [['catalog'], [A]], buttons: registryConfigs };
    expect(explicitMainMenuSchema.safeParse(asV1).success).toBe(false);
    expect(explicitMainMenuSchema.safeParse({ ...asV1, customButtons: [] }).success).toBe(false);
  });

  it('refuses a custom reference placed twice', () => {
    const doubled = v2({ rows: [['catalog'], [A, 'services'], [A]] });
    expect(explicitMainMenuV2Schema.safeParse(doubled).success).toBe(false);
    // The same reference twice on one row.
    expect(explicitMainMenuV2Schema.safeParse(v2({ rows: [['catalog'], [A, A]] })).success).toBe(
      false,
    );
  });

  it('refuses a malformed reference', () => {
    for (const bad of [
      'custom:',
      'custom:not-a-uuid',
      'custom:0198A1B2-C3D4-7E5F-8A6B-7C8D9E0F1A2B',
      ' custom:0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      'mb:0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
    ]) {
      expect(isCustomMenuRef(bad), bad).toBe(false);
      expect(explicitMainMenuV2Schema.safeParse(v2({ rows: [['catalog'], [bad]] })).success).toBe(
        false,
      );
    }
  });

  it('refuses a row longer than the registry plus the custom maximum, and too many rows', () => {
    const refs = Array.from({ length: CUSTOM_MENU_BUTTONS_MAX }, (_, index) =>
      customMenuRefOf(`0198a1b2-c3d4-7e5f-8a6b-${String(index).padStart(12, '0')}`),
    );
    const everything = [...MAIN_MENU_BUTTON_IDS, ...refs];
    const full = v2({
      rows: [everything],
      customButtons: refs.map((ref) => customConfig(ref)),
    });
    // Every declared button and every custom button on ONE row is legal ...
    expect(explicitMainMenuV2Schema.safeParse(full).success).toBe(true);
    expect(everything.length).toBeGreaterThan(MAIN_MENU_ROW_LENGTH_MAX);
    // ... one more on the row is not, and one row per button is the row bound.
    const extra = customMenuRefOf('0198a1b2-c3d4-7e5f-8a6b-ffffffffffff');
    expect(
      explicitMainMenuV2Schema.safeParse(
        v2({
          rows: [[...everything, extra]],
          customButtons: [...refs, extra].map((r) => customConfig(r)),
        }),
      ).success,
    ).toBe(false);
    expect(
      explicitMainMenuV2Schema.safeParse(
        v2({
          rows: everything.map((one) => [one]),
          customButtons: refs.map((ref) => customConfig(ref)),
        }),
      ).success,
    ).toBe(true);
    expect(
      explicitMainMenuV2Schema.safeParse(
        v2({
          rows: [...everything.map((one) => [one]), ['catalog']],
          customButtons: refs.map((ref) => customConfig(ref)),
        }),
      ).success,
    ).toBe(false);
    // More custom configurations than the maximum are refused outright.
    expect(
      explicitMainMenuV2Schema.safeParse(
        v2({ customButtons: [...refs, extra].map((ref) => customConfig(ref)) }),
      ).success,
    ).toBe(false);
    expect(MAIN_MENU_ROWS_MAX).toBe(MAIN_MENU_BUTTON_IDS.length);
  });

  it('refuses a placed custom button with no configuration, and a configuration where it is not placed', () => {
    expect(explicitMainMenuV2Schema.safeParse(v2({ customButtons: [] })).success).toBe(false);
    expect(
      explicitMainMenuV2Schema.safeParse(v2({ customButtons: [customConfig(A), customConfig(B)] }))
        .success,
    ).toBe(false);
    expect(
      explicitMainMenuV2Schema.safeParse(v2({ customButtons: [customConfig(A), customConfig(A)] }))
        .success,
    ).toBe(false);
  });

  it('refuses a layout whose only enabled button is a custom one (a custom button is always gated)', () => {
    const onlyCustom = v2({
      rows: [[A]],
      buttons: registryConfigs.map((config) => ({ ...config, enabled: false })),
    });
    expect(explicitMainMenuV2Schema.safeParse(onlyCustom).success).toBe(false);
    // The trial and referral buttons are gated too, so they do not count either.
    const gatedOnly = v2({
      rows: [['trial', 'referral', A]],
      buttons: registryConfigs.map((config) => ({
        ...config,
        enabled: config.button === 'trial' || config.button === 'referral',
      })),
    });
    expect(explicitMainMenuV2Schema.safeParse(gatedOnly).success).toBe(false);
    // One ungated registry button on is enough.
    const withOne = v2({
      rows: [['help', A]],
      buttons: registryConfigs.map((config) => ({ ...config, enabled: config.button === 'help' })),
    });
    expect(explicitMainMenuV2Schema.safeParse(withOne).success).toBe(true);
  });

  it('accepts a v2 layout that places no custom button, and parses either version by its v', () => {
    const noCustom = v2({ rows: [['catalog']], customButtons: [] });
    expect(explicitMainMenuV2Schema.safeParse(noCustom).success).toBe(true);
    expect(parseExplicitMainMenu(noCustom).success).toBe(true);
    expect(
      parseExplicitMainMenu({ v: 1, rows: [['catalog']], buttons: registryConfigs }).success,
    ).toBe(true);
    // An unknown version is refused, as v1 refused it before.
    expect(parseExplicitMainMenu({ ...noCustom, v: 3 }).success).toBe(false);
    expect(parseExplicitMainMenu(null).success).toBe(false);
  });
});

describe('D2 the version a layout is written as', () => {
  it('writes v1 whenever no custom button is placed, dropping the custom configurations', () => {
    const noCustom = explicitMainMenuV2Schema.parse(
      v2({ rows: [['catalog', 'services']], customButtons: [] }),
    );
    const written = normalizeExplicitMainMenu(noCustom);
    expect(written.v).toBe(EXPLICIT_MAIN_MENU_VERSION);
    expect('customButtons' in written).toBe(false);
    // And a v1 value parses under the v1 schema exactly as before.
    expect(explicitMainMenuSchema.safeParse(written).success).toBe(true);
  });

  it('writes v2 when a custom button is placed, configured in placement order', () => {
    const placed = explicitMainMenuV2Schema.parse(
      v2({
        rows: [['catalog'], [B, 'services', A]],
        customButtons: [customConfig(A), { ...customConfig(B), style: 'success' }],
      }),
    );
    const written = normalizeExplicitMainMenu(placed);
    expect(written.v).toBe(EXPLICIT_MAIN_MENU_VERSION_V2);
    expect(placedCustomRefs(written)).toEqual([B, A]);
    if (written.v !== 2) throw new Error('unreachable');
    expect(written.customButtons.map((config) => config.ref)).toEqual([B, A]);
    expect(written.customButtons[0]?.style).toBe('success');
  });

  it('is idempotent and compares on meaning, across versions', () => {
    const placed = explicitMainMenuV2Schema.parse(v2());
    const once = normalizeExplicitMainMenu(placed);
    expect(normalizeExplicitMainMenu(once)).toEqual(once);
    const reordered = explicitMainMenuV2Schema.parse(
      v2({ customButtons: [{ style: 'default', enabled: true, ref: A }] }),
    );
    expect(explicitMainMenusEqual(placed, reordered)).toBe(true);
    // Switching the custom button off IS a change.
    const off = explicitMainMenuV2Schema.parse(v2({ customButtons: [customConfig(A, false)] }));
    expect(explicitMainMenusEqual(placed, off)).toBe(false);
    // A v2 layout without a custom button equals the same v1 layout.
    const v1 = explicitMainMenuSchema.parse({
      v: 1,
      rows: [['catalog']],
      buttons: registryConfigs,
    });
    const v2None = explicitMainMenuV2Schema.parse(v2({ rows: [['catalog']], customButtons: [] }));
    expect(explicitMainMenusEqual(v1, v2None)).toBe(true);
  });
});

describe('D2 the compatibility projection never names a custom button', () => {
  const placed = explicitMainMenuV2Schema.parse(
    v2({
      rows: [['catalog', A], ['services'], [B]],
      customButtons: [customConfig(A), customConfig(B)],
    }),
  );

  it('drops custom references and parses under the FROZEN previous parser', () => {
    const projection = legacyProjectionOf(placed);
    expect(projection.map((entry) => entry.button).sort()).toEqual(
      [...MAIN_MENU_BUTTON_IDS].sort(),
    );
    expect(JSON.stringify(projection)).not.toContain('custom');
    expect(frozenLayoutSchema.safeParse(projection).success).toBe(true);
    // The order of the registry buttons is the layout's.
    expect(projection.slice(0, 2).map((entry) => entry.button)).toEqual(['catalog', 'services']);
  });

  it('lists only registry buttons in the unplaced pool', () => {
    const unplaced = unplacedMainMenuButtons(placed);
    expect(unplaced).not.toContain('catalog');
    expect(unplaced.length).toBe(MAIN_MENU_BUTTON_IDS.length - 2);
  });
});

describe('D2 customerRowsOf with custom buttons', () => {
  const layout = explicitMainMenuV2Schema.parse(
    v2({
      rows: [['catalog', A], [B], ['services']],
      customButtons: [{ ...customConfig(A), style: 'primary' }, customConfig(B, false)],
    }),
  );
  const gates = {};

  it('draws a custom button only when its configuration is on AND the server says visible', () => {
    expect(customerRowsOf(layout, gates, { [A]: true, [B]: true })).toEqual([
      [
        { button: 'catalog', style: 'default', iconSlot: null },
        { button: A, style: 'primary', iconSlot: null },
      ],
      [{ button: 'services', style: 'default', iconSlot: null }],
    ]);
  });

  it('hides it for any answer but true, and with no answer at all (always gated)', () => {
    for (const answer of [false, null, undefined]) {
      const rows = customerRowsOf(layout, gates, { [A]: answer, [B]: answer }).flat();
      expect(rows.map((one) => one.button)).not.toContain(A);
    }
    expect(
      customerRowsOf(layout, gates)
        .flat()
        .map((one) => one.button),
    ).toEqual(['catalog', 'services']);
  });

  it('drops a row emptied by hiding, without reflowing the rows after it', () => {
    const only = explicitMainMenuV2Schema.parse(
      v2({ rows: [['help'], [A], ['catalog']], customButtons: [customConfig(A)] }),
    );
    expect(
      customerRowsOf(only, gates, { [A]: false }).map((row) => row.map((b) => b.button)),
    ).toEqual([['help'], ['catalog']]);
  });

  it('draws a v1 layout exactly as before', () => {
    const v1 = explicitMainMenuSchema.parse({
      v: 1,
      rows: [['catalog', 'services']],
      buttons: registryConfigs,
    });
    expect(
      customerRowsOf(v1, gates, { [A]: true })
        .flat()
        .map((one) => one.button),
    ).toEqual(['catalog', 'services']);
  });
});

describe('D2 custom button helpers', () => {
  it('turns an id into a reference and a route value and back, and nothing else', () => {
    const id = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    expect(customMenuRefOf(id.toUpperCase())).toBe(`custom:${id}`);
    expect(customMenuIdOfRef(`custom:${id}`)).toBe(id);
    expect(customMenuRouteValue(id)).toBe(`mb:${id}`);
    expect(customMenuIdOfRoute(`mb:${id}`)).toBe(id);
    // A registry command, a typed lookalike, a missing value and a reference are not routes.
    for (const notARoute of [
      '/start',
      '/catalog',
      `custom:${id}`,
      `mb:${id} `,
      ` mb:${id}`,
      'mb:',
      'mb:abc',
      `MB:${id}`,
      `mb:${id.toUpperCase()}`,
      '',
    ]) {
      expect(customMenuIdOfRoute(notARoute), notARoute).toBeNull();
    }
    expect(customMenuIdOfRoute(undefined)).toBeNull();
    expect(customMenuRouteValue(id).startsWith('/')).toBe(false);
  });

  it('normalises a label: one line, bounded, never a slash command', () => {
    expect(normalizeCustomMenuLabel('  کانال ما  ')).toBe('کانال ما');
    expect(normalizeCustomMenuLabel('')).toBeNull();
    expect(normalizeCustomMenuLabel('   ')).toBeNull();
    expect(normalizeCustomMenuLabel('/start')).toBeNull();
    expect(normalizeCustomMenuLabel('a\nb')).toBeNull();
    expect(normalizeCustomMenuLabel('a\tb')).toBeNull();
    expect(normalizeCustomMenuLabel('x'.repeat(CUSTOM_MENU_LABEL_MAX))).not.toBeNull();
    expect(normalizeCustomMenuLabel('x'.repeat(CUSTOM_MENU_LABEL_MAX + 1))).toBeNull();
    // Code points, not UTF-16 units.
    expect(normalizeCustomMenuLabel('😀'.repeat(CUSTOM_MENU_LABEL_MAX))).not.toBeNull();
    expect(normalizeCustomMenuLabel(42)).toBeNull();
  });

  it('normalises a body within its bound only', () => {
    expect(normalizeCustomMenuBody('  سلام  ', 10)).toBe('سلام');
    expect(normalizeCustomMenuBody('', 10)).toBeNull();
    expect(normalizeCustomMenuBody('x'.repeat(11), 10)).toBeNull();
    expect(normalizeCustomMenuBody('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('accepts only the https grammar the client apps use, and stores it normalised', () => {
    expect(normalizeCustomMenuUrl('https://Example.COM/a?b=1')).toBe('https://example.com/a?b=1');
    for (const bad of [
      'http://example.com',
      'tg://resolve?domain=x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      'https://user:pw@example.com',
      'https://example.com@evil.com',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://exa mple.com',
      'example.com',
      '',
    ]) {
      expect(normalizeCustomMenuUrl(bad), bad).toBeNull();
    }
    expect(normalizeCustomMenuUrl(null)).toBeNull();
  });

  it('decides visibility from the flag, the archive and the sending bot', () => {
    const all = { archivedAt: null, botScope: 'ALL' as const, botInstanceIds: [] };
    const selected = { archivedAt: null, botScope: 'SELECTED' as const, botInstanceIds: ['bot-a'] };
    expect(customMenuButtonVisible(all, true, 'bot-a')).toBe(true);
    expect(customMenuButtonVisible(all, false, 'bot-a')).toBe(false);
    expect(
      customMenuButtonVisible({ ...all, archivedAt: '2026-10-01T00:00:00.000Z' }, true, 'bot-a'),
    ).toBe(false);
    expect(customMenuButtonVisible(selected, true, 'bot-a')).toBe(true);
    expect(customMenuButtonVisible(selected, true, 'bot-b')).toBe(false);
    // No bot named (the builder's tenant-wide view) ignores the bot filter, never the flag.
    expect(customMenuButtonVisible(selected, true, null)).toBe(true);
    expect(customMenuButtonVisible(selected, false, null)).toBe(false);
    // SELECTED with no bot at all is drawn nowhere.
    expect(customMenuButtonVisible({ ...selected, botInstanceIds: [] }, true, 'bot-a')).toBe(false);
  });

  it('validates the create request shape at the boundary, strictly', () => {
    const ok = {
      idempotencyKey: 'key-12345678',
      label: 'کانال',
      kind: 'LINK',
      url: 'https://t.me/x',
    };
    expect(createCustomMenuButtonRequestSchema.safeParse(ok).success).toBe(true);
    expect(createCustomMenuButtonRequestSchema.safeParse({ ...ok, kind: 'VIDEO' }).success).toBe(
      false,
    );
    expect(createCustomMenuButtonRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      createCustomMenuButtonRequestSchema.safeParse({ ...ok, botInstanceIds: ['not-a-uuid'] })
        .success,
    ).toBe(false);
    const parsed = createCustomMenuButtonRequestSchema.parse(ok);
    expect(parsed.botScope).toBe('ALL');
    expect(parsed.file).toBeNull();
  });
});
