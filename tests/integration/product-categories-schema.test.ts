import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  DEFAULT_PRODUCT_CATEGORY_NAME,
  money,
  uuidV7Schema,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * What the DATABASE refuses about a category, measured rather than asserted in prose.
 *
 * Every rule here is a CHECK or a foreign key rather than a service predicate, and each
 * one is in the schema because the application check above it can be bypassed: a
 * migration, a repair script, a future service written by somebody who has not read
 * `catalog-visibility.ts`. `nexa-migrations` is explicit that the invariants this suite
 * exists for live IN the database and a mock cannot express them.
 *
 * Two of these cases are the owner's WP5 decisions expressed as constraints:
 *
 * - **a category holding products cannot be deleted** is `products_tenant_category_fk`
 *   with `ON DELETE NO ACTION`. `SET NULL` was the alternative and is worse: the delete
 *   would succeed and silently strand every product in it uncategorised, which is how
 *   an operator's tidy-up empties a shop.
 * - **the emoji bound is in CODE POINTS**, so a family emoji — four code points, eleven
 *   UTF-16 units — is accepted while a nine-character string of ASCII is refused. A
 *   bound written in `.length` would have got that exactly backwards.
 */
describe('what the database refuses about a product category', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  /*
   * Raw client, not `db.execute`, and that is the difference between a test that can
   * fail for the right reason and one that cannot tell you why it failed.
   *
   * Drizzle wraps a driver error as `Failed query: <sql> params: <...>` and puts the
   * PostgreSQL message on `cause`, so `rejects.toThrow(/product_categories_emoji_check/)`
   * never matches and every case here would have been asserting only "something went
   * wrong". `database-invariants.test.ts` uses `withClient` for exactly this reason.
   */
  const query = async (text: string, params: readonly unknown[] = []) =>
    ctx.container.database.withClient((client) => client.query(text, [...params]));

  const insertCategory = async (
    tenantId: string,
    columns: { name?: string; emoji?: string | null; status?: string; visibility?: string },
  ): Promise<unknown> =>
    query(
      `INSERT INTO product_categories (id, tenant_id, name, emoji, status, visibility)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.container.ids.uuid(),
        tenantId,
        columns.name ?? 'a category',
        columns.emoji ?? null,
        columns.status ?? 'ACTIVE',
        columns.visibility ?? 'VISIBLE',
      ],
    );

  // -------------------------------------------------------------------------
  // The emoji, which is optional and must stay optional
  // -------------------------------------------------------------------------

  it('accepts a category with no emoji at all', async () => {
    await expect(insertCategory(tenantA.tenantId, { emoji: null })).resolves.toBeDefined();
  });

  it('accepts a family emoji, which is seven code points and eleven UTF-16 units', async () => {
    /*
     * The case the code-point bound exists for, and the one that corrected the bound's
     * own description. `'👨‍👩‍👧‍👦'.length` is 11, so a bound written in UTF-16 units at 8
     * would refuse this ordinary grapheme while admitting the nine ASCII characters the
     * next case refuses — exactly backwards.
     *
     * It is SEVEN code points, not four: the three zero-width joiners between the four
     * people are code points too. Measured rather than reasoned, because the first
     * version of this test asserted four and was wrong. That makes the bound of eight
     * tighter than it looks — a four-person family fits with one to spare, and a longer
     * ZWJ sequence would not. Recorded here so the next person to raise the bound knows
     * what they are buying.
     */
    expect('👨‍👩‍👧‍👦'.length).toBe(11);
    expect([...'👨‍👩‍👧‍👦'].length).toBe(7);
    await expect(insertCategory(tenantA.tenantId, { emoji: '👨‍👩‍👧‍👦' })).resolves.toBeDefined();
  });

  it('refuses an emoji longer than the code-point bound', async () => {
    await expect(insertCategory(tenantA.tenantId, { emoji: '123456789' })).rejects.toThrowError(
      /product_categories_emoji_check/,
    );
  });

  it('refuses an emoji containing a line break', async () => {
    /*
     * Not cosmetic. This value is rendered into a Telegram inline-keyboard label built
     * from tenant data, and a newline there is a broken button. The constraint is what
     * stops the row existing, so no surface has to defend against it.
     */
    await expect(insertCategory(tenantA.tenantId, { emoji: 'a\nb' })).rejects.toThrowError(
      /product_categories_emoji_check/,
    );
  });

  it('refuses an emoji that is only whitespace', async () => {
    await expect(insertCategory(tenantA.tenantId, { emoji: '   ' })).rejects.toThrowError(
      /product_categories_emoji_check/,
    );
  });

  // -------------------------------------------------------------------------
  // Name and the two enums
  // -------------------------------------------------------------------------

  it('refuses an empty name', async () => {
    await expect(insertCategory(tenantA.tenantId, { name: '' })).rejects.toThrowError(
      /product_categories_name_check/,
    );
  });

  it('refuses a status outside the contract enum', async () => {
    await expect(insertCategory(tenantA.tenantId, { status: 'ARCHIVED' })).rejects.toThrowError(
      /product_categories_status_check/,
    );
  });

  it('refuses a visibility outside the contract enum', async () => {
    await expect(insertCategory(tenantA.tenantId, { visibility: 'SECRET' })).rejects.toThrowError(
      /product_categories_visibility_check/,
    );
  });

  // -------------------------------------------------------------------------
  // The two rules that are about more than one row
  // -------------------------------------------------------------------------

  it('refuses a product that names the other tenant category', async () => {
    const categoryB = ctx.container.ids.uuid();
    const product = ctx.container.ids.uuid();
    await query(`INSERT INTO product_categories (id, tenant_id, name) VALUES ($1, $2, $3)`, [
      categoryB,
      tenantB.tenantId,
      'tenant B group',
    ]);
    await query(
      `INSERT INTO products (id, tenant_id, title, duration_days, traffic_bytes)
       VALUES ($1, $2, $3, 30, 0)`,
      [product, tenantA.tenantId, 'a product'],
    );

    /*
     * The composite key is what refuses this. A single-column reference to
     * `product_categories(id)` would have accepted it: the row exists, it is simply
     * somebody else's, and every reader downstream would have believed the pointer.
     * `products_tenant_panel_fk` is the same shape for the same reason.
     */
    await expect(
      query(`UPDATE products SET category_id = $1 WHERE id = $2`, [categoryB, product]),
    ).rejects.toThrowError(/products_tenant_category_fk/);
  });

  it('refuses deleting a category that still holds a product', async () => {
    const category = ctx.container.ids.uuid();
    const product = ctx.container.ids.uuid();
    await query(`INSERT INTO product_categories (id, tenant_id, name) VALUES ($1, $2, $3)`, [
      category,
      tenantA.tenantId,
      'holds something',
    ]);
    await query(
      `INSERT INTO products (id, tenant_id, title, duration_days, traffic_bytes, category_id)
       VALUES ($1, $2, $3, 30, 0, $4)`,
      [product, tenantA.tenantId, 'a product', category],
    );

    await expect(
      query(`DELETE FROM product_categories WHERE id = $1`, [category]),
    ).rejects.toThrowError(/products_tenant_category_fk/);

    /* And it is deletable once emptied — the rule is "holds products", not "ever did". */
    await query(`UPDATE products SET category_id = NULL WHERE id = $1`, [product]);
    await expect(
      query(`DELETE FROM product_categories WHERE id = $1`, [category]),
    ).resolves.toBeDefined();
  });
});

/**
 * Every tenant can sell something — the invariant, across all three populations.
 *
 * Stated here rather than assumed, because the three populations are produced by three
 * different mechanisms that cannot see each other: migration 0097 for tenants that had
 * products, migration 0099 for the ones its predicate missed, and
 * `provision-installation` for tenants created afterwards. Nothing in the type system
 * relates them, so only a test keeps them agreeing.
 */
describe('every tenant has a category to sell under', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const query = async (text: string, params: readonly unknown[] = []) =>
    ctx.container.database.withClient((client) => client.query(text, [...params]));

  it('gives a tenant with ZERO products one, which 0097 alone did not', async () => {
    /*
     * The hole 0097 left, closed by 0099 and proven by RUNNING 0099.
     *
     * 0097 backfilled `FROM (SELECT DISTINCT tenant_id FROM products)`, so a tenant that
     * existed at migration time and had sold nothing got no category at all — and its
     * operator's first product would then be refused by a rule they could not satisfy.
     *
     * The setup reproduces exactly that state: a real tenant, no products, no category.
     * The migration file is then executed as written, from disk, so this cannot pass
     * against a version of the SQL that differs from the one that ships.
     */
    await query(`DELETE FROM product_categories WHERE tenant_id = $1`, [tenantB.tenantId]);
    const before = await query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1`, [
      tenantB.tenantId,
    ]);
    expect((before.rows[0] as { n: number }).n, 'the fixture tenant has products').toBe(0);

    await query(readFileSync('apps/api/drizzle/0099_every_tenant_has_a_category.sql', 'utf8'));

    const after = await query(
      `SELECT name, status, visibility FROM product_categories WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(after.rows, 'a product-less tenant was left with nothing to file under').toHaveLength(1);
    expect((after.rows[0] as { name: string }).name).toBe(DEFAULT_PRODUCT_CATEGORY_NAME);
  });

  it('writes no second category when 0099 is applied twice', async () => {
    const sqlText = readFileSync('apps/api/drizzle/0099_every_tenant_has_a_category.sql', 'utf8');
    await query(sqlText);
    await query(sqlText);

    const rows = await query(
      `SELECT tenant_id, count(*)::int AS n FROM product_categories GROUP BY tenant_id
       HAVING count(*) > 1`,
    );
    expect(rows.rows, 'a rerun of 0099 duplicated a category').toEqual([]);
  });

  it('names the default the same thing in the migrations and in the contract', () => {
    /*
     * Three places carry this value and two are raw SQL that can import nothing:
     * 0097's backfill, 0099's, and `DEFAULT_PRODUCT_CATEGORY_NAME`, which the
     * provisioning path uses. A drift between them would give tenants provisioned
     * before and after a release differently-named defaults, with no error anywhere.
     *
     * Read from the files rather than restated, so editing one without the other fails
     * here instead of in somebody's shop.
     */
    for (const file of [
      'apps/api/drizzle/0097_product_categories.sql',
      'apps/api/drizzle/0099_every_tenant_has_a_category.sql',
    ]) {
      expect(readFileSync(file, 'utf8'), `${file} names a different default`).toContain(
        `'${DEFAULT_PRODUCT_CATEGORY_NAME}'`,
      );
    }
  });
});

/**
 * Every category id is a UUIDv7 — including the ones 0097 and 0099 wrote.
 *
 * Both backfills used `gen_random_uuid()`, a version-4 UUID, and every reader of a
 * category id accepts version 7 only: `productCategoryIdSchema` in the service and the
 * HTTP contract, `uuidV7Schema` at the Telegram callback boundary. So an installation
 * upgraded into categories had exactly one category per tenant and could do nothing with
 * it — a customer tapping it was UNSUPPORTED, an operator editing it was refused. Found
 * while wiring the Telegram Admin categories section, whose every button carries that id.
 *
 * 0100 re-keys the row. These cases drive it the way an upgrade does: 0099 writes the v4
 * category exactly as it ships, a product is filed under it, and 0100 runs from disk.
 */
describe('0100 gives every backfilled category a UUIDv7', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const query = async (text: string, params: readonly unknown[] = []) =>
    ctx.container.database.withClient((client) => client.query(text, [...params]));
  const run = (file: string) => query(readFileSync(`apps/api/drizzle/${file}`, 'utf8'));

  /** The upgrade state: tenant B's only category, written by 0099 as it ships. */
  async function backfilledCategory(): Promise<string> {
    await query(`DELETE FROM product_categories WHERE tenant_id = $1`, [tenantB.tenantId]);
    await run('0099_every_tenant_has_a_category.sql');
    const rows = await query(`SELECT id FROM product_categories WHERE tenant_id = $1`, [
      tenantB.tenantId,
    ]);
    return (rows.rows[0] as { id: string }).id;
  }

  async function productUnder(categoryId: string): Promise<string> {
    const panelId = ctx.container.ids.uuid();
    await query(
      `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
       VALUES ($1, $2, 'B', 'sanaei', 'https://b.example.test', 'ACTIVE')`,
      [panelId, tenantB.tenantId],
    );
    const created = await new DrizzleProductRepository(ctx.container.database.db).create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelId as PanelId,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    return created.id;
  }

  const tap = (data: string) => intentOf({ callback_query: { id: 'cbq', data } });

  it('reproduces the defect: the backfilled id is refused by every reader before 0100', async () => {
    /*
     * The evidence the repair is for, kept so a later reader can see the defect was
     * real rather than taking the migration's comment for it. If 0099 ever starts
     * writing v7 ids itself this case fails, and the first assertion says why.
     */
    const legacy = await backfilledCategory();
    expect(uuidV7Schema.safeParse(legacy).success, '0099 no longer writes a v4 id').toBe(false);

    expect(tap(`ck:${legacy}.0`).intent, 'a customer could open the v4 category').toBe(
      'UNSUPPORTED',
    );
    const owner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-rekey', roleKeys: ['owner'] }),
    );
    await expect(ctx.container.productCategories.get(tenantB, owner, legacy)).rejects.toMatchObject(
      { code: 'commerce.request_invalid' },
    );
  });

  it('re-keys it to a v7, keeps every other column, and carries its products with it', async () => {
    const legacy = await backfilledCategory();
    const product = await productUnder(legacy);
    const before = await query(
      `SELECT name, emoji, status, visibility, sort_order, created_at FROM product_categories
       WHERE id = $1`,
      [legacy],
    );

    await run('0100_category_ids_are_uuidv7.sql');

    const after = await query(
      `SELECT id, name, emoji, status, visibility, sort_order, created_at FROM product_categories
       WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(after.rows, 'the re-key added or lost a row').toHaveLength(1);
    const { id: rekeyed, ...rest } = after.rows[0] as { id: string };
    expect(uuidV7Schema.safeParse(rekeyed).success, `${rekeyed} is not a UUIDv7`).toBe(true);
    expect(rest, 'the re-key changed something other than the id').toEqual(before.rows[0]);

    const filed = await query(`SELECT category_id FROM products WHERE id = $1`, [product]);
    expect(
      (filed.rows[0] as { category_id: string }).category_id,
      'the product was left behind',
    ).toBe(rekeyed);

    // And now every reader accepts it.
    expect(tap(`ck:${rekeyed}.0`)).toMatchObject({ intent: 'CATEGORY', targetId: rekeyed });
    const owner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-rekeyed', roleKeys: ['owner'] }),
    );
    await expect(
      ctx.container.productCategories.get(tenantB, owner, rekeyed),
    ).resolves.toMatchObject({ id: rekeyed, name: DEFAULT_PRODUCT_CATEGORY_NAME });
  });

  it('touches no category that already had a v7 id, in this tenant or any other', async () => {
    await backfilledCategory();
    const v7 = `SELECT id, tenant_id, name FROM product_categories
                WHERE substring(id::text FROM 15 FOR 1) = '7' ORDER BY id`;
    const untouched = await query(v7);
    expect(untouched.rows.length, 'the fixture has no v7 category to leave alone').toBeGreaterThan(
      0,
    );

    await run('0100_category_ids_are_uuidv7.sql');

    const survivors = await query(
      `SELECT id, tenant_id, name FROM product_categories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [untouched.rows.map((row) => (row as { id: string }).id)],
    );
    expect(survivors.rows, 'a category that was already v7 was re-keyed').toEqual(untouched.rows);
  });

  it('restores the foreign key, so a category holding products still cannot be deleted', async () => {
    const legacy = await backfilledCategory();
    await productUnder(legacy);
    await run('0100_category_ids_are_uuidv7.sql');

    const constraint = await query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'products_tenant_category_fk'`,
    );
    expect((constraint.rows[0] as { def: string } | undefined)?.def).toBe(
      'FOREIGN KEY (tenant_id, category_id) REFERENCES product_categories(tenant_id, id)',
    );
    await expect(
      query(`DELETE FROM product_categories WHERE tenant_id = $1`, [tenantB.tenantId]),
    ).rejects.toThrow(/products_tenant_category_fk/);
  });

  it('changes nothing when it runs a second time', async () => {
    await backfilledCategory();
    await run('0100_category_ids_are_uuidv7.sql');
    const once = await query(`SELECT id FROM product_categories ORDER BY id`);

    await run('0100_category_ids_are_uuidv7.sql');

    expect((await query(`SELECT id FROM product_categories ORDER BY id`)).rows).toEqual(once.rows);
  });
});
