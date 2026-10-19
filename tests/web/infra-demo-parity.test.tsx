import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { t } from '../../apps/web/src/i18n/web.fa';
import { opsCodeLabel } from '../../apps/web/src/ops-code-labels';
import { FailureBadge, PanelDetailPage, PanelsPage } from '../../apps/web/src/pages/panels';
import { AlertsPage } from '../../apps/web/src/pages/alerts';
import { AuditLogPage } from '../../apps/web/src/pages/audit-log';
import { OpsGroupPage } from '../../apps/web/src/pages/ops-group';
import { SystemPage } from '../../apps/web/src/pages/system';
import { event, panel, renderPage, stubApi } from './harness';
import { DEMO_INFRA } from './shots/fixtures/demo-parity/infra.ts';

/**
 * Demo parity, the infrastructure and system family (`DIFFS.md` — panels, ops-group, system,
 * alerts, audit-log). Each test names the composition the approved demo draws and fails if
 * the page goes back to the shape it replaced.
 */

describe('panels (demo parity)', () => {
  it('names a failure kind with a short pill, the full sentence kept as its title', () => {
    renderPage(<FailureBadge failure="TIMEOUT" />);
    const pill = screen.getByText(t('web.failure_short_timeout'));
    expect(pill.closest('[title]')?.getAttribute('title')).toContain(t('web.diag_failure_timeout'));
    // The long sentence is not the pill's text any more.
    expect(screen.queryByText(t('web.diag_failure_timeout'))).toBeNull();
  });

  it('draws the detail as a page header with its figures as six separate cards', async () => {
    stubApi([{ url: '/panels/', body: { panel: panel() } }]);
    const { container } = renderPage(<PanelDetailPage id="p1" mayEdit mayRotate denied={false} />);
    await screen.findByText('Frankfurt A');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Frankfurt A');
    // Not the hero card it replaced.
    expect(container.querySelector('.detail-head')).toBeNull();
    const strip = container.querySelector('.panel-head-stats') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.querySelectorAll(':scope > .stat')).toHaveLength(6);
    expect(within(strip).getByText(t('web.panel_capacity'))).toBeInTheDocument();
    // The lifecycle hint sits under the header's actions, for an ACTIVE panel.
    expect(screen.getByText(t('web.panel_lifecycle_hint'))).toBeInTheDocument();
  });
});

describe('alerts (demo parity)', () => {
  it('reads «رویداد» as the event title, the code only as its title', async () => {
    stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    expect(
      screen.getByRole('columnheader', { name: t('web.diagnostics_event') }),
    ).toBeInTheDocument();
    // The «کد» column it replaced is gone.
    expect(screen.queryByRole('columnheader', { name: 'کد' })).toBeNull();
    const name = document.querySelector('.alerts-event') as HTMLElement;
    expect(name).toHaveTextContent(opsCodeLabel('admin.roles_changed'));
    expect(name).toHaveAttribute('title', 'admin.roles_changed');
    expect(screen.queryByText('admin.roles_changed')).toBeNull();
  });

  it('reads «پیام» in Persian from the code; the server line lives only in «جزئیات فنی»', async () => {
    stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    const message = document.querySelector('.alerts-message') as HTMLElement;
    expect(message).toHaveTextContent(opsCodeLabel('admin.roles_changed'));
    const raw = screen.getByText('Roles changed.');
    expect(raw.closest('details')).not.toBeNull();
    expect(message.closest('details')).toBeNull();
  });

  it('shows the status filter as a chip even at its default («وضعیت: همه»)', async () => {
    stubApi([{ url: '/ops-log', body: { events: [event()], nextCursor: null } }]);
    const { container } = renderPage(<AlertsPage denied={false} />);
    await screen.findByText('Roles changed.');
    const chip = container.querySelector('.lfb-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent(t('web.status'));
    expect(chip).toHaveTextContent(t('web.all'));
    expect(container.querySelector('.lfb-none')).toBeNull();
  });
});

describe('audit log (demo parity)', () => {
  it('draws the typed filters as an open grid of six labelled fields with apply and clear', async () => {
    stubApi([{ url: '/audit-log', body: { entries: [], nextCursor: null } }]);
    const { container } = renderPage(
      <AuditLogPage
        route={{ path: '/audit-log', query: new URLSearchParams() }}
        denied={false}
        mayExport={false}
      />,
    );
    await screen.findByText(t('web.audit_empty'));
    const grid = container.querySelector('form.audit-filters') as HTMLElement;
    expect(grid).not.toBeNull();
    for (const label of [
      'web.audit_filter_actor',
      'web.audit_filter_action',
      'web.audit_filter_entity_id',
      'web.audit_filter_customer',
      'web.audit_filter_from',
      'web.audit_filter_to',
    ] as const) {
      expect(within(grid).getByText(t(label))).toBeInTheDocument();
    }
    expect(within(grid).getByRole('button', { name: t('web.audit_apply') })).toBeInTheDocument();
    expect(within(grid).getByRole('button', { name: t('web.audit_clear') })).toBeDisabled();
    // Typed into without opening «فیلترها»: the grid is on the page, not in the panel.
    fireEvent.change(within(grid).getByLabelText(t('web.audit_filter_actor')), {
      target: { value: 'sara' },
    });
    expect((screen.getByLabelText(t('web.audit_filter_actor')) as HTMLInputElement).value).toBe(
      'sara',
    );
  });
});

describe('ops group (demo parity)', () => {
  const BOT_A = { id: '01a05e35-c9ad-7e93-bef3-1ed9b5525e01', username: 'first_bot' };
  const BOT_B = { id: '01a05e35-c9ad-7e93-bef3-1ed9b5525e02', username: 'second_bot' };
  const view = {
    connection: 'CONNECTED',
    group: {
      title: 'Nexa Ops',
      bot: BOT_A,
      connectedAt: '2026-09-01T10:00:00.000Z',
      disconnectedAt: null,
    },
    health: 'HEALTHY',
    problems: [],
    checkedAt: '2026-09-01T10:01:00.000Z',
    lastDeliveredAt: '2026-09-01T10:02:00.000Z',
    topics: [{ category: 'SYSTEM', state: 'READY', lastDeliveredAt: null, recreatedCount: 0 }],
    queue: { pending: 0, preserved: 3 },
    laneEnabled: true,
    pendingCodeExpiresAt: null,
    bots: [BOT_A, BOT_B],
    manual: { configured: false, inUse: false },
  };

  it('puts the choice of bot behind «فیلترها» and keeps the requeue in the queue card', async () => {
    stubApi([{ url: '/ops-group', body: { opsGroup: view } }]);
    const { container } = renderPage((<OpsGroupPage denied={false} mayManage />) as ReactElement);
    await screen.findByText('Nexa Ops');
    const connect = container.querySelector('.ops-group-connect') as HTMLElement;
    expect(within(connect).getByRole('button', { name: /فیلترها/u })).toBeInTheDocument();
    // The bot select is not drawn inline any more: it lives in the filter panel.
    expect(container.querySelector('#ops-group-bot')).toBeNull();
    expect(within(connect).getByText(t('web.filters_none'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.opsgroup_requeue') })).toBeInTheDocument();
    expect(container.querySelector('.two-col.ops-group-cols')).not.toBeNull();
  });
});

describe('system (demo parity)', () => {
  it('splits status and build evenly and puts the ops-group link on the logs row', async () => {
    stubApi([
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      {
        url: '/health/info',
        body: {
          name: 'nexa',
          version: '1.0.0',
          commit: 'abc123',
          buildTime: '2026-09-06T00:00:00.000Z',
          nodeVersion: 'v22.11.0',
          environment: 'production',
        },
      },
    ]);
    const { container } = renderPage(
      <SystemPage
        route={{ path: '/system', query: new URLSearchParams() }}
        permissions={['settings.view']}
      />,
    );
    await screen.findByText(t('web.system_logs_title'));
    expect(container.querySelector('.two-col.system-cols')).not.toBeNull();
    const logs = container.querySelector('.system-logs') as HTMLElement;
    expect(within(logs).getByRole('link', { name: t('web.opsgroup_title') })).toHaveAttribute(
      'href',
      '/ops-group',
    );
  });
});

/*
 * The family's demo-parity fixtures against the frozen contract — the check
 * `shots-fixtures.test.tsx` makes of the default registry, for the bodies a side-by-side
 * photographs. A drifted body draws the page's error card, which compares with nothing.
 */
describe('the infrastructure demo-parity fixtures', () => {
  it.each(DEMO_INFRA.map((fixture) => [`${fixture.method} ${fixture.path}`, fixture] as const))(
    '%s satisfies its response schema',
    (_, fixture) => {
      expect(fixture.schema).not.toBeNull();
      expect(() => fixture.schema?.parse(fixture.body)).not.toThrow();
    },
  );
});

describe('phone cards (demo parity, 390)', () => {
  it('draws the panel list as the kit stacking table', async () => {
    stubApi([{ url: '/panels', body: { panels: [panel()], nextCursor: null } }]);
    const { container } = renderPage(
      <PanelsPage
        route={{ path: '/panels', query: new URLSearchParams() }}
        mayEdit={false}
        denied={false}
      />,
    );
    await screen.findByText('Frankfurt A');
    expect(container.querySelector('.tbl-wrap.stack')).not.toBeNull();
    const labels = [...container.querySelectorAll('td')].map((cell) =>
      cell.getAttribute('data-label'),
    );
    expect(labels).toContain(t('web.panel_capacity'));
  });
});
