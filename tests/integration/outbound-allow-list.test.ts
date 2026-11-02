import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTBOUND_PRIVATE_TARGETS_SETTING_KEY, type ActorContext } from '@nexa/contracts';
import { resolveInstallationTenant } from '../../apps/api/src/bootstrap';
import { checkUrl } from '../../apps/api/src/infrastructure/net/url-policy';
import { panelUrlPolicy } from '../../apps/api/src/infrastructure/net/installation-policy';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R12 F2 item 4: the owner's allow-list of private outbound targets is a setting only the
 * owner can write (it also takes the CRITICAL `settings.destructive`), and what the owner
 * stores is what every role's URL policy re-opens after its refresh.
 */
describe('the outbound private-target allow-list', () => {
  let ctx: TestContext;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext({ NEXA_EDGE_SUBNET: '172.29.0.0/24' });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
  });

  const set = (actor: ActorContext, value: string, expectedVersion: number | null = null) =>
    ctx.container.settingsService.set(tenantA, actor, {
      key: OUTBOUND_PRIVATE_TARGETS_SETTING_KEY,
      value,
      expectedVersion,
      idempotencyKey: randomUUID(),
    });

  /** An administrator who may edit settings but holds nothing CRITICAL. */
  async function settingsEditor(): Promise<ActorContext> {
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, 'settings_editor', 'settings_editor', false)`);
    for (const permission of ['settings.view', 'settings.edit']) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const admin = await createAdmin(ctx.container, tenantA, { username: 'editor' });
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    return adminActorFor(admin);
  }

  it('refuses an administrator with settings.edit alone, and audits the refusal', async () => {
    const editor = await settingsEditor();
    await expect(set(editor, '172.17.0.1')).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    const rows = await ctx.container.database.db.execute<{ result: string }>(sql`
      SELECT result FROM audit_logs
       WHERE tenant_id = ${tenantA.tenantId} AND action = 'settings.set'
         AND entity_id = ${OUTBOUND_PRIVATE_TARGETS_SETTING_KEY}`);
    expect(rows.rows.map((row) => row.result)).toContain('DENIED');
    // The same editor may still change an ordinary setting.
    await expect(
      ctx.container.settingsService.set(tenantA, editor, {
        key: 'ops.log.nightly_report_time',
        value: '01:15',
        expectedVersion: null,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('Codex P2 on #359: re-checks settings.destructive INSIDE the transaction', async () => {
    // An owner-shaped custom role holding both permissions, so revoking one is one DELETE.
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, 'security_editor', 'security_editor', false)`);
    for (const permission of ['settings.view', 'settings.edit', 'settings.destructive']) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const admin = await createAdmin(ctx.container, tenantA, { username: 'security-editor' });
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    const editor = adminActorFor(admin);

    // The permission is revoked right after the early check passes and before the
    // transaction begins — the window the early check alone left open.
    const guard = (
      ctx.container.settingsService as unknown as {
        guard: { check: (...args: unknown[]) => Promise<void> };
      }
    ).guard;
    const original = guard.check.bind(guard);
    const spy = vi.spyOn(guard, 'check').mockImplementation(async (...args: unknown[]) => {
      await original(...args);
      if (args[2] === 'settings.destructive' && args[3] === undefined) {
        await ctx.container.database.db.execute(sql`
          DELETE FROM role_permissions
           WHERE role_id = ${roleId} AND permission_key = 'settings.destructive'`);
      }
    });
    try {
      await expect(set(editor, '172.17.0.1')).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    } finally {
      spy.mockRestore();
    }
    // Nothing was stored, and the refusal is in the audit log.
    const stored = await ctx.container.database.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM setting_values
       WHERE tenant_id = ${tenantA.tenantId} AND setting_key = ${OUTBOUND_PRIVATE_TARGETS_SETTING_KEY}`);
    expect(stored.rows[0]?.n).toBe('0');
    const audit = await ctx.container.database.db.execute<{ result: string }>(sql`
      SELECT result FROM audit_logs
       WHERE tenant_id = ${tenantA.tenantId} AND action = 'settings.set'
         AND entity_id = ${OUTBOUND_PRIVATE_TARGETS_SETTING_KEY} AND actor_id = ${admin.id}`);
    expect(audit.rows.map((row) => row.result)).toContain('DENIED');
  });

  it('lets the owner allow a target, which the URL policy re-opens after the refresh', async () => {
    await resolveInstallationTenant(ctx.container);
    const policy = panelUrlPolicy(ctx.container.config, ctx.container.outboundAllowList);
    expect(checkUrl('http://172.17.0.1:8000/', policy).allowed).toBe(false);

    const first = await set(owner, '172.17.0.1, 172.29.0.0/24');
    // Not before the refresh: the policy reads the list it holds.
    expect(checkUrl('http://172.17.0.1:8000/', policy).allowed).toBe(false);
    await ctx.container.outboundAllowList.refresh();
    expect(checkUrl('http://172.17.0.1:8000/', policy).allowed).toBe(true);
    expect(checkUrl('http://172.29.0.1:8000/', policy).allowed).toBe(true);
    expect(checkUrl('http://172.17.0.2:8000/', policy).allowed).toBe(false);

    await set(owner, '', first.setting.version);
    await ctx.container.outboundAllowList.refresh();
    expect(checkUrl('http://172.17.0.1:8000/', policy).allowed).toBe(false);
  });
});
