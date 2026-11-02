import { describe, expect, it } from 'vitest';
import {
  TONPAYS_PACING_BURST_DEFAULT,
  TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS,
  TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS,
  type Logger,
} from '@nexa/contracts';
import {
  TONPAYS_PACING_MAX_WAIT_MS,
  TonPaysRateLimiter,
  tonpaysBackoffMs,
  tonpaysRetryAfterMs,
  type TonPaysPacing,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-rate-limiter';

/**
 * Round 11 A8: the one client-side limiter every TonPays call takes a token from. A fake clock
 * and a sleep that advances it: nothing here waits for real time.
 */

const KEY = 'tp_live_SECRET_key_a';
const OTHER_KEY = 'tp_live_SECRET_key_b';

function rig(
  options: {
    pacing?: Partial<TonPaysPacing> | (() => Promise<Partial<TonPaysPacing>>);
    random?: () => number;
  } = {},
) {
  let now = Date.UTC(2026, 9, 27, 9, 0, 0);
  const slept: number[] = [];
  const lines: { context: Record<string, unknown>; message: string }[] = [];
  const logger: Logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (context, message) => lines.push({ context, message }),
    error: () => undefined,
  };
  const pacing = options.pacing;
  const limiter = new TonPaysRateLimiter({
    clock: { now: () => new Date(now) },
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    random: options.random ?? (() => 0.5),
    logger,
    ...(pacing === undefined
      ? {}
      : { pacingFor: typeof pacing === 'function' ? pacing : () => Promise.resolve(pacing) }),
  });
  return {
    limiter,
    slept,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    nowMs: () => now,
  };
}

describe('the token bucket', () => {
  it('lets a burst of `burst` calls go at once, then paces the rest at calls_per_minute', async () => {
    const r = rig({ pacing: { callsPerMinute: 30, burst: 3 } });
    for (let i = 0; i < 3; i += 1) {
      expect(await r.limiter.acquire('TONPAYS', KEY)).toEqual({ kind: 'GO' });
    }
    expect(r.slept).toEqual([]);
    // The fourth waits one token (2 s at 30 a minute), the fifth another.
    expect(await r.limiter.acquire('TONPAYS', KEY)).toEqual({ kind: 'GO' });
    expect(await r.limiter.acquire('TONPAYS', KEY)).toEqual({ kind: 'GO' });
    expect(r.slept).toEqual([2_000, 2_000]);
  });

  it('never lets more than calls_per_minute + burst leave inside any minute', async () => {
    const r = rig({ pacing: { callsPerMinute: 30, burst: 3 } });
    const sent: number[] = [];
    while (r.nowMs() - Date.UTC(2026, 9, 27, 9, 0, 0) < 5 * 60_000) {
      const gate = await r.limiter.acquire('TONPAYS', KEY);
      if (gate.kind === 'GO') sent.push(r.nowMs());
      else r.advance(gate.retryAfterMs);
    }
    for (const start of sent) {
      const inWindow = sent.filter((t) => t >= start && t < start + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(30 + 3);
    }
    // And it is not starved: about the pace over five minutes.
    expect(sent.length).toBeGreaterThanOrEqual(5 * 30);
  });

  it('HOLDS a call (nothing sent) whose token is further away than the longest wait', async () => {
    const r = rig({ pacing: { callsPerMinute: 6, burst: 1 } });
    expect(await r.limiter.acquire('TONPAYS', KEY)).toEqual({ kind: 'GO' });
    // 6 a minute is one token every 10 s: more than the 5 s a call may wait.
    expect(10_000).toBeGreaterThan(TONPAYS_PACING_MAX_WAIT_MS);
    const gate = await r.limiter.acquire('TONPAYS', KEY);
    expect(gate).toEqual({ kind: 'HELD', retryAfterMs: 10_000, reason: 'PACE' });
    expect(r.slept).toEqual([]);
  });

  it('keeps one bucket per API key: one key spending its burst does not slow another', async () => {
    const r = rig({ pacing: { callsPerMinute: 6, burst: 1 } });
    expect((await r.limiter.acquire('TONPAYS', KEY)).kind).toBe('GO');
    expect((await r.limiter.acquire('TONPAYS', KEY)).kind).toBe('HELD');
    expect((await r.limiter.acquire('TONPAYS', OTHER_KEY)).kind).toBe('GO');
  });

  it('reads its pace from settings, clamped to the documented bounds, and keeps the default when the read fails', async () => {
    const tooFast = rig({ pacing: { callsPerMinute: 500, burst: 50 } });
    for (let i = 0; i < 10; i += 1) await tooFast.limiter.acquire('TONPAYS', KEY);
    // burst clamped to 10: all ten go at once; the eleventh waits 1 s (60 a minute, the cap).
    expect(tooFast.slept).toEqual([]);
    await tooFast.limiter.acquire('TONPAYS', KEY);
    expect(tooFast.slept).toEqual([1_000]);

    const failing = rig({ pacing: () => Promise.reject(new Error('db down')) });
    for (let i = 0; i < TONPAYS_PACING_BURST_DEFAULT; i += 1) {
      expect((await failing.limiter.acquire('TONPAYS_TELEGRAM', KEY)).kind).toBe('GO');
    }
    // TonPays Telegram's default: 15 a minute, so the next token is 4 s away.
    await failing.limiter.acquire('TONPAYS_TELEGRAM', KEY);
    expect(failing.slept).toEqual([4_000]);
  });
});

describe('a 429 pauses the key', () => {
  it('honours the provider’s Retry-After: every call on the key is HELD until it has passed', async () => {
    const r = rig({ pacing: { callsPerMinute: 30, burst: 3 } });
    expect(r.limiter.rateLimited('TONPAYS', KEY, '40')).toBe(40_000);
    r.advance(39_000);
    const held = await r.limiter.acquire('TONPAYS', KEY);
    expect(held).toEqual({ kind: 'HELD', retryAfterMs: 1_000, reason: 'PAUSE' });
    r.advance(1_000);
    // After the pause: one token, then the pace again — never a fresh burst.
    expect((await r.limiter.acquire('TONPAYS', KEY)).kind).toBe('GO');
    await r.limiter.acquire('TONPAYS', KEY);
    expect(r.slept).toEqual([2_000]);
  });

  it('reads Retry-After as an HTTP date too, bounded to an hour, and ignores one in the past', () => {
    const now = new Date(Date.UTC(2026, 9, 27, 9, 0, 0));
    expect(tonpaysRetryAfterMs('Tue, 27 Oct 2026 09:00:30 GMT', now)).toBe(30_000);
    expect(tonpaysRetryAfterMs('999999', now)).toBe(60 * 60_000);
    expect(tonpaysRetryAfterMs('Tue, 27 Oct 2026 08:00:00 GMT', now)).toBeNull();
    expect(tonpaysRetryAfterMs('soon', now)).toBeNull();
    expect(tonpaysRetryAfterMs(null, now)).toBeNull();
  });

  it('without Retry-After backs off exponentially per consecutive 429, with jitter, to a cap', () => {
    const r = rig({ random: () => 0.5 });
    const pauses: number[] = [];
    for (let i = 0; i < 10; i += 1) pauses.push(r.limiter.rateLimited('TONPAYS', KEY, null));
    // 5 s, 10 s, 20 s, ... each started from the moment it was met (the clock is still).
    expect(pauses.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(pauses[9]).toBe(TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS);
    for (let i = 1; i < pauses.length; i += 1) {
      expect(pauses[i]).toBeGreaterThanOrEqual(pauses[i - 1]!);
    }
    // The jitter: ±20 % of the nominal step, deterministic in the random it is handed.
    expect(tonpaysBackoffMs(0, 0)).toBe(TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS * 0.8);
    expect(tonpaysBackoffMs(0, 1)).toBe(TONPAYS_RATE_LIMIT_BACKOFF_BASE_MS * 1.2);
    expect(tonpaysBackoffMs(40, 1)).toBe(TONPAYS_RATE_LIMIT_BACKOFF_CAP_MS * 1.2);
  });

  it('starts the back-off over once the provider answers anything but a 429', () => {
    const r = rig();
    r.limiter.rateLimited('TONPAYS', KEY, null);
    r.limiter.rateLimited('TONPAYS', KEY, null);
    r.advance(60_000);
    r.limiter.answered(KEY);
    expect(r.limiter.rateLimited('TONPAYS', KEY, null)).toBe(5_000);
  });

  it('a 429 met while another call waited for its token holds that call too', async () => {
    const r = rig({ pacing: { callsPerMinute: 30, burst: 1 } });
    await r.limiter.acquire('TONPAYS', KEY);
    // The sleep is where another call's 429 lands.
    const limiter = new TonPaysRateLimiter({
      clock: { now: () => new Date(r.nowMs()) },
      sleep: (ms) => {
        r.advance(ms);
        limiter.rateLimited('TONPAYS', KEY, '30');
        return Promise.resolve();
      },
      pacingFor: () => Promise.resolve({ callsPerMinute: 30, burst: 1 }),
    });
    await limiter.acquire('TONPAYS', KEY);
    const gate = await limiter.acquire('TONPAYS', KEY);
    expect(gate).toEqual({ kind: 'HELD', retryAfterMs: 30_000, reason: 'PAUSE' });
  });
});

describe('the operator signal', () => {
  it('rolls 429s up into at most one line a minute per route, with the counts, and never the key', async () => {
    const r = rig();
    r.limiter.rateLimited('TONPAYS', KEY, '10');
    for (let i = 0; i < 5; i += 1) {
      r.advance(1_000);
      r.limiter.rateLimited('TONPAYS', KEY, '10');
      await r.limiter.acquire('TONPAYS', KEY);
    }
    expect(r.lines).toHaveLength(1);
    r.advance(60_000);
    r.limiter.rateLimited('TONPAYS', KEY, '10');
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]!.context).toMatchObject({
      provider: 'TONPAYS',
      rateLimited: 6,
      heldLocally: 5,
      retryAfterMs: 10_000,
    });
    expect(JSON.stringify(r.lines)).not.toContain('SECRET');
  });
});
