import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/app';
import { stubApi } from './harness';

/**
 * The shell, rendered whole.
 *
 * No test in this suite rendered `<App />` at all, which is how the frozen
 * screen survived four rounds of fixing it one layer down: every page's polling
 * was corrected while the query that decides whether any page renders had no
 * interval, `retry: false`, and a Retry button as its only way out.
 *
 * A production-shaped client, because the harness's `retry: false` would hide
 * the difference between "the shell asks again" and "the shell asked once".
 */
const renderShell = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
};

const UNAVAILABLE =
  'وضعیت ورود شما قابل بررسی نیست. ممکن است همچنان وارد باشید — پیش از ورود دوباره، اتصال را بررسی کنید.';

const SESSION = {
  admin: {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    username: 'owner',
    displayName: 'مدیر اصلی',
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['owner'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-09-06T08:00:00.000Z',
  },
  permissions: ['panels.view'],
  expiresAt: '2026-09-07T08:00:00.000Z',
};

describe('a shell that could not resolve its session', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The headline scenario of four rounds of `polling.ts`, still true one layer
   * up: a tenant is stopped for maintenance, `authenticate` throws
   * `auth.tenant_suspended` — a 401 the server issues WITHOUT revoking the
   * session, whose message is "Try again once it has been started" — and
   * `fetchSession` rethrows it rather than reporting a signed-out state.
   */
  it('recovers by itself when the paused installation is started again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const paused = stubApi([
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.tenant_suspended',
            message: 'This installation is paused. Try again once it has been started.',
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderShell();
    await screen.findByText(UNAVAILABLE);
    expect(paused.calls.length).toBeGreaterThan(0);

    // `botctl start`. Nobody is at the screen.
    stubApi([
      { url: '/auth/session', body: SESSION },
      { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
      { url: '/panels', body: { panels: [], nextCursor: null } },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
      { url: '/health/info', body: { version: '1', commit: 'abc', builtAt: null } },
    ]);

    await vi.advanceTimersByTimeAsync(35_000);
    // The operator is SIGNED IN again, not merely no longer looking at the
    // paragraph. Asserting only that the paragraph left the DOM passed just as
    // well when the recovery answered "no session" and threw the operator out —
    // the exact conflation `fetchSession`, `sessionView` and
    // `auth.tenant_suspended` all exist to prevent.
    expect(await screen.findByText('مدیر اصلی')).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  /**
   * And a 401 that really means signed out is NOT a failure: `fetchSession`
   * returns null for it, so the query succeeds, the sign-in form renders, and
   * no interval is armed. A shell polling the session of a signed-out browser
   * would be pure noise.
   */
  it('does not poll when the server simply says there is no session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const anonymous = stubApi([
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.required',
            message: 'no session',
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderShell();
    await screen.findByLabelText('نام کاربری');

    const asked = anonymous.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(anonymous.calls.length).toBe(asked);
  });
});

/**
 * The worst screen this branch produced, and the one that survived four rounds
 * of fixing the pages beneath it.
 */
describe('a session that expires under an open tab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SIGNED_IN = [
    { url: '/auth/session', body: SESSION },
    { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
    { url: '/panels', body: { panels: [], nextCursor: null } },
    { url: '/ops-log', body: { events: [], nextCursor: null } },
    { url: '/health/info', body: { version: '1', commit: 'abc', builtAt: null } },
  ];

  /**
   * Every PAGE correctly stops polling on its 401 — that is the rule four
   * rounds of `polling.ts` established. The shell used not to ask at all, so
   * nothing on screen ever changed: a complete, fully drawn admin console that
   * could do nothing, with no way back but a manual reload and nothing telling
   * the operator to sign in again.
   */
  it('tells the operator to sign in again instead of leaving a console that does nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(SIGNED_IN);
    renderShell();
    await screen.findByText('مدیر اصلی');

    // The session expires, or an owner revokes it. `fetchSession` reports an
    // ordinary 401 as a resolved "nobody is signed in" rather than a failure.
    stubApi([
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.session_invalid',
            message: 'The session is not valid. Sign in again.',
            correlationId: 'c1',
          },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(65_000);
    expect(await screen.findByLabelText('نام کاربری')).toBeInTheDocument();
    expect(screen.queryByText('مدیر اصلی')).toBeNull();
  });

  /**
   * And the opposite mistake: a momentary blip must NOT tear the console down.
   *
   * `refetchOnReconnect` is on by default, so a laptop waking or a kiosk NIC
   * flap fires `online` a moment before the API is reachable. Replacing the
   * signed-in tree with an error paragraph unmounted every open form and lost
   * whatever had been typed into it — for a failure the next poll resolves.
   */
  it('keeps the console up through a failure that is not an answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(SIGNED_IN);
    renderShell();
    await screen.findByText('مدیر اصلی');

    stubApi([
      {
        url: '/auth/session',
        status: 503,
        body: {
          error: { kind: 'internal', code: 'down', message: 'no', correlationId: 'c1' },
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(screen.getByText('مدیر اصلی')).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();

    // ...and it is still asking, so "kept up" is not "gave up".
    stubApi(SIGNED_IN);
    const recovered = stubApi(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(35_000);
    await waitFor(() => {
      expect(
        recovered.calls.filter((call) => call.url.includes('/auth/session')).length,
      ).toBeGreaterThan(0);
    });
  });
});
