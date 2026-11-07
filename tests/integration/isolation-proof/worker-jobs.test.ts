import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isSystemContext,
  systemJobActor,
  type CorrelationId,
  type DomainEvent,
  type ScopeContext,
} from '@nexa/contracts';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../apps/api/src/infrastructure/persistence/database';
import { OutboxRelay } from '../../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import type { EventConsumer } from '../../../apps/api/src/modules/platform/eventing/application/event-consumer';
import { outboxMessages } from '../../../apps/api/src/infrastructure/persistence/schema';
import { resetAntiSpamWindows, testAppDatabaseUrl } from '../harness';
import { buildWorld, fingerprints, victimRows, type TenantWorld, type World } from './fixtures';

/**
 * Phase 6A PR-5 (D3) — the worker's background work, tenant against tenant.
 *
 *  - the OUTBOX relay, built on the APPLICATION pool (nexa_app) with the capacity round-robin
 *    (PR-2's weighted turns) over three tenants' backlogs: every message reaches its
 *    consumer under its OWN tenant's scope, a stopped tenant's messages are left unclaimed,
 *    and another tenant's turn takes nothing of it;
 *  - the service REMINDER sweep, per tenant, and the customer NOTIFICATION lane that sends
 *    what it raised: every tenant's customer is the same Telegram user, in the same chat, so
 *    the one thing that keeps a reminder from going out through the wrong tenant's bot is the
 *    tenant binding itself. Each bot sends only its own tenant's messages.
 */

const actor = () => systemJobActor('isolation-proof', 'iso-proof' as CorrelationId);
const LABELS = ['PRIMARY', 'HOSTED_1', 'HOSTED_2'] as const;

describe('isolation proof (PR-5) — worker jobs', () => {
  let world: World;
  let app: DatabaseHandle;

  beforeAll(async () => {
    world = await buildWorld();
    app = createDatabase(testAppDatabaseUrl(), 2);
    expect(await app.scopeEnforcement()).toBe('enforcing');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await world?.close();
  });

  beforeEach(async () => {
    await resetAntiSpamWindows();
    world.telegram.calls.length = 0;
    await world.api.container.database.db.execute(
      sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`,
    );
  });

  async function enqueue(tenant: TenantWorld, count: number, tag: string) {
    for (let i = 0; i < count; i += 1) {
      await world.api.container.uow.run(tenant.scope, (tx) =>
        world.api.container.outbox.write(tx, actor(), {
          eventType: 'SystemPinged',
          aggregateType: 'System',
          aggregateId: `${tag}-${tenant.label}-${String(i)}`,
          payload: { source: 'isolation-proof' },
        }),
      );
    }
  }

  interface Delivery {
    readonly eventTenant: string | null;
    readonly scope: ScopeContext;
    readonly role: string;
    readonly boundTenant: string;
    readonly foreignCustomers: number;
  }

  /** A consumer that records the scope it was handed and what its transaction can see. */
  function recorder(deliveries: Delivery[]): EventConsumer {
    return {
      name: `isolation-proof-${String(Math.random()).slice(2, 10)}`,
      subscribesTo: ['SystemPinged'],
      async handle(event: DomainEvent, context: { tx: unknown; scope: ScopeContext }) {
        const tx = context.tx as { execute: (q: unknown) => Promise<{ rows: unknown[] }> };
        const tenantId = (event as { tenantId?: string | null }).tenantId ?? null;
        const probe = (
          await tx.execute(sql`
            SELECT current_user AS role,
                   coalesce(current_setting('app.current_tenant_id', true), '') AS bound,
                   (SELECT count(*)::int FROM customers
                     WHERE tenant_id IS DISTINCT FROM ${tenantId}::uuid) AS foreign`)
        ).rows[0] as { role: string; bound: string; foreign: number };
        deliveries.push({
          eventTenant: tenantId,
          scope: context.scope,
          role: probe.role,
          boundTenant: probe.bound,
          foreignCustomers: probe.foreign,
        });
      },
    } as EventConsumer;
  }

  const relayWith = (consumers: EventConsumer[], batchSize: number) =>
    new OutboxRelay(app.db, consumers, world.api.container.clock, world.api.container.logger, {
      batchSize,
      pollIntervalMs: 50,
      maxLagMs: 300_000,
      // The installation's own bot a double turn, as production weighs it (PR-2).
      turnWeightOf: async (tenantId) => (tenantId === world.tenants.PRIMARY.tenantId ? 2 : 1),
    });

  it('the relay, in round-robin turns, hands each message to its consumer under its own tenant', async () => {
    for (const label of LABELS) await enqueue(world.tenants[label], 4, 'turns');
    const deliveries: Delivery[] = [];
    const relay = relayWith([recorder(deliveries)], 6);
    await relay.processBatch();
    await relay.processBatch();
    // Every tenant got turns (the round-robin), and every message went out once.
    expect(deliveries).toHaveLength(12);
    for (const label of LABELS) {
      const own = deliveries.filter((d) => d.eventTenant === world.tenants[label].tenantId);
      expect(own, label).toHaveLength(4);
      for (const delivery of own) {
        expect(isSystemContext(delivery.scope)).toBe(false);
        expect((delivery.scope as { tenantId: string }).tenantId).toBe(
          world.tenants[label].tenantId,
        );
      }
    }
  });

  it('a stopped hosted tenant’s messages are left unclaimed while the others are delivered', async () => {
    const stopped = world.tenants.HOSTED_2;
    const db = world.api.container.database.db;
    for (const label of LABELS) await enqueue(world.tenants[label], 2, 'stopped');
    await db.execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${stopped.tenantId}`);
    try {
      const deliveries: Delivery[] = [];
      await relayWith([recorder(deliveries)], 10).processBatch();
      expect(deliveries.map((d) => d.eventTenant).sort()).toEqual(
        [
          world.tenants.PRIMARY.tenantId,
          world.tenants.PRIMARY.tenantId,
          world.tenants.HOSTED_1.tenantId,
          world.tenants.HOSTED_1.tenantId,
        ].sort(),
      );
      const pending = await db
        .select({ tenantId: outboxMessages.tenantId })
        .from(outboxMessages)
        .where(sql`${outboxMessages.publishedAt} IS NULL`);
      expect(pending.map((row) => row.tenantId)).toEqual([stopped.tenantId, stopped.tenantId]);
    } finally {
      await db.execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${stopped.tenantId}`);
    }
  });

  /*
   * PR-6 CANDIDATE (defence in depth, not an observed leak). The relay claims a batch that
   * spans tenants on ONE transaction on the system path (`OutboxRelay` is `@ScopeBound()`,
   * so its unscoped `processBatch` runs as `nexa_system`, reason `OutboxRelay.processBatch`),
   * and each consumer's effect runs inside that transaction. A consumer's statement is
   * therefore NOT confined to the event's tenant by row-level security: a consumer that
   * dropped its tenant predicate would read or write every tenant's rows, which is exactly
   * the "one missed predicate" ADR-0037 adopted RLS to catch. Today every consumer scopes
   * its own SQL, so nothing leaks; the database does not enforce it. The fix (PR-6) is to
   * bind the event's tenant for each consumer's savepoint (`SET LOCAL ROLE NONE` and
   * `app.current_tenant_id`), or to run each consumer in its tenant's own unit of work.
   * The assertion is the property; `it.fails` until PR-6 makes it hold.
   */
  it.fails(
    'PR-6: a consumer’s transaction is confined by RLS to its event’s tenant',
    async () => {
      for (const label of LABELS) await enqueue(world.tenants[label], 1, 'confined');
      const deliveries: Delivery[] = [];
      await relayWith([recorder(deliveries)], 10).processBatch();
      expect(deliveries).toHaveLength(3);
      for (const delivery of deliveries) {
        expect(delivery.role).toBe('nexa_app');
        expect(delivery.boundTenant).toBe(delivery.eventTenant);
        expect(delivery.foreignCustomers).toBe(0);
      }
    },
  );

  const customerLane = () =>
    (
      world.api.container.customerNotificationLoop as unknown as {
        lane: { deliverDue(scope: unknown, limit: number): Promise<unknown> };
      }
    ).lane;

  it('the reminder sweep and the notification lane: each bot tells only its own tenant’s customer', async () => {
    const db = world.api.container.database.db;
    // Every tenant's service runs out tomorrow; the usage is fresh.
    await db.execute(sql`UPDATE services SET expires_at = now() + interval '1 day',
                                             usage_synced_at = now()`);
    const before = new Map<string, string>();
    for (const label of LABELS) before.set(label, await victimRows(world, world.tenants[label]));

    const reminders = async (tenantId: string) =>
      (
        (
          await db.execute(
            sql`SELECT count(*)::int AS n FROM service_reminders WHERE tenant_id = ${tenantId}`,
          )
        ).rows[0] as { n: number }
      ).n;

    // ONE tenant's sweep touches that tenant's services only.
    const hosted = world.tenants.HOSTED_1;
    const others = [world.tenants.PRIMARY, world.tenants.HOSTED_2];
    const othersBefore = await Promise.all(others.map((t) => reminders(t.tenantId)));
    await world.api.container.serviceReminderSweep.runOnce(hosted.scope);
    expect(await reminders(hosted.tenantId)).toBeGreaterThan(0);
    expect(await Promise.all(others.map((t) => reminders(t.tenantId)))).toEqual(othersBefore);
    for (const label of ['PRIMARY', 'HOSTED_2'] as const) {
      expect(await victimRows(world, world.tenants[label])).toBe(before.get(label));
    }

    // Then the others'; and the customer lane delivers each tenant's due messages, in that
    // tenant's scope, as a per-tenant worker pass would (see the PR-6 case below for why
    // this calls the lane itself rather than the worker's loop).
    for (const t of others) await world.api.container.serviceReminderSweep.runOnce(t.scope);
    for (const label of LABELS) {
      await customerLane().deliverDue(world.tenants[label].scope, 50);
    }

    const byBot = new Map<number, string[]>();
    for (const call of world.telegram.calls) {
      if (call.botId === null) continue;
      byBot.set(call.botId, [...(byBot.get(call.botId) ?? []), JSON.stringify(call.body)]);
    }
    for (const label of LABELS) {
      const own = world.tenants[label];
      const sent = byBot.get(own.telegramBotId) ?? [];
      expect(sent.length, `${label}’s bot sent nothing`).toBeGreaterThan(0);
      for (const other of LABELS.filter((l) => l !== label)) {
        const foreign = fingerprints(world.tenants[other]).filter((needle) =>
          sent.some((body) => body.includes(needle)),
        );
        expect(foreign, `${label}’s bot carried ${other}’s data`).toEqual([]);
      }
    }
    // No call went out under an unknown token.
    expect(world.telegram.calls.filter((call) => call.botId === null)).toEqual([]);
  });

  /*
   * PR-6 CANDIDATE (a hosted-bot functional gap, not a leak — it fails CLOSED). Every per-
   * tenant loop the worker runs takes its scope from `installationTenantId` (container.ts:
   * the customer notification lane, service and customer reminders, payment expiry, the
   * gateway inquiry lane, broadcasts, campaigns, bulk operations, receipt-review pushes, the
   * provisioner, …), so it serves the installation's PRIMARY only. A hosted tenant's due
   * customer notification is never sent by the worker — nor, by the same wiring, are its
   * reminders raised, its broadcasts dispatched, its gateway payments inquired or its
   * services provisioned. Nothing crosses tenants; the hosted bot is simply not served.
   * The assertion is the property; `it.fails` until PR-6 makes the loops iterate tenants.
   */
  const pendingFor = async (tenantId: string) =>
    (
      (
        await world.api.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM customer_notifications
               WHERE tenant_id = ${tenantId} AND state = 'PENDING'`,
        )
      ).rows[0] as { n: number }
    ).n;

  it('(the PR-6 case’s precondition) a hosted tenant has a due customer notification', async () => {
    const db = world.api.container.database.db;
    const hosted = world.tenants.HOSTED_2;
    await db.execute(sql`DELETE FROM customer_notifications WHERE tenant_id = ${hosted.tenantId}`);
    await db.execute(sql`DELETE FROM service_reminders WHERE tenant_id = ${hosted.tenantId}`);
    await db.execute(sql`UPDATE services SET expires_at = now() + interval '1 day',
                                             usage_synced_at = now()
                          WHERE tenant_id = ${hosted.tenantId}`);
    await world.api.container.serviceReminderSweep.runOnce(hosted.scope);
    expect(await pendingFor(hosted.tenantId)).toBeGreaterThan(0);
  });

  it.fails('PR-6: the worker’s notification loop delivers a hosted tenant’s due message', async () => {
    const hosted = world.tenants.HOSTED_2;
    world.telegram.calls.length = 0;
    for (let i = 0; i < 3; i += 1) await world.api.container.customerNotificationLoop.tick();
    expect(await pendingFor(hosted.tenantId)).toBe(0);
    expect(
      world.telegram.calls.filter((call) => call.botId === hosted.telegramBotId).length,
    ).toBeGreaterThan(0);
  });
});
