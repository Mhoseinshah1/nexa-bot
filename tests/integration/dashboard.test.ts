import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  DASHBOARD_ROUTES,
  MANAGEMENT_CONDITION_FAILURE_CODES,
  REPORT_ROUTES,
  SESSION_COOKIE_NAME,
  dashboardOperationsResponseSchema,
  dashboardSummaryResponseSchema,
  navCountersResponseSchema,
  providerDescriptor,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
  type Clock,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { ReportAccess } from '../../apps/api/src/modules/commerce/reporting/application/report-access';
import { ReportingService } from '../../apps/api/src/modules/commerce/reporting/application/reporting.service';
import { DrizzleOperationsOverviewRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-operations-overview.repository';
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { DefaultReportExportWriter } from '../../apps/api/src/infrastructure/export/report-export-writer';
import { IntlReportPeriodResolver } from '../../apps/api/src/infrastructure/time/report-calendar';
import { SEED_IDS, seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Round W's dashboard and sidebar counters over real HTTP and real SQL
 * (`docs/web-redesign/dashboard.md`).
 *
 * The business summary is WP12's reports read once more, so the seed is the reports' own
 * kind of day: 1405/06/10 in Tehran (1 September 2026, from 2026-08-31T20:30Z), with every
 * way a figure lies placed in it on purpose — a trial, a refunded order, a pending order, a
 * failed attempt before a confirmed one, a top-up, a sale one second inside midnight and one
 * on it, a sale in another currency, and another tenant's sale. The operational counts get
 * the same treatment: an archived panel, a disabled panel whose last probe failed, a
 * resolved condition, a closed ticket, a rejected refund request, a SUSPENDED service
 * expiring tomorrow — each a row that must NOT be counted, beside one that must.
 *
 * The HTTP range is CUSTOM on past dates, so those assertions do not move with the clock.
 * TODAY and THIS MONTH are pinned by a service built on a stopped clock.
 */

const ORIGIN = 'https://admin.example.test';
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Local midnight of 1405/06/10 in Tehran. */
const D0 = Date.UTC(2026, 7, 31, 20, 30);
const at = (hours: number, minutes = 0, dayOffset = 0, seconds = 0): string =>
  new Date(D0 + dayOffset * DAY + ((hours * 60 + minutes) * 60 + seconds) * 1000).toISOString();
const DAY_D = 'range=CUSTOM&from=1405-06-10&to=1405-06-10';

class StoppedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

describe('Round W dashboard', () => {
  let api: ApiApp;
  const cookies: Record<string, string> = {};
  let ownerId = '';
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

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  // --- Seed helpers ------------------------------------------------------------------

  const ids = { panelA: '', panelB: '', productA: '', productB: '', c0: '', c1: '', c2: '' };

  async function customer(tenantId: string, createdAt: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${id}, ${tenantId}, ${`78000${n}`}, ${`Customer${n}`}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)`);
    return id;
  }

  async function panel(
    tenantId: string,
    provider: 'sanaei' | 'marzban',
    status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED',
    health: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' | null,
  ): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, archived_at)
      VALUES (${id}, ${tenantId}, ${`Panel ${n}`}, ${provider}, ${`https://p${n}.example.test`}, ${status},
        ${status === 'ARCHIVED' ? at(0) : null}::timestamptz)`);
    if (health !== null) {
      await run(sql`INSERT INTO panel_health (panel_id, tenant_id, state, checked_at, latency_ms, failure)
        VALUES (${id}, ${tenantId}, ${health}, ${at(0)}::timestamptz, 40,
          ${health === 'UNREACHABLE' ? 'UNREACHABLE' : null})`);
    }
    return id;
  }

  async function product(tenantId: string, panelId: string): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${id}, ${tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 100000, 'IRT')`);
    return id;
  }

  async function order(o: {
    tenantId?: string;
    customerId: string;
    purpose: 'NEW_SERVICE' | 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'TRIAL';
    state?: 'PAID' | 'AWAITING_PAYMENT' | 'REFUNDED';
    subtotal: number;
    discount?: number;
    settledAt?: string;
    refundedAt?: string;
    currency?: 'IRT' | 'IRR';
  }): Promise<string> {
    const id = uuid();
    const tenantId = o.tenantId ?? tenantA.tenantId;
    const state = o.state ?? 'PAID';
    const discount = o.discount ?? 0;
    const bytes = o.purpose === 'ADD_TIME' ? 0 : 1_073_741_824;
    const days = o.purpose === 'ADD_TRAFFIC' ? 0 : 30;
    const settled = state === 'AWAITING_PAYMENT' ? null : (o.settledAt ?? null);
    const isA = tenantId === tenantA.tenantId;
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, refunded_at, created_at)
      VALUES (${id}, ${tenantId}, ${o.customerId}, ${state}, ${o.purpose},
        ${isA ? ids.productA : ids.productB}, ${isA ? ids.panelA : ids.panelB},
        'Plan', ${days}, ${bytes}, 1, ${o.subtotal},
        'دسته', ${o.subtotal}, ${discount}, ${o.subtotal - discount}, ${o.currency ?? 'IRT'}, '{}'::jsonb,
        ${o.settledAt ?? at(0)}::timestamptz, ${settled}::timestamptz, ${o.refundedAt ?? null}::timestamptz,
        ${o.settledAt ?? at(0)}::timestamptz)`);
    return id;
  }

  async function payment(p: {
    tenantId?: string;
    customerId: string;
    orderId: string | null;
    state: 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
    method: 'WALLET' | 'MANUAL_TRANSFER';
    amount: number;
    createdAt: string;
    doneAt?: string;
  }): Promise<string> {
    const id = uuid();
    n += 1;
    const confirmed = p.state === 'CONFIRMED';
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
        reference, evidence_kind, confirmed_at, resolved_at, gateway_provider, created_at)
      VALUES (${id}, ${p.tenantId ?? tenantA.tenantId}, ${p.customerId}, ${p.orderId}, ${p.state}, ${p.method}, ${p.amount}, 'IRT',
        ${`DSH-${n}`}, ${confirmed ? (p.method === 'WALLET' ? 'WALLET_DEBIT' : 'OPERATOR_REVIEW') : null},
        ${confirmed ? (p.doneAt ?? p.createdAt) : null}::timestamptz,
        ${p.state === 'FAILED' ? (p.doneAt ?? p.createdAt) : null}::timestamptz,
        ${p.method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null},
        ${p.createdAt}::timestamptz)`);
    return id;
  }

  async function service(s: {
    tenantId?: string;
    orderId: string;
    customerId: string;
    state: string;
    expiresAt?: Date | null;
  }): Promise<string> {
    const id = uuid();
    n += 1;
    const tenantId = s.tenantId ?? tenantA.tenantId;
    const isA = tenantId === tenantA.tenantId;
    await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id, state,
        provider_username, traffic_limit_bytes, provisioned_at, expires_at, created_at)
      VALUES (${id}, ${tenantId}, ${s.customerId}, ${s.orderId}, ${isA ? ids.panelA : ids.panelB},
        ${isA ? ids.productA : ids.productB}, ${s.state}, ${`nxdsh${n}`}, 1073741824,
        ${s.state === 'PENDING_PROVISION' || s.state === 'UNRECONCILED' ? null : at(12, 5)}::timestamptz,
        ${s.expiresAt?.toISOString() ?? null}::timestamptz, ${at(12, 5)}::timestamptz)`);
    return id;
  }

  async function operation(o: {
    tenantId?: string;
    serviceId: string;
    state: 'PLANNED' | 'IN_FLIGHT' | 'UNKNOWN' | 'FAILED';
  }): Promise<void> {
    const tenantId = o.tenantId ?? tenantA.tenantId;
    await run(sql`INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id, panel_id, type, state,
        attempts, failure_kind, completed_at)
      VALUES (${uuid()}, ${tenantId}, ${uuid().replaceAll('-', '').slice(-16)}, ${o.serviceId},
        ${tenantId === tenantA.tenantId ? ids.panelA : ids.panelB}, 'PROVISION', ${o.state}, 1,
        ${o.state === 'FAILED' ? 'PROVIDER_ERROR' : null},
        ${o.state === 'FAILED' ? at(12, 30) : null}::timestamptz)`);
  }

  async function condition(tenantId: string, code: string, resolved: boolean): Promise<void> {
    await run(sql`INSERT INTO operational_events (id, tenant_id, code, severity, message, first_seen_at, last_seen_at, resolved_at)
      VALUES (${uuid()}, ${tenantId}, ${code}, 'ERROR', 'seeded', ${at(1)}::timestamptz, ${at(1)}::timestamptz,
        ${resolved ? at(2) : null}::timestamptz)`);
  }

  async function ticket(status: string): Promise<void> {
    n += 1;
    await run(sql`INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id, category_title,
        status, opening_key, closed_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${ids.c1}, ${SEED_IDS.botA1}, ${ticketCategory}, 'General',
        ${status}, ${`open-${n}`}, ${status === 'CLOSED' ? at(3) : null}::timestamptz)`);
  }
  let ticketCategory = '';

  /** A Telegram Business conversation (TB2) in `state`, on its own connection. */
  async function conversation(
    tenantId: string,
    bot: string,
    state: 'HANDOFF_REQUIRED' | 'AI_ACTIVE' | 'HUMAN_ACTIVE',
    customerId: string | null = null,
  ): Promise<void> {
    n += 1;
    const connectionRowId = uuid();
    await run(sql`INSERT INTO telegram_business_connections
        (id, tenant_id, bot_instance_id, connection_id, owner_telegram_user_id,
         owner_user_chat_id, is_enabled, rights, connected_at, last_confirmed_at)
      VALUES (${connectionRowId}, ${tenantId}, ${bot}, ${`dash-${n}`}, '5000009',
              '5000009', true, ARRAY['can_reply'], now(), now())`);
    const chat = String(7_200_000 + n);
    await run(sql`INSERT INTO business_conversations
        (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id, connection_row_id,
         peer_telegram_user_id, customer_id, state, control_epoch, handoff_reason)
      VALUES (${uuid()}, ${tenantId}, ${bot}, '5000009', ${chat}, ${connectionRowId}, ${chat},
              ${customerId}, ${state}, 1, ${state === 'HANDOFF_REQUIRED' ? 'HANDOFF_TOPIC' : null})`);
  }

  const now = () => Date.now();

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['support', ['support'], tenantA],
      ['sales', ['sales'], tenantA],
      ['technical', ['technical'], tenantA],
    ] as const) {
      const admin = await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
      if (username === 'owner') ownerId = admin.id;
    }
    for (const name of ['owner', 'support', 'sales', 'technical']) {
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

    // --- The fleet: five live panels, one archived, and tenant B's.
    ids.panelA = await panel(tenantA.tenantId, 'sanaei', 'ACTIVE', 'HEALTHY');
    await panel(tenantA.tenantId, 'marzban', 'ACTIVE', 'UNREACHABLE');
    await panel(tenantA.tenantId, 'sanaei', 'ACTIVE', null);
    // Disabled after a failed probe: DISABLED in the view, and never "unhealthy".
    await panel(tenantA.tenantId, 'sanaei', 'DISABLED', 'UNREACHABLE');
    await panel(tenantA.tenantId, 'sanaei', 'ARCHIVED', 'HEALTHY');
    await panel(tenantA.tenantId, 'marzban', 'ACTIVE', 'DEGRADED');
    ids.panelB = await panel(tenantB.tenantId, 'sanaei', 'ACTIVE', 'UNREACHABLE');
    ids.productA = await product(tenantA.tenantId, ids.panelA);
    ids.productB = await product(tenantB.tenantId, ids.panelB);

    // --- Customers: two registered on D (one a second before midnight), one on D-1, one
    // exactly on the next midnight.
    ids.c0 = await customer(tenantA.tenantId, at(9, 0, -1));
    ids.c1 = await customer(tenantA.tenantId, at(10, 0));
    ids.c2 = await customer(tenantA.tenantId, at(23, 59, 0, 59));
    await customer(tenantA.tenantId, at(0, 0, 1));

    // --- Sales on D.
    const o1 = await order({
      customerId: ids.c1,
      purpose: 'NEW_SERVICE',
      subtotal: 100_000,
      discount: 20_000,
      settledAt: at(12),
    });
    await payment({
      customerId: ids.c1,
      orderId: o1,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 80_000,
      createdAt: at(11),
      doneAt: at(11, 5),
    });
    const o1Paid = await payment({
      customerId: ids.c1,
      orderId: o1,
      state: 'CONFIRMED',
      method: 'MANUAL_TRANSFER',
      amount: 80_000,
      createdAt: at(11, 30),
      doneAt: at(12),
    });
    const o2 = await order({
      customerId: ids.c1,
      purpose: 'RENEW',
      subtotal: 50_000,
      settledAt: at(13),
    });
    await payment({
      customerId: ids.c1,
      orderId: o2,
      state: 'CONFIRMED',
      method: 'WALLET',
      amount: 50_000,
      createdAt: at(13),
    });
    // A top-up is not an order payment, and never a method's share of sales.
    await payment({
      customerId: ids.c1,
      orderId: null,
      state: 'CONFIRMED',
      method: 'MANUAL_TRANSFER',
      amount: 60_000,
      createdAt: at(8),
    });
    await order({
      customerId: ids.c1,
      purpose: 'ADD_TRAFFIC',
      subtotal: 10_000,
      settledAt: at(14),
    });
    await order({
      customerId: ids.c1,
      purpose: 'ADD_TIME',
      subtotal: 5_000,
      settledAt: at(14, 30),
    });
    const trial = await order({
      customerId: ids.c1,
      purpose: 'TRIAL',
      subtotal: 0,
      settledAt: at(9, 30),
    });
    await order({
      customerId: ids.c2,
      purpose: 'NEW_SERVICE',
      state: 'REFUNDED',
      subtotal: 40_000,
      settledAt: at(19),
      refundedAt: at(20),
    });
    const pending = await order({
      customerId: ids.c2,
      purpose: 'NEW_SERVICE',
      state: 'AWAITING_PAYMENT',
      subtotal: 40_000,
    });
    const o8 = await order({
      customerId: ids.c2,
      purpose: 'NEW_SERVICE',
      subtotal: 2_000,
      settledAt: at(23, 59, 0, 59),
    });
    await order({
      customerId: ids.c2,
      purpose: 'NEW_SERVICE',
      subtotal: 1_000,
      settledAt: at(0, 0, 1),
    });
    const irr = await order({
      customerId: ids.c0,
      purpose: 'NEW_SERVICE',
      subtotal: 500_000,
      settledAt: at(16),
      currency: 'IRR',
    });

    // --- The previous day, and the month around D.
    const o10 = await order({
      customerId: ids.c0,
      purpose: 'RENEW',
      subtotal: 7_000,
      settledAt: at(15, 0, -1),
    });
    await payment({
      customerId: ids.c0,
      orderId: o10,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 7_000,
      createdAt: at(14, 0, -1),
      doneAt: at(14, 1, -1),
    });
    const o12 = await order({
      customerId: ids.c0,
      purpose: 'NEW_SERVICE',
      subtotal: 3_000,
      settledAt: at(14, 0, -1),
    });
    // 1405/06/01 00:00 exactly: the first instant of the month.
    const o13 = await order({
      customerId: ids.c0,
      purpose: 'NEW_SERVICE',
      subtotal: 4_000,
      settledAt: at(0, 0, -9),
    });
    // 1405/05/05, inside last month's like-for-like span; 1405/05/20, outside it.
    const o14 = await order({
      customerId: ids.c0,
      purpose: 'NEW_SERVICE',
      subtotal: 6_000,
      settledAt: at(12, 0, -36),
    });
    const o15 = await order({
      customerId: ids.c0,
      purpose: 'NEW_SERVICE',
      subtotal: 9_999,
      settledAt: at(12, 0, -21),
    });

    // A failure resolved exactly on the next midnight belongs to the next day.
    await payment({
      customerId: ids.c2,
      orderId: pending,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 40_000,
      createdAt: at(23),
      doneAt: at(0, 0, 1),
    });
    await payment({
      customerId: ids.c2,
      orderId: pending,
      state: 'UNKNOWN',
      method: 'MANUAL_TRANSFER',
      amount: 40_000,
      createdAt: at(22),
    });

    // --- Services, relative to the REAL clock: the expiry window is "from now".
    const soon = (ms: number) => new Date(now() + ms);
    const s1 = await service({
      orderId: o1,
      customerId: ids.c1,
      state: 'ACTIVE',
      expiresAt: soon(DAY),
    });
    const sTrial = await service({
      orderId: trial,
      customerId: ids.c1,
      state: 'ACTIVE',
      expiresAt: soon(7 * DAY - HOUR),
    });
    const s8 = await service({ orderId: o8, customerId: ids.c2, state: 'PENDING_PROVISION' });
    const sIrr = await service({
      orderId: irr,
      customerId: ids.c0,
      state: 'ACTIVE',
      expiresAt: soon(8 * DAY),
    });
    const s12 = await service({ orderId: o12, customerId: ids.c0, state: 'UNRECONCILED' });
    // Suspended: expiring by date, but not an ACTIVE service.
    await service({ orderId: o13, customerId: ids.c0, state: 'SUSPENDED', expiresAt: soon(DAY) });
    // Active with an expiry already passed: the sweep has not caught up; not "expiring".
    await service({ orderId: o14, customerId: ids.c0, state: 'ACTIVE', expiresAt: soon(-HOUR) });
    await service({ orderId: o15, customerId: ids.c0, state: 'EXPIRED', expiresAt: soon(-DAY) });

    await operation({ serviceId: s8, state: 'PLANNED' });
    await operation({ serviceId: s12, state: 'IN_FLIGHT' });
    await operation({ serviceId: sIrr, state: 'UNKNOWN' });
    await operation({ serviceId: sTrial, state: 'FAILED' });

    // --- Things waiting for an operator, and things that are not.
    const [code] = MANAGEMENT_CONDITION_FAILURE_CODES;
    await condition(tenantA.tenantId, code, false);
    await condition(tenantA.tenantId, code, true);
    await condition(tenantA.tenantId, 'test.not_a_management_condition', false);
    await condition(tenantB.tenantId, code, false);

    ticketCategory = uuid();
    await run(
      sql`INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${ticketCategory}, ${tenantA.tenantId}, 'General')`,
    );
    for (const status of ['OPEN', 'WAITING_FOR_SUPPORT', 'WAITING_FOR_CUSTOMER', 'CLOSED']) {
      await ticket(status);
    }

    // Roadmap B6: two support handoffs waiting for a person; a conversation the AI holds and
    // one a person already took are not; nor is tenant B's handoff.
    await conversation(tenantA.tenantId, SEED_IDS.botA1, 'HANDOFF_REQUIRED');
    await conversation(tenantA.tenantId, SEED_IDS.botA1, 'HANDOFF_REQUIRED', ids.c1);
    await conversation(tenantA.tenantId, SEED_IDS.botA1, 'AI_ACTIVE');
    await conversation(tenantA.tenantId, SEED_IDS.botA1, 'HUMAN_ACTIVE');
    await conversation(tenantB.tenantId, SEED_IDS.botB1, 'HANDOFF_REQUIRED');

    await run(sql`INSERT INTO service_refund_requests (id, tenant_id, service_id, customer_id, order_id, payment_id,
        bot_instance_id, state, reason, filing_key, principal_minor, currency)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${s1}, ${ids.c1}, ${o1}, ${o1Paid}, ${SEED_IDS.botA1},
        'OPEN', 'not needed', 'filing-open', 80000, 'IRT')`);
    await run(sql`INSERT INTO service_refund_requests (id, tenant_id, service_id, customer_id, order_id, payment_id,
        bot_instance_id, state, reason, filing_key, principal_minor, currency, decided_by_admin_id, decided_at,
        rejection_reason, resolved_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${s1}, ${ids.c1}, ${o1}, ${o1Paid}, ${SEED_IDS.botA1},
        'REJECTED', 'changed mind', 'filing-rejected', 80000, 'IRT', ${ownerId}, ${at(4)}::timestamptz,
        'used', ${at(4)}::timestamptz)`);

    // --- Tenant B: a sale, an expiring service, a queued operation.
    const bCustomer = await customer(tenantB.tenantId, at(9, 0));
    const bOrder = await order({
      tenantId: tenantB.tenantId,
      customerId: bCustomer,
      purpose: 'NEW_SERVICE',
      subtotal: 999_999,
      settledAt: at(12),
    });
    await payment({
      tenantId: tenantB.tenantId,
      customerId: bCustomer,
      orderId: bOrder,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 999_999,
      createdAt: at(11),
      doneAt: at(11, 1),
    });
    const bService = await service({
      tenantId: tenantB.tenantId,
      orderId: bOrder,
      customerId: bCustomer,
      state: 'ACTIVE',
      expiresAt: soon(DAY),
    });
    await operation({ tenantId: tenantB.tenantId, serviceId: bService, state: 'PLANNED' });
  });

  // --- Business summary -------------------------------------------------------------

  it('states the selected period from the reports’ own definitions, compared with the day before', async () => {
    const response = await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies.owner as string);
    expect(response.statusCode).toBe(200);
    const body = dashboardSummaryResponseSchema.parse(response.json());

    // o1 80000 after discount, o2 renewal 50000, o3 10000, o4 5000, o8 2000 one second
    // before midnight, and the IRR sale. NOT the trial, the refunded or pending orders, the
    // sale ON the next midnight, the top-up, or tenant B's 999999.
    expect(body.selected.sales).toEqual({ current: 6, previous: 2 });
    expect(body.selected.revenue).toEqual([
      { currency: 'IRR', current: '500000', previous: '0' },
      { currency: 'IRT', current: '147000', previous: '10000' },
    ]);
    expect(body.selected.renewals).toEqual({ current: 1, previous: 1 });
    expect(body.selected.newCustomers).toEqual({ current: 2, previous: 1 });
    // One failure resolved on D; the one resolved ON the next midnight is the next day's.
    expect(body.selected.failedPayments).toEqual({ current: 1, previous: 1 });
    expect(body.currency).toBe('IRT');
    expect(body.currencies).toEqual(expect.arrayContaining(['IRR', 'IRT']));
    expect(body.activeServices).toBe(4);
    expect(body.period.granularity).toBe('HOUR');
    expect(body.period.current.startLocal).toBe('1405/06/10');
  });

  it('agrees with the report summary and trend for the same period, figure for figure', async () => {
    const owner = cookies.owner as string;
    const dashboard = dashboardSummaryResponseSchema.parse(
      (await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, owner)).json(),
    );
    const report = reportSummaryResponseSchema.parse(
      (await get(`${REPORT_ROUTES.summary}?${DAY_D}`, owner)).json(),
    );
    const trend = reportTrendResponseSchema.parse(
      (await get(`${REPORT_ROUTES.trend}?${DAY_D}&metric=REVENUE`, owner)).json(),
    );
    const newUsers = reportTrendResponseSchema.parse(
      (await get(`${REPORT_ROUTES.trend}?${DAY_D}&metric=NEW_USERS`, owner)).json(),
    );
    expect(dashboard.selected.sales).toEqual(report.sales);
    expect(dashboard.selected.revenue).toEqual(report.revenue);
    expect(dashboard.selected.renewals).toEqual(report.renewals);
    expect(dashboard.selected.newCustomers).toEqual(report.newUsers);
    expect(dashboard.activeServices).toBe(report.activeServices);
    expect(dashboard.period).toMatchObject({ ...report.period, generatedAt: expect.any(String) });
    expect(dashboard.selected.revenueSeries.current).toEqual(trend.current);
    expect(dashboard.selected.revenueSeries.previous).toEqual(trend.previous);
    expect(dashboard.selected.newCustomerSeries).toEqual(newUsers.current);
  });

  it('draws revenue by hour in the sales currency, with the previous day aligned', async () => {
    const body = dashboardSummaryResponseSchema.parse(
      (await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies.owner as string)).json(),
    );
    const { current, previous } = body.selected.revenueSeries;
    expect(current).toHaveLength(24);
    expect(current[12]?.value).toBe('80000');
    expect(current[14]?.value).toBe('15000');
    // The IRR sale at 16:00 is not drawn in a Toman series.
    expect(current[16]?.value).toBe('0');
    expect(current[23]?.value).toBe('2000');
    expect(previous[14]?.value).toBe('3000');
    expect(previous[15]?.value).toBe('7000');
    expect(previous[15]?.label).toBe(current[15]?.label);
    expect(body.selected.newCustomerSeries[10]?.value).toBe('1');
    expect(body.selected.newCustomerSeries[23]?.value).toBe('1');
  });

  it('splits the sales into new, renewal and add-on, and the kinds add up to the sales', async () => {
    const body = dashboardSummaryResponseSchema.parse(
      (await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies.owner as string)).json(),
    );
    const bucket = (hour: number) => body.selected.salesByKind[hour]?.counts;
    expect(bucket(12)).toEqual({ NEW: 1, RENEWAL: 0, ADDON: 0 });
    expect(bucket(13)).toEqual({ NEW: 0, RENEWAL: 1, ADDON: 0 });
    expect(bucket(14)).toEqual({ NEW: 0, RENEWAL: 0, ADDON: 2 });
    // A sale in another currency is still a sale.
    expect(bucket(16)).toEqual({ NEW: 1, RENEWAL: 0, ADDON: 0 });
    expect(bucket(23)).toEqual({ NEW: 1, RENEWAL: 0, ADDON: 0 });
    // The trial at 09:30 is no kind of sale.
    expect(bucket(9)).toEqual({ NEW: 0, RENEWAL: 0, ADDON: 0 });
    const total = body.selected.salesByKind.reduce(
      (sum, b) => sum + (b.counts === null ? 0 : b.counts.NEW + b.counts.RENEWAL + b.counts.ADDON),
      0,
    );
    expect(total).toBe(body.selected.sales.current);
  });

  it('shares confirmed ORDER payments by method, never a top-up or a failed attempt', async () => {
    const body = dashboardSummaryResponseSchema.parse(
      (await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies.owner as string)).json(),
    );
    expect(body.selected.paymentMethods).toEqual([
      {
        method: 'MANUAL_TRANSFER',
        confirmed: 1,
        confirmedAmount: [{ currency: 'IRT', amount: '80000' }],
      },
      { method: 'WALLET', confirmed: 1, confirmedAmount: [{ currency: 'IRT', amount: '50000' }] },
    ]);
  });

  it('compares today and this month like for like, and leaves the hours not yet begun empty', async () => {
    // A service on a stopped clock: D at 15:00 Tehran. Everything else is the container's.
    const c = api.container;
    const service = new ReportingService({
      access: new ReportAccess(c.guard, c.admins, c.opsLog),
      repository: new DrizzleReportingRepository(c.database.db),
      periods: new IntlReportPeriodResolver(),
      presentation: {
        presentationFor: async () => ({ timezone: 'Asia/Tehran', calendar: 'jalali' }),
      },
      salesCurrency: { salesCurrency: async () => 'IRT' },
      writer: new DefaultReportExportWriter(),
      clock: new StoppedClock(new Date(at(15))),
    });
    const owner = {
      type: 'WEB_ADMIN',
      id: ownerId,
      label: 'owner',
      surface: 'WEB',
      correlationId: 'dashboard-test',
    } as never;
    const body = dashboardSummaryResponseSchema.parse(
      JSON.parse(JSON.stringify(await service.dashboard(tenantA, owner, { range: 'TODAY' }))),
    );

    // Today to 15:00: o1, o2, o3, o4. Yesterday to 15:00: o12 at 14:00 — and NOT o10, which
    // settled at 15:00 exactly, the cut's own instant.
    expect(body.today.sales).toEqual({ current: 4, previous: 1 });
    expect(body.today.revenue).toEqual([{ currency: 'IRT', current: '145000', previous: '3000' }]);
    expect(body.today.period.current.effectiveEnd).toBe(at(15));
    expect(body.today.period.previous.effectiveEnd).toBe(at(15, 0, -1));
    expect(body.today.series[12]?.value).toBe('80000');
    expect(body.today.series[14]?.value).toBe('15000');
    // 15:00 has not begun at 15:00: unknown, never zero.
    expect(body.today.series[15]?.value).toBeNull();
    expect(body.today.series[23]?.value).toBeNull();

    // Shahrivar to D 15:00: o13 at its first instant, o12 and o10 on D-1, and today's four.
    // Mordad to the same elapsed span: o14 on the 5th, and NOT o15 on the 20th.
    expect(body.month.revenue).toEqual([{ currency: 'IRT', current: '159000', previous: '6000' }]);
    expect(body.month.sales).toEqual({ current: 7, previous: 1 });
    expect(body.month.period.current.startLocal).toBe('1405/06/01');
    expect(body.month.period.granularity).toBe('DAY');
    expect(body.month.series[0]?.value).toBe('4000');
    expect(body.month.series[8]?.value).toBe('10000');
    expect(body.month.series[9]?.value).toBe('145000');
    expect(body.month.series[10]?.value).toBeNull();

    // The IRR sale settled at 16:00, past the 15:00 cut: inside today's and this month's
    // NOMINAL end, outside every effective window, so no figure contains it and the list of
    // currencies must not offer it either. Nor may the trend's, over the same cut.
    expect(body.currencies).toEqual(['IRT']);
    const trend = await service.trend(tenantA, owner, { range: 'TODAY' }, 'REVENUE');
    expect(trend.currencies).toEqual(['IRT']);

    // The selected period on the same clock is TODAY, so its figures are today's.
    expect(body.selected.sales).toEqual(body.today.sales);
    expect(body.selected.salesByKind[15]?.counts).toBeNull();
  });

  it('keeps one tenant out of another tenant’s dashboard', async () => {
    const body = dashboardSummaryResponseSchema.parse(
      (await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies.foreign as string)).json(),
    );
    expect(body.selected.revenue).toEqual([{ currency: 'IRT', current: '999999', previous: '0' }]);
    expect(body.selected.sales).toEqual({ current: 1, previous: 0 });
    expect(body.selected.failedPayments).toEqual({ current: 1, previous: 0 });
    expect(body.selected.newCustomers).toEqual({ current: 1, previous: 0 });
    expect(body.activeServices).toBe(1);
  });

  it('refuses the business summary to every non-owner, recorded like any denial', async () => {
    const before = await denials();
    for (const name of ['support', 'sales', 'technical']) {
      const response = await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, cookies[name] as string);
      expect(response.statusCode, name).toBe(403);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'platform.permission_denied',
      );
    }
    // support and sales hold reports.view and lack the owner role; technical lacks both.
    expect(await denials()).toBe(before + 3);
    expect((await get(`${DASHBOARD_ROUTES.summary}?${DAY_D}`, null)).statusCode).toBe(401);
  });

  it('refuses a malformed range at the edge', async () => {
    for (const query of [
      'range=CUSTOM&from=1405-06-10',
      'range=TODAY&from=1405-06-10&to=1405-06-10',
      'range=ALL_TIME',
      'range=TODAY&range=YESTERDAY',
      '',
    ]) {
      const response = await get(`${DASHBOARD_ROUTES.summary}?${query}`, cookies.owner as string);
      expect(response.statusCode, query).toBe(400);
    }
  });

  // --- Operations ---------------------------------------------------------------------

  it('counts the fleet once, by the projected health view, and the provisioning lane now', async () => {
    const body = dashboardOperationsResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.operations, cookies.owner as string)).json(),
    );
    expect(body.panels).toEqual({
      total: 5,
      active: 4,
      health: [
        { state: 'HEALTHY', count: 1 },
        { state: 'DEGRADED', count: 1 },
        { state: 'UNREACHABLE', count: 1 },
        { state: 'DISABLED', count: 1 },
        { state: 'UNCHECKED', count: 1 },
      ],
      providers: [
        {
          providerType: 'marzban',
          providerName: providerDescriptor('marzban')?.canonicalName,
          count: 2,
        },
        {
          providerType: 'sanaei',
          providerName: providerDescriptor('sanaei')?.canonicalName,
          count: 3,
        },
      ],
    });
    expect(body.provisioning).toEqual({ queued: 2, unknown: 1, unreconciledServices: 1 });
    // s1 tomorrow and the trial in six days and 23 hours; not the one in eight days, not the
    // SUSPENDED one, not the one already past its expiry, not tenant B's.
    expect(body.expiring).toEqual({ withinDays: 7, count: 2 });
  });

  it('withholds each operations section without its page’s permission, and records nothing', async () => {
    const before = await denials();
    const support = dashboardOperationsResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.operations, cookies.support as string)).json(),
    );
    expect(support.panels).toBeNull();
    expect(support.provisioning).toEqual({ queued: 2, unknown: 1, unreconciledServices: 1 });
    expect(support.expiring?.count).toBe(2);
    const sales = dashboardOperationsResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.operations, cookies.sales as string)).json(),
    );
    expect(sales).toMatchObject({ panels: null, provisioning: null, expiring: null });
    // A withheld section is not a denial: a sidebar that polls must not fill the alerts feed.
    expect(await denials()).toBe(before);
    expect((await get(DASHBOARD_ROUTES.operations, null)).statusCode).toBe(401);
  });

  it('keeps one tenant out of another tenant’s operations', async () => {
    const body = dashboardOperationsResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.operations, cookies.foreign as string)).json(),
    );
    expect(body.panels).toMatchObject({
      total: 1,
      active: 1,
      health: [{ state: 'UNREACHABLE', count: 1 }],
    });
    expect(body.provisioning).toEqual({ queued: 1, unknown: 0, unreconciledServices: 0 });
    expect(body.expiring?.count).toBe(1);
  });

  // --- Sidebar counters ---------------------------------------------------------------

  it('counts what waits behind each sidebar link, and nothing that does not', async () => {
    const body = navCountersResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.navCounters, cookies.owner as string)).json(),
    );
    expect(body.counters).toEqual({
      // One open management condition: not the resolved one, not the non-management code,
      // not tenant B's.
      openConditions: 1,
      // OPEN and WAITING_FOR_SUPPORT; not WAITING_FOR_CUSTOMER, not CLOSED.
      ticketsAwaitingSupport: 2,
      // UNREACHABLE and DEGRADED active panels; not the DISABLED one whose probe failed.
      unhealthyPanels: 2,
      unreconciledServices: 1,
      // The OPEN request; not the REJECTED one.
      refundRequestsAwaiting: 1,
      paymentsUnknown: 1,
      // HANDOFF_REQUIRED; not AI_ACTIVE, not HUMAN_ACTIVE, not tenant B's.
      businessHandoffs: 2,
    });
  });

  it('withholds each counter without its page’s permission, and records nothing', async () => {
    const before = await denials();
    const counters = async (name: string) =>
      navCountersResponseSchema.parse(
        (await get(DASHBOARD_ROUTES.navCounters, cookies[name] as string)).json(),
      ).counters;
    expect(await counters('support')).toEqual({
      openConditions: null,
      ticketsAwaitingSupport: 2,
      unhealthyPanels: null,
      unreconciledServices: 1,
      refundRequestsAwaiting: null,
      paymentsUnknown: null,
      businessHandoffs: 2,
    });
    expect(await counters('technical')).toEqual({
      openConditions: 1,
      ticketsAwaitingSupport: null,
      unhealthyPanels: 2,
      unreconciledServices: 1,
      refundRequestsAwaiting: null,
      paymentsUnknown: null,
      businessHandoffs: null,
    });
    expect(Object.values(await counters('sales')).every((value) => value === null)).toBe(true);
    expect(await denials()).toBe(before);
    expect((await get(DASHBOARD_ROUTES.navCounters, null)).statusCode).toBe(401);
  });

  it('keeps one tenant out of another tenant’s counters', async () => {
    const body = navCountersResponseSchema.parse(
      (await get(DASHBOARD_ROUTES.navCounters, cookies.foreign as string)).json(),
    );
    expect(body.counters).toEqual({
      openConditions: 1,
      ticketsAwaitingSupport: 0,
      unhealthyPanels: 1,
      unreconciledServices: 0,
      refundRequestsAwaiting: 0,
      paymentsUnknown: 0,
      businessHandoffs: 1,
    });
  });

  it('bounds a counter by the rows it reads, and says so by reaching the cap', async () => {
    for (let i = 0; i < 2; i += 1) {
      await payment({
        customerId: ids.c1,
        orderId: null,
        state: 'UNKNOWN',
        method: 'MANUAL_TRANSFER',
        amount: 1_000,
        createdAt: at(5, i),
      });
    }
    const repository = new DrizzleOperationsOverviewRepository(api.container.database.db);
    expect(await repository.navCounter(tenantA, 'paymentsUnknown', 10)).toBe(3);
    expect(await repository.navCounter(tenantA, 'paymentsUnknown', 2)).toBe(2);
    expect(await repository.navCounter(tenantA, 'businessHandoffs', 10)).toBe(2);
    expect(await repository.navCounter(tenantA, 'businessHandoffs', 1)).toBe(1);
  });

  it('bounds the unreconciled badge, and counts the dashboard’s unreconciled gauge in full', async () => {
    for (let i = 0; i < 2; i += 1) {
      const orderId = await order({
        customerId: ids.c0,
        purpose: 'NEW_SERVICE',
        subtotal: 1_000,
        settledAt: at(6, i),
      });
      await service({ orderId, customerId: ids.c0, state: 'UNRECONCILED' });
    }
    const repository = new DrizzleOperationsOverviewRepository(api.container.database.db);
    // Three in tenant A: the badge stops at its cap, the gauge does not.
    expect(await repository.navCounter(tenantA, 'unreconciledServices', 2)).toBe(2);
    expect(await repository.unreconciledServices(tenantA)).toBe(3);
    expect(await repository.unreconciledServices(tenantB)).toBe(0);
  });

  async function denials(): Promise<number> {
    const result = await run(
      sql`SELECT coalesce(sum(occurrence_count), 0)::int AS n FROM operational_events
           WHERE code = 'access.permission_denied'`,
    );
    return (result.rows[0] as { n: number }).n;
  }
});
