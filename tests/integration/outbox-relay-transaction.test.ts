import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import {
  operationalEvents,
  outboxMessages,
  processedMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import type { EventConsumer } from '../../apps/api/src/modules/platform/eventing/application/event-consumer';
import { OutboxRelay } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * The relay's transaction boundary (C1).
 *
 * The effectively-once contract is: the `processed_messages` claim and the
 * consumer's effect are ONE commit. Every test here is about that boundary
 * and nothing else — which consumers exist, what they project, and how lag is
 * reported are `outbox.test.ts`'s business.
 *
 * The consumers below write a real row through the transaction they are
 * given, so "the effect" is something the database can be asked about after
 * the fact, and a rollback is observable as an absent row rather than as a
 * counter a mock forgot to decrement.
 */

const actor = () => systemJobActor('test-job', 'corr-relay-tx' as CorrelationId);

describe('the relay commits the claim and the effect together', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const relayWith = (consumers: EventConsumer[], context: TestContext = ctx) =>
    new OutboxRelay(
      context.container.database.db,
      consumers,
      context.container.clock,
      context.container.logger,
      {
        batchSize: 10,
        pollIntervalMs: 50,
        maxLagMs: 300_000,
      },
    );

  const writeEvent = (context: TestContext = ctx) =>
    context.container.uow.run(tenantA, async (tx) => {
      await context.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

  /**
   * A consumer whose effect is a real row, written through the relay's
   * transaction, and which can be told to fail before or after writing it.
   */
  const projecting = (
    name: string,
    plan: { failBefore?: () => boolean; failAfter?: () => boolean } = {},
    context: TestContext = ctx,
  ): EventConsumer & { handled: number } => {
    const consumer = {
      name,
      subscribesTo: ['SystemPinged'] as const,
      handled: 0,
      async handle(event, tx) {
        consumer.handled += 1;
        if (plan.failBefore?.()) throw new Error('failed before writing');
        await context.container.opsLog.record(
          { tenantId: event.tenantId as never, botInstanceId: null },
          { code: 'system.ping', severity: 'INFO', message: `projected by ${name}` },
          tx,
        );
        if (plan.failAfter?.()) throw new Error('failed after writing');
      },
    } satisfies EventConsumer & { handled: number };
    return consumer;
  };

  const effects = (context: TestContext = ctx) =>
    context.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'system.ping'));
  const claims = (context: TestContext = ctx) =>
    context.container.database.db.select().from(processedMessages);
  const messages = (context: TestContext = ctx) =>
    context.container.database.db.select().from(outboxMessages);

  // 1 ----------------------------------------------------------------------
  it('commits the claim and the effect for a message that succeeds', async () => {
    await writeEvent();
    const consumer = projecting('test.ok');

    const result = await relayWith([consumer]).processBatch();

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await effects()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
    const [message] = await messages();
    expect(message?.publishedAt).not.toBeNull();
  });

  // 2 ----------------------------------------------------------------------
  it('rolls back BOTH the effect and the claim when the consumer throws after writing', async () => {
    // The effect landed in the transaction before the throw. It must not
    // survive on its own: an effect with no claim is an effect that will be
    // applied again on the retry.
    await writeEvent();
    const consumer = projecting('test.after', { failAfter: () => true });

    const result = await relayWith([consumer]).processBatch();

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(await effects()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    // And the failure was still recorded, on the message, in the same batch
    // transaction — which is only possible because the failed dispatch rolled
    // back to a savepoint rather than aborting the transaction.
    const [message] = await messages();
    expect(message?.publishedAt).toBeNull();
    expect(message?.attempts).toBe(1);
    expect(message?.lastError).toContain('failed after writing');
  });

  // 3 ----------------------------------------------------------------------
  it('applies the effect exactly once across a failure and its retry', async () => {
    await writeEvent();
    let attempt = 0;
    const consumer = projecting('test.retry', { failAfter: () => (attempt += 1) === 1 });
    const relay = relayWith([consumer]);

    const first = await relay.processBatch();
    expect(first.failed).toBe(1);
    expect(await effects()).toHaveLength(0);

    const second = await relay.processBatch();
    expect(second).toEqual({ claimed: 1, published: 1, failed: 0 });

    // Handled twice, applied once. The retry did real work because the first
    // attempt's claim did not survive; had it survived, the retry would have
    // skipped the consumer and published a message whose effect never happened.
    expect(consumer.handled).toBe(2);
    expect(await effects()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
  });

  // 4 ----------------------------------------------------------------------
  it('does not mark the pair processed when the consumer fails before its effect', async () => {
    await writeEvent();
    const consumer = projecting('test.before', { failBefore: () => true });

    const result = await relayWith([consumer]).processBatch();

    expect(result.failed).toBe(1);
    expect(await claims()).toHaveLength(0);
    expect(await effects()).toHaveLength(0);
    const [message] = await messages();
    expect(message?.publishedAt).toBeNull();
    expect(message?.attempts).toBe(1);
  });

  // 5 ----------------------------------------------------------------------
  it('lets two concurrent relay workers apply one message once', async () => {
    // Real concurrency: both workers are inside their batch transaction at the
    // same time, held there by a barrier in the consumer. `FOR UPDATE SKIP
    // LOCKED` is what keeps the second from claiming the row the first holds,
    // and the (consumer, event) primary key is what would catch it if it did.
    await writeEvent();
    let arrived = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const consumer = projecting('test.race');
    const gated: EventConsumer = {
      ...consumer,
      async handle(event, tx) {
        arrived += 1;
        if (arrived >= 1) open();
        await gate;
        await consumer.handle(event, tx);
      },
    };

    const [a, b] = await Promise.all([
      relayWith([gated]).processBatch(),
      // Let the first worker take the row before the second looks.
      new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        relayWith([gated]).processBatch(),
      ),
    ]);

    expect(a.published + b.published).toBe(1);
    expect(a.claimed + b.claimed).toBe(1);
    expect(await effects()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
  });

  // 6 ----------------------------------------------------------------------
  it('publishes the other messages in a batch when one of them fails', async () => {
    await writeEvent();
    await writeEvent();
    await writeEvent();
    const consumer = projecting('test.partial', {
      failAfter: () => consumer.handled === 2,
    });

    const result = await relayWith([consumer]).processBatch();

    // The middle one failed and rolled back to its savepoint; the two around
    // it committed. Without a per-message savepoint the second failure would
    // have aborted the batch transaction and taken the first message's commit
    // with it.
    expect(result).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(await effects()).toHaveLength(2);
    expect(await claims()).toHaveLength(2);
    const rows = await messages();
    expect(rows.filter((row) => row.publishedAt !== null)).toHaveLength(2);
    expect(rows.filter((row) => row.attempts === 1)).toHaveLength(1);
  });

  // 7 ----------------------------------------------------------------------
  it('needs no second connection, so a pool of one is enough', async () => {
    // The batch transaction holds the pool's only connection. A consumer that
    // wrote through the pool would wait for a connection that the transaction
    // it is running inside will never release — a deadlock the previous
    // relay had, and that this test would hang on rather than fail.
    const one = await createTestContext({ DATABASE_POOL_MAX: '1' });
    try {
      await one.reset();
      await writeEvent(one);
      const consumer = projecting('test.pool', {}, one);

      const result = await Promise.race([
        relayWith([consumer], one).processBatch(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the relay starved its own pool')), 8_000),
        ),
      ]);

      expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(await effects(one)).toHaveLength(1);
    } finally {
      await one.close();
    }
  }, 15_000);

  it('does not double-count a redelivered message it already applied', async () => {
    // The original at-least-once shape, kept beside the new tests: a crash
    // between the effect's commit and the `published_at` write is impossible
    // now (they are one commit), but a redelivery of an already-published
    // message can still happen and must still be a no-op.
    await writeEvent();
    const consumer = projecting('test.redeliver');
    const relay = relayWith([consumer]);
    await relay.processBatch();
    await ctx.container.database.db.execute(sql`UPDATE outbox_messages SET published_at = NULL`);
    const second = await relay.processBatch();
    expect(second.claimed).toBe(1);
    expect(consumer.handled).toBe(1);
    expect(await effects()).toHaveLength(1);
  });
});
