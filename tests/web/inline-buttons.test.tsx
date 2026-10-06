import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  INLINE_BUTTONS,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  INLINE_BUTTON_NAME,
  InlineButtonsSection,
  canonicalIcons,
  canonicalStyles,
  invalidIcons,
} from '../../apps/web/src/pages/bot-buttons/inline-buttons';
import { t } from '../../apps/web/src/i18n/web.fa';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { renderPage, setting, stubApi } from './harness';

/**
 * Owner spec §6 on the Web Admin: «دکمه‌های شیشه‌ای ربات». Every registry button is listed
 * with its label and its style; the styles are ONE settings write with the version read; a
 * label is the button's template card; nothing about a button's route is offered.
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

const templates = INLINE_BUTTONS.flatMap((entry) =>
  entry.label === null ? [] : [view(entry.label, CATALOGUE_FA[entry.label])],
);

function api(value: unknown = {}, version: number | null = null) {
  return stubApi([
    {
      url: '/settings',
      body: {
        settings: [setting({ key: 'bot.inline_buttons', value, version, configures: null })],
      },
    },
    {
      url: '/settings/bot.inline_buttons',
      body: {
        setting: setting({
          key: 'bot.inline_buttons',
          value: { 'payment.sent': 'success' },
          version: (version ?? 0) + 1,
          configures: null,
        }),
        changed: true,
      },
    },
  ]);
}

const section = (props: { mayEdit?: boolean; mayViewTemplates?: boolean } = {}) => (
  <InlineButtonsSection
    mayEdit={props.mayEdit ?? true}
    denied={false}
    mayViewTemplates={props.mayViewTemplates ?? true}
    mayEditTemplates
    templates={templates}
    onLabelChanged={() => undefined}
  />
);

const row = (key: string) =>
  document.querySelector(`[data-inline-button="${key}"]`) as HTMLElement | null;

describe('«دکمه‌های شیشه‌ای ربات»', () => {
  it('lists every registry button once, with its label and a style choice of exactly four', async () => {
    api();
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(document.querySelectorAll('[data-inline-button]').length).toBe(INLINE_BUTTONS.length);
    const sent = row('payment.sent') as HTMLElement;
    expect(within(sent).getByText(t(INLINE_BUTTON_NAME['payment.sent']))).toBeInTheDocument();
    expect(within(sent).getByTestId('ib-preview').textContent).toBe(
      CATALOGUE_FA['bot.payment.sent_button'],
    );
    const select = within(sent).getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'default',
      'primary',
      'success',
      'danger',
    ]);
    // A data-labelled button offers its style and says why its text is not here.
    expect(
      within(row('catalog.product') as HTMLElement).getByText(t('web.ib_data_label')),
    ).toBeInTheDocument();
  });

  it('saves the changed styles as ONE settings write, with the version it read', async () => {
    const calls = api({ main_menu: 'primary' }, 4);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    const select = within(row('payment.sent') as HTMLElement).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'success' } });
    expect(within(row('payment.sent') as HTMLElement).getByTestId('ib-preview').className).toMatch(
      /bb-style-success/,
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/settings/bot.inline_buttons'))).toBe(
        true,
      ),
    );
    const write = calls.calls.find((call) => call.url.endsWith('/settings/bot.inline_buttons'));
    expect(write?.body).toMatchObject({
      value: { main_menu: 'primary', 'payment.sent': 'success' },
      expectedVersion: 4,
    });
    expect((write?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(7);
  });

  it('offers no style change without settings.edit, and no label editor without templates.view', async () => {
    api();
    renderPage(section({ mayEdit: false, mayViewTemplates: false }));
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(within(row('payment.sent') as HTMLElement).getByRole('combobox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.ib_save') })).toBeNull();
    expect(screen.queryByText(t('web.ib_edit_label'))).toBeNull();
    expect(screen.getByText(t('web.ib_denied_edit'))).toBeInTheDocument();
  });

  it("edits a label through the button's own template card, opened on demand", async () => {
    const calls = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({ key: 'bot.inline_buttons', value: {}, version: null, configures: null }),
          ],
        },
      },
      {
        url: '/templates/bot.payment.sent_button',
        body: {
          template: view('bot.payment.sent_button', 'رسید را فرستادم'),
          revision: 1,
          changed: true,
        },
      },
    ]);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    const sent = row('payment.sent') as HTMLElement;
    const details = sent.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    // The template card's body (the row also holds the icon's own text field, Item 3).
    const body = await waitFor(() => {
      const found = details.querySelector('textarea');
      if (found === null) throw new Error('no template body yet');
      return found;
    });
    fireEvent.change(body, { target: { value: 'رسید را فرستادم' } });
    fireEvent.click(within(sent).getByRole('button', { name: t('web.save') }));
    await waitFor(() =>
      expect(
        calls.calls.some(
          (call) =>
            call.method === 'POST' && call.url.endsWith('/templates/bot.payment.sent_button'),
        ),
      ).toBe(true),
    );
  });

  it('filters by name or label', async () => {
    api();
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(screen.getByLabelText(t('web.ib_filter')), {
      target: { value: t(INLINE_BUTTON_NAME['service.renew']) },
    });
    expect(row('service.renew')).not.toBeNull();
    expect(row('payment.sent')).toBeNull();
  });
});

afterEach(() => {
  // The leave-guard case moves the router; put it back past any guard.
  act(() => navigate('/', { replace: true, force: true }));
});

/** The tab hidden and shown again: react-query refetches what the page shows. */
function refocus(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  window.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.dispatchEvent(new Event('visibilitychange'));
}

describe('«دکمه‌های شیشه‌ای ربات» — Codex review of #145', () => {
  it('4170910503: a refetch after an edit never lends the draft the newer version', async () => {
    const listing = {
      settings: [setting({ key: 'bot.inline_buttons', value: {}, version: 4, configures: null })],
    };
    const calls = stubApi([
      { url: '/settings', body: listing },
      {
        url: '/settings/bot.inline_buttons',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.version_conflict',
            message: 'stale',
            correlationId: 't',
          },
        },
      },
    ]);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(within(row('payment.sent') as HTMLElement).getByRole('combobox'), {
      target: { value: 'success' },
    });
    // Another administrator saves meanwhile; this page re-reads version 5.
    listing.settings = [
      setting({
        key: 'bot.inline_buttons',
        value: { main_menu: 'danger' },
        version: 5,
        configures: null,
      }),
    ];
    const reads = calls.calls.filter((call) => call.url.endsWith('/settings')).length;
    refocus();
    await waitFor(() =>
      expect(calls.calls.filter((call) => call.url.endsWith('/settings')).length).toBeGreaterThan(
        reads,
      ),
    );
    expect(
      await screen.findByText(t('web.ib_changed_elsewhere'), { exact: false }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/settings/bot.inline_buttons'))).toBe(
        true,
      ),
    );
    const write = calls.calls.find((call) => call.url.endsWith('/settings/bot.inline_buttons'));
    // The version the DRAFT was edited from: the server refuses it rather than reverting.
    expect(write?.body).toMatchObject({ expectedVersion: 4, value: { 'payment.sent': 'success' } });
    // Adopting the fresh value is explicit.
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_reload') }));
    await waitFor(() =>
      expect(
        (within(row('main_menu') as HTMLElement).getByRole('combobox') as HTMLSelectElement).value,
      ).toBe('danger'),
    );
    expect(
      (within(row('payment.sent') as HTMLElement).getByRole('combobox') as HTMLSelectElement).value,
    ).toBe('default');
  });

  it('4170910519: an unsaved style edit holds an in-app navigation', async () => {
    api();
    renderPage(
      <>
        {section()}
        <LeaveGuardHost />
      </>,
    );
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(within(row('payment.sent') as HTMLElement).getByRole('combobox'), {
      target: { value: 'danger' },
    });
    act(() => navigate('/elsewhere'));
    expect(await screen.findByText(t('web.unsaved_question'))).toBeInTheDocument();
  });

  it('4170910512: a stored value this release cannot read can still be repaired', async () => {
    const calls = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            {
              ...setting({
                key: 'bot.inline_buttons',
                value: { 'no.such.button': 'primary' },
                version: 3,
                configures: null,
              }),
              source: 'DEFAULT',
              storedValueInvalid: true,
            },
          ],
        },
      },
      {
        url: '/settings/bot.inline_buttons',
        body: {
          setting: setting({ key: 'bot.inline_buttons', value: {}, version: 4, configures: null }),
          changed: true,
        },
      },
    ]);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(screen.getByText(t('web.ib_stored_invalid'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.ib_reset') })).toBeEnabled();
    const save = screen.getByRole('button', { name: t('web.ib_save') });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.calls.some((call) => call.url.endsWith('/settings/bot.inline_buttons'))).toBe(
        true,
      ),
    );
    expect(
      calls.calls.find((call) => call.url.endsWith('/settings/bot.inline_buttons'))?.body,
    ).toMatchObject({ value: {}, expectedVersion: 3 });
  });
});

describe('canonicalStyles', () => {
  it('stores only the buttons whose style differs from the default', () => {
    expect(canonicalStyles({ main_menu: 'default', 'payment.sent': 'danger' })).toEqual({
      'payment.sent': 'danger',
    });
  });
});

/**
 * Phase 2 UX wave, Item 3: the optional premium icon per inline button — its own setting
 * (`bot.inline_button_icons`), on the same rows, saved with its own version.
 */
describe('«دکمه‌های شیشه‌ای ربات» — premium icons (Item 3)', () => {
  const ICON = '5368324170671202286';

  function iconApi(
    icons: unknown = {},
    iconsVersion: number | null = null,
    extra: { storedValueInvalid?: boolean } = {},
  ) {
    return stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({ key: 'bot.inline_buttons', value: {}, version: 2, configures: null }),
            setting({
              key: 'bot.inline_button_icons',
              value: icons,
              version: iconsVersion,
              configures: null,
              ...extra,
            }),
          ],
        },
      },
      {
        url: '/settings/bot.inline_buttons',
        body: {
          setting: setting({ key: 'bot.inline_buttons', value: {}, version: 3, configures: null }),
          changed: true,
        },
      },
      {
        url: '/settings/bot.inline_button_icons',
        body: {
          setting: setting({
            key: 'bot.inline_button_icons',
            value: {},
            version: (iconsVersion ?? 0) + 1,
            configures: null,
          }),
          changed: true,
        },
      },
    ]);
  }
  const iconInput = (key: string) =>
    within(row(key) as HTMLElement).getByRole('textbox', {
      name: `${t('web.ib_icon')} — ${t(INLINE_BUTTON_NAME[key as 'payment.sent'])}`,
    }) as HTMLInputElement;
  const writes = (api: ReturnType<typeof stubApi>, key: string) =>
    api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(`/settings/${key}`));

  it('shows every button’s icon as optional and empty by default, with Telegram’s limits stated', async () => {
    iconApi();
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(iconInput('payment.sent').value).toBe('');
    expect(
      within(row('payment.sent') as HTMLElement).getByText(t('web.ib_icon_none')),
    ).toBeTruthy();
    expect(within(row('payment.sent') as HTMLElement).getByText(t('web.bb_optional'))).toBeTruthy();
    expect(screen.getByTestId('ib-icon-limits').textContent).toBe(t('web.ib_icon_limits'));
    expect(document.querySelectorAll('[data-testid="ib-icon"]').length).toBe(INLINE_BUTTONS.length);
    expect(document.querySelector('[data-testid="ib-icon-mark"]')).toBeNull();
  });

  it('saves an icon as ONE write of bot.inline_button_icons with ITS version, and no style write', async () => {
    const api = iconApi({ main_menu: '1' }, 7);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(iconInput('payment.sent'), { target: { value: ICON } });
    // The preview marks the icon before the label (never a fake of the custom emoji).
    const preview = within(row('payment.sent') as HTMLElement).getByTestId('ib-preview');
    expect(preview.querySelector('[data-testid="ib-icon-mark"]')).not.toBeNull();
    expect(preview.textContent).toBe(`✦${CATALOGUE_FA['bot.payment.sent_button']}`);
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    expect(writes(api, 'bot.inline_button_icons')[0]?.body).toMatchObject({
      value: { main_menu: '1', 'payment.sent': ICON },
      expectedVersion: 7,
    });
    expect(writes(api, 'bot.inline_buttons')).toHaveLength(0);
  });

  it('refuses to save an id that is not digits, says why, and saves once it is fixed', async () => {
    const api = iconApi();
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    for (const bad of ['abc', '12a', '💰', '-1', '1'.repeat(33)]) {
      fireEvent.change(iconInput('payment.sent'), { target: { value: bad } });
      expect(iconInput('payment.sent').getAttribute('aria-invalid')).toBe('true');
      expect(within(row('payment.sent') as HTMLElement).getByRole('alert').textContent).toBe(
        t('web.ib_icon_invalid'),
      );
      expect(
        (screen.getByRole('button', { name: t('web.ib_save') }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    fireEvent.change(iconInput('payment.sent'), { target: { value: ` ${ICON} ` } });
    expect(within(row('payment.sent') as HTMLElement).queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    // Trimmed, never stored with the spaces.
    expect(writes(api, 'bot.inline_button_icons')[0]?.body).toMatchObject({
      value: { 'payment.sent': ICON },
    });
  });

  it('removes an icon: the button returns to «بدون آیکون» and the write drops its key', async () => {
    const api = iconApi({ 'payment.sent': ICON, main_menu: '1' }, 3);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(iconInput('payment.sent').value).toBe(ICON);
    fireEvent.click(
      within(row('payment.sent') as HTMLElement).getByRole('button', {
        name: `${t('web.ib_icon_remove')} — ${t(INLINE_BUTTON_NAME['payment.sent'])}`,
      }),
    );
    expect(iconInput('payment.sent').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    expect(writes(api, 'bot.inline_button_icons')[0]?.body).toMatchObject({
      value: { main_menu: '1' },
      expectedVersion: 3,
    });
  });

  it('a style and an icon edited together are two writes, each with its own version and key', async () => {
    const api = iconApi({}, null);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(within(row('payment.sent') as HTMLElement).getByRole('combobox'), {
      target: { value: 'success' },
    });
    fireEvent.change(iconInput('main_menu'), { target: { value: ICON } });
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    const style = writes(api, 'bot.inline_buttons')[0]?.body as Record<string, unknown>;
    const icon = writes(api, 'bot.inline_button_icons')[0]?.body as Record<string, unknown>;
    expect(style).toMatchObject({ value: { 'payment.sent': 'success' }, expectedVersion: 2 });
    expect(icon).toMatchObject({ value: { main_menu: ICON }, expectedVersion: null });
    expect(style['idempotencyKey']).not.toBe(icon['idempotencyKey']);
  });

  it('offers no icon edit without settings.edit', async () => {
    iconApi({ 'payment.sent': ICON }, 1);
    renderPage(section({ mayEdit: false }));
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(iconInput('payment.sent').disabled).toBe(true);
    expect(
      within(row('payment.sent') as HTMLElement).queryByRole('button', {
        name: new RegExp(t('web.ib_icon_remove')),
      }),
    ).toBeNull();
  });

  it('an unreadable stored icon value is said, and can be repaired by a save', async () => {
    const api = iconApi({ 'no.such.button': 'x' }, 4, { storedValueInvalid: true });
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    expect(screen.getByText(t('web.ib_icons_stored_invalid'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    expect(writes(api, 'bot.inline_button_icons')[0]?.body).toMatchObject({
      value: {},
      expectedVersion: 4,
    });
  });
});

describe('«دکمه‌های شیشه‌ای ربات» — review of #215 (N1, N2)', () => {
  const ICON = '5368324170671202286';
  const writes = (api: ReturnType<typeof stubApi>, key: string) =>
    api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(`/settings/${key}`));
  const iconInput = (key: 'payment.sent' | 'main_menu') =>
    within(row(key) as HTMLElement).getByRole('textbox', {
      name: `${t('web.ib_icon')} — ${t(INLINE_BUTTON_NAME[key])}`,
    }) as HTMLInputElement;

  it('N1: styles saved and icons refused — says so, claims no change elsewhere, and the next click sends only the icons', async () => {
    const state = { stylesSaved: false };
    const styles = (saved: boolean) =>
      setting({
        key: 'bot.inline_buttons',
        value: saved ? { 'payment.sent': 'success' } : {},
        version: saved ? 3 : 2,
        configures: null,
      });
    const api = stubApi([
      {
        url: '/settings',
        get body() {
          return {
            settings: [
              styles(state.stylesSaved),
              setting({
                key: 'bot.inline_button_icons',
                value: {},
                version: 5,
                configures: null,
              }),
            ],
          };
        },
      },
      {
        url: '/settings/bot.inline_buttons',
        get body() {
          state.stylesSaved = true;
          return { setting: styles(true), changed: true };
        },
      },
      {
        url: '/settings/bot.inline_button_icons',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.version_conflict',
            message: 'stale',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(within(row('payment.sent') as HTMLElement).getByRole('combobox'), {
      target: { value: 'success' },
    });
    fireEvent.change(iconInput('main_menu'), { target: { value: ICON } });
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    expect(await screen.findByText(t('web.ib_icons_failed_styles_saved'))).toBeTruthy();
    expect(writes(api, 'bot.inline_buttons')).toHaveLength(1);
    expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1);
    // The styles' new version was adopted: nothing "changed elsewhere", the icon edit kept.
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/settings')),
      ).toHaveLength(2),
    );
    expect(screen.queryByText(t('web.ib_changed_elsewhere'))).toBeNull();
    expect(iconInput('main_menu').value).toBe(ICON);
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(2));
    expect(writes(api, 'bot.inline_buttons')).toHaveLength(1);
    expect(writes(api, 'bot.inline_button_icons')[1]?.body).toMatchObject({
      value: { main_menu: ICON },
      expectedVersion: 5,
    });
  });

  it('N2: Persian and Arabic-Indic digits are taken as the same id, in ASCII', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({ key: 'bot.inline_buttons', value: {}, version: 2, configures: null }),
            setting({ key: 'bot.inline_button_icons', value: {}, version: 1, configures: null }),
          ],
        },
      },
      {
        url: '/settings/bot.inline_button_icons',
        body: {
          setting: setting({ key: 'bot.inline_button_icons', value: {}, version: 2 }),
          changed: true,
        },
      },
    ]);
    renderPage(section());
    await waitFor(() => expect(row('payment.sent')).not.toBeNull());
    fireEvent.change(iconInput('payment.sent'), { target: { value: '۵۳۶۸۳۲۴۱۷۰۶۷۱۲۰۲۲۸۶' } });
    expect(iconInput('payment.sent').value).toBe(ICON);
    fireEvent.change(iconInput('main_menu'), { target: { value: '٥٣٦٨' } });
    expect(within(row('main_menu') as HTMLElement).queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.ib_save') }));
    await waitFor(() => expect(writes(api, 'bot.inline_button_icons')).toHaveLength(1));
    expect(writes(api, 'bot.inline_button_icons')[0]?.body).toMatchObject({
      value: { main_menu: '5368', 'payment.sent': ICON },
    });
  });
});

describe('canonicalIcons / invalidIcons', () => {
  it('keeps registry order, trims, drops the empty, and names the invalid', () => {
    expect(canonicalIcons({ main_menu: ' 12 ', 'payment.sent': '', 'list.close': '3' })).toEqual({
      main_menu: '12',
      'list.close': '3',
    });
    expect(Object.keys(canonicalIcons({ 'list.close': '3', main_menu: '1' }))).toEqual([
      'main_menu',
      'list.close',
    ]);
    expect(invalidIcons({ main_menu: '12', 'list.close': 'x1', 'payment.sent': '' })).toEqual([
      'list.close',
    ]);
    expect(canonicalIcons({ main_menu: '۱۲', 'list.close': '٣' })).toEqual({
      main_menu: '12',
      'list.close': '3',
    });
  });
});
