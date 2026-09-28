import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderServiceTarget, ProviderUserRef } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';

/**
 * Package E — `RickpanelAdapter.fetchSubscriptionFiles`, straight against a socket.
 *
 * The integration suite drives the files through `SubscriptionFileService`, which answers
 * a 404 and a malformed body with the same customer sentence, so it cannot tell whether
 * the adapter said "not found" or "broken". These tests read the adapter's own outcome.
 * They agree with the document's prose (`docs/package-e-rickpanel-files-audit.md` §1),
 * not with a real RickPanel: that is §8's gap.
 */

let server: Server;
let base: string;
let filesStatus = 200;
let filesBody: string = '[]';
let filesHeaders: Record<string, string> = {};
let tokenStatus = 200;
let requests: { method: string; path: string; auth: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    request.resume();
    request.on('end', () => {
      requests.push({
        method: request.method ?? 'GET',
        path: url,
        auth: String(request.headers['authorization'] ?? ''),
      });
      if (url === '/api/admin/token') {
        response.writeHead(tokenStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'a-real-jwt', token_type: 'bearer' }));
        return;
      }
      if (/^\/api\/user\/[^/]+\/files$/.test(url) && request.method === 'GET') {
        response.writeHead(filesStatus, { 'content-type': 'application/json', ...filesHeaders });
        response.end(filesBody);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'not found' }));
    });
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

beforeEach(() => {
  filesStatus = 200;
  filesBody = '[]';
  filesHeaders = {};
  tokenStatus = 200;
  requests = [];
});

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
    maxRetries: 0,
  }).forBase(base);

const target = (): ProviderServiceTarget => ({
  baseUrl: base,
  credentials: { shape: 'USERNAME_PASSWORD', username: 'admin', password: 'a-real-password' },
  activation: {},
});

const REF: ProviderUserRef = {
  username: 'nx user/1',
  subscriptionRef: 'sub-ref-not-sent-to-rickpanel',
  clientId: '019250ab-cdef-7012-8345-6789abcdef01',
};

const fetchFiles = () =>
  new RickpanelAdapter({
    readBackDelayMs: 0,
    sleep: () => Promise.resolve(),
  }).fetchSubscriptionFiles(target(), http(), REF);

describe('RickPanel subscription files, at the adapter', () => {
  it('asks the all-files route for the ENCODED username, with the bearer it was issued', async () => {
    filesBody = JSON.stringify([
      { filename: 'a.txt', media_type: 'text/plain', content_b64: 'aGVsbG8=', caption: 'c' },
    ]);
    const outcome = await fetchFiles();

    expect(outcome).toMatchObject({ ok: true, found: true, failed: 0 });
    const files = requests.filter((r) => r.path.endsWith('/files'));
    expect(files).toEqual([
      { method: 'GET', path: '/api/user/nx%20user%2F1/files', auth: 'Bearer a-real-jwt' },
    ]);
  });

  it('answers a 404 as found:false — a user the panel does not hold, not a fault', async () => {
    filesStatus = 404;
    filesBody = JSON.stringify({ detail: 'User not found' });

    expect(await fetchFiles()).toEqual({ ok: true, found: false });
  });

  it('carries a 429 Retry-After in delta-seconds as milliseconds', async () => {
    filesStatus = 429;
    filesHeaders = { 'retry-after': '37' };
    filesBody = JSON.stringify({ detail: 'slow down' });

    expect(await fetchFiles()).toEqual({
      ok: false,
      failure: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 37_000,
    });
  });

  it('falls back to the documented minute when a 429 says nothing it can read', async () => {
    filesStatus = 429;
    filesHeaders = { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' };

    expect(await fetchFiles()).toMatchObject({ failure: 'RATE_LIMITED', retryAfterMs: 60_000 });
  });

  it('refuses a 200 in no shape it knows as MALFORMED_RESPONSE, never as an empty list', async () => {
    filesBody = JSON.stringify({ items: [] });

    expect(await fetchFiles()).toEqual({ ok: false, failure: 'MALFORMED_RESPONSE', status: 200 });
  });

  it('keeps a 5xx a provider failure, not a missing user', async () => {
    filesStatus = 500;
    filesBody = JSON.stringify({ detail: 'boom' });

    const outcome = await fetchFiles();
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toHaveProperty('found');
    expect(outcome).not.toHaveProperty('retryAfterMs');
  });

  it('never asks for files with a credential the panel refused', async () => {
    tokenStatus = 401;

    expect(await fetchFiles()).toMatchObject({ ok: false, failure: 'AUTHENTICATION_FAILED' });
    expect(requests.some((r) => r.path.endsWith('/files'))).toBe(false);
  });
});
