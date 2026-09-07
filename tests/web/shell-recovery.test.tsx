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
    await screen.findByText(
      'وضعیت ورود شما قابل بررسی نیست. ممکن است همچنان وارد باشید — پیش از ورود دوباره، اتصال را بررسی کنید.',
    );
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
    await waitFor(() => {
      expect(
        screen.queryByText(
          'وضعیت ورود شما قابل بررسی نیست. ممکن است همچنان وارد باشید — پیش از ورود دوباره، اتصال را بررسی کنید.',
        ),
      ).toBeNull();
    });
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
