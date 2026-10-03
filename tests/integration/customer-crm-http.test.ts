import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_CRM_ROUTES,
  CUSTOMER_ROUTES,
  customerListResponseSchema,
  customerNoteCreateResponseSchema,
  customerNoteListResponseSchema,
  customerTagAssignmentResponseSchema,
  customerTagListResponseSchema,
  customerTagWriteResponseSchema,
  SESSION_COOKIE_NAME,
  type BotInstanceId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Customer notes and tags over HTTP (program §8): the routes, the list's `tag` filter, and
 * the permission split as a signed-in session meets it — a real cookie, a real origin, the
 * real guard. The service-level rules are `customer-crm.test.ts`.
 */

const ORIGIN = 'https://admin.example.test';

describe('customer notes and tags — HTTP', () => {
  let api: ApiApp;
  let operatorCookie: string;
  /** A custom role holding users.view ALONE. */
  let viewerCookie: string;
  let keyCounter = 0;
  const idempotencyKey = () => `crm-http-${String((keyCounter += 1))}-key`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, cookie: string, payload: unknown, origin: string | null = ORIGIN) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: origin === null ? { cookie } : { cookie, origin },
      payload,
    });

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
      username: 'operator',
      password: 'the-operators-real-password',
      roleKeys: ['operator'],
    });
    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'viewer_only', 'Viewer only', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'users.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);
    operatorCookie = await cookieFor('operator', 'the-operators-real-password');
    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  async function customer(telegramUserId: string): Promise<UserId> {
    const repository = new DrizzleCustomerRepository(api.container.database.db);
    const resolution = await repository.resolve(tenantA, {
      id: api.container.ids.uuid() as UserId,
      telegramUserId,
      profile: { username: null, firstName: 'C', lastName: null, languageCode: null },
      botInstanceId: SEED_IDS.botA1 as unknown as BotInstanceId,
      now: api.container.clock.now(),
    });
    return resolution.customer.id;
  }

  it('creates, assigns, filters and notes through the operator session', async () => {
    const tagged = await customer('7700001');
    await customer('7700002');
    const created = await post(CUSTOMER_CRM_ROUTES.tags, operatorCookie, {
      idempotencyKey: idempotencyKey(),
      label: ' Gold   member ',
      color: 'warn',
    });
    expect(created.statusCode).toBe(201);
    const tag = customerTagWriteResponseSchema.parse(created.json()).tag;
    expect(tag).toMatchObject({ label: 'Gold member', color: 'warn', archivedAt: null });

    const assigned = await post(CUSTOMER_CRM_ROUTES.customerTags(tagged), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      tagId: tag.id,
    });
    expect(assigned.statusCode).toBe(201);
    expect(
      customerTagAssignmentResponseSchema.parse(assigned.json()).tags.map((one) => one.id),
    ).toEqual([tag.id]);

    const filtered = await get(`${CUSTOMER_ROUTES.list}?tag=${tag.id}`, viewerCookie);
    expect(filtered.statusCode).toBe(200);
    expect(
      customerListResponseSchema.parse(filtered.json()).customers.map((one) => one.id),
    ).toEqual([tagged]);

    const note = await post(CUSTOMER_CRM_ROUTES.customerNotes(tagged), operatorCookie, {
      idempotencyKey: idempotencyKey(),
      body: 'asked for a refund by phone',
    });
    expect(note.statusCode).toBe(201);
    expect(customerNoteCreateResponseSchema.parse(note.json()).note.authorLabel).toBe('operator');
    const notes = await get(CUSTOMER_CRM_ROUTES.customerNotes(tagged), operatorCookie);
    expect(customerNoteListResponseSchema.parse(notes.json()).notes.map((one) => one.body)).toEqual(
      ['asked for a refund by phone'],
    );
  });

  it('serves tags to users.view and refuses it every §8 write and the notes', async () => {
    const someone = await customer('7700003');
    const list = await get(CUSTOMER_CRM_ROUTES.tags, viewerCookie);
    expect(list.statusCode).toBe(200);
    expect(customerTagListResponseSchema.parse(list.json()).tags).toEqual([]);
    expect((await get(CUSTOMER_CRM_ROUTES.customerTags(someone), viewerCookie)).statusCode).toBe(
      200,
    );

    expect(
      (
        await post(CUSTOMER_CRM_ROUTES.tags, viewerCookie, {
          idempotencyKey: idempotencyKey(),
          label: 'X',
        })
      ).statusCode,
    ).toBe(403);
    expect((await get(CUSTOMER_CRM_ROUTES.customerNotes(someone), viewerCookie)).statusCode).toBe(
      403,
    );
    expect(
      (
        await post(CUSTOMER_CRM_ROUTES.customerNotes(someone), viewerCookie, {
          idempotencyKey: idempotencyKey(),
          body: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('refuses a malformed tag filter rather than answering an empty page', async () => {
    expect((await get(`${CUSTOMER_ROUTES.list}?tag=vip`, viewerCookie)).statusCode).toBe(400);
  });

  it('refuses a write from an origin the installation does not list', async () => {
    const response = await post(
      CUSTOMER_CRM_ROUTES.tags,
      operatorCookie,
      { idempotencyKey: idempotencyKey(), label: 'Cross-site' },
      'https://evil.example.test',
    );
    expect(response.statusCode).toBe(403);
    expect(
      (await api.container.database.db.execute(sql`SELECT count(*)::int AS n FROM customer_tags`))
        .rows,
    ).toEqual([{ n: 0 }]);
  });
});
