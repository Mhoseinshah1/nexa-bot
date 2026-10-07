import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  SESSION_COOKIE_NAME,
  legacyProductReviewListResponseSchema,
  legacyProductReviewResponseSchema,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { runProductsRead } from '../../apps/api/src/legacy-import-products';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { digestProductsReadSet } from '../../apps/api/src/modules/platform/legacy-importer/application/products-read-set';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { LegacyProductsController } from '../../apps/api/src/surfaces/web/legacy-products.controller';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  seededCategoryFor,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Mirza migration PR2 — the legacy product review end to end against PostgreSQL, on the
 * SYNTHETIC fixture's product-review variant (snapshot A, then the newer snapshot B).
 * NOT EVIDENCE about the legacy archive; no count here is a real-data expectation.
 */

describe('Mirza PR2: legacy product review', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  const job = systemJobActor('legacy-import:products-read', 'corr-products' as CorrelationId);
  const connector = (snapshot: 'A' | 'B' | 'C') =>
    new FixtureLegacySourceConnector(
      buildSyntheticLegacyDataset({ productReview: snapshot }) as never,
    );
  const db = () => ctx.container.database.db;
  const fingerprints: Record<'A' | 'B' | 'C', { v1: string; products: string }> = {
    A: { v1: '', products: '' },
    B: { v1: '', products: '' },
    C: { v1: '', products: '' },
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    for (const snapshot of ['A', 'B', 'C'] as const) {
      const session = await connector(snapshot).open();
      fingerprints[snapshot] = {
        v1: (await readImportV1Identity(session)).fingerprint,
        products: (await digestProductsReadSet(session)).fingerprint,
      };
    }
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-lpr', roleKeys: ['owner'] }),
    );
  });

  const read = (
    snapshot: 'A' | 'B' | 'C',
    approved: 'approved' | 'unapproved' | string = 'approved',
    scope = tenantA,
  ) =>
    runProductsRead(
      ctx.container.legacyImporter(),
      connector(snapshot),
      {
        expectedFingerprint: fingerprints[snapshot].v1,
        expectedProductsFingerprint:
          approved === 'approved'
            ? fingerprints[snapshot].products
            : approved === 'unapproved'
              ? null
              : approved,
        batchSize: 3,
      },
      { scope, actor: job, productionLikeTarget: false },
    );

  const service = () => ctx.container.legacyProductReviews;
  const rowByCode = async (code: string, scope = tenantA, actor = owner) => {
    const { items } = await service().list(scope, actor, { q: code });
    const found = items.find((item) => item.review.codeProduct === code);
    if (found === undefined) throw new Error(`no review row ${code}`);
    return found.review;
  };
  const key = () => `lpr-${ctx.container.ids.uuid()}`;

  async function activeProduct(scope = tenantA): Promise<string> {
    const panel = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panel}, ${scope.tenantId}, 'Panel', 'sanaei', 'https://p.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, scope, panel);
    const products = new DrizzleProductRepository(db());
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن فعلی',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panel as PanelId,
        categoryId: seededCategoryFor(scope) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 32_212_254_720n, deviceLimit: null },
        price: money(145_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function auditCount(action: string, result = 'SUCCESS'): Promise<number> {
    const rows = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action} AND result = ${result}`,
    );
    return rows.rows[0]?.n ?? 0;
  }

  // --- the read -----------------------------------------------------------------------

  it('without the products approval, prints its fingerprint and writes NOTHING', async () => {
    const before = await databaseFingerprint(db());
    const outcome = await read('A', 'unapproved');
    expect(outcome.written).toBeNull();
    expect(outcome.fingerprint).toBe(fingerprints.A.products);
    expect(outcome.v1.fingerprint).toBe(fingerprints.A.v1);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('a products fingerprint that is not the approved one writes NOTHING', async () => {
    const before = await databaseFingerprint(db());
    await expect(read('A', fingerprints.B.products)).rejects.toThrow(
      /READ_SET_FINGERPRINT_MISMATCH/u,
    );
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('an approved read writes review rows, its run and audit rows — and nothing else', async () => {
    const before = await databaseFingerprint(db());
    const outcome = await read('A');
    expect(Object.keys(changedTables(before, await databaseFingerprint(db()))).sort()).toEqual([
      'audit_logs',
      'legacy_product_reviews',
      'legacy_read_set_runs',
    ]);
    // Every reviewable code is one row; the two unreviewable rows are counted, not stored.
    const { items } = await service().list(tenantA, owner, {});
    const codes = items.map((item) => item.review.codeProduct);
    expect(outcome.written?.counts.created).toBe(codes.length);
    expect(outcome.written?.skipped).toEqual({ CODE_EMPTY: 2, CODE_INVALID: 0 });
    expect(new Set(items.map((item) => item.review.state))).toEqual(new Set(['PENDING_REVIEW']));
    expect(outcome.written?.recorded.run).toMatchObject({
      readSet: 'products',
      readSetFingerprint: fingerprints.A.products,
      sourceFingerprint: fingerprints.A.v1,
      rowCount: BigInt(outcome.productRows),
    });

    const p1 = await rowByCode('p1');
    expect(p1).toMatchObject({
      legacyProductId: '1',
      title: 'synthetic 30GB',
      trafficBytes: 30n * 1024n ** 3n,
      durationDays: 30,
      historicalPriceRaw: '150000',
      historicalPriceMinor: 150000n,
      historicalPriceCurrency: 'IRT',
      liveInvoiceCount: 1,
      readFingerprint: fingerprints.A.products,
      sourceFingerprint: fingerprints.A.v1,
    });
    // The facts are the cells verbatim — the fork's status cells included.
    expect((await rowByCode('p6')).facts).toEqual([
      expect.objectContaining({ hide_panel: '{"rp1":"rp1","rp2":"rp2"}', agent: 'f' }),
    ]);
    expect((await rowByCode('p7')).facts[0]).toMatchObject({
      note: 'test product',
      one_buy_status: '1',
      price_product: '0',
    });
    expect((await rowByCode('p2')).facts[0]).toMatchObject({ agent: 'n' });
    expect((await rowByCode('p8')).facts[0]).toMatchObject({ agent: 'n2', Location: 'rp1,rp2' });
    expect(await rowByCode('p4')).toMatchObject({
      trafficBytes: null,
      parseNotes: { trafficBytes: 'ZERO_MEANING_UNKNOWN' },
    });
    expect(await rowByCode('p9')).toMatchObject({
      historicalPriceRaw: '۱۵۰۰۰۰',
      historicalPriceMinor: null,
      parseNotes: { historicalPrice: 'NOT_A_NUMBER' },
    });
    const dup = await rowByCode('dup');
    expect(dup.sourceConflict).toBe('CODE_DUPLICATED');
    expect(dup.facts).toHaveLength(2);
    // Same duration and volume, two products.
    const p3 = await rowByCode('p3');
    expect(p3.id).not.toBe(p1.id);
    expect(await rowByCode('p13')).toMatchObject({ trafficBytes: 11_274_289_152n });
    expect(await auditCount('legacy.product_review.read')).toBe(codes.length);
  });

  it('re-reading the same approved source changes no review row', async () => {
    await read('A');
    const first = await db().execute(
      sql`SELECT * FROM legacy_product_reviews ORDER BY code_product`,
    );
    const again = await read('A');
    expect(again.written?.counts).toMatchObject({ created: 0, sourceChanged: 0, factsUpdated: 0 });
    expect(again.written?.recorded.created).toBe(false);
    const second = await db().execute(
      sql`SELECT * FROM legacy_product_reviews ORDER BY code_product`,
    );
    expect(second.rows).toEqual(first.rows);
  });

  it('a delivery pass that does not reproduce the verified one writes NOTHING', async () => {
    // A session whose second product scan differs: not a snapshot. The legacy source is
    // never like this; the point is that the review is written only after the read is proven.
    const diverging = {
      label: 'diverging',
      open: async () => {
        const session = await connector('A').open();
        let scans = 0;
        return {
          ...session,
          readSetRows: (table: string, primaryKey: string, columns: readonly string[]) => {
            scans += table === 'product' ? 1 : 0;
            const rows = session.readSetRows(table, primaryKey, columns);
            if (table !== 'product' || scans < 2) return rows;
            return (async function* () {
              for await (const row of rows) yield row.map((cell) => (cell === 'p1' ? 'p1x' : cell));
            })();
          },
        };
      },
    };
    const before = await databaseFingerprint(db());
    await expect(
      runProductsRead(
        ctx.container.legacyImporter(),
        diverging,
        {
          expectedFingerprint: fingerprints.A.v1,
          expectedProductsFingerprint: fingerprints.A.products,
          batchSize: 3,
        },
        { scope: tenantA, actor: job, productionLikeTarget: false },
      ),
    ).rejects.toThrow(/READ_SET_SNAPSHOT_DIVERGED/u);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('a stopped tenant is refused and nothing is written', async () => {
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(read('A')).rejects.toThrow();
    const rows = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM legacy_product_reviews`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  // --- decisions -----------------------------------------------------------------------

  it('approve-as-new creates a draft NOBODY can order, with no price, in one transaction', async () => {
    await read('A');
    const p3 = await rowByCode('p3');
    const decided = await service().approveNew(tenantA, owner, p3.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p3.factsChecksum,
      expectedVersion: p3.version,
      title: p3.title,
      durationDays: p3.durationDays,
      trafficBytes: String(p3.trafficBytes),
      reason: null,
    });
    expect(decided.review.state).toBe('APPROVED_NEW');
    expect(decided.review.approvedFactsChecksum).toBe(p3.factsChecksum);
    const productId = decided.review.approvedProductId as string;
    const product = await ctx.container.products.get(tenantA, owner, productId);
    expect(product).toMatchObject({
      status: 'INACTIVE',
      audience: 'HIDDEN',
      categoryId: null,
      panelId: null,
      price: null,
    });
    expect(decided.approvedProductTitle).toBe(p3.title);
    // The historical price reached no product: the only product price in the tenant is null.
    const prices = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM products WHERE tenant_id = ${tenantA.tenantId}
            AND (price_amount IS NOT NULL OR price_currency IS NOT NULL)`,
    );
    expect(prices.rows[0]?.n).toBe(0);
    expect(await auditCount('product.create')).toBe(1);
    expect(await auditCount('legacy.product_review.approve_new')).toBe(1);

    // Ordered by direct reference by a real customer: refused.
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      { ...job, surface: 'TELEGRAM' },
      {
        idempotencyKey: 'resolve-lpr',
        telegramUserId: '900777',
        from: { id: 900777, first_name: 'تست' },
        botInstanceId: SEED_IDS.botA1 as BotInstanceId,
      },
    );
    await expect(
      ctx.container.orders.createDraft(tenantA, job, {
        idempotencyKey: 'order-draft',
        customerId: customer.id,
        productId,
      }),
    ).rejects.toMatchObject({ code: 'commerce.product_not_purchasable' });
  });

  it('approve-existing maps; a replay is the same decision; reject and reopen move by rule', async () => {
    await read('A');
    const target = await activeProduct();
    const p1 = await rowByCode('p1');
    const body = {
      idempotencyKey: key(),
      expectedFactsChecksum: p1.factsChecksum,
      expectedVersion: p1.version,
      productId: target,
      reason: 'same plan',
    };
    const first = await service().approveExisting(tenantA, owner, p1.id, body);
    expect(first.review).toMatchObject({ state: 'APPROVED_EXISTING', approvedProductId: target });
    const replay = await service().approveExisting(tenantA, owner, p1.id, body);
    expect(replay.review.version).toBe(first.review.version);
    expect(await auditCount('legacy.product_review.approve_existing')).toBe(1);
    // A second decision on a decided row is refused: it must be reopened first.
    await expect(
      service().reject(tenantA, owner, p1.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p1.factsChecksum,
        expectedVersion: p1.version,
        reason: 'no',
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.not_in_state' });
    const reopened = await service().reopen(tenantA, owner, p1.id, {
      idempotencyKey: key(),
      expectedVersion: first.review.version,
      reason: 'look again',
    });
    expect(reopened.review).toMatchObject({
      state: 'PENDING_REVIEW',
      approvedProductId: null,
      approvedFactsChecksum: null,
    });
    // Approving against facts the operator did not see is refused.
    await expect(
      service().approveExisting(tenantA, owner, p1.id, {
        ...body,
        idempotencyKey: key(),
        expectedFactsChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.facts_changed' });
    const rejected = await service().reject(tenantA, owner, p1.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p1.factsChecksum,
      expectedVersion: reopened.review.version,
      reason: 'not migrating it',
    });
    expect(rejected.review.state).toBe('REJECTED');
  });

  it('a duplicated code cannot be approved, only rejected; an unknown product is refused', async () => {
    await read('A');
    const target = await activeProduct();
    const dup = await rowByCode('dup');
    await expect(
      service().approveExisting(tenantA, owner, dup.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: dup.factsChecksum,
        expectedVersion: dup.version,
        productId: target,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.source_conflict' });
    const p2 = await rowByCode('p2');
    await expect(
      service().approveExisting(tenantA, owner, p2.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p2.factsChecksum,
        expectedVersion: p2.version,
        productId: '0190a000-0000-7000-8000-000000000000',
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.product_not_found' });
    expect(
      (
        await service().reject(tenantA, owner, dup.id, {
          idempotencyKey: key(),
          expectedFactsChecksum: dup.factsChecksum,
          expectedVersion: dup.version,
          reason: 'two rows',
        })
      ).review.state,
    ).toBe('REJECTED');
  });

  it('permissions: operator and observer may neither view nor decide; denials are audited', async () => {
    await read('A');
    const p1 = await rowByCode('p1');
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-lpr', roleKeys: ['operator'] }),
    );
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-lpr', roleKeys: ['observer'] }),
    );
    for (const actor of [operator, observer]) {
      await expect(service().list(tenantA, actor, {})).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(
        service().reject(tenantA, actor, p1.id, {
          idempotencyKey: key(),
          expectedFactsChecksum: p1.factsChecksum,
          expectedVersion: p1.version,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    }
    expect(await auditCount('legacy.product_review.reject', 'DENIED')).toBe(2);

    // decide (and view) without catalog.edit: approve-as-new is refused, audited, no product.
    const decider = await createAdmin(ctx.container, tenantA, { username: 'decider-lpr' });
    await db().execute(sql`
      INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
      VALUES (${tenantA.tenantId}, ${decider.id}, 'legacy.products.view', 'GRANT', 'test'),
             (${tenantA.tenantId}, ${decider.id}, 'legacy.products.decide', 'GRANT', 'test')`);
    const p3 = await rowByCode('p3');
    await expect(
      service().approveNew(tenantA, adminActorFor(decider), p3.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p3.factsChecksum,
        expectedVersion: p3.version,
        title: 'x',
        durationDays: 30,
        trafficBytes: '1',
        reason: null,
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect(await auditCount('product.create', 'DENIED')).toBe(1);
    const products = await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM products
      WHERE tenant_id = ${tenantA.tenantId} AND audience = 'HIDDEN'`);
    expect(products.rows[0]?.n).toBe(0);
    // ... while the same admin may reject.
    expect(
      (
        await service().reject(tenantA, adminActorFor(decider), p3.id, {
          idempotencyKey: key(),
          expectedFactsChecksum: p3.factsChecksum,
          expectedVersion: p3.version,
          reason: 'no',
        })
      ).review.state,
    ).toBe('REJECTED');
  });

  it('tenant isolation: another tenant neither sees nor decides these rows', async () => {
    await read('A');
    const p1 = await rowByCode('p1');
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-lpr', roleKeys: ['owner'] }),
    );
    expect((await service().list(tenantB, ownerB, {})).items).toEqual([]);
    await expect(service().get(tenantB, ownerB, p1.id)).rejects.toMatchObject({
      code: 'legacy_product_review.not_found',
    });
    await expect(
      service().reject(tenantB, ownerB, p1.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p1.factsChecksum,
        expectedVersion: p1.version,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.not_found' });
    // Tenant B's own read is its own rows.
    await read('A', 'approved', tenantB);
    expect((await service().list(tenantB, ownerB, {})).items.length).toBeGreaterThan(0);
    expect((await rowByCode('p1')).state).toBe('PENDING_REVIEW');
  });

  // --- the HTTP surface ------------------------------------------------------------------

  it('the Web Admin surface: the wire shape parses, a decision goes through the service', async () => {
    await read('A');
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'lpr-web' as CorrelationId,
      },
      { username: 'owner-lpr', password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    type WebRequest = Parameters<LegacyProductsController['list']>[0];
    const request = (method: string) =>
      ({
        method,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.10',
      }) as unknown as WebRequest;
    const controller = new LegacyProductsController(ctx.container);
    const listed = legacyProductReviewListResponseSchema.parse(
      await controller.list(request('GET'), { attention: 'true', limit: '5' }),
    );
    expect(listed.reviews).toHaveLength(5);
    expect(listed.nextCursor).toBe(listed.reviews[4]?.codeProduct);
    const next = legacyProductReviewListResponseSchema.parse(
      await controller.list(request('GET'), { attention: 'true', after: listed.nextCursor }),
    );
    expect(next.reviews.map((r) => r.codeProduct)).not.toContain(listed.reviews[0]?.codeProduct);
    const p1 = listed.reviews.find((r) => r.codeProduct === 'p1');
    expect(p1).toMatchObject({
      historicalPriceMinor: '150000',
      historicalPriceCurrency: 'IRT',
      exportable: false,
    });
    const rejected = legacyProductReviewResponseSchema.parse(
      await controller.reject(request('POST'), p1?.id ?? '', {
        idempotencyKey: key(),
        expectedFactsChecksum: p1?.factsChecksum,
        expectedVersion: p1?.version,
        reason: 'از طریق وب',
      }),
    );
    expect(rejected.review.state).toBe('REJECTED');
    expect(rejected.review.decisionReason).toBe('از طریق وب');
    // A body that asks the draft for a price is refused by the strict schema.
    await expect(
      controller.approveNew(request('POST'), p1?.id ?? '', {
        idempotencyKey: key(),
        expectedFactsChecksum: p1?.factsChecksum,
        expectedVersion: p1?.version,
        title: 'x',
        durationDays: 30,
        trafficBytes: '1',
        price: { amountMinor: '150000', currency: 'IRT' },
      }),
    ).rejects.toThrow();
  });

  // --- a newer snapshot, and the export --------------------------------------------------

  it('snapshot B: a changed approved product is SOURCE_CHANGED, a vanished one marked, a new one pending', async () => {
    await read('A');
    const target = await activeProduct();
    const p1 = await rowByCode('p1');
    await service().approveExisting(tenantA, owner, p1.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p1.factsChecksum,
      expectedVersion: p1.version,
      productId: target,
      reason: null,
    });
    const p5 = await rowByCode('p5');
    await service().reject(tenantA, owner, p5.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p5.factsChecksum,
      expectedVersion: p5.version,
      reason: 'gift, not migrated',
    });
    const p3 = await rowByCode('p3');
    await service().approveNew(tenantA, owner, p3.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p3.factsChecksum,
      expectedVersion: p3.version,
      title: 'twin',
      durationDays: 30,
      trafficBytes: String(p3.trafficBytes),
      reason: null,
    });

    const exportedA = await service().exportMapping(tenantA, job, fingerprints.A.products);
    expect(exportedA.products.map((p) => p.codeProduct)).toEqual(['p1', 'p3']);

    const outcome = await read('B');
    expect(outcome.written?.counts).toMatchObject({
      created: 1,
      sourceChanged: 2,
      markedMissing: 1,
    });
    expect(await rowByCode('p1')).toMatchObject({
      state: 'SOURCE_CHANGED',
      priorState: 'APPROVED_EXISTING',
      approvedProductId: target,
      historicalPriceMinor: 160000n,
    });
    expect(await rowByCode('p5')).toMatchObject({
      state: 'SOURCE_CHANGED',
      priorState: 'REJECTED',
      missingSinceReadFingerprint: fingerprints.B.products,
    });
    expect((await rowByCode('p20')).state).toBe('PENDING_REVIEW');
    expect((await rowByCode('p3')).state).toBe('APPROVED_NEW');
    expect(await auditCount('legacy.product_review.source_changed')).toBe(2);

    // The export follows the APPROVED read: A's approval no longer describes the review.
    await expect(
      service().exportMapping(tenantA, job, fingerprints.A.products),
    ).rejects.toMatchObject({
      code: 'legacy_product_review.not_in_state',
    });
    const exportedB = await service().exportMapping(tenantA, job, fingerprints.B.products);
    expect(exportedB.products).toEqual([
      { codeProduct: 'p3', productId: (await rowByCode('p3')).approvedProductId },
    ]);
    expect(exportedB.notExported['SOURCE_CHANGED']).toBe(1);
    expect(exportedB.notExported['ABSENT_FROM_READ']).toBe(1);

    // A vanished code cannot be approved; a changed one is decided again, never silently.
    const p5b = await rowByCode('p5');
    await expect(
      service().approveExisting(tenantA, owner, p5b.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p5b.factsChecksum,
        expectedVersion: p5b.version,
        productId: target,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'legacy_product_review.source_absent' });
    const p1b = await rowByCode('p1');
    const again = await service().approveExisting(tenantA, owner, p1b.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p1b.factsChecksum,
      expectedVersion: p1b.version,
      productId: target,
      reason: 'price change only',
    });
    expect(again.review).toMatchObject({ state: 'APPROVED_EXISTING', priorState: null });
    expect(
      (await service().exportMapping(tenantA, job, fingerprints.B.products)).products.map(
        (p) => p.codeProduct,
      ),
    ).toEqual(['p1', 'p3']);

    // Re-reading A afterwards (an OLDER snapshot) is again a changed source, never a revert.
    await read('A');
    expect((await rowByCode('p1')).state).toBe('SOURCE_CHANGED');
    expect(await rowByCode('p5')).toMatchObject({ missingSinceReadFingerprint: null });
  });

  it('a code absent from two reads in a row is acknowledged by each: the later read exports', async () => {
    await read('A');
    const target = await activeProduct();
    const p3 = await rowByCode('p3');
    const p5 = await rowByCode('p5');
    await service().reject(tenantA, owner, p5.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p5.factsChecksum,
      expectedVersion: p5.version,
      reason: 'gift',
    });
    await service().approveExisting(tenantA, owner, p3.id, {
      idempotencyKey: key(),
      expectedFactsChecksum: p3.factsChecksum,
      expectedVersion: p3.version,
      productId: target,
      reason: null,
    });
    await read('B'); // p5 vanishes: SOURCE_CHANGED, absent in B
    expect((await rowByCode('p5')).missingSinceReadFingerprint).toBe(fingerprints.B.products);
    const c = await read('C'); // p5 is STILL gone; p20 changed
    expect(c.written?.counts).toMatchObject({ stillAbsent: 1, markedMissing: 0 });
    expect(await rowByCode('p5')).toMatchObject({
      state: 'SOURCE_CHANGED',
      priorState: 'REJECTED',
      missingSinceReadFingerprint: fingerprints.C.products,
    });
    const exported = await service().exportMapping(tenantA, job, fingerprints.C.products);
    expect(exported.products).toEqual([{ codeProduct: 'p3', productId: target }]);
    expect(exported.notExported['ABSENT_FROM_READ']).toBe(1);
    // Re-reading C acknowledges nothing new.
    const again = await read('C');
    expect(again.written?.counts).toMatchObject({ stillAbsent: 0, markedMissing: 0 });
  });

  it('the table refuses an approval without its product and a forged state', async () => {
    await read('A');
    const p2 = await rowByCode('p2');
    const refusal = async (statement: Promise<unknown>) => {
      try {
        await statement;
        return 'ACCEPTED';
      } catch (error) {
        const e = error as { cause?: { constraint?: string; message?: string } };
        return `${e.cause?.constraint ?? ''} ${e.cause?.message ?? ''}`;
      }
    };
    expect(
      await refusal(
        db().execute(
          sql`UPDATE legacy_product_reviews SET state = 'APPROVED_EXISTING' WHERE id = ${p2.id}`,
        ),
      ),
    ).toMatch(/legacy_product_reviews_approval_check/u);
    expect(
      await refusal(
        db().execute(sql`UPDATE legacy_product_reviews SET state = 'MAYBE' WHERE id = ${p2.id}`),
      ),
    ).toMatch(/legacy_product_reviews_state_check/u);
    expect(
      await refusal(
        db().execute(
          sql`UPDATE legacy_product_reviews SET historical_price_currency = 'IRR', historical_price_minor = 1 WHERE id = ${p2.id}`,
        ),
      ),
    ).toMatch(/legacy_product_reviews_price_check/u);
  });
});
