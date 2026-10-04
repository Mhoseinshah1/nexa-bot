import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_ROUTES,
  RESELLER_ROUTES,
  RESELLER_TIER_ROUTES,
  SESSION_COOKIE_NAME,
  customerListResponseSchema,
  resellerResponseSchema,
  resellerTierResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * UX batch 01, item 9: registering a reseller from a customer PICKER, over real HTTP.
 *
 * The register form used to want the customer's internal uuid, and an operator typing
 * the Telegram id they had was refused. The picker is the customer list's own search,
 * `GET /users?q=` (`docs/web-admin-search.md`), and the register command still takes the
 * uuid — which the picker supplies from the row the operator chose. These cases pin what
 * the picker relies on, end to end: what each shape of input finds, that several matches
 * come back as several (the operator chooses; nothing picks for them), that the search is
 * charged `users.search` and scoped to the actor's tenant, and that the id it hands over
 * is accepted by the register command.
 *
 * Tenant B holds a twin of tenant A's customer — same Telegram id, username and name — so
 * a search that leaked would find two rows where one is right.
 */

const ORIGIN = 'https://admin.example.test';

describe('the reseller customer picker', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let noSearchCookie: string;
  let foreignCookie: string;
  let ali: string;
  let alireza: string;
  let aliB: string;
  let n = 0;
  const key = (): string => `reseller-picker-${(n += 1)}`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const run = (statement: ReturnType<typeof sql>) => api.container.database.db.execute(statement);
  const id = () => api.container.ids.uuid();

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

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
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  async function customer(
    tenantId: string,
    input: { telegramUserId: string; username: string | null; firstName: string; lastName: string },
  ): Promise<string> {
    const customerId = id();
    await run(sql`INSERT INTO customers
        (id, tenant_id, telegram_user_id, username, first_name, last_name, status)
      VALUES (${customerId}, ${tenantId}, ${input.telegramUserId}, ${input.username},
              ${input.firstName}, ${input.lastName}, 'ACTIVE')`);
    return customerId;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owner-password',
      roleKeys: ['owner'],
    });
    // May register resellers and read customers, and may NOT search them.
    const roleId = id();
    await run(sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, 'reseller_clerk', 'Reseller clerk', false)`);
    for (const permission of ['resellers.view', 'resellers.edit', 'users.view']) {
      await run(sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const clerk = await createAdmin(api.container, tenantA, {
      username: 'clerk',
      password: 'the-clerk-password',
    });
    await run(sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${clerk.id}, ${roleId})`);
    ownerCookie = await cookieFor('owner');
    noSearchCookie = await cookieFor('clerk');

    api.container.setInstallationTenant(tenantB.tenantId);
    await createAdmin(api.container, tenantB, {
      username: 'foreign',
      password: 'the-foreign-password',
      roleKeys: ['owner'],
    });
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    const a = tenantA.tenantId as string;
    ali = await customer(a, {
      telegramUserId: '7100000001',
      username: 'ali_reza',
      firstName: 'Ali',
      lastName: 'Rezaei',
    });
    alireza = await customer(a, {
      telegramUserId: '7100000002',
      username: 'AliReza_Shop',
      firstName: 'علیرضا',
      lastName: 'کریمی',
    });
    aliB = await customer(tenantB.tenantId as string, {
      telegramUserId: '7100000001',
      username: 'ali_reza',
      firstName: 'Ali',
      lastName: 'Rezaei',
    });
  });

  /** Exactly the request the Web Admin's picker sends. */
  const pick = (q: string, cookie: string | null = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${CUSTOMER_ROUTES.list}?limit=10&q=${encodeURIComponent(q)}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });
  const found = async (q: string, cookie: string = ownerCookie): Promise<string[]> => {
    const response = await pick(q, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return customerListResponseSchema
      .parse(response.json())
      .customers.map((row) => row.id)
      .sort();
  };

  it('finds a customer by Telegram id, exactly, in this tenant only', async () => {
    expect(await found('7100000001')).toEqual([ali]);
    // Exact: a prefix of a Telegram id finds nobody.
    expect(await found('710000000')).toEqual([]);
    // Tenant B's twin is B's, and only B sees it.
    expect(await found('7100000001', foreignCookie)).toEqual([aliB]);
  });

  it('finds by @username and by plain username, case-insensitively', async () => {
    expect(await found('@ALI_REZA')).toEqual([ali]);
    expect(await found('@alireza_shop')).toEqual([alireza]);
    expect(await found('ali_reza')).toEqual([ali]);
    expect(await found('ALIREZA_SHOP')).toEqual([alireza]);
  });

  it('finds by display name', async () => {
    expect(await found('علیرضا')).toEqual([alireza]);
    expect(await found('Ali Rez')).toEqual([ali]);
  });

  it('returns every match of an ambiguous search, for the operator to choose from', async () => {
    expect(await found('ali')).toEqual([ali, alireza].sort());
    expect(await found('@ali')).toEqual([ali, alireza].sort());
  });

  it('returns nothing for no match, rather than a near one', async () => {
    expect(await found('7199999999')).toEqual([]);
    expect(await found('@nobody_here')).toEqual([]);
  });

  it('is charged users.search, and refuses a session that lacks it or has none', async () => {
    expect((await pick('7100000001', noSearchCookie)).statusCode).toBe(403);
    expect((await pick('7100000001', null)).statusCode).toBe(401);
  });

  it('registers the uuid of the row the operator picked, never anything typed', async () => {
    const tier = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RESELLER_TIER_ROUTES.create}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
      payload: {
        idempotencyKey: key(),
        name: 'Gold',
        pricingMode: 'LIST_PRICE',
        discountPercentage: null,
        creditLimit: { amount: '0', currency: 'IRT' },
      },
    });
    expect(tier.statusCode, tier.body).toBe(201);
    const tierId = resellerTierResponseSchema.parse(tier.json()).tier.id;

    const [picked] = customerListResponseSchema.parse(
      (await pick('@alireza_shop')).json(),
    ).customers;
    const registered = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RESELLER_ROUTES.register}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
      payload: {
        idempotencyKey: key(),
        customerId: picked!.id,
        tierId,
        pricingMode: 'TIER',
        discountPercentage: null,
        creditLimit: null,
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    expect(resellerResponseSchema.parse(registered.json()).reseller).toMatchObject({
      customerId: alireza,
      telegramUserId: '7100000002',
    });

    // The register command still refuses a Telegram id where the uuid belongs: the
    // picker is what turns one into the other, and the server does not guess.
    const typed = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RESELLER_ROUTES.register}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
      payload: {
        idempotencyKey: key(),
        customerId: '7100000001',
        tierId,
        pricingMode: 'TIER',
        discountPercentage: null,
        creditLimit: null,
      },
    });
    expect(typed.statusCode).toBe(400);

    // And tenant B cannot register tenant A's customer it can never have picked.
    const foreign = await inject({
      method: 'POST',
      url: `${API_PREFIX}${RESELLER_ROUTES.register}`,
      headers: { cookie: foreignCookie, origin: ORIGIN },
      payload: {
        idempotencyKey: key(),
        customerId: ali,
        tierId,
        pricingMode: 'TIER',
        discountPercentage: null,
        creditLimit: null,
      },
    });
    expect([403, 404]).toContain(foreign.statusCode);
  });
});
