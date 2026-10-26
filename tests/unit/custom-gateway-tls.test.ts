import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { CustomGatewayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/custom-gateway-adapter';
import { MockCustomBridge } from '../support/mock-custom-bridge';

/**
 * The custom gateway's adapter against the reference bridge over REAL TLS, through the very
 * `SafeHttpClient` the container builds for it: a CA and a leaf for `bridge.test` made here with
 * openssl (the DNS-pin suite's pattern), the name pinned to 127.0.0.1, certificates verified.
 * Proves the bytes Nexa signs are the bytes that cross the wire, that the path resolves under the
 * base URL's prefix, and that the bridge's response signature survives the trip.
 */

const HOSTNAME = 'bridge.test';
const SECRET = 'cgw_tls_SECRET_for_this_suite_only_51b2e07d';
let dir: string;
let ca: string;
let server: Server;
let port: number;
const bridge = new MockCustomBridge({ secret: SECRET, now: () => new Date(), basePath: '/nexa' });

function issue(): { ca: string; cert: string; key: string } {
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
    '/CN=Nexa Bridge Test CA',
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
  dir = mkdtempSync(join(tmpdir(), 'nexa-cgw-'));
  const issued = issue();
  ca = issued.ca;
  ({ server, port } = await bridge.listen({ cert: issued.cert, key: issued.key }));
}, 60_000);

afterAll(() => {
  server?.closeAllConnections();
  server?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function adapter(trusted: boolean) {
  const client = new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 5_000,
    maxResponseBytes: 64 * 1024,
    maxRetries: 0,
    ...(trusted ? { caCertificates: [ca] } : {}),
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  return new CustomGatewayAdapter({ http: client });
}

describe('the custom gateway over TLS', () => {
  it('creates, reads PAID and pings across a real TLS connection, signatures intact both ways', async () => {
    const base = `https://${HOSTNAME}:${String(port)}/nexa`;
    const custom = adapter(true);
    const orderId = custom.newOrderId();
    const created = await custom.createInvoice(SECRET, {
      orderId,
      amount: 1_250_000n,
      callbackUrl: null,
      buyerChatId: null,
      presentation: null,
      providerUserId: '4829103375',
      endpoint: base,
      expiresAt: new Date(Date.now() + 70 * 60_000),
    });
    expect(created).toMatchObject({ kind: 'CREATED', orderId });
    if (created.kind !== 'CREATED') return;
    bridge.set(orderId, 'PAID', 1_250_000n);
    expect(
      await custom.inquire(SECRET, created.invoiceId, {
        providerOrderId: orderId,
        sentAmount: 1_250_000n,
        hintedPaymentId: null,
        endpoint: base,
      }),
    ).toMatchObject({ kind: 'OBSERVED', verdict: 'APPROVED' });
    expect(await custom.checkCredential(SECRET, { endpoint: base })).toEqual({ kind: 'OK' });
    expect(bridge.received.every((one) => one.verdict === 'ok')).toBe(true);
  });

  it('a certificate it cannot verify is a refusal before anything is sent; the test fails', async () => {
    const base = `https://${HOSTNAME}:${String(port)}/nexa`;
    const custom = adapter(false);
    const before = bridge.received.length;
    expect(
      await custom.createInvoice(SECRET, {
        orderId: custom.newOrderId(),
        amount: 1_000n,
        callbackUrl: null,
        buyerChatId: null,
        presentation: null,
        providerUserId: '4829103375',
        endpoint: base,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ kind: 'REFUSED', configuration: true });
    expect((await custom.checkCredential(SECRET, { endpoint: base })).kind).toBe('UNAVAILABLE');
    expect(bridge.received.length).toBe(before);
  });
});
