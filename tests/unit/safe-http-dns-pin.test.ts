import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';

/**
 * The DNS pin, over a real TLS socket.
 *
 * The rest of the SSRF suite proves the DECISION — which addresses the policy
 * allows, which URLs it refuses. This file proves the thing that decision is
 * worth nothing without: that the socket actually goes to the address that was
 * approved, and not to whatever a second resolution would return.
 *
 * That distinction was previously untested and was known to be: deleting the
 * pinned `lookup` outright left every test in `safe-http.test.ts` green,
 * because the nearest one refuses `localhost` at the address check, before a
 * socket exists. A check that runs before the socket says nothing about where
 * the socket then goes.
 *
 * The setup is built to make exactly that difference observable:
 *
 *   A — 127.0.0.2, returned by the client's own resolver, approved by the
 *       policy, and therefore the address the pin must dial. Answers "A".
 *   B — 127.0.0.1, which is what the SYSTEM resolver returns for `localhost`,
 *       and therefore where a second resolution would land. Answers "B".
 *
 * Both listen on the same port, on different loopback addresses, and both
 * present the same certificate — issued by a CA generated here and trusted
 * only through the client's `caCertificates` option. So TLS succeeds against
 * either one, and the body is the only thing that differs. The test asserts
 * the body is "A".
 *
 * Nothing here is mocked: a real `SafeHttpClient`, a real TLS handshake with
 * verification ON, a real socket. Remove the pin and the request still
 * succeeds — against B — so the assertion fails on the destination rather than
 * on an error, which is the failure mode that matters.
 */

const PUBLIC_TLS_ORIGIN = 'https://registry.npmjs.org';

/** Whether this sandbox can reach a publicly trusted TLS endpoint at all. */
async function publicTlsReachable(): Promise<boolean> {
  const plain = new SafeHttpClient({
    allowLoopback: false,
    totalTimeoutMs: 15_000,
    maxResponseBytes: 8192,
    maxRetries: 0,
  });
  const probe = await plain.send(PUBLIC_TLS_ORIGIN, { method: 'GET', path: '/' });
  return probe.ok;
}

const HOSTNAME = 'localhost';
const APPROVED = '127.0.0.2';
const SECOND_RESOLUTION = '127.0.0.1';

let dir: string;
let ca: string;
let serverA: Server;
let serverB: Server;
let port: number;

/** A CA and one leaf for `localhost`, generated fresh. No fixture to expire. */
function issueCertificates(): { ca: string; cert: string; key: string } {
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
    `/CN=${HOSTNAME}`,
    '-keyout',
    at('leaf.key'),
    '-out',
    at('leaf.csr'),
  ]);

  // The SAN covers the NAME only. The client keeps the hostname as the TLS
  // server name while pinning where the socket goes, so a certificate that
  // named the addresses instead would let a broken pin pass verification.
  writeFileSync(at('ext.cnf'), `subjectAltName=DNS:${HOSTNAME}\nextendedKeyUsage=serverAuth\n`);
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

  return {
    ca: readFileSync(at('ca.pem'), 'utf8'),
    cert: readFileSync(at('leaf.pem'), 'utf8'),
    key: readFileSync(at('leaf.key'), 'utf8'),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexa-pin-'));
  const issued = issueCertificates();
  ca = issued.ca;

  const make = (body: string) =>
    createServer({ cert: issued.cert, key: issued.key }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ served: body }));
    });

  serverA = make('A');
  serverB = make('B');

  // A first, on an ephemeral port; B then takes the SAME port on the other
  // loopback address, so one URL can reach either and only the address decides.
  serverA.listen(0, APPROVED);
  await once(serverA, 'listening');
  const address = serverA.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;

  serverB.listen(port, SECOND_RESOLUTION);
  await once(serverB, 'listening');
}, 60_000);

afterAll(() => {
  serverA?.closeAllConnections();
  serverB?.closeAllConnections();
  serverA?.close();
  serverB?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('the outbound client — the DNS pin', () => {
  /** Both servers are genuinely reachable, so the pin is what chooses. */
  it('has two live destinations, distinguishable by body', async () => {
    for (const [address, expected] of [
      [APPROVED, 'A'],
      [SECOND_RESOLUTION, 'B'],
    ] as const) {
      const direct = new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 5_000,
        maxResponseBytes: 4096,
        maxRetries: 0,
        caCertificates: [ca],
        // Addressed by NAME so TLS verifies, but resolved to the one under test.
        resolve: async () => [{ address, family: 4 }],
      });
      const result = await direct.send(`https://${HOSTNAME}:${port}`, {
        method: 'GET',
        path: '/',
      });
      expect(result.ok, `${address} was not reachable`).toBe(true);
      if (!result.ok) return;
      expect(JSON.parse(result.bodyText)).toEqual({ served: expected });
    }
  });

  it('connects to the address the policy approved, not to a second resolution', async () => {
    let resolutions = 0;
    const client = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 5_000,
      maxResponseBytes: 4096,
      maxRetries: 0,
      caCertificates: [ca],
      resolve: async (hostname) => {
        resolutions += 1;
        expect(hostname).toBe(HOSTNAME);
        return [{ address: APPROVED, family: 4 }];
      },
    });

    const result = await client.send(`https://${HOSTNAME}:${port}`, {
      method: 'GET',
      path: '/',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // THE assertion. `localhost` resolves to 127.0.0.1 through the system, so a
    // second resolution reaches B. Reading "A" back means the socket went to
    // the address that was checked and approved, and nothing re-resolved
    // between the decision and the connection.
    expect(
      JSON.parse(result.bodyText),
      'the socket reached the second-resolution address, not the approved one',
    ).toEqual({ served: 'A' });

    // Once. A second resolution is the window a rebinding attack needs.
    expect(resolutions).toBe(1);
  });

  it('verifies the certificate against the NAME, with no trust weakening', async () => {
    // The same request with the CA withheld must fail. If this passed, the test
    // above would prove nothing about TLS — and a client that reached A only
    // because verification was off would be worse than one with no pin.
    const untrusting = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 5_000,
      maxResponseBytes: 4096,
      maxRetries: 0,
      resolve: async () => [{ address: APPROVED, family: 4 }],
    });

    const result = await untrusting.send(`https://${HOSTNAME}:${port}`, {
      method: 'GET',
      path: '/',
    });
    expect(result.ok, 'an untrusted certificate was accepted').toBe(false);
  });

  it('keeps trusting the public roots when a private CA is configured', async () => {
    // C4. `ca` REPLACES Node's trust store rather than extending it, so passing
    // only the operator's PEM made every panel with an ordinary publicly
    // trusted certificate fail the moment `PANEL_HTTP_CA_FILE` was set. The
    // client now builds the list from the bundled roots plus the operator's.
    //
    // Proved against a REAL public endpoint, because that is the only thing
    // that can distinguish "extends" from "replaces": a local CA cannot stand
    // in for the Mozilla bundle. Skipped rather than failed when the sandbox
    // has no egress, so the suite stays honest about what it actually checked.
    const reachable = await publicTlsReachable();
    if (!reachable) {
      console.warn('no public TLS egress; C4 public-root assertion skipped');
      return;
    }

    const withPrivateCa = new SafeHttpClient({
      allowLoopback: false,
      totalTimeoutMs: 15_000,
      maxResponseBytes: 8192,
      maxRetries: 0,
      caCertificates: [ca],
    });

    const result = await withPrivateCa.send(PUBLIC_TLS_ORIGIN, { method: 'GET', path: '/' });
    expect(
      result.ok,
      'a publicly trusted endpoint stopped validating once a private CA was configured',
    ).toBe(true);
  });

  it('trusts a server signed by the configured private CA', async () => {
    // The other half of C4: adding the operator's roots must still work. The
    // pin test above already relies on this, but it is asserted here directly
    // so the pair reads as one guarantee rather than a side effect.
    const address = serverA.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const client = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 5_000,
      maxResponseBytes: 4096,
      maxRetries: 0,
      caCertificates: [ca],
      resolve: async () => [{ address: APPROVED, family: 4 }],
    });

    const result = await client.send(`https://${HOSTNAME}:${address.port}`, {
      method: 'GET',
      path: '/',
    });
    expect(result.ok, 'the configured private CA was not trusted').toBe(true);
  });

  it('bounds a stalled DNS resolver, which the deadline used to start after', async () => {
    // C6. The deadline was created inside the socket phase, so resolution ran
    // outside it: a resolver that never answered left the call open forever
    // while the docblock promised the timeout covered DNS.
    //
    // The resolver here never settles. Only a deadline that starts BEFORE
    // resolution can end this call.
    const started = Date.now();
    const client = new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 700,
      maxResponseBytes: 4096,
      maxRetries: 0,
      caCertificates: [ca],
      resolve: () => new Promise(() => {}),
    });

    const result = await client.send(`https://${HOSTNAME}:9`, { method: 'GET', path: '/' });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('TIMEOUT');
    // Bounded, and bounded by the configured budget rather than by luck.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('still refuses an address the policy rejects, even when resolution offers it', async () => {
    // The pin dials only approved addresses; it does not become a way to reach
    // one the policy refused. Loopback off makes both destinations forbidden.
    const strict = new SafeHttpClient({
      allowLoopback: false,
      totalTimeoutMs: 5_000,
      maxResponseBytes: 4096,
      maxRetries: 0,
      caCertificates: [ca],
      resolve: async () => [{ address: APPROVED, family: 4 }],
    });

    const result = await strict.send(`https://${HOSTNAME}:${port}`, {
      method: 'GET',
      path: '/',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('BLOCKED_TARGET');
  });
});
