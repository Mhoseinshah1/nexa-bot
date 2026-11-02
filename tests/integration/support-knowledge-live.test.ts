import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { formatMoney } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../../apps/api/src/modules/control/support-ai/domain/output-policy';
import { livePriceFamily } from '../../apps/api/src/modules/control/support-ai/domain/price-family';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Phase 4 PR-2 item 1 — the support AI's live catalogue quotes what the INVOICE will charge.
 *
 * Real PostgreSQL. Every case compares the price the support context carries for a plan with the
 * total of the draft order the same customer's checkout opens for that plan
 * (`OrderService.createDraft`, priced by `PricingService.price`): equal for a customer with a
 * personal discount, with an automatic promotion that wins, with both, and for an unlinked
 * conversation (the list price). Building the context creates no order, no quote and no row.
 */

const BOT = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT };
const LIST = 150_000n;
const USER = 962_201;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('PR-2: the live catalogue quotes the checkout’s price', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let customer: UserId;
  let productId: ProductId;
  let n = 0;
  const key = (label: string) => `sai2-${label}-${String((n += 1))}-${String(Date.now())}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    const c = ctx.container;
    c.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner-sai2', roleKeys: ['owner'] }),
    );
    const panelId = c.ids.uuid();
    await c.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel S', 'sanaei', 'https://s.example.test', 'ACTIVE')`);
    await makePanelSellable(c, tenantA, panelId);
    const products = new DrizzleProductRepository(c.database.db);
    const created = await products.create(tenantA, {
      id: c.ids.uuid() as ProductId,
      draft: {
        title: 'یک‌ماهه ۵۰ گیگ',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(LIST, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: c.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', c.clock.now());
    productId = created.id;
    const { customer: record } = await c.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${String(USER)}`),
      {
        idempotencyKey: `resolve-${String(USER)}`,
        telegramUserId: String(USER),
        from: { id: USER, first_name: 'سارا' },
        botInstanceId: BOT,
      },
    );
    customer = record.id;
  });

  async function setPersonalDiscount(percent: number) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'personal_discount');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'personal_discount',
      enabled: true,
      expectedVersion: current.version,
      idempotencyKey: key('flag'),
      reason: 'PR-2 parity test',
    });
    await ctx.container.customerControls.setPersonalDiscount(tenantA, owner, {
      idempotencyKey: key('percent'),
      customerId: customer,
      percent,
      reason: 'مشتری وفادار',
    });
  }

  async function automaticRule(percent: bigint) {
    const created = await ctx.container.discounts.create(tenantA, owner, {
      idempotencyKey: key('rule'),
      write: {
        kind: 'AUTOMATIC',
        code: null,
        label: 'حراج',
        type: 'PERCENTAGE',
        value: percent,
        currency: null,
        appliesTo: ['NEW_SERVICE', 'RENEW'],
        productId: null,
        categoryId: null,
        customerId: null,
        firstPurchaseOnly: false,
        minimumSubtotal: null,
        startsAt: null,
        endsAt: null,
        totalLimit: null,
        perCustomerLimit: null,
        priority: 0,
        stackable: false,
      },
    });
    await ctx.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key('activate'),
      discountId: created.rule.id,
    });
  }

  const orderCount = async () =>
    (
      (
        await ctx.container.database.db.execute(
          sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantA.tenantId}`,
        )
      ).rows[0] as { n: number }
    ).n;

  /** The catalogue's C1 price for `who`, and the draft total the checkout charges. */
  async function quotedAndInvoiced(who: UserId | null) {
    const before = await orderCount();
    const { payload } = await ctx.container.supportContext.build(tenantA, who);
    // A read: building the context drafted, quoted and stored nothing.
    expect(await orderCount()).toBe(before);
    const plan = payload.catalogue.find((entry) => entry.title === 'یک‌ماهه ۵۰ گیگ');
    expect(plan).toBeDefined();
    if (who === null) return { plan: plan!, invoice: null, payload };
    const draft = await ctx.container.orders.createDraft(viaBot, customerActor(key('draft')), {
      idempotencyKey: key('draft'),
      customerId: who,
      productId,
    });
    return { plan: plan!, invoice: draft.totals.total, payload };
  }

  it('a customer with a personal discount: the quoted price IS the invoice’s', async () => {
    await setPersonalDiscount(20);
    const { plan, invoice, payload } = await quotedAndInvoiced(customer);
    expect(invoice).toEqual(money(120_000n, 'IRT'));
    expect(plan.price).toEqual({
      amountMinor: invoice!.amountMinor.toString(),
      currency: 'IRT',
      formatted: formatMoney(invoice!),
    });
    expect(plan.personalDiscountPercent).toBe(20);
    expect(plan.duration).toBe('30 روز');
    expect(plan.traffic).toBe('50 گیگابایت');
    // The output validator lets the reply quote that price, and only that price.
    const allowance = outputPolicyAllowanceFromContext(JSON.stringify(payload), {
      priceFamily: livePriceFamily(payload),
    });
    const now = ctx.container.clock.now();
    expect(
      checkOutputPolicy(`قیمت برای شما ${formatMoney(invoice!)} است.`, allowance, now),
    ).toEqual({ ok: true });
    expect(checkOutputPolicy('قیمت برای شما 150,000 تومان است.', allowance, now)).toEqual({
      ok: false,
      violation: 'number',
    });
  });

  it('an automatic promotion that wins is quoted too (the bot’s plan list does not show it)', async () => {
    await automaticRule(30n);
    const { plan, invoice } = await quotedAndInvoiced(customer);
    expect(invoice).toEqual(money(105_000n, 'IRT'));
    expect(plan.price.amountMinor).toBe(invoice!.amountMinor.toString());
    expect(plan.personalDiscountPercent).toBeNull();
  });

  it('personal discount and a smaller promotion: the larger single discount, as the invoice', async () => {
    await setPersonalDiscount(25);
    await automaticRule(10n);
    const { plan, invoice } = await quotedAndInvoiced(customer);
    expect(invoice).toEqual(money(112_500n, 'IRT'));
    expect(plan.price.amountMinor).toBe(invoice!.amountMinor.toString());
    expect(plan.personalDiscountPercent).toBe(25);
  });

  it('an unlinked conversation sees the list price; no personal discount leaks into it', async () => {
    await setPersonalDiscount(20);
    const { plan } = await quotedAndInvoiced(null);
    expect(plan.price).toEqual({
      amountMinor: LIST.toString(),
      currency: 'IRT',
      formatted: '150,000 تومان',
    });
    expect(plan.personalDiscountPercent).toBeNull();
  });
  it('review of PR #367: a reseller sees only what their tier grants (products, panels, categories)', async () => {
    const c = ctx.container;
    const products = new DrizzleProductRepository(c.database.db);
    const product = (await products.findById(tenantA, productId))!;
    const granted = await products.create(tenantA, {
      id: c.ids.uuid() as ProductId,
      draft: {
        title: 'پلن نمایندگی',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 20,
        panelId: product.panelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: c.clock.now(),
    });
    await products.setStatus(tenantA, granted.id, 'INACTIVE', 'ACTIVE', c.clock.now());
    const tier = await c.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key('tier'),
      write: {
        name: 'Tier PR-2',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 10,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await c.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key('grants'),
      tierId: tier.id,
      grants: [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: granted.id },
        { kind: 'PANEL', subject: null },
        { kind: 'BOT', subject: null },
      ],
    });
    await c.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key('register'),
      customerId: customer,
      write: { tierId: tier.id, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
    });
    const { payload } = await c.supportContext.build(tenantA, customer);
    // The public plan the tier does not grant is not listed; the granted one is, at the
    // reseller's price — what its draft charges.
    expect(payload.catalogue.map((plan) => plan.title)).toEqual(['پلن نمایندگی']);
    const draft = await c.orders.createDraft(viaBot, customerActor(key('draft')), {
      idempotencyKey: key('draft'),
      customerId: customer,
      productId: granted.id,
    });
    expect(payload.catalogue[0]?.price.amountMinor).toBe(draft.totals.total.amountMinor.toString());
  });
});
