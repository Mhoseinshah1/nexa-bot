import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  systemContext,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import {
  auditLogs,
  operationalEvents,
  outboxMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * The Phase 0 exit criterion.
 *
 * "A trivial write path works end to end — authenticate → authorize → validate
 *  → idempotency → transaction with audit + outbox → relay → consumer — with
 *  tests, under a tenant context."
 *
 * Every later business write follows this shape, so it is worth proving before
 * any of them exist.
 */
describe('canonical write path', () => {
  let ctx: TestContext;

  const correlationId = 'corr-write-path' as CorrelationId;
  const systemActor = () => systemJobActor('test-job', correlationId);

  const customerActor = (): ActorContext => ({
    type: 'CUSTOMER',
    id: 'customer-1',
    label: 'A customer',
    surface: 'TELEGRAM',
    correlationId,
  });

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('runs all seven steps and lands the event in a projection', async () => {
    const result = await ctx.container.recordPing.execute(tenantA, systemActor(), {
      idempotencyKey: 'write-path-1',
      source: 'test',
      note: 'end to end',
    });

    expect(result.replayed).toBe(false);
    expect(result.sequence).toBe(1);

    // 6. TRANSACT — the change, its audit row and its outbox row committed together.
    const audits = await ctx.container.database.db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('system.ping');
    expect(audits[0]?.result).toBe('SUCCESS');
    expect(audits[0]?.correlationId).toBe(correlationId);
    expect(audits[0]?.tenantId).toBe(tenantA.tenantId);
    // Values, not references: the row still means something later.
    expect(audits[0]?.after).toMatchObject({ source: 'test' });

    const messages = await ctx.container.database.db.select().from(outboxMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.publishedAt).toBeNull();

    // 7. PROJECT — the relay publishes and the consumer projects.
    await ctx.container.relay.processBatch();

    const projected = await ctx.container.database.db.select().from(operationalEvents);
    expect(projected.map((e) => e.code)).toContain('system.ping');
    // The correlation id survived the queue boundary.
    expect(projected.find((e) => e.code === 'system.ping')?.correlationId).toBe(correlationId);
  });

  it('denies an actor without the permission, and records the denial', async () => {
    // Deny by default: Phase 0 has no admins, so nobody holds maintenance.run.
    await expect(
      ctx.container.recordPing.execute(tenantA, customerActor(), {
        idempotencyKey: 'write-path-denied',
        source: 'test',
      }),
    ).rejects.toThrowError(/maintenance.run/);

    // A denial is auditable and observable, not silent.
    const audits = await ctx.container.database.db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe('DENIED');
    expect(audits[0]?.actorType).toBe('CUSTOMER');

    const events = await ctx.container.database.db.select().from(operationalEvents);
    expect(events.map((e) => e.code)).toContain('access.permission_denied');
    expect(events.find((e) => e.code === 'access.permission_denied')?.severity).toBe('WARN');

    // And nothing was written to the outbox.
    expect(await ctx.container.database.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('rejects an invalid command before doing any work', async () => {
    await expect(
      ctx.container.recordPing.execute(tenantA, systemActor(), {
        idempotencyKey: 'short',
        source: 'not-a-source',
      }),
    ).rejects.toThrow();

    expect(await ctx.container.database.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('replays an idempotent command instead of repeating it', async () => {
    // Telegram retries webhooks, queues redeliver and gateways double-post.
    const first = await ctx.container.recordPing.execute(tenantA, systemActor(), {
      idempotencyKey: 'write-path-idem',
      source: 'telegram',
    });
    const second = await ctx.container.recordPing.execute(tenantA, systemActor(), {
      idempotencyKey: 'write-path-idem',
      source: 'telegram',
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    // One state change, one audit row, one outbox row.
    expect(await ctx.container.database.db.select().from(outboxMessages)).toHaveLength(1);
    expect(await ctx.container.database.db.select().from(auditLogs)).toHaveLength(1);
  });

  it('refuses a key reused with a different payload', async () => {
    await ctx.container.recordPing.execute(tenantA, systemActor(), {
      idempotencyKey: 'write-path-mismatch',
      source: 'telegram',
    });

    // Not a replay — a caller bug, and returning the old result would hide it.
    await expect(
      ctx.container.recordPing.execute(tenantA, systemActor(), {
        idempotencyKey: 'write-path-mismatch',
        source: 'http',
      }),
    ).rejects.toThrowError(/different request payload/i);
  });

  it('scopes idempotency keys per tenant', async () => {
    const inA = await ctx.container.recordPing.execute(tenantA, systemActor(), {
      idempotencyKey: 'shared-key',
      source: 'test',
    });
    const inSystem = await ctx.container.recordPing.execute(systemContext('test'), systemActor(), {
      idempotencyKey: 'shared-key',
      source: 'test',
    });

    // Same key, different scope, so both did real work.
    expect(inA.replayed).toBe(false);
    expect(inSystem.replayed).toBe(false);
    expect(inSystem.eventId).not.toBe(inA.eventId);
  });

  it('writes a null tenant for genuinely tenant-less work', async () => {
    await ctx.container.recordPing.execute(systemContext('platform-health'), systemActor(), {
      idempotencyKey: 'write-path-system',
      source: 'test',
    });

    const [message] = await ctx.container.database.db.select().from(outboxMessages);
    expect(message?.tenantId).toBeNull();
  });
});
