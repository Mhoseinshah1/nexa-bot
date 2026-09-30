import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  MAIN_MENU_BUTTONS,
  mainMenuButtonIsGated,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { BotButtonsPage } from '../../apps/web/src/pages/bot-buttons';
import { PanelTrialTab } from '../../apps/web/src/pages/panel-trial';
import { NAV, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * R1 on the Web Admin: «دکمه‌های ربات» and the panel's «سرویس تست» tab.
 *
 * The bot-buttons page manages the customer main menu — every declared button, the two
 * new ones included — through the SAME endpoints the settings and texts screens use: the
 * arrangement is `bot.main_menu`, saved whole with its version; the labels are the
 * `bot.menu.*` templates. The trial tab sends the whole configuration with its revision,
 * the traffic as a figure and a unit.
 */

const flag = (key: string, enabled: boolean) => ({
  key,
  enabled,
  source: 'DEFAULT',
  version: 3,
  updatedAt: null,
  updatedByAdminId: null,
  reason: null,
  description: key,
  blastRadius: 'TENANT_WIDE',
  configuration: [],
});

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

const PANEL_ID = '01926f00-0000-7000-8000-00000000b001';

/** One row of the Trials overview: a panel with its trial on, offered now or not. */
const trialRow = (offeredNow: boolean) => ({
  panelId: PANEL_ID,
  panelName: 'آلمان',
  trial: {
    panelId: PANEL_ID,
    enabled: true,
    trafficBytes: '104857600',
    durationHours: 72,
    label: null,
    revision: 1,
    updatedAt: '2026-09-29T10:00:00.000Z',
  },
  offeredNow,
});

function api(
  options: {
    /** F5: whether the Trials overview reports a panel offering a trial now. */
    trialOffered?: boolean;
    value?: unknown;
    labels?: Record<string, string>;
  } = {},
) {
  return stubApi([
    { url: '/trials/panels', body: { panels: [trialRow(options.trialOffered ?? false)] } },
    {
      url: '/settings',
      body: {
        settings: [
          setting({
            key: 'bot.main_menu',
            value: options.value ?? DEFAULT_MAIN_MENU_LAYOUT,
            version: 7,
            configures: null,
            zeroMeaning: 'LITERAL',
          }),
        ],
      },
    },
    { url: '/settings/bot.main_menu', body: { setting: setting(), changed: true } },
    {
      url: '/features',
      body: { flags: [flag('referrals', true)] },
    },
    {
      url: '/templates',
      body: {
        templates: MAIN_MENU_BUTTONS.map((button) =>
          view(button.label, options.labels?.[button.label] ?? CATALOGUE_FA[button.label]),
        ),
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

const rowOf = (id: string) =>
  document.querySelector(`tr[data-button="${id}"]`) as HTMLTableRowElement;

describe('«دکمه‌های ربات»', () => {
  it('lists every main-menu button, the trial and the referral included, with its label and its gate', async () => {
    api();
    renderPage(
      <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates mayViewPanels />,
    );
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());
    const rows = [...document.querySelectorAll('tr[data-button]')].map((row) =>
      row.getAttribute('data-button'),
    );
    expect(rows).toEqual(MAIN_MENU_BUTTONS.map((button) => button.id));
    await waitFor(() =>
      expect(within(rowOf('trial')).getByText(CATALOGUE_FA['bot.menu.trial'])).toBeInTheDocument(),
    );
    expect(
      within(rowOf('referral')).getByText(CATALOGUE_FA['bot.menu.referral']),
    ).toBeInTheDocument();
    /*
     * F5: the trial has no flag. No panel offers one here, so the page says the button will
     * not be seen, and why — a panel's own trial, not a switch on the Features page.
     */
    expect(
      within(rowOf('trial')).getByText(t('web.bot_buttons_needs_trial_offer')),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(rowOf('trial')).getByText(t('web.bot_buttons_trial_not_offered')),
      ).toBeInTheDocument(),
    );
    expect(within(rowOf('trial')).queryByText(t('web.bot_buttons_feature_off'))).toBeNull();
    expect(within(rowOf('referral')).queryByText(t('web.bot_buttons_feature_off'))).toBeNull();
    // The preview is the keyboard the bot would draw: no trial while no panel offers one.
    const preview = document.querySelector('.menu-preview') as HTMLElement;
    expect(within(preview).queryByText(CATALOGUE_FA['bot.menu.trial'])).toBeNull();
    expect(within(preview).getByText(CATALOGUE_FA['bot.menu.referral'])).toBeInTheDocument();
  });

  it('draws the trial button in the preview once a panel offers a trial, and guesses nothing without panels.view (F5)', async () => {
    api({ trialOffered: true });
    const { unmount } = renderPage(
      <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates mayViewPanels />,
    );
    const preview = () => document.querySelector('.menu-preview') as HTMLElement;
    await waitFor(() =>
      expect(within(preview()).getByText(CATALOGUE_FA['bot.menu.trial'])).toBeInTheDocument(),
    );
    expect(within(rowOf('trial')).queryByText(t('web.bot_buttons_trial_not_offered'))).toBeNull();
    unmount();

    // Without `panels.view` the page cannot know: the note stays, no badge, no guess.
    const calls = api({ trialOffered: false });
    renderPage(<BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());
    expect(
      within(rowOf('trial')).getByText(t('web.bot_buttons_needs_trial_offer')),
    ).toBeInTheDocument();
    expect(within(rowOf('trial')).queryByText(t('web.bot_buttons_trial_not_offered'))).toBeNull();
    expect(calls.calls.some((call) => call.url.includes('/trials/panels'))).toBe(false);
  });

  it('reorders and switches buttons, and saves the whole arrangement with its version', async () => {
    const calls = api({ trialOffered: true });
    renderPage(<BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);
    await waitFor(() => expect(rowOf('trial')).not.toBeNull());

    fireEvent.click(
      within(rowOf('trial')).getByRole('button', {
        name: `${t('web.bot_buttons_move_up')}: ${CATALOGUE_FA['bot.menu.trial']}`,
      }),
    );
    fireEvent.click(within(rowOf('help')).getByRole('switch'));
    fireEvent.click(layoutCard().getByRole('button', { name: t('web.save') }));

    await waitFor(() => expect(calls.calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/settings/bot.main_menu');
    const body = post?.body as {
      value: { button: string; enabled: boolean }[];
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
    expect(body.value.find((entry) => entry.button === 'help')?.enabled).toBe(false);
    expect(body.value.find((entry) => entry.button === 'trial')?.enabled).toBe(true);
  });

  it('refuses to save an arrangement that leaves no ungated button on', async () => {
    const calls = api();
    renderPage(<BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);
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

  it('edits each label through the texts screen’s card, and warns when two buttons share one', async () => {
    api({ labels: { 'bot.menu.trial': CATALOGUE_FA['bot.menu.catalog'] } });
    renderPage(<BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);
    await waitFor(() =>
      expect(screen.getAllByText(t('web.bot_buttons_label_duplicate')).length).toBe(2),
    );
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
