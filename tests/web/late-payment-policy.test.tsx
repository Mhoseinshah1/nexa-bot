import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LateCreditCard } from '../../apps/web/src/pages/late-credit-card';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * NEXA-OWNER-BATCH-1 PR-5: each online gateway's late-payment policy is a three-way choice
 * on its own page, each choice with what it does in Persian under it, saved through the
 * ordinary settings write at the version it was read at.
 */
const KEY = 'payments.late_credit.tonpays_enabled';
const ROWS = [
  setting({ key: KEY, value: 'WALLET', version: 2 }),
  setting({ key: 'payments.late_credit.window_hours', value: 48, version: null }),
];

function api() {
  return stubApi([
    { url: '/settings', body: { settings: ROWS } },
    {
      url: `/settings/${KEY}`,
      method: 'POST',
      body: {
        setting: setting({ key: KEY, value: 'DELIVER', version: 3, source: 'TENANT' }),
        changed: true,
      },
    },
  ]);
}

describe('the late-payment policy card', () => {
  it('offers the three policies with their Persian descriptions, the stored one chosen', async () => {
    api();
    renderPage(<LateCreditCard provider="TONPAYS" maySettingsView maySettingsEdit />);
    const wallet = await screen.findByRole('radio', { name: t('web.late_policy_wallet') });
    expect(wallet).toBeChecked();
    expect(screen.getByRole('radio', { name: t('web.late_policy_review') })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: t('web.late_policy_deliver') })).not.toBeChecked();
    for (const hint of [
      'web.late_policy_wallet_hint',
      'web.late_policy_review_hint',
      'web.late_policy_deliver_hint',
    ] as const) {
      expect(screen.getByText(t(hint))).toBeInTheDocument();
    }
  });

  it('saves the chosen policy as its value, at the version it was read at', async () => {
    const calls = api();
    renderPage(<LateCreditCard provider="TONPAYS" maySettingsView maySettingsEdit />);
    fireEvent.click(await screen.findByRole('radio', { name: t('web.late_policy_deliver') }));
    await waitFor(() =>
      expect(calls.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    );
    const post = calls.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain(KEY);
    expect(post?.body).toMatchObject({ value: 'DELIVER', expectedVersion: 2 });
  });

  it('is read-only without settings.edit, and absent on a route with no policy', async () => {
    api();
    const { unmount } = renderPage(
      <LateCreditCard provider="TONPAYS" maySettingsView maySettingsEdit={false} />,
    );
    expect(await screen.findByRole('radio', { name: t('web.late_policy_review') })).toBeDisabled();
    unmount();
    api();
    renderPage(<LateCreditCard provider="TELEGRAM_STARS" maySettingsView maySettingsEdit />);
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
