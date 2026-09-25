import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type PanelId,
  type ProductAudience,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/** The public catalogue: what every ordinary customer sees (WP9-B R6). */
const CUSTOMER_AUDIENCE = { kind: 'CUSTOMER' } as const;

/**
 * The two customer browse queries, at the repository, where their predicates live.
 *
 * The surface tests in `telegram-order-flow.test.ts` prove what a customer SEES. These
 * prove two properties those cannot reach, because the service in front of them
 * happens to mask both:
 *
 *   1. The TENANT predicate stands on its own. Through the service, the eligible-panel
 *      list is already tenant-scoped and the foreign keys are composite, so a query
 *      that dropped its own tenant term would still look correct. A repository that
 *      trusts its caller's panel list for isolation is one refactor away from a leak,
 *      so the cases below hand it ANOTHER tenant's panel and assert nothing comes back.
 *
 *   2. The two queries AGREE. The category list decides non-emptiness with an EXISTS
 *      that restates the product predicate inline, and the product page applies it
 *      through `customerVisibleProduct`. If they ever disagree, a customer is offered a
 *      category that opens on an empty page — the dead end §6.3 says never to show.
 */
describe('the categorised customer catalogue, at the repository', () => {
  let ctx: TestContext;
  let repository: DrizzleProductRepository;
  let panelA: string;
  let panelB: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    repository = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
  });

  async function sellable(
    scope: typeof tenantA,
    panelId: string,
    categoryId: string,
    overrides: { audience?: ProductAudience; price?: null; status?: 'ACTIVE' | 'INACTIVE' } = {},
  ): Promise<string> {
    const created = await repository.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: overrides.audience ?? 'EVERYONE',
        sortOrder: 1,
        panelId: panelId as PanelId,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: overrides.price === null ? null : money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    if ((overrides.status ?? 'ACTIVE') === 'ACTIVE') {
      await repository.setStatus(
        scope,
        created.id,
        'INACTIVE',
        'ACTIVE',
        ctx.container.clock.now(),
      );
    }
    return created.id;
  }

  async function category(
    fields: { status?: 'ACTIVE' | 'INACTIVE'; visibility?: 'VISIBLE' | 'HIDDEN' } = {},
  ): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, status, visibility, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, 'دسته', ${fields.status ?? 'ACTIVE'},
              ${fields.visibility ?? 'VISIBLE'}, 3)`);
    return id;
  }

  describe('tenant isolation, with the caller handed another tenant panel', () => {
    it('lists none of another tenant categories, whatever panels it is told are eligible', async () => {
      // Tenant B has a perfectly sellable category. Tenant A asks with B's panel in its
      // eligible list — the one input that could make B's row pass every OTHER term.
      await sellable(tenantB, panelB, SEED_IDS.categoryB);

      const page = await repository.listCustomerCategories(
        tenantA,
        8,
        0,
        [panelB],
        CUSTOMER_AUDIENCE,
      );

      expect(
        page.items.map((c) => c.id),
        'another tenant category reached this tenant list',
      ).not.toContain(SEED_IDS.categoryB);
      expect(page.items).toHaveLength(0);
    });

    it('opens another tenant category on an EMPTY page, whatever panels it is told are eligible', async () => {
      const theirs = await sellable(tenantB, panelB, SEED_IDS.categoryB);

      const page = await repository.listCustomerProductsInCategory(
        tenantA,
        SEED_IDS.categoryB,
        8,
        0,
        [panelB],
        CUSTOMER_AUDIENCE,
      );

      expect(
        page.items.map((p) => p.id),
        'another tenant product was browsable',
      ).not.toContain(theirs);
      expect(page.items).toHaveLength(0);
    });
  });

  describe('the category list and the product page agree', () => {
    /*
     * Every way a single product can fail, one category each. For each, the category
     * is listed EXACTLY when its first product page is non-empty — asserted in both
     * directions, so a list that offered a dead end and a list that hid a category
     * with something to sell both fail.
     */
    const cases: readonly {
      readonly label: string;
      readonly product: Parameters<typeof sellable>[3];
      readonly category?: Parameters<typeof category>[0];
      readonly sellable: boolean;
    }[] = [
      { label: 'an ordinary product', product: {}, sellable: true },
      { label: 'an INACTIVE product', product: { status: 'INACTIVE' }, sellable: false },
      { label: 'a HIDDEN-audience product', product: { audience: 'HIDDEN' }, sellable: false },
      {
        label: 'a resellers-only product',
        product: { audience: 'RESELLERS_ONLY' },
        sellable: false,
      },
      { label: 'an unpriced product', product: { price: null }, sellable: false },
      {
        label: 'a product in a HIDDEN category',
        product: {},
        category: { visibility: 'HIDDEN' },
        sellable: false,
      },
      {
        label: 'a product in an INACTIVE category',
        product: {},
        category: { status: 'INACTIVE' },
        sellable: false,
      },
    ];

    it.each(cases)(
      'agrees about $label',
      async ({ product, category: fields, sellable: expected }) => {
        const id = await category(fields);
        await sellable(tenantA, panelA, id, product);

        const listed = (
          await repository.listCustomerCategories(tenantA, 50, 0, [panelA], CUSTOMER_AUDIENCE)
        ).items
          .map((c) => c.id)
          .includes(id as ProductCategoryId);
        const page = await repository.listCustomerProductsInCategory(
          tenantA,
          id,
          8,
          0,
          [panelA],
          CUSTOMER_AUDIENCE,
        );

        expect(listed, 'the category list disagrees with the expectation').toBe(expected);
        expect(page.items.length > 0, 'the product page disagrees with the category list').toBe(
          listed,
        );
      },
    );

    it('agrees about a product on a panel that is not eligible', async () => {
      // Eligibility is decided once, by `PanelSalesGate`, and handed in. Both queries
      // must honour the SAME list — a panel absent from it sells nothing in either.
      const id = await category();
      await sellable(tenantA, panelA, id);

      const listed = (
        await repository.listCustomerCategories(tenantA, 50, 0, [], CUSTOMER_AUDIENCE)
      ).items;
      const page = await repository.listCustomerProductsInCategory(
        tenantA,
        id,
        8,
        0,
        [],
        CUSTOMER_AUDIENCE,
      );

      expect(listed).toHaveLength(0);
      expect(page.items).toHaveLength(0);
    });
  });

  describe('paging', () => {
    it('reads hasMore from the data, and a page past the end is empty rather than an error', async () => {
      const id = await category();
      for (let i = 0; i < 3; i += 1) await sellable(tenantA, panelA, id);

      const first = await repository.listCustomerProductsInCategory(
        tenantA,
        id,
        2,
        0,
        [panelA],
        CUSTOMER_AUDIENCE,
      );
      const second = await repository.listCustomerProductsInCategory(
        tenantA,
        id,
        2,
        2,
        [panelA],
        CUSTOMER_AUDIENCE,
      );
      const beyond = await repository.listCustomerProductsInCategory(
        tenantA,
        id,
        2,
        4,
        [panelA],
        CUSTOMER_AUDIENCE,
      );

      expect([first.items.length, first.hasMore]).toStrictEqual([2, true]);
      expect([second.items.length, second.hasMore]).toStrictEqual([1, false]);
      expect([beyond.items.length, beyond.hasMore]).toStrictEqual([0, false]);
      // No product appears on two pages.
      const seen = [...first.items, ...second.items].map((p) => p.id);
      expect(new Set(seen).size).toBe(3);
    });
  });
});
