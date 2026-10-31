import { describe, expect, it } from 'vitest';
import Fastify from '../../apps/api/node_modules/fastify';
import { API_PREFIX, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import {
  ANONYMOUS_RATE_LIMIT_WINDOW_MS,
  AnonymousRateLimiter,
  MAX_TRACKED_ADDRESSES,
  installAnonymousRateLimit,
} from '../../apps/api/src/surfaces/web/anonymous-rate-limit';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * R12 F2 item 2, second half: one client address cannot turn an anonymous route into the
 * process's whole workload. Driven through a real Fastify instance, because the property is
 * the hook's: it runs before any handler, on the right paths, keyed by `request.ip`.
 */
describe('the anonymous per-address rate limit', () => {
  function app(limit: number) {
    let now = 1_000_000;
    const fastify = Fastify();
    let handled = 0;
    installAnonymousRateLimit(
      fastify,
      new AnonymousRateLimiter({ limitPerWindow: limit, now: () => now }),
    );
    for (const url of ['/health/ready', '/payments/return/x/y', `${API_PREFIX}/auth/login`]) {
      fastify.all(url, async () => {
        handled += 1;
        return { ok: true };
      });
    }
    fastify.post('/telegram/webhook/:id', async () => ({ ok: true }));
    fastify.get(`${API_PREFIX}/orders`, async () => ({ ok: true }));
    return {
      fastify,
      handled: () => handled,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const from = (remoteAddress: string, url = '/health/ready', method = 'GET') => ({
    method,
    url,
    remoteAddress,
  });

  it('refuses the request over the budget with 429, before the handler runs', async () => {
    const a = app(3);
    for (let i = 0; i < 3; i += 1) {
      expect((await a.fastify.inject(from('203.0.113.7') as never)).statusCode).toBe(200);
    }
    const refused = await a.fastify.inject(from('203.0.113.7') as never);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      PLATFORM_ERROR_CODES.REQUEST_RATE_LIMITED,
    );
    expect(a.handled()).toBe(3);
    // Another address has its own budget.
    expect((await a.fastify.inject(from('198.51.100.9') as never)).statusCode).toBe(200);
    // And the window ends.
    a.advance(ANONYMOUS_RATE_LIMIT_WINDOW_MS);
    expect((await a.fastify.inject(from('203.0.113.7') as never)).statusCode).toBe(200);
  });

  it('counts the payment return and sign-in, and leaves the webhook and the admin alone', async () => {
    const a = app(1);
    const ip = '203.0.113.8';
    await a.fastify.inject(from(ip, '/payments/return/x/y') as never);
    expect(
      (await a.fastify.inject(from(ip, `${API_PREFIX}/auth/login`, 'POST') as never)).statusCode,
    ).toBe(429);
    // Telegram delivers every update from a few addresses: never limited here.
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await a.fastify.inject(from(ip, '/telegram/webhook/abc', 'POST') as never)).statusCode,
      ).toBe(200);
      expect((await a.fastify.inject(from(ip, `${API_PREFIX}/orders`) as never)).statusCode).toBe(
        200,
      );
    }
  });

  it('never limits loopback: the container health check calls /health/ready there', async () => {
    const a = app(1);
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      for (let i = 0; i < 5; i += 1) {
        expect((await a.fastify.inject(from(ip) as never)).statusCode).toBe(200);
      }
    }
  });

  it('is off at zero, and defaults to 120 a minute', async () => {
    const a = app(0);
    for (let i = 0; i < 20; i += 1) {
      expect((await a.fastify.inject(from('203.0.113.9') as never)).statusCode).toBe(200);
    }
    expect(configSchema.shape.ANONYMOUS_RATE_LIMIT_PER_MINUTE.parse(undefined)).toBe(120);
  });

  it('keeps its table bounded whatever the number of addresses', () => {
    let now = 0;
    const limiter = new AnonymousRateLimiter({ limitPerWindow: 5, now: () => now });
    for (let i = 0; i < MAX_TRACKED_ADDRESSES + 500; i += 1) {
      limiter.admit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    }
    expect(limiter.tracked).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
    now += ANONYMOUS_RATE_LIMIT_WINDOW_MS;
    limiter.admit('192.0.2.1');
    expect(limiter.tracked).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
  });
});
