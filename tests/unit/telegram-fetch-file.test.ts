import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENT_RECEIPT_MAX_BYTES } from '@nexa/contracts';
import {
  isSafeFilePath,
  telegramFetchFile,
} from '../../apps/api/src/infrastructure/telegram/fetch-file';

/**
 * Fetching a receipt's bytes, against a real socket.
 *
 * The bound is the point. `PAYMENT_RECEIPT_MAX_BYTES` is a promise about what this
 * process will ALLOCATE, and a check that runs after the whole body is buffered is not
 * that promise — a response that omits or understates its size would have already done
 * the damage by the time it was refused. Both cases below serve more than the cap and
 * both must come back UNAVAILABLE.
 */
describe('fetching a receipt file', () => {
  let telegram: Server;
  let base = '';
  /** How many bytes the server actually managed to write, per request. */
  let written: number[] = [];

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const url = request.url ?? '';
      if (url.includes('/getFile')) {
        /*
         * The id travels in the BODY, as production sends it, and the answered path
         * echoes it — so a case can steer the SECOND leg, which is the one under test,
         * while still going through the real first one.
         */
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const requested = (JSON.parse(body) as { file_id: string }).file_id;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { file_path: `photos/${requested}` } }));
        });
        return;
      }
      if (url.includes('oversize-declared')) {
        // A declared length past the cap. The body is never sent, because the refusal
        // happens on the header — which is the cheap half of the bound.
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(PAYMENT_RECEIPT_MAX_BYTES + 1_000),
        });
        response.end(Buffer.alloc(1_024));
        return;
      }
      if (url.includes('oversize-chunked')) {
        /*
         * No `content-length` at all, which is the case the header check cannot see:
         * chunked, and larger than the cap. Written in megabyte chunks and stopped as
         * soon as the socket goes away, so the test measures the fetch aborting rather
         * than the server finishing.
         */
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        let sent = 0;
        const chunk = Buffer.alloc(1_024 * 1_024);
        const pump = (): void => {
          while (sent < PAYMENT_RECEIPT_MAX_BYTES + 4 * 1_024 * 1_024) {
            if (response.writableEnded || response.destroyed) break;
            sent += chunk.byteLength;
            if (!response.write(chunk)) {
              response.once('drain', pump);
              return;
            }
          }
          written.push(sent);
          if (!response.writableEnded) response.end();
        };
        response.on('close', () => written.push(sent));
        pump();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(Buffer.from([1, 2, 3, 4, 5]));
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      telegram.close(() => resolve());
      /*
       * `close` stops accepting and then waits for every open socket, and two of them
       * outlive their request: `fetch` keeps its connection alive after a response, and
       * the aborted transfer below leaves one half-written. Destroying them is what
       * makes this teardown finish at all — CI timed the hook out at 10s where this
       * machine happened to win the race against undici's keep-alive expiry.
       */
      telegram.closeAllConnections();
    });
  });

  const fetchFile = (fileId: string) =>
    telegramFetchFile({
      token: 'test-token',
      apiBaseUrl: base,
      fileBaseUrl: base,
      timeoutMs: 20_000,
      fileId,
    });

  it('returns the bytes and the declared type for an ordinary file', async () => {
    const result = await fetchFile('ordinary');
    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') return;
    expect(Array.from(result.bytes)).toStrictEqual([1, 2, 3, 4, 5]);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('refuses a file whose declared length is past the cap', async () => {
    // The server is asked for the oversize path through `file_path`, so the getFile leg
    // is the same one production takes.
    const result = await fetchFile('oversize-declared');
    expect(result.outcome).toBe('UNAVAILABLE');
  });

  it('refuses a chunked body past the cap, and stops reading it', async () => {
    written = [];
    const result = await fetchFile('oversize-chunked');

    expect(result.outcome).toBe('UNAVAILABLE');
    /*
     * The ABORT is the property under test, not just the refusal: the server must have
     * stopped short of everything it was willing to send. Without a running bound the
     * fetch buffers the whole body, the server writes all of it, and this is the cap
     * plus four megabytes.
     */
    const most = Math.max(0, ...written);
    expect(most, 'the transfer should have been abandoned early').toBeLessThan(
      PAYMENT_RECEIPT_MAX_BYTES + 4 * 1_024 * 1_024,
    );
  });

  it('refuses a file path that could leave the file host', () => {
    for (const bad of ['/etc/passwd', '../secrets', 'a/../../b', 'http://evil.test/x', 'a\\b']) {
      expect(isSafeFilePath(bad), bad).toBe(false);
    }
    expect(isSafeFilePath('photos/file_42.jpg')).toBe(true);
  });
});
