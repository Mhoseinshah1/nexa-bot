import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import { NotificationsPage } from '../../apps/web/src/pages/alerts';
import { event, panel, renderPage, stubApi } from './harness';

/**
 * Two defect classes the fifth review found, kept together because they are the
 * same mistake seen from opposite sides: a screen that shows less than the
 * server allows, and a screen that shows less than the server currently knows.
 */

const READINESS = {
  url: '/system/readiness',
  body: { status: 'ok', dependencies: [{ name: 'postgres', status: 'up', latencyMs: 3 }] },
};

const routeFor = (path: string, permissions: readonly string[]): ReactElement =>
  resolve({ path, query: new URLSearchParams() }, permissions).element as ReactElement;

/**
 * `/notifications` carries TWO server capabilities and they are held
 * separately: the delivery history behind `opslog.view`, and the test send
 * behind `settings.edit`, which `POST /notifications/test` authorizes on its
 * own. The nav gated the page on the history permission alone, so an actor
 * holding only the second had no route to a page that would have served them.
 *
 * Driven through the real `NAV` and the real `resolve`, and through the rendered
 * page — not by reading the permission out of the source, which is what made
 * the defect invisible in the first place.
 */
describe('the notification permission combinations', () => {
  const entry = NAV.find((candidate) => candidate.id === 'notifications');
  const HISTORY = { url: '/notifications', body: { notifications: [], nextCursor: null } };
  const TEST_SEND = 'ارسال پیام آزمایشی';
  const DENIED = 'شما به این بخش دسترسی ندارید.';

  const open = (permissions: readonly string[]) => {
    stubApi([HISTORY]);
    return renderPage(routeFor('/notifications', permissions));
  };

  it('offers the page to an actor who may only send a test', async () => {
    expect(entry, 'the notifications nav entry').toBeDefined();
    expect(navPermitted(entry!, ['settings.edit'])).toBe(true);

    open(['settings.edit']);
    // The capability they hold is offered...
    expect(await screen.findByRole('button', { name: TEST_SEND })).toBeInTheDocument();
    // ...and the one they do not is refused rather than blank.
    expect(await screen.findByText(DENIED)).toBeInTheDocument();
  });

  it('offers the page to an actor who may only read the history', async () => {
    expect(navPermitted(entry!, ['opslog.view'])).toBe(true);

    open(['opslog.view']);
    await waitFor(() => {
      expect(screen.queryByText(DENIED)).toBeNull();
    });
    expect(screen.queryByRole('button', { name: TEST_SEND })).toBeNull();
  });

  it('offers both to an actor who holds both', async () => {
    expect(navPermitted(entry!, ['opslog.view', 'settings.edit'])).toBe(true);

    open(['opslog.view', 'settings.edit']);
    expect(await screen.findByRole('button', { name: TEST_SEND })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(DENIED)).toBeNull();
    });
  });

  it('offers nothing usable to an actor who holds neither', async () => {
    // The nav hides it, which is correct: there is no capability behind it.
    expect(navPermitted(entry!, ['panels.view'])).toBe(false);

    open(['panels.view']);
    expect(await screen.findByText(DENIED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEST_SEND })).toBeNull();
  });

  /**
   * The rule itself, at the seam. An entry naming several permissions is
   * satisfied by ANY of them — the opposite reading would hide a page from
   * everyone who does not hold all of them, which is the same defect again.
   */
  it('treats a list of permissions as any, not all', () => {
    const both = { ...entry!, permission: ['a', 'b'] as const };
    expect(navPermitted(both, ['a'])).toBe(true);
    expect(navPermitted(both, ['b'])).toBe(true);
    expect(navPermitted(both, ['c'])).toBe(false);
    // A single string still means exactly that one.
    expect(navPermitted({ ...entry!, permission: 'a' }, ['a'])).toBe(true);
    expect(navPermitted({ ...entry!, permission: 'a' }, ['b'])).toBe(false);
    // Null still means everybody.
    expect(navPermitted({ ...entry!, permission: null }, [])).toBe(true);
  });
});

/**
 * A page that never asks again is a photograph.
 *
 * Panel health and the open management conditions are both written by the
 * BACKGROUND monitor, so nothing the operator does on these pages causes them
 * to change. With no interval, no refresh control and `refetchOnWindowFocus`
 * off globally, an open page kept one moment's answer indefinitely.
 *
 * Asserted by counting the requests the real query client actually issued —
 * a source check for `refetchInterval` would pass against a value of zero, a
 * disabled query, or a key that never changes.
 */
describe('pages that must not go stale', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const countOf = (calls: readonly { url: string }[], fragment: string) =>
    calls.filter((call) => call.url.includes(fragment)).length;

  it('re-reads the open management conditions while the dashboard stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    const before = countOf(api.calls, '/ops-log');
    expect(before).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(api.calls, '/ops-log')).toBeGreaterThan(before);
    });
  });

  it('shows a condition that opened after the page was drawn, without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    // The incident starts while the operator is looking at the card.
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: {
          events: [
            event({ code: 'settings.stored_value_invalid', message: 'A setting stopped parsing.' }),
          ],
          nextCursor: null,
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(16_000);
    expect(await screen.findByText('A setting stopped parsing.')).toBeInTheDocument();
  });

  it('stops showing a condition once it has recovered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: {
          events: [
            event({ code: 'settings.stored_value_invalid', message: 'A setting stopped parsing.' }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('A setting stopped parsing.');

    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(await screen.findByText('چیزی برای رسیدگی نیست.')).toBeInTheDocument();
    expect(screen.queryByText('A setting stopped parsing.')).toBeNull();
  });

  it('re-reads the fleet on its own cadence, which is slower than the conditions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [panel()], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('توزیع پنل‌ها');

    const fleetBefore = countOf(api.calls, '/panels');
    // Past the conditions cadence but not the fleet's: the two are deliberately
    // different, and asserting them together would hide one of them.
    await vi.advanceTimersByTimeAsync(20_000);
    await waitFor(() => {
      expect(countOf(api.calls, '/ops-log')).toBeGreaterThan(1);
    });
    expect(countOf(api.calls, '/panels')).toBe(fleetBefore);

    await vi.advanceTimersByTimeAsync(45_000);
    await waitFor(() => {
      expect(countOf(api.calls, '/panels')).toBeGreaterThan(fleetBefore);
    });
  });
});

/**
 * The panel detail is the other page the monitor writes underneath.
 */
describe('the panel detail while it stays open', () => {
  const A = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
  const B = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';

  afterEach(() => {
    vi.useRealTimers();
  });

  const countOf = (calls: readonly { url: string }[], fragment: string) =>
    calls.filter((call) => call.url.includes(fragment)).length;

  it('re-reads its own row so a new health result appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([
      { url: `/panels/${A}`, body: { panel: panel({ id: A, name: 'Frankfurt A' }) } },
      { url: '/providers', body: { providers: [] } },
    ]);
    renderPage(routeFor(`/panels/${A}`, ['panels.view', 'panels.edit']));
    await screen.findByText('Frankfurt A');

    const before = countOf(api.calls, `/panels/${A}`);
    expect(before).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(95_000);
    await waitFor(() => {
      expect(countOf(api.calls, `/panels/${A}`)).toBeGreaterThan(before);
    });
  });

  /**
   * And the poll follows the route.
   *
   * Stated precisely, because a mutation showed the obvious explanation is the
   * wrong one: removing the route key does NOT break this. What stops the old
   * panel being polled is React Query's observer model — the key
   * `['panel', id]` changes, the previous query loses its last observer and
   * stops its interval — not the remount.
   *
   * So this test is evidence for "the detail polls, and it polls the panel on
   * screen", and it dies when the interval is removed. It is NOT evidence for
   * the key; the two draft tests in `router.test.tsx` are. Saying so here is
   * the point: a polling interval added beside a keyed subtree invites exactly
   * the assumption that one protects the other.
   */
  it('stops polling the panel the operator navigated away from', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi([
      { url: `/panels/${A}`, body: { panel: panel({ id: A, name: 'Frankfurt A' }) } },
      { url: `/panels/${B}`, body: { panel: panel({ id: B, name: 'Helsinki B' }) } },
      { url: '/providers', body: { providers: [] } },
    ]);
    const view = renderPage(routeFor(`/panels/${A}`, ['panels.view', 'panels.edit']));
    await screen.findByText('Frankfurt A');

    view.rerender(routeFor(`/panels/${B}`, ['panels.view', 'panels.edit']));
    await screen.findByText('Helsinki B');

    const aAfterMove = countOf(api.calls, `/panels/${A}`);
    const bAfterMove = countOf(api.calls, `/panels/${B}`);

    await vi.advanceTimersByTimeAsync(95_000);
    await waitFor(() => {
      expect(countOf(api.calls, `/panels/${B}`)).toBeGreaterThan(bAfterMove);
    });
    // The panel they left is not still being polled.
    expect(countOf(api.calls, `/panels/${A}`)).toBe(aAfterMove);
  });
});

/**
 * `panels.edit` and `panels.view` are separate, and the create form is open to
 * the first alone. Sending such an actor to `/panels/:id` on success took them
 * from a working form to a page they cannot open, with no way back — the create
 * route is not in the nav either.
 */
describe('creating a panel without permission to view one', () => {
  const CREATED = { id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8', name: 'Frankfurt A' };

  const fillAndSubmit = async () => {
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'Frankfurt A' } });
    fireEvent.change(screen.getByLabelText('ارائه‌دهنده'), { target: { value: 'marzban' } });
    fireEvent.change(screen.getByLabelText('نشانی پایه'), {
      target: { value: 'https://panel.example/api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
  };

  const stub = () =>
    stubApi([
      {
        url: '/providers',
        body: {
          providers: [
            {
              key: 'marzban',
              canonicalName: 'Marzban',
              credentialShape: 'USERNAME_PASSWORD',
              capabilities: ['HEALTH_CHECK'],
              requiredActivationFields: [],
            },
          ],
        },
      },
      { url: '/panels', body: { panel: panel(CREATED) } },
    ]);

  it('keeps an edit-only creator on the form and names what was created', async () => {
    stub();
    renderPage(routeFor('/panels/new', ['panels.edit']));
    await screen.findByLabelText('ارائه‌دهنده');
    await fillAndSubmit();

    // The confirmation is HERE, and it identifies the panel by name.
    expect(await screen.findByText('پنل ساخته شد')).toBeInTheDocument();
    expect(screen.getByText('Frankfurt A')).toBeInTheDocument();
    // Still on a page they can use, not on a denied detail route.
    expect(screen.getByLabelText('نام')).toBeInTheDocument();
    expect(screen.queryByText('شما به این بخش دسترسی ندارید.')).toBeNull();
  });

  it('still opens the detail page for a creator who may view panels', async () => {
    const api = stub();
    renderPage(routeFor('/panels/new', ['panels.edit', 'panels.view']));
    await screen.findByLabelText('ارائه‌دهنده');
    await fillAndSubmit();

    // It navigated, so it did NOT stop to show the stay-here confirmation.
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('پنل ساخته شد')).toBeNull();
    });
  });

  it('still denies the detail route itself to an actor without panels.view', async () => {
    stubApi([{ url: `/panels/${CREATED.id}`, body: { panel: panel(CREATED) } }]);
    renderPage(routeFor(`/panels/${CREATED.id}`, ['panels.edit']));
    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
  });
});

/**
 * Second-order defects the fresh-context review found in the seven fixes.
 */
describe('the archive filter and the cursor that belongs to it', () => {
  const routeWith = (query: string) => ({
    path: '/panels',
    query: new URLSearchParams(query),
  });

  const page = (rows: number, next: string | null) => ({
    url: '/panels',
    body: {
      panels: Array.from({ length: rows }, (_, index) =>
        panel({ id: `0000000${index}`.slice(-8), name: `row ${index}` }),
      ),
      nextCursor: next,
    },
  });

  /**
   * The mode lives in the URL, so it can change WITHOUT the toolbar: the
   * sidebar's own «پنل‌ها» link navigates to `/panels`, dropping the query
   * while React keeps this component — and its cursor trail — mounted.
   * Clearing the trail only in the filter's `onChange` covered one of the two
   * ways the mode moves, and a cursor minted by one list applied to the other
   * silently strands every row before it.
   */
  it('does not carry a cursor from one list into the other', async () => {
    const api = stubApi([page(2, 'archived-cursor-1')]);
    const view = renderPage(
      resolve(routeWith('archived=only'), ['panels.view']).element as ReactElement,
    );
    await screen.findByText('row 0');

    // Page forward inside the ARCHIVE, so a trail exists.
    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('cursor=archived-cursor-1'))).toBe(true);
    });

    // Now the mode changes by ROUTE, not by the toolbar — the sidebar link.
    const before = api.calls.length;
    view.rerender(resolve(routeWith(''), ['panels.view']).element as ReactElement);
    await waitFor(() => {
      expect(api.calls.length).toBeGreaterThan(before);
    });

    // The live list is asked for its FIRST page. A carried cursor would have
    // walked past every live panel older than that archived row.
    const latest = api.calls.at(-1);
    expect(latest?.url).not.toContain('cursor=');
    expect(latest?.url).not.toContain('archived=only');
  });

  it('offers no previous page after the mode changed underneath it', async () => {
    const api = stubApi([page(2, 'archived-cursor-1')]);
    const view = renderPage(
      resolve(routeWith('archived=only'), ['panels.view']).element as ReactElement,
    );
    await screen.findByText('row 0');
    fireEvent.click(screen.getByRole('button', { name: 'قدیمی‌تر' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('cursor='))).toBe(true);
    });

    view.rerender(resolve(routeWith(''), ['panels.view']).element as ReactElement);
    await screen.findByText('row 0');
    // "Newer" would take them back to a position in a list they are no longer
    // looking at. `CursorPager` always renders both buttons and disables them,
    // so the assertion is on the disabled state, not on absence.
    expect(screen.getByRole('button', { name: 'تازه‌تر' })).toBeDisabled();
  });
});

/**
 * `/panels` serves the fleet list and the route to the create form, and the
 * server authorizes them separately — the same shape as `/notifications`.
 */
describe('the panels nav entry', () => {
  const entry = NAV.find((candidate) => candidate.id === 'panels');

  it('is offered to an actor who may create but not list', () => {
    expect(entry).toBeDefined();
    expect(navPermitted(entry!, ['panels.edit'])).toBe(true);
    expect(navPermitted(entry!, ['panels.view'])).toBe(true);
    expect(navPermitted(entry!, ['settings.edit'])).toBe(false);
  });
});

/**
 * The other side of the polling that the four tests above exist to protect.
 *
 * `enabled:` is computed from the session's permission list, which is read ONCE
 * per tab. A tab whose permissions were revoked after it loaded therefore goes
 * on believing it holds them, and every refused request writes an
 * `access.permission_denied` operational event — a code with no `dedupeKey`,
 * into a table with no retention sweeper. Before these intervals existed the
 * growth was bounded by how often somebody navigated; a wall display left on a
 * revoked session would now write thousands of rows a day into the very feed
 * the alerts page exists to keep readable.
 *
 * So: one refusal, then silence.
 */
describe('polling that has started being refused, and polling that has merely stumbled', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const countOf = (calls: readonly { url: string }[], fragment: string) =>
    calls.filter((call) => call.url.includes(fragment)).length;

  const FORBIDDEN = {
    status: 403,
    body: {
      error: {
        kind: 'forbidden',
        code: 'access.denied',
        message: 'no',
        correlationId: 'test',
      },
    },
  };

  const BROKEN = {
    status: 502,
    body: {
      error: {
        kind: 'internal',
        code: 'gateway.bad',
        message: 'no',
        correlationId: 'test',
      },
    },
  };

  it('stops re-reading the conditions once the server starts refusing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    // The permission is taken away while the page stays open. A fresh stub, so
    // the counts below are of requests made AFTER the revocation only.
    const revoked = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', ...FORBIDDEN },
    ]);

    // The next tick asks once — that request is what discovers the refusal.
    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(revoked.calls, '/ops-log')).toBeGreaterThan(0);
    });
    const refusals = countOf(revoked.calls, '/ops-log');

    // Everything after it is silence, across four further cadences.
    await vi.advanceTimersByTimeAsync(64_000);
    expect(countOf(revoked.calls, '/ops-log')).toBe(refusals);
    // ...and the page is still polling something, so a stopped INTERVAL is not
    // being mistaken for a stopped test.
    expect(countOf(revoked.calls, '/system/readiness')).toBeGreaterThan(1);
  });

  it('stops the pending-delivery poll once the server starts refusing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292ca',
      kind: 'OPERATIONAL_EVENT',
      status: 'PENDING',
      templateKey: 'ops.alert',
      attemptCount: 0,
      maxAttempts: 5,
      createdAt: '2026-09-06T08:00:00.000Z',
      lastAttemptAt: null,
      completedAt: null,
      correlationId: 'c1',
    };
    stubApi([{ url: '/notifications', body: { notifications: [pending], nextCursor: null } }]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('ops.alert');

    const revoked = stubApi([{ url: '/notifications', ...FORBIDDEN }]);

    // The list still HOLDS a pending row — React Query retains the last good
    // data across a failed refetch — so an interval that only consulted its own
    // condition would go on asking for ever.
    await vi.advanceTimersByTimeAsync(4_000);
    await waitFor(() => {
      expect(countOf(revoked.calls, '/notifications')).toBeGreaterThan(0);
    });
    const refusals = countOf(revoked.calls, '/notifications');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(countOf(revoked.calls, '/notifications')).toBe(refusals);
  });

  /**
   * The inverse, and the test whose absence let the first version of this rule
   * ship inverted.
   *
   * That version stopped on ANY error. A dashboard on a wall — the scenario the
   * intervals exist for, where nobody is present to press Retry — met one 502
   * from the edge during a rolling restart and froze into an error box for
   * good: `refetchOnWindowFocus` is off, and React Query clears `state.error`
   * only on a SUCCESSFUL fetch, which is the fetch the stopped timer no longer
   * makes. A gate that only ever asked "does a refusal stop it?" was green
   * throughout.
   */
  /**
   * The rule is "a 4xx is an ANSWER", not "a 403 is an answer".
   *
   * A 404 is the case that made the difference visible: a panel deleted or a
   * route retired under an open tab answers 404 for ever, and asking again
   * unchanged cannot make it exist. This test was missing when the widening
   * shipped — the mutation that narrowed the rule back to 401/403 killed
   * nothing, which is how the gap was found.
   */
  it('stops polling a route the server says is not there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    const gone = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        status: 404,
        body: {
          error: { kind: 'not_found', code: 'gone', message: 'no', correlationId: 'test' },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(gone.calls, '/ops-log')).toBeGreaterThan(0);
    });
    const asked = countOf(gone.calls, '/ops-log');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(countOf(gone.calls, '/ops-log')).toBe(asked);
    expect(countOf(gone.calls, '/system/readiness')).toBeGreaterThan(1);
  });

  /**
   * Contract skew, which the second version of this rule polled for ever.
   *
   * `authedGet` throws in two places: `toApiError` for `!response.ok`, and
   * `schema.parse` on the SUCCESS path. The second is a `ZodError`, carries no
   * status, and is what a tab holding the previous release hits on every tick
   * after a deploy. Asking again cannot help — the bundle is the thing that is
   * old — so this is an answer, not a stumble.
   */
  it('stops polling a response this bundle cannot parse', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    // A 200 whose shape the frozen schema rejects.
    const skewed = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: { events: [{ nothing: 'the server it expects' }], nextCursor: null },
      },
    ]);

    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(skewed.calls, '/ops-log')).toBeGreaterThan(0);
    });
    const parsed = countOf(skewed.calls, '/ops-log');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(countOf(skewed.calls, '/ops-log')).toBe(parsed);
    expect(countOf(skewed.calls, '/system/readiness')).toBeGreaterThan(1);
  });

  /**
   * A failure that waiting CAN cure drops into a slow lane instead of holding
   * its declared cadence for as long as the tab is open.
   *
   * Measured on the alerts list, because that is where the hazard actually
   * lives: it polls every THREE seconds while a delivery is pending, and React
   * Query retains the last successful data across a failed refetch, so its own
   * "only while pending" condition stays satisfied for the whole outage. At
   * three seconds a twenty-minute outage is about four hundred POLLS per open
   * tab — some eight hundred requests, since `retry: 1` doubles each — against a
   * server that is already failing.
   */
  it('drops a failing endpoint into a slow lane instead of its declared cadence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292ca',
      kind: 'OPERATIONAL_EVENT',
      status: 'PENDING',
      templateKey: 'ops.alert',
      attemptCount: 0,
      maxAttempts: 5,
      createdAt: '2026-09-06T08:00:00.000Z',
      lastAttemptAt: null,
      completedAt: null,
      correlationId: 'c1',
    };
    stubApi([{ url: '/notifications', body: { notifications: [pending], nextCursor: null } }]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    await screen.findByText('ops.alert');

    const broken = stubApi([{ url: '/notifications', ...BROKEN }]);

    // Ninety seconds. At the declared three-second cadence that is thirty
    // attempts; in the slow lane it is a handful. More than one, because giving
    // up entirely is the frozen-screen defect this must not become.
    await vi.advanceTimersByTimeAsync(90_000);
    // Bounds chosen to pin the DECLARED 30s lane, not merely "slower than 3s":
    // 30s gives three attempts in ninety seconds, a 13s lane gives seven, and
    // giving up entirely gives one. An upper bound of eight would have passed a
    // silent regression to a 13s lane — twice the request volume the docblock
    // promises — so it is four.
    const attempts = countOf(broken.calls, '/notifications');
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it('keeps polling through a transient failure, and recovers on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    // The edge starts answering 502 for the conditions feed.
    const broken = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', ...BROKEN },
    ]);
    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(broken.calls, '/ops-log')).toBeGreaterThan(0);
    });
    const first = countOf(broken.calls, '/ops-log');

    // It must NOT have given up: a 502 is a state waiting resolves.
    await vi.advanceTimersByTimeAsync(48_000);
    await waitFor(() => {
      expect(countOf(broken.calls, '/ops-log')).toBeGreaterThan(first);
    });

    // The deployment finishes, and the page heals with nobody present.
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        body: {
          events: [
            event({ code: 'settings.stored_value_invalid', message: 'A setting stopped parsing.' }),
          ],
          nextCursor: null,
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await screen.findByText('A setting stopped parsing.')).toBeInTheDocument();
  });
});

/**
 * The inverse of the notifications case, and the same rule: a screen must not
 * hide what the server would serve.
 *
 * `GET /providers` takes a session and no permission — it is a catalogue of
 * code, identical for every tenant. The shell gated both the nav entry and the
 * route on `panels.view`, so the actor this release built the create form for
 * (`panels.edit`, no `panels.view`) could not reach it, while the create form
 * they CAN reach fetches that same catalogue and renders it in its picker.
 */
describe('the providers catalogue', () => {
  const entry = NAV.find((candidate) => candidate.id === 'providers');
  const CATALOGUE = {
    url: '/providers',
    body: {
      providers: [
        {
          key: 'marzban',
          canonicalName: 'Marzban',
          credentialShape: 'USERNAME_PASSWORD',
          capabilities: ['HEALTH_CHECK'],
          requiredActivationFields: [],
          maturity: 'now',
        },
      ],
    },
  };

  it('is offered to an actor who may create a panel but not list one', async () => {
    expect(entry, 'the providers nav entry').toBeDefined();
    expect(navPermitted(entry!, ['panels.edit'])).toBe(true);

    stubApi([CATALOGUE]);
    renderPage(routeFor('/providers', ['panels.edit']));
    expect(await screen.findByText('Marzban')).toBeInTheDocument();
    expect(screen.queryByText('شما به این بخش دسترسی ندارید.')).toBeNull();
  });

  it('is offered to a session holding neither panel permission, because the server serves it', async () => {
    expect(navPermitted(entry!, ['reports.view'])).toBe(true);

    stubApi([CATALOGUE]);
    renderPage(routeFor('/providers', ['reports.view']));
    expect(await screen.findByText('Marzban')).toBeInTheDocument();
  });
});

/**
 * The notification detail was the one polled query on this branch with no way
 * back from a failure: a message and no button, a stale attempts card below it
 * still showing the pre-failure list, and re-clicking the same row setting
 * `selected` to the value it already held — so React bails out and nothing
 * refetches. `polling.ts` asserted that every stopped interval could be
 * restarted by "a Retry control and a reload"; for this one that was half true.
 */
describe('a notification detail that failed to load', () => {
  const LIST = {
    url: '/notifications',
    body: {
      notifications: [
        {
          id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cb',
          kind: 'OPERATIONAL_EVENT',
          status: 'SENT',
          templateKey: 'ops.alert',
          attemptCount: 1,
          maxAttempts: 5,
          createdAt: '2026-09-06T08:00:00.000Z',
          lastAttemptAt: '2026-09-06T08:00:01.000Z',
          completedAt: '2026-09-06T08:00:01.000Z',
          correlationId: 'c1',
        },
      ],
      nextCursor: null,
    },
  };
  const DETAIL_URL = '/notifications/01a05e35-c9ad-7e93-bef3-1ed9b55292cb';

  it('offers a retry that actually re-asks', async () => {
    const api = stubApi([
      LIST,
      {
        url: DETAIL_URL,
        status: 500,
        body: {
          error: { kind: 'internal', code: 'oops', message: 'no', correlationId: 'c1' },
        },
      },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'ops.alert' }));
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });

    const before = api.calls.filter((call) => call.url.includes(DETAIL_URL)).length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(retry);
    await waitFor(() => {
      expect(api.calls.filter((call) => call.url.includes(DETAIL_URL)).length).toBeGreaterThan(
        before,
      );
    });
  });
});

/**
 * The three exemptions carved out of "a 4xx is an answer".
 *
 * Each is a status the server uses to say ASK AGAIN, and each was a rule with
 * no test when it shipped — which this branch has learned is a rule that will
 * be silently reverted. Dropping all three from `finalAnswer` left the whole
 * web suite green.
 */
describe('the 4xx answers that are really requests to wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const countOf = (calls: readonly { url: string }[], fragment: string) =>
    calls.filter((call) => call.url.includes(fragment)).length;

  const keepsPolling = async (status: number, code: string) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    renderPage(<DashboardPage permissions={['panels.view', 'opslog.view']} />);
    await screen.findByText('چیزی برای رسیدگی نیست.');

    const waiting = stubApi([
      READINESS,
      { url: '/panels', body: { panels: [], nextCursor: null } },
      {
        url: '/ops-log',
        status,
        body: { error: { kind: 'x', code, message: 'wait', correlationId: 'test' } },
      },
    ]);

    await vi.advanceTimersByTimeAsync(16_000);
    await waitFor(() => {
      expect(countOf(waiting.calls, '/ops-log')).toBeGreaterThan(0);
    });
    const first = countOf(waiting.calls, '/ops-log');

    // It must ask again. The slow lane applies, so ninety seconds is enough.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(countOf(waiting.calls, '/ops-log')).toBeGreaterThan(first);
  };

  it('keeps asking after a 408', async () => {
    await keepsPolling(408, 'timeout');
  });

  it('keeps asking after a 429', async () => {
    await keepsPolling(429, 'rate_limited');
  });

  /**
   * The one that made a status insufficient on its own.
   *
   * `auth.tenant_suspended` is a 401 the server issues while an installation is
   * PAUSED. It deliberately does not revoke the session — "a tenant can be
   * started again, and the sessions its operators held are not the thing that
   * was suspended" — and its message is "Try again once it has been started".
   * Treating it as final froze a wall display for a whole maintenance window
   * AND left it frozen after the installation came back.
   */
  it('keeps asking while the installation is merely paused', async () => {
    await keepsPolling(401, 'auth.tenant_suspended');
  });
});

/**
 * The coldest form of the frozen screen, and the one the "only while unsettled"
 * interval nearly kept.
 *
 * `pollUnlessFinalWhile` asks its condition of the last successful data. On a
 * FIRST load there is none, so an early version returned `false` for that case
 * — and a tab opened during a rolling restart, whose very first request 502s,
 * never polled again even after the server came back. A mutation restoring that
 * killed nothing, which is how the gap was found.
 */
describe('a list whose first load failed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on its own, and shows the data once the server returns', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi([
      {
        url: '/notifications',
        status: 502,
        body: { error: { kind: 'internal', code: 'bad', message: 'no', correlationId: 'c1' } },
      },
    ]);
    renderPage(<NotificationsPage mayTest denied={false} />);
    // The error state, with nothing ever having loaded.
    await screen.findByRole('button', { name: 'تلاش دوباره' });

    // The deployment finishes. Nobody presses anything.
    stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [
            {
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292cc',
              kind: 'OPERATIONAL_EVENT',
              status: 'SENT',
              templateKey: 'ops.recovered',
              attemptCount: 1,
              maxAttempts: 5,
              createdAt: '2026-09-06T08:00:00.000Z',
              lastAttemptAt: '2026-09-06T08:00:01.000Z',
              completedAt: '2026-09-06T08:00:01.000Z',
              correlationId: 'c1',
            },
          ],
          nextCursor: null,
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(await screen.findByText('ops.recovered')).toBeInTheDocument();
  });
});
