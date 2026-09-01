import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import {
  operationalEvents,
  outboxMessages,
  processedMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import type { EventConsumer } from '../../apps/api/src/modules/platform/eventing/application/event-consumer';
import { OutboxRelay } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import { createTestContext, tenantA, type TestContext } from './harness';

const actor = () => systemJobActor('test-job', 'corr-outbox' as CorrelationId);

describe('transactional outbox', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('writes no event when the transaction rolls back', async () => {
    // This is the entire point of an outbox. Publishing from a request handler
    // instead is the dual-write bug: the transaction rolls back and the message
    // has already gone out.
    await expect(
      ctx.container.uow.run(tenantA, async (tx) => {
        await ctx.container.outbox.write(tx, actor(), {
          eventType: 'SystemPinged',
          aggregateType: 'System',
          aggregateId: 'system',
          payload: { source: 'test' },
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const rows = await ctx.container.database.db.select().from(outboxMessages);
    expect(rows).toHaveLength(0);
  });

  it('writes the event when the transaction commits', async () => {
    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    const rows = await ctx.container.database.db.select().from(outboxMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('SystemPinged');
    expect(rows[0]?.publishedAt).toBeNull();
    // The correlation id is a column, not just an ambient value, so the chain
    // survives the queue boundary.
    expect(rows[0]?.correlationId).toBe('corr-outbox');
  });

  it('allocates a monotonic sequence per aggregate', async () => {
    for (let i = 0; i < 3; i += 1) {
      await ctx.container.uow.run(tenantA, async (tx) => {
        await ctx.container.outbox.write(tx, actor(), {
          eventType: 'SystemPinged',
          aggregateType: 'System',
          aggregateId: 'system',
          payload: { source: 'test' },
        });
      });
    }

    const rows = await ctx.container.database.db
      .select()
      .from(outboxMessages)
      .orderBy(outboxMessages.sequence);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
  });

  it('keeps sequences independent across aggregates', async () => {
    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'alpha',
        payload: { source: 'test' },
      });
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'beta',
        payload: { source: 'test' },
      });
    });

    const rows = await ctx.container.database.db.select().from(outboxMessages);
    expect(rows.every((r) => r.sequence === 1)).toBe(true);
  });

  it('rejects an event type that is not in the catalog', async () => {
    await expect(
      ctx.container.uow.run(tenantA, async (tx) =>
        ctx.container.outbox.write(tx, actor(), {
          eventType: 'OrderPaid' as never,
          aggregateType: 'System',
          aggregateId: 'system',
          payload: {} as never,
        }),
      ),
    ).rejects.toThrowError(/event catalog/i);
  });

  it('publishes to a subscribing consumer and marks the row published', async () => {
    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    const result = await ctx.container.relay.processBatch();
    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });

    const [row] = await ctx.container.database.db.select().from(outboxMessages);
    expect(row?.publishedAt).not.toBeNull();

    // The consumer really ran: a projection exists.
    const events = await ctx.container.database.db.select().from(operationalEvents);
    expect(events.map((e) => e.code)).toContain('system.ping');
  });

  it('does nothing on an empty outbox', async () => {
    expect(await ctx.container.relay.processBatch()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });
  });

  it('delivers at-least-once but takes effect exactly once', async () => {
    // Simulates the crash window: the consumer ran, the process died before
    // `published_at` was written, and the message is redelivered on restart.
    const handled: string[] = [];
    const counting: EventConsumer = {
      name: 'test.counting',
      subscribesTo: ['SystemPinged'],
      async handle(event) {
        handled.push(event.eventId);
      },
    };

    const relay = new OutboxRelay(
      ctx.container.database.db,
      [counting],
      ctx.container.clock,
      ctx.container.logger,
      { batchSize: 10, pollIntervalMs: 50, maxLagMs: 300_000 },
    );

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    await relay.processBatch();
    expect(handled).toHaveLength(1);

    // Force the redelivery: unpublish the row, as a crash between dispatch and
    // the published_at update would leave it.
    await ctx.container.database.db.execute(sql`UPDATE outbox_messages SET published_at = NULL`);

    const second = await relay.processBatch();
    expect(second.claimed).toBe(1);
    // Received twice; applied once.
    expect(handled).toHaveLength(1);

    const applied = await ctx.container.database.db.select().from(processedMessages);
    expect(applied).toHaveLength(1);
  });

  it('records the failure and retries rather than dropping a message', async () => {
    // An event that cannot be delivered is a bug to fix, not a message to
    // discard. There is no dead-letter queue on the relay by design.
    let attempts = 0;
    const flaky: EventConsumer = {
      name: 'test.flaky',
      subscribesTo: ['SystemPinged'],
      async handle() {
        attempts += 1;
        if (attempts === 1) throw new Error('consumer exploded');
      },
    };

    const relay = new OutboxRelay(
      ctx.container.database.db,
      [flaky],
      ctx.container.clock,
      ctx.container.logger,
      { batchSize: 10, pollIntervalMs: 50, maxLagMs: 300_000 },
    );

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    const first = await relay.processBatch();
    expect(first.failed).toBe(1);

    const [afterFailure] = await ctx.container.database.db.select().from(outboxMessages);
    expect(afterFailure?.publishedAt).toBeNull();
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.lastError).toContain('consumer exploded');
  });

  it('reports lag so a stalled relay is visible rather than silent', async () => {
    expect(await ctx.container.relay.lagMs()).toBe(0);
    expect(await ctx.container.relay.isHealthy()).toBe(true);

    await ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.outbox.write(tx, actor(), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    expect(await ctx.container.relay.lagMs()).toBeGreaterThanOrEqual(0);
  });
});
