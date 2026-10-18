import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
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
 * Owner decision 2026-10-17 (the one-time Mirza import): a negative Mirza balance becomes a
 * negative wallet balance — one `MIGRATION_OPENING_BALANCE` DEBIT — and the customer may buy
 * NOTHING until they top up. The gate is at the commitment (`OrderService.confirm` here,
 * `CommercialActionService.confirm` in `extra-devices.test.ts`), so it holds for every rail:
 * a wallet purchase would fail `canCover` anyway, and a gateway, receipt or Stars payment is
 * only ever made against a confirmed order.
 *
 * Owner decision 2026-10-18: the rule is the same for every negative wallet. A negative
 * balance that did not come from the import, such as a reseller's legacy debt from the credit
 * line removed on 2026-10-01, blocks a purchase in the same way (`resellers.test.ts` holds
 * the reseller case).
 *
 * MUTATION: removing `assertWalletNotNegative` from `OrderService.confirm` fails the first
 * test; gating only a Mirza DEBIT opening again (the 2026-10-17 scope) fails the third;
 * moving it above the already-confirmed replay fails the fourth.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const IMPORTER = systemJobActor('legacy-import:test', 'corr-negative-gate' as CorrelationId);
const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a negative wallet blocks purchase until it is topped up', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let panelA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `negative-gate-${(n += 1)}`;

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
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-negative',
        roleKeys: ['owner'],
      }),
    );
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor('resolve-negative'),
      {
        idempotencyKey: 'resolve-negative',
        telegramUserId: '930001',
        from: { id: 930001, first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  const draft = async () =>
    ctx.container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(100_000n),
    });
  const confirm = (orderId: string, idempotencyKey = key()) =>
    ctx.container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey,
      customerId: customerA,
      orderId,
    });
  const credit = (amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'شارژ آزمون',
    });
  const balance = async () =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;
  const openNegative = (legacyBalanceMinor: bigint) =>
    ctx.container.migrationOpeningBalance.post(tenantA, IMPORTER, {
      customerId: customerA,
      telegramUserId: '930001',
      legacyBalanceMinor,
      currency: 'IRT',
    });

  it('refuses confirmation below zero; a top-up to zero or above lets it through', async () => {
    await openNegative(-45_000n);
    expect(await balance()).toBe(-45_000n);
    const order = await draft();

    await expect(confirm(order.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED,
    });
    // A partial top-up nets against it and still leaves it below zero.
    await credit(40_000n);
    expect(await balance()).toBe(-5_000n);
    await expect(confirm(order.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED,
    });
    // Exactly zero is not negative.
    await credit(5_000n);
    expect(await balance()).toBe(0n);
    expect((await confirm(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('a zero or positive opening never blocks anything', async () => {
    await openNegative(20_000n);
    const order = await draft();
    expect((await confirm(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('blocks a negative balance that no import wrote just the same, until a top-up', async () => {
    // A debt run up before the owner removed credit (2026-10-01): a plain ledger row, no
    // MIGRATION_OPENING_BALANCE at all.
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, 'DEBIT',
              'PURCHASE', 30000, 'IRT', ${`legacy-credit-${key()}`})`);
    expect(await balance()).toBe(-30_000n);
    const order = await draft();
    await expect(confirm(order.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED,
    });
    await credit(30_000n);
    expect((await confirm(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('never refuses the replay of an order already confirmed', async () => {
    const order = await draft();
    const idempotencyKey = key();
    await confirm(order.id, idempotencyKey);
    // Below zero afterwards (only the importer can do this; it runs under a write freeze).
    await openNegative(-1_000n);
    expect((await confirm(order.id, idempotencyKey)).state).toBe('AWAITING_PAYMENT');
    expect((await confirm(order.id)).state).toBe('AWAITING_PAYMENT');
  });
});
