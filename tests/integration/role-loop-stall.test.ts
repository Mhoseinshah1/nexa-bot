import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { LoopStallReporter } from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import {
  ProvisionerLoop,
  STALE_TICK_MULTIPLE,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import type { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * FIX-03 (batch 2026-10-10): a provisioner lane that fails on every tick opens
 * `job.loop_stalled` in the real operations log, naming the lane and the role, queues one
 * group message to the SYSTEM topic, and is resolved by `job.loop_recovered` once the lane
 * succeeds again. The lane is a fake that throws; the recorder, the condition reader, the
 * group projection and the tables are real.
 */
describe('a stalled provisioner lane in the operations log', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const TICK_MS = 5_000;

  it('opens the condition once with the lane named, and resolves it on recovery', async () => {
    const owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-ops', roleKeys: ['owner'] }),
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: 'flag-ops-role-stall',
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });

    const clock = { now: ctx.container.clock.now().getTime() };
    let refundsFail = true;
    const ok = { settleDue: async () => 0 };
    const loop = new ProvisionerLoop(
      { runOnce: async () => ({ kind: 'IDLE' }) } as unknown as ProvisionerService,
      { deliverDue: async () => undefined } as unknown as DeliveryService,
      {
        announce: async () => undefined,
        announceDue: async () => undefined,
      } as unknown as OperationOutcomeAnnouncer,
      {
        scope: () => tenantA as TenantContext,
        cashback: ok,
        referrals: ok,
        serviceRefunds: {
          settleDue: async () => {
            if (refundsFail) throw new Error('refund row failed');
            return 0;
          },
        },
        tickMs: TICK_MS,
        now: () => clock.now,
        logger: { info: () => undefined, error: () => undefined },
      },
    );
    const reporter = new LoopStallReporter({
      recorder: ctx.container.opsLog,
      conditions: new DrizzleOperationalConditionReader(ctx.container.database.db),
      scope: () => tenantA as TenantContext,
      clock: { now: () => new Date(clock.now) },
      logger: { warn: () => undefined },
      role: 'provisioner',
    });

    await loop.tick();
    clock.now += TICK_MS * STALE_TICK_MULTIPLE + 1;
    await loop.tick();
    await reporter.observe(loop.laneStatuses(clock.now));
    // A second heartbeat inside the re-record interval adds nothing.
    await reporter.observe(loop.laneStatuses(clock.now));

    const rows = async () =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT code, dedupe_key, context, occurrence_count, resolved_at
                FROM operational_events
               WHERE tenant_id = ${tenantA.tenantId} AND code LIKE 'job.loop_%'
               ORDER BY first_seen_at, id`,
        )
      ).rows as {
        code: string;
        dedupe_key: string | null;
        context: Record<string, unknown>;
        occurrence_count: number;
        resolved_at: Date | null;
      }[];

    let found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'job.loop_stalled',
      dedupe_key: 'job.loop_stalled:provisioner-service-refunds',
      context: { kind: 'provisioner-service-refunds', processRole: 'provisioner' },
      occurrence_count: 1,
      resolved_at: null,
    });

    const queued = (
      await ctx.container.database.db.execute(
        sql`SELECT template_key, destination, payload FROM notifications
             WHERE tenant_id = ${tenantA.tenantId}
               AND template_key = 'ops.notification.operational_event'`,
      )
    ).rows as { template_key: string; destination: { opsTopic?: string }; payload: unknown }[];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.destination.opsTopic).toBe('SYSTEM');
    const payload = JSON.stringify(queued[0]?.payload);
    expect(payload).toContain('processRole: provisioner');
    expect(payload).toContain('kind: provisioner-service-refunds');

    refundsFail = false;
    await loop.tick();
    await reporter.observe(loop.laneStatuses(clock.now));
    found = await rows();
    expect(found.map((row) => row.code)).toEqual(['job.loop_stalled', 'job.loop_recovered']);
    expect(found[0]?.resolved_at).not.toBeNull();
  });
});
