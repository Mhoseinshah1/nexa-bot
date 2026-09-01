import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@nexa/contracts';
import { readSessionToken } from '../../apps/api/src/surfaces/web/authenticated-request';

/**
 * A shadowing cookie must not be the one that authenticates.
 *
 * A sibling host under a shared parent domain can set a cookie of the session's
 * name for `Domain=example.com` with a longer `Path`. Browsers send longer-path
 * cookies FIRST, and every conventional parser — ours included — takes the first
 * occurrence of a name. The `__Host-` prefix is what makes that impossible: a
 * browser refuses to store such a cookie unless it is `Secure`, `Path=/`, and
 * names no `Domain`, so only this host can have set one.
 */
function request(cookie: string): Parameters<typeof readSessionToken>[0] {
  return { headers: { cookie } } as unknown as Parameters<typeof readSessionToken>[0];
}

describe('session cookie precedence', () => {
  it('prefers the __Host- cookie even when a plain one is sent first', () => {
    // Exactly the ordering a browser produces for an attacker's longer-path
    // cookie: theirs first, the real one after.
    const header = `${SESSION_COOKIE_NAME}=tossed-by-a-sibling-host; ${SESSION_COOKIE_NAME_SECURE}=the-real-session`;
    expect(readSessionToken(request(header), false)).toBe('the-real-session');
    expect(readSessionToken(request(header), true)).toBe('the-real-session');
  });

  it('refuses a plain cookie outright in production', () => {
    // Preferring the prefixed name protects a request carrying BOTH. A
    // logged-out victim carries neither, so a sibling host setting the plain
    // name for the parent domain would simply be believed — and a host-only
    // clear header cannot delete another domain's cookie afterwards.
    const header = `${SESSION_COOKIE_NAME}=tossed-by-a-sibling-host`;
    expect(readSessionToken(request(header), true)).toBeNull();
    // Outside production it remains the only usable spelling, because a browser
    // refuses a __Host- cookie without Secure.
    expect(readSessionToken(request(header), false)).toBe('tossed-by-a-sibling-host');
  });

  it('takes the first occurrence within one name, as every parser does', () => {
    expect(
      readSessionToken(
        request(`${SESSION_COOKIE_NAME_SECURE}=first; ${SESSION_COOKIE_NAME_SECURE}=second`),
        true,
      ),
    ).toBe('first');
  });

  it('reads nothing from a request with no cookies', () => {
    expect(readSessionToken(request(''), true)).toBeNull();
    expect(readSessionToken(request(''), false)).toBeNull();
  });

  it('names the prefixed cookie in the form browsers enforce', () => {
    // The prefix is not cosmetic: the browser's acceptance rule is keyed to
    // this exact spelling.
    expect(SESSION_COOKIE_NAME_SECURE).toBe(`__Host-${SESSION_COOKIE_NAME}`);
  });
});
