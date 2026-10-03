import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';
import { OrderPlacement } from '../../apps/web/src/pages/order-placement';
import { PanelHealthPage } from '../../apps/web/src/pages/panel-health';
import { panel, renderPage, stubApi } from './harness';

/**
 * Phase C3 in the Web Admin: the explanation of a placement, and the group control.
 * Over the real client and its zod parsing, so a drifted shape fails here.
 */

const ORDER_ID = '01a0c300-0000-7000-8000-0000000000aa';
const HOME = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const PEER = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';

describe('the placement explanation', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('says which rule chose the panel, and shows every candidate with its figures', async () => {
    stubApi([
      {
        url: `/orders/${ORDER_ID}/placement`,
        body: {
          placement: {
            homePanelId: HOME,
            chosenPanelId: PEER,
            group: 'eu',
            strategy: 'LEAST_USED',
            decidedBy: 'LOAD',
            decidedAt: '2026-09-06T08:00:00.000Z',
            candidates: [
              {
                panelId: PEER,
                panelName: 'Peer',
                rank: 1,
                excluded: null,
                ineligibleReason: null,
                healthy: true,
                used: 0,
                maxServices: 10,
                home: false,
              },
              {
                panelId: HOME,
                panelName: 'Home',
                rank: null,
                excluded: 'INELIGIBLE',
                ineligibleReason: 'DRAINING',
                healthy: true,
                used: 7,
                maxServices: 10,
                home: true,
              },
            ],
          },
        },
      },
    ]);
    renderPage(<OrderPlacement orderId={ORDER_ID} />);
    expect(await screen.findByText(t('web.bal_decided_load'))).toBeInTheDocument();
    expect(screen.getByText('eu')).toBeInTheDocument();
    expect(screen.getByText(t('web.balancing_strategy_least_used'))).toBeInTheDocument();
    const home = screen.getByRole('link', { name: 'Home' }).closest('tr') as HTMLElement;
    expect(within(home).getByText(t('web.bal_placement_home'))).toBeInTheDocument();
    expect(within(home).getByText(/فروش جدید متوقف است/u)).toBeInTheDocument();
  });

  it('says plainly when the order took the explicit route', async () => {
    stubApi([{ url: `/orders/${ORDER_ID}/placement`, body: { placement: null } }]);
    renderPage(<OrderPlacement orderId={ORDER_ID} />);
    expect(await screen.findByText(t('web.bal_placement_none'))).toBeInTheDocument();
  });
});

describe('the balancing group on the panel health page', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const dashboard = (overrides: Record<string, unknown>) => ({
    url: '/panel-health',
    body: {
      rows: [
        {
          panel: panel(overrides),
          services: { active: 0, suspended: 0, expired: 0, pending: 0, unreconciled: 0 },
          provisioning: {
            failedInWindow: 0,
            unknownOpen: 0,
            lastFailureAt: null,
            lastFailureKind: null,
          },
          conditions: [],
        },
      ],
      nextCursor: null,
      generatedAt: '2026-09-06T08:00:00.000Z',
      failureWindowMs: 86_400_000,
    },
  });

  it('shows the group, and edits it through the panel write with a stable key', async () => {
    const api = stubApi([
      dashboard({ balancingGroup: null }),
      { url: `/panels/${HOME}`, body: { panel: panel({ balancingGroup: 'eu-west' }) } },
    ]);
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    expect(await screen.findByText(t('web.bal_group_none'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.bal_group_edit') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('web.bal_group')), {
      target: { value: ' EU-West ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.bal_group_save') }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith(`/panels/${HOME}`)),
      ).toBe(true),
    );
    const call = api.calls.find((one) => one.method === 'POST');
    expect(call?.body).toMatchObject({ balancingGroup: 'eu-west' });
    expect(typeof (call?.body as { idempotencyKey: string }).idempotencyKey).toBe('string');
  });

  it('offers no group control without panels.edit', async () => {
    stubApi([dashboard({ balancingGroup: 'eu' })]);
    renderPage(
      <PanelHealthPage denied={false} mayProbe={false} mayDrain={false} mayViewServices={false} />,
    );
    expect(await screen.findByText('eu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.bal_group_edit') })).toBeNull();
  });
});
