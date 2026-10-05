import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../apps/api/src/infrastructure/persistence/schema';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';
import { DrizzleBusinessConversationRepository } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository';
import { DrizzleSupportAnalyticsReader } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-analytics.reader';
import { SEED_IDS, createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * TB10 (program §47) — the support inbox and the support analytics, asked of the PLANNER.
 *
 * A behavioural test cannot tell an index scan from a sequential scan: both return the same
 * rows. So the statements the REAL repositories send are captured on their way out — the
 * inbox through a drizzle logger, the analytics through a recording `execute` — and
 * EXPLAINed against two tenants of a year's history each.
 *
 * What each must show: the tenant-leading index named in the plan, the window (or the
 * keyset) inside its Index Cond, and no sequential scan of the table. With migration 0210's
 * three indexes dropped, five of the six plan cases here fail: the inbox becomes a Seq Scan
 * and a Sort of the tenant's conversations for every page, and the escalation and job
 * counts become sequential scans (`support_ai_runs` keeps its TB4 index).
 */
const ROWS = 20_000;

describe('the support query plans', () => {
  let ctx: TestContext;
  const dialect = new PgDialect();
  let captured: { sql: string; params: unknown[] }[] = [];
  let inbox: DrizzleBusinessConversationRepository;
  let analytics: DrizzleSupportAnalyticsReader;
  const scope = { ...tenantA, botInstanceId: SEED_IDS.botA1 } as never;
  const window = {
    start: new Date(Date.now() - 30 * 86_400_000),
    end: new Date(),
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    const logged = drizzle(ctx.container.database.pool, {
      schema,
      logger: {
        logQuery: (query: string, params: unknown[]) => {
          captured.push({ sql: query, params: [...params] });
        },
      },
    }) as unknown as Database;
    inbox = new DrizzleBusinessConversationRepository(logged);
    const real = ctx.container.database.db;
    analytics = new DrizzleSupportAnalyticsReader({
      execute: (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        captured.push({ sql: compiled.sql, params: [...compiled.params] });
        return real.execute(query);
      },
    } as unknown as Database);

    await ctx.container.database.withClient(async (client) => {
      // A fixture, not an application statement: see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const [tenant, bot] of [
          [tenantA.tenantId, SEED_IDS.botA1],
          [tenantB.tenantId, SEED_IDS.botB1],
        ] as const) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO telegram_business_connections
               (id, tenant_id, bot_instance_id, connection_id, owner_telegram_user_id,
                owner_user_chat_id, is_enabled, rights, connected_at, last_confirmed_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'plan-' || $1::text, '5000001',
                     '5000001', true, ARRAY['can_reply'], now(), now())
             RETURNING id`,
            [tenant, bot],
          );
          // A year of conversations; one in fifty waits for a person.
          await client.query(
            `INSERT INTO business_conversations
               (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id,
                connection_row_id, peer_telegram_user_id, state, control_epoch, handoff_reason,
                last_message_at, last_inbound_at, created_at)
             SELECT gen_random_uuid(), $1::uuid, $2::uuid, '5000001', (7000000 + g)::text,
                    $3::uuid, (7000000 + g)::text,
                    CASE WHEN g % 50 = 0 THEN 'HANDOFF_REQUIRED' WHEN g % 3 = 0 THEN 'HUMAN_ACTIVE'
                         ELSE 'AI_ACTIVE' END,
                    1, CASE WHEN g % 50 = 0 THEN 'HANDOFF_TOPIC' END, t, t, t
               FROM generate_series(1, $4::int) AS g
               CROSS JOIN LATERAL (SELECT now() - (g * interval '1 day' * 365 / $4::int) AS t) s`,
            [tenant, bot, rows[0]!.id, ROWS],
          );
          // One handoff and one job per conversation, at its own time.
          await client.query(
            `INSERT INTO business_conversation_escalations
               (id, tenant_id, conversation_id, control_epoch, reason, ticket_outcome, created_at)
             SELECT gen_random_uuid(), tenant_id, id, 1, 'LOW_CONFIDENCE', 'NO_CUSTOMER', created_at
               FROM business_conversations WHERE tenant_id = $1::uuid`,
            [tenant],
          );
          await client.query(
            `INSERT INTO support_ai_jobs
               (id, tenant_id, kind, conversation_id, idempotency_key, state, created_at)
             SELECT gen_random_uuid(), tenant_id, 'ASSIST_DRAFT', id, 'plan-' || id::text,
                    'FAILED', created_at
               FROM business_conversations WHERE tenant_id = $1::uuid`,
            [tenant],
          );
          await client.query(
            `INSERT INTO support_ai_runs
               (id, tenant_id, operation, provider, model, attempt_index, latency_ms,
                input_tokens, output_tokens, outcome, created_at)
             SELECT gen_random_uuid(), tenant_id, 'ASSIST_DRAFT', 'OPENAI', 'model-x', 0,
                    100 + (random() * 900)::int, 1000, 100, 'OK', created_at
               FROM business_conversations WHERE tenant_id = $1::uuid`,
            [tenant],
          );
        }
        for (const table of [
          'business_conversations',
          'business_conversation_escalations',
          'support_ai_jobs',
          'support_ai_runs',
        ]) {
          await client.query(`VACUUM ANALYZE ${table}`);
        }
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const explain = async (statement: { sql: string; params: unknown[] }): Promise<string> =>
    ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement.sql}`,
        statement.params,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

  /** The buffers the plan's top node reports, which include every node beneath it. */
  const buffersIn = (plan: string): number => {
    const match = /Buffers: shared( hit=(\d+))?( read=(\d+))?/.exec(plan);
    return match === null ? 0 : Number(match[2] ?? 0) + Number(match[4] ?? 0);
  };

  /** The statement a call sent that reads `table`, captured on its way out. */
  const statementOf = async (call: () => Promise<unknown>, table: string) => {
    captured = [];
    await call();
    const found = captured.filter((one) => new RegExp(`from "?${table}"?\\b`, 'i').test(one.sql));
    expect(found, `no statement read ${table}`).toHaveLength(1);
    return found[0]!;
  };

  const INBOX_INDEX = 'business_conversations_inbox_priority_idx';

  describe('the inbox', () => {
    const shapes: readonly { what: string; call: () => Promise<unknown> }[] = [
      { what: 'the first page', call: () => inbox.list(scope, { limit: 51 }) },
      {
        what: 'a later page by the three-key cursor',
        call: () =>
          inbox.list(scope, {
            limit: 51,
            before: {
              priority: 0,
              at: new Date(Date.now() - 100 * 86_400_000),
              id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
            },
          }),
      },
      {
        what: 'the handoffs filter',
        call: () => inbox.list(scope, { state: 'HANDOFF_REQUIRED', limit: 51 }),
      },
    ];

    for (const shape of shapes) {
      it(`serves ${shape.what} from ${INBOX_INDEX}, a bounded range of one tenant`, async () => {
        const plan = await explain(await statementOf(shape.call, 'business_conversations'));
        expect(plan, `${INBOX_INDEX} is not in the plan:\n${plan}`).toContain(INBOX_INDEX);
        expect(plan, `the conversations were walked:\n${plan}`).not.toContain(
          'Seq Scan on business_conversations',
        );
        // The order is the index's: no sort of the tenant's conversations for a page.
        expect(plan, `the page was sorted:\n${plan}`).not.toMatch(
          /Sort Key: \(\(?\(?business_conversations\.state/,
        );
        /*
         * Measured on this fixture: 364 buffers for the first page of 51, 415 for a cursor
         * page and 264 for the handoffs filter (the index range, the heap rows, the
         * connection and the two per-row transcript probes); with the index dropped, the
         * first page was a Seq Scan of the tenant's 20 000 conversations and a Sort, 1 118
         * buffers. The threshold sits between with room on both sides.
         */
        expect(buffersIn(plan), `more than a page was read:\n${plan}`).toBeLessThan(700);
      }, 60_000);
    }

    it('still answers handoffs first, then newest', async () => {
      // 400 of the 20 000 wait for a person: a page of 500 crosses into the rest.
      const page = await inbox.list(scope, { limit: 500 });
      const states = page.map((item) => item.conversation.state);
      const firstOther = states.findIndex((state) => state !== 'HANDOFF_REQUIRED');
      expect(firstOther).toBeGreaterThan(0);
      expect(states.slice(firstOther)).not.toContain('HANDOFF_REQUIRED');
      const times = page.slice(firstOther).map((item) => item.activityAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe('the analytics', () => {
    const windowed: readonly { table: string; index: string }[] = [
      {
        table: 'business_conversation_escalations',
        index: 'business_conversation_escalations_created_idx',
      },
      { table: 'support_ai_jobs', index: 'support_ai_jobs_created_idx' },
      { table: 'support_ai_runs', index: 'support_ai_runs_tenant_created_idx' },
    ];

    for (const shape of windowed) {
      it(`counts ${shape.table} in the window from ${shape.index}`, async () => {
        const plan = await explain(
          await statementOf(() => analytics.read(scope, window), shape.table),
        );
        expect(plan, `${shape.index} is not in the plan:\n${plan}`).toContain(shape.index);
        expect(plan, `the window did not bound the scan:\n${plan}`).toMatch(
          /Index Cond:.*created_at/s,
        );
        expect(plan, `the table was walked:\n${plan}`).not.toContain(`Seq Scan on ${shape.table}`);
      }, 60_000);
    }

    it('still counts what a plain count counts', async () => {
      const facts = await analytics.read(scope, window);
      const expected = await ctx.container.database.withClient(async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM support_ai_jobs
            WHERE tenant_id = $1::uuid AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
          [tenantA.tenantId, window.start.toISOString(), window.end.toISOString()],
        );
        return rows[0]?.n ?? 0;
      });
      expect(expected).toBeGreaterThan(1_000);
      expect(facts.jobs.reduce((sum, row) => sum + row.count, 0)).toBe(expected);
    }, 60_000);
  });
});
