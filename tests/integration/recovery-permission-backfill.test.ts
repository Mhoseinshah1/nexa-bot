import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_SEEDS } from '@nexa/contracts';
import { adminPermissionOverrides } from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Migration 0031, the Backup and Recovery role backfill.
 *
 * The defect it repairs was found on a real staging installation: `/recovery`
 * rendered, and every card in it answered access denied to the administrator who
 * had been the owner since the identity release. A fresh installation of the
 * same image was correct. `ensureSystemRoles` writes a seed's permissions when
 * the role is CREATED and never reasserts them — deliberately, so a restart
 * cannot restore a permission an operator withdrew — so the four permissions the
 * disaster-recovery release added to `ROLE_SEEDS` reached nobody who already had
 * the roles.
 *
 * The statement under test is READ FROM THE MIGRATION, never retyped. A copy
 * would drift from the file it is meant to prove, and a test that asserts a copy
 * of the SQL is a test of the copy.
 */
describe('migration 0031 — the Backup and Recovery role backfill', () => {
  let ctx: TestContext;
  const query = async (text: string) =>
    ctx.container.database.withClient((client) => client.query(text));

  const A = SEED_IDS.tenantA;
  const B = SEED_IDS.tenantB;

  /** The four keys the disaster-recovery release added to the catalogue. */
  const NEW_KEYS = ['backup.view', 'backup.run', 'backup.download', 'recovery.restore'] as const;
  const NEW_KEY_LIST = NEW_KEYS.map((key) => `'${key}'`).join(', ');

  /**
   * What the backfill must produce, written out rather than derived.
   *
   * Deriving it from `ROLE_SEEDS` would run the same computation the migration
   * is supposed to implement, and would agree with it however wrong both were.
   */
  const EXPECTED = [
    'observer:backup.view',
    'operator:backup.view',
    'owner:backup.download',
    'owner:backup.run',
    'owner:backup.view',
    'owner:recovery.restore',
    'technical:backup.run',
    'technical:backup.view',
  ];

  const backfill = () => {
    const sql = readFileSync('apps/api/drizzle/0031_backup_recovery_role_backfill.sql', 'utf8');
    const start = sql.indexOf('INSERT INTO "role_permissions"');
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start);
  };

  /** The state an installation upgraded from before the DR release is in. */
  const asPreDrInstallation = async (tenantId: string) => {
    await query(
      `DELETE FROM role_permissions WHERE tenant_id = '${tenantId}' AND permission_key IN (${NEW_KEY_LIST})`,
    );
    const remaining = await query(
      `SELECT count(*)::int AS n FROM role_permissions WHERE tenant_id = '${tenantId}' AND permission_key IN (${NEW_KEY_LIST})`,
    );
    expect(remaining.rows[0].n).toBe(0);
  };

  /** The new grants a tenant holds, as `role:permission`, sorted. */
  const newGrantsIn = async (tenantId: string): Promise<string[]> => {
    const rows = await query(`
      SELECT r.key AS role_key, rp.permission_key
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
      WHERE rp.tenant_id = '${tenantId}' AND rp.permission_key IN (${NEW_KEY_LIST})
      ORDER BY r.key, rp.permission_key`);
    return rows.rows.map((row: Record<string, string>) => `${row.role_key}:${row.permission_key}`);
  };

  const permissionsByRoleIn = async (tenantId: string): Promise<Record<string, string[]>> => {
    const rows = await query(`
      SELECT r.key AS role_key, rp.permission_key
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
      WHERE rp.tenant_id = '${tenantId}'
      ORDER BY r.key, rp.permission_key`);
    const byRole: Record<string, string[]> = {};
    for (const row of rows.rows as Record<string, string>[]) {
      const roleKey = row.role_key ?? '';
      (byRole[roleKey] ??= []).push(row.permission_key ?? '');
    }
    return byRole;
  };

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('the grants it adds', () => {
    it('gives a pre-existing owner exactly the four new permissions', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());

      const owner = (await permissionsByRoleIn(A)).owner ?? [];
      expect(owner.filter((key) => (NEW_KEYS as readonly string[]).includes(key))).toEqual([
        'backup.download',
        'backup.run',
        'backup.view',
        'recovery.restore',
      ]);
    });

    it('gives operator backup.view and no other new permission', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());

      const operator = (await permissionsByRoleIn(A)).operator ?? [];
      expect(operator.filter((key) => (NEW_KEYS as readonly string[]).includes(key))).toEqual([
        'backup.view',
      ]);
      // The two CRITICAL keys are the ones that must not spread. Taking a
      // backup is an operational act; walking out with the database, or
      // overwriting production with one, is not.
      expect(operator).not.toContain('backup.download');
      expect(operator).not.toContain('recovery.restore');
    });

    it('gives technical backup.view and backup.run', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());

      const technical = (await permissionsByRoleIn(A)).technical ?? [];
      expect(technical.filter((key) => (NEW_KEYS as readonly string[]).includes(key))).toEqual([
        'backup.run',
        'backup.view',
      ]);
      expect(technical).not.toContain('backup.download');
      expect(technical).not.toContain('recovery.restore');
    });

    it('gives observer backup.view, which its LOW-risk seed already implies', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());

      const observer = (await permissionsByRoleIn(A)).observer ?? [];
      expect(observer.filter((key) => (NEW_KEYS as readonly string[]).includes(key))).toEqual([
        'backup.view',
      ]);
    });

    it('adds those eight pairs and not one more', async () => {
      // The whole-installation statement of the four above, and the guard
      // against amplification: finance, support, sales and receipt_reviewer
      // hold nothing here, and `recovery.restore` reaches one role.
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);
      expect(await newGrantsIn(A)).toEqual([]);

      await query(backfill());

      expect(await newGrantsIn(A)).toEqual(EXPECTED);
    });
  });

  describe('what it must not touch', () => {
    it('never widens a role an operator created, even one sharing a seeded key', async () => {
      // `is_system = true` is the discriminator, and the key alone is not
      // enough. Within a tenant the unique index forbids a second role named
      // `owner`, so the only way to construct the case the predicate exists for
      // is a custom role in a tenant whose seeded roles do not exist — which is
      // also the realistic shape, since roles are per tenant.
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      const customId = ctx.container.ids.uuid();
      await query(`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES ('${customId}', '${B}', 'owner', 'A custom role that shares a seeded key', false)`);
      const inserted = await query(`SELECT count(*)::int AS n FROM roles WHERE id = '${customId}'`);
      expect(inserted.rows[0].n, 'the fixture role must actually exist').toBe(1);

      await query(backfill());

      const granted = await query(
        `SELECT count(*)::int AS n FROM role_permissions WHERE role_id = '${customId}'`,
      );
      expect(granted.rows[0].n).toBe(0);
      // And the seeded role in the other tenant was still served.
      expect(await newGrantsIn(A)).toEqual(EXPECTED);
    });

    it('leaves an unrelated permission somebody removed removed', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);
      await query(
        `DELETE FROM role_permissions WHERE tenant_id = '${A}' AND permission_key = 'users.block'`,
      );

      await query(backfill());

      const operator = (await permissionsByRoleIn(A)).operator ?? [];
      expect(operator).not.toContain('users.block');
      expect(operator).toContain('backup.view');
    });

    it('changes no permission row other than the eight it inserts', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);
      const unrelated = () =>
        query(`
          SELECT tenant_id, role_id, permission_key FROM role_permissions
          WHERE permission_key NOT IN (${NEW_KEY_LIST})
          ORDER BY tenant_id, role_id, permission_key`);
      const before = (await unrelated()).rows;
      const countBefore = await query(`SELECT count(*)::int AS n FROM role_permissions`);

      await query(backfill());

      expect((await unrelated()).rows).toEqual(before);
      const countAfter = await query(`SELECT count(*)::int AS n FROM role_permissions`);
      expect(countAfter.rows[0].n - countBefore.rows[0].n).toBe(8);
    });

    it('touches neither role assignments nor permission overrides', async () => {
      const owner = await createAdmin(ctx.container, tenantA, {
        username: 'owner',
        roleKeys: ['owner'],
      });
      await asPreDrInstallation(A);
      await ctx.container.database.db.insert(adminPermissionOverrides).values({
        tenantId: tenantA.tenantId,
        adminId: owner.id,
        permissionKey: 'panels.edit',
        effect: 'DENY',
        reason: 'Under investigation.',
        expiresAt: null,
      });
      const assignments = () =>
        query(`SELECT tenant_id, admin_id, role_id FROM admin_roles ORDER BY 1, 2, 3`);
      const overrides = () =>
        query(
          `SELECT tenant_id, admin_id, permission_key, effect FROM admin_permission_overrides ORDER BY 1, 2, 3, 4`,
        );
      const assignmentsBefore = (await assignments()).rows;
      const overridesBefore = (await overrides()).rows;

      await query(backfill());

      expect((await assignments()).rows).toEqual(assignmentsBefore);
      expect((await overrides()).rows).toEqual(overridesBefore);
      // And the backfill did run, so this is not a no-op satisfying a pair of
      // negative assertions.
      expect(await newGrantsIn(A)).toEqual(EXPECTED);
    });

    it('leaves a fresh installation exactly as it was', async () => {
      // A current image provisions the roles complete, so this migration has
      // nothing to do there. `ON CONFLICT DO NOTHING` is what makes that true
      // rather than an error.
      await ctx.container.roles.ensureSystemRoles(tenantA);
      const before = await permissionsByRoleIn(A);

      await query(backfill());

      expect(await permissionsByRoleIn(A)).toEqual(before);
      expect(await newGrantsIn(A)).toEqual(EXPECTED);
    });
  });

  describe('re-running and tenancy', () => {
    it('is idempotent, so a second run is a no-op rather than an error', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());
      await query(backfill());
      await query(backfill());

      // Eight grants, not twenty-four.
      expect(await newGrantsIn(A)).toEqual(EXPECTED);
    });

    it('serves every tenant the installation holds, not only the primary one', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await ctx.container.roles.ensureSystemRoles(tenantB);
      await asPreDrInstallation(A);
      await asPreDrInstallation(B);

      await query(backfill());

      expect(await newGrantsIn(A)).toEqual(EXPECTED);
      expect(await newGrantsIn(B)).toEqual(EXPECTED);
    });

    it('cannot write a row naming one tenant beside another tenant’s role', async () => {
      // `tenant_id` is read from the same row as `id`, so the pair can only
      // ever agree. The composite foreign key would reject a row where they did
      // not, but the check is stated here because application-level isolation is
      // the whole basis of this schema (ADR-0004).
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await ctx.container.roles.ensureSystemRoles(tenantB);
      await asPreDrInstallation(A);
      await asPreDrInstallation(B);

      await query(backfill());

      const inserted = await query(`
        SELECT rp.tenant_id, r.tenant_id AS role_tenant_id
        FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_key IN (${NEW_KEY_LIST})`);
      // Sixteen: the eight pairs, in each of the two tenants. Asserted so a
      // migration that inserted NOTHING could not satisfy this case — a
      // mismatch check over an empty set is a check that cannot fail.
      expect(inserted.rows.length).toBe(16);
      for (const row of inserted.rows as Record<string, string>[]) {
        expect(row.tenant_id).toBe(row.role_tenant_id);
      }
    });
  });

  describe('what the grant still does not override', () => {
    it('loses to a DENY override, because resolution subtracts DENY last', async () => {
      const owner = await createAdmin(ctx.container, tenantA, {
        username: 'owner',
        roleKeys: ['owner'],
      });
      await asPreDrInstallation(A);
      const actor = adminActorFor(owner);
      expect(await ctx.container.guard.has(tenantA, actor, 'recovery.restore')).toBe(false);

      await query(backfill());
      expect(await ctx.container.guard.has(tenantA, actor, 'recovery.restore')).toBe(true);

      await ctx.container.database.db.insert(adminPermissionOverrides).values({
        tenantId: tenantA.tenantId,
        adminId: owner.id,
        permissionKey: 'recovery.restore',
        effect: 'DENY',
        reason: 'Restores are frozen during the audit.',
        expiresAt: null,
      });

      expect(await ctx.container.guard.has(tenantA, actor, 'recovery.restore')).toBe(false);
      // The role still carries it; the override is what is refusing.
      expect((await permissionsByRoleIn(A)).owner).toContain('recovery.restore');
    });
  });

  describe('the upgrade lands where a fresh install already is', () => {
    it('leaves an upgraded installation holding exactly the seed contract', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);

      await query(backfill());

      const upgraded = await permissionsByRoleIn(A);
      for (const seed of ROLE_SEEDS) {
        expect(upgraded[seed.key], `role ${seed.key}`).toEqual([...seed.permissions].sort());
      }
    });

    it('leaves an upgraded installation indistinguishable from a fresh one', async () => {
      // The claim the defect report reduces to: same image, same screen, same
      // answer, whichever release the installation was created at.
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await asPreDrInstallation(A);
      await ctx.container.roles.ensureSystemRoles(tenantB);

      await query(backfill());

      expect(await permissionsByRoleIn(A)).toEqual(await permissionsByRoleIn(B));
    });
  });
});
