import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type CurrencyCode,
  type PanelId,
  type ProductAudience,
  type ProductCategoryId,
  type ProductId,
  type ResellerGrantKind,
  type ResellerOverrideMode,
  type ResellerStatus,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type { DiscountRuleWrite } from '../../apps/api/src/modules/commerce/pricing/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Resellers, end to end at the service boundary (`docs/wp9-reseller-audit.md` R1–R14).
 *
 * Real PostgreSQL, the real container, the real order, pricing, payment and refund
 * services. Each case names the decision it pins. The rules, in short:
 *
 * - a reseller is a customer with an ACTIVE reseller row; a SUSPENDED one, or none, is an
 *   ordinary customer in every respect (R1);
 * - entitlements fail closed per dimension — operation, catalogue, panel, bot (R5, R6);
 * - the tier's percentage, or the reseller's own override, REPLACES the list subtotal and
 *   promotions come off what is left; one of TIER_PRICE / USER_OVERRIDE fires (R3, R4);
 * - confirmation snapshots the terms append-only and refuses a quote whose reseller layer
 *   no longer matches the live terms with RESELLER_TERMS_CHANGED (R9);
 * - credit is an allowance below zero, read under the wallet lock, in its own currency,
 *   for purchases only (R8); a refund is a compensating credit (R10);
 * - every operator write is audited, idempotent and tenant-scoped (R11).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

/** The Telegram surface's scope: a tenant AND the bot the request arrived through. */
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };
const viaBot2: TenantContext = { ...tenantA, botInstanceId: BOT_A2 };

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Grant {
  readonly kind: ResellerGrantKind;
  readonly subject: string | null;
}

/** A null subject is "every subject of this kind". */
const EVERYTHING: readonly Grant[] = [
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: null },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: null },
];

describe('resellers (WP9-B)', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let panelA: string;
  let panelA2: string;
  let panelB: string;
  /** The customer who becomes a reseller in most cases. */
  let resellerCustomer: UserId;
  /** A customer who never becomes one. */
  let ordinary: UserId;
  let n = 0;
  const key = (): string => `reseller-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    panelA2 = ctx.container.ids.uuid();
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelA2}, ${tenantA.tenantId}, 'Panel A2', 'sanaei', 'https://a2.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    await makePanelSellable(ctx.container, tenantA, panelA2);
    await makePanelSellable(ctx.container, tenantB, panelB);
    // The seed leaves bot A2 STOPPED, and a stopped scope refuses work before any reseller
    // rule is asked. Running, it is the "another bot of the same tenant" the BOT dimension
    // needs.
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-reseller',
        roleKeys: ['owner'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-reseller-b',
        roleKeys: ['owner'],
      }),
    );
    resellerCustomer = await customer('940001');
    ordinary = await customer('940002');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(
    telegramUserId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مریم' },
        botInstanceId: bot,
      },
    );
    return record.id;
  }

  async function category(): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, ${`دسته ${id.slice(-4)}`}, 5)`);
    return id;
  }

  async function product(
    price: bigint,
    options: {
      readonly audience?: ProductAudience;
      readonly panelId?: string;
      readonly categoryId?: string;
      readonly scope?: TenantContext;
    } = {},
  ): Promise<ProductId> {
    const scope = options.scope ?? tenantA;
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن فروشنده',
        description: 'یک ماهه',
        audience: options.audience ?? 'EVERYONE',
        sortOrder: 10,
        panelId: (options.panelId ?? panelA) as PanelId,
        categoryId: (options.categoryId ??
          (scope === tenantB ? SEED_IDS.categoryB : SEED_IDS.categoryA)) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function tier(
    options: {
      readonly name?: string;
      readonly percent?: number | null;
      readonly credit?: bigint;
      readonly creditCurrency?: CurrencyCode;
      readonly grants?: readonly Grant[];
    } = {},
  ): Promise<string> {
    const percent = options.percent ?? null;
    const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name: options.name ?? `Tier ${n}`,
        pricingMode: percent === null ? 'LIST_PRICE' : 'PERCENTAGE_DISCOUNT',
        discountPercentage: percent,
        creditLimit: money(options.credit ?? 0n, options.creditCurrency ?? 'IRT'),
      },
    });
    const grants = options.grants ?? EVERYTHING;
    if (grants.length > 0) await grant(created.id, grants);
    return created.id;
  }

  const grant = (tierId: string, grants: readonly Grant[]) =>
    ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key(),
      tierId,
      grants,
    });

  async function setTierPercent(tierId: string, percent: number | null): Promise<void> {
    const current = await ctx.container.resellersAdmin.getTier(tenantA, owner, tierId);
    await ctx.container.resellersAdmin.updateTier(tenantA, owner, {
      idempotencyKey: key(),
      tierId,
      write: {
        name: current.name,
        pricingMode: percent === null ? 'LIST_PRICE' : 'PERCENTAGE_DISCOUNT',
        discountPercentage: percent,
        creditLimit: current.creditLimit,
      },
    });
  }

  async function register(
    customerId: UserId,
    tierId: string,
    override: {
      readonly mode?: ResellerOverrideMode;
      readonly percent?: number | null;
      readonly credit?: bigint | null;
      readonly creditCurrency?: CurrencyCode;
    } = {},
  ) {
    return ctx.container.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      write: {
        tierId,
        pricingMode: override.mode ?? 'TIER',
        discountPercentage: override.percent ?? null,
        creditLimit:
          override.credit === undefined || override.credit === null
            ? null
            : money(override.credit, override.creditCurrency ?? 'IRT'),
      },
    });
  }

  async function setStatus(customerId: UserId, status: ResellerStatus): Promise<void> {
    const current = await ctx.container.resellersAdmin.get(tenantA, owner, customerId);
    await ctx.container.resellersAdmin.update(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      write: {
        tierId: current.tierId,
        status,
        pricingMode: current.pricingMode,
        discountPercentage: current.discountPercentage,
        creditLimit: current.creditLimit,
      },
    });
  }

  const draft = (customerId: UserId, productId: string, scope: TenantContext = viaBot) =>
    ctx.container.orders.createDraft(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId,
    });

  const confirm = (customerId: UserId, orderId: string, scope: TenantContext = viaBot) =>
    ctx.container.orders.confirm(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId,
    });

  async function confirmed(
    customerId: UserId,
    productId: string,
    scope: TenantContext = viaBot,
  ): Promise<OrderRecord> {
    const order = await draft(customerId, productId, scope);
    return confirm(customerId, order.id, scope);
  }

  const settle = (customerId: UserId, orderId: string, scope: TenantContext = viaBot) =>
    ctx.container.payments.settleFromWallet(scope, customerActor(key()), customerId, {
      idempotencyKey: key(),
      orderId,
    });

  const adjust = (customerId: UserId, direction: 'CREDIT' | 'DEBIT', amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction,
      amountMinor,
      currency: 'IRT',
      note: 'آزمون فروشنده',
    });

  async function automaticDiscount(percent: bigint): Promise<string> {
    const write: DiscountRuleWrite = {
      kind: 'AUTOMATIC',
      code: null,
      label: 'حراج',
      type: 'PERCENTAGE',
      value: percent,
      currency: null,
      appliesTo: ['NEW_SERVICE'],
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
    };
    const created = await ctx.container.discounts.create(tenantA, owner, {
      idempotencyKey: key(),
      write,
    });
    await ctx.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: created.rule.id,
    });
    return created.rule.id;
  }

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

  const balance = async (customerId: UserId): Promise<bigint> =>
    BigInt(
      (
        await rows<{ b: string }>(
          sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
                FROM wallet_entries WHERE customer_id = ${customerId} AND currency = 'IRT'`,
        )
      )[0]?.b ?? '0',
    );

  interface TermsRow {
    reseller_customer_id: string;
    tier_id: string;
    tier_name: string;
    layer: string;
    percent: number | null;
    list_amount: string;
    cost_amount: string;
    promotion_amount: string;
    sale_amount: string;
    margin_amount: string;
    currency: string;
    bot_instance_id: string | null;
  }

  const termsRow = async (orderId: string): Promise<TermsRow | undefined> =>
    (
      await rows<TermsRow>(
        sql`SELECT reseller_customer_id, tier_id, tier_name, layer, percent,
                   list_amount::text AS list_amount, cost_amount::text AS cost_amount,
                   promotion_amount::text AS promotion_amount, sale_amount::text AS sale_amount,
                   margin_amount::text AS margin_amount, currency, bot_instance_id
              FROM order_reseller_terms WHERE order_id = ${orderId}`,
      )
    )[0];

  const orderRow = async (orderId: string) =>
    (
      await rows<{ state: string; subtotal: string; discount: string; total: string }>(
        sql`SELECT state, subtotal_amount::text AS subtotal, discount_amount::text AS discount,
                   total_amount::text AS total
              FROM orders WHERE id = ${orderId}`,
      )
    )[0];

  const refusal = (code: string, details?: Record<string, unknown>) =>
    details === undefined ? { code } : { code, details };

  const stepsOf = (order: OrderRecord) =>
    order.totals.quote.trace.map((s) => ({
      step: s.step,
      ruleId: s.ruleId,
      before: s.amountBefore.amountMinor,
      after: s.amountAfter.amountMinor,
    }));

  // -------------------------------------------------------------------------
  // 1. Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('keeps a tier and a reseller of tenant A invisible and unusable from tenant B (R2, R11)', async () => {
      const tierA = await tier({ name: 'Gold', percent: 10 });
      await register(resellerCustomer, tierA);

      // Reads: another tenant's rows are not found, never empty-but-present.
      expect(await ctx.container.resellersAdmin.listTiers(tenantB, ownerB)).toEqual([]);
      expect((await ctx.container.resellersAdmin.list(tenantB, ownerB, {})).items).toEqual([]);
      await expect(
        ctx.container.resellersAdmin.getTier(tenantB, ownerB, tierA),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));
      await expect(
        ctx.container.resellersAdmin.get(tenantB, ownerB, resellerCustomer),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND));

      // Writes: tenant A's customer cannot be registered in tenant B.
      const customerB = await customer('940101', tenantB, BOT_B);
      const tierB = (
        await ctx.container.resellersAdmin.createTier(tenantB, ownerB, {
          idempotencyKey: key(),
          write: {
            name: 'Gold',
            pricingMode: 'LIST_PRICE',
            discountPercentage: null,
            creditLimit: money(0n, 'IRT'),
          },
        })
      ).id;
      await expect(
        ctx.container.resellersAdmin.register(tenantB, ownerB, {
          idempotencyKey: key(),
          customerId: ordinary,
          write: {
            tierId: tierB,
            pricingMode: 'TIER',
            discountPercentage: null,
            creditLimit: null,
          },
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND));

      // A tier id of tenant A cannot be assigned in tenant B, on register or on update.
      await expect(
        ctx.container.resellersAdmin.register(tenantB, ownerB, {
          idempotencyKey: key(),
          customerId: customerB,
          write: {
            tierId: tierA,
            pricingMode: 'TIER',
            discountPercentage: null,
            creditLimit: null,
          },
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));
      await ctx.container.resellersAdmin.register(tenantB, ownerB, {
        idempotencyKey: key(),
        customerId: customerB,
        write: { tierId: tierB, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
      });
      await expect(
        ctx.container.resellersAdmin.update(tenantB, ownerB, {
          idempotencyKey: key(),
          customerId: customerB,
          write: {
            tierId: tierA,
            status: 'ACTIVE',
            pricingMode: 'TIER',
            discountPercentage: null,
            creditLimit: null,
          },
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));

      // Tenant B cannot edit tenant A's tier or its grants.
      await expect(
        ctx.container.resellersAdmin.replaceGrants(tenantB, ownerB, {
          idempotencyKey: key(),
          tierId: tierA,
          grants: [],
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));
      await expect(
        ctx.container.resellersAdmin.updateTier(tenantB, ownerB, {
          idempotencyKey: key(),
          tierId: tierA,
          write: {
            name: 'Stolen',
            pricingMode: 'LIST_PRICE',
            discountPercentage: null,
            creditLimit: money(0n, 'IRT'),
          },
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));

      // And a grant in tenant A cannot name tenant B's product, panel or bot.
      const foreignProduct = await product(10_000n, { scope: tenantB, panelId: panelB });
      for (const foreign of [
        { kind: 'PRODUCT', subject: foreignProduct },
        { kind: 'PANEL', subject: panelB },
        { kind: 'BOT', subject: BOT_B },
        { kind: 'CATEGORY', subject: SEED_IDS.categoryB },
      ] as const) {
        await expect(grant(tierA, [foreign])).rejects.toMatchObject(
          refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID, {
            kind: foreign.kind,
            subject: foreign.subject,
          }),
        );
      }
      // Tenant A's tier is exactly as it was.
      const unchanged = await ctx.container.resellersAdmin.getTier(tenantA, owner, tierA);
      expect(unchanged.name).toBe('Gold');
      expect(unchanged.grants).toHaveLength(EVERYTHING.length);
      // The two tenants' same-named tiers coexist: uniqueness is per tenant.
      expect(
        (await ctx.container.resellersAdmin.listTiers(tenantB, ownerB)).map((t) => t.name),
      ).toEqual(['Gold']);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Deny by default
  // -------------------------------------------------------------------------

  describe('entitlements fail closed, per dimension (R5, R6)', () => {
    it('refuses every draft for a reseller whose tier grants nothing, naming OPERATION', async () => {
      const tierId = await tier({ grants: [] });
      await register(resellerCustomer, tierId);
      const productId = await product(100_000n);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'OPERATION', tierId }),
      );
      expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    });

    it('names each missing dimension in a fixed order: OPERATION, CATALOGUE, PANEL, BOT', async () => {
      const tierId = await tier({ grants: [] });
      await register(resellerCustomer, tierId);
      const productId = await product(100_000n);
      const refused = (dimension: string) =>
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension });

      // A grant of a different operation grants nothing of this one.
      await grant(tierId, [{ kind: 'OPERATION', subject: 'RENEW' }]);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(refused('OPERATION'));

      await grant(tierId, [{ kind: 'OPERATION', subject: 'NEW_SERVICE' }]);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(refused('CATALOGUE'));

      await grant(tierId, [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: productId },
      ]);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(refused('PANEL'));

      // A grant of the other panel is not a grant of this one.
      await grant(tierId, [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: productId },
        { kind: 'PANEL', subject: panelA2 },
      ]);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(refused('PANEL'));

      await grant(tierId, [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: productId },
        { kind: 'PANEL', subject: panelA },
      ]);
      await expect(draft(resellerCustomer, productId)).rejects.toMatchObject(refused('BOT'));

      // Bot A1 granted: a request through bot A2 is refused, and so is one through no bot.
      await grant(tierId, [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: productId },
        { kind: 'PANEL', subject: panelA },
        { kind: 'BOT', subject: BOT_A },
      ]);
      await expect(draft(resellerCustomer, productId, viaBot2)).rejects.toMatchObject(
        refused('BOT'),
      );
      await expect(draft(resellerCustomer, productId, tenantA)).rejects.toMatchObject(
        refused('BOT'),
      );
      expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);

      // Through the granted bot, every dimension holds.
      const order = await draft(resellerCustomer, productId, viaBot);
      expect(order.state).toBe('DRAFT');
    });

    it('grants the catalogue by category as well as by product, and nothing outside it', async () => {
      const other = await category();
      const inGranted = await product(100_000n);
      const outside = await product(100_000n, { categoryId: other });
      const tierId = await tier({
        grants: [
          { kind: 'OPERATION', subject: 'NEW_SERVICE' },
          { kind: 'CATEGORY', subject: SEED_IDS.categoryA },
          { kind: 'PANEL', subject: null },
          { kind: 'BOT', subject: null },
        ],
      });
      await register(resellerCustomer, tierId);
      expect((await draft(resellerCustomer, inGranted)).state).toBe('DRAFT');
      await expect(draft(resellerCustomer, outside)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'CATALOGUE' }),
      );
      // Every bot granted: a request through no bot at all passes too.
      expect((await draft(resellerCustomer, inGranted, tenantA)).state).toBe('DRAFT');
    });

    it('shows a reseller only what their tier grants, through the granted bot only', async () => {
      const granted = await product(100_000n);
      const notGranted = await product(100_000n);
      const onOtherPanel = await product(100_000n, { panelId: panelA2 });
      const resellersOnly = await product(100_000n, { audience: 'RESELLERS_ONLY' });
      const browse = async (scope: TenantContext, customerId: UserId) =>
        (await ctx.container.products.browse(scope, customerActor(key()), 50, customerId)).items
          .map((p) => p.id)
          .sort();

      const tierId = await tier({ grants: [] });
      await register(resellerCustomer, tierId);
      expect(await browse(viaBot, resellerCustomer), 'a tier with no grants shows nothing').toEqual(
        [],
      );

      await grant(tierId, [
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
        { kind: 'PRODUCT', subject: granted },
        { kind: 'PRODUCT', subject: onOtherPanel },
        { kind: 'PRODUCT', subject: resellersOnly },
        { kind: 'PANEL', subject: panelA },
        { kind: 'BOT', subject: BOT_A },
      ]);
      expect(await browse(viaBot, resellerCustomer)).toEqual([granted, resellersOnly].sort());
      expect(await browse(viaBot2, resellerCustomer), 'an ungranted bot shows nothing').toEqual([]);

      // An ordinary customer sees the public catalogue and never a reseller-only product.
      expect(await browse(viaBot, ordinary)).toEqual([granted, notGranted, onOtherPanel].sort());
    });
  });

  // -------------------------------------------------------------------------
  // 3. Inheritance and override
  // -------------------------------------------------------------------------

  describe('pricing inheritance (R3, R4)', () => {
    it('prices a TIER percentage off the list subtotal, rounding the reduction up, as a TIER_PRICE step', async () => {
      const tierId = await tier({ name: 'Silver', percent: 15 });
      await register(resellerCustomer, tierId);
      const order = await draft(resellerCustomer, await product(99_999n));

      // 15% of 99 999 is 14 999.85, rounded UP in the reseller's favour to 15 000.
      expect(order.totals.subtotal.amountMinor).toBe(84_999n);
      expect(order.totals.discount.amountMinor, 'a margin is never a discount').toBe(0n);
      expect(order.totals.total.amountMinor).toBe(84_999n);
      expect(order.line.unitPrice.amountMinor, 'the line keeps the list unit price').toBe(99_999n);
      expect(stepsOf(order)).toEqual([
        expect.objectContaining({ step: 'BASE_PRICE', after: 99_999n }),
        { step: 'TIER_PRICE', ruleId: tierId, before: 99_999n, after: 84_999n },
      ]);
      expect(order.totals.quote.trace[1]?.ruleLabel).toBe('Silver');
    });

    it('lets the reseller’s own percentage REPLACE the tier’s, as a USER_OVERRIDE step on the reseller row', async () => {
      const tierId = await tier({ percent: 15 });
      const reseller = await register(resellerCustomer, tierId, {
        mode: 'PERCENTAGE_DISCOUNT',
        percent: 40,
      });
      const order = await draft(resellerCustomer, await product(100_000n));
      expect(order.totals.subtotal.amountMinor).toBe(60_000n);
      expect(stepsOf(order)).toEqual([
        expect.objectContaining({ step: 'BASE_PRICE' }),
        { step: 'USER_OVERRIDE', ruleId: reseller.id, before: 100_000n, after: 60_000n },
      ]);
      expect(
        stepsOf(order).some((s) => s.step === 'TIER_PRICE'),
        'only one layer fires',
      ).toBe(false);
    });

    it('lets a LIST_PRICE override charge the list even on a discounting tier, with no step', async () => {
      const tierId = await tier({ percent: 15 });
      await register(resellerCustomer, tierId, { mode: 'LIST_PRICE' });
      const order = await confirmed(resellerCustomer, await product(100_000n));
      expect(order.totals.subtotal.amountMinor).toBe(100_000n);
      expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE']);
      expect(await termsRow(order.id)).toMatchObject({
        layer: 'OVERRIDE',
        percent: null,
        list_amount: '100000',
        cost_amount: '100000',
        margin_amount: '0',
      });
    });

    it('applies a promotion to the reseller cost, and the order’s discount is only the promotion', async () => {
      const discountId = await automaticDiscount(10n);
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const order = await confirmed(resellerCustomer, await product(100_000n));

      expect(order.totals.subtotal.amountMinor).toBe(80_000n);
      expect(order.totals.discount.amountMinor).toBe(8_000n);
      expect(order.totals.total.amountMinor).toBe(72_000n);
      expect(stepsOf(order)).toEqual([
        expect.objectContaining({ step: 'BASE_PRICE', after: 100_000n }),
        { step: 'TIER_PRICE', ruleId: tierId, before: 100_000n, after: 80_000n },
        { step: 'PROMOTIONAL_DISCOUNT', ruleId: discountId, before: 80_000n, after: 72_000n },
      ]);
      expect(
        await rows<{ amount: string }>(
          sql`SELECT amount::text AS amount FROM discount_redemptions WHERE order_id = ${order.id}`,
        ),
      ).toEqual([{ amount: '8000' }]);
    });

    it('computes cashback on the final total a reseller pays, never on the list (R13)', async () => {
      await automaticDiscount(10n);
      const rule = await ctx.container.cashbackRules.create(tenantA, owner, {
        idempotencyKey: key(),
        write: {
          label: 'کش‌بک',
          percent: 10,
          appliesTo: ['NEW_SERVICE'],
          productId: null,
          categoryId: null,
          startsAt: null,
          endsAt: null,
        },
      });
      await ctx.container.cashbackRules.activate(tenantA, owner, {
        idempotencyKey: key(),
        ruleId: rule.id,
      });
      await register(resellerCustomer, await tier({ percent: 20 }));
      const order = await confirmed(resellerCustomer, await product(100_000n));
      // 100 000 list → 80 000 reseller cost → 72 000 after the promotion; 10% of THAT.
      expect(order.totals.total.amountMinor).toBe(72_000n);
      expect(order.totals.quote.cashback?.amount.amountMinor).toBe(7_200n);
    });
  });

  // -------------------------------------------------------------------------
  // 4, 5. The purchase snapshot
  // -------------------------------------------------------------------------

  describe('the purchase snapshot (R9)', () => {
    it('writes list, cost, promotion, sale and margin at confirmation, and the pricing read exposes them', async () => {
      await automaticDiscount(10n);
      const tierId = await tier({ name: 'Gold', percent: 20 });
      await register(resellerCustomer, tierId);
      const productId = await product(100_000n);
      const drafted = await draft(resellerCustomer, productId);
      expect(await termsRow(drafted.id), 'a draft carries no terms').toBeUndefined();

      const order = await confirm(resellerCustomer, drafted.id);
      expect(order.state).toBe('AWAITING_PAYMENT');
      expect(await termsRow(order.id)).toEqual({
        reseller_customer_id: resellerCustomer,
        tier_id: tierId,
        tier_name: 'Gold',
        layer: 'TIER',
        percent: 20,
        list_amount: '100000',
        cost_amount: '80000',
        promotion_amount: '8000',
        sale_amount: '72000',
        // list − cost: the reseller's margin, never the promotion.
        margin_amount: '20000',
        currency: 'IRT',
        bot_instance_id: BOT_A,
      });

      const read = await ctx.container.pricingRead.orderPricing(tenantA, owner, order.id);
      expect(read.reseller).toMatchObject({
        orderId: order.id,
        resellerCustomerId: resellerCustomer,
        tierId,
        tierName: 'Gold',
        layer: 'TIER',
        percent: 20,
        listAmount: 100_000n,
        costAmount: 80_000n,
        promotionAmount: 8_000n,
        saleAmount: 72_000n,
        marginAmount: 20_000n,
        currency: 'IRT',
        botInstanceId: BOT_A,
      });
      // An ordinary customer's order has none.
      const plain = await confirmed(ordinary, productId);
      expect(
        (await ctx.container.pricingRead.orderPricing(tenantA, owner, plain.id)).reseller,
      ).toBeNull();
    });

    it('never re-prices a confirmed order when its tier changes afterwards (R2)', async () => {
      const tierId = await tier({ name: 'Gold', percent: 20 });
      await register(resellerCustomer, tierId);
      const order = await confirmed(resellerCustomer, await product(100_000n));
      const terms = await termsRow(order.id);
      const totals = await orderRow(order.id);

      await setTierPercent(tierId, 50);
      await ctx.container.resellersAdmin.updateTier(tenantA, owner, {
        idempotencyKey: key(),
        tierId,
        write: {
          name: 'Platinum',
          pricingMode: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 50,
          creditLimit: money(0n, 'IRT'),
        },
      });

      expect(await termsRow(order.id)).toEqual(terms);
      expect(terms).toMatchObject({ tier_name: 'Gold', percent: 20, cost_amount: '80000' });
      expect(await orderRow(order.id)).toEqual(totals);
      expect(totals).toMatchObject({ subtotal: '80000', total: '80000' });
    });

    it('refuses to confirm a draft whose tier changed since the quote, and writes nothing', async () => {
      await automaticDiscount(10n);
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const productId = await product(100_000n);
      const drafted = await draft(resellerCustomer, productId);

      await setTierPercent(tierId, 30);

      await expect(confirm(resellerCustomer, drafted.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED),
      );
      expect((await orderRow(drafted.id))?.state).toBe('DRAFT');
      expect(await termsRow(drafted.id)).toBeUndefined();
      expect(
        await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`),
        'the promotion was not redeemed either',
      ).toBe(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM panel_capacity_reservations WHERE order_id = ${drafted.id}`,
        ),
        'nor was a capacity slot taken',
      ).toBe(0);

      // Starting again quotes the live terms, and that confirms.
      const again = await confirmed(resellerCustomer, productId);
      expect(again.totals.subtotal.amountMinor).toBe(70_000n);
      expect((await termsRow(again.id))?.percent).toBe(30);
    });

    it('refuses to confirm an ordinary customer’s draft after they became a discounted reseller', async () => {
      const productId = await product(100_000n);
      const drafted = await draft(resellerCustomer, productId);
      expect(drafted.totals.subtotal.amountMinor).toBe(100_000n);
      await register(resellerCustomer, await tier({ percent: 20 }));
      await expect(confirm(resellerCustomer, drafted.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED),
      );
      expect((await orderRow(drafted.id))?.state).toBe('DRAFT');
    });

    it('refuses to confirm when a grant was withdrawn between the draft and the confirmation', async () => {
      const tierId = await tier();
      await register(resellerCustomer, tierId);
      const drafted = await draft(resellerCustomer, await product(100_000n));
      await grant(tierId, [
        { kind: 'OPERATION', subject: null },
        { kind: 'PRODUCT', subject: null },
        { kind: 'PANEL', subject: panelA2 },
        { kind: 'BOT', subject: null },
      ]);
      await expect(confirm(resellerCustomer, drafted.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'PANEL' }),
      );
      expect((await orderRow(drafted.id))?.state).toBe('DRAFT');
      expect(await termsRow(drafted.id)).toBeUndefined();
    });

    it('leaves no confirmed reseller order without its terms (R7)', async () => {
      const tierId = await tier({ percent: 10 });
      await register(resellerCustomer, tierId);
      await confirmed(resellerCustomer, await product(100_000n));
      await confirmed(resellerCustomer, await product(50_000n));
      await confirmed(ordinary, await product(50_000n));
      expect(
        await count(sql`
          SELECT count(*)::int AS n FROM orders o
            JOIN resellers r ON r.tenant_id = o.tenant_id AND r.customer_id = o.customer_id
           WHERE o.state <> 'DRAFT'
             AND NOT EXISTS (SELECT 1 FROM order_reseller_terms t
                              WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id)`),
      ).toBe(0);
      expect(await count(sql`SELECT count(*)::int AS n FROM order_reseller_terms`)).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 6, 7. Suspension and the reseller-only catalogue
  // -------------------------------------------------------------------------

  describe('a suspended reseller is an ordinary customer (R1)', () => {
    it('lists at list price, is refused reseller-only products, has no credit and no grant constraints', async () => {
      const tierId = await tier({ percent: 20, credit: 100_000n, grants: [] });
      await register(resellerCustomer, tierId);
      const everyone = await product(100_000n);
      const resellersOnly = await product(100_000n, { audience: 'RESELLERS_ONLY' });
      await setStatus(resellerCustomer, 'SUSPENDED');

      // No entitlement constraints, even on a tier that grants nothing; the list price.
      const order = await confirmed(resellerCustomer, everyone);
      expect(order.totals.subtotal.amountMinor).toBe(100_000n);
      expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE']);
      expect(await termsRow(order.id)).toBeUndefined();

      await expect(draft(resellerCustomer, resellersOnly)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE),
      );

      // The credit line is withdrawn with the rest.
      await expect(settle(resellerCustomer, order.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      expect(await balance(resellerCustomer)).toBe(0n);
    });

    it('refuses to confirm a draft quoted while ACTIVE once the reseller is suspended', async () => {
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const drafted = await draft(resellerCustomer, await product(100_000n));
      await setStatus(resellerCustomer, 'SUSPENDED');
      await expect(confirm(resellerCustomer, drafted.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED),
      );
      expect((await orderRow(drafted.id))?.state).toBe('DRAFT');
      expect(await termsRow(drafted.id)).toBeUndefined();
    });
  });

  describe('the reseller-only catalogue (R5)', () => {
    it('hides a RESELLERS_ONLY product from an ordinary customer and sells it to an entitled reseller', async () => {
      const resellersOnly = await product(100_000n, { audience: 'RESELLERS_ONLY' });
      const browse = async (customerId: UserId) =>
        (
          await ctx.container.products.browse(viaBot, customerActor(key()), 50, customerId)
        ).items.map((p) => p.id);

      expect(await browse(ordinary)).not.toContain(resellersOnly);
      await expect(draft(ordinary, resellersOnly)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE),
      );

      await register(resellerCustomer, await tier({ percent: 10 }));
      expect(await browse(resellerCustomer)).toContain(resellersOnly);
      const order = await confirmed(resellerCustomer, resellersOnly);
      expect(order.state).toBe('AWAITING_PAYMENT');
      expect(order.totals.total.amountMinor).toBe(90_000n);

      // A reseller whose tier does not grant it may not buy it either.
      const other = await customer('940003');
      await register(
        other,
        await tier({
          grants: [
            { kind: 'OPERATION', subject: null },
            { kind: 'CATEGORY', subject: await category() },
            { kind: 'PANEL', subject: null },
            { kind: 'BOT', subject: null },
          ],
        }),
      );
      await expect(draft(other, resellersOnly)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'CATALOGUE' }),
      );
      expect(await browse(other)).not.toContain(resellersOnly);
    });
  });

  // -------------------------------------------------------------------------
  // 8, 9. The credit line
  // -------------------------------------------------------------------------

  describe('the credit line (R8)', () => {
    const L = 100_000n;

    it('keeps a 99% reseller price payable: one minor unit, confirmed and settled from the wallet', async () => {
      /*
       * PR #69 review, F4. A 100% rate, or the upward rounding on a tiny subtotal, priced a
       * reseller order at ZERO, which `payments_amount_check` and
       * `wallet_entries_amount_check` refuse at settlement — after the customer confirmed.
       * The reduction now stops one minor unit short of the subtotal.
       */
      const tierId = await tier({ percent: 99 });
      await register(resellerCustomer, tierId);
      const order = await confirmed(resellerCustomer, await product(101n));
      // 99% of 101 rounds its reduction up to 100: the cost is the one unit left.
      expect(order.totals.subtotal.amountMinor).toBe(1n);
      expect(order.totals.total.amountMinor).toBe(1n);
      expect(await termsRow(order.id)).toMatchObject({
        layer: 'TIER',
        percent: 99,
        list_amount: '101',
        cost_amount: '1',
        sale_amount: '1',
        margin_amount: '100',
      });

      await adjust(resellerCustomer, 'CREDIT', 1n);
      const { payment, order: paid } = await settle(resellerCustomer, order.id);
      expect(paid.state).toBe('PAID');
      expect(payment.amount.amountMinor).toBe(1n);
      expect(await balance(resellerCustomer)).toBe(0n);

      // And a one-unit product at 99% keeps its one unit rather than losing all of it.
      const single = await confirmed(resellerCustomer, await product(1n));
      expect(single.totals.total.amountMinor).toBe(1n);
    });

    it('grants no debt on a zero limit: a zero balance cannot pay', async () => {
      await register(resellerCustomer, await tier({ credit: 0n }));
      const order = await confirmed(resellerCustomer, await product(1_000n));
      await expect(settle(resellerCustomer, order.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, {
          shortfallMinor: '1000',
          currency: 'IRT',
        }),
      );
      expect(await balance(resellerCustomer)).toBe(0n);
    });

    it('lets the wallet reach exactly −L and not −L−1', async () => {
      await register(resellerCustomer, await tier({ credit: L }));
      const tooMuch = await confirmed(resellerCustomer, await product(L + 1n));
      await expect(settle(resellerCustomer, tooMuch.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, { shortfallMinor: '1' }),
      );
      expect(await balance(resellerCustomer)).toBe(0n);

      const exact = await confirmed(resellerCustomer, await product(L));
      const { order } = await settle(resellerCustomer, exact.id);
      expect(order.state).toBe('PAID');
      expect(await balance(resellerCustomer)).toBe(-L);

      // Nothing more fits, not even one unit.
      const one = await confirmed(resellerCustomer, await product(1n));
      await expect(settle(resellerCustomer, one.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, { shortfallMinor: '1' }),
      );
      expect(await balance(resellerCustomer)).toBe(-L);
    });

    it('prefers the reseller’s own limit to the tier’s, in both directions', async () => {
      const tierId = await tier({ credit: L });
      await register(resellerCustomer, tierId, { credit: 30_000n });
      const over = await confirmed(resellerCustomer, await product(30_001n));
      await expect(settle(resellerCustomer, over.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      const within = await confirmed(resellerCustomer, await product(30_000n));
      await settle(resellerCustomer, within.id);
      expect(await balance(resellerCustomer)).toBe(-30_000n);

      // An own limit of ZERO overrides a generous tier: no debt at all.
      const other = await customer('940004');
      await register(other, tierId, { credit: 0n });
      const nothing = await confirmed(other, await product(1_000n));
      await expect(settle(other, nothing.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
    });

    it('grants nothing for a purchase in a currency other than the limit’s', async () => {
      const tierId = await tier({ credit: L, creditCurrency: 'USD' });
      await register(resellerCustomer, tierId);
      const order = await confirmed(resellerCustomer, await product(1_000n));
      await expect(settle(resellerCustomer, order.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, { shortfallMinor: '1000' }),
      );

      // The reseller's own limit, in the wrong currency, over a right-currency tier: none.
      const other = await customer('940005');
      await register(other, await tier({ credit: L }), { credit: L, creditCurrency: 'USD' });
      const second = await confirmed(other, await product(1_000n));
      await expect(settle(other, second.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
    });

    it('never lets an operator’s manual debit overdraw, whatever the credit limit', async () => {
      await register(resellerCustomer, await tier({ credit: L }));
      await expect(adjust(resellerCustomer, 'DEBIT', 1n)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      await adjust(resellerCustomer, 'CREDIT', 10n);
      await expect(adjust(resellerCustomer, 'DEBIT', 11n)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      await adjust(resellerCustomer, 'DEBIT', 10n);
      expect(await balance(resellerCustomer)).toBe(0n);

      // And a balance already in credit-debt cannot be pushed further by hand.
      const order = await confirmed(resellerCustomer, await product(40_000n));
      await settle(resellerCustomer, order.id);
      expect(await balance(resellerCustomer)).toBe(-40_000n);
      await expect(adjust(resellerCustomer, 'DEBIT', 1n)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      expect(await balance(resellerCustomer)).toBe(-40_000n);
    });

    it('serialises two concurrent 0.6·L purchases on the wallet lock: exactly one fits', async () => {
      await register(resellerCustomer, await tier({ credit: L }));
      const first = await confirmed(resellerCustomer, await product(60_000n));
      const second = await confirmed(resellerCustomer, await product(60_000n));

      /*
       * The CONTROLLED interleaving. The first settlement is held inside its own
       * transaction at the moment it reads the allowance — which `settleFromWallet` does
       * only after `lockCustomer` — so it holds the customer row's lock while it waits. The
       * second is then started and must be seen WAITING on a lock in `pg_stat_activity`
       * before the first is released. It can therefore only read the balance after the
       * first's debit has committed.
       */
      const service = ctx.container.resellers;
      const original = service.creditAllowance.bind(service);
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      vi.spyOn(service, 'creditAllowance').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        return original(...args);
      });

      const firstSettle = settle(resellerCustomer, first.id);
      firstSettle.catch(() => undefined);
      await inside;
      const secondSettle = settle(resellerCustomer, second.id);
      secondSettle.catch(() => undefined);

      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await rows<{ query: string }>(sql`
          SELECT query FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND pid <> pg_backend_pid()`);
        if (waiting.length >= 1) {
          expect(waiting[0]?.query.toLowerCase()).toContain('for update');
          break;
        }
        if (Date.now() > deadline) throw new Error('the second settlement never waited');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(calls, 'the second has read nothing yet').toBe(1);

      release();
      const [a, b] = await Promise.allSettled([firstSettle, secondSettle]);
      expect(a.status).toBe('fulfilled');
      expect(b).toMatchObject({
        status: 'rejected',
        reason: refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, {
          shortfallMinor: '20000',
        }),
      });
      expect(await balance(resellerCustomer)).toBe(-60_000n);
      expect(await balance(resellerCustomer)).toBeGreaterThanOrEqual(-L);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'PURCHASE' AND customer_id = ${resellerCustomer}`,
        ),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 10, 11. Refunds and the database guard
  // -------------------------------------------------------------------------

  describe('refunds and the record (R10)', () => {
    it('refunds a credit purchase with a compensating ledger entry and edits no row', async () => {
      await register(resellerCustomer, await tier({ percent: 20, credit: 100_000n }));
      const order = await confirmed(resellerCustomer, await product(75_000n));
      expect(order.totals.total.amountMinor).toBe(60_000n);
      const { payment } = await settle(resellerCustomer, order.id);
      expect(await balance(resellerCustomer)).toBe(-60_000n);

      const ledgerBefore = await rows<Record<string, unknown>>(
        sql`SELECT * FROM wallet_entries WHERE customer_id = ${resellerCustomer} ORDER BY created_at, id`,
      );
      const termsBefore = await termsRow(order.id);

      await ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: key(),
        paymentId: payment.id,
        amountMinor: 60_000n,
        reason: 'درخواست فروشنده',
      });

      const ledgerAfter = await rows<Record<string, unknown>>(
        sql`SELECT * FROM wallet_entries WHERE customer_id = ${resellerCustomer} ORDER BY created_at, id`,
      );
      expect(ledgerAfter.slice(0, ledgerBefore.length), 'no existing entry changed').toEqual(
        ledgerBefore,
      );
      expect(
        ledgerAfter
          .slice(ledgerBefore.length)
          .map((e) => [e.direction, e.reason, String(e.amount)]),
      ).toEqual([['CREDIT', 'REFUND', '60000']]);
      expect(await balance(resellerCustomer)).toBe(0n);
      expect(await termsRow(order.id), 'the snapshot keeps the margin it was sold at').toEqual(
        termsBefore,
      );
    });

    it('refuses UPDATE and DELETE on order_reseller_terms', async () => {
      await register(resellerCustomer, await tier({ percent: 20 }));
      const order = await confirmed(resellerCustomer, await product(100_000n));
      const db = ctx.container.database.db;
      const refused = { cause: { code: '23001' } };
      await expect(
        db.execute(sql`UPDATE order_reseller_terms SET margin_amount = margin_amount`),
      ).rejects.toMatchObject(refused);
      await expect(
        db.execute(sql`UPDATE order_reseller_terms SET tier_name = 'rewritten'`),
      ).rejects.toMatchObject(refused);
      await expect(db.execute(sql`DELETE FROM order_reseller_terms`)).rejects.toMatchObject(
        refused,
      );
      expect((await termsRow(order.id))?.tier_name).not.toBe('rewritten');
    });
  });

  // -------------------------------------------------------------------------
  // 12. The operator's service
  // -------------------------------------------------------------------------

  describe('administration (R2, R11)', () => {
    const tierWrite = (name: string) => ({
      name,
      pricingMode: 'PERCENTAGE_DISCOUNT' as const,
      discountPercentage: 10,
      creditLimit: money(50_000n, 'IRT'),
    });

    it('refuses a second tier whose name differs only in case', async () => {
      await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: key(),
        write: tierWrite('Gold'),
      });
      await expect(
        ctx.container.resellersAdmin.createTier(tenantA, owner, {
          idempotencyKey: key(),
          write: tierWrite('  gOLD '),
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
      const silver = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: key(),
        write: tierWrite('Silver'),
      });
      await expect(
        ctx.container.resellersAdmin.updateTier(tenantA, owner, {
          idempotencyKey: key(),
          tierId: silver.id,
          write: tierWrite('GOLD'),
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
      expect(
        (await ctx.container.resellersAdmin.listTiers(tenantA, owner)).map((t) => t.name),
      ).toEqual(['Gold', 'Silver']);
    });

    it('rejects grants naming a subject this tenant does not have, and changes nothing', async () => {
      const tierId = await tier({ grants: [{ kind: 'OPERATION', subject: 'NEW_SERVICE' }] });
      for (const missing of [
        { kind: 'PRODUCT', subject: ctx.container.ids.uuid() },
        { kind: 'CATEGORY', subject: ctx.container.ids.uuid() },
        { kind: 'PANEL', subject: ctx.container.ids.uuid() },
        { kind: 'BOT', subject: ctx.container.ids.uuid() },
      ] as const) {
        await expect(
          grant(tierId, [{ kind: 'OPERATION', subject: null }, missing]),
        ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
      }
      expect((await ctx.container.resellersAdmin.getTier(tenantA, owner, tierId)).grants).toEqual([
        { kind: 'OPERATION', subject: 'NEW_SERVICE' },
      ]);
    });

    it('refuses a second registration, and an unknown tier', async () => {
      const tierId = await tier();
      await register(resellerCustomer, tierId);
      await expect(register(resellerCustomer, tierId)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_ALREADY_REGISTERED),
      );
      await expect(register(ordinary, ctx.container.ids.uuid())).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND),
      );
      await expect(
        ctx.container.resellersAdmin.getTier(tenantA, owner, ctx.container.ids.uuid()),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));
      await expect(
        ctx.container.resellersAdmin.getTier(tenantA, owner, 'not-a-uuid'),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND));
      await expect(
        ctx.container.resellersAdmin.get(tenantA, owner, ordinary),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND));
      expect(await count(sql`SELECT count(*)::int AS n FROM resellers`)).toBe(1);
    });

    it('audits every write with its before and after', async () => {
      const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: key(),
        write: tierWrite('Gold'),
      });
      await ctx.container.resellersAdmin.updateTier(tenantA, owner, {
        idempotencyKey: key(),
        tierId: created.id,
        write: { ...tierWrite('Gold'), discountPercentage: 25 },
      });
      await grant(created.id, [{ kind: 'OPERATION', subject: 'NEW_SERVICE' }]);
      await grant(created.id, [{ kind: 'OPERATION', subject: null }]);
      await register(resellerCustomer, created.id);
      await setStatus(resellerCustomer, 'SUSPENDED');

      const audit = await rows<{
        action: string;
        entity_id: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        result: string;
      }>(sql`SELECT action, entity_id, before, after, result FROM audit_logs
              WHERE action LIKE 'reseller%' ORDER BY occurred_at, id`);
      expect(audit.map((a) => [a.action, a.result])).toEqual([
        ['reseller_tier.create', 'SUCCESS'],
        ['reseller_tier.update', 'SUCCESS'],
        ['reseller_tier.grants', 'SUCCESS'],
        ['reseller_tier.grants', 'SUCCESS'],
        ['reseller.register', 'SUCCESS'],
        ['reseller.update', 'SUCCESS'],
      ]);
      const [create, update, firstGrants, secondGrants, registered, suspended] = audit;
      expect(create).toMatchObject({ entity_id: created.id, before: null });
      expect(create?.after).toMatchObject({ name: 'Gold', discountPercentage: 10 });
      expect(update?.before).toMatchObject({ discountPercentage: 10 });
      expect(update?.after).toMatchObject({ discountPercentage: 25 });
      expect(firstGrants).toMatchObject({
        before: { grants: [] },
        after: { grants: [{ kind: 'OPERATION', subject: 'NEW_SERVICE' }] },
      });
      expect(secondGrants).toMatchObject({
        before: { grants: [{ kind: 'OPERATION', subject: 'NEW_SERVICE' }] },
        after: { grants: [{ kind: 'OPERATION', subject: null }] },
      });
      expect(registered).toMatchObject({
        entity_id: resellerCustomer,
        before: null,
        after: { tierId: created.id, status: 'ACTIVE' },
      });
      expect(suspended).toMatchObject({
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED' },
      });
    });

    it('replays a write with the same key and refuses the same key with a different body', async () => {
      const k = key();
      const first = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: k,
        write: tierWrite('Gold'),
      });
      const replayed = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: k,
        write: tierWrite('Gold'),
      });
      expect(replayed.id).toBe(first.id);
      await expect(
        ctx.container.resellersAdmin.createTier(tenantA, owner, {
          idempotencyKey: k,
          write: tierWrite('Silver'),
        }),
      ).rejects.toMatchObject(refusal(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH));

      const g = key();
      const grants = [{ kind: 'OPERATION' as const, subject: null }];
      await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: g,
        tierId: first.id,
        grants,
      });
      await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: g,
        tierId: first.id,
        grants,
      });
      await expect(
        ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
          idempotencyKey: g,
          tierId: first.id,
          grants: [],
        }),
      ).rejects.toMatchObject(refusal(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH));

      const r = key();
      const write = { tierId: first.id, pricingMode: 'TIER' as const, discountPercentage: null };
      await ctx.container.resellersAdmin.register(tenantA, owner, {
        idempotencyKey: r,
        customerId: resellerCustomer,
        write: { ...write, creditLimit: null },
      });
      const again = await ctx.container.resellersAdmin.register(tenantA, owner, {
        idempotencyKey: r,
        customerId: resellerCustomer,
        write: { ...write, creditLimit: null },
      });
      expect(again.customerId).toBe(resellerCustomer);
      await expect(
        ctx.container.resellersAdmin.register(tenantA, owner, {
          idempotencyKey: r,
          customerId: resellerCustomer,
          write: { ...write, creditLimit: money(1n, 'IRT') },
        }),
      ).rejects.toMatchObject(refusal(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH));

      // One of each, however many times the same command arrived.
      expect(await count(sql`SELECT count(*)::int AS n FROM reseller_tiers`)).toBe(1);
      expect(await count(sql`SELECT count(*)::int AS n FROM resellers`)).toBe(1);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'reseller%'`),
      ).toBe(3);
    });

    it('refuses every write to an actor without resellers.edit, and audits the denial', async () => {
      const finance = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'finance-reseller',
          roleKeys: ['finance'],
        }),
      );
      // Finance reads.
      expect(await ctx.container.resellersAdmin.listTiers(tenantA, finance)).toEqual([]);
      await expect(
        ctx.container.resellersAdmin.createTier(tenantA, finance, {
          idempotencyKey: key(),
          write: tierWrite('Gold'),
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      expect(await count(sql`SELECT count(*)::int AS n FROM reseller_tiers`)).toBe(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'reseller_tier.create' AND result <> 'SUCCESS'`,
        ),
      ).toBe(1);
    });

    it('refuses an operator write once the tenant has stopped accepting work', async () => {
      const tierId = await tier();
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      await expect(
        ctx.container.resellersAdmin.createTier(tenantA, owner, {
          idempotencyKey: key(),
          write: tierWrite('Gold'),
        }),
      ).rejects.toMatchObject(refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID));
      await expect(register(resellerCustomer, tierId)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID),
      );
      expect(await count(sql`SELECT count(*)::int AS n FROM reseller_tiers`)).toBe(1);
      expect(await count(sql`SELECT count(*)::int AS n FROM resellers`)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 14. The commercial actions
  // -------------------------------------------------------------------------

  describe('commercial actions (R5, R6)', () => {
    /**
     * A MARZBAN panel, because a renewal needs a provider that can perform one — the
     * shape `automatic-refund.test.ts` uses, for the reason it records. Nothing dials it.
     */
    async function renewableService(customerId: UserId): Promise<{
      serviceId: string;
      productId: ProductId;
      panelId: string;
    }> {
      const panel = await ctx.container.panels.create(tenantA, owner, {
        name: 'Panel Renew',
        providerType: 'marzban',
        baseUrl: 'https://renew.example.test',
        credentials: { username: 'nexa', password: 'not-a-real-password' },
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
        idempotencyKey: key(),
      });
      const panelId = panel.view.panel.id;
      const productId = await product(100_000n, { panelId });
      const order = await draft(customerId, productId);
      const serviceId = ctx.container.ids.uuid();
      await ctx.container.database.db.execute(sql`
        INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                              provider_username, subscription_ref, provider_client_id,
                              traffic_limit_bytes, state, provisioned_at, expires_at)
        VALUES (${serviceId}, ${tenantA.tenantId}, ${customerId}, ${order.id},
                ${panelId}, ${productId}, ${'rs' + serviceId.slice(-8)},
                ${serviceId.replace(/-/gu, '').slice(0, 32)},
                ${ctx.container.ids.uuid()}, 0, 'ACTIVE', now(), now() + interval '30 days')`);
      return { serviceId, productId, panelId };
    }

    const renew = (customerId: UserId, serviceId: string) =>
      ctx.container.commercialActions.draft(viaBot, customerActor(key()), customerId, {
        serviceId,
        kind: 'RENEW',
        idempotencyKey: key(),
      });

    it('refuses a renewal the tier does not grant, before an order exists', async () => {
      const { serviceId } = await renewableService(resellerCustomer);
      const tierId = await tier({
        percent: 20,
        grants: [
          { kind: 'OPERATION', subject: 'NEW_SERVICE' },
          { kind: 'PRODUCT', subject: null },
          { kind: 'PANEL', subject: null },
          { kind: 'BOT', subject: null },
        ],
      });
      await register(resellerCustomer, tierId);
      const before = await count(sql`SELECT count(*)::int AS n FROM orders`);
      await expect(renew(resellerCustomer, serviceId)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED, { dimension: 'OPERATION' }),
      );
      expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(before);
      expect(await count(sql`SELECT count(*)::int AS n FROM service_commercial_actions`)).toBe(0);
    });

    it('prices a granted renewal at the reseller layer and records its terms at confirmation', async () => {
      const { serviceId, panelId } = await renewableService(resellerCustomer);
      const tierId = await tier({
        percent: 20,
        grants: [
          { kind: 'OPERATION', subject: 'RENEW' },
          { kind: 'PRODUCT', subject: null },
          { kind: 'PANEL', subject: panelId },
          { kind: 'BOT', subject: BOT_A },
        ],
      });
      await register(resellerCustomer, tierId);
      const { order } = await renew(resellerCustomer, serviceId);
      expect(order.purpose).toBe('RENEW');
      expect(order.totals.subtotal.amountMinor).toBe(80_000n);
      expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE', 'TIER_PRICE']);

      const confirmedOrder = await ctx.container.commercialActions.confirm(
        viaBot,
        customerActor(key()),
        resellerCustomer,
        { orderId: order.id, idempotencyKey: key() },
      );
      expect(confirmedOrder.state).toBe('AWAITING_PAYMENT');
      expect(await termsRow(order.id)).toMatchObject({
        layer: 'TIER',
        percent: 20,
        list_amount: '100000',
        cost_amount: '80000',
        margin_amount: '20000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regression: the confirmation read the tier and its grants without a lock
  // -------------------------------------------------------------------------

  describe('a grant withdrawal serialises with a confirmation that already read the grants', () => {
    /*
     * Found by this suite in the first implementation and fixed; what follows is the
     * defect as it was, which this block now holds shut.
     *
     * `ResellerRepository.lockTier` says it takes `FOR UPDATE` on the tier row "so a grants
     * write and a reader agree", and `replaceGrants` takes it. But the reader —
     * `ResellerService.standing`, which `recordPurchase` calls inside the confirming
     * transaction — reads the tier and its grants with PLAIN selects, so it holds nothing
     * the writer waits for. The confirmation's first lock on the tier row is the FK check
     * of the `order_reseller_terms` insert, AFTER the decision.
     *
     * So an operator can withdraw a grant, be told it is withdrawn, and a confirmation that
     * decided on the old grants then commits a sale under it: the exact shape
     * `OrderService.confirm` closes for a category with `findForShare` ("either the
     * deactivation lands first and is read here, or it waits for this confirmation to
     * finish"). The same unlocked read covers the tier's price and the reseller's status.
     *
     * The interleaving is CONTROLLED: the confirmation is held inside its transaction right
     * after `assertEntitled` has decided, before the terms are written. The correct outcome
     * is that the withdrawal then WAITS on a lock until the confirmation finishes.
     */
    it('makes the withdrawal wait for a confirmation that decided on the old grants', async () => {
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const drafted = await draft(resellerCustomer, await product(100_000n));

      const service = ctx.container.resellers;
      const original = service.assertEntitled.bind(service);
      let entered!: () => void;
      const decided = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(service, 'assertEntitled').mockImplementation(async (...args) => {
        await original(...args);
        entered();
        await gate;
      });

      const confirmation = confirm(resellerCustomer, drafted.id);
      confirmation.catch(() => undefined);
      let withdrawnFirst = false;
      let waited = false;
      try {
        await decided;
        const withdrawal = grant(tierId, [
          { kind: 'OPERATION', subject: null },
          { kind: 'PRODUCT', subject: null },
          { kind: 'PANEL', subject: panelA2 },
          { kind: 'BOT', subject: null },
        ]).then(() => {
          withdrawnFirst = !waited;
        });
        withdrawal.catch(() => undefined);

        const deadline = Date.now() + 2_000;
        while (!withdrawnFirst && Date.now() < deadline) {
          const waiting = await count(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND pid <> pg_backend_pid()`);
          if (waiting > 0) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        release();
        await Promise.allSettled([confirmation, withdrawal]);
      } finally {
        release();
      }

      const order = await orderRow(drafted.id);
      const terms = await termsRow(drafted.id);
      const grantsNow = (await ctx.container.resellersAdmin.getTier(tenantA, owner, tierId)).grants;
      expect(
        { withdrawnFirst, waited },
        `the withdrawal committed while a confirmation that had read the old grants was still ` +
          `open; that confirmation then committed as ${order?.state} with terms ` +
          `${terms === undefined ? 'absent' : 'written'}, on panel A, which the grants now ` +
          `in force (${JSON.stringify(grantsNow)}) no longer allow`,
      ).toEqual({ withdrawnFirst: false, waited: true });
    });
  });
  // -------------------------------------------------------------------------
  // Operator writes against the transactions that hold the reseller row
  // -------------------------------------------------------------------------

  /** The waiting statement, or null once `settled()` is true or two seconds pass. */
  async function lockWaitOn(statement: RegExp, settled: () => boolean): Promise<string | null> {
    const deadline = Date.now() + 2_000;
    while (!settled() && Date.now() < deadline) {
      const waiting = await rows<{ query: string }>(sql`
        SELECT query FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND pid <> pg_backend_pid()`);
      const hit = waiting.find((w) => statement.test(w.query));
      if (hit !== undefined) return hit.query;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  /**
   * An operator's reseller update, waiting: at its `FOR UPDATE` read of the before-image
   * (`lockByCustomer`), or at the UPDATE itself.
   */
  const RESELLER_ROW_WRITE = /from\s+"resellers"[\s\S]*for update|update\s+"resellers"/iu;

  // -------------------------------------------------------------------------
  // A suspension against the commercial transactions that read the reseller row
  // -------------------------------------------------------------------------

  describe('a suspension serialises with the commercial transactions that read the reseller', () => {
    /*
     * `ResellerService.standing` reads the reseller row FOR SHARE inside a transaction
     * (`shareByCustomer`), so an operator's suspension — an UPDATE of that row — waits for
     * a transaction that has already read the reseller as ACTIVE, and that transaction
     * commits on the terms it read. With a plain read the suspension commits first, is
     * reported done, and a sale or a credit debit still commits under the ACTIVE row it
     * withdrew. The grant-withdrawal case above contends on the TIER row and cannot see
     * this one: reverting `shareByCustomer` alone leaves it green.
     *
     * Both cases hold the commercial transaction open right after it read the reseller,
     * start the suspension, and require `pg_stat_activity` to show it waiting on the
     * reseller row's lock — at its `FOR UPDATE` read of the before-image, or at the UPDATE —
     * before the hold is released.
     */

    const statusOf = async (customerId: UserId) =>
      (
        await rows<{ status: string }>(
          sql`SELECT status FROM resellers WHERE customer_id = ${customerId}`,
        )
      )[0]?.status;

    it('a suspension serialises with a confirmation that read the reseller as ACTIVE', async () => {
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const drafted = await draft(resellerCustomer, await product(100_000n));

      // Held right after the confirmation's first `standing` read, inside its transaction.
      const service = ctx.container.resellers;
      const original = service.standing.bind(service);
      let entered!: () => void;
      const read = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let readAs: string | null | undefined;
      vi.spyOn(service, 'standing').mockImplementation(async (...args) => {
        const standing = await original(...args);
        if (readAs === undefined && args[2] !== undefined) {
          readAs = standing?.reseller.status ?? null;
          entered();
          await gate;
        }
        return standing;
      });

      const finished: string[] = [];
      const confirmation = confirm(resellerCustomer, drafted.id).then((order) => {
        finished.push('confirmation');
        return order;
      });
      confirmation.catch(() => undefined);
      let suspension: Promise<void>;
      let waitingIn: string | null;
      try {
        await read;
        expect(readAs, 'the confirmation read the reseller as ACTIVE').toBe('ACTIVE');
        suspension = setStatus(resellerCustomer, 'SUSPENDED').then(() => {
          finished.push('suspension');
        });
        suspension.catch(() => undefined);
        waitingIn = await lockWaitOn(RESELLER_ROW_WRITE, () => finished.includes('suspension'));
      } finally {
        release();
      }
      const [confirmed, suspended] = await Promise.allSettled([confirmation, suspension]);

      expect(
        { waitingIn: waitingIn !== null, finished: [...finished] },
        'the suspension must wait on the reseller row until the confirmation that read it ' +
          'as ACTIVE has committed',
      ).toEqual({ waitingIn: true, finished: ['confirmation', 'suspension'] });
      expect(confirmed).toMatchObject({
        status: 'fulfilled',
        value: { state: 'AWAITING_PAYMENT' },
      });
      expect(suspended.status).toBe('fulfilled');
      // The confirmation committed on the terms it read: the reseller's TIER price.
      expect(await termsRow(drafted.id)).toMatchObject({
        layer: 'TIER',
        percent: 20,
        cost_amount: '80000',
      });
      expect(await statusOf(resellerCustomer)).toBe('SUSPENDED');
    });

    it('a suspension waits for a wallet settlement that is spending credit', async () => {
      await register(resellerCustomer, await tier({ credit: 100_000n }));
      const order = await confirmed(resellerCustomer, await product(60_000n));
      const later = await confirmed(resellerCustomer, await product(1_000n));

      // Held right after the settlement read the allowance, under the wallet lock.
      const service = ctx.container.resellers;
      const original = service.creditAllowance.bind(service);
      let entered!: () => void;
      const read = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let allowance: bigint | undefined;
      vi.spyOn(service, 'creditAllowance').mockImplementation(async (...args) => {
        const answer = await original(...args);
        if (allowance === undefined) {
          allowance = answer;
          entered();
          await gate;
        }
        return answer;
      });

      const finished: string[] = [];
      const settlement = settle(resellerCustomer, order.id).then((result) => {
        finished.push('settlement');
        return result;
      });
      settlement.catch(() => undefined);
      let suspension: Promise<void>;
      let waitingIn: string | null;
      try {
        await read;
        expect(allowance, 'the settlement read the credit line').toBe(100_000n);
        suspension = setStatus(resellerCustomer, 'SUSPENDED').then(() => {
          finished.push('suspension');
        });
        suspension.catch(() => undefined);
        waitingIn = await lockWaitOn(RESELLER_ROW_WRITE, () => finished.includes('suspension'));
      } finally {
        release();
      }
      const [settled, suspended] = await Promise.allSettled([settlement, suspension]);

      expect(
        { waitingIn: waitingIn !== null, finished: [...finished] },
        'the suspension must wait on the reseller row until the settlement spending its ' +
          'credit has committed',
      ).toEqual({ waitingIn: true, finished: ['settlement', 'suspension'] });
      // The settlement completed on the credit it read.
      expect(settled).toMatchObject({ status: 'fulfilled', value: { order: { state: 'PAID' } } });
      expect(await balance(resellerCustomer)).toBe(-60_000n);
      expect(suspended.status).toBe('fulfilled');
      expect(await statusOf(resellerCustomer)).toBe('SUSPENDED');
      // And the credit line is gone for whatever comes after the suspension.
      await expect(settle(resellerCustomer, later.id)).rejects.toMatchObject(
        refusal(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS),
      );
      expect(await balance(resellerCustomer)).toBe(-60_000n);
    });
  });

  describe('two operator updates of one reseller serialise, and each audits the other’s after-image', () => {
    /*
     * PR #69 review, F3. `ResellerAdminService.update` read its before-image with a plain
     * select, so two concurrent updates both read the row they started from, and the
     * second's audit row recorded a "before" that was never the state it replaced: the
     * first update's after-image vanished from the trail. It now reads the row FOR UPDATE
     * (`lockByCustomer`) before its UPDATE.
     *
     * Controlled: update A is held inside its transaction right after its locked read;
     * update B is started and must be seen waiting on the reseller row in
     * `pg_stat_activity`; A is released. B's audit before-image must equal A's after-image.
     */
    it('makes the second update wait, and audits the first’s after-image as its before', async () => {
      const tierId = await tier({ percent: 20 });
      await register(resellerCustomer, tierId);
      const write = (status: ResellerStatus, percent: number | null) => ({
        tierId,
        status,
        pricingMode: (percent === null ? 'TIER' : 'PERCENTAGE_DISCOUNT') as ResellerOverrideMode,
        discountPercentage: percent,
        creditLimit: null,
      });

      // Held right after update A's locked read of the before-image.
      const repository = (
        ctx.container.resellersAdmin as unknown as {
          deps: { resellers: { lockByCustomer: (...args: never[]) => Promise<unknown> } };
        }
      ).deps.resellers;
      const original = repository.lockByCustomer.bind(repository);
      let entered!: () => void;
      const locked = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      vi.spyOn(repository, 'lockByCustomer').mockImplementation(async (...args) => {
        const row = await original(...args);
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        return row;
      });

      const finished: string[] = [];
      const updateA = ctx.container.resellersAdmin
        .update(tenantA, owner, {
          idempotencyKey: key(),
          customerId: resellerCustomer,
          write: write('ACTIVE', 35),
        })
        .then(() => {
          finished.push('A');
        });
      updateA.catch(() => undefined);
      let updateB: Promise<void> = Promise.resolve();
      let waitingIn: string | null = null;
      try {
        await locked;
        updateB = ctx.container.resellersAdmin
          .update(tenantA, owner, {
            idempotencyKey: key(),
            customerId: resellerCustomer,
            write: write('SUSPENDED', null),
          })
          .then(() => {
            finished.push('B');
          });
        updateB.catch(() => undefined);
        waitingIn = await lockWaitOn(RESELLER_ROW_WRITE, () => finished.includes('B'));
      } finally {
        release();
      }
      const [a, b] = await Promise.allSettled([updateA, updateB]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      expect(
        { waited: waitingIn !== null, finished: [...finished] },
        'update B must wait on the reseller row until update A has committed',
      ).toEqual({ waited: true, finished: ['A', 'B'] });

      const audit = await rows<{
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(sql`SELECT before, after FROM audit_logs
              WHERE action = 'reseller.update' AND result = 'SUCCESS'
              ORDER BY occurred_at, id`);
      expect(audit).toHaveLength(2);
      // Told apart by what each wrote, not by timestamp order: two rows can share a millisecond.
      const first = audit.find((row) => row.after?.['status'] === 'ACTIVE');
      const second = audit.find((row) => row.after?.['status'] === 'SUSPENDED');
      expect(first?.before).toMatchObject({ status: 'ACTIVE', pricingMode: 'TIER' });
      expect(first?.after).toMatchObject({
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 35,
      });
      expect(second?.before, 'B replaced what A wrote, and its audit row says so').toEqual(
        first?.after,
      );
      expect(second?.after).toMatchObject({ status: 'SUSPENDED', pricingMode: 'TIER' });
    });
  });
});
