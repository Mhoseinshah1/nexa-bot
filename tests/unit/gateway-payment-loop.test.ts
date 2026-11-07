import { describe, expect, it } from 'vitest';
import {
  GATEWAY_PAYMENT_INTERVAL_MS,
  GatewayPaymentLoop,
  gatewayLoopSlackIntervals,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment-loop';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { TenantFanOut } from '../../apps/api/src/infrastructure/lifecycle/tenant-pass';

/**
 * WP11A — the gateway lane's readiness is sized to a pass, not to its polling interval.
 *
 * A pass makes its provider calls one after another, each allowed its whole timeout, so
 * an ordinary slow provider holds one pass far longer than three three-second intervals.
 * A lane reported stalled then stops the worker's heartbeat and fails a rollout.
 */
describe('the gateway lane freshness', () => {
  const INTERVAL = GATEWAY_PAYMENT_INTERVAL_MS;
  // Fifteen calls, each allowed fifteen seconds: the bound the container passes.
  const PASS_BOUND = 15 * 15_000;

  it('tolerates two tenants’ pass bounds plus three intervals (the owner’s and one other bot)', () => {
    expect(gatewayLoopSlackIntervals(INTERVAL, PASS_BOUND)).toBe((2 * PASS_BOUND) / INTERVAL + 3);
    expect(gatewayLoopSlackIntervals(INTERVAL, 1)).toBe(4);
  });

  it('a fan-out pass of two slow, bounded tenants stays fresh (Codex P2 on #418)', async () => {
    // The reviewer's repro: two 100 s bodies, a 3 s budget. The pass takes 200 s and is still
    // making bounded progress, so the lane must not read as stalled at any point of it.
    let nowMs = 1_000_000;
    const fanOut = new TenantFanOut({
      activeTenants: () => Promise.resolve(['tenant-hosted', 'tenant-owner'] as never),
      installationTenantId: () => 'tenant-owner' as never,
      now: () => nowMs,
      logger: { error: () => undefined },
    });
    const freshness: boolean[] = [];
    let loop: GatewayPaymentLoop | null = null;
    const lane = {
      runOnce: () => {
        nowMs += 100_000;
        freshness.push(loop?.isFresh(nowMs) ?? false);
        return Promise.resolve({
          created: 0,
          createFailed: 0,
          createUnknown: 0,
          createDeferred: 0,
          inquired: 0,
          settled: 0,
          unsuccessful: 0,
          lateCompletions: 0,
          budgetExhausted: false,
          rowFailures: 0,
          laneFailures: 0,
        });
      },
    } as unknown as GatewayPaymentService;
    loop = new GatewayPaymentLoop(lane, {
      scope: fanOut.pass('gateway-payments', { budgetMs: 3_000 }),
      intervalMs: 3_000,
      passBoundMs: 100_000,
      now: () => nowMs,
      logger: { info: () => undefined, error: () => undefined },
    });
    loop.start();
    await loop.tick();
    expect(freshness).toEqual([true, true]);
    expect(loop.isFresh(nowMs)).toBe(true);
    await loop.stop();
  });

  it('stays fresh through a slow pass that is still inside its bound, and goes stale past it', async () => {
    let nowMs = 1_000_000;
    let finish: () => void = () => undefined;
    const lane = {
      runOnce: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              created: 0,
              createFailed: 0,
              createUnknown: 0,
              createDeferred: 0,
              inquired: 0,
              settled: 0,
              unsuccessful: 0,
              lateCompletions: 0,
              budgetExhausted: false,
            });
        }),
    } as unknown as GatewayPaymentService;
    const loop = new GatewayPaymentLoop(lane, {
      scope: () => ({ tenantId: 't' as never, botInstanceId: null }),
      intervalMs: INTERVAL,
      passBoundMs: PASS_BOUND,
      now: () => nowMs,
      logger: { info: () => undefined, error: () => undefined },
    });
    loop.start();
    const pass = loop.tick();

    // Three and a half minutes into one pass of fifteen slow calls: still bounded.
    nowMs += 210_000;
    expect(loop.isFresh(nowMs)).toBe(true);
    // Past two tenants' bounds and three intervals of slack: a pass that is not coming back.
    nowMs = 1_000_000 + 2 * PASS_BOUND + 3 * INTERVAL + 1;
    expect(loop.isFresh(nowMs)).toBe(false);

    finish();
    await pass;
    expect(loop.isFresh(nowMs)).toBe(true);
    await loop.stop();
  });

  /*
   * FIX10 (Codex #268 A): the pass isolates its lanes, so a lane that throws no longer throws
   * the pass. It must still not be called progress: a claim that fails on every pass would
   * otherwise keep readiness fresh over a queue nothing is working.
   */
  describe('a pass that returns with a failure', () => {
    const report = (failures: { rowFailures: number; laneFailures: number }) => ({
      created: 0,
      createFailed: 0,
      createUnknown: 0,
      createDeferred: 0,
      inquired: 0,
      settled: 0,
      unsuccessful: 0,
      lateCompletions: 0,
      budgetExhausted: false,
      ...failures,
    });
    const loopOver = (failures: { rowFailures: number; laneFailures: number }) => {
      const clock = { nowMs: 1_000_000 };
      const lane = {
        runOnce: () => Promise.resolve(report(failures)),
      } as unknown as GatewayPaymentService;
      const errors: string[] = [];
      const loop = new GatewayPaymentLoop(lane, {
        scope: () => ({ tenantId: 't' as never, botInstanceId: null }),
        intervalMs: INTERVAL,
        passBoundMs: PASS_BOUND,
        now: () => clock.nowMs,
        logger: { info: () => undefined, error: (_c, message) => errors.push(message) },
      });
      return { clock, loop, errors };
    };
    const window = 2 * PASS_BOUND + 3 * INTERVAL;

    it('goes stale when a lane fails on every pass, however many passes return', async () => {
      const { clock, loop } = loopOver({ rowFailures: 0, laneFailures: 1 });
      loop.start();
      // A pass every interval, each one returning, for longer than the freshness window.
      for (let elapsed = 0; elapsed <= window + INTERVAL; elapsed += INTERVAL) {
        clock.nowMs = 1_000_000 + elapsed;
        await loop.tick();
      }
      expect(loop.isFresh(clock.nowMs)).toBe(false);
      await loop.stop();
    });

    it('stays fresh when only rows failed: each was isolated and the lane did its work', async () => {
      const { clock, loop } = loopOver({ rowFailures: 3, laneFailures: 0 });
      loop.start();
      for (let elapsed = 0; elapsed <= window + INTERVAL; elapsed += INTERVAL) {
        clock.nowMs = 1_000_000 + elapsed;
        await loop.tick();
      }
      expect(loop.isFresh(clock.nowMs)).toBe(true);
      await loop.stop();
    });

    it('recovers on the first pass whose lanes all succeed', async () => {
      const failures = { rowFailures: 0, laneFailures: 1 };
      const { clock, loop } = loopOver(failures);
      loop.start();
      clock.nowMs = 1_000_000 + window + 1;
      await loop.tick();
      expect(loop.isFresh(clock.nowMs)).toBe(false);
      failures.laneFailures = 0;
      await loop.tick();
      expect(loop.isFresh(clock.nowMs)).toBe(true);
      await loop.stop();
    });
  });
});
