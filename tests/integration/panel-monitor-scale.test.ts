import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  DrizzlePanelMonitorRepository,
  dueForTenantsQuery,
} from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import {
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import { PanelMonitorService } from '../../apps/api/src/modules/platform/panels/application/panel-monitor.service';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import type { TenantContext } from '@nexa/contracts';
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
  let measuredPanelIds: string[] = [];

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

    // Only the FIRST tenant gets credentials, and only because the throughput
    // measurement below needs probes that reach the budget: a panel with no
    // usable credential is refused before a token is spent, which would measure
    // the refusal path rather than the bucket. Every other test here is about
    // the query plan and does not care.
    const store = new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher);
    const measured = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM panels WHERE tenant_id = ${tenantIds[0]!}::uuid`,
    );
    measuredPanelIds = measured.rows.map((row) => row.id);
    const measuredScope = {
      tenantId: tenantIds[0]! as TenantContext['tenantId'],
      botInstanceId: null,
    };
    await ctx.container.uow.run(measuredScope, async (tx) => {
      for (const id of measuredPanelIds) {
        await store.write(
          measuredScope,
          id,
          {
            username: 'scale-admin',
            password: 'scale-password-do-not-leak',
            apiToken: undefined,
          },
          now,
          tx,
        );
      }
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * The real monitor, pinned to one tenant, with a real probe budget.
   *
   * Everything below the discovery stub is production code: the due scan, the
   * per-panel claim, `takeProbeBudget`, the probe core and the health write.
   * Only the tenant claim is fixed, so the measurement is about one tenant's
   * throughput rather than the rotation across forty.
   */
  function monitorFor(
    tenantId: string,
    options: {
      probeBudget: { capacity: number; refillPerMs: number };
      clockRef: () => Date;
      discovery: DrizzlePanelMonitorRepository;
    },
  ): PanelMonitorService {
    const clock = { now: () => options.clockRef() };
    return new PanelMonitorService(
      {
        discovery: {
          claimTenants: async () => [tenantId],
          dueForTenants: options.discovery.dueForTenants.bind(options.discovery),
          refreshTenantBounds: options.discovery.refreshTenantBounds.bind(options.discovery),
          reconcileSchedules: async () => 0,
          overBudgetTenants: async () => [],
          activePanelCount: async () => 0,
        },
        probe: {
          repository: new DrizzlePanelRepository(ctx.container.database.db),
          credentials: new DrizzlePanelCredentialStore(
            ctx.container.database.db,
            ctx.container.cipher,
          ),
          uow: ctx.container.uow,
          clock,
          http: new SafeHttpClient({
            allowLoopback: true,
            totalTimeoutMs: 1_000,
            maxResponseBytes: 1_024,
            maxRetries: 0,
          }),
          urlPolicy: { allowLoopback: true },
          adapters: (type) => ({
            ...providerAdapter(type),
            // Instant, so any shortfall measured below is the BUDGET and not
            // the network — the most favourable latency an installation could
            // possibly have.
            probe: async () => ({ ok: true, providerVersion: '1.0.0', degraded: false }),
          }),
          probeCooldownMs: 0,
          probeBudget: options.probeBudget,
          cadence: {
            healthyIntervalMs: 10 * 60 * 1000,
            retryableIntervalMs: 2 * 60 * 1000,
            nonRetryableIntervalMs: 60 * 60 * 1000,
          },
        },
        guard: ctx.container.guard,
        audit: ctx.container.audit,
        opsLog: ctx.container.opsLog,
        sessions: ctx.container.sessions,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
        logger: ctx.container.logger,
        batchSize: 50,
        tenantsPerTick: 1,
        concurrency: 4,
        budgetReserve: 0,
        tenantBudgetUpperBound: 60,
        schedulerUpperBound: 1_000,
        capacityAssessmentIntervalMs: 10 * 60 * 1000,
      },
      30_000,
    );
  }

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
    it('cannot keep a 500-panel tenant fresh on the shipped budget, measured', async () => {
      // Codex's reproduction, run rather than argued. The real monitor, the
      // real probe budget and the real due scan, over ten simulated minutes of
      // an instant-answering provider — the most favourable latency there is,
      // so any shortfall is the BUDGET and not the network.
      const LIMIT = 30;
      const WINDOW = 300_000;
      const INTERVAL = 10 * 60 * 1000;
      const budgetBound = tenantBudgetFreshPanelUpperBound(LIMIT, WINDOW, INTERVAL);
      expect(budgetBound).toBe(60);

      const tenant = tenantIds[0]!;
      const real = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      let clock = new Date(now.getTime());

      const m = monitorFor(tenant, {
        probeBudget: { capacity: LIMIT, refillPerMs: LIMIT / WINDOW },
        clockRef: () => clock,
        discovery: real,
      });

      // Twenty ticks of thirty seconds: one whole healthy interval.
      for (let tick = 0; tick < INTERVAL / 30_000; tick += 1) {
        await m.tick();
        clock = new Date(clock.getTime() + 30_000);
      }

      // Measured on the artifact the promise is about: how many of this
      // tenant's panels have a health row at all after one full interval.
      const stored = await ctx.container.database.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM panel_health h
          JOIN panels p ON p.id = h.panel_id
         WHERE p.tenant_id = ${tenant}::uuid
      `);
      const refreshed = stored.rows[0]?.n ?? 0;

      // Anti-vacuity: the loop really probed, so "fewer than 500" is a
      // measurement and not an empty set.
      expect(refreshed).toBeGreaterThan(0);
      // The bucket starts full and refills at six a minute, so ten minutes buys
      // about 30 + 60 probes. Nowhere near 500 — this tenant cannot have all
      // its health rows fresh at any moment, whatever the batch size is.
      expect(refreshed).toBeLessThan(PANELS_PER_TENANT);
      expect(refreshed).toBeLessThanOrEqual(LIMIT + (INTERVAL / WINDOW) * LIMIT);
      // And the shortfall is an order of magnitude, not a rounding error.
      expect(refreshed * 4).toBeLessThan(PANELS_PER_TENANT);
    });

    it('reports a tenant over its own BUDGET ceiling', async () => {
      const budgetBound = tenantBudgetFreshPanelUpperBound(30, 300_000, 10 * 60 * 1000);
      expect(budgetBound).toBe(60);

      const repo = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      const over = await repo.overBudgetTenants(budgetBound);
      expect(over.length).toBeGreaterThan(0);
      for (const tenant of over) expect(tenant.panels).toBeGreaterThan(budgetBound);

      // A bucket large enough for this population clears the per-tenant report.
      expect(await repo.overBudgetTenants(600)).toHaveLength(0);
    });

    it('sees an installation-wide overload that every per-tenant check passes', async () => {
      // The gap a per-tenant scheduler bound hides. The batch is a GLOBAL cap
      // shared among the tenants claimed each tick, so an installation can be
      // made entirely of tenants that are individually fine and still ask the
      // loop to start more probes per interval than it possibly can.
      //
      // Built to be unambiguous: every tenant well under its budget ceiling,
      // the total well over the scheduler's.
      const budgetBound = tenantBudgetFreshPanelUpperBound(30, 300_000, 10 * 60 * 1000);
      const schedulerBound = schedulerFreshPanelUpperBound(50, 30_000, 10 * 60 * 1000);
      expect(budgetBound).toBe(60);
      expect(schedulerBound).toBe(1_000);

      const repo = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      const perTenant = await ctx.container.database.db.execute<{ n: number }>(sql`
        SELECT max(c)::int AS n FROM (
          SELECT count(*) AS c FROM panels WHERE status = 'ACTIVE' GROUP BY tenant_id
        ) AS t
      `);
      const total = await repo.activePanelCount();

      // This fixture is 40 x 500, so it is over on both dimensions; the point
      // being asserted is that the two are measured SEPARATELY and that the
      // installation total is a real, larger number.
      expect(total).toBe(TOTAL);
      expect(total).toBeGreaterThan(schedulerBound);
      expect(perTenant.rows[0]?.n).toBe(PANELS_PER_TENANT);

      // And the shape Codex's example describes: raise the per-tenant bound
      // above every tenant's population and the per-tenant report goes quiet,
      // while the installation is still far past what the scheduler can start.
      expect(await repo.overBudgetTenants(PANELS_PER_TENANT)).toHaveLength(0);
      expect(total).toBeGreaterThan(schedulerBound);
    });
  });
});
