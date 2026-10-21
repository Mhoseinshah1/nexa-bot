import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  EMPTY_PRODUCT_DISPLAY,
  SERVICE_ADDON_ROUTES,
  SESSION_COOKIE_NAME,
  money,
  serviceAddonListResponseSchema,
  serviceAddonResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  testConfig,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Round 4 B6, end to end: an owner configures a traffic package and a time package the way the
 * Web Admin page «حجم، زمان و کاربر اضافه» does (the SAME write bodies, over HTTP, through the
 * session and CSRF checks), and a customer then buys each from the bot with the `v:` / `h:`
 * callbacks. The panel (a deterministic Marzban on a real socket) receives the change, the
 * wallet is debited by exactly the typed price, and the order and its action row are recorded.
 *
 * Two real processes' worth of container, one database: the API app serves the admin calls and
 * the worker-role container runs the bot and the provisioner, as in production.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('extra traffic and time: configured on the web, bought in the bot', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let cookie: string;
  let updateSeq = 0;
  let keySeq = 0;

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
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const env = {
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    };
    ctx = await createTestContext(env);
    api = await createApiApp(testConfig(env));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];

    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const admin = await createAdmin(ctx.container, tenantA, {
      username: 'owner-packages',
      password: 'the-owner-password',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(admin);
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-packages', password: 'the-owner-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`no session cookie: ${login.body}`);
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;

    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-packages-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-packages',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'نیما' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  const asAdmin = () => ({ cookie, origin: ORIGIN });
  const post = (path: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: asAdmin(), payload });
  const get = (path: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin() });
  const key = () => `packages-${String((keySeq += 1))}-${String(Date.now())}`;

  /** The body the Web Admin page sends for a package (`ExtraPackagesPage` → `createServiceAddon`). */
  const packageBody = (fields: Record<string, unknown>) => ({
    idempotencyKey: key(),
    sortOrder: 0,
    trafficGb: null,
    durationDays: null,
    maxQuantity: null,
    panelId: null,
    productId: null,
    priceCurrency: 'IRT',
    ...fields,
  });

  /**
   * Create over HTTP, exactly as the page's «افزودن» does with its «فعال» switch left ON (the
   * default): the package is offered at once, with no second «فعال کردن» (Round 5C-2 D2).
   */
  async function offerOverHttp(fields: Record<string, unknown>): Promise<string> {
    const created = await post(SERVICE_ADDON_ROUTES.create, packageBody(fields));
    expect(created.statusCode, created.body).toBe(201);
    const addon = serviceAddonResponseSchema.parse(JSON.parse(created.body)).addon;
    expect(addon.status, 'a new package is created ACTIVE by default').toBe('ACTIVE');
    return addon.id;
  }

  async function activeService(): Promise<{ id: string; username: string }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('svc'), {
      idempotencyKey: 'svc-draft',
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('svc'), {
      idempotencyKey: 'svc-confirm',
      customerId: customerA,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'svc-credit',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('svc'), customerA, {
      idempotencyKey: 'svc-pay',
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { id: service.id, username: service.providerUsername };
  }

  const tap = (data: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `pkg-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: 930930, is_bot: false, first_name: 'نیما' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 5150, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'نیما' },
    };
  };
  const lastMessage = () =>
    JSON.stringify(
      sent
        .filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'))
        .at(-1) ?? {},
    );
  const drawnCallbacks = (): string[] =>
    [...lastMessage().matchAll(/callback_data\\?":\\?"([^"\\]+)/gu)].map((match) => match[1] ?? '');

  const balance = async () =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  const actionOrder = async (purpose: string) =>
    (
      await ctx.container.database.db.execute<{
        id: string;
        state: string;
        total_amount: string;
        currency: string;
        action_kind: string;
        addon_id: string;
      }>(sql`
        SELECT o.id, o.state, o.total_amount::text, o.currency, a.kind AS action_kind, a.addon_id
          FROM orders o JOIN service_commercial_actions a ON a.order_id = o.id
         WHERE o.purpose = ${purpose}`)
    ).rows;

  it('lists the configured packages by kind through the keyset list the page reads', async () => {
    const traffic = await offerOverHttp({
      kind: 'ADD_TRAFFIC',
      title: 'ده گیگ',
      trafficGb: '10',
      priceAmount: '90000',
    });
    await offerOverHttp({
      kind: 'ADD_TIME',
      title: 'سی روز',
      durationDays: 30,
      priceAmount: '120000',
    });

    const list = await get(`${SERVICE_ADDON_ROUTES.list}?kind=ADD_TRAFFIC&limit=10`);
    expect(list.statusCode, list.body).toBe(200);
    const parsed = serviceAddonListResponseSchema.parse(JSON.parse(list.body));
    expect(parsed.addons.map((one) => one.id)).toEqual([traffic]);
    expect(parsed.addons[0]).toMatchObject({
      kind: 'ADD_TRAFFIC',
      trafficBytes: String(10n * GIB),
      durationDays: null,
      maxQuantity: null,
      priceAmount: '90000',
      priceCurrency: 'IRT',
    });
  });

  it('D2: active defaults ON, false keeps it INACTIVE, an unpriced one never goes live, an edit ignores it', async () => {
    const statusOf = async (body: Record<string, unknown>) => {
      const created = await post(SERVICE_ADDON_ROUTES.create, packageBody(body));
      expect(created.statusCode, created.body).toBe(201);
      return serviceAddonResponseSchema.parse(JSON.parse(created.body)).addon;
    };
    const base = { kind: 'ADD_TRAFFIC', trafficGb: '5', priceAmount: '45000' };

    expect((await statusOf({ ...base, title: 'پیش‌فرض' })).status).toBe('ACTIVE');
    expect((await statusOf({ ...base, title: 'روشن', active: true })).status).toBe('ACTIVE');
    const off = await statusOf({ ...base, title: 'خاموش', active: false });
    expect(off.status).toBe('INACTIVE');
    // No price means not for sale: the flag cannot publish what activate would refuse.
    const unpriced = await statusOf({
      kind: 'ADD_TRAFFIC',
      trafficGb: '5',
      title: 'بی‌قیمت',
      priceAmount: null,
      priceCurrency: null,
      active: true,
    });
    expect(unpriced.status).toBe('INACTIVE');

    // An edit never changes availability, whatever it carries.
    const edited = await post(SERVICE_ADDON_ROUTES.update(off.id), {
      ...packageBody({ ...base, title: 'خاموش ویرایش', active: true }),
    });
    expect(edited.statusCode, edited.body).toBe(201);
    expect(serviceAddonResponseSchema.parse(JSON.parse(edited.body)).addon.status).toBe('INACTIVE');
  });

  it('D2: one key with the opposite «فعال» is a payload mismatch, never a replay (Codex on #307)', async () => {
    const base = packageBody({
      kind: 'ADD_TRAFFIC',
      trafficGb: '5',
      priceAmount: '45000',
      title: 'کلید',
      active: true,
    });
    const first = await post(SERVICE_ADDON_ROUTES.create, base);
    expect(first.statusCode, first.body).toBe(201);
    const flipped = await post(SERVICE_ADDON_ROUTES.create, { ...base, active: false });
    expect(flipped.statusCode, flipped.body).toBe(409);
    expect(flipped.body).toContain('idempotency_payload_mismatch');
  });

  it('refuses a scope or a maximum on a package: only the user rate has them', async () => {
    const scoped = await post(
      SERVICE_ADDON_ROUTES.create,
      packageBody({
        kind: 'ADD_TRAFFIC',
        title: 'x',
        trafficGb: '1',
        priceAmount: '1000',
        panelId,
      }),
    );
    expect(scoped.statusCode).toBe(400);
    const capped = await post(
      SERVICE_ADDON_ROUTES.create,
      packageBody({
        kind: 'ADD_TIME',
        title: 'x',
        durationDays: 5,
        priceAmount: '1000',
        maxQuantity: 3,
      }),
    );
    expect(capped.statusCode).toBe(400);
  });

  it('sells the web-configured traffic and time packages: panel changed, wallet debited, order recorded', async () => {
    const service = await activeService();
    const trafficAddon = await offerOverHttp({
      kind: 'ADD_TRAFFIC',
      title: 'ده گیگ',
      trafficGb: '10',
      priceAmount: '90000',
    });
    const timeAddon = await offerOverHttp({
      kind: 'ADD_TIME',
      title: 'سی روز',
      durationDays: 30,
      priceAmount: '120000',
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'packages-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });

    const before = await services.findById(tenantA, service.id);
    // Copied: the fake hands out its live record, which the provisioner then mutates.
    const expireBefore = panel.users.get(service.username)?.expire ?? 0;
    expect(panel.users.get(service.username)?.dataLimit).toBe(Number(50n * GIB));
    const walletBefore = await balance();

    // The service card offers the extra-traffic button; the time packages sit behind the
    // renewal button (`n:`), and `h:` opens them directly.
    await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`s:${service.id}`));
    expect(drawnCallbacks()).toEqual(
      expect.arrayContaining([`v:${service.id}`, `n:${service.id}`]),
    );

    // --- extra traffic: v: opens the packages, a: quotes one, q: confirms, the wallet pays.
    await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`v:${service.id}`));
    expect(drawnCallbacks()).toContain(`a:${encodeIdPair(service.id, trafficAddon)}`);
    await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      tap(`a:${encodeIdPair(service.id, trafficAddon)}`),
    );
    const [trafficOrder] = await actionOrder('ADD_TRAFFIC');
    expect(trafficOrder).toMatchObject({
      state: 'DRAFT',
      total_amount: '90000',
      currency: 'IRT',
      action_kind: 'ADD_TRAFFIC',
      addon_id: trafficAddon,
    });
    await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      tap(`q:${trafficOrder!.id}`),
    );
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('pay-t'), customerA, {
      idempotencyKey: 'packages-pay-traffic',
      orderId: trafficOrder!.id as never,
    });
    expect(walletBefore - (await balance())).toBe(90_000n);

    // One action in flight per service: the provisioner applies the first before the second.
    await ctx.container.provisionerLoop.tick();
    expect(panel.users.get(service.username)?.dataLimit).toBe(Number(50n * GIB + 10n * GIB));

    // --- extra time.
    await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`h:${service.id}`));
    expect(drawnCallbacks()).toContain(`b:${encodeIdPair(service.id, timeAddon)}`);
    await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      tap(`b:${encodeIdPair(service.id, timeAddon)}`),
    );
    const [timeOrder] = await actionOrder('ADD_TIME');
    expect(timeOrder).toMatchObject({
      state: 'DRAFT',
      total_amount: '120000',
      action_kind: 'ADD_TIME',
      addon_id: timeAddon,
    });
    await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), tap(`q:${timeOrder!.id}`));
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('pay-h'), customerA, {
      idempotencyKey: 'packages-pay-time',
      orderId: timeOrder!.id as never,
    });
    expect(walletBefore - (await balance())).toBe(90_000n + 120_000n);

    // --- the provisioner applies both to the PANEL.
    await ctx.container.provisionerLoop.tick();
    const ops = await operations.listForService(tenantA, service.id, 50);
    expect(ops.find((one) => one.type === 'ADD_TRAFFIC')?.state).toBe('SUCCEEDED');
    expect(ops.find((one) => one.type === 'ADD_TIME')?.state).toBe('SUCCEEDED');

    const after = panel.users.get(service.username);
    expect(after?.dataLimit, 'the panel allowance grew by the 10 GB package').toBe(
      Number(50n * GIB + 10n * GIB),
    );
    expect(after?.expire, 'the panel window grew by the 30-day package').toBe(
      expireBefore + 30 * 86_400,
    );
    const row = await services.findById(tenantA, service.id);
    expect(row?.trafficLimitBytes).toBe((before?.trafficLimitBytes ?? 0n) + 10n * GIB);
    expect(row?.expiresAt?.getTime()).toBe((before?.expiresAt?.getTime() ?? 0) + 30 * 86_400_000);

    // --- and the orders are recorded as paid, one action row each.
    const paid = await ctx.container.database.db.execute<{ purpose: string; state: string }>(
      sql`SELECT purpose, state FROM orders WHERE purpose IN ('ADD_TRAFFIC', 'ADD_TIME') ORDER BY purpose`,
    );
    expect(paid.rows).toEqual([
      { purpose: 'ADD_TIME', state: 'PAID' },
      { purpose: 'ADD_TRAFFIC', state: 'PAID' },
    ]);
  });
});
