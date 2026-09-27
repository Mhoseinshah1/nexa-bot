import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { SystemPage } from '../../apps/web/src/pages/system';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * WP16 D3 (`docs/wp16-admin-ops-audit.md`): the Diagnostics tab.
 *
 * Read-only: the tab asks for nothing without `opslog.view`, draws the server's counts
 * and rows through the real client and contract schema, links each stuck operation to
 * its service, and offers no control that changes anything.
 */

const route = {
  path: '/system',
  query: new URLSearchParams('section=diagnostics'),
} as unknown as Parameters<typeof SystemPage>[0]['route'];

const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';

const diagnostics = {
  generatedAt: '2026-09-26T08:00:00.000Z',
  outbox: {
    pending: 7,
    oldestPendingAt: '2026-09-26T07:00:00.000Z',
    failing: 2,
    exhausted: 1,
    failingSample: [
      {
        id: '019260ab-cdef-7012-8345-6789abcdef01',
        eventType: 'PaymentSettled',
        aggregateType: 'Payment',
        attempts: 4,
        occurredAt: '2026-09-26T07:00:00.000Z',
        lastError: 'consumer failed delivering [url] to panel',
        nextAttemptAt: '2026-09-26T08:05:00.000Z',
        exhausted: false,
      },
      {
        id: '019260ab-cdef-7012-8345-6789abcdef02',
        eventType: 'RefundCompleted',
        aggregateType: 'Refund',
        attempts: 12,
        occurredAt: '2026-09-26T06:30:00.000Z',
        lastError: 'consumer failed',
        nextAttemptAt: null,
        exhausted: true,
      },
    ],
  },
  provisioning: {
    counts: { UNKNOWN_OUTCOME: 1, LEASE_EXPIRED: 0, RETRYING: 2, UNANNOUNCED: 0 },
    sample: [
      {
        operationId: '019270ab-cdef-7012-8345-6789abcdef01',
        serviceId: SERVICE_ID,
        type: 'PROVISION',
        state: 'UNKNOWN',
        reason: 'UNKNOWN_OUTCOME',
        attempts: 1,
        nextAttemptAt: null,
        createdAt: '2026-09-26T06:00:00.000Z',
        updatedAt: '2026-09-26T06:30:00.000Z',
      },
    ],
  },
};

describe('the diagnostics tab', () => {
  it('asks for nothing and says so without opslog.view', async () => {
    const api = stubApi([{ url: '/system/diagnostics', body: diagnostics }]);
    renderPage(<SystemPage route={route} permissions={[]} />);
    expect(await screen.findAllByText(t('web.no_permission'))).not.toHaveLength(0);
    expect(api.calls.filter((call) => call.url.includes('/system/diagnostics'))).toHaveLength(0);
  });

  it('draws the counts, the stuck operation linked to its service, and the failing event', async () => {
    stubApi([{ url: '/system/diagnostics', body: diagnostics }]);
    renderPage(<SystemPage route={route} permissions={['opslog.view']} />);

    const stuck = await screen.findByRole('table', {
      name: t('web.diagnostics_provisioning_title'),
    });
    expect(within(stuck).getByText(t('web.diagnostics_reason_unknown'))).toBeInTheDocument();
    expect(within(stuck).getByRole('link').getAttribute('href')).toBe(`/services/${SERVICE_ID}`);

    const outbox = screen.getByRole('table', { name: t('web.diagnostics_outbox_title') });
    expect(outbox.textContent).toContain('PaymentSettled');
    expect(outbox.textContent).toContain('[url]');
    expect(screen.getByText(t('web.diagnostics_outbox_failing_banner'))).toBeInTheDocument();
  });

  it('names the messages no longer retried, and when each other one is tried next (WP20)', async () => {
    stubApi([{ url: '/system/diagnostics', body: diagnostics }]);
    renderPage(<SystemPage route={route} permissions={['opslog.view']} />);
    const outbox = await screen.findByRole('table', { name: t('web.diagnostics_outbox_title') });
    expect(screen.getByText(t('web.diagnostics_outbox_exhausted_banner'))).toBeInTheDocument();
    expect(within(outbox).getByText(t('web.diagnostics_no_more_attempts'))).toBeInTheDocument();
    // The one still being retried shows its next attempt, not the exhausted badge.
    expect(within(outbox).getAllByText(t('web.diagnostics_no_more_attempts'))).toHaveLength(1);
  });

  it('draws no exhausted banner when nothing has run out of attempts', async () => {
    stubApi([
      {
        url: '/system/diagnostics',
        body: {
          ...diagnostics,
          outbox: {
            ...diagnostics.outbox,
            exhausted: 0,
            failingSample: diagnostics.outbox.failingSample.slice(0, 1),
          },
        },
      },
    ]);
    renderPage(<SystemPage route={route} permissions={['opslog.view']} />);
    await screen.findByRole('table', { name: t('web.diagnostics_outbox_title') });
    expect(screen.queryByText(t('web.diagnostics_outbox_exhausted_banner'))).toBeNull();
  });

  it('offers no control that changes anything', async () => {
    stubApi([{ url: '/system/diagnostics', body: diagnostics }]);
    const view = renderPage(<SystemPage route={route} permissions={['opslog.view']} />);
    await screen.findByRole('table', { name: t('web.diagnostics_provisioning_title') });
    const panel = view.container.querySelector('#system-panel') ?? view.container;
    // The tab strip lives outside the panel; inside it there is nothing to press.
    expect(within(panel as HTMLElement).queryAllByRole('button')).toHaveLength(0);
  });
});
