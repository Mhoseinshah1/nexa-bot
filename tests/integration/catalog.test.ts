import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type PanelId,
  type ProductAudience,
  type ProductId,
  type ProductStatus,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  isCustomerVisible,
  unorderableReason,
} from '../../apps/api/src/modules/commerce/catalog/application/catalog-visibility';
import type {
  ProductDraft,
  ProductRecord,
} from '../../apps/api/src/modules/commerce/catalog/application/ports';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The customer catalogue, and the three-way distinction it turns on.
 *
 * `LISTED`, `HIDDEN` and `INACTIVE` are not a boolean, and collapsing them is the
 * defect `catalog.ts` exists to prevent: it would make "unlist this" and "stop selling
 * this" the same button, and only one of those is reversible without refunds. So there
 * are two predicates here and they give DIFFERENT answers for the same product:
 *
 *   - catalogue membership — listed AND priced AND fulfillable
 *   - orderability — purchasable AND priced AND fulfillable
 *
 * A `HIDDEN` product satisfies the second and fails the first, which is exactly how a
 * tenant sells something to one customer without publishing it.
 *
 * The other thing this file exists for is the DUPLICATION. `listCatalog` states the
 * membership rule in SQL so a product a customer may not see never leaves the database,
 * and `isCustomerVisible` states it in TypeScript so no other caller re-derives it
 * slightly differently. Two statements of one rule is a liability unless something
 * proves they agree, and that is the matrix below — without it the SQL predicate would
 * be free to drift into a second vocabulary.
 */

const ALL_STATUSES: readonly ProductStatus[] = ['ACTIVE', 'INACTIVE'];
const ALL_AUDIENCES: readonly ProductAudience[] = ['EVERYONE', 'RESELLERS_ONLY', 'HIDDEN'];

describe('the customer catalogue', () => {
  let ctx: TestContext;
  let repository: DrizzleProductRepository;
  let panelA: string;

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
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
  });

  /** A sellable draft. Each case spoils exactly one property. */
  const draft = (overrides: Partial<ProductDraft> = {}): ProductDraft => ({
    title: 'پلن پایه',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA as PanelId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    ...overrides,
  });

  /**
   * Creates a product and puts it in the requested status.
   *
   * Through the repository, because `create` always writes INACTIVE — the rule the
   * product service depends on — so reaching ACTIVE means moving it, which is what
   * production does too.
   */
  async function productIn(
    scope: typeof tenantA,
    status: ProductStatus,
    overrides: Partial<ProductDraft> = {},
  ): Promise<ProductRecord> {
    const created = await repository.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(overrides),
      now: ctx.container.clock.now(),
    });
    if (status === 'ACTIVE') {
      await repository.setStatus(
        scope,
        created.id,
        'INACTIVE',
        'ACTIVE',
        ctx.container.clock.now(),
      );
    }
    const after = await repository.findById(scope, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  const catalogueIds = async (scope: typeof tenantA, limit = 50) =>
    (await repository.listCatalog(scope, limit)).items.map((p) => p.id);

  // -------------------------------------------------------------------------
  // The two predicates, and where they disagree
  // -------------------------------------------------------------------------

  it('lists a product that is listed, priced and fulfillable, and lets it be ordered', async () => {
    const product = await productIn(tenantA, 'ACTIVE');
    expect(await catalogueIds(tenantA)).toEqual([product.id]);
    expect(isCustomerVisible(product)).toBe(true);
    expect(unorderableReason(product)).toBeNull();
  });

  it('keeps a HIDDEN product OUT of the catalogue while leaving it orderable', async () => {
    /*
     * The case the whole three-value audience exists for.
     *
     * `catalog.ts`: a HIDDEN product "is live and simply not listed — which is how a
     * tenant sells something to one customer without publishing it". So the two
     * predicates must disagree here, and a test that only checked the catalogue would
     * pass just as well if HIDDEN had been collapsed into INACTIVE.
     */
    const hidden = await productIn(tenantA, 'ACTIVE', { audience: 'HIDDEN' });

    expect(await catalogueIds(tenantA), 'a hidden product was published').toEqual([]);
    expect(isCustomerVisible(hidden)).toBe(false);
    // ...and yet it can be bought by a customer who was given its reference.
    expect(unorderableReason(hidden), 'a hidden product was made unorderable').toBeNull();
  });

  it('makes an INACTIVE product neither listed nor orderable', async () => {
    const inactive = await productIn(tenantA, 'INACTIVE');
    expect(await catalogueIds(tenantA)).toEqual([]);
    expect(isCustomerVisible(inactive)).toBe(false);
    // The difference from HIDDEN, stated as an assertion rather than a comment.
    expect(unorderableReason(inactive)).toBe('NOT_PURCHASABLE');
  });

  it('excludes an UNPRICED product, because absent is not free', async () => {
    const unpriced = await productIn(tenantA, 'ACTIVE', { price: null });
    expect(await catalogueIds(tenantA)).toEqual([]);
    expect(isCustomerVisible(unpriced)).toBe(false);
    expect(unorderableReason(unpriced)).toBe('NOT_PRICED');
  });

  it('excludes an UNFULFILLABLE product, and names that reason rather than the price', async () => {
    const unfulfillable = await productIn(tenantA, 'ACTIVE', { panelId: null });
    expect(await catalogueIds(tenantA)).toEqual([]);
    expect(isCustomerVisible(unfulfillable)).toBe(false);
    /*
     * The reason is FULFILLMENT, not price — this product has a price.
     *
     * `catalog.ts` requires the refusal to name the product rather than hide it,
     * "because the refusal message an operator needs names the product". A reason that
     * said NOT_PRICED would send them to fix a field that is already correct.
     */
    expect(unorderableReason(unfulfillable)).toBe('NOT_FULFILLABLE');
  });

  it('reports the FIRST failing rule when a product breaks more than one', async () => {
    // Withdrawn AND unpriced. Status comes first because it is the operator's own
    // decision to stop selling; reporting "not priced" would send them to the wrong field.
    const both = await productIn(tenantA, 'INACTIVE', { price: null });
    expect(unorderableReason(both)).toBe('NOT_PURCHASABLE');
  });

  // -------------------------------------------------------------------------
  // The SQL predicate and the TypeScript one, over the whole matrix
  // -------------------------------------------------------------------------

  it('agrees with isCustomerVisible over every status, audience, price and panel', async () => {
    /*
     * Twenty-four products: 2 statuses x 3 audiences x priced/unpriced x
     * fulfillable/unfulfillable. Every combination, so neither predicate can be right
     * for the cases somebody thought of and wrong for one they did not.
     *
     * The comparison is set-to-set. `listCatalog` answers from PostgreSQL and
     * `isCustomerVisible` from TypeScript, and the assertion is that they select the
     * same products out of the same population — which is the only thing that makes
     * having two statements of one rule safe.
     */
    const all: ProductRecord[] = [];
    for (const status of ALL_STATUSES) {
      for (const audience of ALL_AUDIENCES) {
        for (const priced of [true, false]) {
          for (const fulfillable of [true, false]) {
            all.push(
              await productIn(tenantA, status, {
                audience,
                price: priced ? money(250_000n, 'IRT') : null,
                panelId: fulfillable ? (panelA as PanelId) : null,
              }),
            );
          }
        }
      }
    }
    expect(all).toHaveLength(24);

    const fromSql = new Set(await catalogueIds(tenantA, 100));
    const fromTypescript = new Set(all.filter(isCustomerVisible).map((p) => p.id));

    expect([...fromSql].sort(), 'the SQL and TypeScript rules disagree').toEqual(
      [...fromTypescript].sort(),
    );
    // And the rule actually selects something, so the agreement is not two empty sets.
    // ACTIVE x {EVERYONE, RESELLERS_ONLY} x priced x fulfillable = 2.
    expect(fromSql.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Ordering, bounds and tenancy
  // -------------------------------------------------------------------------

  it('orders by sortOrder, then createdAt, then id — deterministically', async () => {
    const third = await productIn(tenantA, 'ACTIVE', { sortOrder: 30, title: 'third' });
    const first = await productIn(tenantA, 'ACTIVE', { sortOrder: 10, title: 'first' });
    const second = await productIn(tenantA, 'ACTIVE', { sortOrder: 20, title: 'second' });
    // Two products sharing a sortOrder fall back to creation order, which is stable.
    const alsoFirst = await productIn(tenantA, 'ACTIVE', { sortOrder: 10, title: 'also first' });

    expect(await catalogueIds(tenantA)).toEqual([first.id, alsoFirst.id, second.id, third.id]);

    // Re-read gives the same answer: nothing here depends on physical row order.
    expect(await catalogueIds(tenantA)).toEqual([first.id, alsoFirst.id, second.id, third.id]);
  });

  it('bounds the page and says there are more rather than handing out a cursor', async () => {
    for (let i = 0; i < 4; i += 1) {
      await productIn(tenantA, 'ACTIVE', { sortOrder: i, title: `plan ${String(i)}` });
    }
    const page = await repository.listCatalog(tenantA, 2);
    expect(page.items).toHaveLength(2);
    /*
     * `hasMore`, not a cursor.
     *
     * The catalogue orders by `sort_order` and that column is mutable — an operator
     * re-orders it — so a keyset over it could skip a product mid-browse. Being told
     * there are more is honest; a cursor that silently drops one is not.
     */
    expect(page.hasMore).toBe(true);

    const whole = await repository.listCatalog(tenantA, 50);
    expect(whole.items).toHaveLength(4);
    expect(whole.hasMore).toBe(false);
  });

  it('never shows one tenant another tenant catalogue', async () => {
    const bPanel = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${bPanel}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);

    const mine = await productIn(tenantA, 'ACTIVE', { title: 'A plan' });
    const theirs = await repository.create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft({ title: 'B plan', panelId: bPanel as PanelId }),
      now: ctx.container.clock.now(),
    });
    await repository.setStatus(tenantB, theirs.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    expect(await catalogueIds(tenantA)).toEqual([mine.id]);
    expect(await catalogueIds(tenantB)).toEqual([theirs.id]);
  });

  it('exposes no panel configuration through a catalogue row', async () => {
    // A product NAMES a panel. The panel's address and credentials belong to `/panels`
    // behind its own permission, and a catalogue read by a customer must not carry them.
    await productIn(tenantA, 'ACTIVE');
    const [row] = (await repository.listCatalog(tenantA, 10)).items;
    const serialised = JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('example.test');
    expect(serialised).not.toContain('sanaei');
  });
});
