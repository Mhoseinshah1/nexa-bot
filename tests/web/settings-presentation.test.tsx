import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  OPS_GROUP_MANAGED_SETTING_KEYS,
  SETTINGS,
  SETTING_KEYS,
  settingDefinition,
  settingIntegerRange,
} from '@nexa/contracts';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { OpsGroupPage } from '../../apps/web/src/pages/ops-group';
import {
  SETTING_GROUP_TITLES,
  SETTING_PRESENTATION,
  SETTINGS_MANAGED_ELSEWHERE,
  SETTINGS_RETIRED,
} from '../../apps/web/src/settings-presentation';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * WP-A1: the Settings page is an operator's page.
 *
 * Every setting shows a Persian title, a short Persian description, the value in force,
 * a control that fits its type and a save button. Raw keys, the registry's English
 * descriptions, "source", "default" and "what zero means" are not on the page an
 * operator reads — the key and the source are kept in a closed technical disclosure.
 */

const LATIN = /[A-Za-z]/;
const PERSIAN = /[؀-ۿ]/;

/** Every registry key, as the server would send it with nothing configured. */
const EVERY_SETTING = SETTINGS.map((definition) =>
  setting({
    key: definition.key,
    value: definition.defaultValue,
    description: definition.description,
    zeroMeaning: definition.zeroMeaning,
    configures: definition.configures,
    consumer: definition.consumer,
    classification: definition.classification,
  }),
);

/**
 * The keys the Settings page draws. WP-A4 moved the ops group's chat and topic ids to the
 * ops group panel's advanced section and hid the retired severity cutoff and the internal
 * attempt ceiling; they keep their presentation entries, which stay total over the registry.
 */
const VISIBLE_KEYS = SETTING_KEYS.filter(
  (key) =>
    !(OPS_GROUP_MANAGED_SETTING_KEYS as readonly string[]).includes(key) &&
    // R1: the main menu's arrangement is edited on the «دکمه‌های ربات» page.
    !SETTINGS_MANAGED_ELSEWHERE.includes(key) &&
    // F5: a retired key is drawn nowhere.
    !SETTINGS_RETIRED.includes(key),
);

/** A connected, healthy ops group, for the page that now edits the manual topic id. */
const OPS_GROUP_VIEW = {
  connection: 'CONNECTED',
  group: {
    title: 'Nexa Ops',
    bot: { id: '01900000-0000-7000-8000-00000000a001', username: 'acme_store_bot' },
    connectedAt: '2026-09-01T10:00:00.000Z',
    disconnectedAt: null,
  },
  health: 'HEALTHY',
  problems: [],
  checkedAt: null,
  lastDeliveredAt: null,
  topics: [
    { category: 'SYSTEM', state: 'READY', lastDeliveredAt: null, recreatedCount: 0 },
    { category: 'PAYMENTS', state: 'READY', lastDeliveredAt: null, recreatedCount: 0 },
  ],
  queue: { pending: 0, preserved: 0 },
  laneEnabled: true,
  pendingCodeExpiresAt: null,
  bots: [],
  manual: { configured: false, inUse: false },
};

const ROUTES = [{ url: '/settings', body: { settings: EVERY_SETTING } }];

/** The page as an operator reads it: everything except the closed technical disclosures. */
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details')) details.remove();
  // Screen-reader-only labels are not read on screen, but they are still copy an
  // operator's assistive technology speaks, so they stay in.
  return copy.textContent ?? '';
}

describe('the settings presentation registry', () => {
  it('names and describes every registry key in Persian, with no Latin text', () => {
    for (const key of SETTING_KEYS) {
      const presentation = SETTING_PRESENTATION[key];
      const title = t(presentation.title);
      const description = t(presentation.description);
      expect(title, key).toMatch(PERSIAN);
      expect(description, key).toMatch(PERSIAN);
      expect(LATIN.test(title), `${key} title: ${title}`).toBe(false);
      expect(LATIN.test(description), `${key} description: ${description}`).toBe(false);
      expect(t(SETTING_GROUP_TITLES[presentation.group]), key).toMatch(PERSIAN);
    }
  });

  it('gives two settings two different titles', () => {
    const titles = SETTING_KEYS.map((key) => t(SETTING_PRESENTATION[key].title));
    expect(new Set(titles).size).toBe(titles.length);
  });

  /**
   * A numeric field on a key whose value is not a number would send a number the schema
   * refuses; this catches a presentation entry that disagrees with the registry.
   */
  it('puts a numeric field on every numeric key and on nothing else', () => {
    for (const key of SETTING_KEYS) {
      const { control } = SETTING_PRESENTATION[key];
      const schema = settingDefinition(key).schema;
      const range = settingIntegerRange(key);
      // A whole number the key's own schema accepts; its "not set" is null, never 0.
      const acceptsNumber = schema.safeParse(range?.min ?? 1).success;
      expect(control.kind === 'integer', key).toBe(acceptsNumber);
      // Empty is null only where the schema has a null to store.
      if (control.kind === 'integer') {
        expect(control.optional === true, key).toBe(schema.safeParse(null).success);
      }
    }
  });
});

describe('the settings page', () => {
  it('shows the operator header and no developer metadata', async () => {
    stubApi(ROUTES);
    const { container } = renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.setting_ops_max_per_minute') });

    expect(screen.getByText('تنظیمات موردنظر را تغییر دهید و ذخیره کنید.')).toBeInTheDocument();

    const text = visibleText(container);
    for (const definition of SETTINGS) {
      expect(text.includes(definition.key), `raw key ${definition.key} on the page`).toBe(false);
      expect(
        text.includes(definition.description.slice(0, 40)),
        `English description of ${definition.key} on the page`,
      ).toBe(false);
    }
    expect(text).not.toContain('منبع');
    expect(text).not.toContain('پیش‌فرض');
    expect(text).not.toContain('معنای صفر یا خالی');
    expect(text).not.toContain('صفر یک مقدار عادی است');
  });

  it('draws every setting with its Persian title, description, value in force and save button', async () => {
    stubApi(ROUTES);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.setting_ops_max_per_minute') });

    for (const key of VISIBLE_KEYS) {
      const presentation = SETTING_PRESENTATION[key];
      const heading = screen.getByRole('heading', { name: t(presentation.title) });
      const card = heading.closest('article') as HTMLElement;
      expect(within(card).getByText(t(presentation.description))).toBeInTheDocument();
      expect(
        within(card).getByText(`${t('web.settings_current_value')}:`, { exact: false }),
      ).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: t('web.save') })).toBeInTheDocument();
    }
    // One save button per setting: each is saved on its own.
    expect(screen.getAllByRole('button', { name: t('web.save') })).toHaveLength(
      VISIBLE_KEYS.length,
    );
    // WP-A4: the keys the ops group panel owns are not drawn here at all; nor, since R1,
    // the main menu's arrangement, which the «دکمه‌های ربات» page edits; nor, since F5, a
    // retired key.
    for (const key of [
      ...OPS_GROUP_MANAGED_SETTING_KEYS,
      ...SETTINGS_MANAGED_ELSEWHERE,
      ...SETTINGS_RETIRED,
    ]) {
      expect(
        screen.queryByRole('heading', { name: t(SETTING_PRESENTATION[key].title) }),
        key,
      ).toBeNull();
    }
  });

  it('keeps the machine key in a closed technical disclosure', async () => {
    stubApi(ROUTES);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const heading = await screen.findByRole('heading', {
      name: t('web.setting_ops_max_per_minute'),
    });
    const card = heading.closest('article') as HTMLElement;
    const details = card.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(t('web.settings_technical'))).toBeInTheDocument();
    expect(within(details).getByText('ops.notifications.max_per_minute')).toBeInTheDocument();
  });

  it('groups the settings under Persian headings', async () => {
    stubApi(ROUTES);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.setting_ops_max_per_minute') });
    for (const title of Object.values(SETTING_GROUP_TITLES)) {
      expect(screen.getByRole('heading', { name: t(title) })).toBeInTheDocument();
    }
  });

  it('edits a number in a numeric field with its unit and the range its schema accepts', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [setting({ key: 'sales.payment_window_minutes', value: 60, configures: null })],
        },
      },
      {
        url: '/settings/sales.payment_window_minutes',
        body: {
          setting: setting({ key: 'sales.payment_window_minutes', value: 45, version: 1 }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = (await screen.findByLabelText(
      t('web.setting_payment_window_minutes'),
    )) as HTMLInputElement;
    expect(field.value).toBe('60');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getAllByText(t('web.unit_minutes')).length).toBeGreaterThan(0);
    const range = settingIntegerRange('sales.payment_window_minutes');
    expect(range).not.toBeNull();
    expect(
      screen.getByText(new RegExp(`${t('web.settings_range_from')} ${range?.min ?? ''} `)),
    ).toBeInTheDocument();

    // Persian digits are a way of writing the same number, and are sent as one.
    fireEvent.change(field, { target: { value: '۴۵' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: 45 });
    });
  });

  it('stores an emptied optional number as "not set", never as zero', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'referral.commission_percent',
              value: 10,
              configures: 'referrals',
              zeroMeaning: 'DISABLES',
            }),
          ],
        },
      },
      {
        url: '/settings/referral.commission_percent',
        body: {
          setting: setting({ key: 'referral.commission_percent', value: null, version: 1 }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = await screen.findByLabelText(t('web.setting_referral_commission_percent'));
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: null });
    });
  });

  it('edits a closed set with a select of Persian options', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'referral.commission_scope',
              value: 'FIRST_PAID_ORDER',
              configures: 'referrals',
            }),
          ],
        },
      },
      {
        url: '/settings/referral.commission_scope',
        body: {
          setting: setting({ key: 'referral.commission_scope', value: 'EVERY_PAID_ORDER' }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const select = (await screen.findByLabelText(
      t('web.setting_referral_commission_scope'),
    )) as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      t('web.referral_trigger_first_paid_order'),
      t('web.referral_trigger_every_paid_order'),
    ]);
    fireEvent.change(select, { target: { value: 'EVERY_PAID_ORDER' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: 'EVERY_PAID_ORDER' });
    });
  });

  /*
   * The severity select is no longer drawn: WP-A4 retired `min_severity` and the page hides
   * it. Its presentation entry stays (the registry is total), so its options are still held
   * to Persian labels here, at the registry.
   */
  it('labels the severity options in Persian, not by their enum names', () => {
    const { control } = SETTING_PRESENTATION['ops.notifications.min_severity'];
    expect(control.kind).toBe('select');
    const options = control.kind === 'select' ? control.options : [];
    expect(options.map((option) => option.value)).toContain('ERROR');
    for (const option of options) expect(LATIN.test(t(option.label)), option.value).toBe(false);
  });

  it('edits every money setting as an amount and a currency, not as JSON', async () => {
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'wallet.topup.maximum',
              value: { amountMinor: '5000000', currency: 'IRT' },
              configures: null,
            }),
          ],
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const amount = (await screen.findByLabelText(
      `${t('web.amount_minor')} — ${t('web.setting_topup_maximum')}`,
    )) as HTMLInputElement;
    expect(amount.value).toBe('5000000');
    expect(
      (
        screen.getByLabelText(
          `${t('web.currency')} — ${t('web.setting_topup_maximum')}`,
        ) as HTMLSelectElement
      ).value,
    ).toBe('IRT');
    expect(screen.queryByDisplayValue(/amountMinor/)).toBeNull();
  });

  /** F5: a money amount typed in Persian digits reaches the schema as Latin digits. */
  it('sends a money amount typed in Persian digits as Latin digits', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({ key: 'sales.currency', value: 'IRT', configures: null }),
            setting({
              key: 'wallet.topup.maximum',
              value: { amountMinor: '0', currency: 'IRT' },
              configures: null,
            }),
          ],
        },
      },
      {
        url: '/settings/wallet.topup.maximum',
        body: { setting: setting({ key: 'wallet.topup.maximum' }), changed: true },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const amount = await screen.findByLabelText(
      `${t('web.amount_minor')} — ${t('web.setting_topup_maximum')}`,
    );
    fireEvent.change(amount, { target: { value: '۲۰٬۰۰۰' } });
    const heading = screen.getByRole('heading', { name: t('web.setting_topup_maximum') });
    const card = heading.closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: t('web.save') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: { amountMinor: '20000', currency: 'IRT' } });
    });
  });

  it('sends a decimal ratio typed in Persian digits with the Arabic separator as the Latin decimal the schema accepts (Codex #122)', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: { settings: [setting({ key: 'stars.per_usdt', value: '', configures: null })] },
      },
      {
        url: '/settings/stars.per_usdt',
        body: { setting: setting({ key: 'stars.per_usdt', value: '77.5' }), changed: true },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = (await screen.findByLabelText(
      t('web.setting_stars_per_usdt'),
    )) as HTMLInputElement;
    expect(field).toHaveAttribute('inputmode', 'decimal');
    fireEvent.change(field, { target: { value: ' ۷۷٫۵ ' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: '77.5' });
    });
  });

  /**
   * F2: any safe integer is a number; a digit cap sent a valid 16-digit id as a string.
   *
   * WP-A4 moved the topic id to the ops group panel's advanced manual fallback, so the rule
   * is held where the key is now edited.
   */
  it('sends a 16-digit topic id as a number', async () => {
    const api = stubApi([
      { url: '/ops-group', body: { opsGroup: OPS_GROUP_VIEW } },
      {
        url: '/settings',
        body: {
          settings: [setting({ key: 'ops.notifications.telegram_topic_id', value: null })],
        },
      },
      {
        url: '/settings/ops.notifications.telegram_topic_id',
        body: { setting: setting({ key: 'ops.notifications.telegram_topic_id' }), changed: true },
      },
    ]);
    const { container } = renderPage(<OpsGroupPage mayManage denied={false} />);
    await screen.findByText(t('web.opsgroup_advanced'));
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const field = await screen.findByLabelText(t('web.opsgroup_manual_topic'));
    fireEvent.change(field, { target: { value: '1234567890123456' } });
    fireEvent.click(
      within(field.closest('.field-row') as HTMLElement).getByRole('button', {
        name: t('web.save'),
      }),
    );
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: 1234567890123456 });
    });
  });

  /** F1: two channels that behave differently must not read the same. */
  it('summarises each channel with whether it is required and its join link', async () => {
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'telegram.channels',
              value: [
                { handle: '@required_one', mandatory: true },
                { chatId: '-1001234567890', joinUrl: 'https://t.me/+invite', mandatory: false },
              ],
              configures: null,
            }),
          ],
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const heading = await screen.findByRole('heading', {
      name: t('web.setting_telegram_channels'),
    });
    const card = heading.closest('article') as HTMLElement;
    const current = within(card).getByText(`${t('web.settings_current_value')}:`, {
      exact: false,
    }).parentElement as HTMLElement;
    const text = current.textContent ?? '';
    expect(text).toContain(`@required_one — ${t('web.channel_mandatory')}`);
    expect(text).toContain(`-1001234567890 — ${t('web.channel_optional')}`);
    expect(text).toContain(`${t('web.channel_join_url')}: https://t.me/+invite`);
  });

  /** F4: "not in the active list" only from a successful read of the list. */
  /*
   * F5: the retired trial product is drawn nowhere — a trial is configured on each panel's
   * own tab — and the trial's one remaining setting, the customer's allowance, stands on
   * its own: it names no feature switch, because the `trials` flag is gone.
   */
  it('draws no retired trial control, and the trial allowance without a feature switch', async () => {
    expect(SETTINGS_RETIRED).toEqual(['trial.product_id']);
    for (const key of SETTINGS_RETIRED) {
      expect(settingDefinition(key).consumer, key).toBe('PLANNED');
    }
    stubApi(ROUTES);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const heading = await screen.findByRole('heading', {
      name: t('web.setting_trial_limit_per_customer'),
    });
    expect(screen.queryByRole('heading', { name: t('web.setting_trial_product_id') })).toBeNull();
    const card = heading.closest('article') as HTMLElement;
    expect(within(card).queryByText(t('web.settings_needs_feature'))).toBeNull();
    // No row on the page is a control nothing reads.
    expect(screen.queryByText(t('web.setting_no_consumer'))).toBeNull();
  });

  it('says a refused value in Persian and keeps the English detail out of sight', async () => {
    stubApi([
      { url: '/settings', body: { settings: [setting()] } },
      {
        url: '/settings/ops.notifications.max_per_minute',
        status: 422,
        body: {
          error: {
            kind: 'validation',
            code: 'control.invalid_value',
            message:
              'The value for ops.notifications.max_per_minute does not match its declaration.',
            correlationId: 'test',
            details: {
              key: 'ops.notifications.max_per_minute',
              issues: ['Too big: expected <=60'],
            },
          },
        },
      },
    ]);
    const { container } = renderPage(<SettingsPage mayEdit denied={false} />);
    const field = await screen.findByLabelText(t('web.setting_ops_max_per_minute'));
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));

    expect(await screen.findByText(t('web.settings_invalid_value'))).toBeInTheDocument();
    const text = visibleText(container);
    expect(text).not.toContain('does not match its declaration');
    expect(text).not.toContain('Too big');
  });

  it('shows a change guard’s own Persian refusal as it is', async () => {
    const refusal = 'یادآور اول باید زودتر از یادآور دوم باشد؛ یعنی تعداد روز بیشتری داشته باشد.';
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'reminders.expiry_first_days',
              value: 3,
              configures: 'service_expiry_reminders',
            }),
          ],
        },
      },
      {
        url: '/settings/reminders.expiry_first_days',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.invalid_value',
            message: refusal,
            correlationId: 'test',
            details: { key: 'reminders.expiry_first_days' },
          },
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByLabelText(t('web.setting_reminders_expiry_first_days'));
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
  });

  it('titles a key this bundle does not know in Persian, and keeps the key in the disclosure', async () => {
    stubApi([
      {
        url: '/settings',
        body: { settings: [setting({ key: 'future.setting', value: 3, configures: null })] },
      },
    ]);
    const { container } = renderPage(<SettingsPage mayEdit denied={false} />);
    expect(
      await screen.findByRole('heading', { name: t('web.settings_unknown_title') }),
    ).toBeInTheDocument();
    expect(visibleText(container)).not.toContain('future.setting');
    expect(
      within(container.querySelector('details') as HTMLElement).getByText('future.setting'),
    ).toBeInTheDocument();
  });
});
