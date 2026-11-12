import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { TierTargetEditor } from '../../apps/web/src/pages/reseller-tier-target';
import { ResellerTrialSettingsCard } from '../../apps/web/src/pages/reseller-trial-settings';
import { FEATURE_PRESENTATION } from '../../apps/web/src/pages/features-catalogue';
import { t } from '../../apps/web/src/i18n/web.fa';
import { panel, renderPage, setting, stubApi } from './harness';

/**
 * The Web Admin's PR-5 additions: a tier's «هدف سطح بعد», the reseller trial settings card, and
 * the «پیشرفت سطح» flag's label in «قابلیت‌ها». (The reseller drawer's 2FA reset and trial
 * count are in reseller-web-panel-admin.test.tsx.)
 */
afterEach(() => vi.unstubAllGlobals());

const TARGET = '/reseller-tiers/tier-1/next-target';

describe('«هدف سطح بعد»', () => {
  it('shows the stored count and saves a changed one with a key', async () => {
    const api = stubApi([
      { url: TARGET, method: 'GET', body: { target: { kind: 'COUNT', count: 50 } } },
      { url: TARGET, method: 'PUT', body: { target: { kind: 'COUNT', count: 80 } } },
    ]);
    renderPage(<TierTargetEditor tierId="tier-1" />);
    const value = (await screen.findByLabelText(
      t('web.rp_admin_target_value'),
    )) as HTMLInputElement;
    await waitFor(() => expect(value.value).toBe('50'));
    const save = screen.getByRole('button', { name: t('web.rp_admin_target_save') });
    expect(save).toBeDisabled();
    fireEvent.change(value, { target: { value: '80' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
    const body = api.calls.find((call) => call.method === 'PUT')?.body as {
      target: unknown;
      idempotencyKey: string;
    };
    expect(body.target).toEqual({ kind: 'COUNT', count: 80 });
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('saves an amount target in minor units of the chosen currency', async () => {
    const api = stubApi([
      { url: TARGET, method: 'GET', body: { target: null } },
      { url: TARGET, method: 'PUT', body: { target: null } },
    ]);
    renderPage(<TierTargetEditor tierId="tier-1" />);
    fireEvent.change(await screen.findByLabelText(t('web.rp_admin_target_kind')), {
      target: { value: 'AMOUNT' },
    });
    fireEvent.change(screen.getByLabelText(t('web.rp_admin_target_value')), {
      target: { value: '10000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_admin_target_save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(
      (api.calls.find((call) => call.method === 'PUT')?.body as { target: unknown }).target,
    ).toEqual({ kind: 'AMOUNT', amount: { amountMinor: '10000000', currency: 'IRT' } });
  });

  it('clears the target with «بدون هدف»', async () => {
    const api = stubApi([
      { url: TARGET, method: 'GET', body: { target: { kind: 'COUNT', count: 50 } } },
      { url: TARGET, method: 'PUT', body: { target: null } },
    ]);
    renderPage(<TierTargetEditor tierId="tier-1" />);
    const kind = await screen.findByLabelText(t('web.rp_admin_target_kind'));
    await waitFor(() => expect((kind as HTMLSelectElement).value).toBe('COUNT'));
    fireEvent.change(kind, { target: { value: 'NONE' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_admin_target_save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(
      (api.calls.find((call) => call.method === 'PUT')?.body as { target: unknown }).target,
    ).toBeNull();
  });
});

describe('the resellers page’s trial settings card', () => {
  const PANEL_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
  const rows = [
    setting({ key: 'reseller.trial_daily_quota', value: 0, version: null }),
    setting({ key: 'reseller.trial_product', value: null, version: null }),
  ];

  it('saves the daily quota through the ordinary settings write, 0–20 only', async () => {
    const api = stubApi([
      {
        url: '/settings/reseller.trial_daily_quota',
        method: 'POST',
        body: { setting: rows[0], changed: true },
      },
      { url: '/settings', method: 'GET', body: { settings: rows } },
    ]);
    renderPage(<ResellerTrialSettingsCard maySettingsView maySettingsEdit mayViewPanels={false} />);
    const input = await screen.findByLabelText(t('web.rp_trial_settings_quota'));
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '21' } });
    expect(screen.getByText(t('web.rp_trial_settings_quota_invalid'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_trial_settings_save') })).toBeDisabled();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_trial_settings_save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      value: 3,
      expectedVersion: null,
    });
  });

  it('chooses the trial panel from the panels list and can clear it', async () => {
    const api = stubApi([
      {
        url: '/settings/reseller.trial_product',
        method: 'POST',
        body: { setting: rows[1], changed: true },
      },
      { url: '/settings', method: 'GET', body: { settings: rows } },
      {
        url: '/panels',
        method: 'GET',
        body: { panels: [panel({ id: PANEL_ID, name: 'Frankfurt A' })], nextCursor: null },
      },
    ]);
    renderPage(<ResellerTrialSettingsCard maySettingsView maySettingsEdit mayViewPanels />);
    const select = await screen.findByLabelText(t('web.rp_trial_settings_product'));
    await screen.findByRole('option', { name: 'Frankfurt A' });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: PANEL_ID } });
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      value: PANEL_ID,
    });
  });

  it('is read-only without settings.edit', async () => {
    stubApi([{ url: '/settings', method: 'GET', body: { settings: rows } }]);
    renderPage(
      <ResellerTrialSettingsCard maySettingsView maySettingsEdit={false} mayViewPanels={false} />,
    );
    expect(await screen.findByText(t('web.rp_trial_settings_read_only'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('web.rp_trial_settings_quota'))).toBeDisabled();
  });
});

describe('«قابلیت‌ها»', () => {
  it('labels reseller_tier_progress «پیشرفت تا سطح بعد در پنل نماینده»', () => {
    const entry = FEATURE_PRESENTATION.reseller_tier_progress;
    expect(entry).toBeDefined();
    expect(t(entry!.title)).toBe('پیشرفت تا سطح بعد در پنل نماینده');
  });
});
