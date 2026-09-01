import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { systemContext } from '@nexa/contracts';
import { createTestContext, SEED_IDS, tenantA, tenantB, type TestContext } from './harness';

/**
 * Tenant isolation.
 *
 * TWO tenants are seeded, because a cross-tenant test with one tenant seeded
 * proves nothing — every query trivially returns only that tenant's rows.
 *
 * Phase 0 enforces scoping in the repository layer rather than with Postgres
 * row-level security (docs/adr/0004-tenant-isolation.md records that decision
 * and its cost). These tests are what stands in for the database-level
 * backstop, so they matter more than they otherwise would.
 */
describe('tenant isolation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('returns only the calling tenant’s bot instances', async () => {
    const forA = await ctx.container.botInstances.listForTenant(tenantA);
    const forB = await ctx.container.botInstances.listForTenant(tenantB);

    expect(forA.map((b) => b.username).sort()).toEqual(['acme_store_bot', 'acme_support_bot']);
    expect(forB.map((b) => b.username)).toEqual(['globex_store_bot']);

    // The decisive assertion: nothing of A's appears under B's scope.
    const aIds = new Set(forA.map((b) => b.id));
    expect(forB.some((b) => aIds.has(b.id))).toBe(false);
  });

  it('does not find another tenant’s bot by username', async () => {
    expect(await ctx.container.botInstances.findByUsername(tenantB, 'acme_store_bot')).toBeNull();
    expect(
      await ctx.container.botInstances.findByUsername(tenantA, 'acme_store_bot'),
    ).not.toBeNull();
  });

  it('refuses to resolve another tenant’s bot token', async () => {
    await expect(
      ctx.container.botInstances.resolveToken(tenantB, SEED_IDS.botA1 as never),
    ).rejects.toThrowError(/bot instance/i);
  });

  it('resolves its own token, decrypted, only for the owning tenant', async () => {
    const token = await ctx.container.botInstances.resolveToken(tenantA, SEED_IDS.botA1 as never);
    expect(token).toBe('000000:seed-token-acme-1');
  });

  it('never exposes the token through the repository’s read model', async () => {
    // No API response may contain a credential. The read model returns a
    // reference; the plaintext is reachable only through resolveToken.
    const [bot] = await ctx.container.botInstances.listForTenant(tenantA);
    expect(JSON.stringify(bot)).not.toContain('seed-token');
    expect(bot?.tokenSecretRef).toMatch(/^secret:/);
  });

  it('rejects a tenant-scoped read attempted under the system scope', async () => {
    // Cross-tenant reads must be explicit and permissioned, never accidental.
    await expect(
      ctx.container.botInstances.listForTenant(systemContext('test')),
    ).rejects.toThrowError(/tenant context/i);
  });

  it('scopes tenant lookup to the caller', async () => {
    const seenByA = await ctx.container.tenants.findInScope(tenantA);
    expect(seenByA?.slug).toBe('acme');

    const seenByB = await ctx.container.tenants.findInScope(tenantB);
    expect(seenByB?.slug).toBe('globex');
  });

  it('models a reseller sales bot as its own tenant with a parent', async () => {
    // Tenant is not the same thing as BotInstance: a reseller sales bot is a
    // tenant, and its settings are therefore scoped without ambiguity.
    const reseller = await ctx.container.tenants.findById(SEED_IDS.tenantBReseller as never);
    expect(reseller?.kind).toBe('RESELLER_BOT');
    expect(reseller?.parentTenantId).toBe(SEED_IDS.tenantB);
  });
});
