import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  systemJobActor,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  admins,
  auditLogs,
  customers,
  hostedBots,
  resellerBotRequests,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleResellerBotRepository } from '../../apps/api/src/modules/commerce/reseller-bots/infrastructure/drizzle-reseller-bot.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleHostingRepository } from '../../apps/api/src/modules/platform/hosting/infrastructure/drizzle-hosting.repository';
import {
  RESELLER_BOT_STOP_AUDIT_ACTION,
  RESELLER_BOT_RESUME_AUDIT_ACTION,
} from '../../apps/api/src/modules/commerce/reseller-bots/application/reseller-bot-fee.service';
import { createTestContext, SEED_IDS, tenantA, tenantB, type TestContext } from './harness';

/** Real scoped application pool (nexa_app), no external Telegram calls. The section proof is
 * isolated for read/scale tests; reseller-bot.test.ts retains the real owner/session guards.
 * Benchmark output intentionally contains only counts and timings, never request/customer data.
 */
function recordBenchmark(value: unknown) {
  const path = process.env['NEXA_RESELLER_BENCHMARK_FILE'];
  if (path !== undefined) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

describe('reseller bot request pages, history and bounded enrichment', () => {
  let ctx: TestContext;
  let repository: DrizzleResellerBotRepository;
  let customerId: UserId;
  let otherCustomerId: UserId;
  let foreignCustomerId: UserId;
  let adminId: string;
  let foreignAdminId: string;
  const at = new Date('2026-11-10T10:00:00.000Z');
  const actor = systemJobActor('reseller-list-probe', 'reseller-list-probe' as CorrelationId);
  const db = () => ctx.container.database.db;
  const service = () => ctx.container.resellerBots;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ctx ??= await createTestContext();
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    repository = new DrizzleResellerBotRepository(ctx.applicationDatabase.db);
    vi.spyOn(ctx.container.hostingSection, 'requireSection').mockResolvedValue(tenantA);
    customerId = await customer(tenantA, '1001');
    otherCustomerId = await customer(tenantA, '1002');
    foreignCustomerId = await customer(tenantB, '1003');
    adminId = await admin(tenantA.tenantId);
    foreignAdminId = await admin(tenantB.tenantId);
    const tier = randomUUID();
    await db()
      .execute(sql`INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_currency)
      VALUES (${tier}, ${tenantA.tenantId}, 'list-fixture', 'LIST_PRICE', 'IRT')`);
    for (const id of [customerId, otherCustomerId]) {
      await db()
        .execute(sql`INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, credit_limit_amount)
        VALUES (${randomUUID()}, ${tenantA.tenantId}, ${id}, ${tier}, 'ACTIVE', NULL)`);
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  async function customer(scope: TenantContext, telegramUserId: string) {
    const id = ctx.container.ids.uuid() as UserId;
    await db()
      .insert(customers)
      .values({
        id,
        tenantId: scope.tenantId,
        telegramUserId,
        firstName: 'List',
        lastName: 'Fixture',
        status: 'ACTIVE',
        firstSeenAt: at,
        firstBotInstanceId: scope === tenantA ? SEED_IDS.botA1 : SEED_IDS.botB1,
        createdAt: at,
      });
    return id;
  }
  async function admin(tenantId: string) {
    const id = randomUUID();
    await db().insert(admins).values({
      id,
      tenantId,
      username: 'list-fixture',
      displayName: 'Fixture',
      passwordHash: 'unused-fixture-hash',
      passwordUpdatedAt: at,
    });
    return id;
  }
  async function requests(
    count: number,
    options: { linked?: boolean; scope?: TenantContext; customer?: UserId } = {},
  ) {
    const scope = options.scope ?? tenantA;
    const ids = Array.from({ length: count }, () => randomUUID());
    const hostIds = ids.map(() => randomUUID());
    if (options.linked) {
      await db()
        .insert(tenants)
        .values(
          hostIds.map((id) => ({
            id,
            kind: 'HOSTED',
            parentTenantId: scope.tenantId,
            slug: `fixture-${id}`,
            displayName: 'Fixture',
            status: 'ACTIVE',
            currency: 'IRT',
          })),
        );
      const owners = hostIds.map(() => randomUUID());
      await db()
        .insert(admins)
        .values(
          hostIds.map((id, i) => ({
            id: owners[i]!,
            tenantId: id,
            username: 'fixture',
            displayName: 'Fixture',
            passwordHash: 'unused-fixture-hash',
            passwordUpdatedAt: at,
          })),
        );
      await db()
        .insert(hostedBots)
        .values(
          hostIds.map((id, i) => ({
            tenantId: scope.tenantId,
            hostedTenantId: id,
            state: 'ACTIVE',
            ownerAdminId: owners[i]!,
            createdByAdminId: scope === tenantA ? adminId : foreignAdminId,
            createdAt: at,
            stateChangedAt: at,
            updatedAt: at,
          })),
        );
    }
    await db()
      .insert(resellerBotRequests)
      .values(
        ids.map((id, i) => ({
          id,
          tenantId: scope.tenantId,
          customerId: options.customer ?? customerId,
          status: options.linked ? 'APPROVED' : 'CANCELLED',
          telegramBotId: `fixture-${id}`,
          botUsername: `fixture_${String(i)}_bot`,
          tokenCiphertext: 'unused-fixture-ciphertext',
          tokenKeyId: 'fixture',
          feeAmountMinor: 500000n,
          feeCurrency: 'IRT',
          createdAt: at,
          updatedAt: at,
          cancelledAt: options.linked ? null : at,
          decidedAt: options.linked ? at : null,
          decidedByAdminId: options.linked ? (scope === tenantA ? adminId : foreignAdminId) : null,
          paidThrough: options.linked ? new Date('2026-12-10T10:00:00Z') : null,
          lastPeriod: options.linked ? 1 : 0,
          hostedTenantId: options.linked ? hostIds[i]! : null,
          linkedAt: options.linked ? at : null,
        })),
      );
    return ids.sort().reverse();
  }

  it('pages past 200 with identical timestamps, microseconds, concurrent inserts and isolated anchors', async () => {
    const ids = await requests(501);
    const foreign = (await requests(1, { scope: tenantB, customer: foreignCustomerId }))[0]!;
    const first = await service().adminList(tenantA, actor, null, { limit: 50 });
    expect(first.requests.map((row) => row.id)).toEqual(ids.slice(0, 50));
    const newer = (await requests(1, { customer: otherCustomerId }))[0]!;
    await db()
      .update(resellerBotRequests)
      .set({ createdAt: new Date(at.getTime() + 1000) })
      .where(eq(resellerBotRequests.id, newer));
    const all = [...first.requests];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await service().adminList(tenantA, actor, null, { limit: 50, cursor });
      expect(page.requests.length).toBeLessThanOrEqual(50);
      all.push(...page.requests);
      cursor = page.nextCursor;
    }
    expect(all.map((row) => row.id)).toEqual(ids);
    expect(new Set(all.map((row) => row.id)).size).toBe(501);
    expect((await service().adminList(tenantA, actor, null, { limit: 50 })).requests[0]?.id).toBe(
      newer,
    );
    for (const anchor of [foreign, randomUUID()]) {
      expect(await repository.listAll(tenantA, 50, anchor)).toEqual([]);
    }
    // Sub-millisecond values are resolved by PostgreSQL, not rounded through a JS Date.
    await db().execute(
      sql`UPDATE reseller_bot_requests SET created_at = '2026-11-10T10:00:00.000900Z' WHERE id = ${ids[0]}`,
    );
    await db().execute(
      sql`UPDATE reseller_bot_requests SET created_at = '2026-11-10T10:00:00.000800Z' WHERE id = ${ids[1]}`,
    );
    expect((await repository.listAll(tenantA, 1, ids[0]))[0]?.id).toBe(ids[1]);
    expect((await service().adminList(tenantA, actor, null)).requests).toHaveLength(200);
    await expect(service().adminList(tenantA, actor, null, { limit: 201 })).rejects.toThrow();
    await expect(
      service().adminList(tenantA, actor, null, { cursor: 'invalid' }),
    ).rejects.toThrow();
  });

  it('keeps complete own history and same-time timeline construction without another customer or tenant', async () => {
    const linked = (await requests(1, { linked: true }))[0]!;
    const cancelled = (await requests(1))[0]!;
    const rejected = (await requests(1))[0]!;
    const pending = (await requests(1))[0]!;
    await db()
      .update(resellerBotRequests)
      .set({
        status: 'REJECTED',
        cancelledAt: null,
        decidedAt: at,
        decidedByAdminId: adminId,
        rejectReason: 'Fixture rejection',
      })
      .where(eq(resellerBotRequests.id, rejected));
    await db()
      .update(resellerBotRequests)
      .set({ status: 'PENDING', cancelledAt: null })
      .where(eq(resellerBotRequests.id, pending));
    const other = (await requests(1, { customer: otherCustomerId }))[0]!;
    const foreign = (
      await requests(1, { scope: tenantB, customer: foreignCustomerId, linked: true })
    )[0]!;
    await db()
      .insert(auditLogs)
      .values([
        {
          id: randomUUID(),
          tenantId: tenantA.tenantId,
          occurredAt: at,
          actorType: 'SYSTEM_JOB',
          action: RESELLER_BOT_STOP_AUDIT_ACTION,
          entityType: 'ResellerBotRequest',
          entityId: linked,
          correlationId: 'fixture',
          sourceSurface: 'WORKER',
          result: 'SUCCESS',
        },
        {
          id: randomUUID(),
          tenantId: tenantA.tenantId,
          occurredAt: new Date(at.getTime() + 1),
          actorType: 'SYSTEM_JOB',
          action: RESELLER_BOT_RESUME_AUDIT_ACTION,
          entityType: 'ResellerBotRequest',
          entityId: linked,
          correlationId: 'fixture',
          sourceSurface: 'WORKER',
          result: 'SUCCESS',
        },
      ]);
    const own = await service().listOwn(tenantA, customerId);
    expect(new Set(own.map((row) => row.id))).toEqual(
      new Set([linked, cancelled, rejected, pending]),
    );
    expect(own.find((row) => row.id === linked)?.timeline.map((entry) => entry.event)).toEqual([
      'SUBMITTED',
      'APPROVED',
      'BOT_CREATED',
      'STOPPED',
      'RESUMED',
    ]);
    expect(own.find((row) => row.id === rejected)?.timeline.map((entry) => entry.event)).toEqual([
      'SUBMITTED',
      'REJECTED',
    ]);
    expect(own.find((row) => row.id === cancelled)?.timeline.map((entry) => entry.event)).toEqual([
      'SUBMITTED',
      'CANCELLED',
    ]);
    expect((await service().listOwn(tenantA, otherCustomerId)).map((row) => row.id)).toEqual([
      other,
    ]);
    await expect(service().listOwn(tenantB, foreignCustomerId)).rejects.toThrow();
    expect(await repository.customerSummaries(tenantA, [foreignCustomerId])).toEqual([]);
    const foreignRow = await repository.find(tenantB, foreign);
    expect(await repository.hostedStates(tenantA, [foreignRow!.hostedTenantId!])).toEqual([]);
    expect(await repository.listByCustomer(tenantB, customerId)).toEqual([]);
  });

  it.each([1, 50, 200, 501])(
    'bounds query growth and measures before/after hydration for %i linked requests',
    async (count) => {
      await requests(count, { linked: true });
      // Repeated customer and distinct linked bots expose both original N+1 loops.
      const rows = await repository.listByCustomer(tenantA, customerId);
      const customerRepository = new DrizzleCustomerRepository(ctx.applicationDatabase.db);
      const hostingRepository = new DrizzleHostingRepository(ctx.applicationDatabase.db);
      const query = vi.spyOn(ctx.applicationDatabase.pool, 'query');
      const beforeStart = performance.now();
      await repository.listCharges(
        tenantA,
        rows.map((row) => row.id),
      );
      await repository.lifecycleMarks(
        tenantA,
        rows.map((row) => row.id),
      );
      const before = [];
      for (const row of rows) {
        const hosted = await hostingRepository.findHosted(tenantA, row.hostedTenantId!);
        const customer = await customerRepository.findById(tenantA, row.customerId);
        before.push({ id: row.id, hosted: hosted?.state, customer: customer?.id });
      }
      const beforeMs = performance.now() - beforeStart;
      const beforeQueries = query.mock.calls.length;
      query.mockClear();
      const afterStart = performance.now();
      const after = [];
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        await repository.listCharges(
          tenantA,
          batch.map((row) => row.id),
        );
        await repository.lifecycleMarks(
          tenantA,
          batch.map((row) => row.id),
        );
        const hosted = new Map(
          (
            await repository.hostedStates(
              tenantA,
              batch.map((row) => row.hostedTenantId!),
            )
          ).map((row) => [row.id, row.state]),
        );
        const customers = new Map(
          (
            await repository.customerSummaries(tenantA, [
              ...new Set(batch.map((row) => row.customerId)),
            ])
          ).map((row) => [row.id, row.id]),
        );
        after.push(
          ...batch.map((row) => ({
            id: row.id,
            hosted: hosted.get(row.hostedTenantId!),
            customer: customers.get(row.customerId),
          })),
        );
      }
      const afterMs = performance.now() - afterStart;
      const afterQueries = query.mock.calls.length;
      expect(after).toEqual(before);
      expect(beforeQueries).toBe(2 + 2 * count);
      expect(afterQueries).toBe(4 * Math.ceil(count / 100));
      query.mockClear();
      const ownStart = performance.now();
      expect(await service().listOwn(tenantA, customerId)).toHaveLength(count);
      const ownMs = performance.now() - ownStart;
      const ownQueries = query.mock.calls.length;
      expect(ownQueries).toBeLessThanOrEqual(10 + 3 * Math.ceil(count / 100));
      query.mockClear();
      const pageStart = performance.now();
      const page = await service().adminList(tenantA, actor, null, { limit: 50 });
      const pageMs = performance.now() - pageStart;
      const pageQueries = query.mock.calls.length;
      expect(page.requests).toHaveLength(Math.min(50, count));
      expect(
        page.requests.every(
          (row) =>
            row.customer.id === customerId &&
            row.customer.displayName === 'List Fixture' &&
            row.customer.telegramUserId === '1001' &&
            row.hostedBot.state === 'ACTIVE',
        ),
      ).toBe(true);
      expect(JSON.stringify(page)).not.toContain('unused-fixture-ciphertext');
      expect(pageQueries).toBeLessThanOrEqual(12);
      query.mockRestore();
      if (count === 501) {
        const plan = await db().execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT id, created_at FROM reseller_bot_requests
          WHERE tenant_id = ${tenantA.tenantId}
            AND (created_at, id) < (SELECT created_at, id FROM reseller_bot_requests
              WHERE tenant_id = ${tenantA.tenantId} AND id = ${rows[49]!.id})
          ORDER BY created_at DESC, id DESC LIMIT 51`);
        const result = plan.rows[0]?.['QUERY PLAN'] as {
          'Execution Time': number;
          Plan: { 'Node Type': string; 'Shared Hit Blocks': number };
        }[];
        recordBenchmark({
          resellerRequestPlan: {
            count,
            executionMs: result[0]?.['Execution Time'],
            root: result[0]?.Plan['Node Type'],
            sharedHitBlocks: result[0]?.Plan['Shared Hit Blocks'],
          },
        });
      }
      recordBenchmark({
        resellerRequestBenchmark: {
          count,
          beforeQueries,
          afterQueries,
          beforeMs: +beforeMs.toFixed(2),
          afterMs: +afterMs.toFixed(2),
          ownQueries,
          ownMs: +ownMs.toFixed(2),
          pageQueries,
          pageMs: +pageMs.toFixed(2),
        },
      });
    },
  );
});
