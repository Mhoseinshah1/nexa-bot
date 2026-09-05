import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  DrizzlePanelMonitorRepository,
  dueForTenantsQuery,
} from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { sustainableFreshPanels } from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import { createTestContext, SEED_IDS, type TestContext } from './harness';

/**
 * The scheduler at a size no unit test can express.
 *
 * The property under test is not "the result is short" — `LIMIT 50` guarantees
 * that whatever the query does underneath. It is that the DATABASE does bounded
 * work: the first Phase 3C design ranked every due panel on the installation
 * with a window function and then took fifty of them, so a hundred thousand
 * overdue panels meant a hundred thousand rows ranked and sorted every thirty
 * seconds to probe fifty. `result.length <= batchSize` passed the whole time.
 *
 * So this asserts the PLAN, from `EXPLAIN (ANALYZE, BUFFERS)`, over exactly the
 * statement the repository issues — imported, not retyped, because a retyped
 * query goes on proving a plan for code that no longer exists.
 *
 * The fixture is built with direct inserts. The subject is the query plan, and
 * driving thirty thousand panels through the service would test the service.
 */

const TENANTS = 40;
const PANELS_PER_TENANT = 500;
const TOTAL = TENANTS * PANELS_PER_TENANT;

interface PlanNode {
  'Node Type': string;
  'Actual Rows': number;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

describe('the panel monitor scheduler at scale', () => {
  let ctx: TestContext;
  const now = new Date('2026-06-01T00:00:00.000Z');
  let tenantIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();

    // 40 tenants x 500 panels. Enough that an unbounded plan is unmistakable in
    // the row counts and small enough to build in a second or two.
    tenantIds = Array.from(
      { length: TENANTS },
      (_, i) => `01a10000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );

    await ctx.container.database.withClient(async (client) => {
      await client.query(
        // Reseller sub-tenants of the seeded primary: the schema requires a
        // non-PRIMARY tenant to name a parent, which is the shape a real
        // multi-tenant installation has anyway.
        `INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name)
         SELECT id, 'RESELLER_BOT', $2::uuid, 'scale-' || ord, 'Scale ' || ord
           FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)`,
        [tenantIds, SEED_IDS.tenantA],
      );
      // Panels, then schedules, then rotation rows — the same shape the
      // application maintains, built in bulk.
      await client.query(
        `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
         SELECT gen_random_uuid(), t.id, 'panel-' || t.id || '-' || g, 'marzban',
                'https://panel.example.test', 'ACTIVE'
           FROM unnest($1::uuid[]) AS t(id)
           CROSS JOIN generate_series(1, $2::int) AS g`,
        [tenantIds, PANELS_PER_TENANT],
      );
      await client.query(
        `INSERT INTO panel_monitor_schedule
           (panel_id, tenant_id, next_eligible_at, consecutive_failures, updated_at)
         SELECT p.id, p.tenant_id, $1::timestamptz - (random() * interval '1 hour'), 0, $1::timestamptz
           FROM panels p`,
        [now],
      );
      await client.query(
        `INSERT INTO panel_monitor_tenants (tenant_id, next_eligible_at, last_served_at)
         SELECT tenant_id, MIN(next_eligible_at), to_timestamp(0)
           FROM panel_monitor_schedule GROUP BY tenant_id`,
      );
      await client.query('ANALYZE panels, panel_monitor_schedule, panel_monitor_tenants');
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('built the fixture it claims to have built', async () => {
    // A plan assertion over an empty table proves nothing, so the size is
    // checked rather than assumed.
    const rows = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM panel_monitor_schedule`,
    );
    expect(rows.rows[0]?.n).toBe(TOTAL);
  });

  it('reads only the rows it returns, not the whole due population', async () => {
    const claimed = tenantIds.slice(0, 10);
    const perTenant = 5;
    const batchSize = 50;

    const explained = await ctx.container.database.db.execute<{
      'QUERY PLAN': [{ Plan: PlanNode }];
    }>(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dueForTenantsQuery(claimed, now, perTenant, batchSize)}`,
    );
    const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
    expect(plan).toBeDefined();

    const nodes: PlanNode[] = [];
    walk(plan!, (node) => nodes.push(node));

    // 1. The schedule is reached by an INDEX, never a sequential scan. A
    //    sequential scan here is the unbounded shape by definition.
    const scheduleScans = nodes.filter((n) => n['Relation Name'] === 'panel_monitor_schedule');
    expect(scheduleScans.length).toBeGreaterThan(0);
    for (const scan of scheduleScans) {
      expect(scan['Node Type'], JSON.stringify(scan)).not.toBe('Seq Scan');
      expect(scan['Index Name']).toBe('panel_monitor_schedule_due_idx');
    }

    // 2. Rows actually read from the schedule are bounded by
    //    `tenants x perTenant`, NOT by the 20 000 rows that are due. This is
    //    the assertion the old window-function plan could never pass.
    const scheduleRows = scheduleScans.reduce((sum, scan) => sum + scan['Actual Rows'], 0);
    expect(scheduleRows).toBeLessThanOrEqual(claimed.length * perTenant);
    expect(scheduleRows).toBeLessThan(TOTAL / 10);

    // 3. Nothing in the plan sorts or ranks the due population. A `WindowAgg`
    //    or a large `Sort` is exactly what this design removed.
    for (const node of nodes) {
      expect(node['Node Type'], JSON.stringify(node)).not.toBe('WindowAgg');
      if (node['Node Type'] === 'Sort') {
        expect(node['Actual Rows']).toBeLessThanOrEqual(claimed.length * perTenant);
      }
    }
  });

  it('does the same bounded work whether ten panels are due or twenty thousand', async () => {
    // The scaling claim, measured rather than argued: read the plan for one
    // tenant, then make a hundred times as many panels due, and read it again.
    const one = tenantIds.slice(0, 1);
    const rowsRead = async (): Promise<number> => {
      const explained = await ctx.container.database.db.execute<{
        'QUERY PLAN': [{ Plan: PlanNode }];
      }>(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dueForTenantsQuery(one, now, 5, 50)}`);
      let total = 0;
      walk(explained.rows[0]!['QUERY PLAN'][0]!.Plan, (node) => {
        if (node['Relation Name'] === 'panel_monitor_schedule') total += node['Actual Rows'];
      });
      return total;
    };

    const before = await rowsRead();
    // Every panel of every tenant is now overdue by an hour.
    await ctx.container.database.withClient((client) =>
      client.query(
        `UPDATE panel_monitor_schedule SET next_eligible_at = $1::timestamptz - interval '1 hour'`,
        [now],
      ),
    );
    const after = await rowsRead();

    // The claim is that the work does not GROW with the due population, so the
    // two are compared to each other rather than to a magic number.
    expect(after).toBe(before);
    // And both are the per-tenant share, plus the one row an index scan reads
    // past its limit to know it has finished.
    expect(before).toBeLessThanOrEqual(5 + 1);
  });

  it('gives every due tenant a turn within the documented bound', async () => {
    // The fairness guarantee, at a size where it can actually fail: more due
    // tenants than one tick claims. With `d` due tenants and `t` claimed per
    // tick, no tenant waits longer than `ceil(d / t)` ticks — and the previous
    // test only ever proved "two tenants, batch of two", which a static
    // oldest-first ordering also passes.
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const perTick = 12;
    const bound = Math.ceil(TENANTS / perTick);

    const served = new Set<string>();
    for (let round = 0; round < bound; round += 1) {
      const claimed = await discovery.claimTenants(
        new Date(now.getTime() + round * 30_000),
        perTick,
      );
      for (const id of claimed) served.add(id);
    }

    // Every one of the forty, inside ceil(40 / 12) = 4 ticks.
    expect(served.size).toBe(TENANTS);
    for (const id of tenantIds) expect(served.has(id), id).toBe(true);
  });

  it('does not let a deep-backlog tenant crowd out a shallow one', async () => {
    // The shape the brief names: tenants 1-39 with a deep older backlog, one
    // tenant with a single due panel. Under a static oldest-first ordering the
    // shallow tenant never gets a turn; under rotation it gets one within the
    // bound.
    const shallow = tenantIds[TENANTS - 1]!;
    await ctx.container.database.withClient(async (client) => {
      // Everyone else is much older, and has been waiting much longer.
      await client.query(
        `UPDATE panel_monitor_schedule SET next_eligible_at = $1::timestamptz - interval '10 days'
          WHERE tenant_id <> $2`,
        [now, shallow],
      );
      await client.query(
        `UPDATE panel_monitor_tenants
            SET next_eligible_at = $1::timestamptz - interval '10 days',
                last_served_at = to_timestamp(0)
          WHERE tenant_id <> $2`,
        [now, shallow],
      );
      // The shallow tenant is due, but only just, and was served most recently.
      await client.query(
        `UPDATE panel_monitor_tenants
            SET next_eligible_at = $1::timestamptz - interval '1 minute',
                last_served_at = $1::timestamptz - interval '1 minute'
          WHERE tenant_id = $2`,
        [now, shallow],
      );
    });

    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const perTick = 12;
    let servedAtRound: number | null = null;
    for (let round = 0; round < Math.ceil(TENANTS / perTick); round += 1) {
      const claimed = await discovery.claimTenants(
        new Date(now.getTime() + round * 30_000),
        perTick,
      );
      if (claimed.includes(shallow)) {
        servedAtRound = round;
        break;
      }
    }
    expect(servedAtRound).not.toBeNull();
  });

  describe('the freshness promise is a throughput promise too', () => {
    it('reports the tenants whose population its bucket cannot keep fresh', async () => {
      // Codex's reproduction, made deterministic. The cadence check at boot
      // proves a PROBED panel is refreshed in time; it cannot prove every panel
      // gets probed, which the tenant's bucket decides. With the shipped
      // defaults — 30 tokens per 5 minutes, a 10-minute healthy interval — the
      // sustainable population is 60 panels per tenant, so a tenant with 500
      // healthy panels cannot have them all fresh at any moment however the
      // batch size, tick and concurrency are tuned: there are only six tokens a
      // minute to spend.
      const sustainable = sustainableFreshPanels(30, 300_000, 10 * 60 * 1000);
      expect(sustainable).toBe(60);

      const repo = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      const over = await repo.overCapacityTenants(sustainable);
      // The fixture builds 40 tenants of 500 ACTIVE panels each.
      expect(over.length).toBeGreaterThan(0);
      for (const tenant of over) expect(tenant.panels).toBeGreaterThan(sustainable);

      // And the bound is not a fixed number: a bigger bucket supports more.
      expect(sustainableFreshPanels(300, 300_000, 10 * 60 * 1000)).toBe(600);
      expect(await repo.overCapacityTenants(600)).toHaveLength(0);
    });
  });
});
