import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUDIENCE_ERROR_CODES,
  AUDIENCE_ROUTES,
  AUTH_ROUTES,
  SESSION_COOKIE_NAME,
  audienceOptionsResponseSchema,
  audiencePreviewResponseSchema,
  errorResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * The audience routes over HTTP (round N): every response parses against its contract
 * schema, a definition the contract refuses is a 400 with the audience's own code, and the
 * server — not the Web Admin — refuses a reader without `users.view`.
 */

const ORIGIN = 'https://admin.example.test';

describe('audience HTTP surface', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let technicalCookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, role] of [
      ['owner', 'owner'],
      ['technical', 'technical'],
    ] as const) {
      await createAdmin(api.container, tenantA, {
        username,
        password: `the-${username}-password`,
        roleKeys: [role],
      });
    }
    ownerCookie = await cookieFor('owner');
    technicalCookie = await cookieFor('technical');
  });

  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  it('previews a definition and lists the builder’s options', async () => {
    const fixtures = new AudienceFixtures(
      { container: api.container } as never,
      tenantA.tenantId as string,
    );
    await fixtures.customer({ telegramUserId: '7001', botInstanceId: SEED_IDS.botA1 });
    await fixtures.tier('gold');

    const preview = await post(AUDIENCE_ROUTES.preview, ownerCookie, {
      definition: { version: 1, purchase: 'NEVER_PURCHASED' },
    });
    expect(preview.statusCode).toBe(201);
    const body = audiencePreviewResponseSchema.parse(preview.json()).preview;
    expect(body).toMatchObject({ customers: 1, reachable: 1 });

    const options = await inject({
      method: 'GET',
      url: `${API_PREFIX}${AUDIENCE_ROUTES.options}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
    });
    expect(options.statusCode).toBe(200);
    const parsed = audienceOptionsResponseSchema.parse(options.json());
    expect(parsed.currency).toBe('IRT');
    expect(parsed.resellerTiers.map((tier) => tier.name)).toEqual(['gold']);
    // Roadmap C3 (PR #245 review m5): the tenant's bots ON THE WIRE — names and status only,
    // never a token or its ciphertext, read from the raw response, not the parsed one.
    const raw = options.json() as { bots: Record<string, unknown>[] };
    expect(raw.bots.length).toBeGreaterThan(0);
    for (const bot of raw.bots)
      expect(Object.keys(bot).sort()).toEqual(['id', 'status', 'username']);
    expect(options.body).not.toMatch(/token|ciphertext/i);
  });

  it('refuses an invalid definition as a 400 with the audience code', async () => {
    const response = await post(AUDIENCE_ROUTES.preview, ownerCookie, {
      definition: { version: 1, walletBalance: { currency: 'IRT' } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe(
      AUDIENCE_ERROR_CODES.DEFINITION_INVALID,
    );
  });

  it('refuses a caller without users.view', async () => {
    const response = await post(AUDIENCE_ROUTES.preview, technicalCookie, {
      definition: { version: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  /** An administrator holding ONLY a custom role with exactly these keys. */
  async function customCookie(username: string, permissions: readonly string[]): Promise<string> {
    const db = api.container.database.db;
    const roleId = api.container.ids.uuid();
    await db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, ${username}, ${username}, false)`);
    for (const permission of permissions) {
      await db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const admin = await createAdmin(api.container, tenantA, {
      username,
      password: `the-${username}-password`,
    });
    await db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    return cookieFor(username);
  }

  const options = (cookie: string) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${AUDIENCE_ROUTES.options}`,
      headers: { cookie, origin: ORIGIN },
    });

  // Codex R1 on PR #117: the options are the vocabulary of every consumer's form, so a role
  // that may run the action reads them without being handed the customer list.
  it('serves the options to every consuming action without users.view, and to nobody else', async () => {
    const consumers: readonly (readonly string[])[] = [
      ['broadcasts.view', 'broadcasts.send'],
      ['bulk_operations.view', 'users.wallet.mass'],
      ['bulk_operations.view', 'services.mass.grant'],
    ];
    for (const [index, permissions] of consumers.entries()) {
      const cookie = await customCookie(`consumer${index}`, permissions);
      const response = await options(cookie);
      expect(response.statusCode, permissions.join('+')).toBe(200);
      expect(audienceOptionsResponseSchema.parse(response.json()).currency).toBe('IRT');
      // The options are not the customer list: the counted sample stays on users.view.
      expect(
        (await post(AUDIENCE_ROUTES.preview, cookie, { definition: { version: 1 } })).statusCode,
      ).toBe(403);
    }
    const viewer = await customCookie('viewer', ['broadcasts.view', 'bulk_operations.view']);
    expect((await options(viewer)).statusCode).toBe(403);
  });
});
