import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CardSwitchLimitsCard } from '../../apps/web/src/pages/card-switch-limits-card';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * R5C-1 item 2: the three «تغییر شماره کارت» limits on the card-to-card method's page. The
 * server decides every press; this card only edits the three registry numbers, each through
 * the ordinary settings write.
 */
const ROWS = [
  setting({
    key: 'payments.card_switch_cooldown_seconds',
    value: 60,
    version: null,
    zeroMeaning: 'LITERAL',
  }),
  setting({ key: 'payments.card_switch_limit', value: 2, version: 3, zeroMeaning: 'DISABLES' }),
  setting({ key: 'payments.card_switch_max_distinct_cards', value: 2, version: null }),
];

const field = (label: string) => screen.findByLabelText(new RegExp(label, 'u'));

function api() {
  return stubApi([
    { url: '/settings', body: { settings: ROWS } },
    {
      url: '/settings/payments.card_switch_cooldown_seconds',
      method: 'POST',
      body: {
        setting: setting({
          key: 'payments.card_switch_cooldown_seconds',
          value: 120,
          version: 1,
          source: 'TENANT',
        }),
        changed: true,
      },
    },
  ]);
}

describe('the card-switch limits card', () => {
  it('shows the three values in force, with their defaults when nothing is stored', async () => {
    api();
    renderPage(<CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView maySettingsEdit />);
    expect(await field(t('web.card_switch_cooldown'))).toHaveValue('60');
    expect(await field(t('web.card_switch_max'))).toHaveValue('2');
    expect(await field(t('web.card_switch_distinct'))).toHaveValue('2');
  });

  it('writes only the changed key, at the version it was read at', async () => {
    const calls = api();
    renderPage(<CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView maySettingsEdit />);
    fireEvent.change(await field(t('web.card_switch_cooldown')), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.card_switch_save') }));
    await waitFor(() =>
      expect(calls.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    );
    const post = calls.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('payments.card_switch_cooldown_seconds');
    expect(post?.body).toMatchObject({ value: 120, expectedVersion: null });
  });

  it.each([
    ['web.card_switch_cooldown', '3601', 'web.card_switch_cooldown_invalid'],
    ['web.card_switch_max', '21', 'web.card_switch_max_invalid'],
    ['web.card_switch_distinct', '0', 'web.card_switch_distinct_invalid'],
    ['web.card_switch_distinct', '21', 'web.card_switch_distinct_invalid'],
    ['web.card_switch_cooldown', 'abc', 'web.card_switch_cooldown_invalid'],
  ] as const)('refuses %s = %s before anything is sent', async (label, value, message) => {
    const calls = api();
    renderPage(<CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView maySettingsEdit />);
    fireEvent.change(await field(t(label)), { target: { value } });
    expect(await screen.findByText(t(message))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.card_switch_save') })).toBeDisabled();
    expect(calls.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('accepts the bounds themselves', async () => {
    api();
    renderPage(<CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView maySettingsEdit />);
    fireEvent.change(await field(t('web.card_switch_cooldown')), { target: { value: '3600' } });
    fireEvent.change(await field(t('web.card_switch_max')), { target: { value: '0' } });
    fireEvent.change(await field(t('web.card_switch_distinct')), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: t('web.card_switch_save') })).toBeEnabled();
  });

  it('is read-only without settings.edit, and absent without settings.view or on another route', async () => {
    api();
    const view = renderPage(
      <CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView maySettingsEdit={false} />,
    );
    expect(await field(t('web.card_switch_cooldown'))).toBeDisabled();
    expect(screen.queryByRole('button', { name: t('web.card_switch_save') })).toBeNull();
    view.unmount();

    const hidden = renderPage(
      <CardSwitchLimitsCard provider="MANUAL_TRANSFER" maySettingsView={false} maySettingsEdit />,
    );
    expect(hidden.container.textContent).toBe('');
    hidden.unmount();

    const other = renderPage(
      <CardSwitchLimitsCard provider="NOWPAYMENTS" maySettingsView maySettingsEdit />,
    );
    expect(other.container.textContent).toBe('');
  });
});
