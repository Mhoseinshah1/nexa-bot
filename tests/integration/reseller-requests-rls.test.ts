import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withDatabaseScope } from '../../apps/api/src/infrastructure/persistence/database-scope';
import {
  resellerRequestMessages,
  resellerRequestQuestions,
  resellerRequests,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, SEED_IDS, tenantB, type TestContext } from './harness';

/**
 * RLS isolation of the reseller request tables (PR-2). They carry `tenant_id`, so
 * `row-level-security.ts` secures them by discovery; this proves what that means for THEM,
 * through the application's pool (`nexa_app`) — the owner bypasses the policies and would
 * prove nothing.
 *
 * MUTATION: `DROP POLICY nexa_tenant_isolation ON reseller_requests` makes the first test fail.
 */
describe('reseller requests: row-level security', () => {
  let ctx: TestContext;
  const requestA = randomUUID();
  const requestB = randomUUID();
  const questionA = randomUUID();

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const db = ctx.container.database.db;
    for (const [tenant, bot, request, tag] of [
      [SEED_IDS.tenantA, SEED_IDS.botA1, requestA, 'a'],
      [SEED_IDS.tenantB, SEED_IDS.botB1, requestB, 'b'],
    ] as const) {
      const customer = randomUUID();
      await db.execute(sql`
        INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, status)
        VALUES (${customer}, ${tenant}, ${`9100${tag}`}, ${tag}, 'ACTIVE')`);
      await db.execute(sql`
        INSERT INTO reseller_requests (id, tenant_id, customer_id, bot_instance_id, answers, opening_key)
        VALUES (${request}, ${tenant}, ${customer}, ${bot}, '[]'::jsonb, ${`rls-${tag}`})`);
    }
    await db.execute(sql`
      INSERT INTO reseller_request_questions (id, tenant_id, position, text, required, max_length)
      VALUES (${questionA}, ${SEED_IDS.tenantA}, 0, 'سؤال', true, 100)`);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const app = () => ctx.applicationDatabase;

  it('shows a tenant its own requests and none of another’s, even by id', async () => {
    const asB = await withDatabaseScope(tenantB, () =>
      app().db.select({ id: resellerRequests.id }).from(resellerRequests),
    );
    expect(asB.map((row) => row.id)).toEqual([requestB]);
    const aByIdAsB = await withDatabaseScope(tenantB, () =>
      app()
        .db.select({ id: resellerRequests.id })
        .from(resellerRequests)
        .where(sql`${resellerRequests.id} = ${requestA}`),
    );
    expect(aByIdAsB).toEqual([]);
    const questionsAsB = await withDatabaseScope(tenantB, () =>
      app().db.select({ id: resellerRequestQuestions.id }).from(resellerRequestQuestions),
    );
    expect(questionsAsB).toEqual([]);
  });

  it('refuses to move a request into another tenant or to write a message into one', async () => {
    await expect(
      withDatabaseScope(tenantB, () =>
        app()
          .db.update(resellerRequests)
          .set({ status: 'REJECTED' })
          .where(sql`${resellerRequests.id} = ${requestA}`)
          .returning({ id: resellerRequests.id }),
      ),
    ).resolves.toEqual([]);
    await expect(
      withDatabaseScope(tenantB, () =>
        app()
          .db.update(resellerRequests)
          .set({ tenantId: SEED_IDS.tenantA as never })
          .where(sql`${resellerRequests.id} = ${requestB}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withDatabaseScope(tenantB, () =>
        app()
          .db.insert(resellerRequestMessages)
          .values({
            id: randomUUID(),
            tenantId: SEED_IDS.tenantA as never,
            requestId: requestA,
            senderType: 'CUSTOMER',
            body: 'x',
            idempotencyKey: 'rls-msg',
            requestHash: 'h',
          }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const untouched = await ctx.container.database.db.execute(
      sql`SELECT status FROM reseller_requests WHERE id = ${requestA}`,
    );
    expect((untouched.rows[0] as { status: string }).status).toBe('PENDING');
  });

  it('raises for a statement with no tenant bound, rather than answering', async () => {
    await expect(
      app().db.select({ id: resellerRequests.id }).from(resellerRequests),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
