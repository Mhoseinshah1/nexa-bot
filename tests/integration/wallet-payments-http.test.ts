import { sql } from 'drizzle-orm';
import type { ProductCategoryId } from '@nexa/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  COMPENSATION_ROUTES,
  compensationListResponseSchema,
  paymentReceiptListResponseSchema,
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
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
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
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(api.container, tenantA, panelA);

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
        /*
         * The category of the tenant this product is written for, never a fixed one.
         * `products_tenant_category_fk` is composite, so a tenant B product filed
         * under tenant A's category is refused by the database — turning a
         * cross-tenant isolation test into a foreign-key error instead of the
         * assertion it was written to make.
         */
        categoryId: seededCategoryFor(scope) as ProductCategoryId,
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
    const pending = await api.container.payments
      .requestManualTransfer(tenantA, systemActor('http-pay-1'), customerA, {
        idempotencyKey: 'http-manual-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

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
    const pending = await api.container.payments
      .requestManualTransfer(tenantA, systemActor('http-pay-2'), customerA, {
        idempotencyKey: 'http-manual-0002',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

    const refused = await get(PAYMENT_ROUTES.detail(pending.id), technicalCookie);
    expect(refused.statusCode).toBe(403);

    const response = await get(PAYMENT_ROUTES.detail(pending.id), viewerCookie);
    const parsed = paymentResponseSchema.parse(JSON.parse(response.body));
    expect(parsed.payment.state).toBe('PENDING');
    expect(parsed.payment.evidenceNote).toBeNull();
    expect(parsed.payment.confirmedByAdminId).toBeNull();

    /*
     * The frozen destination, over HTTP, since the Codex review of PR #34.
     *
     * The service read and the Web Admin rendering are each covered in their own suite;
     * what neither can see is the CONTROLLER — `toDetail` receiving a null it did not
     * have to, which would leave both of those green and every payment screen empty.
     * The seeded account is the destination this payment was issued against.
     */
    const destination = parsed.payment.destination;
    expect(destination, 'a manual transfer names where it was sent').not.toBeNull();
    expect(destination?.accountId).toBe(SEED_IDS.paymentAccountA);
    // FOUR digits. The sixteen must not be on the wire at all — a browser that never
    // receives them cannot leak them, which is the whole reason the view is narrow.
    expect(destination?.cardLast4).toMatch(/^[0-9]{4}$/u);
    expect(response.body).not.toMatch(/[0-9]{16}/u);
  });

  /*
   * Payment File 02 §10 (D3): card-to-card review is Telegram's, and the Web Admin is
   * read-only for it. The two routes that used to confirm and reject are GONE — not
   * refused by a permission, absent — so even the owner, who holds every key, reaches
   * nothing, and the payment and its order are untouched.
   */
  it('offers no way to confirm or reject a card-to-card payment over HTTP, even to the owner', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'http-pay-3');
    const pending = await api.container.payments
      .requestManualTransfer(tenantA, systemActor('http-pay-3'), customerA, {
        idempotencyKey: 'http-manual-0003',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

    for (const [suffix, body] of [
      ['confirm', { idempotencyKey: 'http-confirm-0002', evidenceNote: 'received' }],
      ['reject', { idempotencyKey: 'http-reject-0002', resolutionNote: 'not received' }],
      ['receipt-credit', { idempotencyKey: 'http-credit-0002', amountMinor: '250000' }],
      ['late-credit', { idempotencyKey: 'http-late-0002' }],
      ['late-dismiss', { idempotencyKey: 'http-late-0003', reason: 'NOT_RECEIVED' }],
    ] as const) {
      const url = `${PAYMENT_ROUTES.detail(pending.id)}/${suffix}`;
      for (const cookie of [ownerCookie, financeCookie]) {
        const response = await post(url, cookie, body);
        expect(response.statusCode, `POST ${url} exists`).toBe(404);
      }
    }

    const detail = paymentResponseSchema.parse(
      JSON.parse((await get(PAYMENT_ROUTES.detail(pending.id), ownerCookie)).body),
    );
    expect(detail.payment.state).toBe('PENDING');
    const rows = (await api.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${order.id}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(rows.rows[0]?.state).toBe('AWAITING_PAYMENT');
  });

  it('lists only this tenant’s payments', async () => {
    const customerB = await customer(tenantB, SEED_IDS.botB1 as BotInstanceId, '900402');
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantB, panelB);
    const theirOrder = await awaitingPayment(tenantB, customerB, panelB, 'http-pay-5');
    const theirs = await api.container.payments
      .requestManualTransfer(tenantB, systemActor('http-pay-5'), customerB, {
        idempotencyKey: 'http-manual-0005',
        orderId: theirOrder.id,
      })
      .then((issued) => issued.payment);

    const list = paymentListResponseSchema.parse(
      JSON.parse((await get(PAYMENT_ROUTES.list, viewerCookie)).body),
    );
    expect(list.payments).toHaveLength(0);
    const detail = await get(PAYMENT_ROUTES.detail(theirs.id), ownerCookie);
    expect(detail.statusCode).toBe(404);
    expect(errorOf(detail.body).code).toBe(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND);
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
    const pending = await api.container.payments
      .requestManualTransfer(tenantA, systemActor('http-pay-6'), customerA, {
        idempotencyKey: 'http-manual-0006',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

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
  // -------------------------------------------------------------------------
  // Payment File 02 §21 (D7): the diagnostics, over HTTP
  // -------------------------------------------------------------------------

  describe('the payment diagnostics', () => {
    it('shows the payment id, Telegram id and username, gateway, external reference and times', async () => {
      await api.container.database.db.execute(
        sql`UPDATE customers SET username = 'zahra_pays' WHERE id = ${customerA}`,
      );
      const order = await awaitingPayment(tenantA, customerA, panelA, 'http-d7-1');
      const pending = await api.container.payments
        .requestManualTransfer(tenantA, systemActor('http-d7-1'), customerA, {
          idempotencyKey: 'http-d7-manual-1',
          orderId: order.id,
        })
        .then((issued) => issued.payment);

      const list = paymentListResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.list, viewerCookie)).body),
      );
      expect(list.payments).toHaveLength(1);
      expect(list.payments[0]).toMatchObject({
        id: pending.id,
        orderId: order.id,
        customerId: customerA,
        customerTelegramUserId: '900400',
        customerUsername: 'zahra_pays',
        gatewayProvider: 'MANUAL_TRANSFER',
        externalReference: null,
        amount: '250000',
        state: 'PENDING',
      });
      expect(list.payments[0]?.createdAt).toMatch(/Z$/u);
      expect(list.payments[0]?.updatedAt).toMatch(/Z$/u);

      const detail = paymentResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.detail(pending.id), viewerCookie)).body),
      );
      expect(detail.payment).toMatchObject({
        customerTelegramUserId: '900400',
        customerUsername: 'zahra_pays',
        gatewayProvider: 'MANUAL_TRANSFER',
        // An order payment promises no top-up gift, and was not credited to a wallet.
        topupCashbackPercent: null,
        receiptCredit: null,
      });
    });

    it('shows a receipt’s credit-to-wallet disposition on the detail, read-only', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'http-d7-2');
      const { payment } = await api.container.payments.requestManualTransfer(
        tenantA,
        systemActor('http-d7-2'),
        customerA,
        { idempotencyKey: 'http-d7-manual-2', orderId: order.id },
      );
      await api.container.payments.signalTransferSent(
        tenantA,
        systemActor('http-d7-2'),
        customerA,
        {
          idempotencyKey: 'http-d7-signal-2',
          paymentId: payment.id,
          botInstanceId: SEED_IDS.botA1 as BotInstanceId,
        },
      );
      await api.container.receipts.submit(tenantA, systemActor('http-d7-2'), customerA, {
        idempotencyKey: 'http-d7-file-2',
        botInstanceId: SEED_IDS.botA1 as BotInstanceId,
        file: {
          kind: 'PHOTO',
          fileId: 'file-d7-2',
          fileUniqueId: 'u-d7-2',
          mimeType: null,
          fileSize: 1_024n,
          fileName: null,
          telegramMessageId: 8n,
          caption: 'واریز از کارت همسرم',
        },
      });
      const finance = adminActorFor(
        await createAdmin(api.container, tenantA, {
          username: 'finance-d7',
          roleKeys: ['finance'],
        }),
      );
      await api.container.receiptDispositions.creditToWallet(tenantA, finance, {
        idempotencyKey: 'http-d7-credit-2',
        paymentId: payment.id,
        amountMinor: 240_000n,
        note: 'کمتر واریز شده',
      });

      const detail = paymentResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.detail(payment.id), viewerCookie)).body),
      );
      expect(detail.payment.state).toBe('FAILED');
      expect(detail.payment.receiptCredit).toMatchObject({
        amountMinor: '240000',
        currency: 'IRT',
        decidedByAdminId: finance.id,
        note: 'کمتر واریز شده',
      });
      // The customer's caption is for the reviewer's Telegram caption, never a browser.
      const receipts = await get(PAYMENT_ROUTES.receipts(payment.id), financeCookie);
      expect(receipts.body).not.toContain('همسرم');
    });

    /*
     * WP10 follow-up §5: a receipt CREDITED TO THE WALLET is FAILED by state and must not read
     * as a rejection anywhere a payment is listed. Three receipts decided three ways, one
     * pending, and a rejected transfer that never carried a receipt: the list and the detail
     * say which is which, and the filter finds exactly the credited one.
     */
    it('tells a credited receipt from a rejected one, on the list, the detail and the filter', async () => {
      const finance = adminActorFor(
        await createAdmin(api.container, tenantA, {
          username: 'finance-disp',
          roleKeys: ['finance'],
        }),
      );
      async function receipted(key: string, withReceipt = true) {
        const order = await awaitingPayment(tenantA, customerA, panelA, key);
        const { payment } = await api.container.payments.requestManualTransfer(
          tenantA,
          systemActor(key),
          customerA,
          { idempotencyKey: `${key}-manual`, orderId: order.id },
        );
        await api.container.payments.signalTransferSent(tenantA, systemActor(key), customerA, {
          idempotencyKey: `${key}-signal`,
          paymentId: payment.id,
          botInstanceId: SEED_IDS.botA1 as BotInstanceId,
        });
        if (withReceipt) {
          await api.container.receipts.submit(tenantA, systemActor(key), customerA, {
            idempotencyKey: `${key}-file`,
            botInstanceId: SEED_IDS.botA1 as BotInstanceId,
            file: {
              kind: 'PHOTO',
              fileId: `file-${key}`,
              fileUniqueId: `u-${key}`,
              mimeType: null,
              fileSize: 1_024n,
              fileName: null,
              telegramMessageId: 9n,
              caption: null,
            },
          });
        }
        return payment.id;
      }
      const credited = await receipted('disp-credit');
      await api.container.receiptDispositions.creditToWallet(tenantA, finance, {
        idempotencyKey: 'disp-credit-credit',
        paymentId: credited,
        amountMinor: 230_000n,
        note: null,
      });
      const rejected = await receipted('disp-reject');
      await api.container.payments.rejectManualTransfer(tenantA, finance, rejected, {
        idempotencyKey: 'disp-reject-reject',
        note: 'رسید ناخوانا',
      });
      const approved = await receipted('disp-approve');
      await api.container.payments.confirmManualTransfer(tenantA, finance, approved, {
        idempotencyKey: 'disp-approve-approve',
        note: 'ok',
      });
      const pending = await receipted('disp-pending');
      const signalOnly = await receipted('disp-signal', false);
      await api.container.payments.rejectManualTransfer(tenantA, finance, signalOnly, {
        idempotencyKey: 'disp-signal-reject',
        note: 'هیچ رسیدی نیامد',
      });

      const list = paymentListResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.list, viewerCookie)).body),
      );
      const of = (id: string) => list.payments.find((one) => one.id === id);
      expect(of(credited)).toMatchObject({
        state: 'FAILED',
        receiptDisposition: 'CREDITED_TO_WALLET',
      });
      expect(of(rejected)).toMatchObject({ state: 'FAILED', receiptDisposition: 'REJECTED' });
      expect(of(approved)).toMatchObject({ state: 'CONFIRMED', receiptDisposition: 'APPROVED' });
      expect(of(pending)).toMatchObject({ state: 'PENDING', receiptDisposition: null });
      // A rejection with no receipt is a payment decision, not a receipt disposition.
      expect(of(signalOnly)).toMatchObject({ state: 'FAILED', receiptDisposition: null });

      const detail = paymentResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.detail(credited), viewerCookie)).body),
      );
      expect(detail.payment).toMatchObject({
        state: 'FAILED',
        receiptDisposition: 'CREDITED_TO_WALLET',
        receiptCredit: { amountMinor: '230000', currency: 'IRT', decidedByAdminId: finance.id },
      });
      expect(detail.payment.receiptCredit?.decidedAt).toEqual(expect.any(String));
      const rejectedDetail = paymentResponseSchema.parse(
        JSON.parse((await get(PAYMENT_ROUTES.detail(rejected), viewerCookie)).body),
      );
      expect(rejectedDetail.payment).toMatchObject({
        receiptDisposition: 'REJECTED',
        receiptCredit: null,
        resolutionNote: 'رسید ناخوانا',
      });

      const filtered = paymentListResponseSchema.parse(
        JSON.parse(
          (await get(`${PAYMENT_ROUTES.list}?disposition=CREDITED_TO_WALLET`, viewerCookie)).body,
        ),
      );
      expect(filtered.payments.map((one) => one.id)).toEqual([credited]);
      const rejectedOnly = paymentListResponseSchema.parse(
        JSON.parse((await get(`${PAYMENT_ROUTES.list}?disposition=REJECTED`, viewerCookie)).body),
      );
      expect(rejectedOnly.payments.map((one) => one.id)).toEqual([rejected]);
    });

    it('lists the compensations: automatic wallet refunds of undeliverable orders, paged', async () => {
      const refused = await get(COMPENSATION_ROUTES.list, technicalCookie);
      expect(refused.statusCode).toBe(403);

      const empty = compensationListResponseSchema.parse(
        JSON.parse((await get(COMPENSATION_ROUTES.list, viewerCookie)).body),
      );
      expect(empty).toEqual({ compensations: [], nextCursor: null });

      // Two transfers confirmed after their panel was switched off: the automatic lane
      // refunds each to the wallet in the confirming transaction (§13).
      const finance = adminActorFor(
        await createAdmin(api.container, tenantA, {
          username: 'finance-d7c',
          roleKeys: ['finance'],
        }),
      );
      const refunded: string[] = [];
      for (const key of ['http-d7-c1', 'http-d7-c2']) {
        await api.container.database.db.execute(
          sql`UPDATE panels SET status = 'ACTIVE' WHERE id = ${panelA}`,
        );
        const order = await awaitingPayment(tenantA, customerA, panelA, key);
        const { payment } = await api.container.payments.requestManualTransfer(
          tenantA,
          systemActor(key),
          customerA,
          { idempotencyKey: `${key}-manual`, orderId: order.id },
        );
        await api.container.database.db.execute(
          sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
        );
        const confirmed = await api.container.payments.confirmManualTransfer(
          tenantA,
          finance,
          payment.id,
          { idempotencyKey: `${key}-confirm`, note: 'arrived' },
        );
        expect(confirmed.order?.state).toBe('REFUNDED');
        refunded.push(payment.id);
      }

      // An OPERATOR's refund of a delivered wallet order, beside them: a refund, and not a
      // compensation. Its reason is the operator's free text, and here it reads exactly
      // like the automatic lane's — `UNDELIVERABLE`, on a `WALLET_CREDIT` refund — so only
      // the missing requesting administrator can tell the two apart (Codex, PR #70).
      await api.container.database.db.execute(
        sql`UPDATE panels SET status = 'ACTIVE' WHERE id = ${panelA}`,
      );
      const owner = adminActorFor(
        await createAdmin(api.container, tenantA, { username: 'owner-d7c', roleKeys: ['owner'] }),
      );
      await api.container.wallet.adjust(tenantA, owner, customerA, {
        idempotencyKey: 'http-d7-fund',
        direction: 'CREDIT',
        amountMinor: 250_000n,
        currency: 'IRT',
        note: 'fixture',
      });
      const delivered = await awaitingPayment(tenantA, customerA, panelA, 'http-d7-c3');
      const { payment: walletPayment } = await api.container.payments.settleFromWallet(
        tenantA,
        systemActor('http-d7-c3'),
        customerA,
        { idempotencyKey: 'http-d7-c3-settle', orderId: delivered.id },
      );
      await api.container.database.db.execute(sql`
        UPDATE provisioning_operations
           SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
         WHERE order_id = ${delivered.id}`);
      await api.container.refunds.request(tenantA, owner, {
        idempotencyKey: 'http-d7-c3-refund',
        paymentId: walletPayment.id,
        amountMinor: 50_000n,
        reason: 'UNDELIVERABLE',
      });

      const first = compensationListResponseSchema.parse(
        JSON.parse((await get(`${COMPENSATION_ROUTES.list}?limit=1`, viewerCookie)).body),
      );
      expect(first.compensations).toHaveLength(1);
      expect(first.compensations[0]).toMatchObject({
        paymentId: refunded[0],
        customerId: customerA,
        customerTelegramUserId: '900400',
        principalMinor: '250000',
        creditedMinor: '250000',
        currency: 'IRT',
        reason: 'UNDELIVERABLE',
        state: 'COMPLETED',
      });
      expect(first.nextCursor).not.toBeNull();
      const second = compensationListResponseSchema.parse(
        JSON.parse(
          (
            await get(
              `${COMPENSATION_ROUTES.list}?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
              viewerCookie,
            )
          ).body,
        ),
      );
      expect(second.compensations.map((row) => row.paymentId)).toEqual([refunded[1]]);
      expect(second.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Receipts, over HTTP
  // -------------------------------------------------------------------------

  /**
   * The two routes an operator reads a receipt through.
   *
   * What matters at this layer is the RESPONSE: who is refused, and what headers the
   * bytes arrive under. A customer's «receipt» can be any file they chose to upload, so
   * the content route must never let them pick the type the admin origin serves.
   */
  describe('the receipt routes', () => {
    async function filed(key: string): Promise<{ paymentId: string; receiptId: string }> {
      const order = await awaitingPayment(tenantA, customerA, panelA, key);
      const payment = await api.container.payments
        .requestManualTransfer(tenantA, systemActor(key), customerA, {
          idempotencyKey: `${key}-manual`,
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      await api.container.payments.signalTransferSent(tenantA, systemActor(key), customerA, {
        idempotencyKey: `${key}-signal`,
        paymentId: payment.id,
        botInstanceId: SEED_IDS.botA1 as BotInstanceId,
      });
      await api.container.receipts.submit(tenantA, systemActor(key), customerA, {
        idempotencyKey: `${key}-file`,
        botInstanceId: SEED_IDS.botA1 as BotInstanceId,
        file: {
          kind: 'PHOTO',
          fileId: `file-${key}`,
          fileUniqueId: `u-${key}`,
          mimeType: 'image/jpeg',
          fileSize: 1_024n,
          fileName: null,
          telegramMessageId: 7n,
          caption: null,
        },
      });
      const rows = (await api.container.database.db.execute(
        sql`SELECT id FROM payment_receipts WHERE payment_id = ${payment.id}` as never,
      )) as unknown as { rows: { id: string }[] };
      const row = rows.rows[0];
      if (row === undefined) throw new Error('no receipt was filed');
      return { paymentId: payment.id, receiptId: row.id };
    }

    it('lists a payment receipt without ever returning the file id', async () => {
      const { paymentId } = await filed('http-receipt-1');
      const response = await get(PAYMENT_ROUTES.receipts(paymentId), financeCookie);

      expect(response.statusCode).toBe(200);
      const parsed = paymentReceiptListResponseSchema.parse(JSON.parse(response.body));
      expect(parsed.receipts).toHaveLength(1);
      expect(parsed.receipts[0]?.kind).toBe('PHOTO');
      /*
       * The PROHIBITION, and `fileUniqueId` is NOT it: that one is on the contract on
       * purpose, because it is what makes two uploads of the same image the same
       * receipt. What must never appear is `file_id` — the token-scoped handle `getFile`
       * takes, which would hand a browser the means to fetch the file from Telegram
       * directly.
       */
      expect(response.body).not.toContain('file-http-receipt-1');
      expect(response.body).not.toContain('fileId');
    });

    it('refuses the list to an operator holding no receipt permission', async () => {
      const { paymentId } = await filed('http-receipt-2');
      const response = await get(PAYMENT_ROUTES.receipts(paymentId), technicalCookie);

      expect(response.statusCode).toBe(403);
      expect(errorOf(response.body).code).toBe('platform.permission_denied');
    });

    it('refuses a receipt paired with a payment it does not belong to', async () => {
      const first = await filed('http-receipt-3');
      const second = await filed('http-receipt-4');
      const response = await get(
        PAYMENT_ROUTES.receiptContent(second.paymentId, first.receiptId),
        financeCookie,
      );

      // Both ids are real and both are this tenant's. What is refused is the PAIRING,
      // which is the only thing stopping an operator walking receipt ids.
      expect(response.statusCode).toBe(404);
      expect(errorOf(response.body).code).toBe('commerce.receipt_not_found');
    });

    it('serves the bytes as an opaque attachment, never as the declared type', async () => {
      const { paymentId, receiptId } = await filed('http-receipt-5');
      /*
       * The Telegram fetch is stubbed because this case is about the RESPONSE, not the
       * sink: `fetch-file.ts` has its own guard and its own tests, and a real call here
       * would need Telegram. Everything below the stub is the production path.
       */
      const real = api.container.receiptFiles.download.bind(api.container.receiptFiles);
      (api.container.receiptFiles as { download: unknown }).download = () =>
        Promise.resolve({ outcome: 'SUCCEEDED', bytes: new Uint8Array([1, 2, 3, 4]) });
      try {
        const response = await get(
          PAYMENT_ROUTES.receiptContent(paymentId, receiptId),
          financeCookie,
        );

        expect(response.statusCode).toBe(200);
        // `image/jpeg` is what the UPLOADER declared. It must not be what is served.
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-disposition']).toBe(`attachment; filename="${receiptId}"`);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-length']).toBe('4');
      } finally {
        (api.container.receiptFiles as { download: unknown }).download = real;
      }
    });

    it('answers a receipt whose bytes cannot be fetched with an honest refusal', async () => {
      const { paymentId, receiptId } = await filed('http-receipt-6');
      const real = api.container.receiptFiles.download.bind(api.container.receiptFiles);
      (api.container.receiptFiles as { download: unknown }).download = () =>
        Promise.resolve({ outcome: 'UNAVAILABLE', reason: 'gone' });
      try {
        const response = await get(
          PAYMENT_ROUTES.receiptContent(paymentId, receiptId),
          financeCookie,
        );

        // Not a 404 — the row is intact — and not an empty 200, which would show the
        // reviewer a blank frame and let them believe they had looked.
        expect(response.statusCode).toBe(412);
        expect(errorOf(response.body).code).toBe('commerce.receipt_unavailable');
      } finally {
        (api.container.receiptFiles as { download: unknown }).download = real;
      }
    });
  });
});
