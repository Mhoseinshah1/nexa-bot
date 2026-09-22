import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_PRODUCT_CATEGORY_NAME } from '@nexa/contracts';
import { productCategories, tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { provisionInstallation } from '../../apps/api/src/provision-installation.cli';
import { createTestContext, resetDatabase, testConfig, type TestContext } from './harness';

/**
 * Provisioning the installation, against a real database.
 *
 * This is the step that stands between a migrated schema and an owner who can
 * log in. Its two properties are the ones an installer depends on: it creates
 * exactly one primary tenant, and meeting one that already exists is a success
 * that changes nothing — because an installer that failed at a later step will
 * be rerun from the top.
 */
describe('provision-installation', () => {
  let ctx: TestContext;
  const url = () => testConfig().DATABASE_URL;

  const input = {
    slug: 'nexa-prod',
    displayName: 'Nexa Production',
    locale: 'fa',
    timezone: 'Asia/Tehran',
    calendar: 'jalali',
    currency: 'IRT',
  };

  beforeEach(async () => {
    ctx ??= await createTestContext();
    // NOT ctx.reset(): that reseeds the development fixtures, which include a
    // primary tenant. This suite is about a genuinely empty installation, which
    // is the state a production database is in after migration.
    await resetDatabase(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const primaries = async () =>
    ctx.container.database.db.select().from(tenants).where(eq(tenants.kind, 'PRIMARY'));

  const categoriesOf = async (tenantId: string) =>
    ctx.container.database.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.tenantId, tenantId));

  // -------------------------------------------------------------------------
  // The tenant's first category — the PRODUCTION path, not the development seed
  // -------------------------------------------------------------------------

  describe('the first category a provisioned tenant gets', () => {
    /**
     * A freshly provisioned installation can sell something.
     *
     * The invariant this protects: every sellable product belongs to exactly one
     * category, so a tenant with NO category is a tenant whose operator's first product
     * is refused by `PRODUCT_NOT_CATEGORISED` — naming a rule they cannot satisfy,
     * because there is no category to pick and nothing tells them one is needed.
     *
     * Asserted against `provisionInstallation` deliberately. Migration 0097 gives
     * EXISTING tenants this row and the development seed gives the test fixtures one,
     * and neither of those is evidence about a real tenant created in production —
     * `seed()` has no callers in application code at all. This is the only path that
     * creates a tenant outside a migration, so it is the only place the invariant can
     * be established for a new one.
     */
    it('creates one, in the same transaction as the tenant', async () => {
      const result = await provisionInstallation(url(), input);
      expect(result.created).toBe(true);

      const categories = await categoriesOf(result.tenantId);
      expect(categories, 'a provisioned tenant has no category to sell under').toHaveLength(1);
      expect(categories[0]?.name).toBe(DEFAULT_PRODUCT_CATEGORY_NAME);
      expect(categories[0]?.tenantId).toBe(result.tenantId);
      expect(categories[0]?.status).toBe('ACTIVE');
      expect(categories[0]?.visibility).toBe('VISIBLE');
    });

    it('writes no second one when the installer is rerun', async () => {
      const first = await provisionInstallation(url(), input);
      const again = await provisionInstallation(url(), input);

      expect(again.created, 'a rerun re-provisioned the installation').toBe(false);
      expect(await categoriesOf(first.tenantId)).toHaveLength(1);
    });

    it('keeps a renamed category through a rerun, rather than restoring the default', async () => {
      /*
       * The reason the idempotency key is "this tenant has ANY category" and not "has
       * one named `DEFAULT_PRODUCT_CATEGORY_NAME`".
       *
       * An operator renames the default — which the audit promises they can — and the
       * installer is then rerun after a failure at a later step. Keyed on the name, the
       * rerun would find no match and create a SECOND category, leaving the tenant with
       * a duplicate nobody asked for and a customer-facing list that grew by itself.
       */
      const first = await provisionInstallation(url(), input);
      await ctx.container.database.db.execute(
        sql`UPDATE product_categories SET name = 'فروش ویژه' WHERE tenant_id = ${first.tenantId}`,
      );

      await provisionInstallation(url(), input);

      const categories = await categoriesOf(first.tenantId);
      expect(categories).toHaveLength(1);
      expect(categories[0]?.name, 'a rerun overwrote the operator name').toBe('فروش ویژه');
    });
  });

  /**
   * Two installers, started at once, against one database.
   *
   * Deterministic by construction rather than by timing: both promises are
   * created before either is awaited, so both transactions are genuinely in
   * flight, and the advisory lock — not a sleep — decides the order. A test
   * that staggered them with a delay would prove only that sequential calls
   * work, which is the case that was never in doubt.
   */
  it('two simultaneous installers with the same slug leave exactly one primary', async () => {
    const both = await Promise.allSettled([
      provisionInstallation(url(), input),
      provisionInstallation(url(), input),
    ]);

    const fulfilled = both.filter((r) => r.status === 'fulfilled');
    expect(fulfilled, `both calls failed: ${JSON.stringify(both)}`).toHaveLength(2);

    const results = fulfilled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as {
      tenantId: string;
      created: boolean;
    }[];
    // One created it; the other found it. Not one crash and one success.
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(1);
    // And both are talking about the same tenant.
    expect(new Set(results.map((r) => r.tenantId)).size).toBe(1);

    expect(await primaries()).toHaveLength(1);
  });

  it('two simultaneous installers with DIFFERENT slugs still leave exactly one primary', async () => {
    // The case the old `SELECT ... FOR UPDATE` could not catch at all. With
    // the same slug the loser happened to die on `tenants_slug_key` — a
    // different invariant catching this one by accident. With different slugs
    // nothing stopped both from committing, and the installation ended up with
    // two primary tenants, which is two installations sharing a database.
    const both = await Promise.allSettled([
      provisionInstallation(url(), { ...input, slug: 'nexa-one' }),
      provisionInstallation(url(), { ...input, slug: 'nexa-two' }),
    ]);

    const rows = await primaries();
    expect(rows, 'a second primary tenant was created').toHaveLength(1);

    // The loser is deterministic: it either reports the existing tenant, or it
    // fails cleanly. What it must never do is create a second one.
    const fulfilled = both.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of fulfilled) {
      const value = (r as PromiseFulfilledResult<{ tenantId: string }>).value;
      expect(value.tenantId).toBe(String(rows[0]!.id));
    }
  });

  it('the database refuses a second primary tenant even when the CLI is bypassed', async () => {
    // Raw SQL, because the invariant belongs to the database and not to the
    // code that usually writes it. Anything reaching this table — a future
    // service, a migration, an operator with psql — meets the same rule.
    await provisionInstallation(url(), input);
    const db = ctx.container.database.db;

    let refusal: unknown;
    try {
      await db.execute(sql`
        INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status,
                             locale, display_timezone, calendar, currency)
        VALUES (gen_random_uuid(), 'PRIMARY', NULL, 'a-different-slug', 'Second', 'ACTIVE',
                'fa', 'Asia/Tehran', 'jalali', 'IRT')
      `);
    } catch (error) {
      refusal = error;
    }
    expect(refusal, 'the database accepted a second primary tenant').toBeDefined();
    // Drizzle wraps the driver error, so the constraint name is on the cause.
    // Asserting on the NAME rather than on "some error happened" is what
    // proves this index refused it, and not the slug index or a CHECK.
    const cause = (refusal as { cause?: { constraint?: string; message?: string } }).cause;
    expect(
      cause?.constraint ?? `${cause?.message ?? ''}${String(refusal)}`,
      'refused by something other than the single-primary index',
    ).toMatch(/tenants_single_primary_key/);

    expect(await primaries()).toHaveLength(1);
  });

  it('a reseller tenant is still allowed alongside the primary', async () => {
    // The index is partial. If it were not, this would fail — and resellers
    // are the entire reason the tenants table has a `kind` at all.
    const { tenantId } = await provisionInstallation(url(), input);
    const db = ctx.container.database.db;

    await db.execute(sql`
      INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status,
                           locale, display_timezone, calendar, currency)
      VALUES (gen_random_uuid(), 'RESELLER_BOT', ${tenantId}, 'a-reseller', 'Reseller', 'ACTIVE',
              'fa', 'Asia/Tehran', 'jalali', 'IRT')
    `);

    expect(await primaries()).toHaveLength(1);
    const all = await db.select().from(tenants);
    expect(all).toHaveLength(2);
  });

  it('creates the primary tenant a fresh installation has none of', async () => {
    expect(await primaries(), 'a migrated database already had a tenant').toHaveLength(0);

    const result = await provisionInstallation(url(), input);
    expect(result.created).toBe(true);

    const rows = await primaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'nexa-prod',
      displayName: 'Nexa Production',
      kind: 'PRIMARY',
      status: 'ACTIVE',
      currency: 'IRT',
      calendar: 'jalali',
    });
    // A primary tenant has no parent, and the CHECK constraint agrees.
    expect(rows[0]?.parentTenantId).toBeNull();
  });

  it('is a no-op on the second run, and changes nothing', async () => {
    const first = await provisionInstallation(url(), input);

    // A rerun with DIFFERENT values, which is what an operator who retyped the
    // installer's arguments would produce. Renaming the installation silently
    // would change what every administrator sees.
    const second = await provisionInstallation(url(), {
      ...input,
      slug: 'something-else',
      displayName: 'Something Else',
    });

    expect(second.created, 'a rerun created a second installation').toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.slug).toBe('nexa-prod');

    const rows = await primaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug, 'a rerun renamed the installation').toBe('nexa-prod');
  });

  it('makes the tenant the one bootstrap-owner will find', async () => {
    // The whole point of this CLI. `bootstrap-owner` resolves `findPrimary()`
    // and refuses when it returns null, so provisioning is only useful if the
    // row it writes is the row that lookup returns.
    const result = await provisionInstallation(url(), input);
    const found = await ctx.container.tenants.findPrimary();
    expect(found, 'bootstrap-owner would still refuse to run').not.toBeNull();
    expect(found?.id).toBe(result.tenantId);
  });

  it('refuses invalid input before touching the database', async () => {
    await expect(
      provisionInstallation(url(), { ...input, slug: 'NOT VALID' }),
    ).rejects.toThrowError(/slug/);
    expect(await primaries(), 'a rejected provision still wrote a row').toHaveLength(0);
  });
});
