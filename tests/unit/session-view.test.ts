import { describe, expect, it } from 'vitest';
import { sessionView } from '../../apps/web/src/app';
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
    expect(sessionView({ isPending: false, isError: true })).toBe('unavailable');
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
    expect(sessionView({ isPending: false, isError: true, data: session })).toBe('signed-in');
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
    expect(sessionView({ isPending: false, isError: false, data: null })).toBe('signed-out');
  });

  it('reports a resolved session as signed in', () => {
    expect(sessionView({ isPending: false, isError: false, data: session })).toBe('signed-in');
  });

  it('reports a pending query as loading, whatever else is set', () => {
    expect(sessionView({ isPending: true, isError: false })).toBe('loading');
    expect(sessionView({ isPending: true, isError: true })).toBe('loading');
  });
});
