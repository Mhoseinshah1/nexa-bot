import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReadinessService } from '../../apps/api/src/modules/platform/system/application/readiness.service';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * R12 F2 item 2: the anonymous `/health/ready` cannot be used to exhaust the API's pool.
 *
 * Before: every request ran the four probes, three of which check a connection out of the
 * pool that serves the operators and the bot. A loop of anonymous GETs — or a load balancer
 * misconfigured to poll fast — held that pool, and a stalled database made every probe hold
 * its connection for the whole timeout. Now one computation is in flight at a time and its
 * verdict is reused for a short window.
 */
describe('the readiness verdict', () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

  function service(cacheMs: number) {
    let now = Date.parse('2026-10-31T00:00:00.000Z');
    let databaseCalls = 0;
    let release: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    let down = false;
    const readiness = new ReadinessService({
      clock: { now: () => new Date(now) } as never,
      logger: logger as never,
      maxOutboxLagMs: 60_000,
      verdictCacheMs: cacheMs,
      probes: {
        database: async () => {
          databaseCalls += 1;
          if (gate !== null) await gate;
          if (down) throw new Error('the database is unreachable');
        },
        cache: async () => true,
        schema: async () => ({ state: 'CURRENT' as const, applied: 1 }),
        outboxLagMs: async () => 0,
      },
    });
    return {
      readiness,
      calls: () => databaseCalls,
      advance: (ms: number) => {
        now += ms;
      },
      hold: () => {
        gate = new Promise<void>((resolve) => {
          release = () => {
            gate = null;
            resolve();
          };
        });
      },
      release: () => release?.(),
      setDown: (value: boolean) => {
        down = value;
      },
    };
  }

  it('shares ONE computation among every caller that arrives while it runs', async () => {
    const s = service(3_000);
    s.hold();
    const callers = Array.from({ length: 50 }, () => s.readiness.verdict());
    // Fifty anonymous requests during a slow probe: one database probe, not fifty.
    expect(s.calls()).toBe(1);
    s.release();
    const answers = await Promise.all(callers);
    expect(answers.every((answer) => answer.degraded === false)).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it('reuses the verdict for the window, then computes it again', async () => {
    const s = service(3_000);
    await s.readiness.verdict();
    s.advance(2_999);
    await s.readiness.verdict();
    expect(s.calls()).toBe(1);
    // A degraded answer is reused exactly like a healthy one: the degraded case, probes
    // timing out against a stalled database, is the expensive one to repeat.
    s.advance(1);
    s.setDown(true);
    expect((await s.readiness.verdict()).degraded).toBe(true);
    expect(s.calls()).toBe(2);
    s.setDown(false);
    s.advance(1_000);
    expect((await s.readiness.verdict()).degraded).toBe(true);
    expect(s.calls()).toBe(2);
    s.advance(2_000);
    expect((await s.readiness.verdict()).degraded).toBe(false);
    expect(s.calls()).toBe(3);
  });

  it('recomputes on every call with a zero window, and `run()` is never cached', async () => {
    const zero = service(0);
    await zero.readiness.verdict();
    await zero.readiness.verdict();
    expect(zero.calls()).toBe(2);

    const s = service(3_000);
    await s.readiness.verdict();
    await s.readiness.run();
    await s.readiness.run();
    // The authenticated detail asks fresh; only the anonymous verdict is shared.
    expect(s.calls()).toBe(3);
  });

  it('defaults to a three-second window, and /health/ready is the route that uses it', () => {
    expect(configSchema.shape.READINESS_CACHE_MS.parse(undefined)).toBe(3_000);
    const controller = readFileSync('apps/api/src/surfaces/web/health.controller.ts', 'utf8');
    expect(controller).toContain('this.probe.verdict()');
    expect(controller).not.toContain('this.probe.run()');
  });
});
