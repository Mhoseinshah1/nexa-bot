import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
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
    const recovered = stubApi(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(35_000);
    await waitFor(() => {
      expect(
        recovered.calls.filter((call) => call.url.includes('/auth/session')).length,
      ).toBeGreaterThan(0);
    });
  });
});

/**
 * The shell rendered whole for the three states the pure `sessionView` cannot
 * reach: a permanently broken lookup, a sign-out, and a tab nobody was looking
 * at.
 */
describe('the shell in the states a pure function cannot see', () => {
  afterEach(() => {
    vi.useRealTimers();
    // RESTORED — deleted, so jsdom's own accessor comes back, rather than
    // pinned to a stub that merely agrees with it today. Two tests here
    // redefine it and jsdom's document is shared for the whole file, so leaving
    // it overridden is a landmine for the next test appended to this block: it
    // would run against a tab that is permanently visible without saying so,
    // and could never exercise real visibility tracking.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  const SIGNED_IN = [
    { url: '/auth/session', body: SESSION },
    { url: '/system/readiness', body: { status: 'ok', dependencies: [] } },
    { url: '/panels', body: { panels: [], nextCursor: null } },
    { url: '/ops-log', body: { events: [], nextCursor: null } },
    { url: '/health/info', body: { version: '1', commit: 'abc', builtAt: null } },
  ];

  /**
   * 1d — the rule is `finalAnswer`, and only its `ZodError` arm was tested.
   *
   * The comment at the site says it covers "a 403 here… the session lookup
   * itself being refused". Replacing `finalAnswer(session.error)` with an
   * explicit `name === 'ZodError'` check left all 290 tests green, and on a
   * 403 or a 404 restored exactly the measured defect the round claims to have
   * removed: copy blaming the connection for an answer the server gave, beside
   * a Retry whose press issues two more requests (`main.tsx` retries once)
   * against a query whose poll has already stopped.
   *
   * A 503 is the control. It is retryable, `pollSession` keeps asking, and the
   * connection copy is TRUE there — so this test would pass under the mutation
   * if it only checked the final cases, and the third leg is what makes it a
   * rule rather than three examples.
   */
  it.each([
    ['forbidden', 403],
    ['not_found', 404],
  ])('says the server refused a %s session lookup, and offers no retry', async (kind, status) => {
    stubApi([
      ...SIGNED_IN.filter((route) => !route.url.includes('/auth/session')),
      {
        url: '/auth/session',
        status,
        body: { error: { kind, code: 'test.refused', message: 'no', correlationId: 'c' } },
      },
    ]);
    renderShell();

    expect(await screen.findByText(t('web.rejected'))).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.retry') })).toBeNull();
  });

  /**
   * F7 — 408 and 429 are NOT final, and the rule had no leg holding that end.
   *
   * `finalAnswer` excludes both deliberately: a timeout and a rate limit are
   * exactly what waiting cures, and `pollSession` keeps asking. Widening
   * `settled` to class them as final left all 299 tests green, and it makes
   * the shell print "the server rejected it" and withdraw Retry while the poll
   * is still running — a screen asserting a final answer the server did not
   * give. Same argument as the 503 leg: three examples are not a rule.
   */
  it.each([
    ['a timeout', 408],
    ['a rate limit', 429],
  ])('keeps asking after %s', async (_label, status) => {
    stubApi([
      ...SIGNED_IN.filter((route) => !route.url.includes('/auth/session')),
      {
        url: '/auth/session',
        status,
        body: {
          error: { kind: 'internal', code: 'test.slow', message: 'slow', correlationId: 'c' },
        },
      },
    ]);
    renderShell();

    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.retry') })).toBeInTheDocument();
    expect(screen.queryByText(t('web.rejected'))).toBeNull();
  });

  it('keeps the connection copy and the retry for a 503', async () => {
    stubApi([
      ...SIGNED_IN.filter((route) => !route.url.includes('/auth/session')),
      {
        url: '/auth/session',
        status: 503,
        body: {
          error: { kind: 'internal', code: 'test.down', message: 'down', correlationId: 'c' },
        },
      },
    ]);
    renderShell();

    // The connection really may be the problem, and the poll is still running.
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.retry') })).toBeInTheDocument();
    expect(screen.queryByText(t('web.rejected'))).toBeNull();
  });

  /**
   * `pollSession` stops on a final answer, so on one the shell has learned the
   * lookup is permanently broken and will never ask again. Keeping the console
   * drawn there was the previous round's defect reached through the door its
   * own fix opened: a complete admin console, nothing to press, for ever.
   *
   * And what replaces it must not lie about why. This screen said the
   * connection could not be established, beside a live Retry, for a **200** the
   * schema rejected — the transport worked, the server answered, and pressing
   * Retry issued two more requests (`main.tsx` retries once) that could not
   * answer differently, on a query whose poll has stopped. It was the third
   * error card on the branch and the only one `errorCopy` had not reached.
   */
  it('stops showing a console it can no longer confirm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(SIGNED_IN);
    renderShell();
    await screen.findByText('مدیر اصلی');

    // A 200 whose body this bundle cannot parse: contract skew across a deploy.
    stubApi([
      ...SIGNED_IN.filter((route) => !route.url.includes('/auth/session')),
      { url: '/auth/session', body: { nothing: 'the schema expects' } },
    ]);

    await vi.advanceTimersByTimeAsync(65_000);
    // The server ANSWERED. Not the connection copy, and no retry to press.
    expect(await screen.findByText(t('web.rejected'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rejected_hint'))).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.retry') })).toBeNull();
    expect(screen.queryByText('مدیر اصلی')).toBeNull();

    // ...and it STOPS asking. Deleting `pollSession`'s final-answer branch left
    // every test in the suite green, because they all asserted what was drawn
    // and never how often it was asked.
    const skewed = stubApi([
      ...SIGNED_IN.filter((route) => !route.url.includes('/auth/session')),
      { url: '/auth/session', body: { nothing: 'the schema expects' } },
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(skewed.calls.filter((call) => call.url.includes('/auth/session')).length).toBe(0);
    // A POSITIVE CONTROL for that zero, and it took a second attempt to find
    // one. The obvious "some other request reached the stub" does not exist
    // here: the unavailable screen unmounts `SignedIn`, so every page interval
    // is gone and the stub sees NO traffic whatsoever — which means the bare
    // `toBe(0)` above was equally satisfied by "the shell stopped asking" and
    // by "this stub was never wired up".
    //
    // So the control is a deliberate trigger. Coming back to the tab must reach
    // the stub — proving it is live and the tree is mounted — which leaves the
    // zero above meaning only what it claims: the INTERVAL gave up.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => {
      expect(
        skewed.calls.filter((call) => call.url.includes('/auth/session')).length,
        'the stub must be reachable for the zero above to mean anything',
      ).toBeGreaterThan(0);
    });
  });

  /**
   * Signing out is known, not derived. The server has destroyed the session; a
   * client that re-asks and keeps the console up when the answer does not come
   * back has told the operator on a shared machine that they are still signed
   * in, and on a FINAL failure it says so for ever.
   *
   * The 403 route below is the answer a follow-up lookup WOULD get. Under the
   * rule this test protects no follow-up happens at all, so the route is what
   * the mutant hits; the assertion that nothing was asked is below.
   */
  it('signs out at once, without re-asking a question already answered', async () => {
    stubApi(SIGNED_IN);
    renderShell();
    await screen.findByText('مدیر اصلی');

    stubApi([
      { url: '/auth/logout', body: { ok: true } },
      {
        url: '/auth/session',
        status: 403,
        body: {
          error: { kind: 'FORBIDDEN', code: 'nope', message: 'no', correlationId: 'c1' },
        },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'خروج' }));

    expect(await screen.findByLabelText('نام کاربری')).toBeInTheDocument();
    expect(screen.queryByText('مدیر اصلی')).toBeNull();
    // ...and it did not ask. A sign-out that re-derives its own outcome can
    // only get something worse back.
    expect(
      screen.queryByText(UNAVAILABLE),
      'a sign-out must not be able to render a lookup failure',
    ).toBeNull();
  });

  /**
   * The other half of the same rule: a lookup already IN FLIGHT when sign-out
   * lands must not be allowed to answer.
   *
   * `setQueryData` dispatches a success and never touches the retryer, so a
   * `GET /auth/session` sent moments earlier with a still-valid cookie resolves
   * afterwards and overwrites the `null` with the session it fetched. The
   * console came back — for a whole refresh cadence, on the shared machine this
   * path exists for. `refetchOnWindowFocus` is what makes the race ordinary:
   * returning to a tab and immediately signing out is a normal sequence.
   */
  it('cannot be undone by a session lookup that was already in flight', async () => {
    // Captured out of the executor through an object so TypeScript does not
    // narrow the binding to `null` at the call site below.
    const gate: { release: (value: unknown) => void } = { release: () => undefined };
    const pending = new Promise((resolve) => {
      gate.release = resolve;
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.includes('/auth/logout')) return json({ ok: true });
        if (url.includes('/auth/session')) {
          // The FIRST session request answers immediately; the second is the
          // one left hanging across the sign-out.
          if (calls.filter((call) => call.includes('/auth/session')).length > 1) {
            await pending;
          }
          return json(SESSION);
        }
        if (url.includes('/health/info'))
          return json({ version: '1', commit: 'abc', builtAt: null });
        if (url.includes('/system/readiness')) return json({ status: 'ok', dependencies: [] });
        if (url.includes('/ops-log')) return json({ events: [], nextCursor: null });
        if (url.includes('/panels')) return json({ panels: [], nextCursor: null });
        return json({ error: { kind: 'x', code: 'x', message: 'x', correlationId: 'x' } }, 404);
      }),
    );

    renderShell();
    await screen.findByText('مدیر اصلی');

    // Coming back to the tab starts a session lookup that will not answer yet.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));

    fireEvent.click(screen.getByRole('button', { name: 'خروج' }));
    await screen.findByLabelText('نام کاربری');

    // The in-flight lookup now answers, with the session it was granted before
    // the cookie was cleared.
    //
    // NOT `waitFor(() => expect(...).toBeNull())`. The console is already gone
    // at this point, so that condition holds on entry and the wait returns
    // before the released response is anywhere near being applied — the first
    // version of this assertion passed against the very defect it names. Give
    // the resolution a real chance to land, then assert.
    gate.release(undefined);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });
    expect(screen.queryByText('مدیر اصلی')).toBeNull();
    expect(screen.getByLabelText('نام کاربری')).toBeInTheDocument();
  });

  /**
   * `refetchInterval` does not run while a tab is hidden — React Query's
   * `refetchIntervalInBackground` is `false` by default — so the interval alone
   * covers the wall display and NOT the case this was written for: an operator
   * who leaves the tab open behind another one and comes back to a console
   * whose session died while nobody was watching.
   */
  it('re-asks the moment the operator comes back to the tab', async () => {
    stubApi(SIGNED_IN);
    renderShell();
    await screen.findByText('مدیر اصلی');

    const returned = stubApi([
      {
        url: '/auth/session',
        status: 401,
        body: {
          error: {
            kind: 'UNAUTHENTICATED',
            code: 'auth.session_invalid',
            message: 'Sign in again.',
            correlationId: 'c1',
          },
        },
      },
    ]);

    // No timers advanced: this is the tab becoming visible again, which is the
    // event React Query's focus manager listens for. The manager reads
    // `document.visibilityState`, so it has to actually change — jsdom reports
    // `visible` throughout otherwise, and the event would be ignored.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByLabelText('نام کاربری')).toBeInTheDocument();
    expect(
      returned.calls.filter((call) => call.url.includes('/auth/session')).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * The harm the `data === null` rule is justified by, seen at the render level.
 *
 * `sessionView`'s comment and the commit that added it both say a failing focus
 * refetch "unmounted the form mid-typing and lost the username already in it".
 * That was covered only by two pure-function cases, which cannot see an
 * unmount — and this branch's own ledger says a rule with no test is a rule
 * that will be silently reverted. A later change that keeps `sessionView`
 * honest but reintroduces the unmount on `App`'s side would restore the exact
 * defect with the suite green.
 */
describe('a sign-in form during a failing lookup', () => {
  it('keeps the form and the username already typed into it', async () => {
    stubApi([
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
    const username = (await screen.findByLabelText('نام کاربری')) as HTMLInputElement;
    fireEvent.change(username, { target: { value: 'owner' } });

    // The operator alt-tabs to a password manager and comes back mid-deploy.
    const blip = stubApi([
      {
        url: '/auth/session',
        status: 503,
        body: { error: { kind: 'internal', code: 'down', message: 'no', correlationId: 'c1' } },
      },
    ]);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });

    // The control this test needs, and the same one the assertion two describes
    // above needed: without it, dropping `refetchOnWindowFocus` would leave the
    // 503 unfetched, the form trivially intact, and this test green while
    // covering nothing.
    expect(
      blip.calls.filter((call) => call.url.includes('/auth/session')).length,
      'the failing refetch must actually have happened',
    ).toBeGreaterThan(0);
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect((screen.getByLabelText('نام کاربری') as HTMLInputElement).value).toBe('owner');
  });

  afterEach(() => {
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });
});
