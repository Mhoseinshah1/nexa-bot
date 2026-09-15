import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { SanaeiAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import {
  CANARY,
  startFake3xUi,
  type Behaviour,
  type Fake3xUi,
  type Fake3xUiOptions,
} from '../support/fake-3xui';

/**
 * The Sanaei / 3X-UI adapter, against a deterministic fake 3X-UI on a real
 * socket.
 *
 * The fake reproduces MHSanaei/3x-ui v3.7.0 (commit
 * `f727d04f6522bb94a8fb52e8352fdcafb51c11e1`) and nothing else, so what these
 * tests establish is exactly the compatibility boundary this release claims:
 * implemented and verified against the v3.7.0 wire contract. No real panel is
 * contacted, by design — CI must not depend on somebody's installation being
 * up, and a test that reaches the internet fails for reasons unrelated to the
 * code.
 *
 * The real `SafeHttpClient` is used throughout. Mocking it away would erase the
 * parts most worth proving: that a custom `webBasePath` survives URL
 * composition, that TLS is verified, and that no credential can follow a
 * redirect to another origin.
 */

let fake: Fake3xUi | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function panel(options: Fake3xUiOptions = {}): Promise<Fake3xUi> {
  fake = await startFake3xUi(options);
  return fake;
}

const TOKENS = {
  [CANARY.token]: 'admin',
  'monitor-token-aaaaaaaaaaaa': 'monitor',
  'node-sync-token-bbbbbbbbbb': 'node-sync',
} as const;

function client(baseUrl: string, extra: { ca?: readonly string[]; timeoutMs?: number } = {}) {
  return new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: extra.timeoutMs ?? 2_000,
    maxResponseBytes: 64 * 1024,
    maxRetries: 0,
    ...(extra.ca === undefined ? {} : { caCertificates: extra.ca }),
  }).forBase(baseUrl);
}

const withToken = (token: string): ProviderTarget['credentials'] => ({
  shape: 'OPAQUE_TOKEN',
  token,
});
const withPassword = (
  username: string = CANARY.username,
  password: string = CANARY.password,
): ProviderTarget['credentials'] => ({ shape: 'USERNAME_PASSWORD', username, password });

function probe(
  server: Fake3xUi,
  credentials: ProviderTarget['credentials'],
  extra: { ca?: readonly string[]; timeoutMs?: number } = {},
) {
  return new SanaeiAdapter().probe(
    { baseUrl: server.baseUrl, credentials },
    client(server.baseUrl, extra),
  );
}

/** Everything the adapter said, as one string, for a canary search. */
const asText = (value: unknown): string => JSON.stringify(value);

// ===========================================================================
// Bearer
// ===========================================================================
describe('the Sanaei adapter — Bearer API token', () => {
  it('1. authenticates an admin token and reads the status', async () => {
    const server = await panel({ tokens: TOKENS });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toEqual({ ok: true, providerVersion: '3.7.0', degraded: false });
    // One request. A Bearer caller bypasses CSRF in v3.7.0, so asking for a
    // token first would be a wasted round trip.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${CANARY.token}`);
  });

  it('2. authenticates a monitor-scoped token — least privilege is enough', async () => {
    const server = await panel({ tokens: TOKENS });
    const outcome = await probe(server, withToken('monitor-token-aaaaaaaaaaaa'));
    expect(outcome).toMatchObject({ ok: true, degraded: false });
  });

  it('3. authenticates a node-sync token, which v3.7.0 also allows on status', async () => {
    const server = await panel({ tokens: TOKENS });
    const outcome = await probe(server, withToken('node-sync-token-bbbbbbbbbb'));
    expect(outcome).toMatchObject({ ok: true, degraded: false });
  });

  it('4. reports an invalid token as an authentication failure, not a missing panel', async () => {
    const server = await panel({ tokens: TOKENS });
    const outcome = await probe(server, withToken('not-a-real-token'));
    expect(outcome).toEqual({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 401 });
  });

  it('4b. sends X-Requested-With so the rejection is a 401 rather than a 404', async () => {
    const server = await panel({ tokens: TOKENS });
    await probe(server, withToken('not-a-real-token'));
    expect(server.requests[0]?.headers['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('5. reports a scope refusal as an authentication failure, with the 403', async () => {
    // A token the panel KNOWS, refused by enforceTokenScope because its scope's
    // allowlist does not reach /server/status. Distinct from an unknown token:
    // this one authenticated and was then denied, and both are the operator's
    // credential to fix.
    const server = await panel({ tokens: { 'scoped-away-token': 'denied' } });
    const outcome = await probe(server, withToken('scoped-away-token'));
    expect(outcome).toEqual({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 403 });
    // The panel's refusal message is not repeated to the operator.
    expect(asText(outcome)).not.toContain('not permitted');
  });

  it('5b. a 404 on the status route is NOT a rejected credential', async () => {
    // The finding: this adapter always sends X-Requested-With, and that header
    // is exactly what makes v3.7.0 answer 401 rather than 404 for an
    // unauthenticated request. So under Nexa's own request mode a 404 cannot
    // be the unauthenticated answer — it is a moved webBasePath, a proxy, or
    // an upstream that does not serve the route. Reporting it as an
    // authentication failure sends an operator to rotate a token that works.
    const server = await panel({ tokens: TOKENS, behaviour: 'status-404' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toEqual({ ok: false, failure: 'PROVIDER_ERROR', status: 404 });
    expect(outcome).not.toMatchObject({ failure: 'AUTHENTICATION_FAILED' });
  });

  it('5d. a rate limit is its own kind, not the panel being broken', async () => {
    // 429 used to be PROVIDER_ERROR, which is retryable — so the monitor
    // answered "you are calling me too often" with its SHORTEST failure
    // cadence, and told the operator to go and look at a panel that is fine.
    const server = await panel({ tokens: TOKENS, behaviour: 'status-429' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toEqual({ ok: false, failure: 'RATE_LIMITED', status: 429 });
    // Not a credential problem: rotating a working token on a panel with a
    // login limiter is how a rate limit becomes a lockout.
    expect(outcome).not.toMatchObject({ failure: 'AUTHENTICATION_FAILED' });
    // And the panel's own body is not repeated to the operator.
    expect(asText(outcome)).not.toContain('Too Many Requests');
  });

  it('5e. a rate limit is its own kind at EVERY session step, not only the token read', async () => {
    // The finding. The 429 rule was added to `fromApiStatus`, which only the
    // UNAUTHENTICATED status read goes through. The session flow is four
    // requests, and a limiter in front of the panel answers whichever one
    // arrives while its window is full — so csrf-token, the two-factor
    // question and the login each had their own branch mapping every non-2xx
    // to PROVIDER_ERROR. That is retryable, and the monitor answered "you are
    // calling me too often" with its SHORTEST failure cadence.
    for (const behaviour of ['csrf-429', 'twofactor-429', 'login-429'] as const) {
      const server = await panel({ tokens: TOKENS, behaviour });
      const outcome = await probe(server, withPassword());
      expect(outcome, `${behaviour} was not reported as a rate limit`).toEqual({
        ok: false,
        failure: 'RATE_LIMITED',
        status: 429,
      });
      // Never a credential problem: rotating a working password on a panel
      // with a login limiter is how a rate limit becomes a lockout.
      expect(outcome).not.toMatchObject({ failure: 'AUTHENTICATION_FAILED' });
      // Nor the panel's own body, which is a proxy's HTML.
      expect(asText(outcome)).not.toContain('Too Many Requests');
      await fake?.close();
      fake = null;
    }
  });

  it('5f. a rate limit AFTER a good login is not a degraded panel', async () => {
    // The worst of the four, because it fails in the opposite direction.
    // Everything after a successful login is DEGRADED on purpose — the panel
    // is up and the credentials are right, so an authentication failure there
    // would send an operator to replace a password that just worked. But
    // DEGRADED is `ok: true`, so it earns the HEALTHY cadence: the one answer
    // a limiter must not get.
    const server = await panel({ tokens: TOKENS, behaviour: 'status-429' });
    const outcome = await probe(server, withPassword());
    expect(outcome).toEqual({ ok: false, failure: 'RATE_LIMITED', status: 429 });
    expect(outcome).not.toMatchObject({ ok: true });
    // The login DID happen and DID succeed, so this is the authenticated path
    // rather than a flow that stopped earlier.
    expect(server.requests.map((request) => request.path.split('/').pop())).toContain('login');
  });

  it('5g. a 403 on login is still the CSRF reading, and 2FA is still terminal', async () => {
    // The 429 rule is inserted into the same branches as those two, so both
    // are re-asserted here rather than assumed: a fix that mapped every
    // non-2xx login answer to RATE_LIMITED would pass 5e and break these.
    const csrfBroken = await panel({ tokens: TOKENS, behaviour: 'login-403' });
    expect(await probe(csrfBroken, withPassword())).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 403,
    });
    await fake?.close();
    fake = null;

    const twoFactor = await panel({ tokens: TOKENS, twoFactorEnabled: true });
    expect(await probe(twoFactor, withPassword())).toEqual({
      ok: false,
      failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
      status: null,
    });
  });

  it('5c. a reachable panel at the WRONG configured base path is not a credential problem', async () => {
    // The same rule reached the way an operator actually reaches it: the panel
    // is served under one base path and configured under another, so every
    // request 404s. The token is perfectly valid.
    const server = await panel({ basePath: '/real-path/', tokens: TOKENS });
    const wrong = `${server.origin}/wrong-path/`;
    const outcome = await new SanaeiAdapter().probe(
      { baseUrl: wrong, credentials: withToken(CANARY.token) },
      client(wrong),
    );
    expect(outcome).toMatchObject({ ok: false, status: 404 });
    expect(outcome).not.toMatchObject({ failure: 'AUTHENTICATION_FAILED' });
  });

  it('6. refuses a malformed status body rather than reporting health', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'status-html' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE', status: 200 });
  });
});

// ===========================================================================
// Session
// ===========================================================================
describe('the Sanaei adapter — session compatibility mode', () => {
  it('7. mints a CSRF token and carries the session cookie it is bound to', async () => {
    const server = await panel();
    const outcome = await probe(server, withPassword());
    expect(outcome).toMatchObject({ ok: true, degraded: false });

    const paths = server.requests.map((r) => r.path.replace(/^\//, ''));
    expect(paths).toEqual(['csrf-token', 'getTwoFactorEnable', 'login', 'panel/api/server/status']);
    const login = server.requests[2];
    expect(login?.headers['x-csrf-token']).toMatch(/^canary-csrf-token/);
    expect(login?.headers['cookie']).toMatch(/3x-ui=canary-cookie-value/);
  });

  it('8. a login without the CSRF token is refused by the panel — so it never sends one', async () => {
    // Proven from the other side: the fake answers 403 to a login whose CSRF
    // header is missing or wrong, and the real flow never provokes it.
    const server = await panel();
    await probe(server, withPassword());
    const login = server.requests.find((r) => r.path.endsWith('login'));
    expect(login?.headers['x-csrf-token']).toBeTruthy();

    // And directly: a hand-made login without the header gets the 403 the
    // adapter's ordering exists to avoid.
    const bare = await client(server.baseUrl).send({
      method: 'POST',
      path: 'login',
      body: { kind: 'json', value: { username: CANARY.username, password: CANARY.password } },
    });
    expect(bare).toMatchObject({ ok: true, status: 403 });
  });

  it('9. authenticates a correct username and password', async () => {
    const server = await panel();
    const outcome = await probe(server, withPassword());
    expect(outcome).toEqual({ ok: true, providerVersion: '3.7.0', degraded: false });
  });

  it('10. treats HTTP 200 with success:false as an authentication failure', async () => {
    const server = await panel();
    const outcome = await probe(server, withPassword(CANARY.username, 'the-wrong-password'));
    expect(outcome).toEqual({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 200 });
    // It stopped there: no status read follows a failed login.
    expect(server.requests.map((r) => r.path)).not.toContain('/panel/api/server/status');
  });

  it('11. sends the session cookie on the status read', async () => {
    const server = await panel();
    await probe(server, withPassword());
    const status = server.requests.find((r) => r.path.endsWith('server/status'));
    expect(status?.headers['cookie']).toMatch(/3x-ui=/);
  });

  it('12 + 13. never reuses a session cookie between probes', async () => {
    const server = await panel();
    await probe(server, withPassword());
    const first = server.requests.find((r) => r.path.endsWith('login'))?.headers['cookie'];
    await probe(server, withPassword());
    const cookies = server.requests
      .filter((r) => r.path.endsWith('login'))
      .map((r) => r.headers['cookie']);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(first);
    expect(cookies[1]).not.toBe(cookies[0]);
    // Each probe minted its own session, which is what "no persistence" looks
    // like from the panel's side.
    expect(server.requests.filter((r) => r.path.endsWith('csrf-token'))).toHaveLength(2);
  });

  it('14. never reuses a CSRF token between probes', async () => {
    const server = await panel();
    await probe(server, withPassword());
    await probe(server, withPassword());
    const tokens = server.requests
      .filter((r) => r.path.endsWith('login'))
      .map((r) => r.headers['x-csrf-token']);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).not.toBe(tokens[0]);
  });

  it('15. stops before login when 2FA is enabled, and says an API token is needed', async () => {
    const server = await panel({ twoFactorEnabled: true });
    const outcome = await probe(server, withPassword());
    expect(outcome).toEqual({
      ok: false,
      failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
      status: null,
    });
    // The point of asking first: not one credential was submitted, so the
    // panel's own login limiter is untouched.
    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual([
      'csrf-token',
      'getTwoFactorEnable',
    ]);
    expect(asText(server.requests)).not.toContain(CANARY.password);
  });

  // --- Finding 1: the 2FA answer must be a boolean --------------------------
  const malformed2fa: ReadonlyArray<{ readonly label: string; readonly behaviour: Behaviour }> = [
    { label: 'obj missing', behaviour: 'twofactor-obj-missing' },
    { label: 'obj null', behaviour: 'twofactor-obj-null' },
    { label: 'obj the STRING "true"', behaviour: 'twofactor-obj-string' },
    { label: 'obj an object', behaviour: 'twofactor-obj-object' },
    { label: 'success false', behaviour: 'twofactor-success-false' },
  ];

  for (const { label, behaviour } of malformed2fa) {
    it(`15b. a 2FA answer with ${label} submits NO credential`, async () => {
      // The rule: "not exactly true" is not permission to try a password. An
      // incompatible or rewritten answer to "is a second factor required" is a
      // compatibility failure, and finding out by submitting the operator's
      // credentials is what the pre-login question exists to avoid.
      const server = await panel({ behaviour });
      const outcome = await probe(server, withPassword());
      expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });

      // The load-bearing half: no login was attempted at all.
      const paths = server.requests.map((r) => r.path.replace(/^\//, ''));
      expect(paths).toEqual(['csrf-token', 'getTwoFactorEnable']);
      expect(paths).not.toContain('login');
      const seen = asText(server.requests);
      expect(seen).not.toContain(CANARY.password);
      expect(seen).not.toContain(CANARY.username);
    });
  }

  // --- Finding 4: only the official session cookie is replayed ---------------
  it('16b. replays ONLY the 3x-ui cookie, never an unrelated one', async () => {
    // A panel origin can carry cookies that are nothing to do with 3X-UI — a
    // proxy, a WAF, an analytics tag. Sending them back on requests that carry
    // a CSRF token and a password is not part of the v3.7.0 contract.
    const server = await panel({ behaviour: 'csrf-extra-cookie' });
    const outcome = await probe(server, withPassword());
    expect(outcome).toMatchObject({ ok: true, degraded: false });

    const afterMint = server.requests.filter((r) => !r.path.endsWith('csrf-token'));
    expect(afterMint.length).toBeGreaterThan(0);
    for (const request of afterMint) {
      const cookie = request.headers['cookie'] ?? '';
      expect(cookie, request.path).toMatch(/^3x-ui=/);
      expect(cookie, request.path).not.toContain('attacker-extra-cookie');
      expect(cookie, request.path).not.toContain(CANARY.extraCookie);
    }
    expect(asText(server.requests)).not.toContain(CANARY.extraCookie);
    expect(asText(outcome)).not.toContain(CANARY.extraCookie);
  });

  it('16c. refuses when csrf-token sets no 3x-ui cookie, submitting no credential', async () => {
    const server = await panel({ behaviour: 'csrf-no-session-cookie' });
    const outcome = await probe(server, withPassword());

    // The STRUCTURAL claim first, deliberately. Falsification showed that when
    // the outcome-code assertion leads, a mutation that carries on past the
    // mint fails with "wrong error code" — which names the symptom and hides
    // the defect. What this test is actually about is that the flow STOPS at
    // the mint: no 2FA question, no login, nothing carried onward.
    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual(['csrf-token']);
    expect(asText(server.requests)).not.toContain(CANARY.password);
    expect(asText(server.requests)).not.toContain(CANARY.extraCookie);
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('16d. P7: refuses a csrf token too large to be one, submitting no credential', async () => {
    // Bounded only by `maxResponseBytes` — half a megabyte at the shipped
    // default — and then written into the headers of every request that
    // follows, on every probe, for ever. Same structural claim first: the flow
    // must STOP at the mint.
    const server = await panel({ behaviour: 'csrf-enormous-token' });
    const outcome = await probe(server, withPassword());

    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual(['csrf-token']);
    expect(asText(server.requests)).not.toContain(CANARY.password);
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('16e. P7: refuses a csrf token carrying CRLF rather than throwing on it', async () => {
    // Node rejects a header value containing a control character by THROWING,
    // so a panel answering with one turned a probe into an exception the caller
    // has to recover from. What actually happened is a panel that is not
    // speaking this contract, and that has a name.
    const server = await panel({ behaviour: 'csrf-token-with-crlf' });
    const outcome = await probe(server, withPassword());

    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual(['csrf-token']);
    expect(asText(server.requests)).not.toContain(CANARY.password);
    expect(asText(server.requests)).not.toContain('X-Injected');
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('16f. P7: refuses a session cookie too large to be one, submitting no credential', async () => {
    // The cookie is as provider-supplied as the token, and it is rotated by the
    // login and 2FA responses as well as minted here, so the bound is applied
    // where the value is read rather than only where it is first seen.
    const server = await panel({ behaviour: 'csrf-enormous-cookie' });
    const outcome = await probe(server, withPassword());

    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual(['csrf-token']);
    expect(asText(server.requests)).not.toContain(CANARY.password);
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('16g. P7: a LOGIN that rotates the session to something unusable is reported', async () => {
    // The defect this pins is the one a `?? session` fallback creates: an
    // unusable rotation was indistinguishable from no rotation, so the adapter
    // kept sending the cookie the panel had just replaced. The panel then
    // rejected the stale cookie with a 401, which this adapter maps to
    // DEGRADED — an operator told the credentials are fine and something else
    // is wrong, about a panel Nexa can never read.
    const server = await panel({ behaviour: 'login-enormous-cookie' });
    const outcome = await probe(server, withPassword());

    // It got as far as the login and stopped there: no status read with a
    // stale cookie.
    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual([
      'csrf-token',
      'getTwoFactorEnable',
      'login',
    ]);
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
    // Emphatically NOT degraded: that is the outcome the old fallback produced.
    expect(outcome).not.toMatchObject({ ok: true });
  });

  it('16h. P7: a 2FA response that rotates the session the same way is reported', async () => {
    const server = await panel({ behaviour: 'twofactor-enormous-cookie' });
    const outcome = await probe(server, withPassword());

    expect(server.requests.map((r) => r.path.replace(/^\//, ''))).toEqual([
      'csrf-token',
      'getTwoFactorEnable',
    ]);
    // And no credential was submitted, because the flow stopped before login.
    expect(asText(server.requests)).not.toContain(CANARY.password);
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('16i. P7: a response that sets NO session cookie keeps the one in hand', async () => {
    // The other half of the distinction, and the reason it cannot simply be
    // "any absent value is a failure": v3.7.0 does not rotate the session on
    // every response, and a probe that demanded one would fail against a
    // perfectly healthy panel. The ordinary path is the assertion.
    const server = await panel();
    const outcome = await probe(server, withPassword());

    expect(outcome).toMatchObject({ ok: true });
    // Every authenticated request carried the cookie minted at csrf-token.
    for (const request of server.requests.filter((r) => !r.path.endsWith('csrf-token'))) {
      expect(request.headers['cookie'], request.path).toMatch(/^3x-ui=/);
    }
  });

  it('16. never sends a twoFactorCode field', async () => {
    const server = await panel();
    await probe(server, withPassword());
    const login = server.requests.find((r) => r.path.endsWith('login'));
    expect(login?.body).not.toContain('twoFactorCode');
    expect(JSON.parse(login?.body ?? '{}')).toEqual({
      username: CANARY.username,
      password: CANARY.password,
    });
  });
});

// ===========================================================================
// Base path
// ===========================================================================
describe('the Sanaei adapter — webBasePath', () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly basePath: string }> = [
    { label: '17. root', basePath: '/' },
    { label: '18. a custom web base path', basePath: '/xui-secret-path/' },
    { label: '19. a nested base path', basePath: '/a/b/c/' },
  ];

  for (const { label, basePath } of cases) {
    it(`${label} — bearer and session both stay below it`, async () => {
      const server = await panel({ basePath, tokens: TOKENS });
      expect(await probe(server, withToken(CANARY.token))).toMatchObject({ ok: true });
      expect(await probe(server, withPassword())).toMatchObject({ ok: true });

      // 20. Nothing escaped: every request the panel saw is under the base.
      for (const request of server.requests) {
        expect(request.path.startsWith(basePath)).toBe(true);
      }
      expect(server.requests.map((r) => r.path)).toContain(`${basePath}panel/api/server/status`);
    });
  }

  it('20b. a base path with no trailing slash still composes below itself', async () => {
    const server = await panel({ basePath: '/xui-secret-path/', tokens: TOKENS });
    const trimmed = server.baseUrl.replace(/\/$/, '');
    const outcome = await new SanaeiAdapter().probe(
      { baseUrl: trimmed, credentials: withToken(CANARY.token) },
      client(trimmed),
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(server.requests[0]?.path).toBe('/xui-secret-path/panel/api/server/status');
  });
});

// ===========================================================================
// Network
// ===========================================================================
describe('the Sanaei adapter — network conditions', () => {
  it('21. reports a timeout as a timeout', async () => {
    const server = await panel({ behaviour: 'hang', tokens: TOKENS });
    const outcome = await probe(server, withToken(CANARY.token), { timeoutMs: 300 });
    expect(outcome).toMatchObject({ ok: false, failure: 'TIMEOUT' });
  });

  it('22. reports a refused connection as unreachable', async () => {
    const server = await panel({ tokens: TOKENS });
    const dead = server.baseUrl;
    await server.close();
    fake = null;
    const outcome = await new SanaeiAdapter().probe(
      { baseUrl: dead, credentials: withToken(CANARY.token) },
      client(dead),
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'UNREACHABLE' });
  });

  it('23 + 24. accepts a private CA when configured, and refuses the same certificate without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanaei-tls-'));
    const at = (name: string) => join(dir, name);
    const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-sha256',
      '-subj',
      '/CN=Nexa Test CA',
      '-keyout',
      at('ca.key'),
      '-out',
      at('ca.pem'),
    ]);
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=localhost',
      '-keyout',
      at('leaf.key'),
      '-out',
      at('leaf.csr'),
    ]);
    writeFileSync(at('ext.cnf'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
    openssl([
      'x509',
      '-req',
      '-in',
      at('leaf.csr'),
      '-CA',
      at('ca.pem'),
      '-CAkey',
      at('ca.key'),
      '-CAcreateserial',
      '-days',
      '2',
      '-sha256',
      '-extfile',
      at('ext.cnf'),
      '-out',
      at('leaf.pem'),
    ]);
    const ca = readFileSync(at('ca.pem'), 'utf8');

    const server = await panel({
      tokens: TOKENS,
      tls: {
        key: readFileSync(at('leaf.key'), 'utf8'),
        cert: readFileSync(at('leaf.pem'), 'utf8'),
      },
    });

    // 23: trusted through the configured CA — the self-hosted panel case.
    expect(await probe(server, withToken(CANARY.token), { ca: [ca] })).toMatchObject({ ok: true });
    // 24: the same certificate, no CA configured. Verification stays on.
    expect(await probe(server, withToken(CANARY.token))).toMatchObject({
      ok: false,
      failure: 'TLS_FAILED',
    });
  });

  it('25. refuses an infrastructure target through the URL policy', async () => {
    const blocked = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 64 * 1024,
      maxRetries: 0,
      deniedSubnets: ['127.0.0.0/8'],
    });
    const server = await panel({ tokens: TOKENS });
    const outcome = await new SanaeiAdapter().probe(
      { baseUrl: server.baseUrl, credentials: withToken(CANARY.token) },
      blocked.forBase(server.baseUrl),
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'BLOCKED_TARGET' });
    // Refused before the socket: the panel saw nothing, so no credential left.
    expect(server.requests).toHaveLength(0);
  });

  it('26. still permits a legitimate private panel while a deny list is in force', async () => {
    // The production shape: an installation that denies its OWN data network
    // must still reach a self-hosted panel elsewhere in private space. The
    // deny list here names a private range this panel is not on.
    const server = await panel({ tokens: TOKENS });
    const policed = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 64 * 1024,
      maxRetries: 0,
      deniedSubnets: ['172.29.1.0/24', '10.0.0.0/8'],
    });
    const outcome = await new SanaeiAdapter().probe(
      { baseUrl: server.baseUrl, credentials: withToken(CANARY.token) },
      policed.forBase(server.baseUrl),
    );
    expect(outcome).toMatchObject({ ok: true, degraded: false });
  });
});

// ===========================================================================
// Redirects
// ===========================================================================
describe('the Sanaei adapter — redirects never carry credentials', () => {
  const secretsIn = (server: Fake3xUi): string => asText(server.requests);

  it('27 + 29. a cross-origin redirect on the bearer probe receives nothing', async () => {
    const attacker = await startFake3xUi({ tokens: TOKENS });
    try {
      const server = await panel({
        tokens: TOKENS,
        behaviour: 'redirect-everything',
        redirectTo: attacker.origin,
      });
      const outcome = await probe(server, withToken(CANARY.token));
      // The client never follows a redirect, so there is no second request to
      // carry anything anywhere.
      expect(outcome).toMatchObject({ ok: false });
      expect(attacker.requests).toHaveLength(0);
      expect(secretsIn(attacker)).not.toContain(CANARY.token);
    } finally {
      await attacker.close();
    }
  });

  it('28 + 29. a cross-origin redirect during the session flow receives no cookie, password or CSRF token', async () => {
    const attacker = await startFake3xUi();
    try {
      const server = await panel({
        behaviour: 'redirect-everything',
        redirectTo: attacker.origin,
      });
      const outcome = await probe(server, withPassword());
      expect(outcome).toMatchObject({ ok: false });
      expect(attacker.requests).toHaveLength(0);
      const seen = secretsIn(attacker);
      expect(seen).not.toContain(CANARY.password);
      expect(seen).not.toContain(CANARY.cookie);
      expect(seen).not.toContain(CANARY.csrf);
      // And nothing about the redirect target reached the outcome.
      expect(asText(outcome)).not.toContain('attacker');
      expect(asText(outcome)).not.toContain(attacker.origin);
    } finally {
      await attacker.close();
    }
  });

  it('30. a same-origin redirect is not followed either — the policy is uniform', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'redirect-status' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toMatchObject({ ok: false, status: 302 });
    expect(server.requests).toHaveLength(1);
  });
});

// ===========================================================================
// Parser
// ===========================================================================
describe('the Sanaei adapter — the status parser is strict', () => {
  const rejects: ReadonlyArray<{ readonly label: string; readonly behaviour: Behaviour }> = [
    { label: '31. no envelope at all', behaviour: 'status-no-envelope' },
    { label: '32. an envelope reporting success:false', behaviour: 'status-success-false' },
    { label: '33. a body that is not JSON', behaviour: 'status-html' },
    {
      label: '31b. a null obj, which v3.7.0 sends before its first refresh',
      behaviour: 'status-obj-null',
    },
    { label: '31c. an obj with no xray — not a 3X-UI status', behaviour: 'status-missing-xray' },
  ];

  for (const { label, behaviour } of rejects) {
    it(`${label} is not health`, async () => {
      const server = await panel({ tokens: TOKENS, behaviour });
      const outcome = await probe(server, withToken(CANARY.token));
      expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
    });
  }

  it('34. an oversized body is refused rather than buffered', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'status-oversized' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toMatchObject({ ok: false, failure: 'MALFORMED_RESPONSE' });
  });

  it('35. unknown fields stay forward compatible', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'status-extra-fields' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toEqual({ ok: true, providerVersion: '3.7.0', degraded: false });
  });
});

// ===========================================================================
// Reflected secrets
// ===========================================================================
describe('the Sanaei adapter — a hostile panel cannot reflect a secret back out', () => {
  it('36. an API token echoed in the status body does not reach the outcome', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'status-reflects-token' });
    const outcome = await probe(server, withToken(CANARY.token));
    expect(outcome).toMatchObject({ ok: true });
    expect(asText(outcome)).not.toContain(CANARY.token);
  });

  it('37. a password echoed in a login failure does not reach the outcome', async () => {
    const server = await panel({ behaviour: 'login-reflects-credentials' });
    const outcome = await probe(server, withPassword());
    expect(outcome).toEqual({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 200 });
    const text = asText(outcome);
    expect(text).not.toContain(CANARY.password);
    expect(text).not.toContain(CANARY.username);
    // Nor the panel's own message, which is where the echo lived.
    expect(text).not.toContain('rejected user');
  });

  it('38 + 39. a cookie and a CSRF token echoed back do not reach the outcome', async () => {
    const server = await panel({ behaviour: 'login-reflects-session' });
    const outcome = await probe(server, withPassword());
    const text = asText(outcome);
    expect(text).not.toContain(CANARY.cookie);
    expect(text).not.toContain(CANARY.csrf);
  });

  it('39b. every outcome this adapter can produce carries only a kind, a status and a safe version', async () => {
    // Structural, not a substring search: the shapes are closed, so there is
    // nowhere for a reflected secret to ride out even in a case not listed
    // above.
    const server = await panel({ tokens: TOKENS });
    for (const credentials of [withToken(CANARY.token), withPassword()]) {
      const outcome = await probe(server, credentials);
      const keys = Object.keys(outcome).sort();
      expect(keys).toEqual(['degraded', 'ok', 'providerVersion']);
    }
    const failure = await probe(server, withToken('nope'));
    expect(Object.keys(failure).sort()).toEqual(['failure', 'ok', 'status']);
  });

  it('39c. a hostile version string is dropped rather than persisted', async () => {
    const server = await panel({ tokens: TOKENS, behaviour: 'status-extra-fields' });
    const outcome = await probe(server, withToken(CANARY.token));
    // The version that survives passed a character allowlist.
    expect(outcome).toMatchObject({ providerVersion: '3.7.0' });
  });
});

// ===========================================================================
// Registration
// ===========================================================================
describe('the Sanaei provider registration', () => {
  it('resolves through the registry to the real adapter', () => {
    const adapter = providerAdapter('sanaei');
    expect(adapter).toBeInstanceOf(SanaeiAdapter);
    expect(adapter.descriptor.key).toBe('sanaei');
    expect(adapter.supports('HEALTH_CHECK')).toBe(true);
  });

  it('declares the two-mode credential shape the source establishes', () => {
    expect(providerAdapter('sanaei').descriptor.credentialShape).toBe('TOKEN_OR_USERNAME_PASSWORD');
  });

  it('claims ONLY the capabilities that have code behind them', () => {
    // `supports()` answers from the descriptor and the providers endpoint
    // publishes it verbatim, so a capability listed here is a capability this
    // release tells operators it has. Phase 3B implemented authentication,
    // connection testing and a read-only health probe; Phase 4D adds creating a
    // client, reading its traffic and handing back a subscription link. Nothing
    // else for this provider — and the list below is the guard that says so.
    const adapter = providerAdapter('sanaei');
    expect([...adapter.descriptor.capabilities]).toEqual([
      'HEALTH_CHECK',
      'CREATE_USER',
      'READ_USAGE',
      'DELIVER_SUBSCRIPTION_LINK',
      // `LIMIT_DEVICES` is not a method: `createUser` writes `limitIp` from the
      // order's frozen `deviceLimit`, and 3X-UI's `limitIp` is its device limit
      // (`0` is its unlimited, which is why the adapter translates `null` to it).
      // It sat on the unimplemented list below while that code was running, so the
      // descriptor understated the adapter — and nothing consulted the capability,
      // which is why it looked harmless. Something does now: the provisioner refuses
      // a device-limited order on a panel that cannot apply one, so a panel that
      // CAN must say so or every such order is refused.
      'LIMIT_DEVICES',
    ]);
    for (const implemented of [
      'HEALTH_CHECK',
      'CREATE_USER',
      'READ_USAGE',
      'DELIVER_SUBSCRIPTION_LINK',
      'LIMIT_DEVICES',
    ] as const) {
      expect(adapter.supports(implemented), implemented).toBe(true);
    }
    // Each of these returns in the commit that implements it. Listed by name rather
    // than derived from the descriptor, because a test that computed the complement
    // would pass no matter which side a capability moved to.
    for (const unimplemented of [
      'RENEW_USER',
      'DELETE_USER',
      'DISABLE_USER',
      'ENABLE_USER',
      'RESET_USAGE',
      'ADD_VOLUME',
      'ADD_TIME',
      'ROTATE_SUBSCRIPTION_LINK',
      'DELIVER_RAW_CONFIGS',
      'DELIVER_CONFIG_FILE',
      'INACTIVE_ACCOUNT_INBOUND',
    ] as const) {
      expect(adapter.supports(unimplemented), unimplemented).toBe(false);
    }
  });
});
