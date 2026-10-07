import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  IncidentBanner,
  IncidentDetailPage,
  IncidentsPage,
  TARGET_PICKER_MAX_PAGES,
  formBody,
  walkPages,
  fromLocalInput,
  toLocalInput,
} from '../../apps/web/src/pages/incidents';
import { pathOf } from '../../apps/web/src/pages/notification-center';
import { NAV, navPermitted } from '../../apps/web/src/nav';
import { renderPage, stubApi } from './harness';

/**
 * Phase E3: the incidents page over the real client and its zod parsing. What is asserted
 * is that each action is drawn only for the key the server charges, that every write
 * sends the version it read and a key that survives a retry, and that the notice sends
 * back exactly the count the preview showed.
 */

const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const PANEL = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: 'MAINTENANCE',
    severity: 'MAJOR',
    status: 'ACTIVE',
    title: 'Frankfurt maintenance',
    description: 'kernel upgrade',
    customerMessage: 'Service in Frankfurt pauses for an hour.',
    targets: [{ kind: 'PANEL', ref: PANEL }],
    stopSales: true,
    adminBanner: true,
    scheduledStartAt: null,
    scheduledEndAt: '2026-10-03T12:00:00.000Z',
    startedAt: '2026-10-03T10:00:00.000Z',
    resolvedAt: null,
    version: 3,
    createdAt: '2026-10-03T09:00:00.000Z',
    effects: [
      {
        kind: 'PANEL_DRAIN',
        targetKind: 'PANEL',
        targetRef: PANEL,
        subjectRef: PANEL,
        state: 'APPLIED',
        errorCode: null,
        updatedAt: '2026-10-03T10:00:01.000Z',
      },
    ],
    ...overrides,
  };
}

const detail = (overrides: Record<string, unknown> = {}) => ({
  url: `/incidents/${ID}`,
  body: {
    incident: incident(overrides),
    timeline: [
      {
        id: 'e1',
        kind: 'STARTED',
        actorLabel: 'owner',
        detail: null,
        occurredAt: '2026-10-03T10:00:00.000Z',
      },
    ],
  },
});

describe('the incidents list', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('draws the server rows and offers creation only to incidents.manage', async () => {
    stubApi([{ url: '/incidents', body: { incidents: [incident()], nextCursor: null } }]);
    const view = renderPage(<IncidentsPage denied={false} mayManage={false} />);
    expect(await screen.findByText('Frankfurt maintenance')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.inc_new') })).toBeNull();
    view.unmount();

    stubApi([{ url: '/incidents', body: { incidents: [incident()], nextCursor: null } }]);
    renderPage(<IncidentsPage denied={false} mayManage />);
    expect(await screen.findByRole('button', { name: t('web.inc_new') })).toBeInTheDocument();
  });

  it('asks nothing when denied', () => {
    const api = stubApi([]);
    renderPage(<IncidentsPage denied mayManage />);
    expect(api.calls).toHaveLength(0);
  });
});

describe('the incident detail', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('draws no action without manage or notify', async () => {
    stubApi([detail()]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage={false} mayNotify={false} />);
    expect(await screen.findByText(t('web.inc_effect_panel_drain'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.inc_resolve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.inc_notice') })).toBeNull();
  });

  it('draws the notice for incidents.notify, and still no action without manage', async () => {
    stubApi([detail()]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage={false} mayNotify />);
    expect(await screen.findByRole('button', { name: t('web.inc_notice') })).toBeInTheDocument();
    for (const label of ['web.inc_edit', 'web.inc_resolve', 'web.inc_apply_effects'] as const) {
      expect(screen.queryByRole('button', { name: t(label) })).toBeNull();
    }
  });

  it('resolves with the version it read, and keeps the key across a lost answer', async () => {
    const api = stubApi([
      detail(),
      {
        url: `/incidents/${ID}/resolve`,
        status: 503,
        body: { error: { kind: 'unavailable', code: 'x', message: 'x', correlationId: 'c' } },
      },
    ]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage mayNotify={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.inc_resolve') }));
    const confirm = () =>
      screen
        .getAllByRole('button', { name: t('web.inc_resolve') })
        .find((button) => button.closest('[role="dialog"]') !== null) as HTMLElement;
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/resolve'))).toHaveLength(1),
    );
    await waitFor(() => expect(confirm()).not.toBeDisabled());
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/resolve'))).toHaveLength(2),
    );
    const [first, second] = api.calls.filter((c) => c.url.endsWith('/resolve'));
    expect(first?.method).toBe('POST');
    expect((first?.body as { expectedVersion: number }).expectedVersion).toBe(3);
    expect((second?.body as { idempotencyKey: string }).idempotencyKey).toBe(
      (first?.body as { idempotencyKey: string }).idempotencyKey,
    );
  });

  /**
   * Roadmap B3: a 409 means the incident moved on. The modal used to keep the version it read,
   * so every further press was refused the same way until the operator left the page. Now the
   * conflict re-reads the incident and the next press carries the fresh version and a new key.
   */
  it('re-reads the incident on a version conflict, and acts on the fresh version next', async () => {
    const page = detail();
    const api = stubApi([
      page,
      {
        url: `/incidents/${ID}/resolve`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'incident.version_conflict',
            message: 'x',
            correlationId: 'c',
          },
        },
      },
    ]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage mayNotify={false} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.inc_resolve') }));
    const confirm = () =>
      screen
        .getAllByRole('button', { name: t('web.inc_resolve') })
        .find((button) => button.closest('[role="dialog"]') !== null) as HTMLElement;
    const reads = () =>
      api.calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/incidents/${ID}`));
    expect(reads()).toHaveLength(1);
    // Somebody else moved it to version 4 meanwhile.
    (page.body.incident as { version: number }).version = 4;
    fireEvent.click(confirm());
    expect(await screen.findByText(t('web.inc_error_version'))).toBeInTheDocument();
    await waitFor(() => expect(reads().length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(confirm()).not.toBeDisabled());
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url.endsWith('/resolve'))).toHaveLength(2),
    );
    const [first, second] = api.calls.filter((c) => c.url.endsWith('/resolve'));
    expect((first?.body as { expectedVersion: number }).expectedVersion).toBe(3);
    expect((second?.body as { expectedVersion: number }).expectedVersion).toBe(4);
    expect((second?.body as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (first?.body as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('sends the notice with exactly the previewed count', async () => {
    const api = stubApi([
      detail(),
      { url: `/incidents/${ID}/notice/preview`, body: { recipients: 7, version: 3 } },
      { url: `/incidents/${ID}/notice`, body: { incident: incident(), queued: 7 } },
    ]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage={false} mayNotify />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.inc_notice') }));
    expect(await screen.findByText('7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.inc_notice_confirm') }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/notice'))).toBe(true),
    );
    const sent = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/notice'));
    expect(sent?.body).toMatchObject({ expectedRecipients: 7, expectedVersion: 3 });
  });

  it('offers no notice when there is no customer message', async () => {
    stubApi([detail({ customerMessage: null })]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage mayNotify />);
    expect(await screen.findByText(t('web.inc_no_customer_message'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.inc_notice') })).toBeNull();
  });

  it('offers no action on a resolved incident', async () => {
    stubApi([detail({ status: 'RESOLVED', resolvedAt: '2026-10-03T11:00:00.000Z' })]);
    renderPage(<IncidentDetailPage id={ID} denied={false} mayManage mayNotify />);
    expect(await screen.findByText(t('web.inc_status_resolved'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.inc_edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.inc_notice') })).toBeNull();
  });
});

describe('the admin banner', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('draws each active incident with a link, and nothing when there is none', async () => {
    stubApi([
      {
        url: '/incidents/banner',
        body: {
          incidents: [
            {
              id: ID,
              kind: 'INCIDENT',
              severity: 'CRITICAL',
              title: 'Gateway outage',
              startedAt: '2026-10-03T10:00:00.000Z',
              scheduledEndAt: null,
            },
          ],
        },
      },
    ]);
    const view = renderPage(<IncidentBanner mayView />);
    const link = await screen.findByRole('link', { name: t('web.inc_banner_open') });
    expect(link.getAttribute('href')).toBe(`/incidents/${ID}`);
    expect(screen.getByText(/Gateway outage/u)).toBeInTheDocument();
    view.unmount();

    stubApi([{ url: '/incidents/banner', body: { incidents: [] } }]);
    const empty = renderPage(<IncidentBanner mayView />);
    await waitFor(() => expect(empty.container.querySelector('.incident-banners')).toBeNull());
  });

  it('draws no link for an administrator without incidents.view, who still sees the banner', async () => {
    stubApi([
      {
        url: '/incidents/banner',
        body: {
          incidents: [
            {
              id: ID,
              kind: 'INCIDENT',
              severity: 'MINOR',
              title: 'Gateway outage',
              startedAt: '2026-10-03T10:00:00.000Z',
              scheduledEndAt: null,
            },
          ],
        },
      },
    ]);
    renderPage(<IncidentBanner mayView={false} />);
    expect(await screen.findByText(/Gateway outage/u)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: t('web.inc_banner_open') })).toBeNull();
  });
});

describe('the list pages', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('asks for the next page by the cursor the server gave', async () => {
    const api = stubApi([
      { url: '/incidents', body: { incidents: [incident()], nextCursor: 'c-1' } },
      {
        url: '/incidents?cursor=c-1',
        body: { incidents: [incident({ id: PANEL, title: 'Older one' })], nextCursor: null },
      },
    ]);
    renderPage(<IncidentsPage denied={false} mayManage={false} />);
    await screen.findByText('Frankfurt maintenance');
    fireEvent.click(screen.getByRole('button', { name: t('web.older') }));
    expect(await screen.findByText('Older one')).toBeInTheDocument();
    expect(api.calls.some((c) => c.url.endsWith('/incidents?cursor=c-1'))).toBe(true);
  });
});

describe('the target picker', () => {
  it('walks every page, not the first', async () => {
    const seen: (string | null)[] = [];
    const all = await walkPages(async (cursor) => {
      seen.push(cursor);
      return cursor === null
        ? { items: [{ ref: 'a', label: 'A' }], nextCursor: 'p2' }
        : { items: [{ ref: 'b', label: 'B' }], nextCursor: null };
    });
    expect(all.map((o) => o.ref)).toEqual(['a', 'b']);
    expect(seen).toEqual([null, 'p2']);
  });

  it('stops after a bounded number of pages', async () => {
    let calls = 0;
    await walkPages(async () => {
      calls += 1;
      return { items: [], nextCursor: 'again' };
    });
    expect(calls).toBe(TARGET_PICKER_MAX_PAGES);
  });
});

describe('the wiring', () => {
  it('links the notification center to the incident', () => {
    expect(pathOf({ target: 'INCIDENT', id: ID })).toBe(`/incidents/${ID}`);
    expect(pathOf({ target: 'INCIDENTS', id: null })).toBe('/incidents');
    expect(pathOf({ target: 'COMPENSATIONS', id: null })).toBe('/compensations');
  });

  it('draws the nav entry for incidents.view alone', () => {
    const entry = NAV.find((candidate) => candidate.path === '/incidents');
    expect(entry).toBeDefined();
    expect(navPermitted(entry!, ['incidents.view'])).toBe(true);
    expect(navPermitted(entry!, ['opslog.view'])).toBe(false);
  });

  it('sends an empty customer message as null and an ACTIVE start as null', () => {
    const body = formBody(
      {
        kind: 'INCIDENT',
        severity: 'MINOR',
        title: '  t  ',
        description: '',
        customerMessage: '   ',
        targets: [],
        stopSales: false,
        adminBanner: true,
        scheduledStartAt: '2030-01-01T10:00',
        scheduledEndAt: '',
      },
      false,
    );
    expect(body).toMatchObject({
      title: 't',
      customerMessage: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
    });
  });

  it('round-trips a local schedule', () => {
    const iso = '2030-01-01T10:15:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
  });
});
