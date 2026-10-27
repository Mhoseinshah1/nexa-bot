import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * R11 A7 — `OpsLogFacts.serviceUsernameOfOrder`, against the real SQL: the panel account name of
 * the service an order is TIED to, which every service-related operations-log message prints as
 * «👤 نام کاربری سرویس».
 *
 * MUTATIONS (each applied, the named test red, reverted, green):
 *  - the `services.order_id` branch removed -> "the service an order created";
 *  - the `service_commercial_actions` branch removed -> "a renewal …";
 *  - the `provisioning_operations` branch removed -> "an order only an operation names";
 *  - `funded_at IS NOT NULL` removed from the reservation branch -> "an unfunded reservation …";
 *  - the `tenant_id` predicate removed from one branch -> "another tenant …".
 */
describe('serviceUsernameOfOrder — which service an order is tied to', () => {
  let ctx: TestContext;
  let facts: DrizzleOpsLogFacts;
  let n = 0;
  const uuid = (): string => ctx.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const NOW = '2026-10-12T09:30:00Z';
  let panelId = '';
  let productId = '';
  let customerId = '';

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    panelId = uuid();
    productId = uuid();
    customerId = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'پنل ۱', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productId}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 100000, 'IRT')`);
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${customerId}, ${tenantA.tenantId}, '790001', 'Customer', ${NOW}::timestamptz, ${NOW}::timestamptz)`);
  });

  async function order(
    purpose: 'NEW_SERVICE' | 'RENEW' | 'TRIAL',
    source = 'NEXA',
  ): Promise<string> {
    const id = uuid();
    // A trial is free (`orders_trial_is_free_check`).
    const price = purpose === 'TRIAL' ? 0 : 1000;
    n += 1;
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at, source, source_ref, origin)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, 'PAID', ${purpose}, ${productId}, ${panelId},
        'Plan', 30, 1073741824, 1, ${price}, 'دسته', ${price}, 0, ${price}, 'IRT', '{}'::jsonb,
        ${NOW}::timestamptz, ${NOW}::timestamptz, ${NOW}::timestamptz, ${source},
        ${source === 'NEXA' ? null : `legacy-${String(n)}`}, 'STANDARD')`);
    return id;
  }

  async function service(orderId: string, username: string, source = 'NEXA'): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id, state,
        provider_username, traffic_limit_bytes, provisioned_at, expires_at, created_at, source, source_ref)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId}, ${panelId}, ${productId}, 'ACTIVE',
        ${username}, 1073741824, ${NOW}::timestamptz, ${NOW}::timestamptz, ${NOW}::timestamptz,
        ${source}, ${source === 'NEXA' ? null : `legacy-svc-${String(n)}`})`);
    return id;
  }

  async function reservation(orderId: string, username: string, funded: boolean): Promise<void> {
    await run(sql`INSERT INTO service_username_reservations (id, tenant_id, namespace_key, username,
        panel_id, order_id, customer_id, mode, funded_at, expires_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, 'sanaei:a.example.test', ${username}, ${panelId}, ${orderId},
        ${customerId}, 'AUTOMATIC', ${funded ? NOW : null}::timestamptz, ${NOW}::timestamptz)`);
  }

  const of = (orderId: string, scope = tenantA) =>
    ctx.container.uow.run(scope, (tx) => facts.serviceUsernameOfOrder(scope, orderId, tx as never));

  it('the service an order created: its stored panel account — an imported MIRZA service too', async () => {
    const created = await order('NEW_SERVICE');
    await service(created, 'nx7k2m9q');
    expect(await of(created)).toBe('nx7k2m9q');

    const imported = await order('NEW_SERVICE', 'MIRZA');
    await service(imported, 'mirza_user_7', 'MIRZA');
    expect(await of(imported)).toBe('mirza_user_7');
  });

  it('a trial order names the trial service', async () => {
    const trial = await order('TRIAL');
    await service(trial, 'nxtrial01');
    expect(await of(trial)).toBe('nxtrial01');
  });

  it('a renewal (or add-on) order names the service it acted on, not a service of its own', async () => {
    const created = await order('NEW_SERVICE');
    const serviceId = await service(created, 'nx7k2m9q');
    const renewal = await order('RENEW');
    await run(sql`INSERT INTO service_commercial_actions (id, tenant_id, customer_id, service_id, order_id,
        kind, product_id, amount, currency)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${customerId}, ${serviceId}, ${renewal}, 'RENEW',
        ${productId}, 1000, 'IRT')`);
    expect(await of(renewal)).toBe('nx7k2m9q');
  });

  it('an order only an operation names: the operation’s service', async () => {
    const created = await order('NEW_SERVICE');
    const serviceId = await service(created, 'nx7k2m9q');
    const other = await order('RENEW');
    await run(sql`INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id, panel_id,
        type, order_id, target_expires_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, '0123456789abcdef', ${serviceId}, ${panelId}, 'RENEW',
        ${other}, ${NOW}::timestamptz)`);
    expect(await of(other)).toBe('nx7k2m9q');
  });

  it('a purchase paid but not yet built: the name its FUNDED reservation holds', async () => {
    const pending = await order('NEW_SERVICE');
    await reservation(pending, 'nx_reserved', true);
    expect(await of(pending)).toBe('nx_reserved');
  });

  it('an unfunded reservation is never read: a payment that failed or expired names no service', async () => {
    const unpaid = await order('NEW_SERVICE');
    await reservation(unpaid, 'nx_unpaid', false);
    expect(await of(unpaid)).toBeNull();
  });

  it('an order tied to nothing (a top-up has none) answers null', async () => {
    expect(await of(await order('NEW_SERVICE'))).toBeNull();
    expect(await of(uuid())).toBeNull();
  });

  it('another tenant cannot read it', async () => {
    const created = await order('NEW_SERVICE');
    await service(created, 'nx7k2m9q');
    expect(await of(created, tenantB)).toBeNull();
  });
});
