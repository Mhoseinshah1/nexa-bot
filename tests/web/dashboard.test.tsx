import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { DashboardPage, healthSlices, providerSlices } from '../../apps/web/src/pages/dashboard';
import { panelSummarySchema } from '@nexa/contracts';
import { formatTimestamp } from '../../apps/web/src/format';
import { event, panel, renderPage, stubApi } from './harness';

/**
 * Fixtures through the SAME schema the server validates against.
 *
 * `healthSlices` takes `PanelSummaryResponse[]`; handing it a cast object
 * means a contract rename cannot fail this file. Parsing means it can.
 */
const fleetOf = (...panels: Record<string, unknown>[]) =>
  panels.map((one) => panelSummarySchema.parse(one));

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
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);

    expect(await screen.findByText('توزیع پنل‌ها')).toBeInTheDocument();
    expect(screen.queryByText('توزیع لوکیشن‌ها')).toBeNull();
  });

  /**
   * F9 — `empty` without `isEmpty` is a prop that can never be read.
   *
   * Both fleet cards passed an `empty` element naming the fleet, and neither
   * passed `isEmpty`, which defaults to false. `StateSwitch` therefore could
   * not reach the empty state at either one, and a zero-panel installation
   * fell through to `Distribution`'s own `total === 0` guard — the GENERIC
   * "موردی برای نمایش نیست.", twice, with the fleet copy nowhere. Dead props
   * do not announce themselves; the card looked fine and said the wrong thing.
   */
  it('names the empty thing when the fleet is empty', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);

    // Both fleet cards, and the copy that names what is missing.
    await waitFor(() => {
      expect(screen.getAllByText('هنوز پنلی ثبت نشده است.')).toHaveLength(2);
    });
    // Not the generic fallback that was appearing instead.
    expect(screen.queryByText('موردی برای نمایش نیست.')).toBeNull();
  });

  it('counts each panel exactly once per breakdown', () => {
    // PARSED, not cast. `as never[]` handed `healthSlices` an unchecked
    // `Record<string, unknown>`: rename `health.state` in the contract and
    // every panel would land under the `undefined` key, the total would still
    // be 3, and this test would still pass. The schema is the point of the
    // fixture.
    const fleet = fleetOf(
      panel({ health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'b', health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'c', health: { ...(panel().health as object), state: 'UNREACHABLE' } }),
    );

    const total = healthSlices(fleet).reduce((sum, slice) => sum + slice.count, 0);
    expect(total).toBe(3);
    expect(providerSlices(fleet).reduce((sum, slice) => sum + slice.count, 0)).toBe(3);
  });

  it('orders a breakdown by share, biggest first', () => {
    const fleet = fleetOf(
      panel({ health: { ...(panel().health as object), state: 'UNREACHABLE' } }),
      panel({ id: 'b', health: { ...(panel().health as object), state: 'HEALTHY' } }),
      panel({ id: 'c', health: { ...(panel().health as object), state: 'HEALTHY' } }),
    );
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
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    const call = api.calls.find((entry) => entry.url.includes('/ops-log'));
    // T28 — the EXACT scope. `toContain('scope=MANAGEMENT')` is also satisfied
    // by `scope=MANAGEMENT`, the wider list that admits one-shot records
    // nothing can ever resolve, so the assertion could not tell the card's
    // whole point from its opposite. Parsed, not substring-matched.
    const scope = new URL(call?.url ?? '', 'https://admin.example.test').searchParams;
    expect(scope.get('scope')).toBe('MANAGEMENT_CONDITIONS');
    expect(scope.get('open')).toBe('true');
  });

  /**
   * The card's timestamp is the column the LIST IS ORDERED BY.
   *
   * It drew `lastSeenAt` while the server ordered by `first_seen_at DESC`, so
   * six rows carried six timestamps in no particular order on the one card
   * whose purpose is triage. Nothing claimed "most recent", so nothing was
   * literally false — the card was simply incoherent with its own ordering,
   * which reads as a bug in the data.
   *
   * The fixture sets the two columns APART on every row and puts them in
   * OPPOSITE orders, because the shared default (`firstSeenAt === lastSeenAt`)
   * is why no existing test could tell the two spellings apart: an assertion
   * over it would pass whichever column the card drew.
   */
  it('dates each condition by when it FIRST appeared, which is the order it is in', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: {
          events: [
            event({
              id: 'newer-first-seen',
              message: 'Newer condition',
              firstSeenAt: '2026-09-06T08:00:00.000Z',
              lastSeenAt: '2026-09-06T09:00:00.000Z',
            }),
            event({
              id: 'older-first-seen',
              message: 'Older condition',
              firstSeenAt: '2026-09-05T08:00:00.000Z',
              // Recurring RIGHT NOW: under the old spelling this row's
              // timestamp sorted above the one drawn for the row above it.
              lastSeenAt: '2026-09-06T23:00:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('Older condition');

    const shown = screen
      .getAllByTitle('نخستین بار')
      .map((node) => node.textContent ?? '')
      .filter((text) => text.length > 0);
    expect(shown, 'both conditions carry a timestamp').toHaveLength(2);
    expect(shown).toEqual([
      formatTimestamp('2026-09-06T08:00:00.000Z'),
      formatTimestamp('2026-09-05T08:00:00.000Z'),
    ]);
    // And NOT the activity column, which is what made the card incoherent.
    for (const lastSeen of ['2026-09-06T09:00:00.000Z', '2026-09-06T23:00:00.000Z']) {
      expect(shown, `${lastSeen} is the activity column`).not.toContain(formatTimestamp(lastSeen));
    }
  });

  /**
   * T01 — a full page is not a truncated fleet.
   *
   * The card asks for `PANEL_PAGE_MAX` panels and warns when the aggregate
   * covers only part of the fleet. Deriving that from `length === limit` made
   * a tenant with EXACTLY 200 panels read a partial-fleet warning over a
   * complete aggregate — the one case where the count is right and the caption
   * says it is not. The server answers the question with `nextCursor`.
   */
  it('claims a partial fleet only when the server left a panel out', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) =>
      panel({ id: `0000000${index}`.slice(-8), name: `panel ${index}` }),
    );

    stubApi([
      READINESS,
      { url: '/panels', body: { panels: fullPage, nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    // Waits for the AGGREGATE, not for the static card title: asserting an
    // absence before the data lands passes for any implementation.
    expect((await screen.findAllByText('سالم')).length).toBeGreaterThan(0);
    // Full, and complete.
    expect(screen.queryByText(/فقط ۲۰۰ پنل نخست/)).toBeNull();
  });

  it('says the aggregate is partial when the server has more panels', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [panel()], nextCursor: 'opaque-cursor-1' } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    // One row on the page and more behind it: a length comparison would have
    // called this complete.
    expect((await screen.findAllByText(/فقط ۲۰۰ پنل نخست/)).length).toBeGreaterThan(0);
  });

  it('shows an open management condition', async () => {
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: { events: [event({ message: 'Roles changed for an owner.' })], nextCursor: null },
      },
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
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    const { container } = renderPage(
      <DashboardPage permissions={['panels.view', 'opslog.view']} />,
    );
    await screen.findByText('توزیع پنل‌ها');

    const text = container.textContent ?? '';
    for (const abbreviation of ['میلیون', 'میلیارد', 'هزار']) {
      expect(text, abbreviation).not.toContain(abbreviation);
    }
    // WP12: money appears on this page only in the owner's business section, from server
    // aggregates. Without the owner role there is no business section at all
    // (`reports.test.tsx` asserts that nothing is even fetched).
    expect(screen.queryByText('گزارش کسب‌وکار')).toBeNull();
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
      { url: '/ops-log', body: { events: [], nextCursor: null } },
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
/**
 * A card header states nothing the card below has withheld.
 *
 * `truncated` fed the by-provider card's HINT, rendered above the
 * `StateSwitch`, so after a refusal the header went on saying "this count
 * covers only the first page; the fleet is larger than one page" over a card
 * saying the fleet could not be read at all. The `shownData` rule, unapplied
 * one component over.
 */
describe('the dashboard fleet header', () => {
  it('says nothing about a fleet it could not read', async () => {
    const route = {
      url: '/panels',
      body: { panels: [panel()], nextCursor: 'more' } as unknown,
      status: 200,
    };
    stubApi([READINESS, { url: '/ops-log', body: { events: [], nextCursor: null } }, route]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await waitFor(() => {
      expect(screen.queryAllByText(/فقط ۲۰۰ پنل نخست/).length).toBeGreaterThan(0);
    });

    route.status = 403;
    route.body = {
      error: {
        kind: 'forbidden',
        code: 'access.permission_denied',
        message: 'no',
        correlationId: 'test',
      },
    };
    await vi.advanceTimersByTimeAsync(95_000);

    await waitFor(() => {
      expect(screen.queryAllByText(/فقط ۲۰۰ پنل نخست/)).toHaveLength(0);
    });
    vi.useRealTimers();
  });
});
