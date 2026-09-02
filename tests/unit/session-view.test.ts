import { describe, expect, it } from 'vitest';
import { sessionView } from '../../apps/web/src/app';

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
  it('reports a lookup failure as unavailable, not as signed out', () => {
    expect(sessionView({ isPending: false, isError: true })).toBe('unavailable');
    // Even when a stale value is still cached: an error means we do not know.
    expect(sessionView({ isPending: false, isError: true, data: session })).toBe('unavailable');
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
