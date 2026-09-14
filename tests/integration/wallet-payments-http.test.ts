import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  PAYMENT_ROUTES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  WALLET_ROUTES,
  money,
  paymentListResponseSchema,
  paymentResponseSchema,
  walletEntryListResponseSchema,
  walletResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * The wallet and payment HTTP surfaces, over real HTTP.
 *
 * What only exists at this layer, and is therefore only testable here:
 *
 *   - the PROJECTION. The one place a field no contract declares could become JSON, and
 *     the one place a bigint could be serialised as a number and lose precision.
 *   - AUTHORIZATION for an authenticated caller who holds the wrong permission. The Web
 *     Admin not drawing a button is not authorization, and every route here is reached
 *     by a real operator who is refused by the service rather than by the UI.
 *   - TENANT SCOPE taken from the session, which is what makes another tenant's id
 *     useless rather than merely unlikely.
 *   - the ABSENCE of a write. There is no set-balance, no ledger edit and no ledger
 *     delete, and the case at the bottom asserts that by ASKING for them — a comment
 *     saying "we did not build these" cannot notice the commit that does.
 */

const ORIGIN = 'https://admin.example.test';

describe('wallet and payment HTTP surfaces', () => {
  let api: ApiApp;
  /** Holds `users.view` and nothing financial. Can look, cannot move money. */
  let viewerCookie: string;
  /** `finance`: `users.wallet.credit` and `receipts.review`, but NOT `users.wallet.debit`. */
  let financeCookie: string;
  /** A real operator holding no `users.*` or `payments.*` permission at all. */
  let technicalCookie: string;
  let ownerCookie: string;
  let panelA: string;
  let products: DrizzleProductRepository;
  let customerA: UserId;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(api.container.database.db);

    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'finance',
      password: 'the-finance-password',
      roleKeys: ['finance'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-password',
      roleKeys: ['owner'],
    });

    /*
     * A role holding `users.view` ALONE.
     *
     * No system role has exactly that shape, and the distinction matters: this is the
     * operator who may read a balance and may not move it, which is the whole reason
     * `users.view` and `users.wallet.*` are different permissions.
     */
    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'wallet_viewer', 'Wallet viewer', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'users.view'),
             (${tenantA.tenantId}, ${viewerRoleId}, 'payments.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://panel.example.test', 'ACTIVE')`);

    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
    financeCookie = await cookieFor('finance', 'the-finance-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
    ownerCookie = await cookieFor('owner', 'the-owners-password');
    customerA = await customer(tenantA, SEED_IDS.botA1 as BotInstanceId, '900400');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const systemActor = (correlationId: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: correlationId as CorrelationId,
  });

  async function customer(
    scope: typeof tenantA,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId,
      },
    );
    return record.id;
  }

  async function awaitingPayment(
    scope: typeof tenantA,
    customerId: UserId,
    panelId: string,
    key: string,
  ) {
    const created = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    const order = await api.container.orders.createDraft(scope, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: created.id,
    });
    return api.container.orders.confirm(scope, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: order.id,
    });
  }

  const get = (url: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${url}`, headers: { cookie } });

  const post = (url: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${url}`,
      headers: { cookie, origin: ORIGIN },
      payload,
    });

  const errorOf = (body: string): { code: string } =>
    (JSON.parse(body) as { error: { code: string } }).error;

  // -------------------------------------------------------------------------
  // Reading a wallet
  // -------------------------------------------------------------------------

  it('returns a DERIVED balance and the count of entries behind it', async () => {
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'seeder', roleKeys: ['owner'] }),
    );
    /*
     * The largest amount one movement may carry.
     *
     * `PAYMENT_AMOUNT_MAX_MINOR` bounds a SINGLE movement at 1e12, so no one entry can
     * reach 2^53 — the exactness of a SUM that does is proved at the repository, where
     * `wallet.test.ts` appends 9_007_199_254_740_993 directly. What this case proves is
     * the PROJECTION: the amount leaves as TEXT, so a balance that has grown past 2^53
     * across many entries is not rounded on its way to the operator.
     */
    await api.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'seed-credit-0001',
      direction: 'CREDIT',
      amountMinor: 999_999_999_999n,
      currency: 'IRT',
      note: 'the largest one movement may carry',
    });

    const response = await get(WALLET_ROUTES.balance(customerA), viewerCookie);
    expect(response.statusCode).toBe(200);
    const parsed = walletResponseSchema.parse(JSON.parse(response.body));

    expect(parsed.wallet.balanceAmount).toBe('999999999999');
    expect(typeof parsed.wallet.balanceAmount).toBe('string');
    expect(parsed.wallet.currency).toBe('IRT');
    expect(parsed.wallet.entryCount).toBe(1);
    // No stored balance field could appear: there is none to return.
    expect(JSON.parse(response.body)).not.toHaveProperty('wallet.balance');
  });

  it('pages the ledger newest first, and the cursor is one this server minted', async () => {
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'pager', roleKeys: ['owner'] }),
    );
    for (let i = 0; i < 3; i += 1) {
      await api.container.wallet.adjust(tenantA, owner, customerA, {
        idempotencyKey: `page-credit-000${String(i)}`,
        direction: 'CREDIT',
        amountMinor: BigInt(i + 1) * 1_000n,
        currency: 'IRT',
        note: `entry ${String(i)}`,
      });
    }

    const first = await get(`${WALLET_ROUTES.entries(customerA)}?limit=2`, viewerCookie);
    const firstPage = walletEntryListResponseSchema.parse(JSON.parse(first.body));
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    // Newest first: a ledger is read backwards from the last thing that happened.
    expect(firstPage.entries[0]?.note).toBe('entry 2');

    const second = await get(
      `${WALLET_ROUTES.entries(customerA)}?limit=2&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? '',
      )}`,
      viewerCookie,
    );
    const secondPage = walletEntryListResponseSchema.parse(JSON.parse(second.body));
    expect(secondPage.entries.map((e) => e.note)).toEqual(['entry 0']);
    expect(secondPage.nextCursor).toBeNull();

    // A cursor this server did not mint is a 400, not a 500 at the timestamp cast.
    const bogus = await get(`${WALLET_ROUTES.entries(customerA)}?cursor=nonsense`, viewerCookie);
    expect(bogus.statusCode).toBe(400);
  });

  it('refuses a reader who holds no users.view', async () => {
    const response = await get(WALLET_ROUTES.balance(customerA), technicalCookie);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).code).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
  });

  it('answers a MALFORMED customer id with a 400, never a 500', async () => {
    const response = await get(WALLET_ROUTES.balance('not-a-uuid'), viewerCookie);
    expect(response.statusCode).toBe(400);
  });

  it('cannot read a wallet in another tenant', async () => {
    const customerB = await customer(tenantB, SEED_IDS.botB1 as BotInstanceId, '900401');
    // The scope comes from the SESSION, so tenant A's operator asking for tenant B's
    // customer gets "unknown customer" rather than a balance.
    const response = await get(WALLET_ROUTES.balance(customerB), viewerCookie);
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body).code).toBe(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND);
  });

  // -------------------------------------------------------------------------
  // Moving a wallet
  // -------------------------------------------------------------------------

  it('credits under users.wallet.credit, once for a repeated key', async () => {
    const body = {
      idempotencyKey: 'http-credit-0001',
      direction: 'CREDIT',
      amount: '500000',
      currency: 'IRT',
      note: 'goodwill',
    };
    const first = await post(WALLET_ROUTES.adjust(customerA), financeCookie, body);
    expect(first.statusCode).toBe(201);
    const again = await post(WALLET_ROUTES.adjust(customerA), financeCookie, body);
    expect(again.statusCode).toBe(201);

    expect((JSON.parse(again.body) as { entry: { id: string } }).entry.id).toBe(
      (JSON.parse(first.body) as { entry: { id: string } }).entry.id,
    );
    const balance = walletResponseSchema.parse(
      JSON.parse((await get(WALLET_ROUTES.balance(customerA), viewerCookie)).body),
    );
    expect(balance.wallet.balanceAmount).toBe('500000');
    expect(balance.wallet.entryCount).toBe(1);
  });

  /*
   * `finance` holds `users.wallet.credit` and NOT `users.wallet.debit`.
   *
   * That is the actor that can tell the two permissions apart. An operator holding
   * neither is refused either way and proves only that some permission is charged.
   */
  it('refuses a DEBIT from a credit-only operator, and audits the refusal', async () => {
    const response = await post(WALLET_ROUTES.adjust(customerA), financeCookie, {
      idempotencyKey: 'http-debit-0001',
      direction: 'DEBIT',
      amount: '1',
      currency: 'IRT',
      note: 'should not happen',
    });
    expect(response.statusCode).toBe(403);

    const audit = (await api.container.database.db.execute(
      sql`SELECT action, result FROM audit_logs WHERE entity_type = 'Wallet'` as never,
    )) as unknown as { rows: { action: string; result: string }[] };
    expect(audit.rows).toEqual([{ action: 'wallet.debit', result: 'DENIED' }]);
  });

  it('debits under users.wallet.debit, and refuses one the balance cannot cover', async () => {
    await post(WALLET_ROUTES.adjust(customerA), ownerCookie, {
      idempotencyKey: 'http-fund-0001',
      direction: 'CREDIT',
      amount: '100000',
      currency: 'IRT',
      note: 'fund',
    });

    const tooMuch = await post(WALLET_ROUTES.adjust(customerA), ownerCookie, {
      idempotencyKey: 'http-debit-0002',
      direction: 'DEBIT',
      amount: '250000',
      currency: 'IRT',
      note: 'more than there is',
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(errorOf(tooMuch.body).code).toBe(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS);

    const ok = await post(WALLET_ROUTES.adjust(customerA), ownerCookie, {
      idempotencyKey: 'http-debit-0003',
      direction: 'DEBIT',
      amount: '40000',
      currency: 'IRT',
      note: 'correction',
    });
    expect(ok.statusCode).toBe(201);
    const balance = walletResponseSchema.parse(
      JSON.parse((await get(WALLET_ROUTES.balance(customerA), viewerCookie)).body),
    );
    expect(balance.wallet.balanceAmount).toBe('60000');
  });

  it('refuses an amount of zero, a negative, one past the ceiling and a bad currency', async () => {
    for (const amount of ['0', '-1', '1000000000001', 'abc']) {
      const response = await post(WALLET_ROUTES.adjust(customerA), ownerCookie, {
        idempotencyKey: `http-bounds-${amount}`,
        direction: 'CREDIT',
        amount,
        currency: 'IRT',
        note: 'bounds',
      });
      expect(response.statusCode, `amount ${amount} was accepted`).toBe(400);
    }
    const wrongCurrency = await post(WALLET_ROUTES.adjust(customerA), ownerCookie, {
      idempotencyKey: 'http-bounds-currency',
      direction: 'CREDIT',
      amount: '1000',
      currency: 'GBP',
      note: 'bounds',
    });
    expect(wrongCurrency.statusCode).toBe(400);
  });

  /*
   * The routes that do NOT exist, asserted by asking for them.
   *
   * A balance cannot be set, an entry cannot be edited and an entry cannot be deleted.
   * The legacy `صفر کردن موجودی` button is a set-balance in disguise, and it is the
   * single easiest thing to add here by accident.
   */
  it('offers no way to set a balance, edit an entry or delete one', async () => {
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'absent', roleKeys: ['owner'] }),
    );
    const entry = await api.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'absent-credit-0001',
      direction: 'CREDIT',
      amountMinor: 1_000n,
      currency: 'IRT',
      note: 'there',
    });

    for (const [method, url] of [
      ['PUT', WALLET_ROUTES.balance(customerA)],
      ['PATCH', WALLET_ROUTES.balance(customerA)],
      ['DELETE', WALLET_ROUTES.balance(customerA)],
      ['PUT', `${WALLET_ROUTES.entries(customerA)}/${entry.id}`],
      ['PATCH', `${WALLET_ROUTES.entries(customerA)}/${entry.id}`],
      ['DELETE', `${WALLET_ROUTES.entries(customerA)}/${entry.id}`],
    ] as const) {
      const response = await inject({
        method,
        url: `${API_PREFIX}${url}`,
        headers: { cookie: ownerCookie, origin: ORIGIN },
        payload: { amount: '0' },
      });
      expect(response.statusCode, `${method} ${url} exists`).toBe(404);
    }
  });

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------

  it('lists payments, filters them, and keeps the evidence note off the list', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-1');
    const pending = await api.container.payments.requestManualTransfer(
      tenantA,
      systemActor('http-pay-1'),
      customerA,
      { idempotencyKey: 'http-manual-0001', orderId: order.id },
    );

    const all = await get(PAYMENT_ROUTES.list, viewerCookie);
    expect(all.statusCode).toBe(200);
    const list = paymentListResponseSchema.parse(JSON.parse(all.body));
    expect(list.payments).toHaveLength(1);
    expect(list.payments[0]?.amount).toBe('250000');
    // The note is an operator's own text about somebody's transfer. Detail only.
    expect(list.payments[0]).not.toHaveProperty('evidenceNote');

    for (const [query, expected] of [
      ['state=PENDING', 1],
      ['state=CONFIRMED', 0],
      ['method=MANUAL_TRANSFER', 1],
      ['method=WALLET', 0],
      [`orderId=${order.id}`, 1],
      [`customerId=${customerA}`, 1],
      [`reference=${pending.reference}`, 1],
      ['reference=not-a-real-reference', 0],
    ] as const) {
      const response = await get(`${PAYMENT_ROUTES.list}?${query}`, viewerCookie);
      const page = paymentListResponseSchema.parse(JSON.parse(response.body));
      expect(page.payments, `filter ${query}`).toHaveLength(expected);
    }
  });

  it('shows the detail with its evidence note, behind payments.view', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-2');
    const pending = await api.container.payments.requestManualTransfer(
      tenantA,
      systemActor('http-pay-2'),
      customerA,
      { idempotencyKey: 'http-manual-0002', orderId: order.id },
    );

    const refused = await get(PAYMENT_ROUTES.detail(pending.id), technicalCookie);
    expect(refused.statusCode).toBe(403);

    const response = await get(PAYMENT_ROUTES.detail(pending.id), viewerCookie);
    const parsed = paymentResponseSchema.parse(JSON.parse(response.body));
    expect(parsed.payment.state).toBe('PENDING');
    expect(parsed.payment.evidenceNote).toBeNull();
    expect(parsed.payment.confirmedByAdminId).toBeNull();
  });

  it('confirms under receipts.review, settles the order, and records the reviewer', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-3');
    const pending = await api.container.payments.requestManualTransfer(
      tenantA,
      systemActor('http-pay-3'),
      customerA,
      { idempotencyKey: 'http-manual-0003', orderId: order.id },
    );

    // `viewer` holds `payments.view` and NOT `receipts.review`: the reader who can see a
    // payment and must not be able to approve it.
    const refused = await post(PAYMENT_ROUTES.confirm(pending.id), viewerCookie, {
      idempotencyKey: 'http-confirm-0001',
      evidenceNote: 'not mine to approve',
    });
    expect(refused.statusCode).toBe(403);

    const response = await post(PAYMENT_ROUTES.confirm(pending.id), financeCookie, {
      idempotencyKey: 'http-confirm-0002',
      evidenceNote: 'کارت به کارت، ۴ رقم آخر ۱۲۳۴',
    });
    expect(response.statusCode).toBe(201);
    const parsed = paymentResponseSchema.parse(JSON.parse(response.body));
    expect(parsed.payment.state).toBe('CONFIRMED');
    expect(parsed.payment.evidenceKind).toBe('OPERATOR_REVIEW');
    expect(parsed.payment.confirmedByAdminId).not.toBeNull();
    expect(parsed.payment.confirmedAt).not.toBeNull();
    // The amount is UNCHANGED by the confirmation, and there is no field to change it.
    expect(parsed.payment.amount).toBe('250000');

    const rows = (await api.container.database.db.execute(
      sql`SELECT state, settled_at FROM orders WHERE id = ${order.id}` as never,
    )) as unknown as { rows: { state: string; settled_at: string | null }[] };
    expect(rows.rows[0]?.state).toBe('PAID');
    expect(rows.rows[0]?.settled_at).not.toBeNull();
  });

  it('answers a repeated confirmation with the same payment, and settles once', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-4');
    const pending = await api.container.payments.requestManualTransfer(
      tenantA,
      systemActor('http-pay-4'),
      customerA,
      { idempotencyKey: 'http-manual-0004', orderId: order.id },
    );
    const body = { idempotencyKey: 'http-confirm-0003', evidenceNote: 'received' };

    const first = await post(PAYMENT_ROUTES.confirm(pending.id), financeCookie, body);
    const again = await post(PAYMENT_ROUTES.confirm(pending.id), financeCookie, body);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);

    const events = (await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(events.rows[0]?.n).toBe(1);
  });

  it('cannot confirm a payment in another tenant', async () => {
    const customerB = await customer(tenantB, SEED_IDS.botB1 as BotInstanceId, '900402');
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const theirOrder = await awaitingPayment(tenantB, customerB, panelB, 'http-pay-5');
    const theirs = await api.container.payments.requestManualTransfer(
      tenantB,
      systemActor('http-pay-5'),
      customerB,
      { idempotencyKey: 'http-manual-0005', orderId: theirOrder.id },
    );

    // The list does not show it and the confirmation does not find it.
    const list = paymentListResponseSchema.parse(
      JSON.parse((await get(PAYMENT_ROUTES.list, viewerCookie)).body),
    );
    expect(list.payments).toHaveLength(0);

    const response = await post(PAYMENT_ROUTES.confirm(theirs.id), financeCookie, {
      idempotencyKey: 'http-confirm-0004',
      evidenceNote: 'not mine',
    });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body).code).toBe(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND);
  });

  /*
   * The payment writes that do NOT exist, asserted by asking.
   *
   * `payments.retry` is a frozen permission for a gateway that does not ship, and a
   * retry button with nothing behind it is the legacy silent-success pattern. There is
   * also no way for an operator to CREATE a payment: one is created by a customer
   * choosing how to pay.
   */
  it('offers no way to create, fail, cancel, retry or refund a payment', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-6');
    const pending = await api.container.payments.requestManualTransfer(
      tenantA,
      systemActor('http-pay-6'),
      customerA,
      { idempotencyKey: 'http-manual-0006', orderId: order.id },
    );

    for (const url of [
      PAYMENT_ROUTES.list,
      `${PAYMENT_ROUTES.detail(pending.id)}/fail`,
      `${PAYMENT_ROUTES.detail(pending.id)}/cancel`,
      `${PAYMENT_ROUTES.detail(pending.id)}/retry`,
      `${PAYMENT_ROUTES.detail(pending.id)}/refund`,
    ]) {
      const response = await post(url, ownerCookie, { idempotencyKey: 'x'.repeat(12) });
      expect(response.statusCode, `POST ${url} exists`).toBe(404);
    }
  });
});
