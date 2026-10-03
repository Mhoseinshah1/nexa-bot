import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuditLogReader } from '../../apps/api/src/modules/platform/audit/infrastructure/drizzle-audit-log.reader';
import type { AuditLogFilter } from '../../apps/api/src/modules/platform/audit/application/ports';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The audit log browser's statements, asked of the PLANNER (Phase D1, `docs/audit-log.md`).
 *
 * The four `audit_logs_tenant_*_page_idx` indexes are built outside the migrator
 * (`online-indexes.ts`), and `online-indexes.test.ts` asserts they exist. Only a plan can
 * say whether the statements `DrizzleAuditLogReader` actually sends reach them — a filtered
 * scan of the tenant's whole log returns the same rows, and `customers-plan.test.ts` records
 * an index a repository claimed and the planner ignored for a year.
 *
 * Two tenants of 30 000 rows each, with the shapes a real log has: many actions, a few
 * dozen actors, entities of several types, a small minority of denials.
 */
const ROWS = 30_000;
const ACTOR = 'a0000000-0000-7000-8000-000000000007';
const ORDER_ENTITY = '0f000000-0000-7000-8000-000000000041';
const HOT_PANEL = '0e000000-0000-7000-8000-000000000001';

describe('the audit log query plans', () => {
  let ctx: TestContext;
  let reader: DrizzleAuditLogReader;
  let customerId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    reader = new DrizzleAuditLogReader(ctx.container.database.db);
    customerId = ctx.container.ids.uuid();
    await ctx.container.database.withClient(async (client) => {
      // A fixture, not an application statement: see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const [scope, salt] of [
          [tenantA, 0],
          [tenantB, 1],
        ] as const) {
          await client.query(
            `INSERT INTO audit_logs
               (id, tenant_id, occurred_at, actor_type, actor_id, actor_label, action,
                entity_type, entity_id, before, after, reason, correlation_id, source_surface,
                result)
             SELECT gen_random_uuid(), $1::uuid,
                    now() - (g || ' minutes')::interval,
                    'WEB_ADMIN',
                    'a0000000-0000-7000-8000-' || lpad(((g + $2::int) % 40)::text, 12, '0'),
                    'admin' || ((g + $2::int) % 40),
                    (ARRAY['payment.confirm','order.confirm','panel.update','product.update',
                           'wallet.credit','wallet.debit','auth.login','customer.block',
                           'service.terminate','settings.set'])[1 + (g % 10)],
                    (ARRAY['Payment','Order','Panel','Product','Wallet','Wallet','Admin',
                           'Customer','Service','Setting'])[1 + (g % 10)],
                    '0f000000-0000-7000-8000-' || lpad((g % 5000)::text, 12, '0'),
                    '{"status":"ACTIVE"}'::jsonb, '{"status":"BLOCKED"}'::jsonb, NULL,
                    'plan-' || g, 'WEB',
                    CASE WHEN g % 50 = 0 THEN 'DENIED' ELSE 'SUCCESS' END
               FROM generate_series(1, $3::int) AS g`,
            [scope.tenantId, salt, ROWS],
          );
        }
        await client.query(
          `INSERT INTO customers (id, tenant_id, telegram_user_id, status)
             VALUES ($1::uuid, $2::uuid, '700000001', 'ACTIVE')`,
          [customerId, tenantA.tenantId],
        );
        await client.query('ANALYZE audit_logs');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const planOf = async (
    filter: AuditLogFilter,
    after: { occurredAt: string; id: string } | null = null,
  ): Promise<string> => {
    const { sql, params } = reader.pageStatement(tenantA, filter, 51, after);
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
        [...params],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  const removedByFilter = (plan: string): number =>
    [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );

  /** No sequential scan of the log, and at most `removed` rows read and thrown away. */
  const expectServed = (plan: string, index: string, removed = 500) => {
    expect(plan, `expected ${index}:\n${plan}`).toContain(index);
    expect(plan, `the log was scanned:\n${plan}`).not.toMatch(/Seq Scan on audit_logs/);
    expect(removedByFilter(plan), `rows read and discarded:\n${plan}`).toBeLessThan(removed);
  };

  it('pages the unfiltered log in index order, page one and a later page', async () => {
    const first = await planOf({});
    expectServed(first, 'audit_logs_tenant_occurred_page_idx');
    // In order from the index: nothing sorts the tenant's log to find fifty rows.
    expect(first).not.toMatch(/\bSort\b/);

    const rows = await reader.page(tenantA, {}, 51, null);
    const middle = rows[50]?.position ?? null;
    const later = await planOf({}, middle);
    expectServed(later, 'audit_logs_tenant_occurred_page_idx');
    expect(later).not.toMatch(/\bSort\b/);
    expect(later, later).toMatch(/Index Cond:.*occurred_at/s);
  }, 60_000);

  it('serves one administrator from the actor keyset, in order', async () => {
    const plan = await planOf({ actorIds: [ACTOR] });
    expectServed(plan, 'audit_logs_tenant_actor_page_idx');
    expect(plan).not.toMatch(/\bSort\b/);
  }, 60_000);

  /*
   * An entity with a FEW rows may be read through the older `(entity_type, entity_id)` index
   * and sorted — the planner's own choice, and a cheap one, because entity ids are uuids and
   * another tenant's rows for the same id are essentially never there. The long-history case
   * the tenant-led keyset exists for is the LAST test, because its fixture skews the log.
   */
  it('serves one entity with a short history from an entity index', async () => {
    const plan = await planOf({ entityType: 'Order', entityId: ORDER_ENTITY });
    expect(plan, plan).toMatch(/audit_logs_(tenant_entity_page|entity)_idx/);
    expect(plan, plan).not.toMatch(/Seq Scan on audit_logs/);
    expect(removedByFilter(plan), plan).toBeLessThan(50);
  }, 60_000);

  it('serves one exact action from the action keyset, in order', async () => {
    const plan = await planOf({ action: { exact: 'panel.update' } });
    expectServed(plan, 'audit_logs_tenant_action_page_idx');
    expect(plan).not.toMatch(/\bSort\b/);
  }, 60_000);

  /*
   * A FAMILY and the AUTH/CRITICAL slices are sets of actions, and the planner chooses by
   * statistics between reading the matching rows through the action index and walking the
   * time keyset until a page has matched. On a log whose actions are spread as a real log's
   * are, either is bounded, and that is what this asserts. A family absent from the recent
   * past is the case statistics cannot see — it is walked back to where it last occurred —
   * which `docs/audit-log.md` states as a limitation, with the date range as the answer.
   */
  it('bounds an action family and the AUTH and CRITICAL slices on a realistic log', async () => {
    for (const filter of [
      { action: { prefix: 'wallet.' } },
      { security: 'AUTH' },
      { security: 'CRITICAL' },
    ] as const) {
      const plan = await planOf(filter);
      expect(plan, plan).not.toMatch(/Seq Scan on audit_logs/);
      expect(removedByFilter(plan), plan).toBeLessThan(1_000);
    }
  }, 60_000);

  it('serves the customer filter as index probes, never a walk of the log', async () => {
    const plan = await planOf({ customerId });
    expectServed(plan, 'audit_logs_tenant_entity_page_idx');
  }, 60_000);

  it('serves a date range from the time keyset', async () => {
    const now = Date.now();
    const plan = await planOf({
      from: new Date(now - 3 * 86_400_000).toISOString(),
      to: new Date(now).toISOString(),
    });
    expectServed(plan, 'audit_logs_tenant_occurred_page_idx');
  }, 60_000);

  /*
   * LAST: twenty thousand fresh rows against one panel — a monitor's history — skew the log
   * the way production skews it. The long entity history must be read in order from the
   * tenant-led keyset rather than sorted, and the denials, the rarest rows, must still come
   * from their own partial index rather than a walk past every new success.
   */
  it('reads a long entity history in order, and denials from their own index, on a skewed log', async () => {
    await ctx.container.database.withClient(async (client) => {
      await client.query(
        `INSERT INTO audit_logs
           (id, tenant_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id,
            correlation_id, source_surface, result)
         SELECT gen_random_uuid(), $1::uuid, now() - (g || ' seconds')::interval, 'SYSTEM_JOB',
                'monitor', 'panel.monitor.probe', 'Panel', $2, 'hot-' || g, 'WORKER', 'SUCCESS'
           FROM generate_series(1, 20000) AS g`,
        [tenantA.tenantId, HOT_PANEL],
      );
      await client.query('ANALYZE audit_logs');
    });
    const long = await planOf({ entityType: 'Panel', entityId: HOT_PANEL });
    expectServed(long, 'audit_logs_tenant_entity_page_idx');
    expect(long, long).not.toMatch(/\bSort\b/);

    const denied = await planOf({ security: 'DENIED' });
    expectServed(denied, 'audit_logs_tenant_denied_page_idx', 1);
    expect(denied, denied).not.toMatch(/\bSort\b/);
  }, 60_000);
});
