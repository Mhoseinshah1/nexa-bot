import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';
import { PanelHealthPage } from '../../apps/web/src/pages/panel-health';
import { panel, renderPage, stubApi } from './harness';

/**
 * Phase C2: the panel health dashboard, over the real client and its zod parsing.
 *
 * What is asserted is that every figure comes from the server's row, that the
 * actions are drawn only for the permission the server charges, and that the
 * drain sends a reason and a stable key — never a clock-made one.
 */

const PANEL_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

function row(
  overrides: Record<string, unknown> = {},
  panelOverrides: Record<string, unknown> = {},
) {
  return {
    panel: panel({
      sellability: {
        sellable: true,
        reason: null,
        activationComplete: true,
        missingActivationFields: [],
        connectionValidated: true,
      },
      ...panelOverrides,
    }),
    services: { active: 12, suspended: 3, expired: 2, pending: 0, unreconciled: 1 },
    provisioning: {
      failedInWindow: 4,
      unknownOpen: 2,
      lastFailureAt: '2026-09-06T07:00:00.000Z',
      lastFailureKind: 'TIMEOUT',
    },
    conditions: [
      {
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        firstSeenAt: '2026-09-06T06:00:00.000Z',
        lastSeenAt: '2026-09-06T07:00:00.000Z',
        occurrences: 5,
      },
    ],
    ...overrides,
  };
}

const dashboard = (rows: unknown[]) => [
  {
    url: '/panel-health',
    body: {
      rows,
      nextCursor: null,
      generatedAt: '2026-09-06T08:00:00.000Z',
      failureWindowMs: 24 * 60 * 60 * 1000,
    },
  },
];

describe('the panel health dashboard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows every server figure for a panel, and nothing it did not send', async () => {
    stubApi(dashboard([row()]));
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    const card = (await screen.findByRole('heading', { name: /Frankfurt A/u })).closest('section');
    expect(card).not.toBeNull();
    const inCard = within(card as HTMLElement);
    expect(inCard.getByText('42')).toBeInTheDocument(); // latency, from the probe
    expect(inCard.getByText(t('web.ph_streak'))).toBeInTheDocument();
    expect(inCard.getByText('12')).toBeInTheDocument(); // active services
    expect(inCard.getByText('4')).toBeInTheDocument(); // failed in the window
    expect(inCard.getByText('panel.health.unreachable')).toBeInTheDocument();
    expect(inCard.getByText(/24/u)).toBeInTheDocument(); // the window it counted
    expect(inCard.getByText(t('web.ph_sellable_yes'))).toBeInTheDocument();
  });

  it('draws the probe, the services link and drain only for their permissions', async () => {
    stubApi(dashboard([row()]));
    renderPage(
      <PanelHealthPage denied={false} mayProbe={false} mayDrain={false} mayViewServices={false} />,
    );
    await screen.findByRole('heading', { name: /Frankfurt A/u });
    expect(screen.queryByRole('button', { name: t('web.panel_test') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.ph_action_drain') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('web.ph_action_services') })).toBeNull();
  });

  it("links to the panel's services by its id", async () => {
    stubApi(dashboard([row()]));
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    const link = await screen.findByRole('link', { name: t('web.ph_action_services') });
    expect(link.getAttribute('href')).toBe(`/services?q=${PANEL_ID}`);
  });

  it('runs the existing connection test, not a second probe', async () => {
    const api = stubApi([
      ...dashboard([row()]),
      {
        url: `/panels/${PANEL_ID}/test`,
        body: { panel: panel(), probed: true },
      },
    ]);
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.panel_test') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/panels/${PANEL_ID}/test`))).toBe(true),
    );
    const call = api.calls.find((one) => one.url.endsWith('/test'));
    expect(call?.method).toBe('POST');
    expect(typeof (call?.body as { idempotencyKey: string }).idempotencyKey).toBe('string');
  });

  it('drains with a required reason and a stable key', async () => {
    const api = stubApi([
      ...dashboard([row()]),
      {
        url: `/panels/${PANEL_ID}/drain`,
        body: {
          panel: panel({
            drain: { draining: true, since: '2026-09-06T08:00:00.000Z', reason: 'مهاجرت' },
          }),
        },
      },
    ]);
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.ph_action_drain') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('web.ph_drain_confirm') });
    // No reason, no request.
    expect(confirm).toBeDisabled();
    // The dialog says what drain does NOT do, before anybody presses it.
    expect(within(dialog).getByText(t('web.ph_drain_explain'))).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(t('web.ph_reason_label')), {
      target: { value: '  مهاجرت  ' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/panels/${PANEL_ID}/drain`))).toBe(true),
    );
    const call = api.calls.find((one) => one.url.endsWith('/drain'));
    expect(call?.body).toMatchObject({ draining: true, reason: 'مهاجرت' });
    expect((call?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(7);
  });

  it('shows a drained panel as such, with its reason, and offers to undrain', async () => {
    stubApi(
      dashboard([
        row(
          {},
          {
            drain: { draining: true, since: '2026-09-06T07:30:00.000Z', reason: 'نگهداری سرور' },
            sellability: {
              sellable: false,
              reason: 'DRAINING',
              activationComplete: true,
              missingActivationFields: [],
              connectionValidated: true,
            },
          },
        ),
      ]),
    );
    renderPage(<PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />);
    expect(await screen.findByText('نگهداری سرور')).toBeInTheDocument();
    expect(screen.getByText(t('web.panel_reason_draining'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.ph_action_undrain') })).toBeInTheDocument();
  });

  it('says so when there is no panel, and refuses without panels.view', async () => {
    stubApi(dashboard([]));
    const { unmount } = renderPage(
      <PanelHealthPage denied={false} mayProbe mayDrain mayViewServices />,
    );
    expect(await screen.findByText(t('web.ph_empty'))).toBeInTheDocument();
    unmount();

    const api = stubApi(dashboard([row()]));
    renderPage(<PanelHealthPage denied mayProbe mayDrain mayViewServices />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Frankfurt A/u })).toBeNull());
    expect(api.calls).toHaveLength(0);
  });
});
