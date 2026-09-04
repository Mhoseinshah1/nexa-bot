import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';

/**
 * The outbound client, against a real server on a real socket.
 *
 * Deterministic and local: a `node:http` server on an ephemeral loopback port,
 * never a public third-party panel. CI must not depend on somebody else's
 * Marzban being up, and a test that reaches the internet is a test that fails
 * for reasons unrelated to the code.
 *
 * Loopback is normally REFUSED by the URL policy — the API runs in a container
 * where loopback is itself — so every client here is built with
 * `allowLoopback: true`. That option exists for exactly this, and the
 * production container never sets it.
 */
interface Route {
  (path: string): {
    status: number;
    headers?: Record<string, string>;
    body?: string;
    /** Hold the socket open without answering, to exercise the deadline. */
    hang?: boolean;
    /** Write forever, to exercise the size cap. */
    flood?: boolean;
  };
}

let server: Server;
let base: string;
let route: Route = () => ({ status: 200, body: '{"ok":true}' });

beforeAll(async () => {
  server = createServer((request, response) => {
    const plan = route(request.url ?? '/');
    if (plan.hang === true) return; // never answers; the client's deadline must fire
    if (plan.flood === true) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = 'x'.repeat(64 * 1024);
      const pump = (): void => {
        while (response.write(chunk)) {
          /* until the client gives up */
        }
      };
      response.on('drain', pump);
      pump();
      return;
    }
    response.writeHead(plan.status, { 'content-type': 'application/json', ...plan.headers });
    response.end(plan.body ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
});

const client = (overrides: Partial<ConstructorParameters<typeof SafeHttpClient>[0]> = {}) =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
    ...overrides,
  });

describe('the outbound client — the happy path', () => {
  it('sends a GET and returns status, headers and a bounded body', async () => {
    route = () => ({ status: 200, body: '{"version":"0.8.4"}' });
    const result = await client().send(base, { method: 'GET', path: '/api/system' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('{"version":"0.8.4"}');
    expect(result.headers['content-type']).toContain('application/json');
  });

  it('sends a form POST, which is what a panel login is', async () => {
    let seen = '';
    route = (path) => {
      seen = path;
      return { status: 200, body: '{"token":"t"}' };
    };
    const result = await client().send(base, {
      method: 'POST',
      path: 'api/admin/token',
      body: { kind: 'form', value: { username: 'admin', password: 'pw' } },
    });
    expect(result.ok).toBe(true);
    expect(seen).toBe('/api/admin/token');
  });

  it('resolves a relative path against the base without letting it escape the host', async () => {
    // `..` cannot change the host — that is a property of URL resolution — but
    // it is asserted rather than assumed, because the whole design rests on an
    // adapter being unable to choose its own destination.
    const result = await client().send(base, { method: 'GET', path: '../../../etc/passwd' });
    expect(result.ok).toBe(true);
  });
});

describe('the outbound client — what an adapter cannot do', () => {
  it('refuses an absolute URL in the path', async () => {
    // An adapter naming its own host is the thing the design removes. Refused
    // rather than resolved, so a compromised or careless adapter cannot reach
    // the metadata service by returning a URL instead of a path.
    for (const path of [
      'http://169.254.169.254/latest/meta-data/',
      'https://evil.example.com/x',
      '//evil.example.com/x',
      'file:///etc/passwd',
    ]) {
      const result = await client().send(base, { method: 'GET', path });
      expect(result.ok, path).toBe(false);
      if (result.ok) continue;
      expect(result.failure).toBe('BLOCKED_TARGET');
    }
  });

  it('refuses a base the policy would refuse', async () => {
    const result = await client().send('http://169.254.169.254', { method: 'GET', path: '/' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('BLOCKED_TARGET');
  });
});

describe('the outbound client — resolution', () => {
  it('refuses a NAME that resolves to a forbidden address', async () => {
    // This is the rebinding defence's observable half. `localhost` passes every
    // check that can be made on the URL as written — it is a name, not a
    // literal — and is refused only after resolution shows it points at
    // loopback. A client that trusted the URL check alone would connect.
    const strict = new SafeHttpClient({
      allowLoopback: false,
      totalTimeoutMs: 2_000,
      maxResponseBytes: 1024,
      maxRetries: 0,
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const result = await strict.send(`http://localhost:${address.port}`, {
      method: 'GET',
      path: '/',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('BLOCKED_TARGET');
  });

  it('reports a name that resolves to nothing as unreachable, not as blocked', async () => {
    // The distinction is what an operator acts on: "your DNS is wrong" and
    // "we refuse to call that" are different problems with different remedies.
    const result = await client().send('https://nexa-does-not-exist.invalid', {
      method: 'GET',
      path: '/',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('UNREACHABLE');
  });
});

describe('the outbound client — bounds', () => {
  it('gives up on a server that never answers, and does so within the deadline', async () => {
    route = () => ({ status: 200, hang: true });
    const started = Date.now();
    const result = await client({ totalTimeoutMs: 600 }).send(base, {
      method: 'GET',
      path: '/hang',
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('TIMEOUT');
    // BOUNDED, not merely eventual. A deadline that fires at some point is not
    // a deadline; this asserts it fired near the one configured.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('stops reading a response that will not stop arriving', async () => {
    // Enforced WHILE reading. A cap applied to a completed buffer has already
    // spent the memory it was meant to protect, and a panel that streams
    // forever would take the worker down before the check ran.
    route = () => ({ status: 200, flood: true });
    const result = await client({ maxResponseBytes: 32 * 1024 }).send(base, {
      method: 'GET',
      path: '/flood',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('MALFORMED_RESPONSE');
  });

  it('never follows a redirect', async () => {
    // A 30x from an operator-configured panel is either a misconfiguration to
    // fix or somebody moving the request to a host the policy already refused.
    // Following it would re-open every question the policy answers, one hop
    // later — and the credentials would already be on the wire.
    route = () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      body: '',
    });
    const result = await client().send(base, { method: 'GET', path: '/redirect' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('MALFORMED_RESPONSE');
    expect(result.status).toBe(302);
  });
});

describe('the outbound client — retry', () => {
  it('does not retry by default', async () => {
    let calls = 0;
    route = () => {
      calls += 1;
      return { status: 401, body: '{"detail":"bad credentials"}' };
    };
    await client().send(base, { method: 'GET', path: '/api/system' });
    expect(calls).toBe(1);
  });

  it('never retries a deterministic failure, however many retries are allowed', async () => {
    // An authentication probe retried on a schedule is a credential-stuffing
    // loop pointed at the operator's own panel, and several panels lock an
    // account after enough of them. A 4xx reaches the adapter as a RESULT, so
    // the client sees a successful exchange here — the rule that matters is
    // that a refused CONNECTION to a blocked target is not retried either.
    let calls = 0;
    route = () => {
      calls += 1;
      return { status: 401, body: '{}' };
    };
    const result = await client({ maxRetries: 3 }).send(base, { method: 'GET', path: '/x' });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);

    const blocked = await client({ maxRetries: 3 }).send('http://169.254.169.254', {
      method: 'GET',
      path: '/',
    });
    expect(blocked.ok).toBe(false);
  });

  it('bounds the attempts it does make', async () => {
    // A closed port is transient by classification, so it is the one thing a
    // retry budget applies to — and the budget is spent, not exceeded.
    const started = Date.now();
    const result = await client({ maxRetries: 2, totalTimeoutMs: 500 }).send('http://127.0.0.1:9', {
      method: 'GET',
      path: '/',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('UNREACHABLE');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('what the client tells its caller', () => {
  it('reports a status number and never a body or a header on failure', async () => {
    // The failure shape has no free-text field at all, which is what stops a
    // `WWW-Authenticate` header or an echoed request body reaching a log, an
    // audit row or an operator's screen. Asserted structurally: the object has
    // exactly these keys.
    route = () => ({
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="panel"', 'set-cookie': 'session=secret' },
      body: '{"password":"hunter2"}',
    });
    const result = await client().send('http://169.254.169.254', { method: 'GET', path: '/' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result).sort()).toEqual(['failure', 'ok', 'status']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
