import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CUSTOMER_360_ROUTES,
  CUSTOMER_WORKSPACE_LATEST_LIMIT,
  CUSTOMER_WORKSPACE_PERMISSIONS,
  CUSTOMER_WORKSPACE_SECTIONS,
  ROLE_SEEDS,
  SESSION_COOKIE_NAME,
  customerWorkspaceResponseSchema,
  type CustomerWorkspaceResponse,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleCustomerInsightReader } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer-insight.reader';
import { SEED_IDS, seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Roadmap B5 — Customer 360's workspace summary (`GET /users/:id/workspace`) over real HTTP
 * and real SQL.
 *
 * The seed puts, beside every row that must be counted for the customer, a row that must
 * not: a ticket waiting for the CUSTOMER and a closed one, a conversation the AI holds, a
 * confirmed payment beside the UNKNOWN ones, an ACTIVE service beside the UNRECONCILED one —
 * and the same kinds of row for ANOTHER customer of the same tenant, and for tenant B. The
 * lists hold seven orders and seven payments, two of each sharing one instant, so "the
 * newest five, newest first" is decided by the query and its tie-break, never by luck.
 */

const ORIGIN = 'https://admin.example.test';
const T0 = Date.UTC(2026, 8, 1, 8, 0);
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

describe('Customer 360 workspace', () => {
  let api: ApiApp;
  const cookies: Record<string, string> = {};
  let n = 0;
  const uuid = (): string => api.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const get = (path: string, cookie: string | null) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
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

  async function workspaceAs(name: string, customerId: string): Promise<CustomerWorkspaceResponse> {
    const response = await get(CUSTOMER_360_ROUTES.workspace(customerId), cookies[name] ?? null);
    expect(response.statusCode, response.body).toBe(200);
    return customerWorkspaceResponseSchema.parse(response.json()).workspace;
  }

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  // --- Seed helpers ------------------------------------------------------------------

  const ids = { panelA: '', productA: '', panelB: '', productB: '', x: '', y: '', z: '' };
  const latest = { orders: [] as string[], payments: [] as string[] };
  let category = '';

  async function customer(tenantId: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${id}, ${tenantId}, ${`79000${n}`}, ${`Customer${n}`}, ${at(0)}::timestamptz, ${at(0)}::timestamptz)`);
    return id;
  }

  async function panel(tenantId: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${id}, ${tenantId}, ${`Panel ${n}`}, 'marzban', ${`https://w${n}.example.test`}, 'ACTIVE')`);
    return id;
  }

  async function product(tenantId: string, panelId: string): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${id}, ${tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 100000, 'IRT')`);
    return id;
  }

  async function order(tenantId: string, customerId: string, createdAt: string, title: string) {
    const id = uuid();
    const isA = tenantId === tenantA.tenantId;
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        subtotal_amount, discount_amount, total_amount, currency, quote, created_at)
      VALUES (${id}, ${tenantId}, ${customerId}, 'AWAITING_PAYMENT', 'NEW_SERVICE',
        ${isA ? ids.productA : ids.productB}, ${isA ? ids.panelA : ids.panelB},
        ${title}, 30, 1073741824, 1, 100000, 100000, 0, 100000, 'IRT', '{}'::jsonb,
        ${createdAt}::timestamptz)`);
    return id;
  }

  async function payment(
    tenantId: string,
    customerId: string,
    state: 'PENDING' | 'CONFIRMED' | 'UNKNOWN',
    createdAt: string,
    orderId: string | null = null,
  ): Promise<string> {
    const id = uuid();
    n += 1;
    const confirmed = state === 'CONFIRMED';
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
        reference, evidence_kind, confirmed_at, gateway_provider, created_at)
      VALUES (${id}, ${tenantId}, ${customerId}, ${orderId}, ${state}, 'MANUAL_TRANSFER', ${1000 + n}, 'IRT',
        ${`WS-${n}`}, ${confirmed ? 'OPERATOR_REVIEW' : null}, ${confirmed ? createdAt : null}::timestamptz,
        'MANUAL_TRANSFER', ${createdAt}::timestamptz)`);
    return id;
  }

  async function service(tenantId: string, customerId: string, state: string): Promise<void> {
    n += 1;
    const isA = tenantId === tenantA.tenantId;
    const orderId = await order(tenantId, customerId, at(-1000 - n), 'svc');
    await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id, state,
        provider_username, traffic_limit_bytes, provisioned_at, created_at)
      VALUES (${uuid()}, ${tenantId}, ${customerId}, ${orderId}, ${isA ? ids.panelA : ids.panelB},
        ${isA ? ids.productA : ids.productB}, ${state}, ${`nxws${n}`}, 1073741824,
        ${state === 'UNRECONCILED' ? null : at(0)}::timestamptz, ${at(0)}::timestamptz)`);
  }

  async function ticket(tenantId: string, customerId: string, status: string): Promise<void> {
    n += 1;
    await run(sql`INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id, category_title,
        status, opening_key, closed_at)
      VALUES (${uuid()}, ${tenantId}, ${customerId}, ${tenantId === tenantA.tenantId ? SEED_IDS.botA1 : SEED_IDS.botB1},
        ${category}, 'General', ${status}, ${`ws-open-${n}`}, ${status === 'CLOSED' ? at(3) : null}::timestamptz)`);
  }

  async function conversation(
    tenantId: string,
    customerId: string | null,
    state: 'HANDOFF_REQUIRED' | 'AI_ACTIVE',
  ): Promise<void> {
    n += 1;
    const bot = tenantId === tenantA.tenantId ? SEED_IDS.botA1 : SEED_IDS.botB1;
    const connectionRowId = uuid();
    await run(sql`INSERT INTO telegram_business_connections
        (id, tenant_id, bot_instance_id, connection_id, owner_telegram_user_id,
         owner_user_chat_id, is_enabled, rights, connected_at, last_confirmed_at)
      VALUES (${connectionRowId}, ${tenantId}, ${bot}, ${`ws-${n}`}, '5000009',
              '5000009', true, ARRAY['can_reply'], now(), now())`);
    const chat = String(7_300_000 + n);
    await run(sql`INSERT INTO business_conversations
        (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id, connection_row_id,
         peer_telegram_user_id, customer_id, state, control_epoch, handoff_reason)
      VALUES (${uuid()}, ${tenantId}, ${bot}, '5000009', ${chat}, ${connectionRowId}, ${chat},
              ${customerId}, ${state}, 1, ${state === 'HANDOFF_REQUIRED' ? 'HANDOFF_TOPIC' : null})`);
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const name of ['owner', 'support', 'finance', 'sales', 'technical'] as const) {
      await createAdmin(api.container, tenantA, {
        username: name,
        password: `the-${name}-password`,
        roleKeys: [name],
      });
      cookies[name] = await cookieFor(name);
    }
    api.container.setInstallationTenant(tenantB.tenantId);
    await createAdmin(api.container, tenantB, {
      username: 'foreign',
      password: 'the-foreign-password',
      roleKeys: ['owner'],
    });
    cookies.foreign = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    ids.panelA = await panel(tenantA.tenantId);
    ids.productA = await product(tenantA.tenantId, ids.panelA);
    ids.panelB = await panel(tenantB.tenantId);
    ids.productB = await product(tenantB.tenantId, ids.panelB);
    ids.x = await customer(tenantA.tenantId);
    ids.y = await customer(tenantA.tenantId);
    ids.z = await customer(tenantB.tenantId);

    category = uuid();
    await run(
      sql`INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${category}, ${tenantA.tenantId}, 'General')`,
    );
    const categoryB = category;
    for (const status of ['OPEN', 'WAITING_FOR_SUPPORT', 'WAITING_FOR_CUSTOMER', 'CLOSED']) {
      await ticket(tenantA.tenantId, ids.x, status);
    }
    await ticket(tenantA.tenantId, ids.y, 'OPEN');
    category = uuid();
    await run(
      sql`INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${category}, ${tenantB.tenantId}, 'General')`,
    );
    await ticket(tenantB.tenantId, ids.z, 'OPEN');
    category = categoryB;

    await conversation(tenantA.tenantId, ids.x, 'HANDOFF_REQUIRED');
    await conversation(tenantA.tenantId, ids.x, 'AI_ACTIVE');
    await conversation(tenantA.tenantId, ids.y, 'HANDOFF_REQUIRED');
    await conversation(tenantA.tenantId, null, 'HANDOFF_REQUIRED');
    await conversation(tenantB.tenantId, ids.z, 'HANDOFF_REQUIRED');

    await service(tenantA.tenantId, ids.x, 'UNRECONCILED');
    await service(tenantA.tenantId, ids.x, 'ACTIVE');
    await service(tenantA.tenantId, ids.y, 'UNRECONCILED');
    await service(tenantB.tenantId, ids.z, 'UNRECONCILED');

    // Seven orders and seven payments for X; the two newest of each share one instant.
    latest.orders = [];
    latest.payments = [];
    const orderAt = [at(1), at(2), at(3), at(4), at(5), at(6), at(6)];
    const paymentStates = [
      'CONFIRMED',
      'UNKNOWN',
      'PENDING',
      'CONFIRMED',
      'UNKNOWN',
      'CONFIRMED',
      'PENDING',
    ] as const;
    const orders: { id: string; at: string }[] = [];
    const payments: { id: string; at: string }[] = [];
    for (const [i, when] of orderAt.entries()) {
      const orderId = await order(tenantA.tenantId, ids.x, when, `Order ${String(i)}`);
      orders.push({ id: orderId, at: when });
      payments.push({
        // Each attached to its order: an open payment with no order is a top-up, one at a time.
        id: await payment(tenantA.tenantId, ids.x, paymentStates[i] ?? 'PENDING', when, orderId),
        at: when,
      });
    }
    const newestFirst = (rows: { id: string; at: string }[]) =>
      [...rows]
        .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
        .slice(0, CUSTOMER_WORKSPACE_LATEST_LIMIT)
        .map((row) => row.id);
    latest.orders = newestFirst(orders);
    latest.payments = newestFirst(payments);
    // Newer rows of other customers and another tenant: never in X's lists.
    await order(tenantA.tenantId, ids.y, at(60), 'Not X');
    await payment(tenantA.tenantId, ids.y, 'UNKNOWN', at(60));
    await order(tenantB.tenantId, ids.z, at(60), 'Tenant B');
    await payment(tenantB.tenantId, ids.z, 'UNKNOWN', at(60));
  });

  async function denials(): Promise<number> {
    const result = await run(
      sql`SELECT coalesce(sum(occurrence_count), 0)::int AS n FROM operational_events
           WHERE code = 'access.permission_denied'`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  it('counts what about this customer waits for a person, and nothing that does not', async () => {
    const workspace = await workspaceAs('owner', ids.x);
    // OPEN and WAITING_FOR_SUPPORT await support; every status but CLOSED is open.
    expect(workspace.tickets).toEqual({ awaitingSupport: 2, open: 3 });
    // X's HANDOFF_REQUIRED conversation; not the AI's, not Y's, not the unlinked one, not B's.
    expect(workspace.businessHandoffs).toBe(1);
    expect(workspace.payments?.unknown).toBe(2);
    expect(workspace.services).toEqual({ unreconciled: 1 });
  });

  it('lists the newest orders and payments, newest first, at most the limit', async () => {
    const workspace = await workspaceAs('owner', ids.x);
    expect(workspace.orders?.latest.map((row) => row.id)).toEqual(latest.orders);
    expect(workspace.payments?.latest.map((row) => row.id)).toEqual(latest.payments);
    expect(workspace.orders?.latest).toHaveLength(CUSTOMER_WORKSPACE_LATEST_LIMIT);
    const [first] = workspace.payments?.latest ?? [];
    // Money is an exact minor-unit string beside its currency.
    expect(first?.amount).toMatch(/^\d+$/);
    expect(first?.currency).toBe('IRT');
    expect(first?.reference).toMatch(/^WS-/);
  });

  it('withholds each section without its page’s permission, and records nothing', async () => {
    const before = await denials();
    for (const role of ['support', 'finance', 'sales'] as const) {
      const held = new Set(ROLE_SEEDS.find((seedRole) => seedRole.key === role)?.permissions);
      const workspace = await workspaceAs(role, ids.x);
      for (const section of CUSTOMER_WORKSPACE_SECTIONS) {
        const expected = held.has(CUSTOMER_WORKSPACE_PERMISSIONS[section]);
        expect(workspace[section] !== null, `${role} ${section}`).toBe(expected);
      }
    }
    // Not vacuous: the roles disagree, and in the directions the gating decides.
    const support = await workspaceAs('support', ids.x);
    const finance = await workspaceAs('finance', ids.x);
    const sales = await workspaceAs('sales', ids.x);
    expect(support.payments).toBeNull();
    expect(support.tickets).toEqual({ awaitingSupport: 2, open: 3 });
    expect(support.businessHandoffs).toBe(1);
    expect(finance.payments?.unknown).toBe(2);
    expect(finance.tickets).toBeNull();
    expect(finance.businessHandoffs).toBeNull();
    expect(sales.orders?.latest).toHaveLength(CUSTOMER_WORKSPACE_LATEST_LIMIT);
    expect(sales.services).toBeNull();
    expect(await denials()).toBe(before);
  });

  it('charges users.view itself: a role without it is refused, and the refusal is recorded', async () => {
    const before = await denials();
    const response = await get(CUSTOMER_360_ROUTES.workspace(ids.x), cookies.technical ?? null);
    expect(response.statusCode).toBe(403);
    expect(await denials()).toBe(before + 1);
    expect((await get(CUSTOMER_360_ROUTES.workspace(ids.x), null)).statusCode).toBe(401);
  });

  it('keeps one tenant out of another tenant’s customer', async () => {
    const foreign = await get(CUSTOMER_360_ROUTES.workspace(ids.x), cookies.foreign ?? null);
    expect(foreign.statusCode).toBe(404);
    // Tenant B's own customer reads only tenant B's rows.
    const own = await workspaceAs('foreign', ids.z);
    expect(own.tickets).toEqual({ awaitingSupport: 1, open: 1 });
    expect(own.businessHandoffs).toBe(1);
    expect(own.payments?.unknown).toBe(1);
    expect(own.services).toEqual({ unreconciled: 1 });
    expect(own.orders?.latest.map((row) => row.lineTitle)).toEqual(['Tenant B', 'svc']);
  });

  it('refuses an identifier that is not one, and a customer that does not exist', async () => {
    expect(
      (await get(CUSTOMER_360_ROUTES.workspace('not-a-uuid'), cookies.owner ?? null)).statusCode,
    ).toBe(400);
    expect(
      (await get(CUSTOMER_360_ROUTES.workspace(uuid()), cookies.owner ?? null)).statusCode,
    ).toBe(404);
  });

  it('bounds every count by the rows it reads, and every list by its limit', async () => {
    const reader = new DrizzleCustomerInsightReader(api.container.database.db);
    const x = ids.x as UserId;
    expect(await reader.tickets(tenantA, x, 1)).toEqual({ awaitingSupport: 1, open: 1 });
    expect(await reader.unknownPayments(tenantA, x, 1)).toBe(1);
    expect(await reader.unknownPayments(tenantA, x, 10)).toBe(2);
    await conversation(tenantA.tenantId, ids.x, 'HANDOFF_REQUIRED');
    expect(await reader.businessHandoffs(tenantA, x, 10)).toBe(2);
    expect(await reader.businessHandoffs(tenantA, x, 1)).toBe(1);
    await service(tenantA.tenantId, ids.x, 'UNRECONCILED');
    expect(await reader.unreconciledServices(tenantA, x, 1)).toBe(1);
    expect(await reader.unreconciledServices(tenantA, x, 10)).toBe(2);
    expect(await reader.latestOrders(tenantA, x, 2)).toHaveLength(2);
    expect((await reader.latestPayments(tenantA, x, 3)).map((row) => row.id)).toEqual(
      latest.payments.slice(0, 3),
    );
  });
});
