import { describe, expect, it } from 'vitest';
import { sessionView } from '../../apps/web/src/app';
import { queryState, staleAfterError } from '../../apps/web/src/view-state';
import { ApiError } from '../../apps/web/src/api/client';

/**
 * A failed session LOOKUP is not a signed-out state.
 *
 * `fetchSession` resolves to `null` only for a 401 — the server saying there is
 * no session — and rejects for everything else: a database outage, a proxy 503,
 * a dropped connection. Collapsing those two into "show the sign-in form" told
 * an administrator holding a perfectly good cookie that they were signed out,
 * and invited them to open a second session to fix a problem that was never
 * theirs.
 */
const session = {
  admin: {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    username: 'owner',
    displayName: 'Owner',
    status: 'ACTIVE' as const,
    telegramUserId: null,
    roleKeys: ['owner'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  },
  permissions: ['admins.view'],
  expiresAt: '2026-01-02T00:00:00.000Z',
};

describe('session view', () => {
  it('reports a lookup failure with nothing cached as unavailable, not as signed out', () => {
    expect(
      sessionView({ isPending: false, isError: true, error: new ApiError(503, 'down', 'no') }),
    ).toBe('unavailable');
  });

  /**
   * The opposite of what this asserted until round 13.
   *
   * "An error means we do not know" is true of the LOOKUP and false of the
   * session: one that was successfully resolved is still the best thing this
   * tab knows. `refetchOnReconnect` is on by default, so a laptop waking, a
   * kiosk NIC flap or a Caddy reload fires `online` a moment before the API is
   * reachable — and replacing the signed-in tree with an error paragraph
   * unmounted every open form and lost whatever had been typed into it, for a
   * blip the next poll resolves. A revoked session is not this case: it comes
   * back as a resolved `null`, and lands in `signed-out` below.
   */
  it('keeps a resolved session when a later lookup fails', () => {
    expect(sessionView({ isPending: false, isError: true, data: session, error: null })).toBe(
      'signed-in',
    );
  });

  /**
   * And NOT over an error the shell has stopped asking about.
   *
   * `pollSession` gives up on a final answer — a 403, or a `ZodError` from a tab
   * holding a previous release across a deploy. Data winning there kept a
   * complete console drawn for ever with nothing to press, which is the defect
   * the data-wins rule was introduced beside. The two rules have to agree about
   * which failures are worth waiting through.
   */
  it('gives up a resolved session once the lookup is permanently broken', () => {
    const zod = Object.assign(new Error('bad shape'), { name: 'ZodError' });
    expect(sessionView({ isPending: false, isError: true, data: session, error: zod })).toBe(
      'unavailable',
    );
    expect(
      sessionView({
        isPending: false,
        isError: true,
        data: session,
        error: new ApiError(403, 'nope', 'no'),
      }),
    ).toBe('unavailable');
  });

  it('reports the server saying "no session" as signed out', () => {
    expect(sessionView({ isPending: false, isError: false, data: null, error: null })).toBe(
      'signed-out',
    );
  });

  it('reports a resolved session as signed in', () => {
    expect(sessionView({ isPending: false, isError: false, data: session, error: null })).toBe(
      'signed-in',
    );
  });

  it('reports a pending query as loading, whatever else is set', () => {
    expect(sessionView({ isPending: true, isError: false, error: null })).toBe('loading');
    expect(sessionView({ isPending: true, isError: true, error: null })).toBe('loading');
  });
});

/**
 * A resolved `null` is an ANSWER, and it stays the answer through any later
 * failure.
 *
 * Not the same rule as a resolved session, which is surrendered on a final
 * answer because a console that cannot be confirmed lies. A sign-in form never
 * does — so putting a browser that is provably signed out onto the "you may
 * still be signed in" screen was wrong in both directions: on a final error it
 * was terminal, with no interval and no way back, and on a retryable one it
 * unmounted the form mid-typing and lost the username already in it.
 *
 * `refetchOnWindowFocus` is what made this routine: before it, a signed-out tab
 * never fetched again at all.
 */
describe('a browser that is signed out', () => {
  it('stays signed out when a later lookup fails permanently', () => {
    expect(
      sessionView({
        isPending: false,
        isError: true,
        data: null,
        error: new ApiError(404, 'gone', 'no'),
      }),
    ).toBe('signed-out');
  });

  it('stays signed out when a later lookup fails transiently', () => {
    expect(
      sessionView({
        isPending: false,
        isError: true,
        data: null,
        error: new ApiError(503, 'down', 'no'),
      }),
    ).toBe('signed-out');
  });
});

/**
 * `queryState` and `sessionView` have to agree about which failures are worth
 * waiting through, and this is where that agreement is asserted.
 *
 * Tested at the FUNCTION rather than through a screen, because
 * `StateSwitch` renders the error state before it ever reads `stale` — so the
 * `finalAnswer` term inside `staleAfterError` is unreachable through any
 * rendered page and a mutation of it killed nothing. A term no test can falsify
 * is dead logic dressed as a rule; a unit test is what makes it a rule.
 */
describe('the view state of a query', () => {
  /**
   * A whole `QueryView`, because that is what the rules take now.
   *
   * `StateSwitch` derives the state, the staleness and the retry from ONE
   * object; three separately-passed props are what let six call sites go
   * unwired for a round and a wrong-query wiring go undetectable.
   */
  const view = (over: {
    isPending?: boolean;
    isError: boolean;
    data: unknown;
    error: unknown;
  }) => ({ isPending: false, refetch: () => undefined, ...over });
  const denied = new ApiError(403, 'access.permission_denied', 'no');
  const blip = new ApiError(503, 'platform.unavailable', 'later');

  it('shows nothing it has never had', () => {
    expect(queryState(view({ isError: true, data: undefined, error: blip }))).toBe('error');
  });

  it('keeps data through a retryable failure', () => {
    expect(queryState(view({ isError: true, data: { a: 1 }, error: blip }))).toBe('ready');
  });

  it('gives up the data on a final refusal, because no poll is coming', () => {
    expect(queryState(view({ isError: true, data: { a: 1 }, error: denied }))).toBe('error');
  });

  it('calls data stale only while the failure is worth waiting through', () => {
    expect(staleAfterError(view({ isError: true, data: { a: 1 }, error: blip }))).toBe(true);
    // The screen is gone in this case; saying "stale" of it would be a second
    // claim about a page that is not on screen.
    expect(staleAfterError(view({ isError: true, data: { a: 1 }, error: denied }))).toBe(false);
    expect(staleAfterError(view({ isError: false, data: { a: 1 }, error: null }))).toBe(false);
    expect(staleAfterError(view({ isError: true, data: undefined, error: blip }))).toBe(false);
  });
});
