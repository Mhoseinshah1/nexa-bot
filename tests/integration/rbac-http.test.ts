import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  effectivePermissionsResponseSchema,
  RBAC_ROUTES,
  roleMutationResponseSchema,
  roleViewListResponseSchema,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/** Phase D3 role management over real HTTP: the seam, the schemas, Origin, the owner role. */

const ORIGIN = 'https://admin.example.test';

describe('role management over HTTP', () => {
  let api: ApiApp;
  let helperId: string;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    helperId = (
      await createAdmin(api.container, tenantA, {
        username: 'helper',
        password: 'the-helpers-password',
        roleKeys: ['support'],
      })
    ).id;
  });

  async function cookie(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie']),
    );
    return `${SESSION_COOKIE_NAME}=${match![1] as string}`;
  }

  it('refuses an unauthenticated caller', async () => {
    const response = await inject({ method: 'GET', url: `${API_PREFIX}${RBAC_ROUTES.roles}` });
    expect(response.statusCode).toBe(401);
  });

  it('lists, creates, edits and previews through the frozen schemas', async () => {
    const owner = await cookie('owner', 'the-owners-real-password');
    const list = await inject({
      method: 'GET',
      url: `${API_PREFIX}${RBAC_ROUTES.roles}`,
      headers: { cookie: owner },
    });
    expect(list.statusCode).toBe(200);
    const roles = roleViewListResponseSchema.parse(list.json()).roles;
    expect(roles.find((role) => role.key === 'owner')?.immutable).toBe(true);

    const created = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RBAC_ROUTES.roles}`,
      headers: { cookie: owner, origin: ORIGIN },
      payload: {
        key: 'desk',
        name: 'Desk',
        permissions: ['users.view', 'tickets.view', 'tickets.reply'],
        reason: 'new desk',
        idempotencyKey: 'http-role-create-1',
      },
    });
    expect(created.statusCode).toBe(201);
    const role = roleMutationResponseSchema.parse(created.json()).role;

    // No Origin: refused before anything is decided.
    const forged = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RBAC_ROUTES.role('desk')}`,
      headers: { cookie: owner },
      payload: {
        name: 'Desk',
        permissions: ['users.view'],
        expectedVersion: role.version,
        reason: 'x',
      },
    });
    expect(forged.statusCode).toBe(403);

    const ownerEdit = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RBAC_ROUTES.role('owner')}`,
      headers: { cookie: owner, origin: ORIGIN },
      payload: {
        name: 'Owner',
        permissions: [],
        expectedVersion: 1,
        reason: 'x',
        confirmation: 'owner',
      },
    });
    expect(ownerEdit.statusCode).toBe(409);
    expect(ownerEdit.json().error.code).toBe('role.immutable');

    const preview = await inject({
      method: 'GET',
      url: `${API_PREFIX}${RBAC_ROUTES.effective(helperId)}`,
      headers: { cookie: owner },
    });
    expect(preview.statusCode).toBe(200);
    const body = effectivePermissionsResponseSchema.parse(preview.json());
    expect(body.effective).toContain('tickets.reply');
  });

  it('refuses a holder of support the role writes', async () => {
    const helper = await cookie('helper', 'the-helpers-password');
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RBAC_ROUTES.roles}`,
      headers: { cookie: helper, origin: ORIGIN },
      payload: { key: 'mine', name: 'Mine', permissions: ['users.view'], reason: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });
});
