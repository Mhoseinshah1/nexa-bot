import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

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
