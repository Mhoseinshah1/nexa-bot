import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  REFERRAL_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  customerReferralResponseSchema,
  money,
  proportionalTargetMinor,
  referralCodeFor,
  referralCommissionListResponseSchema,
  referralListResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ReferralCommissionScope,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, createTranslator } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import type { Container } from '../../apps/api/src/container';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type { ReferralInvite } from '../../apps/api/src/modules/commerce/referrals/application/referral-program';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type TestContext,
} from './harness';

/**
 * The referral program, from the link a customer arrives through to the commission their
 * referrer earns at delivery and gives back on refund (`docs/wp9-referral-audit.md`
 * F2–F12).
 *
 * The rules under test, each a way to pay somebody who is not owed, or to tell a stranger
 * something they should not learn:
 *
 * - attribution happens ONLY on the update that creates the referee, and every refusal is
 *   audited and never shown to the customer;
 * - a code is resolved inside the tenant, recorded once, and never reassigned;
 * - a commission is PROMISED at confirmation only when every condition holds then, and
 *   EARNED at delivery exactly once, into the REFERRER's wallet;
 * - under first-order scope one referral pays at most once, however many orders race;
 * - an order that ends undelivered earns nothing, and a refund takes back its share by the
 *   cumulative formula, never taking the referrer's wallet below zero;
 * - the records are append-only and a promise's terms are frozen, in the database;
 * - the operator's surfaces are read-only, permissioned and tenant-scoped.
 *
 * Delivery is simulated by moving the order's operation to `SUCCEEDED` in SQL, as
 * `cashback.test.ts` does: the provisioner's own path to that state has its suites.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const BOT_A_USERNAME = 'acme_store_bot';

/**
 * A stand-in for Telegram's `getMe`, which the invite asks for the bot's CURRENT name.
 * `username` null makes it refuse, as Telegram does a revoked token.
 */
interface FakeGetMe {
  readonly url: string;
  username: string | null;
  close(): Promise<void>;
}

async function fakeGetMe(): Promise<FakeGetMe> {
  const fake = { username: BOT_A_USERNAME as string | null };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      if (fake.username === null) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { id: 7001, username: fake.username } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return Object.assign(fake, {
    url: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface ProgramTerms {
  readonly enabled?: boolean;
  /** Omitted: 10. `null`: explicitly unconfigured. */
  readonly percent?: number | null;
  readonly scope?: ReferralCommissionScope;
  readonly minimum?: { readonly amountMinor: bigint; readonly currency: string };
}

/**
 * The fixtures both halves of this file share, bound to one container.
 *
 * A factory rather than two copies: the HTTP and Telegram half drives the same commerce
 * the service half does, and two copies of "paid and delivered" would drift apart.
 */
function fixtures(container: Container, owner: ActorContext, finance: ActorContext, panel: string) {
  let n = 0;
  const key = (): string => `referral-key-${(n += 1)}`;
  const db = container.database.db;
  const products = new DrizzleProductRepository(db);

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db.execute(query as never)) as unknown as { rows: T[] }).rows;
  }

  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

  // -- The program's terms, set the way an operator sets them -----------------

  async function setFlag(enabled: boolean, scope: TenantContext, actor: ActorContext) {
    const before = (await container.featureFlags.list(scope, actor)).find(
      (flag) => flag.key === 'referrals',
    );
    if (before === undefined) throw new Error('no referrals flag');
    await container.featureFlags.set(scope, actor, {
      idempotencyKey: key(),
      key: 'referrals',
      enabled,
      expectedVersion: before.version,
      // TENANT_WIDE: the flag names itself and says why (ADR-0010).
      confirmKey: 'referrals',
      reason: 'test toggle of the referral program',
    });
  }

  async function setSetting(
    settingKey: string,
    value: unknown,
    scope: TenantContext,
    actor: ActorContext,
  ) {
    const before = await container.settingsService.get(scope, actor, settingKey);
    await container.settingsService.set(scope, actor, {
      idempotencyKey: key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  async function program(
    terms: ProgramTerms = {},
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ): Promise<void> {
    await setSetting(
      'referral.commission_percent',
      terms.percent === undefined ? 10 : terms.percent,
      scope,
      actor,
    );
    if (terms.scope !== undefined) {
      await setSetting('referral.commission_scope', terms.scope, scope, actor);
    }
    if (terms.minimum !== undefined) {
      await setSetting(
        'referral.minimum_order_amount',
        { amountMinor: terms.minimum.amountMinor.toString(), currency: terms.minimum.currency },
        scope,
        actor,
      );
    }
    await setFlag(terms.enabled ?? true, scope, actor);
  }

  // -- Customers and their links ------------------------------------------------

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

  const invite = (
    customerId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<ReferralInvite> =>
    container.referrals.invite(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      botInstanceId: bot,
    });

  async function codeOf(customerId: string): Promise<string> {
    const invited = await invite(customerId);
    if (invited.outcome !== 'READY') throw new Error(`no code: ${invited.outcome}`);
    return invited.code;
  }

  /** A referrer with a recorded code, and a NEW customer who arrived through it. */
  async function referred(
    referrerTelegramId = '930001',
    refereeTelegramId = '930002',
  ): Promise<{ referrer: UserId; referee: UserId; code: string }> {
    const referrer = await registered(referrerTelegramId);
    const code = await codeOf(referrer);
    const referee = await registered(refereeTelegramId, `ref-${code}`);
    return { referrer, referee, code };
  }

  const block = (customerId: string) =>
    db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customerId}`,
    );

  // -- Orders, payments, delivery and refunds ------------------------------------

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

  async function draft(customerId: UserId, price: bigint): Promise<OrderRecord> {
    return container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId: await product(price),
    });
  }

  async function confirmed(customerId: UserId, price: bigint): Promise<OrderRecord> {
    const order = await draft(customerId, price);
    return container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: order.id,
    });
  }

  const adjust = (customerId: string, direction: 'CREDIT' | 'DEBIT', amountMinor: bigint) =>
    container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction,
      amountMinor,
      currency: 'IRT',
      note: direction === 'CREDIT' ? 'موجودی آزمون' : 'خرج شد',
    });

  /** Paid from the referee's wallet. Returns the payment id. */
  async function paidFromWallet(order: OrderRecord): Promise<string> {
    await adjust(order.customerId, 'CREDIT', order.totals.total.amountMinor);
    const { payment } = await container.payments.settleFromWallet(
      tenantA,
      customerActor(key()),
      order.customerId,
      { idempotencyKey: key(), orderId: order.id },
    );
    return payment.id;
  }

  /** Paid by a bank transfer an operator confirmed. Returns the payment id. */
  async function paidByTransfer(order: OrderRecord): Promise<string> {
    const { payment } = await container.payments.requestManualTransfer(
      tenantA,
      customerActor(key()),
      order.customerId,
      { idempotencyKey: key(), orderId: order.id },
    );
    await container.payments.confirmManualTransfer(tenantA, finance, payment.id, {
      idempotencyKey: key(),
      note: 'کارت به کارت',
    });
    return payment.id;
  }

  const deliver = (orderId: string) =>
    db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE order_id = ${orderId}`);

  const refund = (paymentId: string, amountMinor: bigint) =>
    container.refunds.request(tenantA, owner, {
      idempotencyKey: key(),
      paymentId,
      amountMinor,
      reason: 'درخواست مشتری',
    });

  const completeInput = (refundId: string) => ({
    idempotencyKey: key(),
    refundId,
    note: 'واریز شد',
    externalReference: null,
  });

  const complete = (refundId: string) =>
    container.refunds.complete(tenantA, owner, completeInput(refundId));

  // -- What the database says ------------------------------------------------------

  const commission = async (orderId: string) =>
    (
      await rows<{
        state: string;
        scope: string;
        percent: number;
        basis: string;
        amount: string;
        currency: string;
        earned_amount: string | null;
        referrer_id: string;
        referee_id: string;
      }>(
        sql`SELECT state, scope, percent, basis_amount::text AS basis, amount::text AS amount,
                   currency, earned_amount::text AS earned_amount, referrer_id, referee_id
              FROM order_referral_commissions WHERE order_id = ${orderId}`,
      )
    )[0];

  const balance = async (customerId: string): Promise<bigint> =>
    BigInt(
      (
        await rows<{ b: string }>(
          sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
                FROM wallet_entries WHERE customer_id = ${customerId}`,
        )
      )[0]?.b ?? '0',
    );

  const entries = (reason: string) =>
    rows<{
      id: string;
      customer_id: string;
      amount: string;
      reference: string;
      reverses_entry_id: string | null;
    }>(
      sql`SELECT id, customer_id, amount::text AS amount, reference, reverses_entry_id
            FROM wallet_entries WHERE reason = ${reason} ORDER BY created_at, id`,
    );

  const reversals = () =>
    rows<{ refund_id: string; due: string; recovered: string; unrecovered: string }>(
      sql`SELECT refund_id, due_amount::text AS due, recovered_amount::text AS recovered,
                 unrecovered_amount::text AS unrecovered
            FROM referral_commission_reversals ORDER BY created_at, id`,
    );

  const referralRows = () =>
    rows<{ referrer_id: string; referee_id: string; trigger: string }>(
      sql`SELECT referrer_id, referee_id, trigger FROM referrals ORDER BY created_at, id`,
    );

  /** Every `referral.attribute` audit row about this customer. */
  const attempts = (customerId: string) =>
    rows<{ result: string; reason: string | null }>(
      sql`SELECT result, after->>'reason' AS reason FROM audit_logs
           WHERE action = 'referral.attribute' AND entity_id = ${customerId}
           ORDER BY occurred_at, id`,
    );

  const events = (eventType: string) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = ${eventType}`);

  // -- Controlled interleavings, as `cashback.test.ts` has them --------------------

  async function awaitBlocked(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const blocked = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (blocked >= expected) return;
      if (Date.now() > deadline) throw new Error(`${what} never blocked.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Runs `hold` in an outside transaction and keeps it open until released. */
  async function holding(
    hold: (tx: { execute: (q: SQL) => Promise<unknown> }) => Promise<void>,
    finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
  ): Promise<{ release: () => Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held!: () => void;
    const ready = new Promise<void>((resolve) => (held = resolve));
    const rollback = new Error('rolled back on purpose');
    const holder = db
      .transaction(async (tx) => {
        await hold(tx as never);
        held();
        await gate;
        if (finish === 'ROLLBACK') throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    await ready;
    return {
      release: async () => {
        open();
        await holder;
      },
    };
  }

  return {
    key,
    rows,
    count,
    setFlag,
    setSetting,
    program,
    register,
    registered,
    invite,
    codeOf,
    referred,
    block,
    product,
    draft,
    confirmed,
    adjust,
    paidFromWallet,
    paidByTransfer,
    deliver,
    refund,
    complete,
    completeInput,
    commission,
    balance,
    entries,
    reversals,
    referralRows,
    attempts,
    events,
    awaitBlocked,
    holding,
  };
}

type Fixtures = ReturnType<typeof fixtures>;

// ===========================================================================
// The program, at the service level
// ===========================================================================

describe('the referral program: attribution, the promise, the credit and its reversal', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let panelA: string;
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
    getMe.username = BOT_A_USERNAME;
    await ctx.reset();
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-referral',
        roleKeys: ['owner'],
      }),
    );
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-referral',
        roleKeys: ['finance'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-referral-b',
        roleKeys: ['owner'],
      }),
    );
    f = fixtures(ctx.container, owner, finance, panelA);
  });

  // -------------------------------------------------------------------------
  // 1. Attribution, at registration and only there (F2, F3, F11)
  // -------------------------------------------------------------------------

  describe('attribution', () => {
    it('attributes a NEW customer arriving through /start ref-<CODE>, snapshotting the scope, with an audit row and a ReferralAttributed event', async () => {
      await f.program();
      const referrer = await f.registered('930001');
      const code = await f.codeOf(referrer);

      const arrived = await f.register('930002', `ref-${code}`);
      const referee = arrived.customer.id;

      expect(arrived.arrival).toBe('FIRST_SEEN');
      expect(await f.referralRows()).toEqual([
        { referrer_id: referrer, referee_id: referee, trigger: 'ON_FIRST_PAID_ORDER' },
      ]);
      expect(await f.attempts(referee)).toEqual([{ result: 'SUCCESS', reason: null }]);
      const [event] = await f.rows<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM outbox_messages WHERE event_type = 'ReferralAttributed'`,
      );
      expect(event?.payload).toMatchObject({
        referrerId: referrer,
        refereeId: referee,
        trigger: 'ON_FIRST_PAID_ORDER',
      });
      expect(await f.events('ReferralAttributed')).toBe(1);
    });

    it('replays a /start update a previous release remembered without its payload, instead of refusing it as a mismatch', async () => {
      // Codex review of PR #68: the payload had joined the request hash, so an update
      // committed by the release before this one and redelivered after the upgrade hashed
      // differently and was refused on every retry.
      await f.program();
      const referrer = await f.registered('930090');
      const code = await f.codeOf(referrer);
      const update = (startPayload: string | null) =>
        ctx.container.customers.resolveFromUpdate(tenantA, customerActor('upgrade'), {
          idempotencyKey: 'telegram-update-930091',
          telegramUserId: '930091',
          from: { id: 930091, first_name: 'مهسا' },
          botInstanceId: BOT_A,
          ...(startPayload === null ? {} : { startPayload }),
        });

      // What the previous release did with this update: no payload reached the service.
      const before = await update(null);
      const after = await update(`ref-${code}`);
      expect(after.customer.id).toBe(before.customer.id);
      expect(after.arrival).toBe('FIRST_SEEN');
    });

    it('snapshots EVERY_PAID_ORDER onto the referral, so a later scope change re-terms only people referred afterwards', async () => {
      await f.program({ scope: 'EVERY_PAID_ORDER' });
      const { referrer, referee, code } = await f.referred();
      await f.setSetting('referral.commission_scope', 'FIRST_PAID_ORDER', tenantA, owner);
      const later = await f.registered('930003', `ref-${code}`);

      expect(await f.referralRows()).toEqual([
        { referrer_id: referrer, referee_id: referee, trigger: 'ON_EVERY_PAID_ORDER' },
        { referrer_id: referrer, referee_id: later, trigger: 'ON_FIRST_PAID_ORDER' },
      ]);
    });

    it('reads the code in a link case-insensitively', async () => {
      await f.program();
      const referrer = await f.registered('930001');
      const code = await f.codeOf(referrer);
      const referee = await f.registered('930002', `REF-${code.toLowerCase()}`);
      expect(await f.referralRows()).toEqual([
        { referrer_id: referrer, referee_id: referee, trigger: 'ON_FIRST_PAID_ORDER' },
      ]);
    });

    it('treats a /start payload that is not a referral code as no attempt at all: nothing written, nothing audited', async () => {
      await f.program();
      const promo = await f.registered('930010', 'promo');
      const short = await f.registered('930011', 'ref-ABC');
      expect(await f.attempts(promo)).toEqual([]);
      expect(await f.attempts(short)).toEqual([]);
      expect(await f.referralRows()).toEqual([]);
    });

    /** A refused attribution: audited DENIED with its reason, and nothing else happened. */
    async function expectRefused(refereeId: string, reason: string): Promise<void> {
      expect(await f.attempts(refereeId)).toEqual([{ result: 'DENIED', reason }]);
      expect(
        await f.count(
          sql`SELECT count(*)::int AS n FROM referrals WHERE referee_id = ${refereeId}`,
        ),
      ).toBe(0);
      expect(await f.events('ReferralAttributed')).toBe(0);
    }

    it('refuses an unknown code as CODE_UNKNOWN, audited, and the customer arrives exactly as one with no link', async () => {
      await f.program();
      const withLink = await f.register('930020', 'ref-ZZZZZZZZ');
      const without = await f.register('930021');

      await expectRefused(withLink.customer.id, 'CODE_UNKNOWN');
      expect(withLink.arrival).toBe(without.arrival);
      expect(withLink.arrival).toBe('FIRST_SEEN');
    });

    it('refuses another tenant’s code as CODE_UNKNOWN: a code is resolved inside the tenant', async () => {
      await f.program();
      await f.program({}, tenantB, ownerB);
      const inB = await f.registered('930030', null, tenantB, BOT_B);
      const codeInB = await f.invite(inB, tenantB, BOT_B);
      expect(codeInB.outcome).toBe('READY');
      if (codeInB.outcome !== 'READY') return;

      const inA = await f.registered('930031', `ref-${codeInB.code}`);

      await expectRefused(inA, 'CODE_UNKNOWN');
      expect(await f.referralRows()).toEqual([]);
    });

    it('refuses a BLOCKED referrer’s link as REFERRER_BLOCKED', async () => {
      await f.program();
      const referrer = await f.registered('930040');
      const code = await f.codeOf(referrer);
      await f.block(referrer);

      const arrived = await f.register('930041', `ref-${code}`);

      await expectRefused(arrived.customer.id, 'REFERRER_BLOCKED');
      expect(arrived.arrival).toBe('FIRST_SEEN');
    });

    it('refuses a customer who already exists as ALREADY_REGISTERED, whoever’s link they follow later', async () => {
      await f.program();
      const referrer = await f.registered('930050');
      const code = await f.codeOf(referrer);
      const existing = await f.registered('930051');

      const again = await f.register('930051', `ref-${code}`);

      expect(again.customer.id).toBe(existing);
      expect(again.arrival).toBe('RETURNING');
      await expectRefused(existing, 'ALREADY_REGISTERED');
    });

    it('makes self-referral impossible: one’s own link is a returning customer’s, and the database refuses a self row', async () => {
      await f.program();
      const referrer = await f.registered('930060');
      const code = await f.codeOf(referrer);

      const self = await f.register('930060', `ref-${code}`);

      expect(self.arrival).toBe('RETURNING');
      await expectRefused(referrer, 'ALREADY_REGISTERED');
      await expect(
        ctx.container.database.db.execute(sql`
          INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${referrer}, ${referrer},
                  'ON_FIRST_PAID_ORDER')`),
      ).rejects.toMatchObject({ cause: { constraint: 'referrals_not_self_check' } });
    });

    it('refuses every link as PROGRAM_INACTIVE while the program is off, or on with no rate chosen', async () => {
      await f.program();
      const referrer = await f.registered('930070');
      const code = await f.codeOf(referrer);

      await f.setFlag(false, tenantA, owner);
      const whileOff = await f.registered('930071', `ref-${code}`);
      await expectRefused(whileOff, 'PROGRAM_INACTIVE');

      await f.setFlag(true, tenantA, owner);
      await f.setSetting('referral.commission_percent', null, tenantA, owner);
      const withoutRate = await f.registered('930072', `ref-${code}`);
      await expectRefused(withoutRate, 'PROGRAM_INACTIVE');
    });
  });

  // -------------------------------------------------------------------------
  // 2. The customer's invite (F3, F12)
  // -------------------------------------------------------------------------

  describe('the invite', () => {
    it('records the customer’s derived code the first time they ask, and answers READY with the deep link and the referred count', async () => {
      await f.program();
      const referrer = await f.registered('931001');
      const code = referralCodeFor(referrer);

      expect(await f.invite(referrer)).toEqual({
        outcome: 'READY',
        code,
        link: `https://t.me/${BOT_A_USERNAME}?start=ref-${code}`,
        referredCount: 0,
      });
      await f.registered('931002', `ref-${code}`);
      expect(await f.invite(referrer)).toMatchObject({ outcome: 'READY', code, referredCount: 1 });

      expect(
        await f.rows<{ customer_id: string; code: string }>(
          sql`SELECT customer_id, code FROM referral_codes`,
        ),
        'asking twice records one code',
      ).toEqual([{ customer_id: referrer, code }]);
    });

    it('answers INACTIVE and records nothing while the program is off, or on with no rate', async () => {
      const customer = await f.registered('931010');
      expect(await f.invite(customer)).toEqual({ outcome: 'INACTIVE' });

      await f.program({ percent: null });
      expect(await f.invite(customer)).toEqual({ outcome: 'INACTIVE' });

      expect(await f.count(sql`SELECT count(*)::int AS n FROM referral_codes`)).toBe(0);
    });

    it('answers UNAVAILABLE, and never reassigns the code, when another customer already holds it', async () => {
      await f.program();
      const customer = await f.registered('931020');
      const holder = await f.registered('931021');
      const code = referralCodeFor(customer);
      await ctx.container.database.db.execute(sql`
        INSERT INTO referral_codes (tenant_id, customer_id, code)
        VALUES (${tenantA.tenantId}, ${holder}, ${code})`);

      expect(await f.invite(customer)).toEqual({ outcome: 'UNAVAILABLE' });
      expect(
        await f.rows<{ customer_id: string; code: string }>(
          sql`SELECT customer_id, code FROM referral_codes`,
        ),
      ).toEqual([{ customer_id: holder, code }]);
    });

    it('answers a redelivered invite again from the same key, rather than refusing it as in flight', async () => {
      // Codex review of PR #68: the key was remembered unconditionally, so Telegram
      // retrying a turn whose reply was lost got IDEMPOTENCY_IN_FLIGHT every time.
      await f.program();
      const customer = await f.registered('931040');
      const again = () =>
        ctx.container.referrals.invite(tenantA, customerActor('redelivered'), {
          idempotencyKey: 'telegram-update-931040:referral',
          customerId: customer,
          botInstanceId: BOT_A,
        });
      const first = await again();
      expect(first.outcome).toBe('READY');
      expect(await again()).toEqual(first);
      expect(await again()).toEqual(first);
    });

    it('builds the link from the name Telegram reports now, not the one the bootstrap stored', async () => {
      await f.program();
      const customer = await f.registered('931050');
      getMe.username = 'acme_renamed_bot';
      const invited = await f.invite(customer);
      expect(invited).toMatchObject({
        outcome: 'READY',
        link: `https://t.me/acme_renamed_bot?start=ref-${referralCodeFor(customer)}`,
      });
    });

    it('offers no link, and records no code, when Telegram cannot say what the bot is called', async () => {
      await f.program();
      const customer = await f.registered('931060');
      getMe.username = null;
      expect(await f.invite(customer)).toEqual({ outcome: 'UNAVAILABLE' });
      expect(await f.count(sql`SELECT count(*)::int AS n FROM referral_codes`)).toBe(0);
    });

    it('answers UNAVAILABLE for a bot of another tenant: a link names the bot the customer is talking to', async () => {
      await f.program();
      const customer = await f.registered('931030');
      expect(await f.invite(customer, tenantA, BOT_B)).toEqual({ outcome: 'UNAVAILABLE' });
      expect(await f.count(sql`SELECT count(*)::int AS n FROM referral_codes`)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The promise, at confirmation (F6)
  // -------------------------------------------------------------------------

  describe('the promise at confirmation', () => {
    it('promises floor(total × percent / 100) to the referee’s referrer, snapshotting the terms', async () => {
      await f.program({ percent: 7 });
      const { referrer, referee } = await f.referred();

      const order = await f.confirmed(referee, 99_999n);

      expect(await f.commission(order.id)).toEqual({
        state: 'PENDING',
        scope: 'FIRST_PAID_ORDER',
        percent: 7,
        basis: '99999',
        amount: '6999', // floor(99 999 × 7 / 100)
        currency: 'IRT',
        earned_amount: null,
        referrer_id: referrer,
        referee_id: referee,
      });
      // A commission is not a price step: the referee pays the full total.
      expect(order.totals.total.amountMinor).toBe(99_999n);
    });

    it('promises nothing on an order by a customer nobody referred', async () => {
      await f.program();
      const { referrer } = await f.referred();
      const order = await f.confirmed(referrer, 100_000n);
      expect(await f.commission(order.id)).toBeUndefined();
    });

    it('promises nothing while the program is off at confirmation, and a promise already made still settles after it is switched off', async () => {
      await f.program({ scope: 'EVERY_PAID_ORDER' });
      const { referrer, referee } = await f.referred();
      const promised = await f.confirmed(referee, 100_000n);
      expect((await f.commission(promised.id))?.state).toBe('PENDING');

      await f.setFlag(false, tenantA, owner);
      const unpromised = await f.confirmed(referee, 100_000n);
      expect(await f.commission(unpromised.id)).toBeUndefined();

      await f.paidFromWallet(promised);
      await f.deliver(promised.id);
      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      expect((await f.commission(promised.id))?.state).toBe('EARNED');
      expect(await f.balance(referrer)).toBe(10_000n);
    });

    it('promises nothing below referral.minimum_order_amount, and promises at the floor exactly', async () => {
      await f.program({
        scope: 'EVERY_PAID_ORDER',
        minimum: { amountMinor: 50_000n, currency: 'IRT' },
      });
      const { referee } = await f.referred();

      const below = await f.confirmed(referee, 49_999n);
      const at = await f.confirmed(referee, 50_000n);

      expect(await f.commission(below.id)).toBeUndefined();
      expect((await f.commission(at.id))?.amount).toBe('5000');
    });

    it('promises nothing when the floor is in a currency the order is not in', async () => {
      await f.program({ minimum: { amountMinor: 1n, currency: 'USD' } });
      const { referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      expect(await f.commission(order.id)).toBeUndefined();
    });

    it('promises nothing when the referrer is BLOCKED at confirmation', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      await f.block(referrer);
      const order = await f.confirmed(referee, 100_000n);
      expect(await f.commission(order.id)).toBeUndefined();
    });

    it('promises nothing that rounds down to zero', async () => {
      await f.program({ percent: 1 });
      const { referee } = await f.referred();
      const order = await f.confirmed(referee, 99n);
      expect(await f.commission(order.id)).toBeUndefined();
    });

    it('promises nothing on a TRIAL, whatever its total: a trial earns nobody anything', async () => {
      await f.program();
      const { referee } = await f.referred();
      const order = await f.draft(referee, 100_000n);
      const promise = (purpose: OrderRecord['purpose']) =>
        ctx.container.uow.run(tenantA, (tx) =>
          ctx.container.referrals.promise(
            tenantA,
            { ...order, purpose },
            ctx.container.clock.now(),
            tx,
          ),
        );

      await promise('TRIAL');
      expect(await f.commission(order.id), 'a trial is promised nothing').toBeUndefined();
      // The same order as a purchase IS promised, so the refusal above is the purpose's.
      await promise('NEW_SERVICE');
      expect((await f.commission(order.id))?.state).toBe('PENDING');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Earned at delivery, exactly once (F7)
  // -------------------------------------------------------------------------

  describe('earning at delivery', () => {
    it('earns nothing before delivery, then credits the REFERRER once with REFERRAL_COMMISSION referenced <orderId>:referral', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(order);

      expect(
        await ctx.container.referralCommissions.settleDue(tenantA, 50),
        'paid is not delivered',
      ).toBe(0);
      expect((await f.commission(order.id))?.state).toBe('PENDING');

      await f.deliver(order.id);
      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      expect(
        await ctx.container.referralCommissions.settleDue(tenantA, 50),
        'and never again',
      ).toBe(0);
      expect(await ctx.container.referralCommissions.settle(tenantA, order.id)).toBe(false);

      expect(await f.commission(order.id)).toMatchObject({
        state: 'EARNED',
        amount: '10000',
        earned_amount: '10000',
      });
      const credits = await f.entries('REFERRAL_COMMISSION');
      expect(credits.map((e) => [e.customer_id, e.amount, e.reference])).toEqual([
        [referrer, '10000', `${order.id}:referral`],
      ]);
      expect(await f.events('ReferralRewarded')).toBe(1);
      expect(await f.balance(referrer)).toBe(10_000n);
      expect(await f.balance(referee), 'the referee paid in full and was credited nothing').toBe(
        0n,
      );
    });

    it('counts only an operation of the type the order BOUGHT as delivery', async () => {
      await f.program();
      const { referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(order);
      await ctx.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET type = 'SYNC_USAGE', state = 'SUCCEEDED', completed_at = now(),
               claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${order.id}`);
      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(0);
      expect((await f.commission(order.id))?.state).toBe('PENDING');
    });

    it('still pays a referrer blocked after the promise was made: the block governs what they may do, not what they are owed', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await f.block(referrer);
      await f.paidFromWallet(order);
      await f.deliver(order.id);
      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      expect(await f.balance(referrer)).toBe(10_000n);
    });

    it('keeps tenants apart: another tenant’s sweep decides nothing here', async () => {
      await f.program();
      const { referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(order);
      await f.deliver(order.id);
      expect(await ctx.container.referralCommissions.settleDue(tenantB, 50)).toBe(0);
      expect(await ctx.container.referralCommissions.settle(tenantB, order.id)).toBe(false);
      expect((await f.commission(order.id))?.state).toBe('PENDING');
    });
  });

  // -------------------------------------------------------------------------
  // 5 and 6. First-order and every-order scope (F5, F7)
  // -------------------------------------------------------------------------

  describe('scope', () => {
    it('under FIRST_PAID_ORDER, a second delivered order’s commission is VOID and only the first is credited', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const first = await f.confirmed(referee, 100_000n);
      const second = await f.confirmed(referee, 100_000n);
      // Both are promised: neither had earned when the other was confirmed.
      expect((await f.commission(second.id))?.state).toBe('PENDING');
      await f.paidFromWallet(first);
      await f.paidFromWallet(second);
      await f.deliver(first.id);
      await f.deliver(second.id);

      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(2);

      expect((await f.commission(first.id))?.state).toBe('EARNED');
      expect((await f.commission(second.id))?.state).toBe('VOID');
      expect(await f.entries('REFERRAL_COMMISSION')).toHaveLength(1);
      expect(await f.balance(referrer)).toBe(10_000n);
    });

    it('under FIRST_PAID_ORDER, an order confirmed after the first commission earned is not promised at all', async () => {
      await f.program();
      const { referee } = await f.referred();
      const first = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(first);
      await f.deliver(first.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);

      const later = await f.confirmed(referee, 100_000n);
      expect(await f.commission(later.id)).toBeUndefined();
    });

    it('serialises two concurrent earners of one referral on the referrer’s lock, so exactly one first-order commission is EARNED', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const first = await f.confirmed(referee, 100_000n);
      const second = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(first);
      await f.paidFromWallet(second);
      await f.deliver(first.id);
      await f.deliver(second.id);

      const held = await f.holding(async (tx) => {
        await tx.execute(sql`SELECT id FROM customers WHERE id = ${referrer} FOR UPDATE`);
      });
      const a = ctx.container.referralCommissions.settle(tenantA, first.id);
      const b = ctx.container.referralCommissions.settle(tenantA, second.id);
      try {
        await f.awaitBlocked(2, 'both earners');
      } finally {
        await held.release();
      }

      // Both decided — one EARNED, one VOID — and neither failed on the index.
      expect(await Promise.all([a, b])).toEqual([true, true]);
      const states = [
        (await f.commission(first.id))?.state,
        (await f.commission(second.id))?.state,
      ].sort();
      expect(states).toEqual(['EARNED', 'VOID']);
      expect(await f.entries('REFERRAL_COMMISSION')).toHaveLength(1);
      expect(await f.balance(referrer)).toBe(10_000n);
    });

    it('refuses, in the database, a second EARNED first-order commission for one referral written without the lock', async () => {
      await f.program();
      const { referee } = await f.referred();
      const first = await f.confirmed(referee, 100_000n);
      const second = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(first);
      await f.deliver(first.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      expect((await f.commission(first.id))?.state).toBe('EARNED');

      await expect(
        ctx.container.database.db.execute(sql`
          UPDATE order_referral_commissions
             SET state = 'EARNED', earned_amount = 0, earned_at = now()
           WHERE order_id = ${second.id}`),
      ).rejects.toMatchObject({
        cause: { constraint: 'order_referral_commissions_first_earned_key' },
      });
      expect((await f.commission(second.id))?.state).toBe('PENDING');
    });

    it('under EVERY_PAID_ORDER, every delivered order earns its own commission', async () => {
      await f.program({ scope: 'EVERY_PAID_ORDER' });
      const { referrer, referee } = await f.referred();
      const first = await f.confirmed(referee, 100_000n);
      const second = await f.confirmed(referee, 50_000n);
      await f.paidFromWallet(first);
      await f.paidFromWallet(second);
      await f.deliver(first.id);
      await f.deliver(second.id);

      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(2);

      expect((await f.commission(first.id))?.state).toBe('EARNED');
      expect((await f.commission(second.id))?.state).toBe('EARNED');
      expect((await f.entries('REFERRAL_COMMISSION')).map((e) => e.reference).sort()).toEqual(
        [`${first.id}:referral`, `${second.id}:referral`].sort(),
      );
      expect(await f.balance(referrer)).toBe(15_000n);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Ended without delivery (F7)
  // -------------------------------------------------------------------------

  describe('an order that ends undelivered', () => {
    it('voids the promise of an order cancelled before it was paid, crediting nothing', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await ctx.container.orders.cancelByCustomer(tenantA, customerActor(f.key()), {
        idempotencyKey: f.key(),
        customerId: referee,
        orderId: order.id,
      });

      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      expect((await f.commission(order.id))?.state).toBe('VOID');
      expect(await f.entries('REFERRAL_COMMISSION')).toHaveLength(0);
      expect(await f.balance(referrer)).toBe(0n);
    });

    it('voids the promise of an order that expired unpaid, crediting nothing', async () => {
      await f.program();
      const { referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order.id}`,
      );
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      const [state] = await f.rows<{ state: string }>(
        sql`SELECT state FROM orders WHERE id = ${order.id}`,
      );
      expect(state?.state).toBe('EXPIRED');

      expect(await ctx.container.referralCommissions.settleDue(tenantA, 50)).toBe(1);
      expect((await f.commission(order.id))?.state).toBe('VOID');
      expect(await f.entries('REFERRAL_COMMISSION')).toHaveLength(0);
    });

    it('voids the promise of a paid order refunded because it could not be delivered, crediting and reversing nothing', async () => {
      await f.program();
      const { referrer, referee } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      const { payment } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        customerActor(f.key()),
        referee,
        { idempotencyKey: f.key(), orderId: order.id },
      );
      // The panel stops being sellable while the transfer waits for review.
      await ctx.container.database.db.execute(
        sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
      );
      const finance = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'finance-2', roleKeys: ['finance'] }),
      );
      const settled = await ctx.container.payments.confirmManualTransfer(
        tenantA,
        finance,
        payment.id,
        { idempotencyKey: f.key(), note: 'کارت به کارت' },
      );
      expect(settled.order?.state).toBe('REFUNDED');

      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      expect((await f.commission(order.id))?.state).toBe('VOID');
      expect(await f.entries('REFERRAL_COMMISSION')).toHaveLength(0);
      expect(await f.reversals()).toHaveLength(0);
      expect(await f.balance(referrer)).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Reversed by refunds (F8, F9)
  // -------------------------------------------------------------------------

  describe('reversal on refund', () => {
    async function earned(price: bigint, percent = 10) {
      await f.program({ percent });
      const pair = await f.referred();
      const order = await f.confirmed(pair.referee, price);
      return { ...pair, order };
    }

    it('takes the whole commission back from the referrer when the whole payment is refunded', async () => {
      const { referrer, referee, order } = await earned(100_000n);
      const paymentId = await f.paidFromWallet(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      const [credit] = await f.entries('REFERRAL_COMMISSION');

      const refunded = await f.refund(paymentId, 100_000n);

      expect(await f.reversals()).toEqual([
        { refund_id: refunded.id, due: '10000', recovered: '10000', unrecovered: '0' },
      ]);
      const debits = await f.entries('REFERRAL_COMMISSION_REVERSAL');
      expect(
        debits.map((e) => [e.customer_id, e.amount, e.reference, e.reverses_entry_id]),
      ).toEqual([[referrer, '10000', `${refunded.id}:referral-reversal`, credit?.id]]);
      expect(await f.balance(referrer)).toBe(0n);
      expect(await f.balance(referee), 'the refund went back to the referee').toBe(100_000n);
      expect(await f.events('ReferralCommissionReversed')).toBe(1);
    });

    it('reverses across two partial refunds exactly what one full refund would', async () => {
      const { order } = await earned(99_999n, 7);
      const paymentId = await f.paidFromWallet(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      const promised = 6_999n; // floor(99 999 × 7 / 100)
      expect((await f.commission(order.id))?.earned_amount).toBe(promised.toString());

      await f.refund(paymentId, 50_000n);
      await f.refund(paymentId, 49_999n);

      const dues = (await f.reversals()).map((r) => BigInt(r.due));
      const afterFirst = proportionalTargetMinor(promised, 99_999n, 50_000n);
      expect(dues).toEqual([promised - afterFirst, afterFirst]);
      expect(
        dues.reduce((a, b) => a + b, 0n),
        'the whole promise, as one full refund',
      ).toBe(promised);
    });

    it('records what a spent referrer balance cannot cover as unrecovered, and never takes it below zero', async () => {
      const { referrer, order } = await earned(100_000n);
      const paymentId = await f.paidByTransfer(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      // Six thousand of the ten thousand earned is spent.
      await f.adjust(referrer, 'DEBIT', 6_000n);
      expect(await f.balance(referrer)).toBe(4_000n);

      const manual = await f.refund(paymentId, 100_000n);
      expect(manual.state, 'a bank refund waits for the bank').toBe('AWAITING_EXTERNAL');
      expect(await f.reversals(), 'nothing is owed until the money has gone back').toHaveLength(0);

      await f.complete(manual.id);

      expect(await f.reversals()).toEqual([
        { refund_id: manual.id, due: '10000', recovered: '4000', unrecovered: '6000' },
      ]);
      expect(await f.balance(referrer)).toBe(0n);
      // The referrer's own totals carry the shortfall, beside what was reversed.
      const summary = await ctx.container.referralsRead.customer(tenantA, owner, referrer);
      expect(summary.totals).toEqual([
        { currency: 'IRT', pending: 0n, earned: 10_000n, reversed: 10_000n, unrecovered: 6_000n },
      ]);
    });

    it('reverses nothing twice for a replayed refund completion', async () => {
      const { order } = await earned(100_000n);
      const paymentId = await f.paidByTransfer(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      const manual = await f.refund(paymentId, 100_000n);
      const input = f.completeInput(manual.id);

      await ctx.container.refunds.complete(tenantA, owner, input);
      await ctx.container.refunds.complete(tenantA, owner, input);

      expect(await f.reversals()).toHaveLength(1);
      expect(await f.entries('REFERRAL_COMMISSION_REVERSAL')).toHaveLength(1);
      expect(await f.events('ReferralCommissionReversed')).toBe(1);
    });

    it('earns only the refunded-down share when a refund completed before delivery was noticed, and reverses nothing', async () => {
      const { referrer, order } = await earned(100_000n);
      const paymentId = await f.paidFromWallet(order);
      /*
       * Delivered FIRST, then refunded, then noticed. The refund used to come before the
       * delivery here; WP10 P3 refuses an operator's refund while the purchase operation
       * is undecided, so "before delivery was noticed" now means what the title says —
       * the account exists, and the earner has not yet swept it.
       */
      await f.deliver(order.id);
      await f.refund(paymentId, 40_000n);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);

      expect((await f.commission(order.id))?.earned_amount).toBe('6000');
      expect(await f.reversals()).toHaveLength(0);
      expect(await f.balance(referrer)).toBe(6_000n);
    });

    it('never misses a reversal when a refund completes while the earner holds the referrer’s lock mid-credit', async () => {
      /*
       * The interleaving F8's lock order exists for (WP8-16's lesson, on the referrer).
       *
       * The earner has taken the REFERRER's lock, read the refunds (none COMPLETED yet)
       * and is writing the full credit. An outside transaction holds it THERE by having
       * inserted the same ledger reference uncommitted. Meanwhile a manual refund of half
       * the payment completes: its reversal must wait on the referrer's lock and then see
       * the commission EARNED — reading PENDING unlocked would return and leave the full
       * credit standing.
       *
       * The blocking row belongs to a BYSTANDER, never to the referrer. The reference is
       * unique per tenant, so the earner's insert still waits on it; but a row of the
       * referrer's would take `FOR KEY SHARE` on the referrer's customer row through its
       * foreign key, and the earner would then wait at `lockCustomer` — before reading a
       * single refund — which is a different, harmless interleaving (WP9-19's first
       * record said so).
       */
      const { referrer, order } = await earned(100_000n);
      const bystander = await f.registered('930099');
      const paymentId = await f.paidByTransfer(order);
      await f.deliver(order.id);
      const manual = await f.refund(paymentId, 50_000n);

      const blocker = await f.holding(async (tx) => {
        await tx.execute(sql`
          INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                      currency, reference)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${bystander}, 'CREDIT',
                  'REFERRAL_COMMISSION', 1, 'IRT', ${`${order.id}:referral`})`);
      }, 'ROLLBACK');

      const earning = ctx.container.referralCommissions.settle(tenantA, order.id);
      let completing: Promise<unknown> | undefined;
      let reached: 'COMMITTED' | 'QUEUED' | 'NEVER' | undefined;
      try {
        await f.awaitBlocked(1, 'the earner at its ledger insert');
        // Where it waits is the premise, so it is asserted: at the INSERT, after it read the
        // refunds, and not at `lockCustomer`, before it read anything.
        expect(
          await f.count(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "wallet_entries"%'`,
          ),
          'the earner waits at its ledger insert',
        ).toBe(1);
        completing = f.complete(manual.id);
        /*
         * Released only once the completion has got as far as it can: queued behind the
         * earner (the rule), or already committed (a completion that judged the unlocked
         * PENDING and walked away). Releasing any earlier lets the earner commit first
         * and the completion then read EARNED, which proves nothing either way.
         */
        const committed = completing.then(() => 'COMMITTED' as const);
        const queued = f
          .awaitBlocked(2, 'the refund completion behind the earner')
          .then(() => 'QUEUED' as const)
          .catch(() => 'NEVER' as const);
        reached = await Promise.race([committed, queued]);
      } finally {
        // A failed wait must not leave the blocker open under the cases after this one.
        await blocker.release();
      }

      expect(await earning).toBe(true);
      await completing;

      const earnedAmount = BigInt((await f.commission(order.id))?.earned_amount ?? '0');
      const reversed = (await f.reversals()).reduce((sum, r) => sum + BigInt(r.due), 0n);
      expect(earnedAmount, 'the earner read no completed refund').toBe(10_000n);
      expect(earnedAmount - reversed, 'half the payment stands, so half the promise').toBe(
        proportionalTargetMinor(10_000n, 100_000n, 50_000n),
      );
      expect(await f.balance(referrer)).toBe(5_000n);
      expect(reached, 'the completion queued behind the earner').toBe('QUEUED');
    });

    it('never takes the referrer below zero when they spend while a reversal is being decided', async () => {
      /*
       * What the reversal's REFERRER lock is for. The commission row's own lock already
       * orders a reversal against the earner; it does nothing about the referrer spending
       * the credit at the same moment. Here a debit of the referrer's whole balance holds
       * the referrer's row and commits only after the completion has arrived. Under the
       * lock the reversal reads the balance AFTER that debit and recovers nothing; without
       * it the reversal reads 10 000 from before it and debits 5 000 into a balance of 0.
       */
      const { referrer, order } = await earned(100_000n);
      const paymentId = await f.paidByTransfer(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      expect(await f.balance(referrer)).toBe(10_000n);
      const manual = await f.refund(paymentId, 50_000n);

      const spend = await f.holding(async (tx) => {
        await tx.execute(sql`SELECT id FROM customers WHERE id = ${referrer} FOR UPDATE`);
        await tx.execute(sql`
          INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                      currency, reference)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${referrer}, 'DEBIT',
                  'ADMIN_DEBIT', 10000, 'IRT', ${`spend-${order.id}`})`);
      });

      let completing: Promise<unknown> | undefined;
      try {
        completing = f.complete(manual.id);
        await f.awaitBlocked(1, 'the reversal behind the spend');
      } finally {
        await spend.release();
      }
      await completing;

      expect(await f.balance(referrer), 'the balance never goes below zero').toBe(0n);
      expect(await f.reversals()).toEqual([
        { refund_id: manual.id, due: '5000', recovered: '0', unrecovered: '5000' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 9. What the database refuses on its own (0108)
  // -------------------------------------------------------------------------

  describe('the database guards', () => {
    it('refuses to update or delete a referral, a referral code or a commission reversal', async () => {
      await f.program();
      const { referee, referrer } = await f.referred();
      const order = await f.confirmed(referee, 100_000n);
      const paymentId = await f.paidFromWallet(order);
      await f.deliver(order.id);
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      await f.refund(paymentId, 100_000n);
      expect(await f.reversals()).toHaveLength(1);

      const db = ctx.container.database.db;
      const refused = { cause: { code: '23001' } };
      await expect(
        db.execute(sql`UPDATE referrals SET referrer_id = ${referee}, referee_id = ${referrer}`),
      ).rejects.toMatchObject(refused);
      await expect(
        db.execute(sql`UPDATE referrals SET trigger = 'ON_EVERY_PAID_ORDER'`),
      ).rejects.toMatchObject(refused);
      await expect(db.execute(sql`DELETE FROM referrals`)).rejects.toMatchObject(refused);
      await expect(
        db.execute(sql`UPDATE referral_codes SET code = 'ZZZZZZZZ'`),
      ).rejects.toMatchObject(refused);
      await expect(db.execute(sql`DELETE FROM referral_codes`)).rejects.toMatchObject(refused);
      await expect(
        db.execute(
          sql`UPDATE referral_commission_reversals SET due_amount = 1, recovered_amount = 1`,
        ),
      ).rejects.toMatchObject(refused);
      await expect(
        db.execute(sql`DELETE FROM referral_commission_reversals`),
      ).rejects.toMatchObject(refused);

      expect(await f.referralRows()).toHaveLength(1);
      expect(await f.count(sql`SELECT count(*)::int AS n FROM referral_codes`)).toBe(1);
      expect(await f.reversals()).toHaveLength(1);
    });

    it('freezes a commission’s terms, moves it only from PENDING to EARNED or VOID, never back, and never deletes it', async () => {
      await f.program({ scope: 'EVERY_PAID_ORDER' });
      const { referee } = await f.referred();
      const earnedOrder = await f.confirmed(referee, 100_000n);
      const voidOrder = await f.confirmed(referee, 100_000n);
      const pendingOrder = await f.confirmed(referee, 100_000n);
      await f.paidFromWallet(earnedOrder);
      await f.deliver(earnedOrder.id);
      await ctx.container.orders.cancelByCustomer(tenantA, customerActor(f.key()), {
        idempotencyKey: f.key(),
        customerId: referee,
        orderId: voidOrder.id,
      });
      await ctx.container.referralCommissions.settleDue(tenantA, 50);
      expect((await f.commission(earnedOrder.id))?.state).toBe('EARNED');
      expect((await f.commission(voidOrder.id))?.state).toBe('VOID');

      const db = ctx.container.database.db;
      const refused = { cause: { code: '23001' } };
      const update = (orderId: string, assignment: SQL) =>
        db.execute(
          sql`UPDATE order_referral_commissions SET ${assignment} WHERE order_id = ${orderId}`,
        );

      // The frozen terms, on a row that is still PENDING.
      for (const assignment of [
        sql`amount = 1`,
        sql`percent = 50`,
        sql`basis_amount = 1000000`,
        sql`currency = 'USD'`,
        sql`scope = 'FIRST_PAID_ORDER'`,
        sql`referrer_id = ${referee}`,
      ]) {
        await expect(update(pendingOrder.id, assignment)).rejects.toMatchObject(refused);
      }
      // Illegal transitions.
      await expect(
        update(
          earnedOrder.id,
          sql`state = 'PENDING', earned_amount = NULL, earned_entry_id = NULL, earned_at = NULL`,
        ),
        'EARNED -> PENDING',
      ).rejects.toMatchObject(refused);
      await expect(
        update(earnedOrder.id, sql`earned_amount = 1`),
        'an EARNED row is frozen entirely',
      ).rejects.toMatchObject(refused);
      await expect(
        update(
          voidOrder.id,
          sql`state = 'EARNED', voided_at = NULL, earned_amount = 0, earned_at = now()`,
        ),
        'VOID -> EARNED',
      ).rejects.toMatchObject(refused);
      await expect(
        update(voidOrder.id, sql`state = 'PENDING', voided_at = NULL`),
        'VOID -> PENDING',
      ).rejects.toMatchObject(refused);
      await expect(db.execute(sql`DELETE FROM order_referral_commissions`)).rejects.toMatchObject(
        refused,
      );

      expect((await f.commission(earnedOrder.id))?.state).toBe('EARNED');
      expect((await f.commission(voidOrder.id))?.state).toBe('VOID');
      expect(await f.commission(pendingOrder.id)).toMatchObject({
        state: 'PENDING',
        amount: '10000',
        percent: 10,
      });
    });
  });
});

// ===========================================================================
// The operator's HTTP surface, and the customer's Telegram surface
// ===========================================================================

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-referral-flow';
const REFERRER_TELEGRAM_ID = 5557770001;
const REFEREE_TELEGRAM_ID = 5557770002;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the referral surfaces: HTTP for the operator, Telegram for the customer', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let panelA: string;
  let f: Fixtures;
  let financeCookie: string;
  let supportCookie: string;
  let foreignCookie: string;
  let updateId = 9000;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if ((request.url ?? '').endsWith('/getMe')) {
          // The invite asks the bot's current name; that is not a message to anybody.
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ ok: true, result: { id: 7001, username: BOT_A_USERNAME } }),
          );
          return;
        }
        sent.push({
          url: request.url ?? '',
          body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    telegram?.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];

    const ownerAdmin = await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owner-password',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(ownerAdmin);
    const financeAdmin = await createAdmin(api.container, tenantA, {
      username: 'finance',
      password: 'the-finance-password',
      roleKeys: ['finance'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
    });
    await createAdmin(api.container, tenantB, {
      username: 'foreign',
      password: 'the-foreign-password',
      roleKeys: ['owner'],
    });
    financeCookie = await cookieFor('finance');
    supportCookie = await cookieFor('support');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
    f = fixtures(api.container, owner, adminActorFor(financeAdmin), panelA);
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

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  /** A referral with one delivered, earned and half-refunded commission. */
  async function history(): Promise<{ referrer: UserId; referee: UserId; orderId: string }> {
    await f.program();
    const { referrer, referee } = await f.referred();
    const order = await f.confirmed(referee, 100_000n);
    const paymentId = await f.paidFromWallet(order);
    await f.deliver(order.id);
    await api.container.referralCommissions.settleDue(tenantA, 50);
    await f.refund(paymentId, 50_000n);
    return { referrer, referee, orderId: order.id };
  }

  // -------------------------------------------------------------------------
  // 10. HTTP
  // -------------------------------------------------------------------------

  describe('over HTTP', () => {
    it('answers 403 on all three routes without referrals.view, and 200 with it', async () => {
      const { referrer } = await history();
      const paths = [
        REFERRAL_ROUTES.list,
        REFERRAL_ROUTES.commissions,
        REFERRAL_ROUTES.customer(referrer),
      ];
      for (const path of paths) {
        expect((await get(path, supportCookie)).statusCode, `support on ${path}`).toBe(403);
        expect((await get(path, financeCookie)).statusCode, `finance on ${path}`).toBe(200);
      }
    });

    it('shows the attribution, the commission with its reversal, and both parties’ summaries', async () => {
      const { referrer, referee, orderId } = await history();

      const list = referralListResponseSchema.parse(
        (await get(REFERRAL_ROUTES.list, financeCookie)).json(),
      );
      expect(list.referrals).toHaveLength(1);
      expect(list.referrals[0]).toMatchObject({
        referrer: { customerId: referrer },
        referee: { customerId: referee },
        trigger: 'ON_FIRST_PAID_ORDER',
      });

      const commissions = referralCommissionListResponseSchema.parse(
        (await get(REFERRAL_ROUTES.commissions, financeCookie)).json(),
      );
      expect(commissions.commissions).toHaveLength(1);
      expect(commissions.commissions[0]).toMatchObject({
        orderId,
        state: 'EARNED',
        scope: 'FIRST_PAID_ORDER',
        percent: 10,
        basisAmount: '100000',
        promisedAmount: '10000',
        earnedAmount: '10000',
        reversedAmount: '5000',
        unrecoveredAmount: '0',
        currency: 'IRT',
      });

      const ofReferrer = customerReferralResponseSchema.parse(
        (await get(REFERRAL_ROUTES.customer(referrer), financeCookie)).json(),
      );
      expect(ofReferrer).toMatchObject({
        customerId: referrer,
        // The referrer's link was opened, so their code is on record.
        code: referralCodeFor(referrer),
        referredBy: null,
        referredCount: 1,
      });
      expect(ofReferrer.totals).toEqual([
        {
          currency: 'IRT',
          pendingAmount: '0',
          earnedAmount: '10000',
          reversedAmount: '5000',
          unrecoveredAmount: '0',
        },
      ]);

      const ofReferee = customerReferralResponseSchema.parse(
        (await get(REFERRAL_ROUTES.customer(referee), financeCookie)).json(),
      );
      expect(ofReferee.referredBy?.referrer.customerId).toBe(referrer);
      expect(ofReferee.referredCount).toBe(0);
      // The referee never opened their own invite, so no code is recorded for them.
      expect(ofReferee.code).toBeNull();
      expect(ofReferee.totals).toEqual([]);
    });

    it('keeps tenants apart: another tenant’s operator lists none of these rows and is told the customer does not exist', async () => {
      const { referrer } = await history();

      const list = referralListResponseSchema.parse(
        (await get(REFERRAL_ROUTES.list, foreignCookie)).json(),
      );
      expect(list.referrals).toEqual([]);
      const commissions = referralCommissionListResponseSchema.parse(
        (await get(REFERRAL_ROUTES.commissions, foreignCookie)).json(),
      );
      expect(commissions.commissions).toEqual([]);

      const foreign = await get(REFERRAL_ROUTES.customer(referrer), foreignCookie);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({
        error: { code: COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND },
      });
      const malformed = await get(REFERRAL_ROUTES.customer('not-a-uuid'), financeCookie);
      expect(malformed.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // 11. Telegram
  // -------------------------------------------------------------------------

  describe('over Telegram', () => {
    const command = (text: string, from: number) => {
      const id = (updateId += 1);
      return inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: id,
          message: {
            message_id: id,
            date: 0,
            chat: { id: from, type: 'private' },
            from: { id: from, is_bot: false, first_name: 'Ali' },
            text,
          },
        },
      });
    };

    const tap = (data: string, from: number) => {
      const id = (updateId += 1);
      return inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: id,
          callback_query: {
            id: `cbq-${id}`,
            from: { id: from, is_bot: false, first_name: 'Ali' },
            chat_instance: 'ci',
            data,
            message: {
              message_id: id,
              date: 0,
              chat: { id: from, type: 'private' },
              from: { id: 999999, is_bot: true, first_name: 'Nexa' },
              text: 'x',
            },
          },
        },
      });
    };

    const lastMessage = () => sent.filter((one) => one.url.includes('/sendMessage')).at(-1);
    const buttons = () => {
      const markup = lastMessage()?.body['reply_markup'] as
        { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
      return (markup?.inline_keyboard ?? []).flat();
    };

    const customerIdOf = async (telegramUserId: number): Promise<UserId> => {
      const [row] = await f.rows<{ id: UserId }>(
        sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
              AND telegram_user_id = ${String(telegramUserId)}`,
      );
      if (row === undefined) throw new Error(`no customer ${String(telegramUserId)}`);
      return row.id;
    };

    it('attributes a new customer whose first /start carries ref-<CODE>, through the real webhook', async () => {
      await f.program();
      await command('/start', REFERRER_TELEGRAM_ID);
      const referrer = await customerIdOf(REFERRER_TELEGRAM_ID);
      await tap('rf:', REFERRER_TELEGRAM_ID);
      const code = referralCodeFor(referrer);

      const response = await command(`/start ref-${code}`, REFEREE_TELEGRAM_ID);

      expect(response.statusCode).toBeLessThan(300);
      const referee = await customerIdOf(REFEREE_TELEGRAM_ID);
      expect(await f.referralRows()).toEqual([
        { referrer_id: referrer, referee_id: referee, trigger: 'ON_FIRST_PAID_ORDER' },
      ]);
    });

    it('greets a customer arriving through a refused link exactly as one arriving with no link', async () => {
      await f.program();
      sent = [];
      await command('/start ref-ZZZZZZZZ', REFEREE_TELEGRAM_ID);
      const refused = lastMessage()?.body;
      sent = [];
      await command('/start', REFEREE_TELEGRAM_ID + 1);
      const plain = lastMessage()?.body;

      expect(refused?.['text']).toBeDefined();
      expect(refused?.['text']).toBe(plain?.['text']);
      expect(refused?.['reply_markup']).toEqual(plain?.['reply_markup']);
      expect(await f.attempts(await customerIdOf(REFEREE_TELEGRAM_ID))).toEqual([
        { result: 'DENIED', reason: 'CODE_UNKNOWN' },
      ]);
    });

    it('draws the referral button on /wallet only while the program is active', async () => {
      await command('/start', REFERRER_TELEGRAM_ID);

      sent = [];
      await command('/wallet', REFERRER_TELEGRAM_ID);
      expect(lastMessage(), 'the wallet answered').toBeDefined();
      expect(buttons().filter((b) => b.callback_data === 'rf:')).toEqual([]);

      await f.program();
      sent = [];
      await command('/wallet', REFERRER_TELEGRAM_ID);
      expect(buttons().filter((b) => b.callback_data === 'rf:')).toEqual([
        { text: CATALOGUE_FA['bot.referral.button'], callback_data: 'rf:' },
      ]);

      await f.setSetting('referral.commission_percent', null, tenantA, owner);
      sent = [];
      await command('/wallet', REFERRER_TELEGRAM_ID);
      expect(
        buttons().filter((b) => b.callback_data === 'rf:'),
        'no rate, no program',
      ).toEqual([]);
    });

    it('answers the rf: tap with bot.referral.invite — link, code and referred count — and with unconfigured while inactive', async () => {
      await command('/start', REFERRER_TELEGRAM_ID);
      const referrer = await customerIdOf(REFERRER_TELEGRAM_ID);

      sent = [];
      await tap('rf:', REFERRER_TELEGRAM_ID);
      expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.referral.unconfigured']);
      expect(await f.count(sql`SELECT count(*)::int AS n FROM referral_codes`)).toBe(0);

      await f.program();
      const code = referralCodeFor(referrer);
      const invite = (referredCount: number) =>
        createTranslator().translate('bot.referral.invite', {
          referralCode: code,
          referralLink: `https://t.me/${BOT_A_USERNAME}?start=ref-${code}`,
          referredCount,
        });

      sent = [];
      await tap('rf:', REFERRER_TELEGRAM_ID);
      expect(lastMessage()?.body['text']).toBe(invite(0));

      await command(`/start ref-${code}`, REFEREE_TELEGRAM_ID);
      sent = [];
      await tap('rf:', REFERRER_TELEGRAM_ID);
      expect(lastMessage()?.body['text']).toBe(invite(1));
    });
  });
});
