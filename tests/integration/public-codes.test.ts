import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyListSearch,
  PUBLIC_CODE_PATTERN,
  type ActorContext,
  type ListSearchTerm,
} from '@nexa/contracts';
import { backfillPublicCodes } from '../../apps/api/src/infrastructure/persistence/public-code-backfill';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Round 4, PR-C: short public codes, against the real database — the insert trigger, its
 * collision retry, the write-once guard, the per-tenant product numbers, the post-migration
 * backfill (resumable and idempotent), and every list search that takes a code.
 */
describe('short public codes', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let a: AudienceFixtures;
  let b: AudienceFixtures;
  let category: string;
  let n = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-codes', roleKeys: ['owner'] }),
    );
    a = new AudienceFixtures(ctx, tenantA.tenantId as string);
    b = new AudienceFixtures(ctx, tenantB.tenantId as string);
    category = ctx.container.ids.uuid();
    await q(`INSERT INTO ticket_categories (id, tenant_id, title) VALUES ($1, $2, 'General')`, [
      category,
      tenantA.tenantId,
    ]);
  });

  async function q<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return ctx.container.database.withClient(
      async (client) => (await client.query(text, values)).rows as T[],
    );
  }

  async function codeOf(table: string, id: string): Promise<string | null> {
    const [row] = await q<{ code: string | null }>(`SELECT code FROM ${table} WHERE id = $1`, [id]);
    return row?.code ?? null;
  }

  async function payment(customerId: string, orderId: string | null = null): Promise<string> {
    n += 1;
    const id = ctx.container.ids.uuid();
    await q(
      `INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                             reference, expires_at)
         VALUES ($1, $2, $3, $4, 'PENDING', 'MANUAL_TRANSFER', 50000, 'IRT', $5,
                 now() + interval '1 hour')`,
      [id, tenantA.tenantId, customerId, orderId, `pc-ref-${n}:manual`],
    );
    return id;
  }

  async function ticket(customerId: string): Promise<string> {
    n += 1;
    const id = ctx.container.ids.uuid();
    await q(
      `INSERT INTO tickets (id, tenant_id, customer_id, bot_instance_id, category_id,
                            category_title, status, opening_key)
         VALUES ($1, $2, $3, $4, $5, 'General', 'OPEN', $6)`,
      [id, tenantA.tenantId, customerId, SEED_IDS.botA1, category, `pc-open-${n}`],
    );
    return id;
  }

  /** A quote document the order read path accepts, for the suites that list orders. */
  const quoteFor = (productId: string) =>
    JSON.stringify({
      productId,
      quotedAt: '2026-01-01T00:00:00.000Z',
      currency: 'IRT',
      finalAmount: { amountMinor: '250000', currency: 'IRT' },
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'list price',
          amountBefore: { amountMinor: '250000', currency: 'IRT' },
          amountAfter: { amountMinor: '250000', currency: 'IRT' },
        },
      ],
    });

  async function world() {
    const panelId = await a.panel();
    const customerId = await a.customer({ telegramUserId: `70${++n}` });
    const productId = await a.product(panelId);
    const serviceId = await a.service({
      customerId,
      panelId,
      productId,
      quote: quoteFor(productId),
    });
    const [svc] = await q<{ order_id: string; product_id: string }>(
      `SELECT order_id, product_id FROM services WHERE id = $1`,
      [serviceId],
    );
    const orderId = svc!.order_id;
    const paymentId = await payment(customerId, orderId);
    const ticketId = await ticket(customerId);
    return {
      panelId,
      customerId,
      serviceId,
      orderId,
      productId: svc!.product_id,
      paymentId,
      ticketId,
    };
  }

  it('the database codes every insert, from every writer, in the format', async () => {
    const w = await world();
    for (const [table, id] of [
      ['orders', w.orderId],
      ['services', w.serviceId],
      ['payments', w.paymentId],
      ['tickets', w.ticketId],
    ] as const) {
      const code = await codeOf(table, id);
      expect(code, table).not.toBeNull();
      expect(PUBLIC_CODE_PATTERN.test(code!), `${table}: ${code}`).toBe(true);
    }
  });

  it('a product is numbered per tenant from P-101', async () => {
    const panelA = await a.panel();
    const first = await a.product(panelA, 'one');
    const second = await a.product(panelA, 'two');
    const panelB = await b.panel();
    const otherTenant = await b.product(panelB, 'one');
    const numbers = await q<{ id: string; code_number: number }>(
      `SELECT id, code_number FROM products WHERE id = ANY($1::uuid[])`,
      [[first, second, otherTenant]],
    );
    const byId = new Map(numbers.map((row) => [row.id, row.code_number]));
    expect(byId.get(first)).toBe(101);
    expect(byId.get(second)).toBe(102);
    expect(byId.get(otherTenant)).toBe(101);
  });

  /** A copy of an order, as a DRAFT, carrying `code` (null: let the trigger draw). */
  async function copyOrder(
    run: (text: string, values: unknown[]) => Promise<{ code: string }[]>,
    sourceOrderId: string,
    code: string | null,
  ): Promise<string> {
    const [row] = await run(
      `INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
         line_title, line_duration_days, line_traffic_bytes, line_unit_price_amount,
         line_quantity, subtotal_amount, discount_amount, total_amount, currency, quote, code)
       SELECT $1, tenant_id, customer_id, 'DRAFT', purpose, product_id, panel_id, line_title,
              line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
              subtotal_amount, discount_amount, total_amount, currency, '{}'::jsonb, $2
         FROM orders WHERE id = $3
       RETURNING code`,
      [ctx.container.ids.uuid(), code, sourceOrderId],
    );
    return row!.code;
  }

  it('a product created before the backfill never takes a number ahead of the older catalogue', async () => {
    const panelA = await a.panel();
    // Two products from before 0262: written with no number.
    await q(`ALTER TABLE products DISABLE TRIGGER nexa_products_code_number`);
    let older: string[];
    try {
      older = [await a.product(panelA, 'old one'), await a.product(panelA, 'old two')];
    } finally {
      await q(`ALTER TABLE products ENABLE TRIGGER nexa_products_code_number`);
    }
    // A product created between the migration and the backfill (Codex review of #299).
    const fresh = await a.product(panelA, 'new');
    const numbers = await q<{ id: string; code_number: number }>(
      `SELECT id, code_number FROM products WHERE id = ANY($1::uuid[])`,
      [[...older, fresh]],
    );
    const byId = new Map(numbers.map((row) => [row.id, row.code_number]));
    expect(byId.get(older[0]!)).toBe(101);
    expect(byId.get(older[1]!)).toBe(102);
    expect(byId.get(fresh)).toBe(103);
    // And the backfill, arriving afterwards, has nothing left to number.
    const reports = await backfillPublicCodes(ctx.container.database);
    expect(reports.find((report) => report.table === 'products')?.filled).toBe(0);
  });

  it('a code is unique per tenant and table, and only that', async () => {
    const w = await world();
    const code = (await codeOf('orders', w.orderId))!;
    // Another tenant may hold the same code for its own order …
    const panelB = await b.panel();
    const customerB = await b.customer({ telegramUserId: '7999' });
    const orderB = await b.order({ customerId: customerB, panelId: panelB });
    expect(await copyOrder(q, orderB, code)).toBe(code);
    // … and another table of the same tenant may too …
    await q(`ALTER TABLE tickets DISABLE TRIGGER nexa_tickets_public_code_frozen`);
    try {
      await q(`UPDATE tickets SET code = $1 WHERE id = $2`, [code, w.ticketId]);
    } finally {
      await q(`ALTER TABLE tickets ENABLE TRIGGER nexa_tickets_public_code_frozen`);
    }
    // … but the same tenant and table may not: the unique key refuses the second holder.
    await expect(copyOrder(q, w.orderId, code)).rejects.toMatchObject({
      code: '23505',
      constraint: 'orders_tenant_code_key',
    });
  });

  it('a collision at insert is drawn again, not refused and not duplicated', async () => {
    const w = await world();
    const seed = 0.4242;
    await ctx.container.database.withClient(async (client) => {
      // `setseed` makes this session's `random()` repeatable: these are the first two draws.
      await client.query('SELECT setseed($1)', [seed]);
      const draws = await client.query<{ first: string; second: string }>(
        'SELECT nexa_public_code() AS first, nexa_public_code() AS second',
      );
      const { first, second } = draws.rows[0]!;
      expect(first).not.toBe(second);
      const run = async (text: string, values: unknown[]) =>
        (await client.query<{ code: string }>(text, values)).rows;
      // Another order of the tenant already holds the first draw.
      expect(await copyOrder(run, w.orderId, first)).toBe(first);
      await client.query('SELECT setseed($1)', [seed]);
      // The trigger draws `first`, finds it taken, and draws again.
      expect(await copyOrder(run, w.orderId, null)).toBe(second);
    });
  });

  it('a code, once written, never changes and is never cleared', async () => {
    const w = await world();
    await expect(
      q(`UPDATE orders SET code = 'ZZZZZZZZ' WHERE id = $1`, [w.orderId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      q(`UPDATE payments SET code = NULL WHERE id = $1`, [w.paymentId]),
    ).rejects.toMatchObject({
      code: '23001',
    });
    await expect(
      q(`UPDATE products SET code_number = 999 WHERE id = $1`, [w.productId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  describe('the backfill of rows from before 0262', () => {
    const TRIGGERS = [
      ['orders', 'nexa_orders_public_code'],
      ['services', 'nexa_services_public_code'],
      ['payments', 'nexa_payments_public_code'],
      ['tickets', 'nexa_tickets_public_code'],
      ['products', 'nexa_products_code_number'],
    ] as const;

    /** Rows written as the release before 0263 wrote them: with no code. */
    async function withoutCodes<T>(write: () => Promise<T>): Promise<T> {
      for (const [table, trigger] of TRIGGERS) {
        await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      }
      try {
        return await write();
      } finally {
        for (const [table, trigger] of TRIGGERS) {
          await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
      }
    }

    async function snapshot() {
      const rows = await q<{ t: string; id: string; code: string | null }>(
        `SELECT 'orders' t, id, code FROM orders UNION ALL
         SELECT 'services', id, code FROM services UNION ALL
         SELECT 'payments', id, code FROM payments UNION ALL
         SELECT 'tickets', id, code FROM tickets UNION ALL
         SELECT 'products', id, code_number::text FROM products`,
      );
      return new Map(rows.map((row) => [`${row.t}:${row.id}`, row.code]));
    }

    it('fills every row in keyset batches, resumes after an interruption, and redraws nothing', async () => {
      // One row coded the ordinary way first: the backfill must never touch it.
      const coded = await world();
      const before = await snapshot();
      await withoutCodes(async () => {
        await world();
        await world();
        await world();
      });
      const missing = [...(await snapshot()).values()].filter((code) => code === null).length;
      expect(missing).toBeGreaterThanOrEqual(15);
      const outbox = await q<{ count: string }>(`SELECT count(*) FROM outbox_messages`);
      const audit = await q<{ count: string }>(`SELECT count(*) FROM audit_logs`);

      // Interrupted: three batches of two, then the process "dies".
      const partial = await backfillPublicCodes(ctx.container.database, {
        batchSize: 2,
        maxBatches: 3,
      });
      // orders: 2, then 1, then an empty batch that says the table is done — and the budget is
      // spent before services begin.
      expect(partial.map((report) => [report.table, report.filled, report.complete])).toEqual([
        ['orders', 3, true],
        ['payments', 0, false],
        ['services', 0, false],
        ['tickets', 0, false],
        ['products', 0, false],
      ]);
      const halfway = await snapshot();
      const filledHalfway = [...halfway.values()].filter((code) => code !== null).length;
      expect(filledHalfway).toBe(before.size + 3);

      // Resumed from nothing but the rows themselves.
      const resumed = await backfillPublicCodes(ctx.container.database, { batchSize: 2 });
      expect(resumed.every((report) => report.complete)).toBe(true);
      const after = await snapshot();
      for (const [key, code] of after) {
        expect(code, key).not.toBeNull();
        if (!key.startsWith('products:')) expect(PUBLIC_CODE_PATTERN.test(code!), key).toBe(true);
      }
      // Idempotent: every code written before, by the trigger or the first run, is unchanged.
      for (const [key, code] of halfway) if (code !== null) expect(after.get(key), key).toBe(code);
      expect(after.get(`orders:${coded.orderId}`)).toBe(before.get(`orders:${coded.orderId}`));
      // Per tenant and table, no code twice.
      for (const table of ['orders', 'services', 'payments', 'tickets']) {
        const codes = [...after].filter(([key]) => key.startsWith(`${table}:`)).map(([, c]) => c);
        expect(new Set(codes).size, table).toBe(codes.length);
      }
      // Products continue the tenant's numbering after the one P-101 the trigger gave out.
      const numbers = [...after]
        .filter(([key]) => key.startsWith('products:'))
        .map(([, c]) => Number(c))
        .sort((x, y) => x - y);
      expect(numbers).toEqual([101, 102, 103, 104]);

      // A third run has nothing to do, and no run wrote an event or an audit row.
      const again = await backfillPublicCodes(ctx.container.database);
      expect(again.every((report) => report.complete && report.filled === 0)).toBe(true);
      expect(await snapshot()).toEqual(after);
      expect(await q(`SELECT count(*) FROM outbox_messages`)).toEqual(outbox);
      expect(await q(`SELECT count(*) FROM audit_logs`)).toEqual(audit);
    });
  });

  describe('every list search takes a code', () => {
    const term = (raw: string): ListSearchTerm => classifyListSearch(raw)!;

    it('orders, services, payments and tickets by their own code, typed in any case', async () => {
      const w = await world();
      await world(); // a neighbour that must not match
      const orderCode = (await codeOf('orders', w.orderId))!;
      const serviceCode = (await codeOf('services', w.serviceId))!;
      const paymentCode = (await codeOf('payments', w.paymentId))!;
      const ticketCode = (await codeOf('tickets', w.ticketId))!;

      const orders = await ctx.container.orders.list(tenantA, owner, {
        search: { text: term(` ${orderCode.toLowerCase()} `) },
      });
      expect(orders.items.map((row) => row.id)).toEqual([w.orderId]);

      const services = await ctx.container.serviceAdmin.list(tenantA, owner, {
        search: { text: term(serviceCode) },
      });
      expect(services.items.map((row) => row.id)).toEqual([w.serviceId]);

      const payments = await ctx.container.payments.list(tenantA, owner, {
        search: { text: term(paymentCode) },
      });
      expect(payments.items.map((row) => row.id)).toEqual([w.paymentId]);

      const tickets = await ctx.container.tickets.list(tenantA, owner, {
        customer: ticketCode,
        limit: 10,
      });
      expect(tickets.map((item) => item.ticket.id)).toEqual([w.ticketId]);
    });

    it('a service and its payments by the code of their ORDER', async () => {
      const w = await world();
      await world();
      const orderCode = (await codeOf('orders', w.orderId))!;
      const services = await ctx.container.serviceAdmin.list(tenantA, owner, {
        search: { text: term(orderCode) },
      });
      expect(services.items.map((row) => row.id)).toEqual([w.serviceId]);
      const payments = await ctx.container.payments.list(tenantA, owner, {
        search: { text: term(orderCode) },
      });
      expect(payments.items.map((row) => row.id)).toEqual([w.paymentId]);
    });

    it('an all-digit code, which the box classifies as a Telegram id, still finds its order', async () => {
      const w = await world();
      await q(`ALTER TABLE orders DISABLE TRIGGER nexa_orders_public_code_frozen`);
      try {
        await q(`UPDATE orders SET code = '23456789' WHERE id = $1`, [w.orderId]);
      } finally {
        await q(`ALTER TABLE orders ENABLE TRIGGER nexa_orders_public_code_frozen`);
      }
      expect(term('23456789').kind).toBe('TELEGRAM_ID');
      const orders = await ctx.container.orders.list(tenantA, owner, {
        search: { text: term('23456789') },
      });
      expect(orders.items.map((row) => row.id)).toEqual([w.orderId]);
    });

    it('a product by P-number, and a code of another tenant finds nothing', async () => {
      const panelA = await a.panel();
      const productId = await a.product(panelA, 'Premium');
      await a.product(panelA, 'Basic');
      const products = await ctx.container.products.list(tenantA, owner, {
        search: { titlePrefix: 'P-101' },
      });
      expect(products.items.map((row) => row.id)).toEqual([productId]);

      const panelB = await b.panel();
      const customerB = await b.customer({ telegramUserId: '7998' });
      const orderB = await b.order({ customerId: customerB, panelId: panelB });
      const foreign = (await codeOf('orders', orderB))!;
      const orders = await ctx.container.orders.list(tenantA, owner, {
        search: { text: term(foreign) },
      });
      expect(orders.items).toEqual([]);
    });
  });
});
