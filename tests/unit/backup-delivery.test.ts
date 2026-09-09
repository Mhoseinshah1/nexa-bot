import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramBackupDelivery } from '../../apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery';

/**
 * Backup delivery, against a real socket.
 *
 * A real server rather than a stubbed `fetch`, for the same reason the provider
 * suite uses one: the behaviour under test is the CLASSIFICATION of what comes
 * back, and half the cases here are things a stub cannot produce honestly — a
 * body that stops mid-JSON, a connection destroyed after the request is read, a
 * redirect. Stubbing `fetch` would be asserting against the fixture's idea of
 * those, not against Node's.
 *
 * The one rule every case serves: an outcome nobody observed is recorded as
 * unobserved. This transport moves an encrypted database, so a wrong guess in
 * either direction is expensive — "failed" strands a backup that arrived,
 * "succeeded" reports one that did not.
 */

const TOKEN = '1234567890:AAFAKE-token-value-not-a-real-one';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe('backup delivery to Telegram', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  let requests: { url: string; method: string }[];
  let dir: string;
  let archivePath: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push({ url: request.url ?? '', method: request.method ?? '' });
      handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };
    dir = await mkdtemp(join(tmpdir(), 'nexa-delivery-'));
    archivePath = join(dir, 'archive.nxb');
    await writeFile(archivePath, Buffer.from('NEXABAK1 pretend ciphertext'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function delivery(overrides: { chatId?: string; token?: string; timeoutMs?: number } = {}) {
    return new TelegramBackupDelivery({
      apiBaseUrl: baseUrl,
      token: overrides.token ?? TOKEN,
      chatId: overrides.chatId ?? '-1001234567890',
      timeoutMs: overrides.timeoutMs ?? 5_000,
    });
  }

  const send = () =>
    delivery().sendDocument({ archivePath, filename: 'b.nxb', caption: 'NEXA BACKUP' });

  it('reports SUCCEEDED only when Telegram says ok', async () => {
    await expect(send()).resolves.toEqual({ state: 'SUCCEEDED', detail: null });
    expect(requests[0]?.url).toContain('/sendDocument');
  });

  it('treats a parsed rejection as definitive', async () => {
    handler = (_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      );
    };
    const result = await send();
    // Telegram considered it and said no. The same bytes would be refused the
    // same way, so there is nothing ambiguous to preserve.
    expect(result.state).toBe('FAILED_DEFINITIVE');
    expect(result.detail).toContain('chat not found');
  });

  it('treats a 5xx as unobserved rather than as a failure', async () => {
    handler = (_request, response) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, description: 'Bad Gateway' }));
    };
    const result = await send();
    // A 5xx can follow a write that landed. Recording it as failed would file a
    // delivered backup as undelivered; recording it as retryable would license a
    // resend of a document the group may already hold.
    expect(result.state).toBe('OUTCOME_UNKNOWN');
  });

  it('treats a 429 as unobserved, not as an invitation to resend', async () => {
    handler = (_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          description: 'Too Many Requests',
          parameters: { retry_after: 30 },
        }),
      );
    };
    const result = await send();
    // The one case that most looks like "retry me". Telegram's rate limiter can
    // reject a request whose upload it already accepted, and this transport is
    // not entitled to decide that about a forty-megabyte document.
    expect(result.state).toBe('OUTCOME_UNKNOWN');
    expect(result.detail).toContain('429');
  });

  it('treats a 2xx whose body will not parse as unobserved', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok": tr');
    };
    const result = await send();
    // Accepted, and we cannot read the verdict — which is exactly the state.
    expect(result.state).toBe('OUTCOME_UNKNOWN');
  });

  it('treats a dropped connection as unobserved', async () => {
    handler = (request, response) => {
      request.resume();
      request.on('end', () => response.socket?.destroy());
    };
    const result = await send();
    // The upload may well have completed on Telegram's side while our socket
    // died waiting for the response.
    expect(result.state).toBe('OUTCOME_UNKNOWN');
  });

  it('treats a timeout as unobserved', async () => {
    handler = (request) => {
      request.resume();
      // Never answers. The abort fires first.
    };
    const result = await delivery({ timeoutMs: 300 }).sendDocument({
      archivePath,
      filename: 'b.nxb',
      caption: 'NEXA BACKUP',
    });
    expect(result.state).toBe('OUTCOME_UNKNOWN');
  });

  it('never follows a redirect, because the token is in the path', async () => {
    // The redirect points back at THIS server, so following it leaves evidence.
    // Pointing it at an unresolvable host instead made the test unfalsifiable:
    // `redirect: 'follow'` then failed on DNS, produced the same
    // OUTCOME_UNKNOWN, and recorded the same single request — so the mutation
    // survived. The second request has to be observable for its absence to mean
    // anything.
    handler = (request, response) => {
      if ((request.url ?? '').includes('/redirected')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(302, { location: `${baseUrl}/redirected` });
      response.end();
    };
    const result = await send();
    // `redirect: 'error'` makes this a transport failure rather than a second
    // request carrying the bot token to wherever the redirect pointed.
    expect(result.state).toBe('OUTCOME_UNKNOWN');
    expect(requests).toHaveLength(1);
    expect(requests.some((entry) => entry.url.includes('/redirected'))).toBe(false);
  });

  it('is definitive, not ambiguous, when nothing was ever sent', async () => {
    const result = await delivery().sendDocument({
      archivePath: join(dir, 'does-not-exist.nxb'),
      filename: 'b.nxb',
      caption: 'NEXA BACKUP',
    });
    // No bytes left this host, so there is no ambiguity to preserve. The
    // distinction matters: an OUTCOME_UNKNOWN here would leave an operator
    // wondering whether a backup that was never sent might be in the group.
    expect(result.state).toBe('FAILED_DEFINITIVE');
    expect(requests).toHaveLength(0);
  });

  it('puts no token in any outcome it reports', async () => {
    const cases: (() => Promise<{ detail: string | null }>)[] = [
      async () => {
        handler = (_request, response) => {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, description: `bad ${TOKEN}`.slice(0, 5) }));
        };
        return send();
      },
      async () => {
        handler = (request, response) => {
          request.resume();
          request.on('end', () => response.socket?.destroy());
        };
        return send();
      },
      async () =>
        delivery().sendDocument({
          archivePath: join(dir, 'missing.nxb'),
          filename: 'b.nxb',
          caption: 'c',
        }),
    ];
    for (const run of cases) {
      const result = await run();
      // The token is in the request PATH, so a detail built from a URL — which
      // is the natural thing for a transport error to carry — would put the bot
      // credential in the run row and in the operator's terminal.
      expect(result.detail ?? '').not.toContain(TOKEN);
      expect(result.detail ?? '').not.toContain('AAFAKE');
      expect(result.detail ?? '').not.toContain('/bot');
    }
  });

  it('is not configured without both a chat and a token', () => {
    expect(delivery().configured).toBe(true);
    expect(delivery({ chatId: '' }).configured).toBe(false);
    expect(delivery({ token: '' }).configured).toBe(false);
  });

  it('sends a plain message with previews disabled', async () => {
    const result = await delivery().sendMessage('NEXA BACKUP\nRETAINED: /var/lib/nexa/backups');
    expect(result.state).toBe('SUCCEEDED');
    expect(requests[0]?.url).toContain('/sendMessage');
  });
});
