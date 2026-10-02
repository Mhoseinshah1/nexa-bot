import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  BOT_COMMANDS,
  MAIN_MENU_BUTTONS,
  mainMenuButton,
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
import { renderPage, stubApi } from './harness';
import { builderView } from './bot-buttons-builder-fixture';

/**
 * R1 + round P on the Web Admin: «دکمه‌های ربات» and the panel's «سرویس تست» tab.
 *
 * The main menu itself is the round T builder, read from `/bot-menu/builder` and tested in
 * `bot-buttons-builder.test.tsx`. This file keeps what the page shows beside it: the
 * command list and every bot's sync state (`/bot-menu`), the labels as `bot.menu.*`
 * templates, and the gate each button is shown under. The trial tab sends the whole
 * configuration with its revision, the traffic as a figure and a unit.
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
    {
      url: '/bot-menu/builder',
      body: builderView({
        itemOverrides: Object.fromEntries(
          items.map((one) => [
            one.id,
            {
              label: one.label,
              labelOverridden: one.labelOverridden,
              gateOpen: one.gateOpen,
            },
          ]),
        ),
      }),
    },
    { url: '/appearance', body: { slots: [], bots: [], operatorTelegramBound: false } },
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

const syncCard = () =>
  within(
    screen
      .getByRole('heading', { name: t('web.bot_buttons_sync_title') })
      .closest('section') as HTMLElement,
  );

const chip = (id: string) => document.querySelector(`[data-chip="${id}"]`) as HTMLElement | null;

const page = () => <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />;

describe('«دکمه‌های ربات»', () => {
  it('re-reads the menu after a label is saved through the texts card (Codex #7)', async () => {
    const calls = api();
    renderPage(page());
    await waitFor(() => expect(chip('wallet')).not.toBeNull());
    const reads = (suffix: string) =>
      calls.calls.filter((call) => call.method === 'GET' && call.url.endsWith(suffix)).length;
    const menuReads = () => reads('/bot-menu');
    await waitFor(() => expect(menuReads()).toBe(1));
    const builderReads = reads('/bot-menu/builder');

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
    // The command list, the digest and the sync states come from `/bot-menu`, and the
    // builder's labels and warnings from `/bot-menu/builder`: the save re-reads both.
    await waitFor(() => expect(menuReads()).toBeGreaterThan(1));
    await waitFor(() => expect(reads('/bot-menu/builder')).toBeGreaterThan(builderReads));
  });

  it('lists every main-menu button, the trial and the referral included, with its label and its gate', async () => {
    api();
    renderPage(page());
    await waitFor(() => expect(chip('trial')).not.toBeNull());
    const placed = [...document.querySelectorAll('.bb-row [data-chip]')].map((one) =>
      one.getAttribute('data-chip'),
    );
    expect(placed).toEqual(MAIN_MENU_BUTTONS.map((button) => button.id));
    expect(
      within(chip('trial') as HTMLElement).getByText(CATALOGUE_FA['bot.menu.trial']),
    ).toBeInTheDocument();
    /*
     * F5: the trial has no flag. The server says no panel offers one, so the page says the
     * button will not be seen, and why — a panel's own trial, not a switch on Features.
     */
    expect(
      within(chip('trial') as HTMLElement).getByText(t('web.bb_hidden_now')),
    ).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-chip-button="trial"]') as HTMLElement);
    const gate = within(screen.getByTestId('bb-gate'));
    expect(gate.getByText(t('web.bot_buttons_needs_trial_offer'))).toBeInTheDocument();
    expect(
      gate.getByText(t('web.bot_buttons_trial_not_offered'), { exact: false }),
    ).toBeInTheDocument();
    // The target is shown, read-only, as the command the button opens.
    expect(within(screen.getByTestId('bb-inspector')).getByText('/trial')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-chip-button="referral"]') as HTMLElement);
    expect(
      within(screen.getByTestId('bb-gate')).getByText(t('web.bot_buttons_feature_off'), {
        exact: false,
      }),
    ).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-chip-button="catalog"]') as HTMLElement);
    expect(screen.queryByTestId('bb-gate')).toBeNull();
    // The customer preview is the keyboard the bot would draw: no gated button while its
    // gate is shut.
    fireEvent.click(screen.getByRole('button', { name: t('web.bb_mode_customer') }));
    const preview = screen.getByTestId('bb-customer-preview');
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.trial'])).toBeNull();
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.referral'])).toBeNull();
    expect(within(preview).getByText(CATALOGUE_FA['bot.menu.catalog'])).toBeInTheDocument();
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
    await waitFor(() => expect(chip('wallet')).not.toBeNull());
    expect(screen.queryByRole('button', { name: t('web.bb_save_draft') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.bb_publish') })).toBeNull();
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
