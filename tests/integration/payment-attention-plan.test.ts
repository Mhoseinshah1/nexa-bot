import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENT_OPS_QUEUES, type TimePeriod } from '@nexa/contracts';
import { DrizzlePaymentAttentionReader } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-attention.reader';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The Payment Operations Center's attention counts, asked of the PLANNER (FIX-11).
 *
 * `GET /payment-operations/attention` evaluated nine queue predicates over every payment
 * the tenant ever took — 2.5–4 s per request at 400 000 payments, on the dashboard and the
 * payments page. The counts are now driven from the rows that CAN match
 * (`paymentOpsCandidateIds`), and the invoice arm of that set from
 * `gateway_invoices_tenant_attention_idx` (`online-indexes.ts`). No behavioural test can
 * see either — the counts are the same — so this file asks the plan.
 *
 * The statement is the reader's own (`statement`), not a retyped copy. Two tenants of
 * 20 000 payments over a year, almost all of them settled gateway payments with a quiet
 * invoice — the shape of a real gateway tenant — and a few dozen that need somebody.
 */
const ROWS = 20_000;
const DAY_MS = 86_400_000;

describe('the payment attention query plan', () => {
  let ctx: TestContext;
  let reader: DrizzlePaymentAttentionReader;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    reader = new DrizzlePaymentAttentionReader(ctx.container.database.db);
    await ctx.container.database.withClient(async (client) => {
      // A fixture, not an application statement: see `services-plan.test.ts`.
      await client.query('SET statement_timeout = 0');
      try {
        for (const scope of [tenantA, tenantB]) {
          await client.query(
            `INSERT INTO customers (id, tenant_id, telegram_user_id, status)
               SELECT gen_random_uuid(), $1::uuid, 'attn-' || $1::text || '-' || g, 'ACTIVE'
                 FROM generate_series(1, 100) AS g`,
            [scope.tenantId],
          );
          // One year of payments: every 400th PENDING, every 500th FAILED with a provider
          // error on its invoice, the rest CONFIRMED with a quiet invoice.
          await client.query(
            `INSERT INTO payments
               (id, tenant_id, customer_id, method, state, amount, currency, reference,
                gateway_provider, evidence_kind, confirmed_at, resolved_at, expires_at,
                created_at, updated_at)
               SELECT gen_random_uuid(), $1::uuid, c.id, 'GATEWAY', k.state, 250000, 'IRT',
                      'attn-' || $1::text || '-' || g, 'TONPAYS',
                      CASE WHEN k.state = 'CONFIRMED' THEN 'GATEWAY_CALLBACK' END,
                      CASE WHEN k.state = 'CONFIRMED' THEN t END,
                      CASE WHEN k.state = 'FAILED' THEN t END,
                      CASE WHEN k.state = 'PENDING' THEN t + interval '70 minutes' END,
                      t, t
                 FROM generate_series(1, $2::int) AS g
                 CROSS JOIN LATERAL (SELECT now() - (g * interval '1 day' * 365 / $2::int) AS t) s
                 CROSS JOIN LATERAL (SELECT CASE WHEN g % 400 = 0 THEN 'PENDING'
                                                 WHEN g % 500 = 0 THEN 'FAILED'
                                                 ELSE 'CONFIRMED' END AS state) k
                 JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n
                         FROM customers WHERE tenant_id = $1::uuid) c ON c.n = 1 + g % 100`,
            [scope.tenantId, ROWS],
          );
          await client.query(
            `INSERT INTO gateway_invoices
               (payment_id, tenant_id, provider, provider_order_id, creation_state,
                provider_invoice_id, created_invoice_at, provider_unit, sent_amount,
                last_inquiry_error_code)
               SELECT p.id, p.tenant_id, 'TONPAYS', 'o-' || p.id, 'CREATED', 'i-' || p.id,
                      p.created_at, 'IRT', 250000,
                      CASE WHEN p.state = 'FAILED' THEN 'HTTP_503' END
                 FROM payments p WHERE p.tenant_id = $1::uuid`,
            [scope.tenantId],
          );
        }
        await client.query('VACUUM ANALYZE payments');
        await client.query('VACUUM ANALYZE gateway_invoices');
      } finally {
        await client.query('RESET statement_timeout');
      }
    });
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const explain = async (window: TimePeriod | null): Promise<string> => {
    const compiled = reader.statement(ctx.container.database.db, tenantA.tenantId, window).toSQL();
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${compiled.sql}`,
        compiled.params,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  /** The most rows any scan of `payments` read and discarded. */
  const discardedPayments = (plan: string): number => {
    let worst = 0;
    let inPayments = false;
    for (const line of plan.split('\n')) {
      if (/(Scan|Scan using \S+) on payments\b/.test(line)) inPayments = true;
      else if (line.includes('->')) inPayments = false;
      const removed = /Rows Removed by Filter: (\d+)/.exec(line);
      if (inPayments && removed !== null) worst = Math.max(worst, Number(removed[1]));
    }
    return worst;
  };

  const now = Date.now();
  for (const [what, window] of [
    ['all time', null],
    ['the last 30 days', { start: new Date(now - 30 * DAY_MS), end: new Date(now) }],
  ] as const) {
    it(`reads only the payments that can need somebody, over ${what}`, async () => {
      const plan = await explain(window);
      // Neither tenant's settled history is walked…
      expect(plan, `the payments heap was walked:\n${plan}`).not.toContain('Seq Scan on payments');
      // …nor its quiet invoices: the invoice arm is the partial index.
      expect(plan, `the invoice arm did not use its index:\n${plan}`).toContain(
        'gateway_invoices_tenant_attention_idx',
      );
      expect(plan, `every invoice was read:\n${plan}`).not.toMatch(
        /Seq Scan on gateway_invoices gi\b/,
      );
      /*
       * The real discriminator: how many of the tenant's payments a node READ and threw away.
       * Measured on this fixture with the driver removed (the full scan): one index scan over
       * the tenant's payments, `Rows Removed by Filter: 19920`, to keep 80. Driven, the
       * payments are fetched by id from the candidates, and nothing near that is discarded.
       */
      expect(
        discardedPayments(plan),
        `the tenant's payments were read and filtered:\n${plan}`,
      ).toBeLessThan(ROWS / 20);
    }, 60_000);
  }

  it('still answers what it answered before: the pending and the provider errors, per tenant', async () => {
    const totals = (rows: Awaited<ReturnType<DrizzlePaymentAttentionReader['counts']>>) =>
      Object.fromEntries(
        PAYMENT_OPS_QUEUES.map((queue) => [
          queue,
          rows.reduce((sum, row) => sum + row.counts[queue], 0),
        ]),
      );
    for (const scope of [tenantA, tenantB]) {
      const counts = totals(await reader.counts(scope, null));
      expect(counts.PENDING).toBe(ROWS / 400);
      // Every 500th, less those that are also every 400th (PENDING wins): 40 − 10.
      expect(counts.PROVIDER_ERROR).toBe(ROWS / 500 - ROWS / 2000);
      expect(counts.UNKNOWN).toBe(0);
      expect(counts.NEEDS_ACTION).toBe(0);
    }
  }, 60_000);
});
