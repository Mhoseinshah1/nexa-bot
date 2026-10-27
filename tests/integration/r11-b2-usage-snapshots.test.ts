import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_SNAPSHOT_BUCKET_MINUTES,
  USAGE_SNAPSHOT_RETENTION_DAYS,
  type ActorContext,
} from '@nexa/contracts';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';
import { harnessFor, rickPanel, seedFleet, seedPanelUser } from './usage-sync-fixtures';

/**
 * R11 B2: the usage snapshots behind the mini app's chart, at the database.
 *
 * Real PostgreSQL, the PRODUCTION provisioner (`harnessFor` builds it from the container's own
 * dependencies), the real RickPanel adapter against a deterministic RickPanel on a socket.
 * The rules, each with the case that fails when it is reverted:
 *
 *   1. a snapshot is recorded from the read the scheduled sync ALREADY makes, and the panel
 *      is asked exactly as often with the feature on as with it off (no extra call);
 *   2. one snapshot per service per hour -- the first figure of a bucket is kept;
 *   3. rows past the retention are deleted by the provisioner's tick, a bounded batch at a
 *      time, whatever the flag says, and fresh rows stay;
 *   4. flag off: nothing is written.
 */

const HOUR = USAGE_SNAPSHOT_BUCKET_MINUTES * 60_000;
const DAY = 86_400_000;
const FIVE_YEARS_AGO = new Date(Date.now() - 5 * 365 * DAY);

describe('R11 B2: usage snapshots', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let panelId: string;
  let flagSeq = 0;

  beforeAll(async () => {
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      PANEL_HTTP_TIMEOUT_MS: '1000',
      PANEL_PROBE_TENANT_LIMIT: '100',
      PANEL_PROBE_TENANT_WINDOW_MS: '300000',
      PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '40',
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-b2', roleKeys: ['owner'] }),
    );
    panelId = await rickPanel(ctx, tenantA, owner, panel, 'b2');
    await validatePanelConnection(ctx.container, tenantA, panelId);
  });

  async function setChart(enabled: boolean): Promise<void> {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'service_usage_chart');
    flagSeq += 1;
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'service_usage_chart',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: `b2-flag-${String(flagSeq)}`,
      reason: 'R11 B2 test',
    });
  }

  async function fleet(count: number, prefix = 'chart'): Promise<string[]> {
    const names = await seedFleet(ctx, tenantA.tenantId, panelId, {
      count,
      prefix,
      createdBefore: FIVE_YEARS_AGO,
    });
    names.forEach((name, i) => seedPanelUser(panel, name, 1_000 * (i + 1)));
    return names;
  }

  interface SnapshotRow {
    readonly service_id: string;
    readonly bucket_at: Date;
    readonly taken_at: Date;
    readonly used_bytes: string;
    readonly total_bytes: string | null;
    readonly expires_at: Date | null;
  }

  async function snapshots(): Promise<SnapshotRow[]> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<SnapshotRow>(
        `SELECT service_id, bucket_at, taken_at, used_bytes::text, total_bytes::text, expires_at
           FROM service_usage_snapshots WHERE tenant_id = $1::uuid ORDER BY bucket_at, service_id`,
        [tenantA.tenantId],
      ),
    );
    return result.rows;
  }

  async function firstServiceId(): Promise<string> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<{ id: string }>(
        'SELECT id FROM services WHERE tenant_id = $1::uuid ORDER BY created_at LIMIT 1',
        [tenantA.tenantId],
      ),
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('no service');
    return id;
  }

  const userReads = (): number =>
    panel.requests.filter((one) => one.method === 'GET' && /^\/api\/user\/[^/]+$/.test(one.path))
      .length;

  /** Records through the PRODUCTION service, inside a transaction, as a caller does. */
  async function record(serviceId: string, usedBytes: bigint, at: Date): Promise<boolean> {
    return ctx.container.uow.run(tenantA, (tx) =>
      ctx.container.usageSnapshots.record(tenantA, serviceId, { usedBytes, at }, tx),
    );
  }

  it('records a snapshot from the usage read the scheduled sync already makes, with no extra panel call', async () => {
    const names = await fleet(3);
    const start = new Date();
    const h = harnessFor(ctx, tenantA, start);

    // Round 1, flag OFF: the sync reads three accounts and stores no snapshot.
    await h.loop.tick();
    const readsOff = userReads();
    const requestsOff = panel.requests.length;
    expect(readsOff, 'one read per service').toBe(names.length);
    expect(await snapshots(), 'flag off: nothing written').toEqual([]);

    // Round 2, flag ON, a cadence later: the SAME number of panel requests, plus snapshots.
    await setChart(true);
    h.clock.advanceMs(5 * 3_600_000);
    await h.loop.tick();
    expect(userReads() - readsOff, 'the panel is asked as often with the chart on').toBe(readsOff);
    expect(panel.requests.length - requestsOff, 'and no other kind of request').toBe(requestsOff);
    const rows = await snapshots();
    expect(rows).toHaveLength(names.length);
    expect(rows.map((row) => row.used_bytes).sort()).toEqual(['1000', '2000', '3000']);
    for (const row of rows) {
      expect(row.taken_at.getTime()).toBe(h.clock.now().getTime());
      expect(row.bucket_at.getTime()).toBe(Math.floor(h.clock.now().getTime() / HOUR) * HOUR);
      expect(row.total_bytes, 'the service row’s allowance').toBe('53687091200');
      expect(row.expires_at, 'a service with no deadline').toBeNull();
    }
  }, 120_000);

  it('keeps one snapshot per service per hour: the first figure of the bucket stays', async () => {
    await setChart(true);
    await fleet(1);
    const serviceId = await firstServiceId();
    const hourStart = new Date(Math.floor(Date.now() / HOUR) * HOUR + 7 * 60_000);

    expect(await record(serviceId, 100n, hourStart)).toBe(true);
    expect(
      await record(serviceId, 250n, new Date(hourStart.getTime() + 30 * 60_000)),
      'same hour: nothing inserted',
    ).toBe(false);
    expect(await record(serviceId, 100n, hourStart), 'a replay inserts nothing').toBe(false);
    let rows = await snapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used_bytes, 'the first figure of the hour').toBe('100');

    expect(await record(serviceId, 400n, new Date(hourStart.getTime() + HOUR))).toBe(true);
    rows = await snapshots();
    expect(rows.map((row) => row.used_bytes)).toEqual(['100', '400']);
  }, 60_000);

  it('writes nothing for a service that is not ACTIVE', async () => {
    await setChart(true);
    await fleet(1);
    const serviceId = await firstServiceId();
    await ctx.container.database.withClient((client) =>
      client.query("UPDATE services SET state = 'SUSPENDED' WHERE id = $1::uuid", [serviceId]),
    );
    expect(await record(serviceId, 100n, new Date())).toBe(false);
    expect(await snapshots()).toEqual([]);
  }, 60_000);

  it('writes nothing while the feature flag is off', async () => {
    await fleet(1);
    const serviceId = await firstServiceId();
    expect(await record(serviceId, 100n, new Date())).toBe(false);
    expect(await snapshots()).toEqual([]);
  }, 60_000);

  it('deletes snapshots older than the retention on the provisioner tick and keeps the rest', async () => {
    // Flag OFF on purpose: retention applies to what was stored before the flag went off.
    await fleet(1);
    const serviceId = await firstServiceId();
    const now = Date.now();
    const ages = [
      USAGE_SNAPSHOT_RETENTION_DAYS * DAY + 2 * HOUR,
      USAGE_SNAPSHOT_RETENTION_DAYS * DAY + 40 * DAY,
      USAGE_SNAPSHOT_RETENTION_DAYS * DAY - 2 * HOUR,
      10 * DAY,
      HOUR,
    ];
    for (const [i, age] of ages.entries()) {
      const takenAt = new Date(now - age);
      await ctx.container.database.withClient((client) =>
        client.query(
          `INSERT INTO service_usage_snapshots
             (tenant_id, service_id, bucket_at, taken_at, used_bytes, total_bytes, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz, $4, NULL, NULL)`,
          [tenantA.tenantId, serviceId, takenAt.toISOString(), 100 + i],
        ),
      );
    }
    expect(await snapshots()).toHaveLength(5);

    const h = harnessFor(ctx, tenantA, new Date());
    await h.executor.runOnce(tenantA);

    expect((await snapshots()).map((row) => row.used_bytes)).toEqual(['102', '103', '104']);
  }, 60_000);

  it('prunes in bounded batches, never the whole backlog in one tick', async () => {
    await fleet(1);
    const serviceId = await firstServiceId();
    const old = new Date(Date.now() - (USAGE_SNAPSHOT_RETENTION_DAYS + 40) * DAY);
    await ctx.container.database.withClient((client) =>
      client.query(
        `INSERT INTO service_usage_snapshots
           (tenant_id, service_id, bucket_at, taken_at, used_bytes)
         SELECT $1::uuid, $2::uuid, $3::timestamptz + make_interval(hours => g),
                $3::timestamptz + make_interval(hours => g), g
           FROM generate_series(1, 700) AS g`,
        [tenantA.tenantId, serviceId, old.toISOString()],
      ),
    );
    const pruned = await ctx.container.uow.run(tenantA, (tx) =>
      ctx.container.usageSnapshots.prune(tenantA, tx),
    );
    expect(pruned, 'one batch').toBe(500);
    expect(await snapshots()).toHaveLength(200);
  }, 60_000);
});
