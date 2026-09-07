import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
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
