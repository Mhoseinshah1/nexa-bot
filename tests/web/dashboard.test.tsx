import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DashboardPage, healthSlices, providerSlices } from '../../apps/web/src/pages/dashboard';
import { event, panel, renderPage, stubApi } from './harness';

const READINESS = {
  url: '/system/readiness',
  body: {
    status: 'ok',
    dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }],
  },
};

describe('the dashboard', () => {
  /**
   * Owner revision 2 — the breakdown is by PANEL, not by location.
   *
   * A panel can serve several locations, so a location breakdown counts one
   * panel more than once and the shares stop summing to the fleet. There is
   * also no location field anywhere in the panel contract, so a location
   * breakdown could only have come from inventing one.
   */
  it('aggregates by panel, and says so', async () => {
    stubApi([
      READINESS,
      {
        url: '/panels',
        body: { panels: [panel(), panel({ id: 'b', name: 'B' })], nextCursor: null },
      },
      { url: '/ops-log', body: { events: [] } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);

    expect(await screen.findByText('توزیع پنل‌ها')).toBeInTheDocument();
    expect(screen.queryByText('توزیع لوکیشن‌ها')).toBeNull();
  });

  it('counts each panel exactly once per breakdown', () => {
    const fleet = [
      panel({ health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'b', health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'c', health: { ...(panel().health as object), state: 'UNREACHABLE' } }),
    ] as never[];

    const total = healthSlices(fleet).reduce((sum, slice) => sum + slice.count, 0);
    expect(total).toBe(3);
    expect(providerSlices(fleet).reduce((sum, slice) => sum + slice.count, 0)).toBe(3);
  });

  it('orders a breakdown by share, biggest first', () => {
    const fleet = [
      panel({ health: { ...(panel().health as object), state: 'UNREACHABLE' } }),
      panel({ id: 'b', health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'c', health: { ...(panel().health as object), state: 'HEALTHY' } }),
    ] as never[];
    expect(healthSlices(fleet)[0]?.count).toBe(2);
  });

  /**
   * Owner revision 3 — "needs attention" means an operator has to do something.
   *
   * The rule is kept by never building the count out of "everything not
   * finished": it asks the server for management-scope conditions that are
   * still OPEN, so a resolved condition is history and a routine event was
   * never attention in the first place.
   */
  it('asks only for open management conditions', async () => {
    const api = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [] } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    const call = api.calls.find((entry) => entry.url.includes('/ops-log'));
    expect(call?.url).toContain('scope=MANAGEMENT');
    expect(call?.url).toContain('open=true');
  });

  it('shows an open management condition', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [event({ message: 'Roles changed for an owner.' })] } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    expect(await screen.findByText('Roles changed for an owner.')).toBeInTheDocument();
  });

  /**
   * Owner revision 1, at the place it was broken.
   *
   * The preview's dashboard called `tomanShort()` for every monetary KPI. There
   * is no money on this page at all now — there are no orders, payments or
   * customers to total — and the assertion is that no abbreviation reaches the
   * screen by any route.
   */
  it('renders no abbreviated money, because it renders no invented money', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/ops-log', body: { events: [] } },
    ]);
    const { container } = renderPage(
      <DashboardPage permissions={['panels.view', 'opslog.view']} />,
    );
    await screen.findByText('توزیع پنل‌ها');

    const text = container.textContent ?? '';
    for (const abbreviation of ['میلیون', 'میلیارد', 'هزار']) {
      expect(text, abbreviation).not.toContain(abbreviation);
    }
    // And it says why there is no revenue tile, rather than leaving a gap.
    expect(screen.getByText(/سفارش، پرداخت و مشتری/)).toBeInTheDocument();
  });

  /**
   * `latencyMs` is OPTIONAL on the wire, not nullable: a dependency that
   * reports no timing simply omits the field. A guard written against `null`
   * let `undefined` through, and the page rendered the literal text
   * "undefined ms" beside a healthy dependency.
   */
  it('omits the timing for a dependency that reported none', async () => {
    stubApi([
      {
        url: '/system/readiness',
        body: {
          status: 'ok',
          dependencies: [
            { name: 'migrations', status: 'up', detail: '27 applied' },
            { name: 'postgres', status: 'up', latencyMs: 3 },
          ],
        },
      },
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [] } },
    ]);
    const { container } = renderPage(<DashboardPage permissions={['opslog.view']} />);
    await screen.findByText('migrations');

    const text = container.textContent ?? '';
    // Asserted as "exactly one timing is rendered" rather than as "the word
    // `undefined` is absent". The weaker form let a reverted guard survive:
    // formatting the missing value produced `NaN ms` instead, which is a
    // different wrong string and an equally wrong screen.
    expect(text.match(/ ms/g) ?? []).toHaveLength(1);
    expect(text).not.toMatch(/(undefined|NaN|null)/);
    // The one that DID report a timing still shows it.
    expect(screen.getByText('3 ms')).toBeInTheDocument();
  });

  it('draws nothing it lacks the permission to read', async () => {
    stubApi([READINESS]);
    renderPage(<DashboardPage permissions={[]} />);
    await screen.findByText('وضعیت سامانه');
    expect(screen.queryByText('توزیع پنل‌ها')).toBeNull();
    expect(screen.queryByText('نیازمند توجه')).toBeNull();
  });
});
