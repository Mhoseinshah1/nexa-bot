import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';

/**
 * The Marzban adapter, against a deterministic fake Marzban.
 *
 * A LOCAL fake, never a real panel: CI must not depend on somebody else's
 * installation being up, and a test that reaches the internet fails for reasons
 * that have nothing to do with the code. The fake implements the two endpoints
 * the adapter uses and can be told to misbehave in each of the ways a real one
 * does.
 *
 * Worth stating plainly, because it bounds what these tests prove: the endpoint
 * shapes come from Marzban's documented API, NOT from the research corpus,
 * which records no Marzban path, method or payload at all. These tests prove
 * the adapter handles those shapes correctly. They do not prove the shapes are
 * right, and nothing in this phase has been run against a real Marzban.
 */
type Behaviour =
  | 'healthy'
  | 'bad-credentials'
  | 'forbidden'
  | 'server-error'
  | 'token-missing'
  | 'html-login-page'
  | 'system-unauthorized'
  | 'system-garbage'
  | 'hostile-version';

let server: Server;
let base: string;
let behaviour: Behaviour = 'healthy';
let loginBodies: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };

    if (url.startsWith('/api/admin/token')) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        loginBodies.push(Buffer.concat(chunks).toString('utf8'));
        switch (behaviour) {
          case 'bad-credentials':
            return json(401, { detail: 'Incorrect username or password' });
          case 'forbidden':
            return json(403, { detail: 'forbidden' });
          case 'server-error':
            return json(500, { detail: 'internal' });
          case 'token-missing':
            return json(200, { token_type: 'bearer' });
          case 'html-login-page':
            response.writeHead(200, { 'content-type': 'text/html' });
            return response.end('<html><body><form>Sign in</form></body></html>');
          default:
            return json(200, { access_token: 'ephemeral-token', token_type: 'bearer' });
        }
      });
      return;
    }

    if (url.startsWith('/api/system')) {
      if (request.headers.authorization !== 'Bearer ephemeral-token') {
        return json(401, { detail: 'not authenticated' });
      }
      switch (behaviour) {
        case 'system-unauthorized':
          return json(401, { detail: 'expired' });
        case 'system-garbage':
          response.writeHead(200, { 'content-type': 'text/html' });
          return response.end('<html>not json</html>');
        case 'hostile-version':
          return json(200, { version: `${'A'.repeat(500)}<script>alert(1)</script>` });
        default:
          return json(200, { version: '0.8.4', users_active: 12, mem_total: 1024 });
      }
    }

    json(404, { detail: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
    maxRetries: 0,
  }).forBase(base);

const CREDENTIALS: ProviderTarget['credentials'] = {
  shape: 'USERNAME_PASSWORD',
  username: 'admin',
  password: 'a-real-password',
};

const probe = async (target?: Partial<ProviderTarget>) =>
  new MarzbanAdapter().probe(
    { baseUrl: base, credentials: CREDENTIALS, ...target },
    target?.baseUrl === undefined
      ? http()
      : new SafeHttpClient({
          allowLoopback: true,
          totalTimeoutMs: 2_000,
          maxResponseBytes: 64 * 1024,
          maxRetries: 0,
        }).forBase(target.baseUrl),
  );

describe('the Marzban adapter — authentication', () => {
  it('authenticates and reports the panel version', async () => {
    behaviour = 'healthy';
    const outcome = await probe();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.degraded).toBe(false);
    expect(outcome.providerVersion).toBe('0.8.4');
  });

  it('sends the credentials as a form grant, and only to the token endpoint', async () => {
    behaviour = 'healthy';
    loginBodies = [];
    await probe();
    expect(loginBodies).toHaveLength(1);
    expect(loginBodies[0]).toContain('username=admin');
    expect(loginBodies[0]).toContain('grant_type=password');
  });

  it('normalizes a rejected password as an authentication failure', async () => {
    // The one failure an operator can fix directly, and the one that must
    // never be retried on a schedule.
    for (const bad of ['bad-credentials', 'forbidden'] as const) {
      behaviour = bad;
      const outcome = await probe();
      expect(outcome.ok, bad).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure).toBe('AUTHENTICATION_FAILED');
    }
  });

  it('distinguishes the panel being broken from the credentials being wrong', async () => {
    behaviour = 'server-error';
    const outcome = await probe();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('PROVIDER_ERROR');
    expect(outcome.status).toBe(500);
  });

  it('refuses a 200 that carries no token', async () => {
    // Reporting this as healthy would mean a panel nothing can actually call
    // showing up green on an operator's screen.
    behaviour = 'token-missing';
    const outcome = await probe();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
  });

  it('handles a reverse proxy answering with a login page', async () => {
    // The commonest real misconfiguration: something in front of Marzban
    // serves HTML with a 200. It parses to nothing and becomes a malformed
    // response, rather than a JSON syntax error quoting somebody's login form.
    behaviour = 'html-login-page';
    const outcome = await probe();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('MALFORMED_RESPONSE');
  });
});

describe('the Marzban adapter — degraded', () => {
  it('reports DEGRADED when the credentials work and the follow-up does not', async () => {
    // This is what makes DEGRADED a real state rather than a hedge: the panel
    // is up and the configuration is right, and something else is wrong. An
    // operator sent to replace a password that just worked would be wasting
    // their time on the wrong problem.
    for (const bad of ['system-unauthorized', 'system-garbage'] as const) {
      behaviour = bad;
      const outcome = await probe();
      expect(outcome.ok, bad).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.degraded).toBe(true);
      expect(outcome.providerVersion).toBeNull();
    }
  });

  it('never reports an authentication failure after authentication succeeded', async () => {
    // The fake returns 401 from /api/system here. Mapping that to
    // AUTHENTICATION_FAILED would be technically accurate about the response
    // and completely wrong about the panel.
    behaviour = 'system-unauthorized';
    const outcome = await probe();
    expect(outcome.ok).toBe(true);
  });
});

describe('the Marzban adapter — what it refuses to carry', () => {
  it('drops a version string that is too long or not version-shaped', async () => {
    // Persisted and shown to an operator, so it is bounded and
    // character-restricted rather than taken as given. A remote end that can
    // choose what lands in a database column will eventually choose badly.
    behaviour = 'hostile-version';
    const outcome = await probe();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.providerVersion).toBeNull();
  });

  it('reports an unreachable panel without attempting a login', async () => {
    behaviour = 'healthy';
    loginBodies = [];
    const outcome = await probe({ baseUrl: 'http://127.0.0.1:9' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('UNREACHABLE');
    expect(loginBodies).toHaveLength(0);
  });

  it('refuses a credential shape it cannot use rather than guessing', async () => {
    // Sending an empty password to find out would be one more failed login on
    // the operator's own panel, and some of them lock an account for that.
    behaviour = 'healthy';
    loginBodies = [];
    const outcome = await new MarzbanAdapter().probe(
      { baseUrl: base, credentials: { shape: 'NONE' } },
      http(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe('UNSUPPORTED_CAPABILITY');
    expect(loginBodies).toHaveLength(0);
  });
});

describe('the adapter registry', () => {
  it('builds an adapter for a type it implements', () => {
    expect(providerAdapter('marzban')).toBeInstanceOf(MarzbanAdapter);
  });

  it('refuses a type it knows but has not implemented, naming which', () => {
    // `sanaei` is in the contract and lands in 3B. What must never happen is
    // a panel of that type being silently operated by a DIFFERENT adapter.
    expect(() => providerAdapter('sanaei')).toThrow(/does not yet implement/);
  });

  it('refuses a type it does not know at all', () => {
    // Reachable from a migration, a direct database write, or a downgrade to a
    // release that knows fewer providers. A default adapter here would be
    // operating somebody's production panel with the wrong protocol.
    for (const unknown of ['hiddify', 'MARZBAN', '', 'marzban; drop table panels']) {
      expect(() => providerAdapter(unknown), unknown).toThrow();
    }
  });

  it('never puts a credential or a URL in its refusal', () => {
    try {
      providerAdapter('sanaei');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toMatch(/password|token|https?:\/\//i);
    }
  });
});
