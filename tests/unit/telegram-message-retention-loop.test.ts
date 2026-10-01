import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
  TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  TELEGRAM_MESSAGE_RETENTION_FAILURE_RECORD_INTERVAL_MS,
  TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD,
  TelegramMessageRetentionLoop,
} from '../../apps/api/src/modules/commerce/messaging/application/telegram-message-retention-loop';

/**
 * The retention lane's operational visibility (`docs/telegram-retention.md` §6): a failure
 * streak becomes ONE condition — written at the threshold, then at most once an interval
 * while it lasts — and the first completed tick resolves it, including one a replaced
 * replica left open. Never a row per failed tick.
 */
const SCOPE = { tenantId: 'tenant-a', botInstanceId: null } as unknown as TenantContext;

/**
 * A loop over a fake sweep and a fake operations log that behaves like the real one: the
 * failing condition is open once it is written (by this loop or, via `openElsewhere`, by
 * another replica) and closed by a recovery. Its read and its write can each be made to
 * throw.
 */
function harness(options: { readonly openOnBoot?: boolean } = {}) {
  let now = 1_000_000;
  let failing = true;
  let calls = 0;
  let open = options.openOnBoot === true;
  let lookupsToFail = 0;
  let writesToFail = 0;
  const recorded: OperationalEventInput[] = [];
  const passes: number[] = [];
  const loop = new TelegramMessageRetentionLoop(
    {
      purgeExpired: (_scope, _actor, limit) => {
        calls += 1;
        passes.push(limit);
        if (failing) return Promise.reject(new Error('statement timeout'));
        return Promise.resolve({ wizards: 0, reviews: 0 });
      },
    },
    {
      scope: () => SCOPE,
      intervalMs: 3_600_000,
      initialDelayMs: 1_000,
      batchSize: 10,
      maxBatchesPerTick: 5,
      now: () => now,
      ids: { uuid: () => '00000000-0000-7000-8000-000000000001' },
      opsLog: {
        record: (_scope, event) => {
          if (writesToFail > 0) {
            writesToFail -= 1;
            return Promise.reject(new Error('ops log unavailable'));
          }
          recorded.push(event);
          if (event.code === TELEGRAM_MESSAGE_RETENTION_FAILING_CODE) open = true;
          if (event.recoversCode === TELEGRAM_MESSAGE_RETENTION_FAILING_CODE) open = false;
          return Promise.resolve({ id: 'x', isNew: true, reopened: false } as never);
        },
      },
      conditions: {
        openConditions: () => {
          if (lookupsToFail > 0) {
            lookupsToFail -= 1;
            return Promise.reject(new Error('read timeout'));
          }
          return Promise.resolve(open ? [TELEGRAM_MESSAGE_RETENTION_FAILING_CODE] : []);
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  );
  return {
    loop,
    recorded,
    passes,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    heal: () => {
      failing = false;
    },
    breakAgain: () => {
      failing = true;
    },
    openElsewhere: () => {
      open = true;
    },
    failLookups: (n: number) => {
      lookupsToFail = n;
    },
    failWrites: (n: number) => {
      writesToFail = n;
    },
    isOpen: () => open,
    codes: () => recorded.map((event) => event.code),
  };
}

describe('the Telegram message retention loop', () => {
  it('records nothing below the threshold, one condition at it, and none on the next ticks within the interval', async () => {
    const h = harness();
    for (let tick = 1; tick < TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD; tick += 1) {
      expect(await h.loop.tick()).toBeNull();
    }
    expect(h.recorded).toEqual([]);
    await h.loop.tick();
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_FAILING_CODE]);
    expect(h.recorded[0]?.dedupeKey).toBe(TELEGRAM_MESSAGE_RETENTION_FAILING_CODE);
    expect(h.recorded[0]?.severity).toBe('WARN');
    // Every following failed tick inside the interval: still one row.
    for (let tick = 0; tick < 10; tick += 1) {
      h.advance(60_000);
      await h.loop.tick();
    }
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_FAILING_CODE]);
    // Past the interval: one more occurrence of the same condition, not a new one per tick.
    h.advance(TELEGRAM_MESSAGE_RETENTION_FAILURE_RECORD_INTERVAL_MS);
    await h.loop.tick();
    expect(h.codes()).toEqual([
      TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
      TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
    ]);
  });

  it('the first completed tick records the recovery against the failing code, once', async () => {
    const h = harness();
    for (let tick = 0; tick < TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD; tick += 1) {
      await h.loop.tick();
    }
    h.heal();
    expect(await h.loop.tick()).toEqual({ wizards: 0, reviews: 0 });
    expect(h.codes()).toEqual([
      TELEGRAM_MESSAGE_RETENTION_FAILING_CODE,
      TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE,
    ]);
    const recovery = h.recorded[1];
    expect(recovery?.recoversCode).toBe(TELEGRAM_MESSAGE_RETENTION_FAILING_CODE);
    expect(recovery?.recoversDedupeKey).toBe(TELEGRAM_MESSAGE_RETENTION_FAILING_CODE);
    expect(recovery?.dedupeKey).not.toBe(TELEGRAM_MESSAGE_RETENTION_FAILING_CODE);
    await h.loop.tick();
    expect(h.recorded).toHaveLength(2);
    // A short failure after the recovery starts a NEW streak from zero.
    h.breakAgain();
    await h.loop.tick();
    expect(h.recorded).toHaveLength(2);
  });

  it('a streak that ends below the threshold records nothing at all', async () => {
    const h = harness();
    await h.loop.tick();
    h.heal();
    await h.loop.tick();
    expect(h.recorded).toEqual([]);
  });

  it('resolves a condition another process left open, once', async () => {
    const h = harness({ openOnBoot: true });
    h.heal();
    await h.loop.tick();
    await h.loop.tick();
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE]);
    expect(h.isOpen()).toBe(false);
  });

  // Codex review of #131: the lookup was marked done before it succeeded.
  it('a lookup that throws on the first completed tick is asked again, and the inherited condition still resolves', async () => {
    const h = harness({ openOnBoot: true });
    h.heal();
    h.failLookups(1);
    await h.loop.tick();
    expect(h.recorded).toEqual([]);
    await h.loop.tick();
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE]);
    expect(h.isOpen()).toBe(false);
  });

  // Codex review of #131: a condition another replica opens AFTER this one's first tick.
  it('a condition another replica opens later is resolved by a later completed tick', async () => {
    const h = harness();
    h.heal();
    await h.loop.tick();
    expect(h.recorded).toEqual([]);
    h.openElsewhere();
    await h.loop.tick();
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_RECOVERED_CODE]);
  });

  // Codex review of #131: a failure write that failed was remembered as written.
  it('a failing condition whose write failed is not remembered: no orphan recovery, and the next failed tick writes it', async () => {
    const h = harness();
    for (let tick = 1; tick < TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD; tick += 1) {
      await h.loop.tick();
    }
    h.failWrites(1);
    await h.loop.tick();
    expect(h.recorded).toEqual([]);
    // The next failed tick, inside the hour, writes it after all.
    h.advance(60_000);
    await h.loop.tick();
    expect(h.codes()).toEqual([TELEGRAM_MESSAGE_RETENTION_FAILING_CODE]);

    // And a good tick after a write that only FAILED records no recovery for it.
    const g = harness();
    for (let tick = 1; tick < TELEGRAM_MESSAGE_RETENTION_FAILURE_THRESHOLD; tick += 1) {
      await g.loop.tick();
    }
    g.failWrites(1);
    await g.loop.tick();
    g.heal();
    await g.loop.tick();
    expect(g.recorded).toEqual([]);
  });

  it('a tick drains bounded batches and stops at a short one', async () => {
    const h = harness();
    h.heal();
    await h.loop.tick();
    expect(h.passes).toEqual([10]);
    expect(h.calls()).toBe(1);
  });
});
