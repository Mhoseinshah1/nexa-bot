import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX, AUTH_ROUTES, PLATFORM_ERROR_CODES, type ErrorResponse } from '@nexa/contracts';

/**
 * A per-client-address budget for the routes anyone can call without a session (R12 F2).
 *
 * The routes it covers answer strangers by design — the health probes, the customer's
 * browser coming back from a payment page, the sign-in form — and before this nothing
 * bounded how often one address could ask. `/health/ready` was the sharp case: every call
 * checked connections out of the pool that serves the operators and the bot. The verdict is
 * now shared and briefly reused (`ReadinessService.verdict`); this is the second half, so
 * no single address can turn a cheap anonymous route into the process's whole workload.
 *
 * In the APPLICATION rather than at Caddy because the stock Caddy image has no rate-limit
 * module, and a custom Caddy build is a supply-chain change of its own. The address is
 * `request.ip`, which honours `TRUSTED_PROXY_IPS` — so behind the edge it is the client's
 * address, never Caddy's — and loopback is never limited: the container's own health check
 * calls `/health/ready` on 127.0.0.1 every ten seconds and must not be refused by it.
 *
 * NOT covered, on purpose: the Telegram webhook (Telegram delivers every update from a few
 * addresses, and its secret header is checked before the body is parsed), the payment
 * gateway webhooks (a provider's few addresses; each only schedules an inquiry) and the
 * mini app (it has its own per-session budget in Redis). Every Web Admin route other than
 * sign-in requires a session.
 *
 * A fixed one-minute window per address, in memory: one API process serves an installation
 * (ADR-0001), and a counter that resets on restart only forgives a minute. The table is
 * bounded — at `MAX_TRACKED_ADDRESSES` the expired entries are dropped, and if every entry
 * is live the oldest go first — so a spray of spoofed-looking sources cannot grow it.
 */

export const ANONYMOUS_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_TRACKED_ADDRESSES = 10_000;

/** The anonymous routes the budget applies to, by path prefix. */
export const ANONYMOUS_RATE_LIMITED_PREFIXES: readonly string[] = [
  '/health/',
  '/payments/return/',
  `${API_PREFIX}${AUTH_ROUTES.login}`,
];

export interface AnonymousRateLimiterOptions {
  /** Requests one address may make per window. 0 turns the limiter off. */
  readonly limitPerWindow: number;
  readonly now: () => number;
}

export class AnonymousRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly options: AnonymousRateLimiterOptions) {}

  /** Whether this request may proceed, and if not, how many seconds until it may. */
  admit(
    address: string,
  ): { readonly allowed: true } | { readonly allowed: false; retryAfterSeconds: number } {
    if (this.options.limitPerWindow <= 0 || isLoopback(address)) return { allowed: true };
    const now = this.options.now();
    const current = this.windows.get(address);
    if (current === undefined || now - current.start >= ANONYMOUS_RATE_LIMIT_WINDOW_MS) {
      this.remember(address, now);
      return { allowed: true };
    }
    current.count += 1;
    if (current.count <= this.options.limitPerWindow) return { allowed: true };
    const retryAfterMs = current.start + ANONYMOUS_RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /** How many addresses are being counted; for the bound's test. */
  get tracked(): number {
    return this.windows.size;
  }

  private remember(address: string, now: number): void {
    this.windows.delete(address);
    if (this.windows.size >= MAX_TRACKED_ADDRESSES) {
      for (const [key, value] of this.windows) {
        if (now - value.start >= ANONYMOUS_RATE_LIMIT_WINDOW_MS) this.windows.delete(key);
      }
      // Every entry is live: drop the oldest (Map iteration is insertion order).
      while (this.windows.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = this.windows.keys().next();
        if (oldest.done === true) break;
        this.windows.delete(oldest.value);
      }
    }
    this.windows.set(address, { start: now, count: 1 });
  }
}

function isLoopback(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === '::1' || lower.startsWith('127.') || lower.startsWith('::ffff:127.');
}

function pathOf(request: FastifyRequest): string {
  const url = request.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Installs the limiter as an `onRequest` hook: it runs before the body is read and before
 * any handler, so a refused request costs a map lookup and nothing else.
 */
export function installAnonymousRateLimit(
  fastify: FastifyInstance,
  limiter: AnonymousRateLimiter,
): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    const path = pathOf(request);
    if (!ANONYMOUS_RATE_LIMITED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      done();
      return;
    }
    const verdict = limiter.admit(request.ip);
    if (verdict.allowed) {
      done();
      return;
    }
    const body: ErrorResponse = {
      error: {
        kind: 'RATE_LIMITED',
        code: PLATFORM_ERROR_CODES.REQUEST_RATE_LIMITED,
        message: 'Too many requests from this address; try again after the window ends.',
        details: { retryAfterSeconds: verdict.retryAfterSeconds },
        correlationId: 'unknown',
      },
    };
    void reply
      .code(429)
      .header('retry-after', String(verdict.retryAfterSeconds))
      .header('cache-control', 'no-store')
      .send(body);
  });
}
