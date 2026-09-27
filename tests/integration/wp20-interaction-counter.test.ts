import { afterAll, describe, expect, it } from 'vitest';
import { ANTI_SPAM_WINDOW_MS } from '@nexa/contracts';
import { RedisInteractionCounter } from '../../apps/api/src/infrastructure/redis/redis-interaction-counter';

/**
 * The anti-spam counter against the real Redis (WP20, brief §3.4): a ROLLING window, a
 * redelivered `update_id` counted once, and a dead Redis answered as UNAVAILABLE rather than
 * waited on. Its own key prefix per run, so nothing here touches another test's windows.
 */
describe('the Redis interaction counter', () => {
  const prefix = `nexa:antispam:test-${String(Date.now())}`;
  const counter = new RedisInteractionCounter(
    process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    prefix,
  );
  afterAll(async () => {
    await counter.close();
  });

  const tally = (updateId: string, nowMs: number, user = 'u1') =>
    counter.tally({
      tenantId: 't',
      botInstanceId: 'b',
      telegramUserId: user,
      updateId,
      nowMs,
      windowMs: ANTI_SPAM_WINDOW_MS,
    });

  it('counts within the window and forgets what is older than it', async () => {
    const t0 = 1_000_000;
    for (let index = 1; index <= 20; index += 1) {
      expect(await tally(`w-${String(index)}`, t0 + index)).toMatchObject({ count: index });
    }
    // Ten seconds after the first twenty, all of them have left the window.
    expect(await tally('w-late', t0 + 20 + ANTI_SPAM_WINDOW_MS)).toMatchObject({ count: 1 });
  });

  it('is a ROLLING window, not a fixed one', async () => {
    const t0 = 2_000_000;
    for (let index = 0; index < 10; index += 1) await tally(`r-a${String(index)}`, t0, 'u2');
    for (let index = 0; index < 10; index += 1) {
      await tally(`r-b${String(index)}`, t0 + 6_000, 'u2');
    }
    // At t0 + 9 s all twenty are inside the last ten seconds.
    expect(await tally('r-c', t0 + 9_000, 'u2')).toMatchObject({ count: 21 });
    // At t0 + 10 s the first ten have left it.
    expect(await tally('r-d', t0 + 10_000, 'u2')).toMatchObject({ count: 12 });
  });

  it('counts a redelivered update once', async () => {
    const t0 = 3_000_000;
    await tally('d-1', t0, 'u3');
    const again = await tally('d-1', t0 + 1, 'u3');
    expect(again).toEqual({ state: 'COUNTED', count: 1, duplicate: true });
  });

  it('does not keep a redelivered update in the window longer than the original', async () => {
    // A redelivery is the same interaction, so it must not refresh its place in the
    // window: nine seconds later it is still the interaction from t0.
    const t0 = 4_000_000;
    await tally('k-1', t0, 'u5');
    await tally('k-1', t0 + 9_000, 'u5');
    expect(await tally('k-2', t0 + ANTI_SPAM_WINDOW_MS, 'u5')).toMatchObject({ count: 1 });
  });

  it('answers UNAVAILABLE, quickly, when Redis does not answer', async () => {
    const dead = new RedisInteractionCounter('redis://127.0.0.1:6399', prefix);
    const started = Date.now();
    expect(
      await dead.tally({
        tenantId: 't',
        botInstanceId: 'b',
        telegramUserId: 'u4',
        updateId: 'x',
        nowMs: 1,
        windowMs: ANTI_SPAM_WINDOW_MS,
      }),
    ).toEqual({ state: 'UNAVAILABLE' });
    expect(Date.now() - started, 'never waited on').toBeLessThan(2_000);
    await dead.close();
  });
});
