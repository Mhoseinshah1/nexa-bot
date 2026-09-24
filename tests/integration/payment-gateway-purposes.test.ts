import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type UserId,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Payment routes PER PURPOSE, and the typed top-up that chooses one (customer UX
 * completion §D, §F).
 *
 *   - `routesFor` lists exactly the routes that are ACTIVE, switched on for the purpose,
 *     admit the customer and — with an amount — admit the amount, in the operator's
 *     order; each predicate is turned off on its own so the case names which one bit;
 *   - a route switched on for top-up and off for purchase is offered for one and not
 *     the other, and `manualTransferOffered` answers per purpose;
 *   - `requestWalletTopupTyped` refuses below the floor, above the NEW ceiling, a route
 *     not allowed for top-up and a DISABLED route, snapshots the route's gift, answers a
 *     replay with the same payment, and refuses the same key with a different amount.
 *
 * Every case runs through the services against a real database, because the route list
 * is read FOR SHARE inside the issuing transaction and the idempotency rules are rows.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Every condition off and both purposes on, so each case turns exactly one thing. */
const OPEN: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

const IRT = (amountMinor: bigint) => money(amountMinor, 'IRT');

describe('payment routes per purpose', () => {
  let ctx: TestContext;
  let ownerA: ActorContext;
  let customerA: UserId;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.container.roles.ensureSystemRoles(tenantA);
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pp', roleKeys: ['owner'] }),
    );
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('resolve-880101'),
      {
        idempotencyKey: 'resolve-880101',
        telegramUserId: '880101',
        from: { id: 880101, first_name: 'نیما' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  const configure = (config: Partial<PaymentGatewayConfig>, key: string) =>
    ctx.container.paymentGateways.configure(tenantA, ownerA, {
      idempotencyKey: `cfg-${key}`,
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, ...config },
    });

  const setStatus = (status: 'ACTIVE' | 'DISABLED', key: string) =>
    ctx.container.paymentGateways.setStatus(tenantA, ownerA, {
      idempotencyKey: `st-${key}`,
      provider: 'MANUAL_TRANSFER',
      status,
    });

  const routesFor = (purpose: 'SERVICE_PURCHASE' | 'WALLET_TOPUP', amount: bigint | null) =>
    ctx.container.paymentGateways.routesFor(
      tenantA,
      customerA,
      purpose,
      amount === null ? null : IRT(amount),
    );

  const providers = async (
    purpose: 'SERVICE_PURCHASE' | 'WALLET_TOPUP',
    amount: bigint | null = null,
  ) => (await routesFor(purpose, amount)).map((route) => route.provider);

  const typed = (amountMinor: bigint, key: string, provider = 'MANUAL_TRANSFER' as const) =>
    ctx.container.payments.requestWalletTopupTyped(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key),
      customerA,
      { idempotencyKey: key, amount: IRT(amountMinor), provider },
    );

  async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
    const error = await promise.then(() => null).catch((thrown: unknown) => thrown);
    expect(error, `expected a refusal with ${code}`).not.toBeNull();
    expect(isNexaError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
  }

  async function setSetting(key: string, value: unknown): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${key},
              ${JSON.stringify(value)}::jsonb, 1, now())
      ON CONFLICT (tenant_id, setting_key)
        DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, version = setting_values.version + 1`);
  }

  async function paymentCount(): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // routesFor
  // -------------------------------------------------------------------------

  describe('routesFor', () => {
    it('offers the seeded route for both purposes, with its descriptor', async () => {
      for (const purpose of ['SERVICE_PURCHASE', 'WALLET_TOPUP'] as const) {
        const routes = await routesFor(purpose, null);
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
          provider: 'MANUAL_TRANSFER',
          displayName: null,
          topupCashbackPercent: 0,
          descriptor: { provider: 'MANUAL_TRANSFER', settlesVia: 'MANUAL_TRANSFER' },
        });
      }
    });

    it('drops a DISABLED route for every purpose', async () => {
      await setStatus('DISABLED', 'off');
      expect(await providers('SERVICE_PURCHASE')).toEqual([]);
      expect(await providers('WALLET_TOPUP')).toEqual([]);
      await setStatus('ACTIVE', 'on');
      expect(await providers('WALLET_TOPUP')).toEqual(['MANUAL_TRANSFER']);
    });

    it('filters by the purpose switches, each on its own', async () => {
      await configure({ allowServicePurchase: false }, 'no-purchase');
      expect(await providers('SERVICE_PURCHASE')).toEqual([]);
      expect(await providers('WALLET_TOPUP')).toEqual(['MANUAL_TRANSFER']);

      await configure({ allowWalletTopup: false }, 'no-topup');
      expect(await providers('SERVICE_PURCHASE')).toEqual(['MANUAL_TRANSFER']);
      expect(await providers('WALLET_TOPUP')).toEqual([]);

      await configure({ allowServicePurchase: false, allowWalletTopup: false }, 'neither');
      expect(await providers('SERVICE_PURCHASE')).toEqual([]);
      expect(await providers('WALLET_TOPUP')).toEqual([]);
    });

    it('filters by the customer’s eligibility', async () => {
      // Two confirmed payments are needed and the customer has none.
      await configure(
        {
          eligibility: {
            activateAfterPayments: 2,
            deactivateAfterPayments: 0,
            activateAfterAccountDays: 0,
          },
        },
        'elig',
      );
      expect(await providers('WALLET_TOPUP')).toEqual([]);
      expect(await providers('SERVICE_PURCHASE')).toEqual([]);
    });

    it('filters by the amount bounds only when an amount is given', async () => {
      await configure({ minAmountMinor: 100_000n, maxAmountMinor: 500_000n }, 'bounds');
      // No amount: the route is on the list; the bounds are somebody else's question.
      expect(await providers('WALLET_TOPUP', null)).toEqual(['MANUAL_TRANSFER']);
      // Inside, at either edge.
      expect(await providers('WALLET_TOPUP', 100_000n)).toEqual(['MANUAL_TRANSFER']);
      expect(await providers('WALLET_TOPUP', 500_000n)).toEqual(['MANUAL_TRANSFER']);
      // Outside, either side.
      expect(await providers('WALLET_TOPUP', 99_999n)).toEqual([]);
      expect(await providers('WALLET_TOPUP', 500_001n)).toEqual([]);
    });

    it('drops a route whose bounds were written in another currency', async () => {
      await configure({ minAmountMinor: 100_000n }, 'cur');
      // The installation switches to IRR; the bounds still MEAN IRT and admit nothing.
      await setSetting('sales.currency', 'IRR');
      const routes = await ctx.container.paymentGateways.routesFor(
        tenantA,
        customerA,
        'WALLET_TOPUP',
        money(200_000n, 'IRR'),
      );
      expect(routes).toEqual([]);
    });

    it('orders by (sortOrder, provider)', async () => {
      /*
       * With one provider in the catalogue the order cannot be observed across rows, so
       * this pins the ordering the repository query states: the route's sort position
       * is what comes back on the route, and the list is the repository's order.
       */
      await configure({ sortOrder: 7 }, 'sort');
      const routes = await routesFor('WALLET_TOPUP', null);
      expect(routes.map((route) => [route.gateway.sortOrder, route.provider])).toEqual([
        [7, 'MANUAL_TRANSFER'],
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // The purpose the manual route is offered FOR
  // -------------------------------------------------------------------------

  it('offers the manual route per purpose, and defaults to a purchase', async () => {
    await configure({ allowServicePurchase: false }, 'mt-1');
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(false);
    expect(await ctx.container.payments.manualTransferOffered(tenantA, 'SERVICE_PURCHASE')).toBe(
      false,
    );
    expect(await ctx.container.payments.manualTransferOffered(tenantA, 'WALLET_TOPUP')).toBe(true);

    await configure({ allowWalletTopup: false }, 'mt-2');
    expect(await ctx.container.payments.manualTransferOffered(tenantA)).toBe(true);
    expect(await ctx.container.payments.manualTransferOffered(tenantA, 'WALLET_TOPUP')).toBe(false);
  });

  it('refuses a PRESET top-up through a route switched off for top-up', async () => {
    await setSetting('wallet.topup.presets', [{ amountMinor: '500000', currency: 'IRT' }]);
    await configure({ allowWalletTopup: false }, 'preset-off');
    await expectRefusal(
      ctx.container.payments.requestWalletTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('preset-off'),
        customerA,
        { idempotencyKey: 'preset-off', amountMinor: 500_000n },
      ),
      COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
    );
    expect(await paymentCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The typed top-up
  // -------------------------------------------------------------------------

  describe('requestWalletTopupTyped', () => {
    it('issues a transfer for a typed amount against the named route, snapshotting its gift', async () => {
      await configure({ topupCashbackPercent: 7 }, 'gift');
      const { payment, destination } = await typed(730_000n, 'typed-1');

      expect(payment.state).toBe('PENDING');
      expect(payment.orderId).toBeNull();
      expect(payment.method).toBe('MANUAL_TRANSFER');
      // The figure the customer typed, in the installation's currency — not a preset.
      expect(payment.amount).toEqual(IRT(730_000n));
      expect(payment.gatewayProvider).toBe('MANUAL_TRANSFER');
      // The route's promise at the moment of issue, frozen on the payment.
      expect(payment.topupCashbackPercent).toBe(7);
      expect(destination).not.toBeNull();

      // Changing the gift afterwards changes nothing about this payment.
      await configure({ topupCashbackPercent: 12 }, 'gift-later');
      const stored = await ctx.container.database.db.execute<{ topup_cashback_percent: number }>(
        sql`SELECT topup_cashback_percent FROM payments WHERE id = ${payment.id}`,
      );
      expect(stored.rows[0]?.topup_cashback_percent).toBe(7);
    });

    it('needs no preset at all', async () => {
      await setSetting('wallet.topup.presets', []);
      const { payment } = await typed(250_000n, 'typed-no-presets');
      expect(payment.amount).toEqual(IRT(250_000n));
    });

    it('refuses an amount below wallet.topup.minimum', async () => {
      await setSetting('wallet.topup.minimum', { amountMinor: '600000', currency: 'IRT' });
      await expectRefusal(typed(599_999n, 'typed-min'), COMMERCE_ERROR_CODES.TOPUP_BELOW_MINIMUM);
      expect(await paymentCount()).toBe(0);
      // At the floor is accepted.
      const { payment } = await typed(600_000n, 'typed-min-ok');
      expect(payment.amount).toEqual(IRT(600_000n));
    });

    it('refuses an amount above wallet.topup.maximum, and accepts the ceiling itself', async () => {
      await setSetting('wallet.topup.maximum', { amountMinor: '1000000', currency: 'IRT' });
      const refused = await typed(1_000_001n, 'typed-max')
        .then(() => null)
        .catch((error: unknown) => error as { code: string; kind: string; details?: unknown });
      expect(refused?.code).toBe(COMMERCE_ERROR_CODES.TOPUP_ABOVE_MAXIMUM);
      // A VALIDATION error: the figure is the customer's input, and the reply names the ceiling.
      expect(refused?.kind).toBe('VALIDATION');
      expect(refused?.details).toEqual({ maximumMinor: '1000000', currency: 'IRT' });
      expect(await paymentCount()).toBe(0);

      const { payment } = await typed(1_000_000n, 'typed-max-ok');
      expect(payment.amount).toEqual(IRT(1_000_000n));
    });

    it('reads a zero maximum as no ceiling', async () => {
      await setSetting('wallet.topup.maximum', { amountMinor: '1000000', currency: 'IRT' });
      await expectRefusal(
        typed(1_000_001n, 'typed-max-off-1'),
        COMMERCE_ERROR_CODES.TOPUP_ABOVE_MAXIMUM,
      );
      // The ceiling switched off: the same figure that was refused a moment ago is not.
      await setSetting('wallet.topup.maximum', { amountMinor: '0', currency: 'IRT' });
      const { payment } = await typed(1_000_001n, 'typed-max-off-2');
      expect(payment.amount).toEqual(IRT(1_000_001n));
    });

    it('applies the route’s own bounds on top of the installation’s', async () => {
      await configure({ maxAmountMinor: 800_000n }, 'route-max');
      await setSetting('wallet.topup.maximum', { amountMinor: '5000000', currency: 'IRT' });
      // Under the installation's ceiling, over the route's: the route drops out of the
      // offered list, and a route not offered is `TOPUP_NOT_OFFERED`.
      await expectRefusal(
        typed(900_000n, 'typed-route-max'),
        COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED,
      );
    });

    it('refuses a route switched off for top-up', async () => {
      await configure({ allowWalletTopup: false }, 'typed-off');
      await expectRefusal(typed(500_000n, 'typed-off-1'), COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED);
      expect(await paymentCount()).toBe(0);
      // Off for purchase only: a top-up is still fine.
      await configure({ allowWalletTopup: true, allowServicePurchase: false }, 'typed-on');
      const { payment } = await typed(500_000n, 'typed-off-2');
      expect(payment.amount).toEqual(IRT(500_000n));
    });

    it('refuses a DISABLED route', async () => {
      await setStatus('DISABLED', 'typed-disabled');
      await expectRefusal(typed(500_000n, 'typed-dis-1'), COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED);
      expect(await paymentCount()).toBe(0);
    });

    it('refuses a customer the route’s thresholds exclude', async () => {
      await configure(
        {
          eligibility: {
            activateAfterPayments: 2,
            deactivateAfterPayments: 0,
            activateAfterAccountDays: 0,
          },
        },
        'typed-elig',
      );
      await expectRefusal(typed(500_000n, 'typed-elig-1'), COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED);
    });

    it('refuses zero and a figure in a currency the installation does not sell in', async () => {
      await expectRefusal(typed(0n, 'typed-zero'), COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      await expectRefusal(
        ctx.container.payments.requestWalletTopupTyped(
          { ...tenantA, botInstanceId: BOT_A },
          systemActor('typed-irr'),
          customerA,
          {
            idempotencyKey: 'typed-irr',
            amount: money(500_000n, 'IRR'),
            provider: 'MANUAL_TRANSFER',
          },
        ),
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
      expect(await paymentCount()).toBe(0);
    });

    it('answers a replay under the same key with the same payment', async () => {
      const first = await typed(400_000n, 'typed-replay');
      const again = await typed(400_000n, 'typed-replay');
      expect(again.payment.id).toBe(first.payment.id);
      expect(again.destination?.cardNumber).toBe(first.destination?.cardNumber);
      expect(await paymentCount()).toBe(1);
    });

    it('refuses the same key with a different amount as a payload mismatch', async () => {
      await typed(400_000n, 'typed-mismatch');
      await expectRefusal(
        typed(450_000n, 'typed-mismatch'),
        PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
      );
      expect(await paymentCount()).toBe(1);
    });

    it('hands back the open top-up whatever amount is typed next', async () => {
      const first = await typed(400_000n, 'typed-open-1');
      // The one-open-top-up rule, unchanged by the entry: the customer holds ONE reference.
      const second = await typed(900_000n, 'typed-open-2');
      expect(second.payment.id).toBe(first.payment.id);
      expect(second.payment.amount).toEqual(IRT(400_000n));
      expect(await paymentCount()).toBe(1);
    });
  });
});
