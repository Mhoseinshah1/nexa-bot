import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { API_PREFIX, AUTH_ROUTES, type TenantId } from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import {
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEEDED_TENANT_KINDS,
  tenantA,
  testConfig,
} from './harness';

/**
 * The installation tenant guard (#413) on an install that hosts many tenants (ADR-0037).
 *
 * The suite's API runs as nexa_app, so the guard's lookups (`tenants.findById`,
 * `tenants.findPrimary`, unbound) go through the audited system path — and have to work
 * there; so does the owner's alert, recorded on the PRIMARY tenant. "The primary" is the
 * OWNER's installation tenant; the guard must never move a reseller's or hosted bot's
 * tenant onto it (PR #411, fail closed): the kind is recorded where the scope is set, and a
 * vanished tenant not recorded as PRIMARY stops the scope, refuses its writes and tells the
 * owner once.
 *
 * MUTATIONS (each run, each turns a case below red): make `run` fall back for every kind
 * (drop the `failClosed` branch) — both hosted cases and the unknown case; fall back when
 * the kind is UNKNOWN (`recordedKind !== null && …`) — the unknown case; make the
 * container's `stopScope` a no-op — the three fail-closed cases; address the owner's alert
 * to the cached tenant instead of the PRIMARY — the three fail-closed cases; never fall
 * back (`if (true)`) — both restore cases here and both in restore-reloads-tenant; record
 * no kind in `resolveInstallationTenant` — the boot case. (The in-process alert dedupe is
 * pinned by the unit suite: here the stopped scope already prevents a second alert.)
 */

const ORIGIN = 'https://admin.example.test';
const VANISHED = 'tenancy.cached_tenant_vanished';

let api: ApiApp;
const inject = (options: Record<string, unknown>) =>
  api.app
    .getHttpAdapter()
    .getInstance()
    .inject(options as never);
const container = () => api.container;
const guard = () => container().installationTenantGuard;
const db = () => container().database.db;

beforeAll(async () => {
  const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
  await migrateOnce(config.DATABASE_URL);
  api = await createApiApp(config);
});
afterAll(async () => {
  await api?.close();
});
beforeEach(async () => {
  await resetDatabase(db());
  await seed(db(), container().cipher);
  container().setInstallationTenant(tenantA.tenantId, 'PRIMARY');
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A child tenant of the installation, created BEFORE it, so "oldest first" would pick it. */
async function childTenant(): Promise<TenantId> {
  const id = randomUUID();
  await db()
    .insert(tenants)
    .values({
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

const login = () =>
  inject({
    method: 'POST',
    url: `${API_PREFIX}${AUTH_ROUTES.login}`,
    headers: { origin: ORIGIN },
    payload: { username: 'nobody', password: 'not-a-real-password' },
  });

async function vanishedAlerts(): Promise<{ tenant_id: string; occurrence_count: number }[]> {
  const result = await db().execute<{ tenant_id: string; occurrence_count: number }>(sql`
    SELECT tenant_id, occurrence_count FROM operational_events WHERE code = ${VANISHED}`);
  return result.rows;
}

async function throttleRows(): Promise<number> {
  const result = await db().execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM admin_login_throttle`,
  );
  return result.rows[0]!.n;
}

/**
 * The real trigger: a Web Admin login on the vanished tenant fails on the tenant foreign
 * key, the error filter hands it to the guard, and the guard fails closed. Then the next
 * login is refused before it writes anything, under any tenant.
 */
async function expectFailsClosedThroughALogin(): Promise<void> {
  const first = await login();
  expect(first.statusCode).toBeGreaterThanOrEqual(500);
  await guard().verify();

  expect(container().installationTenantId).toBeNull();
  expect(container().installationTenantId).not.toBe(tenantA.tenantId);

  const second = await login();
  expect(second.statusCode).toBeGreaterThanOrEqual(400);
  expect(await throttleRows()).toBe(0);

  // Asked again, and by another failed write: still one alert, on the OWNER's tenant only.
  guard().onWriteError(Object.assign(new Error('fk'), { code: '23503', constraint: 'tenant' }));
  await guard().verify();
  expect(await vanishedAlerts()).toEqual([
    { tenant_id: tenantA.tenantId as string, occurrence_count: 1 },
  ]);
}

describe('the installation tenant guard under row-level security', () => {
  it('the harness records each seeded tenant with the kind the seed gives it', async () => {
    const rows = await db().select({ id: tenants.id, kind: tenants.kind }).from(tenants);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.kind]))).toEqual(SEEDED_TENANT_KINDS);
  });

  it('keeps the installation tenant while it exists', async () => {
    await expect(guard().verify()).resolves.toBe(tenantA.tenantId);
    expect(container().installationTenantId).toBe(tenantA.tenantId);
  });

  it('re-resolves a vanished PRIMARY to the PRIMARY one, never an older child (#413)', async () => {
    await childTenant();
    // A restore: the cached id, recorded as PRIMARY at boot, names nothing in the live database.
    container().setInstallationTenant(randomUUID() as TenantId, 'PRIMARY');
    await expect(guard().verify()).resolves.toBe(tenantA.tenantId);
    expect(container().installationTenantId).toBe(tenantA.tenantId);
    expect(await vanishedAlerts()).toEqual([]);
  });

  it('the boot resolution records the PRIMARY, so a later restore re-resolves (#413)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Recorded as UNKNOWN first, so only what the boot resolution records can make it PRIMARY.
    container().setInstallationTenant(tenantA.tenantId);
    const { resolveInstallationTenant } = await import('../../apps/api/src/bootstrap');
    await resolveInstallationTenant(container());
    // The restore, as the guard sees it: the cached id names nothing for one lookup.
    vi.spyOn(container().tenants, 'findById').mockResolvedValueOnce(null);
    await expect(guard().verify()).resolves.toBe(tenantA.tenantId);
    expect(exit).not.toHaveBeenCalled();
    expect(await vanishedAlerts()).toEqual([]);
  });

  it('a hosted tenant deleted BEFORE the first check never becomes the owner’s; its writes are refused', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const child = await childTenant();
    container().setInstallationTenant(child, 'RESELLER_BOT');
    await db().delete(tenants).where(eq(tenants.id, child));

    await expectFailsClosedThroughALogin();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a hosted tenant deleted AFTER the first check gives the same result', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const child = await childTenant();
    container().setInstallationTenant(child, 'RESELLER_BOT');
    await expect(guard().verify()).resolves.toBe(child);
    await db().delete(tenants).where(eq(tenants.id, child));

    await expectFailsClosedThroughALogin();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a tenant whose kind was never recorded fails closed and the role exits non-zero', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const child = await childTenant();
    container().setInstallationTenant(child);
    await db().delete(tenants).where(eq(tenants.id, child));

    await expectFailsClosedThroughALogin();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
