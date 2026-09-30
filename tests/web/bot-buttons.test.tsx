import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  BOT_COMMANDS,
  MAIN_MENU_BUTTONS,
  mainMenuButton,
  mainMenuButtonIsGated,
  templateDefinition,
  templateViewSchema,
  type BotCommandSyncView,
  type MainMenuItemView,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { BotButtonsPage, syncErrorHint } from '../../apps/web/src/pages/bot-buttons';
import { PanelTrialTab } from '../../apps/web/src/pages/panel-trial';
import { NAV, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * R1 + round P on the Web Admin: «دکمه‌های ربات» and the panel's «سرویس تست» tab.
 *
 * The bot-buttons page reads ONE endpoint (`/bot-menu`): each item with the keyboard's
 * own decision about it, the command list, and every bot's sync state. It writes through
 * the endpoints that already exist — the arrangement (order, on/off, appearance slot) as
 * `bot.main_menu` with its version, the labels as `bot.menu.*` templates. The trial tab
 * sends the whole configuration with its revision, the traffic as a figure and a unit.
 */

const view = (key: TemplateKey, body: string) => {
  const definition = templateDefinition(key);
  return templateViewSchema.parse({
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body,
    defaultBody: body,
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
};

const BOT_A1 = '01900000-0000-7000-8000-00000000a001';
const BOT_A2 = '01900000-0000-7000-8000-00000000a002';

/** One item as the server describes it: the declared default, adjustable per test. */
function item(
  id: MainMenuItemView['id'],
  order: number,
  overrides: Partial<MainMenuItemView> = {},
): MainMenuItemView {
  const button = mainMenuButton(id);
  return {
    id,
    order,
    enabled: true,
    target: button.command,
    label: CATALOGUE_FA[button.label],
    defaultLabel: CATALOGUE_FA[button.label],
    labelOverridden: false,
    appearanceSlot: button.appearanceSlot,
    defaultAppearanceSlot: button.appearanceSlot,
    wide: button.wide,
    gate: button.needsTrialOffer ? 'TRIAL_OFFER' : button.feature !== null ? 'FEATURE' : null,
    gateOpen: button.needsTrialOffer || button.feature !== null ? false : null,
    shownNow: !button.needsTrialOffer && button.feature === null,
    ...overrides,
  };
}

const syncView = (overrides: Partial<BotCommandSyncView> = {}): BotCommandSyncView => ({
  botInstanceId: BOT_A1,
  username: 'acme_store_bot',
  botStatus: 'ACTIVE',
  state: 'CURRENT',
  desiredHash: 'abcdef0123456789abcdef0123456789',
  desiredVersion: 3,
  syncedHash: 'abcdef0123456789abcdef0123456789',
  lastSyncedAt: '2026-09-30T10:00:00.000Z',
  lastAttemptedAt: '2026-09-30T10:00:00.000Z',
  lastErrorCode: null,
  attempts: 0,
  nextAttemptAt: null,
  ...overrides,
});

function api(
  options: {
    items?: readonly MainMenuItemView[];
    bots?: readonly BotCommandSyncView[];
    labels?: Record<string, string>;
    version?: number | null;
  } = {},
) {
  const items =
    options.items ??
    MAIN_MENU_BUTTONS.map((button, order) =>
      item(button.id, order, {
        label: options.labels?.[button.label] ?? CATALOGUE_FA[button.label],
        labelOverridden: options.labels?.[button.label] !== undefined,
      }),
    );
  const keyboard = [items.filter((one) => one.shownNow).map((one) => one.label)];
  return stubApi([
    {
      url: '/bot-menu/sync',
      body: {
        results: [{ botInstanceId: BOT_A1, outcome: 'SYNCED', errorCode: null }],
        bots: options.bots ?? [syncView()],
      },
    },
    {
      url: '/bot-menu/check',
      body: {
        checkedAt: '2026-09-30T10:05:00.000Z',
        checks: [
          {
            botInstanceId: BOT_A1,
            outcome: 'READ',
            matches: false,
            registered: [{ command: 'start', description: 'شروع' }],
          },
        ],
        desired: BOT_COMMANDS.map((entry) => ({
          command: entry.command,
          description: CATALOGUE_FA[entry.description],
        })),
      },
    },
    {
      url: '/bot-menu',
      body: {
        layout: {
          version: options.version === undefined ? 7 : options.version,
          storedValueInvalid: false,
          items,
        },
        keyboard,
        commands: {
          hash: 'abcdef0123456789abcdef0123456789',
          entries: BOT_COMMANDS.map((entry) => ({
            command: entry.command,
            description: CATALOGUE_FA[entry.description],
          })),
        },
        bots: options.bots ?? [syncView()],
      },
    },
    { url: '/settings/bot.main_menu', body: { setting: setting(), changed: true } },
    {
      url: '/templates/bot.menu.wallet',
      body: {
        template: view('bot.menu.wallet', CATALOGUE_FA['bot.menu.wallet']),
        revision: 1,
        changed: true,
      },
    },
    {
      url: '/templates',
      body: {
        templates: [
          ...MAIN_MENU_BUTTONS.map((button) =>
            view(button.label, options.labels?.[button.label] ?? CATALOGUE_FA[button.label]),
          ),
          ...BOT_COMMANDS.map((entry) => view(entry.description, CATALOGUE_FA[entry.description])),
        ],
      },
    },
  ]);
}

/** The arrangement's card — the label cards below it have save buttons of their own. */
const layoutCard = () =>
  within(
    screen
      .getByRole('heading', { name: t('web.bot_buttons_order_title') })
      .closest('section') as HTMLElement,
  );
const syncCard = () =>
  within(
    screen
      .getByRole('heading', { name: t('web.bot_buttons_sync_title') })
      .closest('section') as HTMLElement,
  );

const rowOf = (id: string) =>
  document.querySelector(`tr[data-button="${id}"]`) as HTMLTableRowElement;

const page = () => <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />;

describe('«دکمه‌های ربات»', () => {
  it('lists every main-menu button, the trial and the referral included, with its label and its gate', async () => {
    api();
    renderPage(page());
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());
    const rows = [...document.querySelectorAll('tr[data-button]')].map((row) =>
      row.getAttribute('data-button'),
    );
    expect(rows).toEqual(MAIN_MENU_BUTTONS.map((button) => button.id));
    expect(within(rowOf('trial')).getByText(CATALOGUE_FA['bot.menu.trial'])).toBeInTheDocument();
    // The target is shown, read-only, as the command the button opens.
    expect(within(rowOf('wallet')).getByText('/wallet')).toBeInTheDocument();
    expect(within(rowOf('wallet')).queryByRole('textbox')).toBeNull();
    // The slot select offers the closed list with the button's default marked.
    const slot = within(rowOf('wallet')).getByRole('combobox') as HTMLSelectElement;
    expect(slot.value).toBe('wallet');
    expect([...slot.options].map((option) => option.value)).toContain('payment');
    /*
     * F5: the trial has no flag. The server says no panel offers one, so the page says the
     * button will not be seen, and why — a panel's own trial, not a switch on Features.
     */
    expect(
      within(rowOf('trial')).getByText(t('web.bot_buttons_needs_trial_offer')),
    ).toBeInTheDocument();
    expect(
      within(rowOf('trial')).getByText(t('web.bot_buttons_trial_not_offered')),
    ).toBeInTheDocument();
    expect(
      within(rowOf('referral')).getByText(t('web.bot_buttons_feature_off')),
    ).toBeInTheDocument();
    expect(within(rowOf('catalog')).queryByText(t('web.bot_buttons_feature_off'))).toBeNull();
    // The preview is the keyboard the bot would draw: no gated button while its gate is shut.
    const preview = document.querySelector('.menu-preview') as HTMLElement;
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.trial'])).toBeNull();
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.referral'])).toBeNull();
    expect(within(preview).getByText(CATALOGUE_FA['bot.menu.catalog'])).toBeInTheDocument();
  });

  it('draws a gated button in the preview once the server says its gate is open', async () => {
    api({
      items: MAIN_MENU_BUTTONS.map((button, order) =>
        item(button.id, order, button.id === 'trial' ? { gateOpen: true, shownNow: true } : {}),
      ),
    });
    renderPage(page());
    const preview = () => document.querySelector('.menu-preview') as HTMLElement;
    await waitFor(() =>
      expect(within(preview()).getByText(CATALOGUE_FA['bot.menu.trial'])).toBeInTheDocument(),
    );
    expect(within(rowOf('trial')).queryByText(t('web.bot_buttons_trial_not_offered'))).toBeNull();
  });

  it('keeps a gated item out of the preview until its gate is known open (Codex #6)', async () => {
    // The trial is switched OFF in the stored layout and the server answered nothing
    // about its gate. Switching it on in the draft must not preview a button the keyboard
    // will hide: unknown is not open.
    api({
      items: MAIN_MENU_BUTTONS.map((button, order) =>
        item(
          button.id,
          order,
          button.id === 'trial' ? { enabled: false, gateOpen: null, shownNow: false } : {},
        ),
      ),
    });
    renderPage(page());
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());
    fireEvent.click(within(rowOf('trial')).getByRole('switch'));
    const preview = document.querySelector('.menu-preview') as HTMLElement;
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.trial'])).toBeNull();
    // An ungated item switched on in the draft IS previewed: the draft's switches count.
    expect(within(preview).getByText(CATALOGUE_FA['bot.menu.catalog'])).toBeInTheDocument();
  });

  it('re-reads the menu after a label is saved through the texts card (Codex #7)', async () => {
    const calls = api();
    renderPage(page());
    await waitFor(() => expect(rowOf('wallet')).not.toBeNull());
    const menuReads = () =>
      calls.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/bot-menu')).length;
    await waitFor(() => expect(menuReads()).toBe(1));

    const summary = screen.getByText(CATALOGUE_FA['bot.menu.wallet'], { selector: 'summary' });
    const details = summary.closest('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.click(within(details).getByRole('button', { name: t('web.save') }));
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.includes('/templates/bot.menu.wallet'))).toBe(
        true,
      ),
    );
    // The table, the command list, the digest and the sync states come from `/bot-menu`,
    // so the save re-reads it.
    await waitFor(() => expect(menuReads()).toBeGreaterThan(1));
  });

  it('reorders, switches and re-slots buttons, and saves the whole arrangement with its version', async () => {
    const calls = api();
    renderPage(page());
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());

    fireEvent.click(
      within(rowOf('trial')).getByRole('button', {
        name: `${t('web.bot_buttons_move_up')}: ${CATALOGUE_FA['bot.menu.trial']}`,
      }),
    );
    fireEvent.click(within(rowOf('help')).getByRole('switch'));
    fireEvent.change(within(rowOf('wallet')).getByRole('combobox'), {
      target: { value: 'payment' },
    });
    fireEvent.click(layoutCard().getByRole('button', { name: t('web.save') }));

    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.includes('/settings/bot.main_menu'))).toBe(true),
    );
    const post = calls.calls.find((call) => call.url.includes('/settings/bot.main_menu'));
    const body = post?.body as {
      value: { button: string; enabled: boolean; target: string; appearanceSlot: string | null }[];
      expectedVersion: number;
    };
    expect(body.expectedVersion).toBe(7);
    expect(body.value.map((entry) => entry.button)).toEqual([
      'catalog',
      'services',
      'wallet',
      'trial',
      'help',
      'referral',
      'apps',
      'tickets',
    ]);
    // Every entry names its declared target; the slot is stored only when chosen.
    for (const entry of body.value) {
      expect(entry.target).toBe(mainMenuButton(entry.button as never).command);
    }
    expect(body.value.find((entry) => entry.button === 'help')?.enabled).toBe(false);
    expect(body.value.find((entry) => entry.button === 'wallet')?.appearanceSlot).toBe('payment');
    expect(body.value.find((entry) => entry.button === 'catalog')?.appearanceSlot).toBeNull();
    // Saved: the menu is re-read, so the server's next answer is what the page shows.
    await waitFor(() =>
      expect(calls.calls.filter((call) => call.url.endsWith('/bot-menu')).length).toBeGreaterThan(
        1,
      ),
    );
  });

  it('refuses to save an arrangement that leaves no ungated button on', async () => {
    const calls = api();
    renderPage(page());
    await waitFor(() => expect(rowOf('catalog')).not.toBeNull());
    for (const button of MAIN_MENU_BUTTONS.filter((one) => !mainMenuButtonIsGated(one))) {
      fireEvent.click(within(rowOf(button.id)).getByRole('switch'));
    }
    expect(screen.getByText(t('web.bot_buttons_one_required'))).toBeInTheDocument();
    expect(
      (layoutCard().getByRole('button', { name: t('web.save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('shows the default beside an overridden label, edits it through the texts card, and warns on a duplicate', async () => {
    api({ labels: { 'bot.menu.trial': CATALOGUE_FA['bot.menu.catalog'] } });
    renderPage(page());
    await waitFor(() =>
      expect(screen.getAllByText(t('web.bot_buttons_label_duplicate')).length).toBe(2),
    );
    expect(
      within(rowOf('trial')).getByText(t('web.bot_buttons_label_default'), { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(rowOf('catalog')).queryByText(t('web.bot_buttons_label_default'), { exact: false }),
    ).toBeNull();
  });

  it('lists the command menu Telegram is given — the customer scope, never an admin command', async () => {
    api();
    renderPage(page());
    const table = await screen.findByTestId('bot-commands');
    const commands = [...table.querySelectorAll('tr[data-command]')].map((row) =>
      row.getAttribute('data-command'),
    );
    expect(commands).toEqual(BOT_COMMANDS.map((entry) => entry.command));
    expect(commands).not.toContain('admin');
    expect(within(table).getByText(CATALOGUE_FA['bot.command.paysupport'])).toBeInTheDocument();
  });

  it('shows where the selected bot’s menu stands, and offers «همگام‌سازی دوباره» and «بررسی وضعیت»', async () => {
    const calls = api({
      bots: [
        syncView({
          state: 'FAILING',
          attempts: 4,
          lastErrorCode: 'telegram.unreachable',
          nextAttemptAt: '2026-09-30T11:00:00.000Z',
        }),
        syncView({
          botInstanceId: BOT_A2,
          username: 'acme_support_bot',
          botStatus: 'STOPPED',
          state: 'STOPPED',
        }),
      ],
    });
    renderPage(page());
    const status = await screen.findByTestId('bot-menu-sync');
    expect(within(status).getByText('4')).toBeInTheDocument();
    expect(within(status).getByText('telegram.unreachable')).toBeInTheDocument();
    expect(within(status).getByText(t('web.bot_buttons_error_unreachable'))).toBeInTheDocument();
    expect(syncCard().getByText(t('web.bot_menu_state_failing'))).toBeInTheDocument();
    // Two bots: a selector; the stopped one has no actions.
    const select = syncCard().getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '@acme_store_bot',
      '@acme_support_bot',
    ]);

    fireEvent.click(syncCard().getByRole('button', { name: t('web.bot_buttons_sync_now') }));
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/bot-menu/sync'))).toBe(true),
    );
    const sync = calls.calls.find((call) => call.url.endsWith('/bot-menu/sync'));
    expect(sync?.body).toMatchObject({ botInstanceId: BOT_A1 });
    expect(typeof (sync?.body as { idempotencyKey: string }).idempotencyKey).toBe('string');
    await screen.findByText(t('web.bot_buttons_sync_result_synced'));

    fireEvent.click(syncCard().getByRole('button', { name: t('web.bot_buttons_check_now') }));
    await screen.findByTestId('bot-menu-check');
    expect(screen.getByText(t('web.bot_buttons_check_read_mismatch'))).toBeInTheDocument();
    expect(calls.calls.find((call) => call.url.endsWith('/bot-menu/check'))?.body).toEqual({
      botInstanceId: BOT_A1,
    });

    fireEvent.change(select, { target: { value: BOT_A2 } });
    expect(syncCard().getByText(t('web.bot_menu_state_stopped'))).toBeInTheDocument();
    expect(syncCard().queryByRole('button', { name: t('web.bot_buttons_sync_now') })).toBeNull();
  });

  it('draws no action for a viewer without settings.edit', async () => {
    api();
    renderPage(
      <BotButtonsPage mayEdit={false} denied={false} mayViewTemplates mayEditTemplates={false} />,
    );
    await screen.findByTestId('bot-menu-sync');
    expect(syncCard().queryByRole('button', { name: t('web.bot_buttons_sync_now') })).toBeNull();
    expect(layoutCard().queryByRole('button', { name: t('web.save') })).toBeNull();
  });

  it('names a transport code in Persian by its kind', () => {
    expect(syncErrorHint('telegram.unreachable')).toBe('web.bot_buttons_error_unreachable');
    expect(syncErrorHint('telegram.server_error.502')).toBe('web.bot_buttons_error_unreachable');
    expect(syncErrorHint('telegram.rate_limited')).toBe('web.bot_buttons_error_rate_limited');
    expect(syncErrorHint('telegram.rejected.401')).toBe('web.bot_buttons_error_rejected_token');
    expect(syncErrorHint('telegram.rejected.400')).toBe('web.bot_buttons_error_rejected_list');
    expect(syncErrorHint('sync.unexpected')).toBe('web.bot_buttons_error_other');
  });

  it('is reachable from the navigation as «دکمه‌های ربات», on settings.view', () => {
    const entry = NAV.find((one) => one.path === '/bot-buttons');
    expect(entry?.label).toBe('web.nav_bot_buttons');
    expect(entry?.permission).toBe('settings.view');
    const resolved = resolve({ path: '/bot-buttons', query: new URLSearchParams() }, [
      'settings.view',
    ]);
    expect(resolved.title).toBe(t('web.nav_bot_buttons'));
  });
});

describe('the panel’s «سرویس تست» tab', () => {
  const PANEL = '01926f00-0000-7000-8000-00000000a001';

  it('starts an unconfigured panel from 100 MB for 72 hours, and sends the whole configuration', async () => {
    const calls = stubApi([
      {
        url: `/panels/${PANEL}/trial`,
        body: {
          trial: {
            panelId: PANEL,
            enabled: false,
            trafficBytes: null,
            durationHours: null,
            label: null,
            revision: 0,
            updatedAt: null,
          },
        },
      },
    ]);
    renderPage(<PanelTrialTab panelId={PANEL} mayEdit />);
    await screen.findByText(t('web.panel_trial_unconfigured'));
    expect((screen.getByLabelText(t('web.panel_trial_traffic')) as HTMLInputElement).value).toBe(
      '100',
    );
    expect(
      (screen.getByLabelText(t('web.panel_trial_unit_label')) as HTMLSelectElement).value,
    ).toBe('MB');
    expect((screen.getByLabelText(t('web.panel_trial_hours')) as HTMLInputElement).value).toBe(
      '72',
    );
    fireEvent.click(screen.getByRole('switch', { name: t('web.panel_trial_enabled') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(calls.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      expectedRevision: 0,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 72,
      label: null,
    });
  });

  it('sends a carried-forward figure back exactly as shown when only the hours change (Codex, PR #111)', async () => {
    // 1,000,000,000 bytes is shown as 953.67 MB; the server keeps the stored bytes for a
    // figure submitted as shown (`trafficAfterEdit`), so the form must not re-round it.
    const calls = stubApi([
      {
        url: `/panels/${PANEL}/trial`,
        body: {
          trial: {
            panelId: PANEL,
            enabled: true,
            trafficBytes: '1000000000',
            durationHours: 72,
            label: null,
            revision: 3,
            updatedAt: '2026-09-29T10:00:00.000Z',
          },
        },
      },
    ]);
    renderPage(<PanelTrialTab panelId={PANEL} mayEdit />);
    await waitFor(() =>
      expect((screen.getByLabelText(t('web.panel_trial_traffic')) as HTMLInputElement).value).toBe(
        '953.67',
      ),
    );
    fireEvent.change(screen.getByLabelText(t('web.panel_trial_hours')), {
      target: { value: '48' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(calls.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      expectedRevision: 3,
      trafficAmount: '953.67',
      trafficUnit: 'MB',
      durationHours: 48,
    });
  });

  it('refuses a figure the server would refuse, without spending a request on it', async () => {
    const calls = stubApi([
      {
        url: `/panels/${PANEL}/trial`,
        body: {
          trial: {
            panelId: PANEL,
            enabled: true,
            trafficBytes: '1073741824',
            durationHours: 24,
            label: 'آلمان',
            revision: 2,
            updatedAt: '2026-09-29T10:00:00.000Z',
          },
        },
      },
    ]);
    renderPage(<PanelTrialTab panelId={PANEL} mayEdit />);
    // A stored gigabyte is shown back as 1 GB, not as 1024 MB.
    await waitFor(() =>
      expect((screen.getByLabelText(t('web.panel_trial_traffic')) as HTMLInputElement).value).toBe(
        '1',
      ),
    );
    // 200 GB is past the trial ceiling, which the contract's own schema states.
    fireEvent.change(screen.getByLabelText(t('web.panel_trial_traffic')), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    expect(await screen.findByText(t('web.panel_trial_invalid'))).toBeInTheDocument();
    expect(calls.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
