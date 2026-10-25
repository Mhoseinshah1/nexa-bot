import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { createTestContext, SEED_IDS, tenantA, tenantB, type TestContext } from './harness';

/**
 * Round 9 C2 item 6 — where an order or a ticket came from, as the operations log reads it.
 *
 * The source line of a purchase / renewal / extra traffic / extra time / ticket log is the
 * `source_surface` of the audit row written in the transaction that created the order or the
 * message. These tests place those rows the way the services write them and read them back
 * through the real facts reader, over a real PostgreSQL — including that the audit table itself
 * accepts the `MINI_APP` surface (migration 0277), and refuses a surface nobody declared.
 *
 * MUTATION: the facts' `a.result = 'SUCCESS'` dropped -> the refused-attempt test; the
 * `ORDER BY a.occurred_at` dropped or reversed -> the "first row wins" test; the commercial
 * branch's `a.after ->> 'orderId'` dropped -> the "another order of the same service" test.
 */

const T0 = new Date('2026-10-12T09:00:00Z');
const at = (minutes: number): string => new Date(T0.getTime() + minutes * 60_000).toISOString();

describe('the source of an order and of a ticket message, from the audit trail', () => {
  let ctx: TestContext;
  let facts: DrizzleOpsLogFacts;
  let n = 0;
  const uuid = (): string => ctx.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const TX = { tx: undefined } as never;
  let panel = '';
  let product = '';
  let customer = '';

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    panel = uuid();
    product = uuid();
    customer = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panel}, ${tenantA.tenantId}, 'پنل ۱', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${product}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panel}, 100000, 'IRT')`);
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${customer}, ${tenantA.tenantId}, '7910001', 'Customer', ${at(-600)}::timestamptz, ${at(-600)}::timestamptz)`);
  });

  async function order(
    purpose: 'NEW_SERVICE' | 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customer}, 'PAID', ${purpose}, ${product}, ${panel},
        'Plan', ${purpose === 'ADD_TRAFFIC' ? 0 : 30}, ${purpose === 'ADD_TIME' ? 0 : 1073741824}, 1, 1000,
        'دسته', 1000, 0, 1000, 'IRT', '{}'::jsonb,
        ${at(0)}::timestamptz, ${at(0)}::timestamptz, ${at(0)}::timestamptz)`);
    return id;
  }

  async function service(orderId: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id, state,
        provider_username, traffic_limit_bytes, provisioned_at, expires_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customer}, ${orderId}, ${panel}, ${product}, 'ACTIVE',
        ${`nxc2o${String(n)}`}, 1073741824, ${at(0)}::timestamptz, ${at(60 * 24 * 30)}::timestamptz, ${at(0)}::timestamptz)`);
    return id;
  }

  async function commercialAction(
    serviceId: string,
    orderId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<void> {
    await run(sql`INSERT INTO service_commercial_actions (id, tenant_id, customer_id, service_id, order_id, kind,
        product_id, purchased_traffic_bytes, purchased_duration_days, amount, currency)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${customer}, ${serviceId}, ${orderId}, ${kind}, ${product},
        ${kind === 'ADD_TRAFFIC' ? 1073741824 : 0}, ${kind === 'ADD_TIME' ? 15 : 0}, 1000, 'IRT')`);
  }

  async function audit(a: {
    action: string;
    entityType: string;
    entityId: string;
    surface: string;
    actorType?: string;
    actorId?: string | null;
    label?: string | null;
    after?: Record<string, unknown> | null;
    result?: string;
    minutes?: number;
    tenantId?: string;
  }): Promise<void> {
    await run(sql`INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, actor_id, actor_label, action,
        entity_type, entity_id, after, correlation_id, source_surface, result)
      VALUES (${uuid()}, ${a.tenantId ?? tenantA.tenantId}, ${at(a.minutes ?? 0)}::timestamptz,
        ${a.actorType ?? 'CUSTOMER'}, ${a.actorId ?? null}, ${a.label ?? null}, ${a.action}, ${a.entityType},
        ${a.entityId}, ${a.after === undefined || a.after === null ? null : JSON.stringify(a.after)}::jsonb,
        ${`corr-${String(++n)}`}, ${a.surface}, ${a.result ?? 'SUCCESS'})`);
  }

  describe('the audit table and the MINI_APP surface (migration 0277)', () => {
    it('accepts a row written from the mini app, and still refuses a surface nobody declared', async () => {
      const orderId = await order('NEW_SERVICE');
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'MINI_APP',
      });
      await expect(
        audit({
          action: 'order.draft_create',
          entityType: 'Order',
          entityId: orderId,
          surface: 'SOMEWHERE_ELSE',
        }),
      ).rejects.toThrow();
    });
  });

  describe('orderOrigin', () => {
    it('reads the surface and the actor of a new service’s creating row', async () => {
      const orderId = await order('NEW_SERVICE');
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'MINI_APP',
      });
      expect(await facts.orderOrigin(tenantA, orderId, TX)).toEqual({
        surface: 'MINI_APP',
        actorType: 'CUSTOMER',
        actorId: null,
        actorLabel: null,
      });
    });

    it('is the bot’s surface for an order the bot created', async () => {
      const orderId = await order('NEW_SERVICE');
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'TELEGRAM',
      });
      expect((await facts.orderOrigin(tenantA, orderId, TX))?.surface).toBe('TELEGRAM');
    });

    it('names the administrator who created the order from the Web Admin, with the label captured then', async () => {
      const orderId = await order('NEW_SERVICE');
      const adminId = uuid();
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'WEB',
        actorType: 'WEB_ADMIN',
        actorId: adminId,
        label: 'مدیر آزمایشی',
      });
      expect(await facts.orderOrigin(tenantA, orderId, TX)).toEqual({
        surface: 'WEB',
        actorType: 'WEB_ADMIN',
        actorId: adminId,
        actorLabel: 'مدیر آزمایشی',
      });
    });

    it('answers a non-uuid actor id as no id at all, never as a query error', async () => {
      const orderId = await order('NEW_SERVICE');
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'WEB',
        actorType: 'WEB_ADMIN',
        actorId: 'not-a-uuid',
      });
      expect((await facts.orderOrigin(tenantA, orderId, TX))?.actorId).toBeNull();
    });

    it('takes the FIRST creating row, ignores a refused attempt and an unrelated action, and another tenant’s row', async () => {
      const orderId = await order('NEW_SERVICE');
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'WEB',
        result: 'DENIED',
        minutes: -5,
      });
      await audit({
        action: 'order.discount_code',
        entityType: 'Order',
        entityId: orderId,
        surface: 'WEB',
        minutes: -4,
      });
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'WEB',
        tenantId: String(tenantB.tenantId),
        minutes: -3,
      });
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'MINI_APP',
        minutes: 1,
      });
      await audit({
        action: 'order.draft_create',
        entityType: 'Order',
        entityId: orderId,
        surface: 'TELEGRAM',
        minutes: 2,
      });
      expect((await facts.orderOrigin(tenantA, orderId, TX))?.surface).toBe('MINI_APP');
    });

    it('is null for an order nobody audited', async () => {
      expect(await facts.orderOrigin(tenantA, await order('NEW_SERVICE'), TX)).toBeNull();
    });

    it('reads a renewal, extra traffic and extra time from the service row that names the order', async () => {
      const base = await order('NEW_SERVICE');
      const svc = await service(base);
      for (const [purpose, action, surface] of [
        ['RENEW', 'service.renew_draft', 'MINI_APP'],
        ['ADD_TRAFFIC', 'service.add_traffic_draft', 'TELEGRAM'],
        ['ADD_TIME', 'service.add_time_draft', 'MINI_APP'],
      ] as const) {
        const orderId = await order(purpose);
        await commercialAction(svc, orderId, purpose);
        await audit({
          action,
          entityType: 'Service',
          entityId: svc,
          surface,
          after: { orderId, kind: purpose },
        });
        expect((await facts.orderOrigin(tenantA, orderId, TX))?.surface, purpose).toBe(surface);
      }
    });

    it('does not borrow the surface of ANOTHER order of the same service', async () => {
      const svc = await service(await order('NEW_SERVICE'));
      const miniOrder = await order('RENEW');
      const botOrder = await order('RENEW');
      await commercialAction(svc, miniOrder, 'RENEW');
      await commercialAction(svc, botOrder, 'RENEW');
      await audit({
        action: 'service.renew_draft',
        entityType: 'Service',
        entityId: svc,
        surface: 'MINI_APP',
        after: { orderId: miniOrder },
      });
      await audit({
        action: 'service.renew_draft',
        entityType: 'Service',
        entityId: svc,
        surface: 'TELEGRAM',
        after: { orderId: botOrder },
        minutes: 1,
      });
      expect((await facts.orderOrigin(tenantA, miniOrder, TX))?.surface).toBe('MINI_APP');
      expect((await facts.orderOrigin(tenantA, botOrder, TX))?.surface).toBe('TELEGRAM');
    });
  });

  describe('a ticket’s message', () => {
    async function ticketWithMessage(): Promise<{ ticket: string; message: string }> {
      const category = uuid();
      const ticket = uuid();
      const message = uuid();
      n += 1;
      await run(
        sql`INSERT INTO ticket_categories (id, tenant_id, title) VALUES (${category}, ${tenantA.tenantId}, 'General')`,
      );
      await run(sql`INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id, category_title,
          status, opening_key)
        VALUES (${ticket}, ${tenantA.tenantId}, ${customer}, ${SEED_IDS.botA1}, ${category}, 'General', 'OPEN',
          ${`c2-open-${String(n)}`})`);
      await run(sql`INSERT INTO ticket_messages (id, tenant_id, ticket_id, sender_type, body, idempotency_key, request_hash)
        VALUES (${message}, ${tenantA.tenantId}, ${ticket}, 'CUSTOMER', 'سلام', ${`c2-msg-${String(n)}`}, 'h')`);
      return { ticket, message };
    }

    it('reads the surface of the audit row written with the message that OPENED the ticket', async () => {
      const { ticket, message } = await ticketWithMessage();
      await audit({
        action: 'ticket.open',
        entityType: 'Ticket',
        entityId: ticket,
        surface: 'MINI_APP',
        after: { messageId: message },
      });
      expect((await facts.ticket(tenantA, ticket, message, TX))?.surface).toBe('MINI_APP');
    });

    it('reads it for a reply, and tells two messages of one ticket apart', async () => {
      const { ticket, message } = await ticketWithMessage();
      const reply = uuid();
      await run(sql`INSERT INTO ticket_messages (id, tenant_id, ticket_id, sender_type, body, idempotency_key, request_hash)
        VALUES (${reply}, ${tenantA.tenantId}, ${ticket}, 'CUSTOMER', 'باز هم سلام', 'c2-reply', 'h2')`);
      await audit({
        action: 'ticket.open',
        entityType: 'Ticket',
        entityId: ticket,
        surface: 'TELEGRAM',
        after: { messageId: message },
      });
      await audit({
        action: 'ticket.customer_message',
        entityType: 'Ticket',
        entityId: ticket,
        surface: 'MINI_APP',
        after: { messageId: reply },
        minutes: 5,
      });
      expect((await facts.ticket(tenantA, ticket, message, TX))?.surface).toBe('TELEGRAM');
      expect((await facts.ticket(tenantA, ticket, reply, TX))?.surface).toBe('MINI_APP');
    });

    it('is null when no audit row is recorded, and an administrator’s reply row is not a customer’s message', async () => {
      const { ticket, message } = await ticketWithMessage();
      expect((await facts.ticket(tenantA, ticket, message, TX))?.surface).toBeNull();
      await audit({
        action: 'ticket.reply',
        entityType: 'Ticket',
        entityId: ticket,
        surface: 'MINI_APP',
        after: { messageId: message },
      });
      expect((await facts.ticket(tenantA, ticket, message, TX))?.surface).toBeNull();
    });
  });
});
