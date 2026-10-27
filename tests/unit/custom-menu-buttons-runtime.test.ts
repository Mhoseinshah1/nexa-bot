import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  customMenuRefOf,
  customMenuRouteValue,
  explicitMainMenuSchema,
  explicitMainMenuV2Schema,
  defaultMainMenuButtonConfig,
  MAIN_MENU_BUTTON_IDS,
  type CustomMenuBotScope,
  type CustomMenuButtonKind,
  type FeatureFlagKey,
  type ScopeContext,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  MainMenuLayout,
  type MainMenuSourceAnswer,
} from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import { CustomMenuButtonRuntime } from '../../apps/api/src/modules/control/bot-menu-builder/application/custom-menu-button-runtime';
import type { StoredCustomMenuButton } from '../../apps/api/src/modules/control/bot-menu-builder/application/custom-menu-button.ports';

/**
 * R10 D2 — the customer side of the owner's main-menu buttons, over the REAL
 * `MainMenuLayout` and `CustomMenuButtonRuntime` with in-memory ports: which buttons a bot
 * draws (flag, archive, bot), which labels route, and what a tap answers.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-0000000000aa',
  botInstanceId: null,
} as unknown as ScopeContext;

const BOT_A = '01900000-0000-7000-8000-00000000b0a1';
const BOT_B = '01900000-0000-7000-8000-00000000b0b2';
const ID_ONE = '01900000-0000-7000-8000-00000000c001';
const ID_TWO = '01900000-0000-7000-8000-00000000c002';
const REF_ONE = customMenuRefOf(ID_ONE);
const REF_TWO = customMenuRefOf(ID_TWO);

function button(
  id: string,
  label: string,
  overrides: Partial<StoredCustomMenuButton> & { kind?: CustomMenuButtonKind } = {},
): StoredCustomMenuButton {
  const kind = overrides.kind ?? 'TEXT';
  return {
    id,
    label,
    kind,
    url: kind === 'LINK' ? 'https://example.com/a' : null,
    body: kind === 'TEXT' ? 'سلام' : null,
    botScope: 'ALL' as CustomMenuBotScope,
    botInstanceIds: [],
    media: null,
    version: 1,
    archivedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** A published v2 layout placing both custom buttons next to two registry buttons. */
const PLACED = explicitMainMenuV2Schema.parse({
  v: 2,
  rows: [['catalog', 'services'], [REF_ONE], [REF_TWO]],
  buttons: MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id)),
  customButtons: [
    { ref: REF_ONE, enabled: true, style: 'primary' },
    { ref: REF_TWO, enabled: true, style: 'default' },
  ],
});

function world(options: {
  readonly buttons: readonly StoredCustomMenuButton[];
  readonly flags?: Partial<Record<FeatureFlagKey, boolean>>;
  readonly source?: MainMenuSourceAnswer;
  readonly reads?: { list: number };
}) {
  const source: MainMenuSourceAnswer = options.source ?? {
    kind: 'EXPLICIT',
    layout: PLACED,
    revision: 3,
  };
  const menuSource = {
    snapshotFor: () => Promise.resolve({ source, legacy: DEFAULT_MAIN_MENU_LAYOUT }),
  };
  const runtime = new CustomMenuButtonRuntime({
    repository: {
      list: () => {
        if (options.reads !== undefined) options.reads.list += 1;
        return Promise.resolve([...options.buttons]);
      },
      find: (_scope, id) => Promise.resolve(options.buttons.find((one) => one.id === id) ?? null),
      readMedia: () => Promise.resolve(null),
    },
    features: {
      isEnabled: (_scope, key) => Promise.resolve(options.flags?.[key] ?? false),
    },
    source: menuSource,
  });
  const menu = new MainMenuLayout({
    source: menuSource,
    customButtons: runtime,
    settings: { valueOf: <T>() => Promise.resolve(DEFAULT_MAIN_MENU_LAYOUT as T) },
    features: { isEnabled: (_scope, key) => Promise.resolve(options.flags?.[key] ?? false) },
    trials: { anyOffered: () => Promise.resolve(false) },
    templates: {
      render: (_scope, key: TemplateKey) =>
        Promise.resolve((CATALOGUE_FA as Record<string, string>)[key] ?? ''),
    },
  });
  return { runtime, menu };
}

const ON = { custom_menu_buttons: true } as const;
const textsOf = (rows: readonly (readonly { text: string }[])[]) =>
  rows.map((row) => row.map((one) => one.text));

describe('the keyboard a bot draws', () => {
  const two = [button(ID_ONE, 'کانال ما'), button(ID_TWO, 'قوانین')];

  it('draws the custom buttons in their rows, with their style, when the flag is on', async () => {
    const { menu } = world({ buttons: two, flags: ON });
    const rows = await menu.keyboardFor(scope, { botInstanceId: BOT_A });
    expect(textsOf(rows).slice(1)).toEqual([['کانال ما'], ['قوانین']]);
    expect(rows[1]?.[0]?.style).toBe('primary');
  });

  it('draws no custom button while the flag is off, and reads no row for it', async () => {
    const reads = { list: 0 };
    const { menu } = world({ buttons: two, reads });
    const rows = await menu.keyboardFor(scope, { botInstanceId: BOT_A });
    expect(textsOf(rows).flat()).not.toContain('کانال ما');
    expect(textsOf(rows).flat()).not.toContain('قوانین');
    expect(reads.list).toBe(0);
  });

  it('draws a button scoped to bot A on bot A and not on bot B', async () => {
    const scoped = [
      button(ID_ONE, 'کانال ما', { botScope: 'SELECTED', botInstanceIds: [BOT_A] }),
      button(ID_TWO, 'قوانین'),
    ];
    const { menu } = world({ buttons: scoped, flags: ON });
    const onA = textsOf(await menu.keyboardFor(scope, { botInstanceId: BOT_A })).flat();
    const onB = textsOf(await menu.keyboardFor(scope, { botInstanceId: BOT_B })).flat();
    expect(onA).toContain('کانال ما');
    expect(onB).not.toContain('کانال ما');
    // The other button is on every bot.
    expect(onB).toContain('قوانین');
    // A view naming no bot (the builder's) ignores the bot filter, never the flag.
    const none = textsOf(await menu.keyboardFor(scope)).flat();
    expect(none).toContain('کانال ما');
  });

  it('does not draw an archived button', async () => {
    const archived = [
      button(ID_ONE, 'کانال ما', { archivedAt: new Date('2026-10-02T00:00:00Z') }),
      button(ID_TWO, 'قوانین'),
    ];
    const { menu } = world({ buttons: archived, flags: ON });
    const drawn = textsOf(await menu.keyboardFor(scope, { botInstanceId: BOT_A })).flat();
    expect(drawn).not.toContain('کانال ما');
    expect(drawn).toContain('قوانین');
  });

  it('never asks about custom buttons on a layout that places none (v1, or legacy)', async () => {
    const v1 = explicitMainMenuSchema.parse({
      v: 1,
      rows: [['catalog', 'services']],
      buttons: MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id)),
    });
    const reads = { list: 0 };
    const { menu } = world({
      buttons: two,
      flags: ON,
      reads,
      source: { kind: 'EXPLICIT', layout: v1, revision: 1 },
    });
    await menu.keyboardFor(scope, { botInstanceId: BOT_A });
    const legacy = world({
      buttons: two,
      flags: ON,
      reads,
      source: { kind: 'LEGACY', superseded: false, publishedUnreadable: true },
    });
    const rows = await legacy.menu.keyboardFor(scope, { botInstanceId: BOT_A });
    expect(reads.list).toBe(0);
    expect(textsOf(rows).flat()).not.toContain('کانال ما');
  });

  it('draws nothing for a button the layout places but the server cannot find', async () => {
    const { menu } = world({ buttons: [button(ID_TWO, 'قوانین')], flags: ON });
    const drawn = textsOf(await menu.keyboardFor(scope, { botInstanceId: BOT_A })).flat();
    expect(drawn).not.toContain('کانال ما');
    expect(drawn).toContain('قوانین');
  });
});

describe('the route table', () => {
  it('maps a custom label to mb:<id>, never to a slash command', async () => {
    const { menu } = world({ buttons: [button(ID_ONE, 'کانال ما')], flags: ON });
    const routes = await menu.routesFor(scope);
    expect(routes.get('کانال ما')).toBe(customMenuRouteValue(ID_ONE));
    expect(routes.get('کانال ما')?.startsWith('/')).toBe(false);
    // The registry buttons route as before.
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });

  it('lets a registry label win a collision, and routes an archived label to nothing the live one holds', async () => {
    const catalogLabel = CATALOGUE_FA['bot.menu.catalog'];
    const { menu } = world({
      buttons: [
        button(ID_ONE, catalogLabel),
        button(ID_TWO, 'قدیمی', { archivedAt: new Date('2026-10-02T00:00:00Z') }),
        button('01900000-0000-7000-8000-00000000c003', 'قدیمی'),
      ],
      flags: ON,
    });
    const routes = await menu.routesFor(scope);
    expect(routes.get(catalogLabel)).toBe('/catalog');
    // The live button holding a label an archived one once held wins it.
    expect(routes.get('قدیمی')).toBe(customMenuRouteValue('01900000-0000-7000-8000-00000000c003'));
  });

  it('still routes an ARCHIVED button, so a stale keyboard is answered "unavailable"', async () => {
    const { menu } = world({
      buttons: [button(ID_ONE, 'کانال ما', { archivedAt: new Date('2026-10-02T00:00:00Z') })],
      flags: ON,
    });
    expect((await menu.routesFor(scope)).get('کانال ما')).toBe(customMenuRouteValue(ID_ONE));
  });

  it('routes a stale keyboard even while the flag is off (the tap itself says unavailable)', async () => {
    const { menu } = world({ buttons: [button(ID_ONE, 'کانال ما')] });
    expect((await menu.routesFor(scope)).get('کانال ما')).toBe(customMenuRouteValue(ID_ONE));
  });
});

describe('the answer to a tap', () => {
  const textButton = button(ID_ONE, 'کانال ما', { body: 'متن من' });

  it('answers the stored text of a button that is on, placed and shown on this bot', async () => {
    const { runtime } = world({ buttons: [textButton], flags: ON });
    expect(await runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({ outcome: 'TEXT', text: 'متن من' });
  });

  it('answers a link with the stored https address and the optional note', async () => {
    const link = button(ID_ONE, 'کانال ما', { kind: 'LINK', body: 'یادداشت' });
    const { runtime } = world({ buttons: [link], flags: ON });
    expect(await runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({
      outcome: 'LINK',
      url: 'https://example.com/a',
      note: 'یادداشت',
    });
  });

  it('is unavailable with the flag off', async () => {
    const { runtime } = world({ buttons: [textButton] });
    expect(await runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({ outcome: 'UNAVAILABLE' });
  });

  it('is unavailable from a bot the button is not shown on', async () => {
    const scoped = button(ID_ONE, 'کانال ما', { botScope: 'SELECTED', botInstanceIds: [BOT_A] });
    const { runtime } = world({ buttons: [scoped], flags: ON });
    expect((await runtime.forTap(scope, ID_ONE, BOT_A)).outcome).toBe('TEXT');
    expect(await runtime.forTap(scope, ID_ONE, BOT_B)).toEqual({ outcome: 'UNAVAILABLE' });
  });

  it('is unavailable for an archived or an unknown button', async () => {
    const archived = button(ID_ONE, 'کانال ما', { archivedAt: new Date('2026-10-02T00:00:00Z') });
    const { runtime } = world({ buttons: [archived], flags: ON });
    expect(await runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(await runtime.forTap(scope, ID_TWO, BOT_A)).toEqual({ outcome: 'UNAVAILABLE' });
  });

  it('is unavailable unless the PUBLISHED layout places the button with its switch on', async () => {
    const off = explicitMainMenuV2Schema.parse({
      ...PLACED,
      customButtons: [
        { ref: REF_ONE, enabled: false, style: 'default' },
        { ref: REF_TWO, enabled: true, style: 'default' },
      ],
    });
    const switchedOff = world({
      buttons: [textButton],
      flags: ON,
      source: { kind: 'EXPLICIT', layout: off, revision: 4 },
    });
    expect(await switchedOff.runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({
      outcome: 'UNAVAILABLE',
    });
    // Not placed at all: a v2 layout that places only the other button, and a v1 layout.
    const other = explicitMainMenuV2Schema.parse({
      ...PLACED,
      rows: [['catalog'], [REF_TWO]],
      customButtons: [{ ref: REF_TWO, enabled: true, style: 'default' }],
    });
    const unplaced = world({
      buttons: [textButton],
      flags: ON,
      source: { kind: 'EXPLICIT', layout: other, revision: 4 },
    });
    expect(await unplaced.runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({
      outcome: 'UNAVAILABLE',
    });
    // The keyboard fell back to the legacy path (superseded, unreadable): nothing custom is drawn.
    const legacy = world({
      buttons: [textButton],
      flags: ON,
      source: { kind: 'LEGACY', superseded: true, publishedUnreadable: false },
    });
    expect(await legacy.runtime.forTap(scope, ID_ONE, BOT_A)).toEqual({ outcome: 'UNAVAILABLE' });
  });
});
