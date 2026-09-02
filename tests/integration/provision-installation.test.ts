import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { tenants } from '../../apps/api/src/infrastructure/persistence/schema';
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
