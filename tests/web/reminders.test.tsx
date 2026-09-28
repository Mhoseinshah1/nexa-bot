import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { RemindersPage } from '../../apps/web/src/pages/reminders';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * WP-A9 on the Web Admin: the reminders screen.
 *
 * What the screen DOES with the server's rows: a usage threshold stored as percent USED is
 * shown and typed as percent REMAINING; a switch is turned off only after a plain Persian
 * question, and the tenant-wide confirmation protocol is carried for the operator; the
 * wallet threshold is saved in the currency the installation sells in; and a week-out slot
 * that cannot fire says so.
 */

const flag = (key: string, enabled: boolean, overrides: Record<string, unknown> = {}) => ({
  key,
  enabled,
  source: 'DEFAULT',
  version: null,
  updatedAt: null,
  updatedByAdminId: null,
  reason: null,
  description: key,
  blastRadius: 'TENANT_WIDE',
  configuration: [],
  ...overrides,
});

const numberSetting = (key: string, value: number, version: number | null = null) =>
  setting({ key, value, version, configures: 'service_expiry_reminders' });

function rows(overrides: Record<string, unknown> = {}) {
  return [
    numberSetting('reminders.expiry_early_days', 7),
    numberSetting('reminders.expiry_first_days', 3),
    numberSetting('reminders.expiry_second_days', 1),
    numberSetting('reminders.usage_first_percent', 80, 4),
    numberSetting('reminders.usage_second_percent', 90),
    numberSetting('reminders.usage_final_percent', 95),
    numberSetting('reminders.payment_pending_minutes', 10),
    setting({
      key: 'wallet.low_balance.threshold',
      value: { amountMinor: '0', currency: 'IRT' },
      configures: 'wallet_low_balance_reminders',
    }),
    setting({ key: 'sales.currency', value: 'IRR', configures: null }),
  ].map((row) => ({ ...row, ...(overrides[row['key'] as string] as object | undefined) }));
}

const flags = () => [
  flag('service_expiry_reminders', true),
  flag('service_expiry_day_reminder', true),
  flag('service_expired_notice', true),
  flag('service_usage_reminders', true),
  flag('wallet_low_balance_reminders', false),
  flag('payment_pending_reminders', true),
];

function api(overrides: Record<string, unknown> = {}) {
  return stubApi([
    { url: '/settings', body: { settings: rows(overrides) } },
    { url: '/features', body: { flags: flags() } },
    { url: '/templates', body: { templates: [] } },
    {
      url: '/settings/reminders.usage_first_percent',
      body: { setting: numberSetting('reminders.usage_first_percent', 75, 5), changed: true },
    },
    {
      url: '/settings/wallet.low_balance.threshold',
      body: {
        setting: setting({
          key: 'wallet.low_balance.threshold',
          value: { amountMinor: '500000', currency: 'IRR' },
          version: 1,
        }),
        changed: true,
      },
    },
    {
      url: '/features/service_usage_reminders',
      body: { flag: flag('service_usage_reminders', false, { version: 1 }), changed: true },
    },
  ]);
}

const page = () =>
  renderPage(<RemindersPage mayEdit denied={false} mayViewTemplates mayEditTemplates />);

describe('the reminders screen', () => {
  it('shows the four families and the usage thresholds as traffic REMAINING', async () => {
    api();
    page();

    expect(await screen.findByText(t('web.reminders_expiry_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.reminders_usage_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.reminders_wallet_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.reminders_pending_title'))).toBeInTheDocument();
    // Stored 80/90/95 used, shown as 20/10/5 remaining.
    expect(screen.getByLabelText(t('web.reminders_usage_first'))).toHaveValue(20);
    expect(screen.getByLabelText(t('web.reminders_usage_second'))).toHaveValue(10);
    expect(screen.getByLabelText(t('web.reminders_usage_final'))).toHaveValue(5);
    expect(screen.getByLabelText(t('web.reminders_early_days'))).toHaveValue(7);
    // No cron expression anywhere: the controls are quantities.
    expect(document.body.textContent).not.toMatch(/\*\s\*\s\*/);
  });

  it('saves a remaining percentage as the percentage used, at the version it read', async () => {
    const calls = api();
    page();

    const field = await screen.findByLabelText(t('web.reminders_usage_first'));
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.click(field.closest('form')!.querySelector('button[type="submit"]')!);

    await waitFor(() =>
      expect(
        calls.calls.some((call) => call.url.endsWith('/settings/reminders.usage_first_percent')),
      ).toBe(true),
    );
    const sent = calls.calls.find((call) =>
      call.url.endsWith('/settings/reminders.usage_first_percent'),
    );
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ value: 75, expectedVersion: 4 });
  });

  it('asks the Features page’s question before turning a reminder off, and sends no key or reason', async () => {
    const calls = api();
    page();

    const toggle = await screen.findByRole('switch', { name: t('web.reminders_flag_usage') });
    fireEvent.click(toggle);
    // The same dialog, question and effect sentence the Features page shows for this flag.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(t('web.feature_confirm_disable'));
    expect(dialog).toHaveTextContent(t('web.feature_service_usage_reminders_off_effect'));
    // Nothing is sent until the question is answered.
    expect(calls.calls.some((call) => call.url.includes('/features/'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('web.feature_confirm_disable_yes') }));
    await waitFor(() =>
      expect(
        calls.calls.some((call) => call.url.endsWith('/features/service_usage_reminders')),
      ).toBe(true),
    );
    const sent = calls.calls.find((call) => call.url.endsWith('/features/service_usage_reminders'));
    // The flag and the version it was drawn from. No confirmation key (retired by WP-A2),
    // and no reason — never one this screen made up for the audit row.
    expect(Object.keys(sent?.body as object).sort()).toEqual([
      'enabled',
      'expectedVersion',
      'idempotencyKey',
    ]);
    expect(sent?.body).toMatchObject({ enabled: false, expectedVersion: null });
  });

  it('sends nothing when the question is cancelled', async () => {
    const calls = api();
    page();

    fireEvent.click(await screen.findByRole('switch', { name: t('web.reminders_flag_expiry') }));
    fireEvent.click(await screen.findByRole('button', { name: t('web.feature_confirm_cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.calls.some((call) => call.url.includes('/features/'))).toBe(false);
  });

  it('adopts the refreshed version after a conflict, keeping the draft, and the retry succeeds', async () => {
    const settingsRoute = { url: '/settings', body: { settings: rows() } as unknown };
    const writeRoute: { url: string; status?: number; body: unknown } = {
      url: '/settings/reminders.usage_first_percent',
      status: 409,
      body: {
        error: {
          kind: 'conflict',
          code: 'control.version_conflict',
          message: 'somebody else changed it',
          correlationId: 'test',
        },
      },
    };
    const calls = stubApi([
      settingsRoute,
      { url: '/features', body: { flags: flags() } },
      { url: '/templates', body: { templates: [] } },
      writeRoute,
    ]);
    page();

    const field = await screen.findByLabelText(t('web.reminders_usage_first'));
    // Another administrator saves the key while this page is open: version 4 becomes 7.
    settingsRoute.body = {
      settings: rows({ 'reminders.usage_first_percent': { value: 85, version: 7 } }),
    };
    fireEvent.change(field, { target: { value: '25' } });
    const submit = field.closest('form')!.querySelector('button[type="submit"]')!;
    fireEvent.click(submit);

    const writes = () =>
      calls.calls.filter((call) => call.url.endsWith('/settings/reminders.usage_first_percent'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ value: 75, expectedVersion: 4 });
    // The conflict refetched the row; wait until the page holds version 7.
    await waitFor(() =>
      expect(calls.calls.filter((call) => call.url.endsWith('/settings')).length).toBeGreaterThan(
        1,
      ),
    );

    // The retry: the operator's 25 is still there, and it is sent against version 7.
    writeRoute.status = 200;
    writeRoute.body = {
      setting: numberSetting('reminders.usage_first_percent', 75, 8),
      changed: true,
    };
    expect(field).toHaveValue(25);
    // Let the refetched row render, then retry ONCE.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.click(submit);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]?.body).toMatchObject({ value: 75, expectedVersion: 7 });
    expect(await screen.findByText(t('web.saved'))).toBeInTheDocument();
  });

  it('turns a reminder ON without a question', async () => {
    const calls = api();
    page();

    fireEvent.click(await screen.findByRole('switch', { name: t('web.reminders_flag_wallet') }));
    await waitFor(() =>
      expect(
        calls.calls.some((call) => call.url.endsWith('/features/wallet_low_balance_reminders')),
      ).toBe(true),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('saves the wallet threshold in the currency the installation sells in', async () => {
    const calls = api();
    page();

    const field = await screen.findByLabelText(t('web.reminders_wallet_threshold'));
    fireEvent.change(field, { target: { value: '500000' } });
    fireEvent.click(field.closest('form')!.querySelector('button[type="submit"]')!);

    await waitFor(() =>
      expect(
        calls.calls.some((call) => call.url.endsWith('/settings/wallet.low_balance.threshold')),
      ).toBe(true),
    );
    const sent = calls.calls.find((call) =>
      call.url.endsWith('/settings/wallet.low_balance.threshold'),
    );
    expect(sent?.body).toMatchObject({ value: { amountMinor: '500000', currency: 'IRR' } });
  });

  it('says when the week-out warning cannot fire', async () => {
    api({ 'reminders.expiry_first_days': { value: 10 } });
    page();

    expect(await screen.findByText(t('web.reminders_early_inert'))).toBeInTheDocument();
  });

  it('says so, rather than hiding the section, when templates cannot be read', async () => {
    api();
    renderPage(
      <RemindersPage mayEdit denied={false} mayViewTemplates={false} mayEditTemplates={false} />,
    );

    await screen.findByText(t('web.reminders_expiry_title'));
    expect(screen.getAllByText(t('web.reminders_templates_denied')).length).toBeGreaterThan(0);
  });
});
