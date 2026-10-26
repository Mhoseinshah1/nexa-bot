import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  proportionalTargetMinor,
  referralSignupGiftShares,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Container } from '../../apps/api/src/container';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleRefundRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-refund.repository';
import { ReferralCommissionService } from '../../apps/api/src/modules/commerce/referrals/application/referral-commission.service';
import { DrizzleReferralCommissionRepository } from '../../apps/api/src/modules/commerce/referrals/infrastructure/drizzle-referral.repository';
import { TenantReferralDayCalendar } from '../../apps/api/src/modules/commerce/referrals/infrastructure/tenant-referral-day.calendar';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
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
 * R10 D5 (b): the referral-gift abuse guard (`referral_abuse_guard`).
 *
 * The rules under test, each a way to pay a fake sign-up, pay twice, or take back what was
 * already paid:
 *
 * - with the guard on, NEITHER side of a referral's gift is payable before the referee's
 *   first paid, DELIVERED purchase — at the button (`claimableFor`) and in the claim's
 *   locked set alike — and a claim before it writes no gift row;
 * - a trial, an undelivered or failed order and a Mirza referral never qualify;
 * - turning the guard on or off moves no money: stamped sides and balances are untouched;
 * - a referrer is paid at most the daily cap of gift shares per local day `[start, end)`;
 *   the rest waits for the next day, and the referee's own share is never capped;
 * - a commission over the daily cap is DEFERRED, never voided, never blocks the queue, and
 *   is earned the next day from the refunds as they stand then.
 *
 * The whole existing gift and commission suites run with the guard off and are the proof
 * that off is today's behaviour byte for byte.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const DAY = 24 * 3_600_000;

/** A clock the commission earner reads, moved forward by whole days. */
class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

async function fakeGetMe(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { id: 7002, username: 'guard_store_bot' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

function fixtures(container: Container, owner: ActorContext, finance: ActorContext, panel: string) {
  let n = 0;
  let telegramId = 950_000;
  const key = (): string => `guard-key-${(n += 1)}`;
  const db = container.database.db;
  const products = new DrizzleProductRepository(db);

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db.execute(query as never)) as unknown as { rows: T[] }).rows;
  }

  async function setFlag(flagKey: string, enabled: boolean) {
    const before = (await container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === flagKey,
    );
    if (before === undefined) throw new Error(`no ${flagKey} flag`);
    return container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flagKey as never,
      enabled,
      expectedVersion: before.version,
      confirmKey: flagKey,
      reason: 'test toggle',
    });
  }

  async function setSetting(settingKey: string, value: unknown) {
    const before = await container.settingsService.get(tenantA, owner, settingKey);
    return container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  /** The purchase commission, 10%, and the gift: 100,000 split 50/50. */
  async function program(scope: 'FIRST_PAID_ORDER' | 'EVERY_PAID_ORDER' = 'FIRST_PAID_ORDER') {
    await setSetting('referral.commission_percent', 10);
    await setSetting('referral.commission_scope', scope);
    await setFlag('referrals', true);
    await setSetting('referral.signup_gift.total', { amountMinor: '100000', currency: 'IRT' });
    await setSetting('referral.signup_gift.referrer_percent', 50);
    await setSetting('referral.signup_gift.referred_percent', 50);
    await setFlag('referral_signup_gift', true);
  }

  /** The guard on, with its settings as given (defaults: purchase required, no caps). */
  async function guard(
    terms: {
      readonly unlock?: 'ON_ATTRIBUTION' | 'ON_FIRST_PAID_PURCHASE';
      readonly giftCap?: number | null;
      readonly commissionCap?: number | null;
    } = {},
  ) {
    if (terms.unlock !== undefined) await setSetting('referral.abuse.gift_unlock', terms.unlock);
    if (terms.giftCap !== undefined) {
      await setSetting('referral.abuse.referrer_daily_gift_cap', terms.giftCap);
    }
    if (terms.commissionCap !== undefined) {
      await setSetting('referral.abuse.referrer_daily_commission_cap', terms.commissionCap);
    }
    await setFlag('referral_abuse_guard', true);
  }

  const registered = async (startPayload: string | null = null): Promise<UserId> =>
    (
      await container.customers.resolveFromUpdate(tenantA, customerActor(key()), {
        idempotencyKey: key(),
        telegramUserId: String((telegramId += 1)),
        from: { id: telegramId, first_name: 'مهسا' },
        botInstanceId: BOT_A,
        ...(startPayload === null ? {} : { startPayload }),
      })
    ).customer.id;

  async function codeOf(customerId: string): Promise<string> {
    const invited = await container.referrals.invite(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      botInstanceId: BOT_A,
    });
    if (invited.outcome !== 'READY') throw new Error(`no code: ${invited.outcome}`);
    return invited.code;
  }

  /** A referrer, and `count` new customers who arrived through their link. */
  async function referrerWith(
    count: number,
  ): Promise<{ referrer: UserId; referees: UserId[]; referralIds: string[] }> {
    const referrer = await registered();
    const code = await codeOf(referrer);
    const referees: UserId[] = [];
    for (let i = 0; i < count; i += 1) referees.push(await registered(`ref-${code}`));
    const referralIds: string[] = [];
    for (const referee of referees) {
      const [row] = await rows<{ id: string }>(
        sql`SELECT id FROM referrals WHERE tenant_id = ${tenantA.tenantId} AND referee_id = ${referee}`,
      );
      if (row === undefined) throw new Error('no referral was attributed');
      referralIds.push(row.id);
    }
    return { referrer, referees, referralIds };
  }

  const claim = (customerId: string, idempotencyKey = key()) =>
    container.referralSignupGifts.claim(tenantA, customerActor(key()), customerId, {
      idempotencyKey,
    });
  const claimable = (customerId: string) =>
    container.referralSignupGifts.claimableFor(tenantA, customerId);

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panel as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', container.clock.now());
    return created.id;
  }

  async function confirmed(customerId: UserId, price = 100_000n): Promise<OrderRecord> {
    const order = await container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId: await product(price),
    });
    return container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: order.id,
    });
  }

  /** Paid from the buyer's wallet, topped up by an operator credit first. Returns the payment id. */
  async function paidFromWallet(order: OrderRecord): Promise<string> {
    await container.wallet.adjust(tenantA, owner, order.customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: order.totals.total.amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمون',
    });
    const { payment } = await container.payments.settleFromWallet(
      tenantA,
      customerActor(key()),
      order.customerId,
      { idempotencyKey: key(), orderId: order.id },
    );
    return payment.id;
  }

  const deliver = (orderId: string) =>
    db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE order_id = ${orderId}`);

  /** A paid order of `customerId`, delivered. Returns the order and its payment. */
  async function bought(customerId: UserId, price = 100_000n) {
    const order = await confirmed(customerId, price);
    const paymentId = await paidFromWallet(order);
    await deliver(order.id);
    return { order, paymentId };
  }

  async function refunded(paymentId: string, amountMinor: bigint): Promise<void> {
    const refund = await container.refunds.request(tenantA, owner, {
      idempotencyKey: key(),
      paymentId,
      amountMinor,
      reason: 'درخواست مشتری',
    });
    await container.refunds.complete(tenantA, finance, {
      idempotencyKey: key(),
      refundId: refund.id,
      note: 'واریز شد',
      externalReference: null,
    });
  }

  const giftEntries = () =>
    rows<{ customer_id: string; amount: string }>(
      sql`SELECT customer_id, amount::text AS amount FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} AND reason = 'REFERRAL_SIGNUP_GIFT'
           ORDER BY created_at, id`,
    );

  const giftRows = () =>
    rows<{
      referral_id: string;
      referrer_claimed_at: Date | null;
      referee_claimed_at: Date | null;
    }>(
      sql`SELECT referral_id, referrer_claimed_at, referee_claimed_at
            FROM referral_signup_gifts WHERE tenant_id = ${tenantA.tenantId}
           ORDER BY created_at, id`,
    );

  /** Every customer's ledger, as (customer, entries, signed sum): what "no balance moved" means. */
  const ledger = () =>
    rows<{ customer_id: string; entries: number; net: string }>(
      sql`SELECT customer_id, count(*)::int AS entries,
                 SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS net
            FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId}
           GROUP BY customer_id ORDER BY customer_id`,
    );

  const commissions = () =>
    rows<{
      order_id: string;
      referrer_id: string;
      state: string;
      earned_amount: string | null;
      not_before: Date | null;
      voided_at: Date | null;
    }>(
      sql`SELECT order_id, referrer_id, state, earned_amount::text AS earned_amount, not_before, voided_at
            FROM order_referral_commissions WHERE tenant_id = ${tenantA.tenantId}
           ORDER BY created_at, id`,
    );

  return {
    key,
    rows,
    setFlag,
    setSetting,
    program,
    guard,
    registered,
    referrerWith,
    claim,
    claimable,
    confirmed,
    paidFromWallet,
    deliver,
    bought,
    refunded,
    giftEntries,
    giftRows,
    ledger,
    commissions,
  };
}

type Fixtures = ReturnType<typeof fixtures>;

describe('the referral abuse guard (R10 D5 b)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let f: Fixtures;
  let getMe: Awaited<ReturnType<typeof fakeGetMe>>;
  let panelId: string;

  const SHARE = referralSignupGiftShares(100_000n, 50).referrer;

  beforeAll(async () => {
    getMe = await fakeGetMe();
    ctx = await createTestContext({ TELEGRAM_API_BASE_URL: getMe.url });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await getMe?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    panelId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-guard', roleKeys: ['owner'] }),
    );
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-guard',
        roleKeys: ['finance'],
      }),
    );
    f = fixtures(ctx.container, owner, finance, panelId);
  });

  // -------------------------------------------------------------------------------------
  // 1. The purchase condition
  // -------------------------------------------------------------------------------------

  describe('the gift waits for the referee’s first paid, delivered purchase', () => {
    it('offers neither side, pays nothing and writes no gift row while the referee has bought nothing', async () => {
      await f.program();
      await f.guard();
      const {
        referrer,
        referees: [referee],
      } = await f.referrerWith(1);

      expect(await f.claimable(referee as string)).toEqual([]);
      expect(await f.claimable(referrer)).toEqual([]);
      // The claim is what a `rg:` tap calls, drawn or crafted: it reads the LOCKED set,
      // so the purchase condition must hold there and not only on the button.
      for (const claimant of [referee as string, referrer]) {
        expect(await f.claim(claimant)).toEqual({ credited: money(0n, 'IRT'), claimedCount: 0 });
      }
      expect(await f.giftEntries()).toEqual([]);
      // Skipped BEFORE the gift row: no snapshot of today's terms for a side not payable.
      expect(await f.giftRows()).toEqual([]);
    });

    it('opens BOTH sides once the referee has a paid order that was delivered', async () => {
      await f.program();
      await f.guard();
      const {
        referrer,
        referees: [referee],
        referralIds: [referralId],
      } = await f.referrerWith(1);

      const { order } = await f.bought(referee as UserId);
      expect(await f.claimable(referee as string)).toEqual([{ referralId, side: 'REFEREE' }]);
      expect(await f.claimable(referrer)).toEqual([{ referralId, side: 'REFERRER' }]);
      expect((await f.claim(referee as string)).credited).toEqual(money(SHARE, 'IRT'));
      expect((await f.claim(referrer)).credited).toEqual(money(SHARE, 'IRT'));
      expect(await f.giftEntries()).toHaveLength(2);
      expect(order.purpose).toBe('NEW_SERVICE');
    });

    it('never counts a paid order that was not delivered, or whose delivery failed', async () => {
      await f.program();
      await f.guard();
      const {
        referrer,
        referees: [referee],
      } = await f.referrerWith(1);

      const order = await f.confirmed(referee as UserId);
      await f.paidFromWallet(order);
      expect(await f.claimable(referrer)).toEqual([]);

      await ctx.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET state = 'FAILED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${order.id}`);
      expect(await f.claimable(referrer)).toEqual([]);
      expect((await f.claim(referrer)).claimedCount).toBe(0);
    });

    it('never counts a trial, even a delivered one', async () => {
      await f.program();
      await f.guard();
      const {
        referrer,
        referees: [referee],
      } = await f.referrerWith(1);
      const current = await ctx.container.panelTrials.get(tenantA, owner, panelId);
      await ctx.container.panelTrials.update(tenantA, owner, panelId, {
        idempotencyKey: f.key(),
        expectedRevision: current.revision,
        enabled: true,
        trafficAmount: '100',
        trafficUnit: 'MB',
        durationHours: 72,
        label: null,
      });
      const issued = await ctx.container.trials.claim(
        tenantA,
        customerActor('trial'),
        referee as UserId,
        {
          idempotencyKey: f.key(),
          panelId,
        },
      );
      expect(issued.outcome).toBe('ISSUED');
      const [trial] = await f.rows<{ id: string }>(
        sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId}
              AND customer_id = ${referee as string} AND purpose = 'TRIAL'`,
      );
      await f.deliver(trial?.id as string);

      expect(await f.claimable(referrer)).toEqual([]);
      expect(await f.claimable(referee as string)).toEqual([]);
      expect((await f.claim(referee as string)).claimedCount).toBe(0);
    });

    it('never pays a Mirza referral, purchase or not', async () => {
      await f.program();
      await f.guard();
      const {
        referrer,
        referees: [referee],
        referralIds: [referralId],
      } = await f.referrerWith(1);
      await f.bought(referee as UserId);
      // What the import writes; the table is append-only, so marked as only a superuser could.
      const db = ctx.container.database.db;
      await db.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
      await db.execute(sql`
        UPDATE referrals SET source = 'MIRZA', source_ref = ${`referral:${referralId as string}`}
         WHERE id = ${referralId as string}`);
      await db.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
      expect(await f.claimable(referrer)).toEqual([]);
      expect((await f.claim(referrer)).claimedCount).toBe(0);
      expect(await f.giftRows()).toEqual([]);
    });

    it('keeps today’s rule with the guard on and the unlock set to the attribution', async () => {
      await f.program();
      await f.guard({ unlock: 'ON_ATTRIBUTION' });
      const {
        referrer,
        referees: [referee],
        referralIds: [referralId],
      } = await f.referrerWith(1);
      expect(await f.claimable(referrer)).toEqual([{ referralId, side: 'REFERRER' }]);
      expect((await f.claim(referee as string)).credited).toEqual(money(SHARE, 'IRT'));
    });

    it('yields one entry per side under two concurrent claims once qualified', async () => {
      await f.program();
      await f.guard();
      const {
        referees: [referee],
      } = await f.referrerWith(1);
      await f.bought(referee as UserId);
      const results = await Promise.all([f.claim(referee as string), f.claim(referee as string)]);
      expect(results.map((r) => r.claimedCount).sort()).toEqual([0, 1]);
      expect(await f.giftEntries()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. The switch moves no money
  // -------------------------------------------------------------------------------------

  it('leaves every balance and every stamped side as it was when the guard is turned on and off', async () => {
    await f.program();
    const {
      referrer,
      referees: [referee],
    } = await f.referrerWith(1);
    // Before the guard: the referee claims; the referrer does not yet.
    expect((await f.claim(referee as string)).claimedCount).toBe(1);
    const ledgerBefore = await f.ledger();
    const stampsBefore = await f.giftRows();

    await f.guard({ giftCap: 1, commissionCap: 1 });
    expect(await f.ledger()).toEqual(ledgerBefore);
    expect(await f.giftRows()).toEqual(stampsBefore);
    // The unstamped side — the other half of a half-claimed gift — now waits for a purchase.
    expect(await f.claimable(referrer)).toEqual([]);
    expect((await f.claim(referrer)).claimedCount).toBe(0);
    expect(await f.ledger()).toEqual(ledgerBefore);

    await f.setFlag('referral_abuse_guard', false);
    expect(await f.ledger()).toEqual(ledgerBefore);
    expect(await f.giftRows()).toEqual(stampsBefore);
    // Off is the old rule again, with nothing to undo.
    expect((await f.claim(referrer)).claimedCount).toBe(1);
  });

  // -------------------------------------------------------------------------------------
  // 3. The daily gift cap
  // -------------------------------------------------------------------------------------

  describe('the referrer’s daily gift cap', () => {
    const today = () =>
      new TenantReferralDayCalendar(ctx.container.database.db).dayOf(tenantA, new Date());

    it('pays two referrer shares today and the third on the next local day; referee shares are never capped', async () => {
      await f.program();
      await f.guard({ giftCap: 2 });
      const { referrer, referees } = await f.referrerWith(3);
      for (const referee of referees) await f.bought(referee);

      const first = await f.claim(referrer);
      expect(first).toMatchObject({
        credited: money(SHARE * 2n, 'IRT'),
        claimedCount: 2,
        cappedCount: 1,
      });
      // Not lost: still offered, and a second claim today pays nothing more.
      expect(await f.claimable(referrer)).toHaveLength(1);
      expect(await f.claim(referrer)).toMatchObject({ claimedCount: 0, cappedCount: 1 });

      // Every referee is paid in full on the same day: the cap is the referrer's only.
      for (const referee of referees) {
        expect((await f.claim(referee)).credited).toEqual(money(SHARE, 'IRT'));
      }

      // The next local day: the two shares paid today now belong to yesterday.
      await ctx.container.database.db.execute(sql`
        UPDATE referral_signup_gifts SET referrer_claimed_at = referrer_claimed_at - interval '1 day'
         WHERE tenant_id = ${tenantA.tenantId} AND referrer_claimed_at IS NOT NULL`);
      // Nothing held back: the result is the one a claim always returned.
      expect(await f.claim(referrer)).toEqual({ credited: money(SHARE, 'IRT'), claimedCount: 1 });
      expect(await f.claimable(referrer)).toEqual([]);
    });

    it('counts a share stamped at the day’s first instant, and not one at the next day’s', async () => {
      await f.program();
      await f.guard({ giftCap: 1 });
      const {
        referrer,
        referees: [one, two, three],
      } = await f.referrerWith(3);
      await f.bought(one as UserId);
      expect((await f.claim(referrer)).claimedCount).toBe(1);
      const day = await today();

      // The paid share stamped exactly at the END of today — the next day's first instant:
      // outside `[start, end)`, so today has room for one more.
      await ctx.container.database.db.execute(sql`
        UPDATE referral_signup_gifts SET referrer_claimed_at = ${day.end}
         WHERE tenant_id = ${tenantA.tenantId} AND referrer_claimed_at IS NOT NULL`);
      await f.bought(two as UserId);
      expect(await f.claim(referrer)).toEqual({ credited: money(SHARE, 'IRT'), claimedCount: 1 });

      // Both paid shares stamped exactly at the START of today: inside it, so the cap of one
      // is reached and the third waits.
      await ctx.container.database.db.execute(sql`
        UPDATE referral_signup_gifts SET referrer_claimed_at = ${day.start}
         WHERE tenant_id = ${tenantA.tenantId} AND referrer_claimed_at IS NOT NULL`);
      await f.bought(three as UserId);
      expect(await f.claim(referrer)).toMatchObject({ claimedCount: 0, cappedCount: 1 });
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. The daily commission cap
  // -------------------------------------------------------------------------------------

  describe('the referrer’s daily commission cap', () => {
    let clock: TestClock;
    let earner: ReferralCommissionService;

    beforeEach(() => {
      clock = new TestClock();
      const db = ctx.container.database.db;
      earner = new ReferralCommissionService({
        commissions: new DrizzleReferralCommissionRepository(db),
        wallet: new DrizzleWalletRepository(db),
        payments: new DrizzlePaymentRepository(db),
        refunds: new DrizzleRefundRepository(db),
        outbox: ctx.container.outbox,
        uow: ctx.container.uow,
        scopeActivity: ctx.container.tenants,
        clock,
        ids: ctx.container.ids,
        abuse: {
          features: ctx.container.featureFlagResolver,
          settings: ctx.container.settingsResolver,
          days: new TenantReferralDayCalendar(db),
        },
      });
    });

    const scope: TenantContext = tenantA;

    it('earns one per day and DEFERS the rest — still pending, never voided — to the next local day', async () => {
      await f.program('EVERY_PAID_ORDER');
      await f.guard({ commissionCap: 1 });
      const {
        referrer,
        referees: [referee],
      } = await f.referrerWith(1);
      for (let i = 0; i < 3; i += 1) await f.bought(referee as UserId);

      expect(await earner.settleDue(scope, 50)).toBe(1);
      const day = await new TenantReferralDayCalendar(ctx.container.database.db).dayOf(
        scope,
        clock.now(),
      );
      const after = await f.commissions();
      expect(after.map((row) => row.state)).toEqual(['EARNED', 'PENDING', 'PENDING']);
      for (const held of after.slice(1)) {
        expect(held.voided_at).toBeNull();
        expect(new Date(held.not_before ?? 0).getTime()).toBe(day.end.getTime());
        expect(held.referrer_id).toBe(referrer);
      }
      // A second tick the same day moves nothing and voids nothing.
      expect(await earner.settleDue(scope, 50)).toBe(0);
      expect((await f.commissions()).filter((row) => row.state === 'VOID')).toEqual([]);

      // The next local day: one more, and the last deferred again.
      clock.advance(DAY);
      expect(await earner.settleDue(scope, 50)).toBe(1);
      expect((await f.commissions()).map((row) => row.state)).toEqual([
        'EARNED',
        'EARNED',
        'PENDING',
      ]);
      clock.advance(DAY);
      expect(await earner.settleDue(scope, 50)).toBe(1);
      expect((await f.commissions()).map((row) => row.state)).toEqual([
        'EARNED',
        'EARNED',
        'EARNED',
      ]);
    });

    it('never lets a held commission stand in front of the queue behind it', async () => {
      await f.program('EVERY_PAID_ORDER');
      await f.guard({ commissionCap: 1 });
      const {
        referees: [busy],
      } = await f.referrerWith(1);
      for (let i = 0; i < 3; i += 1) await f.bought(busy as UserId);
      expect(await earner.settleDue(scope, 50)).toBe(1);

      // Another referrer's commission, promised AFTER the two held ones.
      const {
        referrer: other,
        referees: [quiet],
      } = await f.referrerWith(1);
      const { order } = await f.bought(quiet as UserId);
      // A batch of two: the held two are older, and must not be what the batch is spent on.
      expect(await earner.settleDue(scope, 2)).toBe(1);
      const row = (await f.commissions()).find((one) => one.order_id === order.id);
      expect(row).toMatchObject({ state: 'EARNED', referrer_id: other });
    });

    it('earns a held commission later from the refunds as they stand then, never below zero', async () => {
      await f.program('EVERY_PAID_ORDER');
      await f.guard({ commissionCap: 1 });
      const {
        referees: [referee],
      } = await f.referrerWith(1);
      await f.bought(referee as UserId);
      const held = await f.bought(referee as UserId);
      expect(await earner.settleDue(scope, 50)).toBe(1);

      // Refunded in part while it waits: the earner reads the COMPLETED refund the next day.
      await f.refunded(held.paymentId, 40_000n);
      clock.advance(DAY);
      expect(await earner.settleDue(scope, 50)).toBe(1);
      const row = (await f.commissions()).find((one) => one.order_id === held.order.id);
      expect(row?.state).toBe('EARNED');
      expect(row?.earned_amount).toBe(
        proportionalTargetMinor(10_000n, 100_000n, 40_000n).toString(),
      );
      expect(BigInt(row?.earned_amount ?? '-1')).toBeGreaterThanOrEqual(0n);
    });

    it('earns a held commission at once when the guard is turned off: nothing to undo', async () => {
      await f.program('EVERY_PAID_ORDER');
      await f.guard({ commissionCap: 1 });
      const {
        referees: [referee],
      } = await f.referrerWith(1);
      await f.bought(referee as UserId);
      await f.bought(referee as UserId);
      expect(await earner.settleDue(scope, 50)).toBe(1);
      await f.setFlag('referral_abuse_guard', false);
      expect(await earner.settleDue(scope, 50)).toBe(1);
      expect((await f.commissions()).map((row) => row.state)).toEqual(['EARNED', 'EARNED']);
    });

    it('lets the deferral move ONLY the hold of a pending commission (the guard trigger, 0283)', async () => {
      await f.program('EVERY_PAID_ORDER');
      await f.guard({ commissionCap: 1 });
      const {
        referees: [referee],
      } = await f.referrerWith(1);
      const first = await f.bought(referee as UserId);
      const second = await f.bought(referee as UserId);
      await earner.settleDue(scope, 50);
      const db = ctx.container.database.db;
      const refused = { cause: { code: '23001' } };
      const update = (orderId: string, assignment: SQL) =>
        db.execute(
          sql`UPDATE order_referral_commissions SET ${assignment} WHERE order_id = ${orderId}`,
        );

      // PENDING -> PENDING touching anything but the hold is still refused.
      await expect(update(second.order.id, sql`earned_amount = 1`)).rejects.toMatchObject(refused);
      await expect(update(second.order.id, sql`voided_at = now()`)).rejects.toMatchObject(refused);
      await expect(update(second.order.id, sql`not_before = NULL`)).rejects.toMatchObject(refused);
      // An EARNED commission's hold does not move at all.
      await expect(update(first.order.id, sql`not_before = now()`)).rejects.toMatchObject(refused);
      // The one allowed change.
      await update(second.order.id, sql`not_before = now() + interval '1 hour'`);
    });
  });
});
