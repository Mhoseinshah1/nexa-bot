import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import {
  adminKnownIps,
  adminReadWindows,
  operationalEvents,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Phase 6A D0: the installation owner's security alerts, against a real database. The
 * installation tenant is A (the owner); B stands in for a hosted tenant, which must never
 * be the addressee of one of these alerts.
 */

let ctx: TestContext;
let owner: SeededAdmin;
let hosted: SeededAdmin;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
  ctx.container.setInstallationTenant(tenantA.tenantId);
  owner = await createAdmin(ctx.container, tenantA, {
    username: 'owner',
    password: 'the-owners-real-password',
    roleKeys: ['owner'],
  });
  hosted = await createAdmin(ctx.container, tenantB, {
    username: 'hosted',
    password: 'the-hosted-password',
    roleKeys: ['owner'],
  });
});

function anonymousActor(): ActorContext {
  return {
    type: 'API',
    id: null,
    label: null,
    surface: 'WEB',
    correlationId: 'test-correlation' as never,
  };
}

async function signIn(
  scope: typeof tenantA,
  username: string,
  password: string,
  ip: string | null,
): Promise<void> {
  await ctx.container.auth.login(
    scope,
    anonymousActor(),
    { username, password },
    { ip, userAgent: 'vitest' },
  );
}

async function events(code: string, tenantId: string) {
  return ctx.container.database.db
    .select()
    .from(operationalEvents)
    .where(and(eq(operationalEvents.code, code), eq(operationalEvents.tenantId, tenantId)));
}

describe('auth.login_new_ip', () => {
  it('remembers the first sign-in silently, then alerts the owner once for a new address', async () => {
    await signIn(tenantA, 'owner', 'the-owners-real-password', '203.0.113.10');
    expect(await events('auth.login_new_ip', tenantA.tenantId)).toEqual([]);
    await signIn(tenantA, 'owner', 'the-owners-real-password', '203.0.113.10');
    expect(await events('auth.login_new_ip', tenantA.tenantId)).toEqual([]);

    await signIn(tenantA, 'owner', 'the-owners-real-password', '198.51.100.7');
    const alerts = await events('auth.login_new_ip', tenantA.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('WARN');
    expect(alerts[0]!.context).toMatchObject({
      adminId: owner.id,
      adminUsername: 'owner',
      clientIp: '198.51.100.7',
    });
    expect(JSON.stringify(alerts[0])).not.toContain('the-owners-real-password');

    const remembered = await ctx.container.database.db
      .select()
      .from(adminKnownIps)
      .where(eq(adminKnownIps.adminId, owner.id));
    expect(remembered.map((row) => row.ip).sort()).toEqual(['198.51.100.7', '203.0.113.10']);
  });

  it('neither remembers nor alerts on an address the proxy configuration cannot vouch for', async () => {
    await signIn(tenantA, 'owner', 'the-owners-real-password', '203.0.113.10');
    await signIn(tenantA, 'owner', 'the-owners-real-password', null);
    expect(await events('auth.login_new_ip', tenantA.tenantId)).toEqual([]);
    const remembered = await ctx.container.database.db.select().from(adminKnownIps);
    expect(remembered).toHaveLength(1);
  });

  it('never alerts a hosted tenant, nor the owner, about a hosted tenant’s sign-ins', async () => {
    await signIn(tenantB, 'hosted', 'the-hosted-password', '203.0.113.10');
    await signIn(tenantB, 'hosted', 'the-hosted-password', '198.51.100.7');
    expect(await events('auth.login_new_ip', tenantB.tenantId)).toEqual([]);
    expect(await events('auth.login_new_ip', tenantA.tenantId)).toEqual([]);
  });

  it('records nothing before an installation tenant exists', async () => {
    ctx.container.setInstallationTenant(null);
    await signIn(tenantA, 'owner', 'the-owners-real-password', '203.0.113.10');
    await signIn(tenantA, 'owner', 'the-owners-real-password', '198.51.100.7');
    expect(await events('auth.login_new_ip', tenantA.tenantId)).toEqual([]);
  });
});

describe('access.data_exported', () => {
  it('announces an audit-log export to the owner with its row count and no filter value', async () => {
    const file = await ctx.container.auditLog.export(tenantA, adminActorFor(owner), {
      customerId: '00000000-0000-4000-8000-00000000cafe',
    } as never);
    const alerts = await events('access.data_exported', tenantA.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.context).toMatchObject({
      adminId: owner.id,
      exportKind: 'AUDIT_LOG',
      rowCount: file.rows,
      format: 'csv',
    });
    expect(JSON.stringify(alerts[0])).not.toContain('cafe');
  });

  it('addresses a hosted tenant’s export to the OWNER, never to the hosted tenant', async () => {
    await ctx.container.auditLog.export(tenantB, adminActorFor(hosted), {} as never);
    expect(await events('access.data_exported', tenantB.tenantId)).toEqual([]);
    const alerts = await events('access.data_exported', tenantA.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.context).toMatchObject({ scopeTenantId: tenantB.tenantId });
  });

  it('is not recorded for a refused export', async () => {
    const viewer = await createAdmin(ctx.container, tenantA, { username: 'viewer', roleKeys: [] });
    await expect(
      ctx.container.auditLog.export(tenantA, adminActorFor(viewer), {} as never),
    ).rejects.toThrow();
    expect(await events('access.data_exported', tenantA.tenantId)).toEqual([]);
  });
});

describe('access.bulk_read', () => {
  it('alerts on one call above the per-call threshold (500 by default)', async () => {
    const actor = adminActorFor(owner);
    await ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customers', rows: 500 });
    expect(await events('access.bulk_read', tenantA.tenantId)).toEqual([]);
    await ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customers', rows: 501 });
    const alerts = await events('access.bulk_read', tenantA.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.context).toMatchObject({ readResource: 'customers', rowCount: 501 });
  });

  it('alerts once per window when many small reads add up past the window threshold', async () => {
    const actor = adminActorFor(owner);
    for (let i = 0; i < 9; i += 1) {
      await ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customer', rows: 250 });
    }
    const alerts = await events('access.bulk_read', tenantA.tenantId);
    // 2 250 rows passed 2 000 on the ninth read; the window is announced once.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.occurrenceCount).toBe(1);
    const [window] = await ctx.container.database.db
      .select()
      .from(adminReadWindows)
      .where(eq(adminReadWindows.adminId, owner.id));
    expect(window?.rowsRead).toBe(2_250);
    expect(window?.alertedAt).not.toBeNull();
  });

  it('counts a hosted administrator’s reads in their own tenant and tells only the owner', async () => {
    await ctx.container.ownerAlerts.rowsRead(tenantB, adminActorFor(hosted), {
      resource: 'customers',
      rows: 900,
    });
    expect(await events('access.bulk_read', tenantB.tenantId)).toEqual([]);
    expect(await events('access.bulk_read', tenantA.tenantId)).toHaveLength(1);
    const windows = await ctx.container.database.db.select().from(adminReadWindows);
    expect(windows.map((row) => row.tenantId)).toEqual([tenantB.tenantId]);
  });

  it('claims a window exactly once when two reads cross it together', async () => {
    const actor = adminActorFor(owner);
    await ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customer', rows: 1_990 });
    await Promise.all([
      ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customer', rows: 20 }),
      ctx.container.ownerAlerts.rowsRead(tenantA, actor, { resource: 'customer', rows: 20 }),
    ]);
    const alerts = await events('access.bulk_read', tenantA.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.occurrenceCount).toBe(1);
  });
});
