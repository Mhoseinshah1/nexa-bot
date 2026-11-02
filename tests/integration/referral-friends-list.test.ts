import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE,
  MINIAPP_ROUTES,
  miniAppPath,
  miniAppReferralFriendsResponseSchema,
  money,
  referralStartPayloadForTelegramId,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type FeatureFlagKey,
  type MiniAppReferralFriendsResponse,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleReferralFriendsRepository } from '../../apps/api/src/modules/commerce/referrals/infrastructure/drizzle-referral-friends.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * R11 B3 — the mini app's invited-friends list (`referral_friends_list`), over HTTP.
 *
 * The rules under test:
 *
 * - the flag is OFF by default: the route answers exactly `{ enabled: false }`, however many
 *   friends the customer has;
 * - the list is the session customer's OWN referrals — never another customer's, never
 *   another tenant's — and the only input is a cursor;
 * - one status per friend, from the purchase commission's own state: nothing → JOINED; a
 *   delivered purchase with no commission pending or paid for more than nothing → PURCHASED;
 *   PENDING → REWARD_PENDING (with `rewardNotBefore` only while a cap day is still ahead);
 *   EARNED for more than nothing → REWARD_PAID; the counts add up to the attribution count;
 * - a friend is drawn by a first name or a masked username or nothing: no Telegram id, last
 *   name, full username or internal id is anywhere in the answer;
 * - a page is bounded and the traversal ends; a cursor the server did not mint is a 400;
 * - imported (MIRZA) attributions are listed, because the screen's own figure counts them.
 *
 * Synthetic data only.
 */

const TOKEN_A1 = '000000:seed-token-acme-1';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

/** Telegram's own signer, independently of the verifier. */
function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const system = (label: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label,
  surface: 'TELEGRAM',
  correlationId: 'referral-friends-test' as CorrelationId,
});

describe('the mini app invited-friends list (R11 B3)', () => {
  let api: ApiApp;
  let owner: ActorContext;
  let panelId: string;
  let n = 0;
  let telegramId = 970_000;
  const key = (): string => `friends-${String((n += 1)).padStart(6, '0')}-abcdef`;
  const db = () => api.container.database.db;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await db().execute(query as never)) as unknown as { rows: T[] }).rows;
  }

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    panelId = api.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelId);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner-friends', roleKeys: ['owner'] }),
    );
    await setFlag('mini_app', true);
  });

  async function setFlag(flag: FeatureFlagKey, enabled: boolean) {
    const before = (await api.container.featureFlags.list(tenantA, owner)).find(
      (one) => one.key === flag,
    );
    if (before === undefined) throw new Error(`no ${flag} flag`);
    await api.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flag,
      enabled,
      expectedVersion: before.version,
      confirmKey: flag,
      reason: 'referral friends test',
    });
  }

  async function setSetting(settingKey: string, value: unknown) {
    const before = await api.container.settingsService.get(tenantA, owner, settingKey);
    await api.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: settingKey,
      value,
      expectedVersion: before.version,
    });
  }

  /** The purchase commission program on: a referee's paid order promises 10% to the referrer. */
  async function program() {
    await setSetting('referral.commission_percent', 10);
    await setSetting('referral.commission_scope', 'FIRST_PAID_ORDER');
    await setFlag('referrals', true);
  }

  async function session(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const friendsRaw = (token: string, cursor?: string) =>
    inject({
      method: 'GET',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.referralFriends)}${
        cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      }`,
      headers: { authorization: `Bearer ${token}` },
    });

  async function friends(token: string, cursor?: string): Promise<MiniAppReferralFriendsResponse> {
    const response = await friendsRaw(token, cursor);
    expect(response.statusCode, response.body).toBe(200);
    return miniAppReferralFriendsResponseSchema.parse(JSON.parse(response.body));
  }

  /** A registered customer: a referrer (via a session) or a referee (via a `/start` payload). */
  async function referrer(): Promise<{ id: UserId; telegramId: number; token: string }> {
    const id = (telegramId += 1);
    const token = await session(id);
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId} AND telegram_user_id = ${String(id)}`,
    );
    if (row === undefined) throw new Error('the session made no customer');
    return { id: row.id as UserId, telegramId: id, token };
  }

  async function referee(
    of: { telegramId: number } | null,
    from: Record<string, unknown> = { first_name: 'مهسا' },
  ): Promise<UserId> {
    const id = (telegramId += 1);
    const resolved = await api.container.customers.resolveFromUpdate(
      tenantA,
      system(`friend-${String(id)}`),
      {
        idempotencyKey: key(),
        telegramUserId: String(id),
        from: { id, ...from },
        botInstanceId: BOT_A,
        ...(of === null
          ? {}
          : { startPayload: referralStartPayloadForTelegramId(String(of.telegramId)) }),
      },
    );
    return resolved.customer.id;
  }

  const products = () => new DrizzleProductRepository(db());

  async function bought(customerId: UserId, delivered: boolean): Promise<OrderRecord> {
    const created = await products().create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products().setStatus(
      tenantA,
      created.id,
      'INACTIVE',
      'ACTIVE',
      api.container.clock.now(),
    );
    const draft = await api.container.orders.createDraft(tenantA, system(key()), {
      idempotencyKey: key(),
      customerId,
      productId: created.id,
    });
    const order = await api.container.orders.confirm(tenantA, system(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: draft.id,
    });
    await api.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: order.totals.total.amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمون',
    });
    await api.container.payments.settleFromWallet(tenantA, system(key()), customerId, {
      idempotencyKey: key(),
      orderId: order.id,
    });
    if (delivered) {
      await db().execute(sql`
        UPDATE provisioning_operations
           SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${order.id}`);
    }
    return order;
  }

  /** Forces the commission of a referee's order into a state the earner would have reached. */
  async function commissionOf(refereeId: UserId) {
    const [row] = await rows<{ id: string; state: string }>(
      sql`SELECT id, state FROM order_referral_commissions
           WHERE tenant_id = ${tenantA.tenantId} AND referee_id = ${refereeId}`,
    );
    if (row === undefined) throw new Error('no commission was promised for the order');
    return row;
  }

  const setCommission = (refereeId: UserId, assignments: ReturnType<typeof sql>) =>
    db().execute(sql`
      UPDATE order_referral_commissions SET ${assignments}
       WHERE tenant_id = ${tenantA.tenantId} AND referee_id = ${refereeId}`);

  const statusOf = (response: MiniAppReferralFriendsResponse, name: string) => {
    if (!response.enabled) throw new Error('the list is off');
    const found = response.items.find((item) => item.displayName === name);
    if (found === undefined) throw new Error(`no friend called ${name}`);
    return found;
  };

  // -------------------------------------------------------------------------------------

  it('is off by default: the route says so and nothing of the friends is in the answer', async () => {
    await program();
    const mine = await referrer();
    await referee(mine, { first_name: 'سارا' });
    const response = await friendsRaw(mine.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ enabled: false });
    expect(response.body).not.toContain('سارا');

    await setFlag('referral_friends_list', true);
    const on = await friends(mine.token);
    expect(on.enabled && on.counts.total).toBe(1);

    // Off again: the section goes, no referral row is touched.
    await setFlag('referral_friends_list', false);
    expect(JSON.parse((await friendsRaw(mine.token)).body)).toEqual({ enabled: false });
    expect(await rows(sql`SELECT 1 FROM referrals`)).toHaveLength(1);
  });

  it('lists the session customer’s own friends only, in their tenant only', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const first = await referrer();
    const second = await referrer();
    await referee(first, { first_name: 'علی' });
    await referee(first, { first_name: 'رضا' });
    await referee(second, { first_name: 'نگار' });

    const mine = await friends(first.token);
    expect(mine.enabled && mine.items.map((item) => item.displayName).sort()).toEqual([
      'رضا',
      'علی',
    ]);
    expect(mine.enabled && mine.counts.total).toBe(2);
    const theirs = await friends(second.token);
    expect(theirs.enabled && theirs.items.map((item) => item.displayName)).toEqual(['نگار']);

    // A friend is nobody's referrer: their own list is empty, not the referrer's.
    const [friendRow] = await rows<{ telegram_user_id: string }>(
      sql`SELECT c.telegram_user_id FROM customers c JOIN referrals r
            ON r.tenant_id = c.tenant_id AND r.referee_id = c.id
           WHERE c.first_name = 'علی'`,
    );
    const friendToken = await session(Number(friendRow?.telegram_user_id));
    const own = await friends(friendToken);
    expect(own.enabled && [own.items.length, own.counts.total]).toEqual([0, 0]);

    // The same referrer id asked in ANOTHER tenant finds nothing: the tenant is in the WHERE.
    const repository = new DrizzleReferralFriendsRepository(db());
    expect(await repository.page(tenantA, first.id, 20, null)).toMatchObject({
      items: expect.arrayContaining([]) as unknown[],
    });
    expect((await repository.page(tenantA, first.id, 20, null)).items).toHaveLength(2);
    expect(await repository.page(tenantB, first.id, 20, null)).toEqual({ items: [], next: null });
    expect(await repository.counts(tenantB, first.id)).toEqual({
      joined: 0,
      purchased: 0,
      rewardPending: 0,
      rewardPaid: 0,
    });
  });

  it('maps each purchase-commission state to one status, and the counts add up', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const mine = await referrer();

    await referee(mine, { first_name: 'پیوسته' });
    const voided = await referee(mine, { first_name: 'لغوشده' });
    const zero = await referee(mine, { first_name: 'صفرپرداخت' });
    const pending = await referee(mine, { first_name: 'درانتظار' });
    const held = await referee(mine, { first_name: 'نگهداشته' });
    const lapsed = await referee(mine, { first_name: 'گذشته' });
    const paid = await referee(mine, { first_name: 'پرداخت‌شده' });
    const undelivered = await referee(mine, { first_name: 'تحویل‌نشده' });

    for (const who of [voided, zero, pending, held, lapsed, paid]) await bought(who, true);
    await bought(undelivered, false);
    expect((await commissionOf(pending)).state).toBe('PENDING');

    await setCommission(voided, sql`state = 'VOID', voided_at = now()`);
    await setCommission(zero, sql`state = 'EARNED', earned_amount = 0, earned_at = now()`);
    await setCommission(held, sql`not_before = now() + interval '1 day'`);
    await setCommission(lapsed, sql`not_before = now() - interval '1 day'`);
    // EARNED for more than nothing names the ledger entry that credited it (a check enforces it).
    const credit = await api.container.wallet.adjust(tenantA, owner, mine.id, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 10_000n,
      currency: 'IRT',
      note: 'پورسانت آزمون',
    });
    await setCommission(
      paid,
      sql`state = 'EARNED', earned_amount = amount, earned_at = now(), earned_entry_id = ${credit.id}`,
    );
    // Paid but not delivered, and the promise voided: nothing was delivered, so only a join.
    await setCommission(undelivered, sql`state = 'VOID', voided_at = now()`);

    const response = await friends(mine.token);
    if (!response.enabled) throw new Error('the list is off');
    const by = (name: string) => statusOf(response, name);
    expect(by('پیوسته').status).toBe('JOINED');
    expect(by('لغوشده').status).toBe('PURCHASED');
    expect(by('صفرپرداخت').status).toBe('PURCHASED');
    expect(by('تحویل‌نشده').status).toBe('JOINED');
    expect(by('درانتظار')).toMatchObject({ status: 'REWARD_PENDING', rewardNotBefore: null });
    expect(by('نگهداشته').status).toBe('REWARD_PENDING');
    expect(by('نگهداشته').rewardNotBefore).not.toBeNull();
    // A cap day that has already come is no reason to wait.
    expect(by('گذشته')).toMatchObject({ status: 'REWARD_PENDING', rewardNotBefore: null });
    expect(by('پرداخت‌شده')).toMatchObject({ status: 'REWARD_PAID', rewardNotBefore: null });
    expect(response.counts).toEqual({
      total: 8,
      joined: 2,
      purchased: 2,
      rewardPending: 3,
      rewardPaid: 1,
    });
    // The list's total is the very figure the screen already shows as «دعوت‌شده».
    const stats = await api.container.referralSignupGifts.stats(tenantA, mine.id);
    expect(response.counts.total).toBe(stats.referralCount);
  });

  it('a pending reward with ONE commission waiting for delivery is not “held until” a day', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const mine = await referrer();
    const friend = await referee(mine, { first_name: 'دو‌سفارش' });
    await bought(friend, true);
    // One commission deferred, a second order's still waiting for delivery (no not_before).
    await setCommission(friend, sql`not_before = now() + interval '2 days'`);
    const [first] = await rows<{ order_id: string; referral_id: string; basis_amount: string }>(
      sql`SELECT order_id, referral_id, basis_amount::text FROM order_referral_commissions
           WHERE referee_id = ${friend}`,
    );
    const second = await bought(friend, false);
    await db().execute(sql`
      INSERT INTO order_referral_commissions
        (id, tenant_id, order_id, referral_id, referrer_id, referee_id, scope, percent,
         basis_amount, amount, currency, state)
      VALUES (${api.container.ids.uuid()}, ${tenantA.tenantId}, ${second.id},
              ${first?.referral_id}, ${mine.id}, ${friend}, 'EVERY_PAID_ORDER', 10,
              ${first?.basis_amount}, 10000, 'IRT', 'PENDING')
      ON CONFLICT DO NOTHING`);
    const response = await friends(mine.token);
    if (!response.enabled) throw new Error('the list is off');
    expect(statusOf(response, 'دو‌سفارش')).toMatchObject({
      status: 'REWARD_PENDING',
      rewardNotBefore: null,
    });
  });

  it('draws a friend by a first name or a masked username or nothing, and leaks no identity', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const mine = await referrer();
    const named = await referee(mine, {
      first_name: 'مهسا',
      last_name: 'اکبری‌زاده',
      username: 'mahsa_secret_handle',
    });
    const onlyHandle = await referee(mine, { first_name: 'x', username: 'handle_only_user' });
    await db().execute(sql`UPDATE customers SET first_name = NULL WHERE id = ${onlyHandle}`);
    const nobody = await referee(mine, { first_name: 'y' });
    await db().execute(
      sql`UPDATE customers SET first_name = NULL, username = NULL, last_name = 'فامیلی' WHERE id = ${nobody}`,
    );

    const response = await friendsRaw(mine.token);
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as { items: Record<string, unknown>[] };
    expect(body.items.map((item) => item.displayName).sort()).toEqual(
      ['@ha***', 'مهسا', null].sort(),
    );
    // Four keys per friend and no more: no id of any kind is on the wire.
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'displayName',
        'joinedAt',
        'rewardNotBefore',
        'status',
      ]);
    }
    const [named_] = await rows<{ telegram_user_id: string }>(
      sql`SELECT telegram_user_id FROM customers WHERE id = ${named}`,
    );
    for (const secret of [
      'اکبری‌زاده',
      'فامیلی',
      'mahsa_secret_handle',
      'handle_only_user',
      named_?.telegram_user_id ?? 'missing',
      named,
      nobody,
      onlyHandle,
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it('bounds a page, ends the traversal, and refuses a cursor the server did not mint', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const mine = await referrer();
    const total = MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE + 5;
    for (let i = 0; i < total; i += 1) await referee(mine, { first_name: `دوست ${String(i)}` });

    const one = await friends(mine.token);
    if (!one.enabled) throw new Error('the list is off');
    expect(one.items).toHaveLength(MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE);
    expect(one.nextCursor).not.toBeNull();
    const two = await friends(mine.token, one.nextCursor as string);
    if (!two.enabled) throw new Error('the list is off');
    expect(two.items).toHaveLength(5);
    expect(two.nextCursor).toBeNull();

    const seen = [...one.items, ...two.items];
    expect(new Set(seen.map((item) => item.displayName)).size).toBe(total);
    // Newest first, across the page boundary.
    const times = seen.map((item) => Date.parse(item.joinedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The counts are over every friend, not the page.
    expect(one.counts.total).toBe(total);
    expect(two.counts.total).toBe(total);

    for (const bad of ['not-a-cursor', '']) {
      const refused = await friendsRaw(mine.token, bad);
      expect(refused.statusCode, refused.body).toBe(400);
    }
  });

  it('lists an imported (MIRZA) attribution, because the screen’s own figure counts it', async () => {
    await program();
    await setFlag('referral_friends_list', true);
    const mine = await referrer();
    await referee(mine, { first_name: 'تازه' });
    // An attribution the one-time import carried: no `/start`, a Mirza reference, history only.
    const imported = await referee(null, { first_name: 'واردشده' });
    await db().execute(sql`
      INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger, source, source_ref)
      VALUES (${api.container.ids.uuid()}, ${tenantA.tenantId}, ${mine.id}, ${imported},
              'ON_FIRST_PAID_ORDER', 'MIRZA', 'mirza-ref-1')`);

    const response = await friends(mine.token);
    if (!response.enabled) throw new Error('the list is off');
    expect(response.items.map((item) => item.displayName).sort()).toEqual(
      ['تازه', 'واردشده'].sort(),
    );
    const stats = await api.container.referralSignupGifts.stats(tenantA, mine.id);
    expect(response.counts.total).toBe(stats.referralCount);
    expect(stats.referralCount).toBe(2);
  });
});
