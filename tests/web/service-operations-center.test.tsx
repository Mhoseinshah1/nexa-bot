import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ServiceActionAvailability } from '@nexa/contracts';
import { BulkOperationDetailPage } from '../../apps/web/src/pages/bulk-operations';
import {
  ServiceGrantMoveCard,
  ServiceMassActionCard,
  massDefinitionOf,
  type ServiceFilters,
} from '../../apps/web/src/pages/service-ops';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Program §13 — the Service Operations Center in the Web Admin, through the real API client:
 * the mass action over the filtered set (preview, the dry run, confirmation), an operator's
 * grant, and the retry of FAILED items.
 */

const SERVICE = '019290ab-cdef-7012-8345-6789abcdef09';
const OP = '019290ab-cdef-7012-8345-6789abcdef01';
const RETRY = '019290ab-cdef-7012-8345-6789abcdef02';
const PANEL = '019290ab-cdef-7012-8345-6789abcdef03';

const FILTERS: ServiceFilters = {
  state: 'ACTIVE',
  deliveryState: null,
  panelId: PANEL,
  productId: null,
  locationKey: null,
  expiringWithinHours: 72,
  q: '',
};

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OP,
    kind: 'SERVICE_SUSPEND',
    state: 'COMPLETED',
    amount: null,
    trafficBytes: null,
    durationDays: null,
    notify: false,
    note: 'maintenance',
    audience: { version: 1 },
    audienceHash: 'a'.repeat(64),
    audienceAsOf: '2026-09-20T10:00:00.000Z',
    notBefore: null,
    frozenAudienceId: null,
    itemCount: 3,
    fingerprint: 'b'.repeat(32),
    totalLiability: null,
    creditedTotal: null,
    counts: {
      total: 3,
      pending: 0,
      credited: 0,
      planned: 0,
      awaitingReconciliation: 0,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      cancelled: 0,
      notified: 0,
      notificationQueued: 0,
    },
    progressPercent: 100,
    createdBy: { id: 'x', username: 'owner' },
    createdAt: '2026-09-20T10:00:00.000Z',
    pausedAt: null,
    completedAt: '2026-09-20T10:05:00.000Z',
    cancelledAt: null,
    retryOfId: null,
    ...overrides,
  };
}

describe('the mass action over the filtered set', () => {
  it('stands for exactly the filters the shared audience can express, or for nothing', () => {
    expect(massDefinitionOf(FILTERS)).toEqual({
      version: 1,
      customerStatus: 'ANY',
      service: {
        productIds: [],
        panelIds: [PANEL],
        states: ['ACTIVE'],
        expiringWithinHours: 72,
        expired: false,
      },
    });
    // A set the operator cannot select by these filters is never acted on in bulk.
    expect(massDefinitionOf({ ...FILTERS, q: 'nx-1' })).toBeNull();
    expect(massDefinitionOf({ ...FILTERS, deliveryState: 'FAILED' })).toBeNull();
    expect(massDefinitionOf({ ...FILTERS, locationKey: 'de' })).toBeNull();
  });

  it('previews the eligible and the excluded, and suspends only after a reason and a confirmation', async () => {
    const api = stubApi([
      {
        url: '/bulk-operations/preview',
        body: {
          preview: {
            kind: 'SERVICE_SUSPEND',
            asOf: '2026-09-20T10:00:00.000Z',
            definition: { version: 1 },
            definitionHash: 'a'.repeat(64),
            count: 4,
            customers: 4,
            fingerprint: 'b'.repeat(32),
            totalLiability: null,
            trafficBytesPerItem: null,
            durationDaysPerItem: null,
            sample: [],
            ineligible: {
              selected: 6,
              notInState: 1,
              panelNotOperable: 1,
              other: 0,
              sample: [
                {
                  serviceId: SERVICE,
                  serviceLabel: 'nx_xui_1',
                  customerId: 'c',
                  reason: 'PANEL_NOT_OPERABLE',
                },
              ],
            },
          },
        },
      },
      { url: '/bulk-operations', body: { operation: operation({ state: 'RUNNING' }) } },
    ]);
    renderPage(<ServiceMassActionCard filters={FILTERS} mayStatus mayGrant={false} />);
    fireEvent.click(screen.getByRole('button', { name: t('web.bulk_preview_button') }));
    expect(await screen.findByText('nx_xui_1')).toBeInTheDocument();
    expect(screen.getAllByText(t('web.soc_ineligible_panel')).length).toBeGreaterThan(0);

    const execute = screen.getByRole('button', { name: t('web.bulk_execute') });
    expect(execute).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.bulk_reason')), {
      target: { value: 'panel maintenance' },
    });
    expect(execute).not.toBeDisabled();
    fireEvent.click(execute);
    expect(
      api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/bulk-operations')),
    ).toBe(false);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: t('web.cb_bulk_run_yes'),
      }),
    );
    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/bulk-operations')),
      ).toBe(true);
    });
    const created = api.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/bulk-operations'),
    );
    expect(created?.body).toMatchObject({
      grant: { kind: 'SERVICE_SUSPEND' },
      notify: false,
      note: 'panel maintenance',
      expectedCount: 4,
      expectedFingerprint: 'b'.repeat(32),
      confirmed: true,
    });
  });

  it('offers no mass action for filters it cannot express', () => {
    stubApi([]);
    renderPage(<ServiceMassActionCard filters={{ ...FILTERS, q: 'x' }} mayStatus mayGrant />);
    expect(screen.getByText(t('web.soc_mass_unrepresentable'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.bulk_preview_button') })).toBeNull();
  });
});

describe('an operator’s grant on one service', () => {
  const actions = (over: Partial<Record<string, ServiceActionAvailability>> = {}) =>
    (['ADD_TRAFFIC', 'ADD_TIME', 'CHANGE_LOCATION'] as const).map(
      (action) => over[action] ?? { action, available: true, blocker: null },
    );

  it('sends the typed GB and the reason, under a key, and says nothing is done yet', async () => {
    const api = stubApi([
      { url: `/services/${SERVICE}/location-targets`, body: { current: null, targets: [] } },
    ]);
    renderPage(
      <ServiceGrantMoveCard
        serviceId={SERVICE}
        actions={actions()}
        mayGrant
        mayEdit={false}
        blockerLabel={(blocker) => blocker}
        onActed={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText(t('web.soc_grant_gb')), { target: { value: '5' } });
    const button = screen.getByRole('button', { name: t('web.soc_grant_traffic_button') });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.soc_reason')), { target: { value: 'sorry' } });
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith(`/services/${SERVICE}/grant`)).toBe(true);
    expect(posted?.body).toEqual({
      kind: 'ADD_TRAFFIC',
      trafficGb: '5',
      reason: 'sorry',
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('says why a grant is unavailable, and draws no form without services.grant', () => {
    stubApi([]);
    const { unmount } = renderPage(
      <ServiceGrantMoveCard
        serviceId={SERVICE}
        actions={actions({
          ADD_TRAFFIC: { action: 'ADD_TRAFFIC', available: false, blocker: 'UNLIMITED' },
        })}
        mayGrant
        mayEdit={false}
        blockerLabel={(blocker) => `blocked:${blocker}`}
        onActed={() => undefined}
      />,
    );
    expect(screen.getByText('blocked:UNLIMITED')).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.soc_grant_gb'))).toBeNull();
    unmount();
    renderPage(
      <ServiceGrantMoveCard
        serviceId={SERVICE}
        actions={actions()}
        mayGrant={false}
        mayEdit={false}
        blockerLabel={(blocker) => blocker}
        onActed={() => undefined}
      />,
    );
    expect(screen.queryByLabelText(t('web.soc_grant_gb'))).toBeNull();
    expect(screen.getAllByText(t('web.soc_grant_denied')).length).toBe(2);
  });
});

describe('retrying the FAILED items of a mass operation', () => {
  it('counts them first, then starts a NEW operation bound to that count', async () => {
    const api = stubApi([
      { url: `/bulk-operations/${OP}/items`, body: { items: [], nextCursor: null } },
      {
        url: `/bulk-operations/${OP}/retry/preview`,
        body: {
          preview: {
            operationId: OP,
            kind: 'SERVICE_SUSPEND',
            count: 1,
            fingerprint: 'c'.repeat(32),
          },
        },
      },
      {
        url: `/bulk-operations/${OP}/retry`,
        body: { operation: operation({ id: RETRY, retryOfId: OP, state: 'RUNNING' }) },
      },
      { url: `/bulk-operations/${OP}`, body: { operation: operation() } },
    ]);
    renderPage(
      <BulkOperationDetailPage
        id={OP}
        denied={false}
        mayWallet={false}
        mayGrant={false}
        mayStatus
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.bulk_retry_preview') }));
    expect(await screen.findByText(t('web.bulk_retry_count'))).toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText(t('web.bulk_reason'), { selector: '#bulk-retry-note' }),
      {
        target: { value: 'panel back' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.bulk_retry_button') }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: t('web.bulk_retry_button'),
      }),
    );
    await waitFor(() => {
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith(`/${OP}/retry`)),
      ).toBe(true);
    });
    const posted = api.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith(`/${OP}/retry`),
    );
    expect(posted?.body).toMatchObject({
      note: 'panel back',
      expectedCount: 1,
      expectedFingerprint: 'c'.repeat(32),
      confirmed: true,
    });
  });

  it('offers no retry when nothing failed', async () => {
    stubApi([
      { url: `/bulk-operations/${OP}/items`, body: { items: [], nextCursor: null } },
      {
        url: `/bulk-operations/${OP}`,
        body: {
          operation: operation({
            counts: { ...(operation().counts as object), failed: 0, succeeded: 3 },
          }),
        },
      },
    ]);
    renderPage(
      <BulkOperationDetailPage
        id={OP}
        denied={false}
        mayWallet={false}
        mayGrant={false}
        mayStatus
      />,
    );
    expect(await screen.findAllByText(t('web.bulk_kind_suspend'))).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: t('web.bulk_retry_preview') })).toBeNull();
  });
});
