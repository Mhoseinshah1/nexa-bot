import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Cross-tenant relationships, attempted directly against PostgreSQL.
 *
 * These go around the repositories on purpose. The application predicates are
 * mandatory and tested elsewhere; what is under test here is the layer that
 * does not depend on anyone remembering them.
 *
 * v1 has no RLS (ADR-0004), and that decision costs nothing here: RLS and
 * referential integrity answer different questions, and "may these two rows be
 * related at all" is the one a foreign key answers. Before migration 0007 every
 * insert below SUCCEEDED — the child row named one tenant while pointing at
 * another tenant's admin or role, and because every read filters on tenant_id,
 * the mis-tenanted row was invisible to the tenant that owned the id. It simply
 * granted, or failed to grant, in silence.
 */

let ctx: TestContext;
let adminA: SeededAdmin;
let adminB: SeededAdmin;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  adminA = await createAdmin(ctx.container, tenantA, {
    username: 'acme-owner',
    roleKeys: ['owner'],
  });
  adminB = await createAdmin(ctx.container, tenantB, {
    username: 'globex-owner',
    roleKeys: ['owner'],
  });
});

/** Runs raw SQL, bypassing every repository and every predicate. */
async function raw(sql: string): Promise<void> {
  await ctx.container.database.db.execute(sql as never);
}

async function roleIdFor(tenantId: string, key: string): Promise<string> {
  const rows = (await ctx.container.database.db.execute(
    `SELECT id FROM roles WHERE tenant_id = '${tenantId}' AND key = '${key}'` as never,
  )) as unknown as { rows: { id: string }[] };
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error(`No ${key} role in tenant ${tenantId}`);
  return id;
}

describe('the database rejects cross-tenant relationships', () => {
  it('refuses an admin_roles row naming one tenant and another tenant’s admin', async () => {
    const roleA = await roleIdFor(tenantA.tenantId, 'support');

    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id)
         VALUES ('${tenantA.tenantId}', '${adminB.id}', '${roleA}')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an admin_roles row pointing at another tenant’s role', async () => {
    const roleB = await roleIdFor(tenantB.tenantId, 'support');

    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id)
         VALUES ('${tenantA.tenantId}', '${adminA.id}', '${roleB}')`,
      ),
    ).rejects.toThrow();
  });

  it('accepts the same row when both sides belong to the tenant', async () => {
    // The constraint must reject the wrong thing without rejecting the right
    // one; a test that only proves refusal would pass against a broken table.
    const roleA = await roleIdFor(tenantA.tenantId, 'finance');

    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id)
         VALUES ('${tenantA.tenantId}', '${adminA.id}', '${roleA}')`,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a role_permissions row pointing at another tenant’s role', async () => {
    const roleB = await roleIdFor(tenantB.tenantId, 'support');

    await expect(
      raw(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_key)
         VALUES ('${tenantA.tenantId}', '${roleB}', 'refunds.issue')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an admin_permission_overrides row for another tenant’s admin', async () => {
    await expect(
      raw(
        `INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
         VALUES ('${tenantA.tenantId}', '${adminB.id}', 'refunds.issue', 'GRANT', 'cross-tenant')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an admin_sessions row for another tenant’s admin', async () => {
    // The worst case of the set. The session lookup is the one read that is
    // unscoped by necessity, and it RETURNS the tenant everything downstream is
    // scoped to — so a mis-tenanted session hands a caller a scope that is not
    // theirs, and every predicate afterwards faithfully enforces the wrong one.
    await expect(
      raw(
        `INSERT INTO admin_sessions
           (id, tenant_id, admin_id, token_hash, issued_at, expires_at, last_seen_at)
         VALUES ('01900000-0000-7000-8000-0000000000f1', '${tenantA.tenantId}', '${adminB.id}',
                 'deadbeef', now(), now() + interval '1 hour', now())`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an assigned_by naming another tenant’s admin', async () => {
    const roleA = await roleIdFor(tenantA.tenantId, 'finance');

    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id, assigned_by_admin_id)
         VALUES ('${tenantA.tenantId}', '${adminA.id}', '${roleA}', '${adminB.id}')`,
      ),
    ).rejects.toThrow();
  });

  it('still permits a NULL assigned_by, which is how bootstrap records itself', async () => {
    // Deliberately nullable: installation bootstrap grants the first owner role
    // with no acting administrator, because none exists yet. A fabricated actor
    // there would be the invented identity this codebase refuses; the audit row
    // with actor SYSTEM_JOB carries the full story instead.
    const roleA = await roleIdFor(tenantA.tenantId, 'finance');

    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id, assigned_by_admin_id)
         VALUES ('${tenantA.tenantId}', '${adminA.id}', '${roleA}', NULL)`,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a created_by naming another tenant’s admin', async () => {
    await expect(
      raw(
        `INSERT INTO admin_permission_overrides
           (tenant_id, admin_id, permission_key, effect, reason, created_by_admin_id)
         VALUES ('${tenantA.tenantId}', '${adminA.id}', 'refunds.issue', 'GRANT', 'cover',
                 '${adminB.id}')`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an admin whose tenant does not exist at all', async () => {
    await expect(
      raw(
        `INSERT INTO admin_roles (tenant_id, admin_id, role_id)
         VALUES ('01900000-0000-7000-8000-0000000000ee', '${adminA.id}',
                 '${await roleIdFor(tenantA.tenantId, 'support')}')`,
      ),
    ).rejects.toThrow();
  });
});
