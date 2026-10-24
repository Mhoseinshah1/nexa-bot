import Fastify from '../../apps/api/node_modules/fastify';
import { describe, expect, it } from 'vitest';
import { installRawBodyCapture, rawBodyOf } from '../../apps/api/src/surfaces/gateway/raw-body';

/**
 * The webhook route keeps the RAW bytes beside the parsed body (documentation §7: the HMAC is
 * over the raw body). A real Fastify instance, because the hook's contract is Fastify's.
 */
async function app(limit = 64) {
  const fastify = Fastify({ bodyLimit: 1024 });
  installRawBodyCapture(fastify, '/payments/webhook', limit);
  const seen: { parsed: unknown; raw: string | null }[] = [];
  fastify.post('/payments/webhook/:provider', (request) => {
    seen.push({ parsed: request.body, raw: rawBodyOf(request)?.toString('utf8') ?? null });
    return { ok: true };
  });
  fastify.post('/other', (request) => {
    seen.push({ parsed: request.body, raw: rawBodyOf(request)?.toString('utf8') ?? null });
    return { ok: true };
  });
  await fastify.ready();
  return { fastify, seen };
}

describe('the gateway webhook raw body', () => {
  it('keeps the exact bytes, whitespace and key order included, and still parses the JSON', async () => {
    const { fastify, seen } = await app();
    const raw = '{\n  "token" : "abc",\n"status":"paid"  }';
    const response = await fastify.inject({
      method: 'POST',
      url: '/payments/webhook/tetrapay',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    expect(seen[0]).toEqual({ parsed: { token: 'abc', status: 'paid' }, raw });
  });

  it('keeps nothing for any other route', async () => {
    const { fastify, seen } = await app();
    await fastify.inject({
      method: 'POST',
      url: '/other',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(seen[0]).toEqual({ parsed: { a: 1 }, raw: null });
  });

  it('refuses a body over the limit without handing it to the handler', async () => {
    const { fastify, seen } = await app(32);
    const response = await fastify.inject({
      method: 'POST',
      url: '/payments/webhook/tetrapay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(200) }),
    });
    expect(response.statusCode).toBe(413);
    expect(seen).toHaveLength(0);
  });
});
