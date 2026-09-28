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

  it('asks before turning a reminder off, and carries the confirmation for the operator', async () => {
    const calls = api();
    page();

    const toggle = await screen.findByRole('switch', { name: t('web.reminders_flag_usage') });
    fireEvent.click(toggle);
    // Nothing is sent until the question is answered.
    expect(await screen.findByText(t('web.reminders_turn_off_confirm'))).toBeInTheDocument();
    expect(calls.calls.some((call) => call.url.includes('/features/'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('web.reminders_turn_off_yes') }));
    await waitFor(() =>
      expect(
        calls.calls.some((call) => call.url.endsWith('/features/service_usage_reminders')),
      ).toBe(true),
    );
    const sent = calls.calls.find((call) => call.url.endsWith('/features/service_usage_reminders'));
    expect(sent?.body).toMatchObject({
      enabled: false,
      confirmKey: 'service_usage_reminders',
      reason: t('web.reminders_toggle_reason'),
    });
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
    expect(screen.queryByText(t('web.reminders_turn_off_confirm'))).toBeNull();
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
