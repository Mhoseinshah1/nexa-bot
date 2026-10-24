import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fxStatusResponseSchema, type FxStatusResponse } from '@nexa/contracts';
import { FxSection, fxSourceErrorLabel } from '../../apps/web/src/pages/fx-section';
import { navigate } from '../../apps/web/src/router';
import { formatNumber } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Round 6, item 1 — the FX section's per-source health and switches. Every figure comes
 * from the status the server sent; the switch is the ordinary settings write.
 */

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));
beforeEach(() => go('/'));
afterEach(() => go('/'));

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();

function status(overrides: Partial<FxStatusResponse> = {}): FxStatusResponse {
  return fxStatusResponseSchema.parse({
    enabled: true,
    baseAsset: 'USDT',
    quoteCurrency: 'IRT',
    side: 'SELL_USDT_TO_RECEIVE_FIAT',
    primarySource: 'NOBITEX',
    fallbackSource: 'WALLEX',
    freshTtlSeconds: 45,
    maxStaleSeconds: 21_600,
    minAgreeingSources: 2,
    acceptSingleSource: false,
    state: 'FRESH',
    quote: {
      quoteId: 'q-1',
      source: 'WALLEX',
      rate: '103500',
      rateMantissa: '103500',
      rateScale: 0,
      sourceAt: null,
      fetchedAt: iso(10),
      ageSeconds: 10,
      policyVersion: 1,
    },
    lastAttemptAt: iso(10),
    lastErrorCode: null,
    sources: [
      {
        source: 'NOBITEX',
        enabled: true,
        lastSuccessAt: null,
        lastFailureAt: iso(30),
        lastFailureCode: 'nobitex.http_403',
        retryAfter: null,
        consecutiveFailures: 4,
      },
      {
        source: 'WALLEX',
        enabled: true,
        lastSuccessAt: iso(10),
        lastFailureAt: null,
        lastFailureCode: null,
        retryAfter: null,
        consecutiveFailures: 0,
      },
    ],
    stars: {
      pricingMode: 'CENTRAL_FX_RATIO',
      starsPerUsdt: '100',
      fixedRateMinor: null,
      centralRatePerStar: null,
    },
    policyVersion: 1,
    ...overrides,
  });
}

const settingRow = (key: string, value: boolean, version = 3) => ({
  key,
  value,
  source: 'TENANT',
  version,
  updatedAt: null,
  updatedByAdminId: null,
  description: '',
  zeroMeaning: 'NOT_APPLICABLE',
  mutability: 'RUNTIME',
  classification: 'PUBLIC',
  configures: 'central_fx',
  consumer: 'ACTIVE',
  storedValueInvalid: false,
});

describe('the sources table', () => {
  it('shows last success, consecutive errors and the last error in Persian', async () => {
    stubApi([{ url: '/fx/status', body: status() }]);
    renderPage(<FxSection denied={false} mayEdit={false} />);
    // The Persian sentence for a 403, not the raw code alone.
    expect((await screen.findByTestId('fx-error-NOBITEX')).textContent).toBe(
      t('web.fx_err_http_403'),
    );
    expect(screen.getAllByText(formatNumber(4)).length).toBeGreaterThan(0);
  });

  it('names every error kind a source can report, and falls back to the raw code', () => {
    expect(fxSourceErrorLabel('wallex.timeout')).toBe(t('web.fx_err_timeout'));
    expect(fxSourceErrorLabel('outlier')).toBe(t('web.fx_err_outlier'));
    expect(fxSourceErrorLabel('outside_band')).toBe(t('web.fx_err_outside_band'));
    expect(fxSourceErrorLabel('tabdeal.bad_price')).toBe(t('web.fx_err_bad_price'));
    expect(fxSourceErrorLabel('bitpin.no_market')).toBe(t('web.fx_err_no_market'));
    expect(fxSourceErrorLabel('wallex.rate_limited')).toBe(t('web.fx_err_rate_limited'));
    expect(fxSourceErrorLabel('wallex.malformed_response')).toBe(
      t('web.fx_err_malformed_response'),
    );
    expect(fxSourceErrorLabel('wallex.http_502')).toBe(
      t('web.fx_err_http').replace('{status}', '502'),
    );
    expect(fxSourceErrorLabel('something.else')).toBe('something.else');
  });

  it('draws the switch as a read-only badge without settings permission', async () => {
    stubApi([{ url: '/fx/status', body: status() }]);
    renderPage(<FxSection denied={false} mayEdit maySettingsEdit={false} />);
    await screen.findByTestId('fx-strip');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('flips a source off through the ordinary settings write, with the version it read', async () => {
    const api = stubApi([
      { url: '/fx/status', body: status() },
      {
        url: '/settings',
        body: {
          settings: [
            settingRow('fx.source_nobitex_enabled', true, 7),
            settingRow('fx.source_wallex_enabled', true, 2),
          ],
        },
      },
      {
        url: '/settings/fx.source_nobitex_enabled',
        method: 'POST',
        body: { key: 'fx.source_nobitex_enabled', value: false, version: 8, changed: true },
      },
    ]);
    renderPage(<FxSection denied={false} mayEdit maySettingsEdit />);
    const toggle = await screen.findByRole('switch', {
      name: `${t('web.fx_source_switch')} ${t('web.fx_source_nobitex')}`,
    });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.method === 'POST' && call.url.includes('fx.source_nobitex_enabled'),
        ),
      ).toBe(true),
    );
    const write = api.calls.find(
      (call) => call.method === 'POST' && call.url.includes('fx.source_nobitex_enabled'),
    );
    expect(write?.body).toMatchObject({ value: false, expectedVersion: 7 });
    expect(typeof (write?.body as { idempotencyKey: string }).idempotencyKey).toBe('string');
  });
});

describe('the fallback window', () => {
  it('warns with the age and the limit while the last stored rate prices, and says what follows', async () => {
    stubApi([
      {
        url: '/fx/status',
        body: status({
          state: 'STALE_ALLOWED',
          quote: { ...status().quote!, ageSeconds: 7_200 },
        }),
      },
    ]);
    renderPage(<FxSection denied={false} mayEdit={false} />);
    const banner = await screen.findByText(/قدیمی‌تر از/u);
    expect(banner.textContent).toContain(`${formatNumber(2)} ${t('web.unit_hours')}`);
    expect(banner.textContent).toContain(`${formatNumber(6)} ${t('web.unit_hours')}`);
  });

  it('says no rate is invented once the window has passed', async () => {
    stubApi([{ url: '/fx/status', body: status({ state: 'UNAVAILABLE' }) }]);
    renderPage(<FxSection denied={false} mayEdit={false} />);
    const alert = await screen.findByText(t('web.fx_unavailable_banner'));
    expect(
      within(alert.closest('div') as HTMLElement).getByText(t('web.fx_unavailable_banner')),
    ).toBeInTheDocument();
  });

  it('lists the agreement policy: the count and the single-source opt-in', async () => {
    stubApi([
      { url: '/fx/status', body: status({ acceptSingleSource: true, minAgreeingSources: 3 }) },
    ]);
    renderPage(<FxSection denied={false} mayEdit={false} />);
    await screen.findByText(t('web.fx_min_agreeing'));
    expect(screen.getByText(t('web.fx_accept_single'))).toBeInTheDocument();
  });
});
