import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  PANEL_HEALTH_FAILURE_WINDOW_MS,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  auditLogs,
  panelMonitorSchedule,
  panels,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { panelConditionKey } from '../../apps/api/src/modules/platform/panels/application/panel-monitor.service';
import { PANEL_CONDITION_CODES } from '../../apps/api/src/modules/platform/panels/application/panel-health-dashboard';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Phase C2: draining a panel, and the health dashboard that shows it.
 *
 * Drain is "no NEW allocations here" and nothing else. The sales consequences —
 * the catalogue, confirmation and settlement refusing — are asserted where those
 * callers already are (`panel-capacity.test.ts`, `automatic-refund.test.ts`). This
 * file owns the WRITE (permission, audit, idempotency, scope, isolation, what it
 * must leave alone) and the dashboard READ (every number from a real row, nothing
 * from another tenant).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

describe('panel drain and the health dashboard', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let technical: ActorContext;
  let operator: ActorContext;
  let ownerB: ActorContext;
  let n = 0;
  const key = () => `panel-drain-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-drain', roleKeys: ['owner'] }),
    );
    technical = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'technical-drain',
        roleKeys: ['technical'],
      }),
    );
    // `panels.view` and nothing that drains.
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-drain',
        roleKeys: ['operator'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-drain', roleKeys: ['owner'] }),
    );
  });

  async function panel(scope = tenantA, actor = owner, name = 'Frankfurt'): Promise<string> {
    const created = await ctx.container.panels.create(scope, actor, {
      name,
      providerType: 'marzban',
      baseUrl: `https://${name.toLowerCase()}.example.test`,
      idempotencyKey: key(),
    });
    return created.view.panel.id;
  }

  const drain = (panelId: string, actor = technical, idempotencyKey = key(), reason = 'نگهداری') =>
    ctx.container.panels.setDrain(tenantA, actor, panelId, {
      draining: true,
      reason,
      idempotencyKey,
    });

  const undrain = (panelId: string, actor = technical, idempotencyKey = key()) =>
    ctx.container.panels.setDrain(tenantA, actor, panelId, {
      draining: false,
      reason: 'تمام شد',
      idempotencyKey,
    });

  const drainAudits = async (panelId: string) =>
    ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, panelId), eq(auditLogs.action, 'panel.drain')));

  // -------------------------------------------------------------------------
  // The write
  // -------------------------------------------------------------------------

  describe('draining', () => {
    it('records the drain, refuses new sales, and leaves status and monitoring alone', async () => {
      const panelId = await panel();
      await makePanelSellable(ctx.container, tenantA, panelId);
      const [scheduleBefore] = await ctx.container.database.db
        .select()
        .from(panelMonitorSchedule)
        .where(eq(panelMonitorSchedule.panelId, panelId));

      const view = await drain(panelId);

      expect(view.panel.drain?.reason).toBe('نگهداری');
      expect(view.panel.status, 'drain is not a status').toBe('ACTIVE');
      expect(view.sellability).toMatchObject({ sellable: false, reason: 'DRAINING' });
      // The monitor's schedule is untouched: a drained panel is still probed.
      // (`DISABLED` is what moves it to the far future; drain must not.)
      const [scheduleAfter] = await ctx.container.database.db
        .select()
        .from(panelMonitorSchedule)
        .where(eq(panelMonitorSchedule.panelId, panelId));
      expect(scheduleAfter?.nextEligibleAt.getTime()).toBe(
        scheduleBefore?.nextEligibleAt.getTime(),
      );

      const audits = await drainAudits(panelId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        result: 'SUCCESS',
        before: { draining: false, drainedAt: null, drainReason: null },
        after: { draining: true, reason: 'نگهداری' },
      });
    });

    it('undrains, and the panel sells again', async () => {
      const panelId = await panel();
      await makePanelSellable(ctx.container, tenantA, panelId);
      await drain(panelId);

      const view = await undrain(panelId);

      expect(view.panel.drain).toBeNull();
      expect(view.sellability).toMatchObject({ sellable: true, reason: null });
      const audits = await drainAudits(panelId);
      expect(audits.map((row) => (row.after as { draining: boolean }).draining)).toEqual([
        true,
        false,
      ]);
      // The reason for LEAVING is recorded too — nowhere else holds it.
      expect(audits[1]?.after).toMatchObject({ reason: 'تمام شد' });
    });

    it('a replayed key changes nothing and writes no second audit row', async () => {
      const panelId = await panel();
      const shared = key();
      await drain(panelId, technical, shared);
      const replay = await drain(panelId, technical, shared);
      expect(replay.panel.drain).not.toBeNull();
      expect(await drainAudits(panelId)).toHaveLength(1);
    });

    it('a request for the state already held records nothing', async () => {
      const panelId = await panel();
      await drain(panelId);
      const before = await ctx.container.database.db
        .select({ drainedAt: panels.drainedAt })
        .from(panels)
        .where(eq(panels.id, panelId));

      await drain(panelId, technical, key(), 'دوباره');

      const after = await ctx.container.database.db
        .select({ drainedAt: panels.drainedAt, reason: panels.drainReason })
        .from(panels)
        .where(eq(panels.id, panelId));
      // The original drain stands: its time and its reason are not rewritten.
      expect(after[0]?.drainedAt?.getTime()).toBe(before[0]?.drainedAt?.getTime());
      expect(after[0]?.reason).toBe('نگهداری');
      expect(await drainAudits(panelId)).toHaveLength(1);
    });

    it('refuses an actor without panels.drain, and audits the denial', async () => {
      const panelId = await panel();
      await expect(drain(panelId, operator)).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      const audits = await drainAudits(panelId);
      expect(audits.map((row) => row.result)).toEqual(['DENIED']);
      const [row] = await ctx.container.database.db
        .select({ drainedAt: panels.drainedAt })
        .from(panels)
        .where(eq(panels.id, panelId));
      expect(row?.drainedAt).toBeNull();
    });

    it('refuses an archived panel', async () => {
      const panelId = await panel();
      await ctx.container.panels.setStatus(tenantA, owner, panelId, {
        status: 'ARCHIVED',
        idempotencyKey: key(),
      });
      await expect(drain(panelId)).rejects.toMatchObject({ code: 'panel.archived' });
    });

    it('refuses a reason too short to explain anything', async () => {
      const panelId = await panel();
      await expect(drain(panelId, technical, key(), 'x')).rejects.toMatchObject({
        code: 'panel.request_invalid',
      });
    });

    it("cannot reach another tenant's panel", async () => {
      const foreign = await panel(tenantB, ownerB, 'Foreign');
      await expect(drain(foreign, owner)).rejects.toMatchObject({ code: 'panel.not_found' });
      const [row] = await ctx.container.database.db
        .select({ drainedAt: panels.drainedAt })
        .from(panels)
        .where(eq(panels.id, foreign));
      expect(row?.drainedAt).toBeNull();
    });

    it('refuses a tenant this installation has stopped, inside the transaction', async () => {
      const panelId = await panel();
      await ctx.container.database.db
        .update(tenants)
        .set({ status: 'STOPPED' })
        .where(eq(tenants.id, tenantA.tenantId));
      await expect(drain(panelId)).rejects.toMatchObject({ code: 'platform.tenant_not_found' });
      expect(await drainAudits(panelId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // The dashboard
  // -------------------------------------------------------------------------

  describe('the health dashboard', () => {
    it('shows each live panel with its services, failures and open conditions', async () => {
      const panelId = await panel();
      const other = await panel(tenantA, owner, 'Paris');
      const now = ctx.container.clock.now();

      // Services: written directly, as `panel-capacity.test.ts` does, because what is
      // under test is the COUNT, not how a service comes to exist. An order row is
      // required by the composite reference, so one draft per service is made the
      // ordinary way.
      const counts: Record<string, number> = { ACTIVE: 2, SUSPENDED: 1, TERMINATED: 3 };
      for (const [state, times] of Object.entries(counts)) {
        for (let i = 0; i < times; i += 1) await insertService(panelId, state);
      }

      // Provisioning: two FAILED inside the window (the newer names the kind), one
      // FAILED just outside it, one UNKNOWN, and one FAILED on the OTHER panel.
      const service = await insertService(panelId, 'ACTIVE');
      const otherService = await insertService(other, 'ACTIVE');
      await insertOperation(
        panelId,
        service,
        'FAILED',
        new Date(now.getTime() - 60_000),
        'TIMEOUT',
      );
      await insertOperation(
        panelId,
        service,
        'FAILED',
        new Date(now.getTime() - 3_600_000),
        'PROVIDER_ERROR',
      );
      await insertOperation(
        panelId,
        service,
        'FAILED',
        new Date(now.getTime() - PANEL_HEALTH_FAILURE_WINDOW_MS - 1),
        'PROVIDER_ERROR',
      );
      await insertOperation(panelId, service, 'UNKNOWN', null, null);
      await insertOperation(
        other,
        otherService,
        'FAILED',
        new Date(now.getTime() - 60_000),
        'TIMEOUT',
      );

      // An open health condition, recorded through the ordinary recorder under the
      // key the monitor uses.
      await ctx.container.opsLogWriter.record(tenantA, {
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        message: 'Panel "Frankfurt" is not answering.',
        dedupeKey: panelConditionKey('panel.health.unreachable', panelId),
        context: { panelId },
      });

      const page = await ctx.container.panelHealth.page(tenantA, operator, {});
      const row = page.rows.find((one) => one.panel.panel.id === panelId);
      expect(row?.stats.services).toEqual({
        active: 3,
        suspended: 1,
        expired: 0,
        pending: 0,
        unreconciled: 0,
      });
      expect(row?.stats.provisioning).toMatchObject({
        failedInWindow: 2,
        unknownOpen: 1,
        lastFailureKind: 'TIMEOUT',
      });
      expect(row?.conditions.map((c) => [c.code, c.severity])).toEqual([
        ['panel.health.unreachable', 'ERROR'],
      ]);
      const otherRow = page.rows.find((one) => one.panel.panel.id === other);
      expect(otherRow?.stats.provisioning.failedInWindow).toBe(1);
      expect(otherRow?.conditions).toEqual([]);
      expect(page.failureWindowMs).toBe(PANEL_HEALTH_FAILURE_WINDOW_MS);
    });

    it("never shows another tenant's panels or counts their rows", async () => {
      const mine = await panel();
      const foreign = await panel(tenantB, ownerB, 'Foreign');
      await ctx.container.opsLogWriter.record(tenantB, {
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        message: 'foreign',
        dedupeKey: panelConditionKey('panel.health.unreachable', foreign),
        context: { panelId: foreign },
      });
      const page = await ctx.container.panelHealth.page(tenantA, operator, {});
      expect(page.rows.map((row) => row.panel.panel.id)).toEqual([mine]);
      // And asking for tenant A's page with tenant B's keys finds nothing: the
      // condition reader is keyed by scope as well as by key.
      const leaked = await ctx.container.panelHealth.page(tenantA, owner, {});
      expect(leaked.rows.flatMap((row) => row.conditions)).toEqual([]);
    });

    it('refuses an actor without panels.view', async () => {
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'support-drain',
          roleKeys: ['support'],
        }),
      );
      await expect(ctx.container.panelHealth.page(tenantA, support, {})).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
    });

    it('lists every code the monitor and the capacity alerts can open', () => {
      // Derived, so it grows with the monitor; pinned here so a change is read.
      expect(PANEL_CONDITION_CODES).toContain('panel.health.unreachable');
      expect(PANEL_CONDITION_CODES).toContain('panel.health.auth_failed');
      expect(PANEL_CONDITION_CODES).toContain('panel.health.degraded');
      expect(PANEL_CONDITION_CODES).toContain('panel.capacity.full');
      // A recovery is not a condition anyone must act on.
      expect(PANEL_CONDITION_CODES).not.toContain('panel.health.recovered');
    });
  });

  // -------------------------------------------------------------------------
  // Fixtures written as rows
  // -------------------------------------------------------------------------

  async function insertService(panelId: string, state: string): Promise<string> {
    const customerTelegramId = String(900_700 + (n += 1));
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'panel-drain:test',
        surface: 'TELEGRAM',
        correlationId: `resolve-${customerTelegramId}` as CorrelationId,
      },
      {
        idempotencyKey: `resolve-${customerTelegramId}`,
        telegramUserId: customerTelegramId,
        from: { id: Number(customerTelegramId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    const { orderId, productId } = await draftOrder(customer.id, panelId);
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at, terminated_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customer.id}, ${orderId}, ${panelId}, ${productId},
              ${'u' + id.replace(/-/g, '').slice(0, 12)},
              ${id.replace(/-/g, '').slice(0, 32)},
              ${ctx.container.ids.uuid()}, 0, ${state},
              ${state === 'PENDING_PROVISION' || state === 'UNRECONCILED' ? null : new Date()},
              ${state === 'TERMINATED' ? new Date() : null})`);
    return id;
  }

  async function insertOperation(
    panelId: string,
    serviceId: string,
    state: 'FAILED' | 'UNKNOWN',
    completedAt: Date | null,
    failureKind: string | null,
  ): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id, panel_id,
                                           type, state, attempts, failure_kind, completed_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${(n += 1).toString(16).padStart(16, '0')},
              ${serviceId}, ${panelId}, 'SUSPEND', ${state}, 1, ${failureKind}, ${completedAt})`);
  }

  async function draftOrder(
    customerId: string,
    panelId: string,
  ): Promise<{ orderId: string; productId: string }> {
    await makePanelSellable(ctx.container, tenantA, panelId);
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(1_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(
      tenantA,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'panel-drain:test',
        surface: 'TELEGRAM',
        correlationId: k as CorrelationId,
      },
      { idempotencyKey: k, customerId: customerId as UserId, productId: created.id },
    );
    return { orderId: order.id, productId: created.id };
  }
});
