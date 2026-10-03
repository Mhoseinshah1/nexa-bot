import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { GatewayHealthResponse, GatewayHealthView } from '@nexa/contracts';
import {
  GatewayHealthPanel,
  PaymentGatewaysTabbedPage,
  healthRangeOf,
  opsLinkFor,
} from '../../apps/web/src/pages/gateway-health';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Gateway Health in the Web Admin (program §11). Fixtures are parsed by
 * `gatewayHealthResponseSchema` through the real client.
 *
 * What this file defends: every line is the server's record, a route with none says
 * "not recorded"; there is no percentage and no latency figure; a route with no safe check
 * says so; the queue figures link into the Payment Operations Center for that route; and the
 * payments facts are named withheld rather than shown as zero.
 */

const routeOf = (query: Record<string, string> = {}) => ({
  path: '/payment-gateways',
  query: new URLSearchParams(query),
});

function view(overrides: Partial<GatewayHealthView> = {}): GatewayHealthView {
  return {
    provider: 'NOWPAYMENTS',
    status: 'ACTIVE',
    state: 'ATTENTION',
    configuration: { complete: true, gaps: [] },
    check: { supported: true, lastAt: '2026-10-03T07:00:00.000Z', lastResult: 'refused:AUTH' },
    answers: {
      lastInvoiceCreatedAt: '2026-10-03T08:00:00.000Z',
      lastInquiryAnsweredAt: '2026-10-03T08:05:00.000Z',
      lastInquiryFailure: { at: '2026-10-03T08:06:00.000Z', code: 'HTTP_503' },
      lastCreateFailure: null,
      attemptsInWindow: 12,
      attemptsWithProviderError: 3,
    },
    callBudget: { windowStartedAt: '2026-10-03T08:00:00.000Z', used: 9 },
    openConditions: [
      {
        code: 'payments.gateway_webhook_unverified',
        severity: 'WARN',
        count: 1,
        since: '2026-10-03T06:00:00.000Z',
      },
    ],
    queues: {
      PENDING: 4,
      UNKNOWN: 2,
      NEEDS_RECONCILIATION: 1,
      MISMATCH: 1,
      PARTIAL: 0,
      LATE_COMPLETION: 0,
      PROVIDER_ERROR: 3,
      REFUND_RELATED: 0,
    },
    lastReconciliation: { at: '2026-10-03T08:10:00.000Z', action: 'payment.reconcile_failed' },
    signals: [],
    ...overrides,
  };
}

const response = (
  gateways: GatewayHealthView[],
  withheld: GatewayHealthResponse['withheld'] = [],
): GatewayHealthResponse => ({
  window: null,
  gateways,
  withheld,
  generatedAt: '2026-10-03T09:00:00.000Z',
});

describe('gateway health', () => {
  it('shows what was recorded, by code, with counts and never a percentage or a latency figure', async () => {
    stubApi([{ url: '/payment-gateways-health', body: response([view()]) }]);
    const { container } = renderPage(<GatewayHealthPanel route={routeOf()} denied={false} />);
    await screen.findByText(t('web.gateway_health_state_attention'));
    const text = container.textContent ?? '';
    expect(text).toContain('HTTP_503');
    expect(text).toContain('payments.gateway_webhook_unverified');
    expect(text).toContain(t('web.gateway_health_latency_not_measured'));
    expect(text).not.toMatch(/%|٪/u);
    const ops = [...container.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === opsLinkFor('NOWPAYMENTS', 'UNKNOWN'),
    );
    expect(ops?.textContent).toContain('2');
    expect(container.querySelector('a[href="/payment-gateways"]')).not.toBeNull();
  });

  it('says "not recorded" for a route with no history, and that a route has no safe check', async () => {
    stubApi([
      {
        url: '/payment-gateways-health',
        body: response([
          view({
            provider: 'CENTRALPAY',
            status: 'DISABLED',
            state: 'DISABLED',
            configuration: { complete: false, gaps: ['CREDENTIAL_MISSING', 'VERIFY_KEY_MISSING'] },
            check: { supported: false, lastAt: null, lastResult: null },
            answers: {
              lastInvoiceCreatedAt: null,
              lastInquiryAnsweredAt: null,
              lastInquiryFailure: null,
              lastCreateFailure: null,
              attemptsInWindow: 0,
              attemptsWithProviderError: 0,
            },
            callBudget: null,
            openConditions: [],
            lastReconciliation: null,
          }),
        ]),
      },
    ]);
    const { container } = renderPage(<GatewayHealthPanel route={routeOf()} denied={false} />);
    await screen.findByText(t('web.gateway_health_check_unsupported'));
    expect(screen.getByText(t('web.gateway_health_gap_credential_missing'))).toBeTruthy();
    expect(screen.getByText(t('web.gateway_health_gap_verify_key_missing'))).toBeTruthy();
    expect(screen.getAllByText(t('web.gateway_health_none_recorded')).length).toBeGreaterThan(3);
    expect(container.textContent).toContain(t('web.gateway_health_state_disabled'));
  });

  it('names the payments facts withheld instead of drawing zeros', async () => {
    stubApi([
      {
        url: '/payment-gateways-health',
        body: response([view({ queues: null, lastReconciliation: null })], ['PAYMENTS']),
      },
    ]);
    const { container } = renderPage(<GatewayHealthPanel route={routeOf()} denied={false} />);
    await screen.findByText(t('web.gateway_health_queues_withheld'));
    expect(
      [...container.querySelectorAll('a')].some((a) =>
        (a.getAttribute('href') ?? '').includes('queue='),
      ),
    ).toBe(false);
  });

  it('asks for the last seven days by default, a named range when chosen, and no bound for ALL', async () => {
    expect(healthRangeOf(null)).toBe('LAST_7_DAYS');
    expect(healthRangeOf('LAST_30_DAYS')).toBe('LAST_30_DAYS');
    expect(healthRangeOf('ALL')).toBeNull();
    expect(healthRangeOf('FOREVER')).toBe('LAST_7_DAYS');
    const api = stubApi([{ url: '/payment-gateways-health', body: response([view()]) }]);
    renderPage(<GatewayHealthPanel route={routeOf({ range: 'ALL' })} denied={false} />);
    await screen.findByText(t('web.gateway_health_state_attention'));
    const call = api.calls.find((c) => c.url.includes('/payment-gateways-health'));
    expect(call?.url).not.toContain('range=');
  });

  it('is a tab beside the configuration, chosen by the URL', async () => {
    stubApi([
      { url: '/payment-gateways-health', body: response([view()]) },
      { url: '/payment-gateways', body: { gateways: [] } },
    ]);
    renderPage(
      <PaymentGatewaysTabbedPage
        route={routeOf({ tab: 'health' })}
        denied={false}
        mayEdit={false}
      />,
    );
    await screen.findByText(t('web.gateway_health_state_attention'));
    const tab = screen.getByRole('tab', { name: t('web.gateway_tab_health') });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: t('web.gateway_tab_config') })).toBeTruthy();
  });
});
