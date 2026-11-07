import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TenantId } from '@nexa/contracts';
import { tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * The installation tenant guard (#413) on an install that hosts many tenants (ADR-0037).
 *
 * The suite's container runs as nexa_app, so the guard's lookups (`tenants.findById`,
 * `tenants.findPrimary`, unbound on a timer) go through the audited system path — and
 * have to work there. "The primary" is the OWNER's installation tenant; the guard must
 * never move a reseller's or hosted bot's tenant onto it.
 *
 * MUTATIONS: remove the "seen as another kind" refusal in `InstallationTenantGuard.run`
 * (the child case fails); drop `kind = 'PRIMARY'` from `DrizzleTenantRepository.findPrimary`
 * (the restore case adopts the older child and fails).
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  await ctx.reset();
});

/** A child tenant of the installation, created BEFORE it, so "oldest first" would pick it. */
async function childTenant(): Promise<TenantId> {
  const id = randomUUID();
  await ctx.container.database.db.insert(tenants).values({
    id,
    kind: 'RESELLER_BOT',
    parentTenantId: tenantA.tenantId as string,
    slug: `child-${id.slice(0, 8)}`,
    displayName: 'Hosted',
    status: 'ACTIVE',
    locale: 'fa',
    displayTimezone: 'Asia/Tehran',
    calendar: 'jalali',
    currency: 'IRT',
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  return id as TenantId;
}

const guard = () => ctx.container.installationTenantGuard;

describe('the installation tenant guard under row-level security', () => {
  it('keeps the installation tenant while it exists', async () => {
    ctx.container.setInstallationTenant(tenantA.tenantId);
    await expect(guard().verify()).resolves.toBe(tenantA.tenantId);
    expect(ctx.container.installationTenantId).toBe(tenantA.tenantId);
  });

  it('re-resolves a vanished tenant to the PRIMARY one, never an older child', async () => {
    await childTenant();
    // A restore: the cached id names nothing in the live database.
    ctx.container.setInstallationTenant(randomUUID() as TenantId);
    await expect(guard().verify()).resolves.toBe(tenantA.tenantId);
    expect(ctx.container.installationTenantId).toBe(tenantA.tenantId);
  });

  it('never replaces a child tenant it has seen with the owner’s, even when it vanishes', async () => {
    const child = await childTenant();
    ctx.container.setInstallationTenant(child);
    await expect(guard().verify()).resolves.toBe(child);

    await ctx.container.database.db.delete(tenants).where(eq(tenants.id, child));
    await expect(guard().verify()).resolves.toBe(child);
    expect(ctx.container.installationTenantId).toBe(child);
    expect(ctx.container.installationTenantId).not.toBe(tenantA.tenantId);
  });
});
