import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROCESS_RESTART_STORM_CODE,
  PROCESS_RESTART_STORM_ENDED_CODE,
  PROCESS_RUN_STABLE_AFTER_MS,
  type TenantContext,
} from '@nexa/contracts';
import { startProcessRestartWatch } from '../../apps/api/src/bootstrap';
import { ProcessRestartWatch } from '../../apps/api/src/modules/platform/opslog/application/process-restart-watch';
import { recordBoot } from '../../apps/api/src/modules/platform/opslog/application/process-run-state';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { DrizzleProcessRunStore } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-process-run.store';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R11 A3, against the real tables: a role that crashes within seconds, again and again, is
 * announced ONCE in the operations group — the `process_runs` row is the memory that
 * survives each crash, the operational-events dedupe row is what stops a restarted process
 * announcing twice — and a life that stays up a minute closes it. The recorder, the
 * condition reader, the group projection and the run store are real; time is fake.
 */
describe('a crash-looping role in the operations log', () => {
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

  const db = () => ctx.container.database.db;

  async function enableOpsGroup(label: string): Promise<void> {
    const owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: `owner-${label}`,
        roleKeys: ['owner'],
      }),
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: `flag-ops-${label}`,
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
  }

  /** One process life of `role`, built as `startProcessRestartWatch` builds it, on a fake clock. */
  function life(role: string, clock: { now: number }, id: number): ProcessRestartWatch {
    return new ProcessRestartWatch({
      role,
      store: new DrizzleProcessRunStore(db()),
      recorder: ctx.container.opsLog,
      conditions: new DrizzleOperationalConditionReader(db()),
      scope: () => tenantA as TenantContext,
      clock: { now: () => new Date(clock.now) },
      newRunId: () => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      logger: { warn: () => undefined },
      every: () => ({ stop: () => undefined }),
    });
  }

  const stormRows = async () =>
    (
      await db().execute(
        sql`SELECT code, dedupe_key, context, occurrence_count, resolved_at
              FROM operational_events
             WHERE tenant_id = ${tenantA.tenantId} AND code LIKE 'process.restart_storm%'
             ORDER BY first_seen_at, id`,
      )
    ).rows as {
      code: string;
      dedupe_key: string | null;
      context: Record<string, unknown>;
      occurrence_count: number;
      resolved_at: Date | null;
    }[];

  const groupMessages = async () =>
    (
      await db().execute(
        sql`SELECT destination, payload FROM notifications
             WHERE tenant_id = ${tenantA.tenantId}
               AND template_key = 'ops.notification.operational_event'
             ORDER BY created_at, id`,
      )
    ).rows as { destination: { opsTopic?: string }; payload: unknown }[];

  it('announces twelve quick restarts once, in Persian, and closes it once when a life stays up', async () => {
    await enableOpsGroup('storm');
    const clock = { now: ctx.container.clock.now().getTime() };

    for (let boot = 1; boot <= 12; boot += 1) {
      await life('worker', clock, boot).start();
      clock.now += 13_000; // v0.8.2's worker died every ~13 s
    }

    let rows = await stormRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: PROCESS_RESTART_STORM_CODE,
      dedupe_key: 'process.restart_storm:worker',
      resolved_at: null,
      // Boots 4..12 each recorded the condition; only the first was a message.
      occurrence_count: 9,
      context: { processRole: 'worker', restarts: 11, windowMinutes: 5 },
    });
    let messages = await groupMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.destination.opsTopic).toBe('SYSTEM');
    const payload = JSON.stringify(messages[0]?.payload);
    expect(payload).toContain('سرویس کارگر پس‌زمینه پی‌درپی ری‌استارت می‌شود');
    expect(payload).toContain('process.restart_storm · worker');

    // Life 13 stays up.
    const stable = life('worker', clock, 13);
    await stable.start();
    clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    await stable.check();
    rows = await stormRows();
    expect(rows.map((row) => row.code)).toEqual([
      PROCESS_RESTART_STORM_CODE,
      PROCESS_RESTART_STORM_ENDED_CODE,
    ]);
    expect(rows[0]?.resolved_at).not.toBeNull();
    messages = await groupMessages();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[1]?.payload)).toContain('دوباره پایدار شد');
  });

  it('a second storm after quiet is a second message', async () => {
    await enableOpsGroup('second');
    const clock = { now: ctx.container.clock.now().getTime() };
    let id = 0;
    const storm = async () => {
      for (let boot = 0; boot < 5; boot += 1) {
        await life('worker', clock, (id += 1)).start();
        clock.now += 13_000;
      }
    };
    await storm();
    const stable = life('worker', clock, (id += 1));
    await stable.start();
    clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    await stable.check();
    clock.now += 3_600_000;
    await storm();

    expect((await stormRows()).map((row) => row.code)).toEqual([
      PROCESS_RESTART_STORM_CODE,
      PROCESS_RESTART_STORM_ENDED_CODE,
    ]);
    // The failure row is REOPENED (counted on, not duplicated); the group saw it twice.
    const failure = (await stormRows())[0];
    expect(failure?.resolved_at).toBeNull();
    const messages = await groupMessages();
    expect(messages).toHaveLength(3);
  });

  it('two roles keep separate rows and separate conditions', async () => {
    await enableOpsGroup('roles');
    const clock = { now: ctx.container.clock.now().getTime() };
    for (let boot = 1; boot <= 5; boot += 1) {
      await life('worker', clock, boot).start();
      await life('monitor', clock, 100 + boot).start();
      clock.now += 13_000;
    }
    const rows = await stormRows();
    expect(rows.map((row) => row.dedupe_key).sort()).toEqual([
      'process.restart_storm:monitor',
      'process.restart_storm:worker',
    ]);
    const runs = (await db().execute(sql`SELECT role FROM process_runs ORDER BY role`)).rows;
    expect(runs).toEqual([{ role: 'monitor' }, { role: 'worker' }]);
  });
});

describe('the run store', () => {
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

  it('serialises boots of one role: twenty at once are twenty lives in a row, none lost', async () => {
    const store = new DrizzleProcessRunStore(ctx.container.database.db);
    const now = new Date('2026-10-27T10:00:00.000Z');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.transact('worker', (previous) =>
          recordBoot(
            previous,
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            new Date(now.getTime() + index * 1_000),
          ),
        ),
      ),
    );
    const row = (
      await ctx.container.database.db.execute(
        sql`SELECT restarts FROM process_runs WHERE role = 'worker'`,
      )
    ).rows[0] as { restarts: number };
    // The first boot found no row; each of the other nineteen found a crashed life before it.
    expect(row.restarts).toBe(19);
  });

  it('writes nothing when the change returns null', async () => {
    const store = new DrizzleProcessRunStore(ctx.container.database.db);
    expect(await store.transact('worker', () => null)).toBeNull();
    const rows = (await ctx.container.database.db.execute(sql`SELECT role FROM process_runs`)).rows;
    expect(rows).toEqual([]);
  });

  it('refuses a role name that is not a role (the table constraint)', async () => {
    const store = new DrizzleProcessRunStore(ctx.container.database.db);
    await expect(
      store.transact('Not A Role', (previous) =>
        recordBoot(previous, '00000000-0000-4000-8000-000000000001', new Date()),
      ),
    ).rejects.toThrow();
  });
});

describe('startProcessRestartWatch, as the roles call it', () => {
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

  it('writes this life before it returns, and a clean stop marks it', async () => {
    ctx.container.setInstallationTenant(tenantA.tenantId);
    const watch = await startProcessRestartWatch(ctx.container, 'monitor');
    const read = async () =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT role, restarts, stable_at, stopped_at FROM process_runs`,
        )
      ).rows as {
        role: string;
        restarts: number;
        stable_at: Date | null;
        stopped_at: Date | null;
      }[];
    let rows = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'monitor',
      restarts: 0,
      stable_at: null,
      stopped_at: null,
    });
    await watch.stop();
    rows = await read();
    expect(rows[0]?.stopped_at).not.toBeNull();
  });
});
