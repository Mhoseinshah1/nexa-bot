import { describe, expect, it } from 'vitest';
import {
  GATEWAY_PAYMENT_INTERVAL_MS,
  GatewayPaymentLoop,
  gatewayLoopSlackIntervals,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment-loop';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

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

  it('tolerates the pass bound plus three intervals', () => {
    expect(gatewayLoopSlackIntervals(INTERVAL, PASS_BOUND)).toBe(PASS_BOUND / INTERVAL + 3);
    expect(gatewayLoopSlackIntervals(INTERVAL, 1)).toBe(4);
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
    // Past the bound and three intervals of slack: a pass that is not coming back.
    nowMs = 1_000_000 + PASS_BOUND + 3 * INTERVAL + 1;
    expect(loop.isFresh(nowMs)).toBe(false);

    finish();
    await pass;
    expect(loop.isFresh(nowMs)).toBe(true);
    await loop.stop();
  });
});
