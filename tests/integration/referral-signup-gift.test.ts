import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  money,
  proportionalTargetMinor,
  referralSignupGiftReference,
  referralSignupGiftShares,
  type ActorContext,
  type BotInstanceId,
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
 * The referral signup gift and the referral statistics
 * (`docs/customer-ux-completion-audit.md` §I, §O3, §O4).
 *
 * The rules under test, each a way to pay somebody twice, pay somebody who is not owed,
 * or tell a customer a figure that is not theirs:
 *
 * - each side of a referral is ONE `REFERRAL_SIGNUP_GIFT` credit, to that side's wallet,
 *   and the two sides always sum to the total snapshotted at the first claim;
 * - a replay, a second tap and two concurrent taps yield exactly one entry per side;
 * - the terms are held coherent by two guards, one on the settings while the gift is on
 *   and one on the flag turning on, and a claim against inactive terms is refused;
 * - a zero share is never paid and never offered;
 * - every read and write is tenant-scoped;
 * - the statistics count delivered, paid-for orders of the referees and the commission
 *   net of what refunds took back — the purchase commission's own behaviour unchanged.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const BOT_USERNAME = 'acme_store_bot';

interface FakeGetMe {
  readonly url: string;
  close(): Promise<void>;
}

/** A stand-in for Telegram's `getMe`, which the invite asks for the bot's current name. */
async function fakeGetMe(): Promise<FakeGetMe> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { id: 7001, username: BOT_USERNAME } }));
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

interface GiftTerms {
  readonly totalMinor?: bigint;
  readonly referrerPercent?: number;
  readonly referredPercent?: number;
  readonly enabled?: boolean;
}

function fixtures(container: Container, owner: ActorContext, finance: ActorContext, panel: string) {
  let n = 0;
  const key = (): string => `gift-key-${(n += 1)}`;
  const db = container.database.db;
  const products = new DrizzleProductRepository(db);

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db.execute(query as never)) as unknown as { rows: T[] }).rows;
  }
  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

  // -- Terms, set the way an operator sets them --------------------------------------

  async function setFlag(
    flagKey: 'referrals' | 'referral_signup_gift',
    enabled: boolean,
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ) {
    const before = (await container.featureFlags.list(scope, actor)).find(
      (flag) => flag.key === flagKey,
    );
    if (before === undefined) throw new Error(`no ${flagKey} flag`);
    return container.featureFlags.set(scope, actor, {
      idempotencyKey: key(),
      key: flagKey,
      enabled,
      expectedVersion: before.version,
      confirmKey: flagKey,
      reason: 'test toggle',
    });
  }

  async function setSetting(
    settingKey: string,
    value: unknown,
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ) {
    const before = await container.settingsService.get(scope, actor, settingKey);
    return container.settingsService.set(scope, actor, {
      idempotencyKey: key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  /** The purchase commission program: 10%, first paid order, on. */
  async function program(scope: TenantContext = tenantA, actor: ActorContext = owner) {
    await setSetting('referral.commission_percent', 10, scope, actor);
    await setFlag('referrals', true, scope, actor);
  }

  /** The gift's terms, settings first and the flag last, as an operator would. */
  async function gift(
    terms: GiftTerms = {},
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ) {
    await setSetting(
      'referral.signup_gift.total',
      { amountMinor: (terms.totalMinor ?? 100_000n).toString(), currency: 'IRT' },
      scope,
      actor,
    );
    await setSetting(
      'referral.signup_gift.referrer_percent',
      terms.referrerPercent ?? 50,
      scope,
      actor,
    );
    await setSetting(
      'referral.signup_gift.referred_percent',
      terms.referredPercent ?? 50,
      scope,
      actor,
    );
    await setFlag('referral_signup_gift', terms.enabled ?? true, scope, actor);
  }

  // -- Customers and their links ----------------------------------------------------

  const register = (
    telegramUserId: string,
    startPayload: string | null = null,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ) =>
    container.customers.resolveFromUpdate(scope, customerActor(key()), {
      idempotencyKey: key(),
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مهسا' },
      botInstanceId: bot,
      ...(startPayload === null ? {} : { startPayload }),
    });

  const registered = async (
    telegramUserId: string,
    startPayload: string | null = null,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<UserId> => (await register(telegramUserId, startPayload, scope, bot)).customer.id;

  async function codeOf(
    customerId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<string> {
    const invited = await container.referrals.invite(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      botInstanceId: bot,
    });
    if (invited.outcome !== 'READY') throw new Error(`no code: ${invited.outcome}`);
    return invited.code;
  }

  /** A referrer with a recorded code, and a NEW customer who arrived through it. */
  async function referred(
    referrerTelegramId = '940001',
    refereeTelegramId = '940002',
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<{ referrer: UserId; referee: UserId; referralId: string }> {
    const referrer = await registered(referrerTelegramId, null, scope, bot);
    const code = await codeOf(referrer, scope, bot);
    const referee = await registered(refereeTelegramId, `ref-${code}`, scope, bot);
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM referrals WHERE tenant_id = ${scope.tenantId} AND referee_id = ${referee}`,
    );
    if (row === undefined) throw new Error('no referral was attributed');
    return { referrer, referee, referralId: row.id };
  }

  // -- The gift ----------------------------------------------------------------------

  const claim = (customerId: string, idempotencyKey = key(), scope: TenantContext = tenantA) =>
    container.referralSignupGifts.claim(scope, customerActor(key()), customerId, {
      idempotencyKey,
    });

  const claimable = (customerId: string, scope: TenantContext = tenantA) =>
    container.referralSignupGifts.claimableFor(scope, customerId);

  const stats = (customerId: string, scope: TenantContext = tenantA) =>
    container.referralSignupGifts.stats(scope, customerId);

  // -- Orders, payments, delivery and refunds -------------------------------------------

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
      },
      now: container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', container.clock.now());
    return created.id;
  }

  async function confirmed(customerId: UserId, price: bigint): Promise<OrderRecord> {
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

  const adjust = (customerId: string, amountMinor: bigint) =>
    container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمون',
    });

  /** Paid from the referee's wallet. Returns the payment id. */
  async function paidFromWallet(order: OrderRecord): Promise<string> {
    await adjust(order.customerId, order.totals.total.amountMinor);
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

  // -- What the database says --------------------------------------------------------------

  const giftEntries = (scope: TenantContext = tenantA) =>
    rows<{ customer_id: string; amount: string; reference: string; currency: string }>(
      sql`SELECT customer_id, amount::text AS amount, reference, currency
            FROM wallet_entries
           WHERE tenant_id = ${scope.tenantId} AND reason = 'REFERRAL_SIGNUP_GIFT'
           ORDER BY created_at, id`,
    );

  const giftRows = () =>
    rows<{
      referral_id: string;
      total_amount: string;
      referrer_amount: string;
      referee_amount: string;
      referrer_claimed_at: string | null;
      referee_claimed_at: string | null;
    }>(
      sql`SELECT referral_id, total_amount::text AS total_amount, referrer_amount::text AS referrer_amount,
                 referee_amount::text AS referee_amount, referrer_claimed_at, referee_claimed_at
            FROM referral_signup_gifts ORDER BY created_at, id`,
    );

  const events = (eventType: string) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = ${eventType}`);

  const audits = (action: string) =>
    rows<{ entity_id: string; after: Record<string, unknown> }>(
      sql`SELECT entity_id, after FROM audit_logs WHERE action = ${action} ORDER BY occurred_at, id`,
    );

  return {
    key,
    rows,
    count,
    setFlag,
    setSetting,
    program,
    gift,
    register,
    registered,
    codeOf,
    referred,
    claim,
    claimable,
    stats,
    confirmed,
    paidFromWallet,
    deliver,
    refunded,
    giftEntries,
    giftRows,
    events,
    audits,
  };
}

type Fixtures = ReturnType<typeof fixtures>;

describe('the referral signup gift and the referral statistics', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let f: Fixtures;
  let getMe: FakeGetMe;

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
    const panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-gift', roleKeys: ['owner'] }),
    );
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-gift',
        roleKeys: ['finance'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-gift-b', roleKeys: ['owner'] }),
    );
    f = fixtures(ctx.container, owner, finance, panelA);
    await f.program();
  });

  // -------------------------------------------------------------------------
  // 1. Each side, one credit, to its own wallet
  // -------------------------------------------------------------------------

  describe('the claim', () => {
    it('credits the referee exactly their share as ONE REFERRAL_SIGNUP_GIFT entry, with the event and the audit row', async () => {
      await f.gift({ totalMinor: 100_000n, referrerPercent: 50, referredPercent: 50 });
      const { referee, referrer, referralId } = await f.referred();

      expect(await f.claimable(referee)).toEqual([{ referralId, side: 'REFEREE' }]);
      const before = await f.events('WalletEntryRecorded');

      const result = await f.claim(referee);

      expect(result).toEqual({ credited: money(50_000n, 'IRT'), claimedCount: 1 });
      expect(await f.giftEntries()).toEqual([
        {
          customer_id: referee,
          amount: '50000',
          reference: referralSignupGiftReference(referralId, 'REFEREE'),
          currency: 'IRT',
        },
      ]);
      expect(await f.events('WalletEntryRecorded')).toBe(before + 1);
      expect(await f.claimable(referee)).toEqual([]);
      // The referrer's side is untouched: still claimable, nothing credited to them.
      expect(await f.claimable(referrer)).toEqual([{ referralId, side: 'REFERRER' }]);

      const [audit] = await f.audits('referral.signup_gift.claim');
      expect(audit?.entity_id).toBe(referee);
      expect(audit?.after).toMatchObject({
        claimedCount: 1,
        creditedMinor: '50000',
        currency: 'IRT',
      });
    });

    it('credits the referrer their share as a SEPARATE entry to the referrer wallet, and the two sum to the total', async () => {
      // 33% of 100,001 rounds down to 33,000; the referee's complement is 67,001.
      await f.gift({ totalMinor: 100_001n, referrerPercent: 33, referredPercent: 67 });
      const { referee, referrer, referralId } = await f.referred();
      const shares = referralSignupGiftShares(100_001n, 33);

      const refereeResult = await f.claim(referee);
      const referrerResult = await f.claim(referrer);

      expect(refereeResult.credited).toEqual(money(shares.referee, 'IRT'));
      expect(referrerResult.credited).toEqual(money(shares.referrer, 'IRT'));
      const entries = await f.giftEntries();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.customer_id).sort()).toEqual([referee, referrer].sort());
      expect(entries.map((e) => e.reference).sort()).toEqual(
        [
          referralSignupGiftReference(referralId, 'REFEREE'),
          referralSignupGiftReference(referralId, 'REFERRER'),
        ].sort(),
      );
      expect(entries.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(100_001n);

      const [row] = await f.giftRows();
      expect(row).toMatchObject({
        referral_id: referralId,
        total_amount: '100001',
        referrer_amount: '33000',
        referee_amount: '67001',
      });
      expect(row?.referrer_claimed_at).not.toBeNull();
      expect(row?.referee_claimed_at).not.toBeNull();
    });

    it('pays the second side the complement of the SNAPSHOTTED total, whatever the settings say by then', async () => {
      await f.gift({ totalMinor: 100_000n });
      const { referee, referrer } = await f.referred();
      await f.claim(referee);

      // The operator raises the gift afterwards. The referrer's side was snapshotted.
      await f.setSetting('referral.signup_gift.total', { amountMinor: '900000', currency: 'IRT' });
      const result = await f.claim(referrer);

      expect(result.credited).toEqual(money(50_000n, 'IRT'));
      expect((await f.giftEntries()).reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(100_000n);
    });

    it('answers a customer with no attribution with claimedCount 0 and writes nothing', async () => {
      await f.gift();
      const alone = await f.registered('940009');

      expect(await f.claimable(alone)).toEqual([]);
      const result = await f.claim(alone);

      expect(result).toEqual({ credited: money(0n, 'IRT'), claimedCount: 0 });
      expect(await f.giftEntries()).toEqual([]);
      expect(await f.giftRows()).toEqual([]);
      expect(await f.audits('referral.signup_gift.claim')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Exactly once
  // -------------------------------------------------------------------------

  describe('exactly once', () => {
    it('replays the same key with the first result and credits nothing more on a new key', async () => {
      await f.gift();
      const { referee } = await f.referred();
      const first = await f.claim(referee, 'gift-replay-1');

      const replayed = await f.claim(referee, 'gift-replay-1');
      const again = await f.claim(referee, 'gift-replay-2');

      expect(replayed).toEqual(first);
      expect(again).toEqual({ credited: money(0n, 'IRT'), claimedCount: 0 });
      expect(await f.giftEntries()).toHaveLength(1);
    });

    it('yields exactly one entry per side under two CONCURRENT claims by the same customer', async () => {
      await f.gift();
      const { referee, referrer } = await f.referred();

      const [a, b] = await Promise.all([
        f.claim(referee, 'gift-race-a'),
        f.claim(referee, 'gift-race-b'),
      ]);
      const [c, d] = await Promise.all([
        f.claim(referrer, 'gift-race-c'),
        f.claim(referrer, 'gift-race-d'),
      ]);

      expect(a.claimedCount + b.claimedCount).toBe(1);
      expect(c.claimedCount + d.claimedCount).toBe(1);
      const entries = await f.giftEntries();
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.customer_id === referee)).toHaveLength(1);
      expect(entries.filter((e) => e.customer_id === referrer)).toHaveLength(1);
      expect(await f.giftRows()).toHaveLength(1);
    });

    it('yields exactly one gift row when BOTH sides claim concurrently for the first time', async () => {
      await f.gift();
      const { referee, referrer } = await f.referred();

      const [a, b] = await Promise.all([
        f.claim(referee, 'gift-both-a'),
        f.claim(referrer, 'gift-both-b'),
      ]);

      expect(a.claimedCount).toBe(1);
      expect(b.claimedCount).toBe(1);
      expect(await f.giftRows()).toHaveLength(1);
      expect((await f.giftEntries()).reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(100_000n);
    });

    it('holds the ledger reference unique per (referral, side) as the backstop', async () => {
      await f.gift();
      const { referee, referralId } = await f.referred();
      await f.claim(referee);
      await expect(
        ctx.container.database.db.execute(sql`
          INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${referee}, 'CREDIT', 'REFERRAL_SIGNUP_GIFT',
                  1, 'IRT', ${referralSignupGiftReference(referralId, 'REFEREE')})`),
      ).rejects.toMatchObject({ cause: { constraint: 'wallet_entries_tenant_reference_key' } });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it("never credits tenant B's referral through tenant A's claim, and scopes every count", async () => {
      await f.program(tenantB, ownerB);
      await f.gift({}, tenantB, ownerB);
      await f.gift();
      // The same Telegram user is a customer of BOTH tenants: referred in B, alone in A.
      const inB = await f.referred('950001', '950002', tenantB, BOT_B);
      const inA = await f.registered('950002');

      const result = await f.claim(inA);

      expect(result).toEqual({ credited: money(0n, 'IRT'), claimedCount: 0 });
      expect(await f.giftEntries(tenantA)).toEqual([]);
      expect(await f.giftEntries(tenantB)).toEqual([]);
      expect(await f.claimable(inA)).toEqual([]);
      expect(await f.claimable(inB.referee, tenantB)).toEqual([
        { referralId: inB.referralId, side: 'REFEREE' },
      ]);
      expect((await f.stats(inB.referrer, tenantB)).referralCount).toBe(1);

      // Tenant B's referee named under tenant A is not a customer there at all.
      await expect(f.claim(inB.referee, f.key(), tenantA)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. The terms: the flag, the two guards, and the zero share
  // -------------------------------------------------------------------------

  describe('the terms', () => {
    it('refuses a claim with REFERRAL_GIFT_DISABLED while the flag is off, and offers nothing', async () => {
      await f.gift({ enabled: false });
      const { referee } = await f.referred();

      expect(await f.claimable(referee)).toEqual([]);
      await expect(f.claim(referee)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED,
      });
      expect(await f.giftEntries()).toEqual([]);
    });

    it('is inactive while the referral program itself is off, even with the gift flag on', async () => {
      await f.gift();
      const { referee } = await f.referred();
      await f.setFlag('referrals', false);

      expect((await ctx.container.referralSignupGifts.terms(tenantA)).active).toBe(false);
      await expect(f.claim(referee)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED,
      });
    });

    it('refuses a share or a total that breaks the terms WHILE the gift is on, and accepts it while off', async () => {
      await f.gift({ referrerPercent: 50, referredPercent: 50 });

      // 60 + 50 is not a whole.
      await expect(f.setSetting('referral.signup_gift.referrer_percent', 60)).rejects.toMatchObject(
        { code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID },
      );
      await expect(f.setSetting('referral.signup_gift.referred_percent', 60)).rejects.toMatchObject(
        { code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID },
      );
      await expect(
        f.setSetting('referral.signup_gift.total', { amountMinor: '0', currency: 'IRT' }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID });
      // Nothing was stored.
      expect(
        (
          await ctx.container.settingsService.get(
            tenantA,
            owner,
            'referral.signup_gift.referrer_percent',
          )
        ).value,
      ).toBe(50);

      // A move that keeps the whole is fine: 40 + 60 after two steps through 40 + 50 would
      // not be, so the operator switches the gift off, edits, and switches it back on.
      await f.setFlag('referral_signup_gift', false);
      await f.setSetting('referral.signup_gift.referrer_percent', 60);
      await f.setSetting('referral.signup_gift.referred_percent', 40);
      await f.setFlag('referral_signup_gift', true);
      const terms = await ctx.container.referralSignupGifts.terms(tenantA);
      expect(terms).toMatchObject({ active: true, referrerPercent: 60, referredPercent: 40 });
    });

    it('refuses to turn the flag on over 60/30 or a zero total, and leaves it off', async () => {
      await f.gift({ referrerPercent: 60, referredPercent: 30, enabled: false });

      await expect(f.setFlag('referral_signup_gift', true)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
      });
      await f.setSetting('referral.signup_gift.referred_percent', 40);
      await f.setSetting('referral.signup_gift.total', { amountMinor: '0', currency: 'IRT' });
      await expect(f.setFlag('referral_signup_gift', true)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
      });

      const flag = (await ctx.container.featureFlags.list(tenantA, owner)).find(
        (row) => row.key === 'referral_signup_gift',
      );
      expect(flag?.enabled).toBe(false);
      // Switching OFF is never guarded: the same command with `enabled: false` is accepted.
      await f.setFlag('referral_signup_gift', false);
    });

    it('pays the referee the whole total and offers the referrer nothing when the referrer share is 0', async () => {
      await f.gift({ totalMinor: 100_000n, referrerPercent: 0, referredPercent: 100 });
      const { referee, referrer } = await f.referred();

      expect(await f.claimable(referrer)).toEqual([]);
      const referrerResult = await f.claim(referrer);
      const refereeResult = await f.claim(referee);

      expect(referrerResult).toEqual({ credited: money(0n, 'IRT'), claimedCount: 0 });
      expect(refereeResult).toEqual({ credited: money(100_000n, 'IRT'), claimedCount: 1 });
      const entries = await f.giftEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.customer_id).toBe(referee);
      // The row was snapshotted by the referrer's (empty) claim and pinned the zero share.
      const [row] = await f.giftRows();
      expect(row).toMatchObject({ referrer_amount: '0', referee_amount: '100000' });
      expect(row?.referrer_claimed_at).toBeNull();
      // Still nothing to offer the referrer afterwards.
      expect(await f.claimable(referrer)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Statistics, and the purchase commission regression (§O4)
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('counts delivered paid orders of the referees and the commission net of reversals', async () => {
      const { referrer, referee } = await f.referred('960001', '960002');
      const code = await f.codeOf(referrer);
      const second = await f.registered('960003', `ref-${code}`);

      // Nothing bought yet.
      expect(await f.stats(referrer)).toEqual({
        referralCount: 2,
        referredPurchaseCount: 0,
        referredPurchaseTotal: money(0n, 'IRT'),
        commissionReceivedTotal: money(0n, 'IRT'),
      });

      // One referee buys and is delivered; the commission is earned on delivery.
      const order = await f.confirmed(referee, 1_000_000n);
      const paymentId = await f.paidFromWallet(order);
      // Paid but not delivered: not a purchase yet, and no commission yet.
      expect(await f.stats(referrer)).toMatchObject({
        referredPurchaseCount: 0,
        commissionReceivedTotal: money(0n, 'IRT'),
      });
      await f.deliver(order.id);
      expect(await ctx.container.referralCommissions.settle(tenantA, order.id)).toBe(true);

      expect(await f.stats(referrer)).toEqual({
        referralCount: 2,
        referredPurchaseCount: 1,
        referredPurchaseTotal: money(1_000_000n, 'IRT'),
        commissionReceivedTotal: money(100_000n, 'IRT'),
      });

      // The other referee's undelivered order counts for nothing.
      const pending = await f.confirmed(second, 500_000n);
      await f.paidFromWallet(pending);
      expect((await f.stats(referrer)).referredPurchaseCount).toBe(1);

      // A partial refund takes back its share of the commission (F8), and stats follow the ledger.
      await f.refunded(paymentId, 400_000n);
      const kept = proportionalTargetMinor(100_000n, 1_000_000n, 400_000n);
      expect(kept).toBe(60_000n);
      expect(await f.stats(referrer)).toMatchObject({
        referredPurchaseCount: 1,
        commissionReceivedTotal: money(kept, 'IRT'),
      });

      // The referee, who referred nobody, has zeros — not the referrer's figures.
      expect(await f.stats(referee)).toEqual({
        referralCount: 0,
        referredPurchaseCount: 0,
        referredPurchaseTotal: money(0n, 'IRT'),
        commissionReceivedTotal: money(0n, 'IRT'),
      });
    });

    it('keeps the purchase commission independent of the gift: a gift claim earns no commission and a commission claims no gift', async () => {
      await f.gift();
      const { referrer, referee } = await f.referred();
      await f.claim(referee);
      await f.claim(referrer);

      const commissions = () =>
        f.count(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE reason = 'REFERRAL_COMMISSION'`,
        );
      expect(await commissions()).toBe(0);

      const order = await f.confirmed(referee, 1_000_000n);
      await f.paidFromWallet(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settle(tenantA, order.id);

      expect(await commissions()).toBe(1);
      expect(await f.giftEntries()).toHaveLength(2);
      expect((await f.stats(referrer)).commissionReceivedTotal).toEqual(money(100_000n, 'IRT'));
    });
  });
});
