import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { createLogger } from '../../apps/api/src/infrastructure/logging/logger';
import { FxRefreshLoop } from '../../apps/api/src/modules/commerce/fx/application/fx-refresh-loop';
import type { FxService } from '../../apps/api/src/modules/commerce/fx/application/fx.service';

/**
 * v0.8.2's worker crash loop, reproduced at the loop: a refresh pass that FAILED (Nobitex
 * answered 403 on the server) reached `backOff`, whose warning was a detached
 * `(logger.warn ?? logger.info)(…)` call. Against the container's real logger that threw
 * inside the `try`; the `catch` backed off again and threw again; the rejected `tick()`
 * promise was unhandled and Node exited.
 *
 * `fx-service.test.ts` drives this loop with plain-object loggers whose methods are arrow
 * functions — no `this` to lose — which is why it stayed green. These use what the
 * container uses: `createLogger`, and a class-based logger whose methods need `this`.
 */

const scope: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
type RefreshIfDue = Pick<FxService, 'refreshIfDue'>;

function realLogger() {
  const lines: Record<string, unknown>[] = [];
  // The container's own constructor, so the logger is exactly the one that crashed.
  const logger = createLogger('info', 'worker', {
    write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>),
  });
  return { lines, logger };
}

type LoopLogger = ConstructorParameters<typeof FxRefreshLoop>[1]['logger'];

function loop(fx: RefreshIfDue, logger: LoopLogger, now: () => number): FxRefreshLoop {
  return new FxRefreshLoop(fx, {
    scope: () => scope,
    baseAsset: 'USDT',
    intervalMs: 10_000,
    passBoundMs: 10_000,
    now,
    logger,
    backoffMs: [10_000, 30_000, 60_000],
  });
}

/** What a 403 from the primary looks like by the time it reaches the loop. */
const http403: RefreshIfDue = {
  refreshIfDue: () =>
    Promise.resolve({ outcome: 'FAILED', reason: 'NOBITEX:http_403' } as Awaited<
      ReturnType<FxService['refreshIfDue']>
    >),
};

/** And a network error that escaped the service as a throw. */
const networkError: RefreshIfDue = {
  refreshIfDue: () =>
    Promise.reject(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
          code: 'ECONNREFUSED',
        }),
      }),
    ),
};

describe('the FX refresh loop backs off through the real logger', () => {
  for (const [label, source] of [
    ['an HTTP 403 (FAILED outcome)', http403],
    ['a network error (thrown pass)', networkError],
  ] as const) {
    it(`${label}: every tick resolves and the back-off warning is written`, async () => {
      const { lines, logger } = realLogger();
      let nowMs = 1_700_000_000_000;
      const fx = loop(source, logger, () => nowMs);
      // Three failed passes, each past the previous back-off, so every step warns once.
      for (const advance of [0, 10_001, 30_001]) {
        nowMs += advance;
        await expect(fx.tick()).resolves.toBeUndefined();
      }
      const warnings = lines.filter((line) => line['msg'] === 'fx refresh failing; backing off');
      expect(warnings.map((line) => line['level'])).toEqual(['warn', 'warn', 'warn']);
      expect(warnings.map((line) => line['consecutiveFailures'])).toEqual([1, 2, 3]);
    });
  }

  it('a logger whose methods need `this` is called ON the logger, not detached from it', async () => {
    // Pins the call site independently of the logger fix: this one is not detach-safe.
    class ReceiverLogger {
      readonly seen: string[] = [];
      info(_context: Record<string, unknown>, message: string): void {
        this.seen.push(`info:${message}`);
      }
      warn(_context: Record<string, unknown>, message: string): void {
        this.seen.push(`warn:${message}`);
      }
      error(_context: Record<string, unknown>, message: string): void {
        this.seen.push(`error:${message}`);
      }
    }
    const receiver = new ReceiverLogger();
    const fx = loop(http403, receiver, () => 1_700_000_000_000);
    await expect(fx.tick()).resolves.toBeUndefined();
    expect(receiver.seen).toEqual(['warn:fx refresh failing; backing off']);

    // And with no `warn`, the fallback to `info` keeps its receiver too.
    class InfoOnly {
      readonly seen: string[] = [];
      info(_context: Record<string, unknown>, message: string): void {
        this.seen.push(`info:${message}`);
      }
      error(_context: Record<string, unknown>, message: string): void {
        this.seen.push(`error:${message}`);
      }
    }
    const infoOnly = new InfoOnly();
    const fallback = loop(http403, infoOnly, () => 1_700_000_000_000);
    await expect(fallback.tick()).resolves.toBeUndefined();
    expect(infoOnly.seen).toEqual(['info:fx refresh failing; backing off']);
  });
});
