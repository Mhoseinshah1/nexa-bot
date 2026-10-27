import { createHash } from 'node:crypto';
import {
  TONPAYS_CALLS_PER_MINUTE_DEFAULT,
  TONPAYS_CALLS_PER_MINUTE_MAX,
  TONPAYS_CALLS_PER_MINUTE_MIN,
  TONPAYS_PACING_BURST_DEFAULT,
  TONPAYS_PACING_BURST_MAX,
  TONPAYS_PACING_BURST_MIN,
  TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS,
  TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS,
  TONPAYS_RATE_LIMIT_BACKOFF_JITTER_RATIO,
  TONPAYS_RETRY_AFTER_MAX_MS,
  TONPAYS_TELEGRAM_CALLS_PER_MINUTE_DEFAULT,
  type Clock,
  type Logger,
} from '@nexa/contracts';

/**
 * Round 11 A8: ONE client-side rate limiter for every TonPays call, per API key.
 *
 * The owner saw TonPays answer HTTP 429 to invoice creates twice inside a minute. Until this,
 * the only bound was the tenant's per-minute budget (`payment_gateway_call_budgets`): a FIXED
 * one-minute window that grants 50 calls from its first call. It let a worker pass fire its
 * calls back to back, and — a fixed window — up to twice its limit inside any rolling minute
 * (the end of one window and the start of the next), against a documented 60. Nothing
 * remembered a 429 beyond the one row that met it: the next row in the same pass asked again.
 *
 * This sits inside `tonpaysRequest`, the one function both TonPays adapters dial through, so
 * every endpoint — create, check, change card, receipt, cancel, refund — takes a token, and no
 * caller (a new lane, a retry of a cancel) can reach the provider around it:
 *
 * - **A token bucket per key.** It refills at `callsPerMinute` and holds at most `burst`. A call
 *   that finds no token waits for the next one when that is at most `maxWaitMs` away — a short
 *   pause in the worker, which makes every call one after another anyway — and is otherwise
 *   HELD: not sent at all, with the time until it could be.
 * - **A 429 pauses the key.** The provider's `Retry-After` when it sent one, else an
 *   exponential back-off (5 s doubling per consecutive 429, at most five minutes, ±20 % jitter).
 *   Every call on that key is HELD until the pause ends, and the bucket restarts with one token,
 *   so the first minute after a pause is paced, never a burst. Any answer that is not a 429
 *   resets the back-off.
 * - **Rolled up.** At most one log line a minute per route says how many 429s came and how many
 *   calls were held since the last line.
 *
 * A HELD call never left the process: for a create that is a certainty, not a lost answer — the
 * one place a request is provably "not sent" without the provider saying so.
 *
 * In-process: the bucket bounds what ONE worker sends. The per-minute budget still bounds the
 * tenant across replicas. The key is held only as a SHA-256 fingerprint, in memory, and is
 * never logged.
 */

export type TonPaysRoute = 'TONPAYS' | 'TONPAYS_TELEGRAM';

export interface TonPaysPacing {
  readonly callsPerMinute: number;
  readonly burst: number;
}

export const DEFAULT_TONPAYS_PACING: Readonly<Record<TonPaysRoute, TonPaysPacing>> = {
  TONPAYS: {
    callsPerMinute: TONPAYS_CALLS_PER_MINUTE_DEFAULT,
    burst: TONPAYS_PACING_BURST_DEFAULT,
  },
  TONPAYS_TELEGRAM: {
    callsPerMinute: TONPAYS_TELEGRAM_CALLS_PER_MINUTE_DEFAULT,
    burst: TONPAYS_PACING_BURST_DEFAULT,
  },
};

/** The longest a call waits for its token before it is HELD instead. */
export const TONPAYS_PACING_MAX_WAIT_MS = 5_000;
/** How long a route's pace, read from its settings, is used before it is read again. */
export const TONPAYS_PACING_CONFIG_TTL_MS = 60_000;
/** The roll-up: at most one rate-limit line per route in this long. */
export const TONPAYS_RATE_LIMIT_LOG_INTERVAL_MS = 60_000;

export type TonPaysGate =
  | { readonly kind: 'GO' }
  /** Not sent. `retryAfterMs` is how long until a call on this key could leave. */
  | { readonly kind: 'HELD'; readonly retryAfterMs: number; readonly reason: 'PACE' | 'PAUSE' };

interface Bucket {
  tokens: number;
  refilledAt: number;
  pausedUntil: number;
  streak: number;
}

interface RollUp {
  rateLimited: number;
  held: number;
  lastLoggedAt: number | null;
}

/** The exponential, jittered pause after `streak` earlier consecutive 429s (0 for the first). */
export function tonpaysBackoffMs(streak: number, random: number): number {
  const nominal = Math.min(
    TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS,
    TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(streak, 0), 20),
  );
  const unit = Math.min(Math.max(random, 0), 1);
  return Math.round(nominal * (1 + TONPAYS_RATE_LIMIT_BACKOFF_JITTER_RATIO * (2 * unit - 1)));
}

/**
 * `Retry-After` as ms: delay-seconds or an HTTP date, bounded to an hour; null when absent or
 * unreadable. A value in the past or of zero is no instruction.
 */
export function tonpaysRetryAfterMs(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const text = value.trim();
  let ms: number;
  if (/^[0-9]{1,7}$/u.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    ms = at - now.getTime();
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, TONPAYS_RETRY_AFTER_MAX_MS);
}

function clampPacing(raw: Partial<TonPaysPacing>, fallback: TonPaysPacing): TonPaysPacing {
  const rate =
    typeof raw.callsPerMinute === 'number' && Number.isFinite(raw.callsPerMinute)
      ? Math.round(raw.callsPerMinute)
      : fallback.callsPerMinute;
  const burst =
    typeof raw.burst === 'number' && Number.isFinite(raw.burst)
      ? Math.round(raw.burst)
      : fallback.burst;
  return {
    callsPerMinute: Math.min(
      TONPAYS_CALLS_PER_MINUTE_MAX,
      Math.max(TONPAYS_CALLS_PER_MINUTE_MIN, rate),
    ),
    burst: Math.min(TONPAYS_PACING_BURST_MAX, Math.max(TONPAYS_PACING_BURST_MIN, burst)),
  };
}

export class TonPaysRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rollUps = new Map<TonPaysRoute, RollUp>();
  private readonly paces = new Map<TonPaysRoute, { pacing: TonPaysPacing; readAt: number }>();

  constructor(
    private readonly deps: {
      readonly clock: Clock;
      /** Waits for a token. Tests pass one that advances their fake clock. */
      readonly sleep?: (ms: number) => Promise<void>;
      /** [0, 1), for the back-off's jitter. */
      readonly random?: () => number;
      readonly logger?: Logger;
      /** The route's pace from its settings; a read that fails keeps the defaults. */
      readonly pacingFor?: (route: TonPaysRoute) => Promise<Partial<TonPaysPacing>>;
      readonly maxWaitMs?: number;
    },
  ) {}

  /** Takes a token for one call on this key, waiting briefly for one; or says why not. */
  async acquire(route: TonPaysRoute, apiKey: string): Promise<TonPaysGate> {
    const pacing = await this.pacing(route);
    const bucket = this.bucketOf(apiKey, pacing);
    const now = this.nowMs();
    this.refill(bucket, pacing, now);
    if (bucket.pausedUntil > now) {
      this.rollUp(route).held += 1;
      return { kind: 'HELD', retryAfterMs: bucket.pausedUntil - now, reason: 'PAUSE' };
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { kind: 'GO' };
    }
    const intervalMs = 60_000 / pacing.callsPerMinute;
    const waitMs = Math.ceil((1 - bucket.tokens) * intervalMs);
    if (waitMs > (this.deps.maxWaitMs ?? TONPAYS_PACING_MAX_WAIT_MS)) {
      this.rollUp(route).held += 1;
      return { kind: 'HELD', retryAfterMs: waitMs, reason: 'PACE' };
    }
    // Reserved before the wait, so a second caller queues behind this one, never beside it.
    bucket.tokens -= 1;
    await (this.deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))))(
      waitMs,
    );
    // A 429 another call met while this one waited pauses this one too.
    const after = this.nowMs();
    if (bucket.pausedUntil > after) {
      this.rollUp(route).held += 1;
      return { kind: 'HELD', retryAfterMs: bucket.pausedUntil - after, reason: 'PAUSE' };
    }
    return { kind: 'GO' };
  }

  /**
   * The provider answered 429: pause every call on this key. Returns the pause applied, in ms —
   * the `Retry-After` it sent (bounded), else the exponential back-off for this streak.
   */
  rateLimited(route: TonPaysRoute, apiKey: string, retryAfterHeader: string | null): number {
    const now = this.nowMs();
    const pacing = this.paces.get(route)?.pacing ?? DEFAULT_TONPAYS_PACING[route];
    const bucket = this.bucketOf(apiKey, pacing);
    const told = tonpaysRetryAfterMs(retryAfterHeader, new Date(now));
    const pauseMs = told ?? tonpaysBackoffMs(bucket.streak, (this.deps.random ?? Math.random)());
    bucket.streak += 1;
    bucket.pausedUntil = Math.max(bucket.pausedUntil, now + pauseMs);
    // After the pause: one token, then the pace — never a full bucket's volley.
    bucket.tokens = 0;
    bucket.refilledAt = bucket.pausedUntil - 60_000 / pacing.callsPerMinute;
    const rollUp = this.rollUp(route);
    rollUp.rateLimited += 1;
    if (
      rollUp.lastLoggedAt === null ||
      now - rollUp.lastLoggedAt >= TONPAYS_RATE_LIMIT_LOG_INTERVAL_MS
    ) {
      this.deps.logger?.warn(
        {
          provider: route,
          rateLimited: rollUp.rateLimited,
          heldLocally: rollUp.held,
          pauseMs: bucket.pausedUntil - now,
          retryAfterMs: told,
          consecutive: bucket.streak,
        },
        'TonPays answered 429: calls with this key are paused (rolled up: at most one line a minute)',
      );
      rollUp.rateLimited = 0;
      rollUp.held = 0;
      rollUp.lastLoggedAt = now;
    }
    return bucket.pausedUntil - now;
  }

  /** The provider answered something other than a 429: the back-off starts over. */
  answered(apiKey: string): void {
    const bucket = this.buckets.get(fingerprint(apiKey));
    if (bucket !== undefined) bucket.streak = 0;
  }

  private nowMs(): number {
    return this.deps.clock.now().getTime();
  }

  private bucketOf(apiKey: string, pacing: TonPaysPacing): Bucket {
    const key = fingerprint(apiKey);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: pacing.burst, refilledAt: this.nowMs(), pausedUntil: 0, streak: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket, pacing: TonPaysPacing, now: number): void {
    // A pace lowered in settings since the last call takes effect at once.
    bucket.tokens = Math.min(pacing.burst, bucket.tokens);
    const elapsed = now - bucket.refilledAt;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(
      pacing.burst,
      bucket.tokens + (elapsed * pacing.callsPerMinute) / 60_000,
    );
    bucket.refilledAt = now;
  }

  private rollUp(route: TonPaysRoute): RollUp {
    let rollUp = this.rollUps.get(route);
    if (rollUp === undefined) {
      rollUp = { rateLimited: 0, held: 0, lastLoggedAt: null };
      this.rollUps.set(route, rollUp);
    }
    return rollUp;
  }

  private async pacing(route: TonPaysRoute): Promise<TonPaysPacing> {
    const now = this.nowMs();
    const cached = this.paces.get(route);
    if (cached !== undefined && now - cached.readAt < TONPAYS_PACING_CONFIG_TTL_MS) {
      return cached.pacing;
    }
    const fallback = DEFAULT_TONPAYS_PACING[route];
    let pacing = cached?.pacing ?? fallback;
    if (this.deps.pacingFor !== undefined) {
      try {
        pacing = clampPacing(await this.deps.pacingFor(route), fallback);
      } catch (error: unknown) {
        // A settings read that fails keeps the last pace (or the conservative default).
        this.deps.logger?.warn(
          { provider: route, error: error instanceof Error ? error.name : 'unknown' },
          'the TonPays pace could not be read from settings; the last one is kept',
        );
      }
    }
    this.paces.set(route, { pacing, readAt: now });
    return pacing;
  }
}

function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
