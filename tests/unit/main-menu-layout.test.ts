import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPLICIT_MAIN_MENU,
  DEFAULT_MAIN_MENU_LAYOUT,
  defaultMainMenuButtonConfig,
  explicitFromLegacy,
  explicitMainMenuSchema,
  type ExplicitMainMenu,
  type OperationalEventInput,
  MAIN_MENU_BUTTON_IDS,
  MAIN_MENU_BUTTONS,
  MAIN_MENU_TARGETS,
  MENU_APPEARANCE_SLOTS,
  mainMenuButton,
  mainMenuButtonIsGated,
  mainMenuEntryOf,
  mainMenuLayoutSchema,
  mainMenuTargetOf,
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
import {
  MainMenuLayout,
  type MainMenuSourceAnswer,
} from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import { PublishedMainMenuSource } from '../../apps/api/src/modules/control/bot-menu-builder/application/main-menu-source';
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
  /** F5: whether any panel offers a trial now — the trial button's one gate. */
  readonly trialOffered?: boolean;
  readonly labels?: Partial<Record<TemplateKey, string>>;
  /** Counts the offer reads, so a test can see when the gate is asked. */
  readonly offerReads?: { count: number };
  /** Round T: the published-layout source; absent is the legacy path. */
  readonly source?: MainMenuSourceAnswer;
}): MainMenuLayout {
  const answer = options.source;
  return new MainMenuLayout({
    ...(answer === undefined
      ? {}
      : {
          source: {
            snapshotFor: () =>
              Promise.resolve({
                source: answer,
                legacy: options.stored ?? DEFAULT_MAIN_MENU_LAYOUT,
              }),
          },
        }),
    settings: {
      valueOf: <T>() => Promise.resolve((options.stored ?? DEFAULT_MAIN_MENU_LAYOUT) as T),
    },
    features: { isEnabled: (_scope, key) => Promise.resolve(options.flags?.[key] ?? false) },
    trials: {
      anyOffered: () => {
        if (options.offerReads !== undefined) options.offerReads.count += 1;
        return Promise.resolve(options.trialOffered ?? false);
      },
    },
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
    // Only the gated buttons left on: a flag switched off, or no panel offering a trial,
    // would empty the keyboard.
    const onlyGated = MAIN_MENU_BUTTONS.map((button) => ({
      button: button.id,
      enabled: mainMenuButtonIsGated(button),
    }));
    expect(onlyGated.filter((entry) => entry.enabled).map((entry) => entry.button)).toEqual([
      'trial',
      'referral',
    ]);
    expect(mainMenuLayoutSchema.safeParse(onlyGated).success).toBe(false);
    // F5: the trial button is gated by a panel offer, not by a flag — so a keyboard with
    // only the trial on is empty whenever no panel offers one, and is refused.
    expect(mainMenuButton('trial')).toMatchObject({ feature: null, needsTrialOffer: true });
    const onlyTrial = MAIN_MENU_BUTTONS.map((button) => ({
      button: button.id,
      enabled: button.id === 'trial',
    }));
    expect(mainMenuLayoutSchema.safeParse(onlyTrial).success).toBe(false);
    // The registry holds it under this schema, with the default in force.
    expect(settingDefinition('bot.main_menu').schema.safeParse(onlyGated).success).toBe(false);
    expect(settingDefinition('bot.main_menu').defaultValue).toEqual(DEFAULT_MAIN_MENU_LAYOUT);
  });
});

describe('the main-menu item model (round P: target and appearance slot)', () => {
  it('pins each button to its declared action and refuses any other target', () => {
    for (const button of MAIN_MENU_BUTTONS) {
      expect(mainMenuTargetOf(button.id)).toBe(button.command);
      expect((MAIN_MENU_TARGETS as readonly string[]).includes(button.command)).toBe(true);
    }
    expect(
      mainMenuLayoutSchema.safeParse([{ button: 'wallet', enabled: true, target: 'wallet' }])
        .success,
    ).toBe(true);
    // A wallet button that opened the catalogue would mis-sell; refused at the schema.
    expect(
      mainMenuLayoutSchema.safeParse([{ button: 'wallet', enabled: true, target: 'catalog' }])
        .success,
    ).toBe(false);
    // And no target outside the closed set — `start` is a command, not a button.
    expect(
      mainMenuLayoutSchema.safeParse([{ button: 'wallet', enabled: true, target: 'start' }])
        .success,
    ).toBe(false);
    expect(
      mainMenuLayoutSchema.safeParse([{ button: 'wallet', enabled: true, target: 'lottery' }])
        .success,
    ).toBe(false);
  });

  it('validates the appearance slot against the closed list, and resolves the default', () => {
    expect(
      mainMenuLayoutSchema.safeParse([
        { button: 'wallet', enabled: true, target: 'wallet', appearanceSlot: 'payment' },
      ]).success,
    ).toBe(true);
    expect(
      mainMenuLayoutSchema.safeParse([
        { button: 'wallet', enabled: true, appearanceSlot: '<b>x</b>' },
      ]).success,
    ).toBe(false);
    const resolved = resolveMainMenuLayout([
      { button: 'wallet', enabled: true, appearanceSlot: 'payment' },
      { button: 'catalog', enabled: false },
    ]);
    expect(resolved[0]).toEqual({
      button: 'wallet',
      enabled: true,
      target: 'wallet',
      appearanceSlot: 'payment',
      appearanceSlotOverridden: true,
    });
    expect(resolved[1]).toEqual({
      button: 'catalog',
      enabled: false,
      target: 'catalog',
      appearanceSlot: mainMenuButton('catalog').appearanceSlot,
      appearanceSlotOverridden: false,
    });
    // Every button names a slot the closed list knows.
    for (const button of MAIN_MENU_BUTTONS) {
      expect((MENU_APPEARANCE_SLOTS as readonly string[]).includes(button.appearanceSlot)).toBe(
        true,
      );
    }
    // Stored back, a default slot is null and a chosen one is kept.
    expect(mainMenuEntryOf(resolved[0]!)).toEqual({
      button: 'wallet',
      enabled: true,
      target: 'wallet',
      appearanceSlot: 'payment',
    });
    expect(mainMenuEntryOf(resolved[1]!).appearanceSlot).toBeNull();
  });

  it('keeps an R1-shaped stored value (no target, no slot) valid and complete', () => {
    const stored: MainMenuLayoutEntry[] = [{ button: 'wallet', enabled: true }];
    expect(mainMenuLayoutSchema.safeParse(stored).success).toBe(true);
    expect(resolveMainMenuLayout(stored).map((item) => item.target)).toEqual([
      'wallet',
      'catalog',
      'services',
      'help',
      'trial',
      'referral',
      'apps',
      'tickets',
    ]);
  });
});

describe('MainMenuLayout — the keyboard and the route table from one object', () => {
  it('reflects a rename and a reorder on the very next render, with no cache in between', async () => {
    let stored: MainMenuLayoutEntry[] = [
      { button: 'catalog', enabled: true },
      { button: 'wallet', enabled: true },
    ];
    let walletLabel = CATALOGUE_FA['bot.menu.wallet'];
    const layout = new MainMenuLayout({
      settings: { valueOf: <T>() => Promise.resolve(stored as T) },
      features: { isEnabled: () => Promise.resolve(false) },
      trials: { anyOffered: () => Promise.resolve(false) },
      templates: {
        render: (_scope, key) =>
          Promise.resolve(
            key === 'bot.menu.wallet'
              ? walletLabel
              : ((CATALOGUE_FA as Record<string, string>)[key] ?? ''),
          ),
      },
    });
    expect((await layout.rowsFor(scope))[0]).toEqual([
      CATALOGUE_FA['bot.menu.catalog'],
      CATALOGUE_FA['bot.menu.wallet'],
    ]);
    // The operator reorders and renames; the next render is the new keyboard.
    stored = [
      { button: 'wallet', enabled: true },
      { button: 'catalog', enabled: true },
    ];
    walletLabel = '💳 موجودی';
    expect((await layout.rowsFor(scope))[0]).toEqual([
      '💳 موجودی',
      CATALOGUE_FA['bot.menu.catalog'],
    ]);
    // And a tap on the new label routes; the shared default keeps routing in the runtime's table.
    expect((await layout.routesFor(scope)).get('💳 موجودی')).toBe('/wallet');
  });

  it("reads a switched-off item's gate only when asked to — the Web Admin's preview (Codex #6)", async () => {
    const reads = { count: 0 };
    const layout = layoutWith({
      stored: [{ button: 'trial', enabled: false }],
      trialOffered: false,
      offerReads: reads,
    });
    // The keyboard: an off item is not drawn, so its gate is not asked.
    const forKeyboard = (await layout.describeFor(scope)).find(
      (one) => one.item.button === 'trial',
    );
    expect(forKeyboard).toMatchObject({ gate: 'TRIAL_OFFER', gateOpen: null, shown: false });
    expect(reads.count).toBe(0);
    // The page: the gate is answered for an off item too, so switching it on previews truly.
    const forPage = (await layout.describeFor(scope, { gatesForHidden: true })).find(
      (one) => one.item.button === 'trial',
    );
    expect(forPage).toMatchObject({ gate: 'TRIAL_OFFER', gateOpen: false, shown: false });
    expect(reads.count).toBe(1);
  });

  it('describes every item with the decision the keyboard makes, gates read only when needed', async () => {
    const reads = { count: 0 };
    const layout = layoutWith({
      stored: [
        { button: 'trial', enabled: false },
        { button: 'referral', enabled: true },
      ],
      flags: { referrals: false },
      trialOffered: true,
      offerReads: reads,
    });
    const described = await layout.describeFor(scope);
    expect(described.map((one) => [one.item.button, one.gate, one.gateOpen, one.shown])).toEqual([
      // Switched off: its gate is not asked (null), and it is not shown.
      ['trial', 'TRIAL_OFFER', null, false],
      // On, but its feature is off: no dead button.
      ['referral', 'FEATURE', false, false],
      ['catalog', null, null, true],
      ['services', null, null, true],
      ['wallet', null, null, true],
      ['help', null, null, true],
      ['apps', null, null, true],
      ['tickets', null, null, true],
    ]);
    expect(reads.count).toBe(0);
    // `buttonsFor` is exactly the shown subset of the same answer.
    expect((await layout.buttonsFor(scope)).map((button) => button.id)).toEqual(
      described.filter((one) => one.shown).map((one) => one.item.button),
    );
  });

  it('draws the operator’s order, without switched-off buttons, and a gated one only while its gate is open', async () => {
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
    const on = layoutWith({ stored, flags: { referrals: true }, trialOffered: true });
    expect(await on.rowsFor(scope)).toEqual([
      [CATALOGUE_FA['bot.menu.referral'], CATALOGUE_FA['bot.menu.catalog']],
      [CATALOGUE_FA['bot.menu.trial'], CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.help']],
      [CATALOGUE_FA['bot.menu.apps']],
      [CATALOGUE_FA['bot.menu.tickets']],
    ]);
  });

  it('draws the trial button exactly while a panel offers a trial, whatever any flag says (F5)', async () => {
    /*
     * The owner's F5 rule: per-panel trials are authoritative. Every flag on and no panel
     * offering a trial draws no trial button; every flag off and a panel offering one
     * draws it. The trial has no flag to consult.
     */
    const everyFlag = Object.fromEntries(
      ['referrals', 'custom_service', 'customer_link_rotation', 'customer_refund_requests'].map(
        (key) => [key, true],
      ),
    ) as Partial<Record<FeatureFlagKey, boolean>>;
    const trialLabel = CATALOGUE_FA['bot.menu.trial'];
    const noOffer = layoutWith({ flags: everyFlag, trialOffered: false });
    expect((await noOffer.rowsFor(scope)).flat()).not.toContain(trialLabel);
    const offer = layoutWith({ flags: {}, trialOffered: true });
    expect((await offer.rowsFor(scope)).flat()).toContain(trialLabel);
    // The operator's own switch still hides it, and then the offer is not even asked.
    const reads = { count: 0 };
    const switchedOff = layoutWith({
      stored: [{ button: 'trial', enabled: false }],
      trialOffered: true,
      offerReads: reads,
    });
    expect((await switchedOff.rowsFor(scope)).flat()).not.toContain(trialLabel);
    expect(reads.count).toBe(0);
    // A hidden trial button still routes, so a keyboard already in a chat keeps working.
    expect((await noOffer.routesFor(scope)).get(trialLabel)).toBe('/trial');
  });

  it('labels the keyboard with the tenant’s text, and routes that same text', async () => {
    const layout = layoutWith({
      trialOffered: true,
      labels: { 'bot.menu.trial': '🎁 تست رایگان' },
    });
    expect((await layout.rowsFor(scope)).flat()).toContain('🎁 تست رایگان');
    const routes = await layout.routesFor(scope);
    expect(routes.get('🎁 تست رایگان')).toBe('/trial');
    expect(routes.get(CATALOGUE_FA['bot.menu.referral'])).toBe('/referral');
    // A hidden button still routes: a keyboard already in a chat keeps working.
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });

  it('routes no label that reads as a slash command (Codex, PR #111)', async () => {
    const layout = layoutWith({ labels: { 'bot.menu.wallet': '/start' } });
    const routes = await layout.routesFor(scope);
    expect(routes.has('/start')).toBe(false);
    expect([...routes.values()]).not.toContain('/wallet');
  });

  it('gives a label two buttons share to the first declared one', async () => {
    const layout = layoutWith({ labels: { 'bot.menu.wallet': CATALOGUE_FA['bot.menu.catalog'] } });
    expect((await layout.routesFor(scope)).get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
  });
});

describe('round T: the keyboard from a PUBLISHED explicit layout', () => {
  const explicit: ExplicitMainMenu = {
    v: 1,
    rows: [['trial', 'wallet', 'catalog'], ['referral'], ['help']],
    buttons: MAIN_MENU_BUTTON_IDS.map((id) => ({
      ...defaultMainMenuButtonConfig(id),
      enabled: id !== 'catalog',
      style: id === 'wallet' ? ('danger' as const) : ('default' as const),
      iconSlot: id === 'wallet' ? ('payment' as const) : null,
    })),
  };
  const published = (layout: ExplicitMainMenu): MainMenuSourceAnswer => ({
    kind: 'EXPLICIT',
    layout,
    revision: 1,
  });

  it('draws the operator’s rows with style and icon slot (restored 2026-10-05), hidden buttons leaving a gap and never a reflow', async () => {
    const layout = layoutWith({ source: published(explicit), trialOffered: false });
    expect(await layout.keyboardFor(scope)).toEqual([
      [{ text: CATALOGUE_FA['bot.menu.wallet'], style: 'danger', iconSlot: 'payment' }],
      [{ text: CATALOGUE_FA['bot.menu.help'], style: 'default', iconSlot: null }],
    ]);
    // `rowsFor` is the text-only view of the same rows — what the transport draws until T2.
    expect(await layout.rowsFor(scope)).toEqual([
      [CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.help']],
    ]);
    const open = layoutWith({
      source: published(explicit),
      trialOffered: true,
      flags: { referrals: true },
    });
    expect(await open.rowsFor(scope)).toEqual([
      [CATALOGUE_FA['bot.menu.trial'], CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.referral']],
      [CATALOGUE_FA['bot.menu.help']],
    ]);
  });

  it('ignores bot.main_menu while a layout is published, and routes every declared button still', async () => {
    const layout = layoutWith({
      source: published(explicit),
      stored: [{ button: 'help', enabled: false }],
    });
    expect((await layout.rowsFor(scope)).flat()).toContain(CATALOGUE_FA['bot.menu.help']);
    const routes = await layout.routesFor(scope);
    // Unplaced and disabled buttons route too: a keyboard already in a chat keeps working.
    expect(routes.get(CATALOGUE_FA['bot.menu.catalog'])).toBe('/catalog');
    expect(routes.get(CATALOGUE_FA['bot.menu.tickets'])).toBe('/tickets');
  });

  it('describes placed buttons row-major, then the pool switched off', async () => {
    const described = await layoutWith({ source: published(explicit) }).describeFor(scope);
    expect(described.map((one) => [one.item.button, one.item.enabled])).toEqual([
      ['trial', true],
      ['wallet', true],
      ['catalog', false],
      ['referral', true],
      ['help', true],
      ['services', false],
      ['apps', false],
      ['tickets', false],
    ]);
  });

  it('Item 1 (Phase 2): for 300 generated layouts the keyboard is the SAVED order exactly — rows, positions, style and icon', async () => {
    // A small deterministic generator: any permutation, any split into rows, any switch.
    let seed = 20261005;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const styles = ['default', 'primary', 'success', 'danger'] as const;
    let checked = 0;
    for (let run = 0; run < 300; run += 1) {
      const ids = [...MAIN_MENU_BUTTON_IDS].sort(() => next() - 0.5);
      const placed = ids.slice(0, 1 + Math.floor(next() * ids.length));
      const rows: (typeof placed)[] = [];
      for (const id of placed) {
        if (rows.length === 0 || next() < 0.4) rows.push([id]);
        else rows[rows.length - 1]?.push(id);
      }
      const buttons = MAIN_MENU_BUTTON_IDS.map((id) => ({
        ...defaultMainMenuButtonConfig(id),
        // The first placed button stays on, so the layout is one the schema accepts.
        enabled: id === placed[0] || next() < 0.8,
        style: styles[Math.floor(next() * styles.length)] ?? 'default',
        iconSlot: next() < 0.3 ? ('wallet' as const) : null,
      }));
      const layout: ExplicitMainMenu = { v: 1, rows, buttons };
      if (!explicitMainMenuSchema.safeParse(layout).success) continue;
      const keyboard = await layoutWith({
        source: published(layout),
        trialOffered: true,
        flags: { referrals: true },
      }).keyboardFor(scope);
      const byId = new Map(buttons.map((one) => [one.button, one]));
      const expected = rows
        .map((row) =>
          row
            .filter((id) => byId.get(id)?.enabled === true)
            .map((id) => ({
              text: CATALOGUE_FA[mainMenuButton(id).label],
              style: byId.get(id)?.style,
              iconSlot: byId.get(id)?.iconSlot,
            })),
        )
        .filter((row) => row.length > 0);
      expect(keyboard, JSON.stringify(layout.rows)).toEqual(expected);
      checked += 1;
    }
    // Most generated layouts are valid; the property was not vacuously true.
    expect(checked).toBeGreaterThan(200);
  });

  it('a LEGACY answer (nothing published, superseded, unreadable) is today’s keyboard exactly', async () => {
    for (const source of [
      { kind: 'LEGACY', superseded: false, publishedUnreadable: false },
      { kind: 'LEGACY', superseded: true, publishedUnreadable: false },
      { kind: 'LEGACY', superseded: false, publishedUnreadable: true },
    ] as const) {
      const stored: MainMenuLayoutEntry[] = [{ button: 'apps', enabled: true }];
      expect(await layoutWith({ source, stored }).keyboardFor(scope)).toEqual(
        (await layoutWith({ stored }).rowsFor(scope)).map((row) =>
          row.map((text) => ({ text, style: 'default', iconSlot: null })),
        ),
      );
    }
  });

  it('the converted default is the default keyboard', async () => {
    expect(DEFAULT_EXPLICIT_MAIN_MENU).toEqual(explicitFromLegacy(DEFAULT_MAIN_MENU_LAYOUT));
    const flags = { referrals: true };
    expect(
      await layoutWith({
        source: published(DEFAULT_EXPLICIT_MAIN_MENU),
        flags,
        trialOffered: true,
      }).rowsFor(scope),
    ).toEqual(await layoutWith({ flags, trialOffered: true }).rowsFor(scope));
  });
});

describe('round T: PublishedMainMenuSource — published only, and only while its projection is current', () => {
  const head = (overrides: Record<string, unknown> = {}) => ({
    published: DEFAULT_EXPLICIT_MAIN_MENU,
    publishedRevision: 4,
    projectionSettingVersion: 7,
    settingVersion: 7,
    ...overrides,
  });
  /** A source over ONE state read, as `readMenuState` answers it. */
  const sourceOver = (
    answer: ReturnType<typeof head> | null,
    events: OperationalEventInput[] = [],
  ) => {
    const legacy = [{ button: 'help', enabled: true }];
    const settingVersion = answer === null ? 3 : answer.settingVersion;
    return new PublishedMainMenuSource(
      {
        readMenuState: () =>
          Promise.resolve({
            layout:
              answer === null
                ? null
                : ({
                    published: answer.published,
                    publishedRevision: answer.publishedRevision,
                    projectionSettingVersion: answer.projectionSettingVersion,
                  } as never),
            setting:
              settingVersion === null
                ? null
                : {
                    value: legacy,
                    version: settingVersion as number,
                    updatedAt: new Date(0),
                    updatedByAdminId: null,
                  },
          }),
      },
      {
        // The resolver's own rule is the integration suite's; here, the row as read.
        resolveStored: (_scope, _key, row) =>
          Promise.resolve({
            value: row?.value ?? DEFAULT_MAIN_MENU_LAYOUT,
            version: row?.version ?? null,
          } as never),
      },
      {
        record: (_scope, event) => {
          events.push(event);
          return Promise.resolve({} as never);
        },
      },
    );
  };
  const currentFor = async (source: PublishedMainMenuSource) =>
    (await source.snapshotFor(scope)).source;

  it('takes the legacy value from the SAME read as the head', async () => {
    expect((await sourceOver(null).snapshotFor(scope)).legacy).toEqual([
      { button: 'help', enabled: true },
    ]);
  });

  it('answers EXPLICIT for a readable, current publish', async () => {
    expect(await currentFor(sourceOver(head()))).toEqual({
      kind: 'EXPLICIT',
      layout: DEFAULT_EXPLICIT_MAIN_MENU,
      revision: 4,
    });
  });

  it('answers LEGACY with nothing published, and with the setting moved (superseded)', async () => {
    expect(await currentFor(sourceOver(null))).toEqual({
      kind: 'LEGACY',
      superseded: false,
      publishedUnreadable: false,
    });
    expect(await currentFor(sourceOver(head({ settingVersion: 8 })))).toEqual({
      kind: 'LEGACY',
      superseded: true,
      publishedUnreadable: false,
    });
    // A setting row that vanished is not "current" either.
    expect((await currentFor(sourceOver(head({ settingVersion: null })))).kind).toBe('LEGACY');
  });

  it('answers LEGACY for an unreadable snapshot and records it once per tenant key', async () => {
    const events: OperationalEventInput[] = [];
    const answer = await currentFor(sourceOver(head({ published: { v: 2, rows: [] } }), events));
    expect(answer).toEqual({ kind: 'LEGACY', superseded: false, publishedUnreadable: true });
    expect(events.map((event) => [event.code, event.severity, event.dedupeKey])).toEqual([
      ['bot_menu.published_unreadable', 'WARN', 'bot_menu.published_unreadable:published'],
    ]);
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
