import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_MAX_FAILED_ATTEMPTS,
  OUTBOX_MESSAGE_EXHAUSTED_CODE,
  deliveryRetryDelayMs,
  systemJobActor,
  type CorrelationId,
} from '@nexa/contracts';
import { OutboxRelay } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import type { EventConsumer } from '../../apps/api/src/modules/platform/eventing/application/event-consumer';
import {
  notifications,
  operationalEvents,
  outboxMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * WP20 (brief §3.1–§3.2): the outbox reschedules a failed message on its own row, stops
 * after twelve real failures and says so once, and keeps the order its table promises —
 * per aggregate, and only that.
 */
const actor = () => systemJobActor('test-job', 'corr-wp20-outbox' as CorrelationId);

describe('outbox retry scheduling', () => {
  let ctx: TestContext;
  let skewMs = 0;
  const clock = { now: () => new Date(Date.now() + skewMs) };

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    skewMs = 0;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const relay = (consumers: EventConsumer[], batchSize = 10) =>
    new OutboxRelay(
      ctx.container.database.db,
      consumers,
      clock,
      ctx.container.logger,
      { batchSize, pollIntervalMs: 50, maxLagMs: 300_000 },
      ctx.container.database,
      undefined,
      ctx.container.opsLog,
    );

  /** A message is named `<aggregate>#<sequence>`: the first on aggregate `a` is `a#1`. */
  const write = (aggregateId: string) =>
    ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId,
        payload: { source: 'test' },
      });
    });

  /** Fails for every event it is told is poisoned; records every one it is handed. */
  const consumer = (poisoned: Set<string>) => {
    const seen: string[] = [];
    const handler: EventConsumer & { seen: string[] } = {
      name: 'wp20.test',
      subscribesTo: ['SystemPinged'],
      seen,
      async handle(event) {
        const name = `${event.aggregateId}#${String(event.sequence)}`;
        seen.push(name);
        if (poisoned.has(name)) throw new Error(`poisoned ${name}`);
      },
    };
    return handler;
  };

  const row = async (name: string) =>
    (await ctx.container.database.db.select().from(outboxMessages)).find(
      (one) => `${one.aggregateId}#${String(one.sequence)}` === name,
    );

  it('reschedules a failure on its own row, and claims nothing before it is due', async () => {
    await write('a');
    const handler = consumer(new Set(['a#1']));
    const before = clock.now().getTime();
    await relay([handler]).processBatch();

    const failed = await row('a#1');
    expect(failed?.attempts).toBe(1);
    const due = failed?.nextAttemptAt?.getTime() ?? 0;
    expect(due - before).toBeGreaterThanOrEqual(5_000);
    expect(due - before).toBeLessThan(6_000);

    // Not due: not claimed, so a poll is not spent on it.
    expect(await relay([handler]).processBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
    skewMs = 5_100;
    expect((await relay([handler]).processBatch()).claimed).toBe(1);
  });

  it('follows the owner’s schedule: 5 s, 15 s, 60 s, 5 min, 15 min, then an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map((n) => deliveryRetryDelayMs(n))).toEqual([
      5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    // The provider's retry_after is a floor, never a replacement, and never zero.
    expect(deliveryRetryDelayMs(1, 30_000)).toBe(30_000);
    expect(deliveryRetryDelayMs(3, 1_000)).toBe(60_000);
    expect(deliveryRetryDelayMs(1, 0)).toBe(5_000);
  });

  it('lets the messages behind a poison message through while it backs off', async () => {
    await write('a');
    await write('b');
    await write('c');
    const handler = consumer(new Set(['a#1']));
    // A batch of ONE: before WP20 the poison message took the only slot on every poll.
    await relay([handler], 1).processBatch();
    await relay([handler], 1).processBatch();
    await relay([handler], 1).processBatch();
    expect((await row('b#1'))?.publishedAt).not.toBeNull();
    expect((await row('c#1'))?.publishedAt).not.toBeNull();
    expect((await row('a#1'))?.attempts).toBe(1);
  });

  it('holds back a failed message’s own aggregate, and nothing else', async () => {
    await write('same');
    await write('same');
    await write('other');
    const handler = consumer(new Set(['same#1']));
    await relay([handler]).processBatch();
    expect((await row('same#1'))?.publishedAt).toBeNull();
    expect((await row('same#2'))?.publishedAt, 'waits for the first').toBeNull();
    expect((await row('other#1'))?.publishedAt, 'another aggregate is not held').not.toBeNull();

    // Still held while the first backs off.
    await relay([handler]).processBatch();
    expect((await row('same#2'))?.publishedAt).toBeNull();
    expect(handler.seen.filter((one) => one === 'same#2')).toHaveLength(0);
  });

  it('drains an aggregate’s queued messages in one batch, in order', async () => {
    // Ordering must not cost throughput: three events of one aggregate that nothing has
    // failed are one batch, not three.
    await write('queue');
    await write('queue');
    await write('queue');
    const handler = consumer(new Set());
    expect((await relay([handler]).processBatch()).published).toBe(3);
    expect(handler.seen).toEqual(['queue#1', 'queue#2', 'queue#3']);
  });

  it('stops after twelve real failures, keeps the message, and says so once', async () => {
    const owner = await createAdmin(ctx.container, tenantA, {
      username: 'diag-owner',
      roleKeys: ['owner'],
    });
    // The operations channel is configured, so "says so" means an operator is told.
    await ctx.container.settingsService.set(tenantA, adminActorFor(owner), {
      key: 'ops.notifications.telegram_chat_id',
      value: '-100999',
      expectedVersion: null,
      idempotencyKey: 'wp20-chat',
    });
    await ctx.container.featureFlags.set(tenantA, adminActorFor(owner), {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: 'wp20-flag',
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
    await write('a');
    await write('a');
    const handler = consumer(new Set(['a#1']));
    for (let failures = 1; failures <= DELIVERY_MAX_FAILED_ATTEMPTS; failures += 1) {
      await relay([handler]).processBatch();
      skewMs += 3_700_000;
    }
    const exhausted = await row('a#1');
    expect(exhausted?.attempts).toBe(DELIVERY_MAX_FAILED_ATTEMPTS);
    expect(exhausted?.publishedAt, 'kept, never marked done').toBeNull();
    expect(exhausted?.nextAttemptAt).toBeNull();

    // No longer claimed, and its aggregate's next message is no longer held behind it.
    const tries = handler.seen.filter((one) => one === 'a#1').length;
    await relay([handler]).processBatch();
    expect(handler.seen.filter((one) => one === 'a#1')).toHaveLength(tries);
    expect((await row('a#2'))?.publishedAt).not.toBeNull();

    // Announced exactly once, however many batches ran.
    const events = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(and(eq(operationalEvents.code, OUTBOX_MESSAGE_EXHAUSTED_CODE)));
    expect(events).toHaveLength(1);
    expect(events[0]?.occurrenceCount).toBe(1);
    // ...and an operator is told, once, through the lane: the event and its notification
    // are written in the relay's own transaction.
    const told = await ctx.container.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'OPERATIONAL_EVENT'));
    expect(told).toHaveLength(1);

    // Shown in the diagnostics, and not counted as lag.
    const found = await ctx.container.diagnostics.read(tenantA, adminActorFor(owner));
    expect(found.outbox.exhausted).toBe(1);
    expect(found.outbox.failingSample[0]).toMatchObject({ exhausted: true, nextAttemptAt: null });
    expect(await relay([handler]).lagMs()).toBe(0);
  });

  it('retries a message whose count grew under the release before, then exhausts and announces it', async () => {
    await write('b');
    // The release before WP20 retried a failing message on every poll: the count is past
    // the limit, and nothing ever decided or said so.
    await ctx.container.database.db
      .update(outboxMessages)
      .set({ attempts: DELIVERY_MAX_FAILED_ATTEMPTS + 3 })
      .where(eq(outboxMessages.aggregateId, 'b'));
    const handler = consumer(new Set(['b#1']));
    expect((await relay([handler]).processBatch()).claimed, 'still claimed').toBe(1);
    const exhausted = await row('b#1');
    expect(exhausted?.exhaustedAt, 'exhausted by this relay').not.toBeNull();
    const events = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(and(eq(operationalEvents.code, OUTBOX_MESSAGE_EXHAUSTED_CODE)));
    expect(events, 'and said so').toHaveLength(1);
    // And never claimed again.
    expect((await relay([handler]).processBatch()).claimed).toBe(0);
  });
});
