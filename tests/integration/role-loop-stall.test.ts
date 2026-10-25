import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import {
  LOOP_BOOT_GRACE_MS,
  LOOP_RECOVERY_CONFIRM_MS,
  LoopStallReporter,
} from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
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
      // These cases test the reporter's other rules; the boot grace and the recovery
      // confirmation have their own file (loop-stall-noise.test.ts).
      bootGraceMs: 0,
      recoveryConfirmMs: 0,
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
    // Persian throughout: the lane and the role by name, the lane's key on the technical line.
    expect(payload).toContain('بازگشت وجه سرویس‌ها');
    expect(payload).toContain('فرایند: سازندهٔ سرویس');
    expect(payload).toContain('job.loop_stalled · provisioner-service-refunds');
    expect(payload).not.toContain('processRole');

    refundsFail = false;
    await loop.tick();
    await reporter.observe(loop.laneStatuses(clock.now));
    found = await rows();
    expect(found.map((row) => row.code)).toEqual(['job.loop_stalled', 'job.loop_recovered']);
    expect(found[0]?.resolved_at).not.toBeNull();
  });

  /**
   * v0.8.2 hotfix, item 5, against the real condition table: a worker that restarts over and
   * over, each life seeing the same stalled loop, announces it ONCE. The first life opens the
   * condition; every later life lands on the still-open row (counted, not announced), because
   * no life stays fresh long enough to close it. The first life that does closes it, once.
   */
  it('announces a stall once across a restart storm and resolves it once', async () => {
    const owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-storm', roleKeys: ['owner'] }),
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: 'flag-ops-loop-storm',
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
    const clock = { now: ctx.container.clock.now().getTime() };
    const life = () =>
      new LoopStallReporter({
        recorder: ctx.container.opsLog,
        conditions: new DrizzleOperationalConditionReader(ctx.container.database.db),
        scope: () => tenantA as TenantContext,
        clock: { now: () => new Date(clock.now) },
        logger: { warn: () => undefined },
        role: 'worker',
      });
    const loop = 'backup-scheduler';

    for (let restart = 0; restart < 6; restart += 1) {
      const reporter = life();
      clock.now += LOOP_BOOT_GRACE_MS;
      await reporter.observe([{ name: loop, stalled: true }]);
      clock.now += 10_000;
      await reporter.observe([{ name: loop, stalled: false }]);
      clock.now += LOOP_RECOVERY_CONFIRM_MS - 20_000;
      await reporter.observe([{ name: loop, stalled: false }]);
      clock.now += 5_000;
    }

    const rows = async () =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT code, occurrence_count, resolved_at FROM operational_events
               WHERE tenant_id = ${tenantA.tenantId} AND code LIKE 'job.loop_%'
               ORDER BY first_seen_at, id`,
        )
      ).rows as { code: string; occurrence_count: number; resolved_at: Date | null }[];
    const announced = async () =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM notifications
               WHERE tenant_id = ${tenantA.tenantId}
                 AND template_key = 'ops.notification.operational_event'`,
        )
      ).rows[0] as { n: number };

    expect(await rows()).toEqual([
      { code: 'job.loop_stalled', occurrence_count: 6, resolved_at: null },
    ]);
    expect((await announced()).n).toBe(1);

    // A life that stays fresh for the whole window closes it, and says so once.
    const survivor = life();
    clock.now += LOOP_BOOT_GRACE_MS;
    for (let elapsed = 0; elapsed <= LOOP_RECOVERY_CONFIRM_MS; elapsed += 10_000) {
      await survivor.observe([{ name: loop, stalled: false }]);
      clock.now += 10_000;
    }
    const after = await rows();
    expect(after.map((row) => row.code)).toEqual(['job.loop_stalled', 'job.loop_recovered']);
    expect(after[0]?.resolved_at).not.toBeNull();
    expect((await announced()).n).toBe(2);
  });
});
