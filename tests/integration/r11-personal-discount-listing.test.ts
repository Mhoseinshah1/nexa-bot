import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  fromWire,
  miniAppCategoryResponseSchema,
  miniAppPath,
  miniAppServiceOfferSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type MiniAppListedPersonalDiscount,
  type Money,
  type MoneyWire,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { formatMoney, formatMoneyIsolated } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  adminActorFor,
  createAdmin,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * R11 A9 — every customer-facing price LIST shows the price the checkout will charge when the
 * customer's personal discount (R10 D3) wins it: the bot's plan list, renewal menu and package
 * list, and the mini app's store and service offers.
 *
 * Real PostgreSQL, the real API app, the real bot runtime (driven through `BotRuntime.handle`
 * as the webhook drives it, against a socket standing in for Telegram) and the mini app over
 * real HTTP. Every case compares what each list SHOWS with what the INVOICE — the draft the
 * same line opens, priced by `PricingService.price` — charges:
 *
 * (a) a discounted customer          — the list shows the discounted price (a bot button: that
 *                                       one price, isolated, and «(N٪ تخفیف)», R11 hotfix);
 * (b) a customer with no percent      — the list is what it always was;
 * (c) a reseller whose tier wins      — the tier price, untagged (the larger single wins);
 * (d) a reseller whose percent wins   — the personal price, never stacked on the tier price;
 * (e) the flag off                    — the list is what it always was;
 * (f) an automatic rule that wins     — the list is what it always was (never the personal);
 * (g) an automatic rule that loses    — the personal price, equal to the invoice.
 *
 * Packages (extra traffic) are not under the personal discount (`PERSONAL_DISCOUNT_PURPOSES`,
 * OQ-R10-D3-02), so their lists and invoices stay at the package price in every case — the
 * list follows the invoice, never the other way round.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const USER = 962_101;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };
const LIST = 100_000n;
const PACKAGE = 50_000n;
/** R11 hotfix: what follows the one price on a discounted bot button. */
const SUFFIX = (percent: number) => `(${String(percent)}٪ تخفیف)`;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Telegram's own signer for a mini-app launch, independently of the verifier. */
function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** What one line of every list shows, and what its invoice charges. */
interface Line {
  /** The bot button's text. */
  readonly bot: string;
  /** The mini app's figures: the line's price and its personal discount, if any. */
  readonly mini: {
    readonly price: Money;
    readonly personal: { percent: number; price: Money } | null;
  };
  /** The total of the draft this line opens. */
  readonly invoice: Money;
}

describe('R11 A9: price lists show the personal discount the invoice charges', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  let owner: ActorContext;
  let customer: UserId;
  let productA: ProductId;
  let serviceId: string;
  let addonId: string;
  let token: string;
  let n = 0;
  let updateSeq = 0;
  const key = (): string => `r11-a9-${String((n += 1))}-${String(Date.now())}`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    const container = api.container;
    await resetDatabase(container.database.db);
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    owner = adminActorFor(
      await createAdmin(container, tenantA, {
        username: 'owner-r11-a9',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );
    await setFlag('mini_app', true);

    // The catalogue's plan, on a sellable panel.
    const panelA = container.ids.uuid();
    await container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(container, tenantA, panelA);
    productA = await product('پلن فهرست', panelA);

    // A service to renew and to add traffic to, on a panel that performs both.
    const renewable = await container.panels.create(tenantA, owner, {
      name: 'Panel Renew',
      providerType: 'marzban',
      baseUrl: 'https://renew.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    const panelRenew = renewable.view.panel.id;
    const renewProduct = await product('پلن تمدید', panelRenew);
    customer = await resolve();
    const bought = await container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customer,
      productId: renewProduct,
    });
    serviceId = container.ids.uuid();
    await container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at, expires_at)
      VALUES (${serviceId}, ${tenantA.tenantId}, ${customer}, ${bought.id}, ${panelRenew},
              ${renewProduct}, 'r11_a9_listing', ${'b'.repeat(32)}, ${container.ids.uuid()},
              53687091200, 'ACTIVE', now(), now() + interval '30 days')`);
    addonId = await trafficPackage();
    token = await miniSession();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function setFlag(flag: 'mini_app' | 'personal_discount', enabled: boolean) {
    const current = await api.container.featureFlagResolver.resolve(tenantA, flag);
    await api.container.featureFlags.set(tenantA, owner, {
      key: flag,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'R11 A9 listing test',
    });
  }

  const setPercent = (percent: number) =>
    api.container.customerControls.setPersonalDiscount(tenantA, owner, {
      idempotencyKey: key(),
      customerId: customer,
      percent,
      reason: 'مشتری وفادار',
    });

  async function product(title: string, panelId: string): Promise<ProductId> {
    const products = new DrizzleProductRepository(api.container.database.db);
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(LIST, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return created.id;
  }

  async function trafficPackage(): Promise<string> {
    const created = await api.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: key(),
      draft: {
        kind: 'ADD_TRAFFIC',
        title: 'ده گیگ',
        sortOrder: 10,
        specification: { kind: 'ADD_TRAFFIC', trafficBytes: 10_737_418_240n, durationDays: null },
        price: money(PACKAGE, 'IRT'),
        panelId: null,
        productId: null,
      } as never,
    });
    await api.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: key(),
      addonId: created.id,
    });
    return created.id;
  }

  async function resolve(): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${String(USER)}`),
      {
        idempotencyKey: `resolve-${String(USER)}`,
        telegramUserId: String(USER),
        from: { id: USER, first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  async function miniSession(): Promise<string> {
    const minted = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A })}`,
      payload: { initData: initDataFor({ id: USER, first_name: 'سارا' }) },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    return (JSON.parse(minted.body) as { token: string }).token;
  }

  async function miniGet<T>(
    path: string,
    params: Record<string, string>,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const response = await inject({
      method: 'GET',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(path, params)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return schema.parse(JSON.parse(response.body));
  }

  /** One bot tap; the buttons of the message Telegram was last asked to draw. */
  async function tap(data: string): Promise<{ text: string; callback_data?: string }[]> {
    sent.length = 0;
    updateSeq += 1;
    await api.container.botRuntime.handle(tenantA, customerActor('r11-a9-bot'), {
      idempotencyKey: `r11-a9-update-${String(updateSeq)}-${String(Date.now())}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: USER, is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: USER, type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: String(USER),
      from: { id: USER, first_name: 'سارا' },
    });
    const drawn = sent.filter(
      (one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'),
    );
    const markup = drawn[drawn.length - 1]?.body['reply_markup'] as
      { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat();
  }

  async function botButton(data: string, prefix: string): Promise<string> {
    const found = (await tap(data)).find((button) => button.callback_data?.startsWith(prefix));
    if (found === undefined) throw new Error(`no ${prefix} button after ${data}`);
    return found.text;
  }

  const fromOffer = (option: {
    readonly price: MoneyWire;
    readonly personalDiscount: MiniAppListedPersonalDiscount | null;
  }): Line['mini'] => ({
    price: fromWire(option.price),
    personal:
      option.personalDiscount === null
        ? null
        : {
            percent: option.personalDiscount.percent,
            price: fromWire(option.personalDiscount.price),
          },
  });

  /** The plan list: the bot's category page, the mini app's category, and the draft. */
  async function plan(): Promise<Line> {
    const bot = await botButton(`ck:${SEED_IDS.categoryA}.0`, `p:${productA}`);
    const page = await miniGet(
      MINIAPP_ROUTES.category,
      { categoryId: SEED_IDS.categoryA },
      miniAppCategoryResponseSchema,
    );
    const item = page.items.find((one) => one.id === productA);
    if (item === undefined) throw new Error('the plan is not in the mini app store');
    const draft = await api.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customer,
      productId: productA,
    });
    return { bot, mini: fromOffer(item), invoice: draft.totals.total };
  }

  /** The renewal menu, the mini app's renewal offer, and the renewal's draft. */
  async function renewal(): Promise<Line> {
    const bot = await botButton(`n:${serviceId}`, `nr:${serviceId}`);
    const offer = await miniGet(
      MINIAPP_ROUTES.serviceOffer,
      { serviceId, kind: 'RENEW' },
      miniAppServiceOfferSchema,
    );
    const [option] = offer.options;
    if (option === undefined) throw new Error('no renewal offered');
    const { order } = await api.container.commercialActions.draft(
      viaBot,
      customerActor(key()),
      customer,
      { serviceId, kind: 'RENEW', idempotencyKey: key() },
    );
    return { bot, mini: fromOffer(option), invoice: order.totals.total };
  }

  /** The extra-traffic package list, the mini app's, and the package's draft. */
  async function traffic(): Promise<Line> {
    const bot = await botButton(`v:${serviceId}`, 'a:');
    const offer = await miniGet(
      MINIAPP_ROUTES.serviceOffer,
      { serviceId, kind: 'ADD_TRAFFIC' },
      miniAppServiceOfferSchema,
    );
    const option = offer.options.find((one) => one.addonId === addonId);
    if (option === undefined) throw new Error('no traffic package offered');
    const { order } = await api.container.commercialActions.draft(
      viaBot,
      customerActor(key()),
      customer,
      { serviceId, kind: 'ADD_TRAFFIC', addonId, idempotencyKey: key() },
    );
    return { bot, mini: fromOffer(option), invoice: order.totals.total };
  }

  /**
   * The rule every case asserts: the list shows the invoice's figure. Discounted — the bot's
   * button carries the invoice total as its ONE price (isolated left-to-right, no U+0336, never
   * the shown price) and «(N٪ تخفیف)», and the mini app's line carries the invoice total as its
   * personal price. Not — the line is drawn as it always was, at `shown`.
   */
  function expectListed(
    line: Line,
    title: string,
    shown: bigint,
    personal: { percent: number; price: bigint } | null,
    /**
     * Only for a line the personal discount does not win and whose list never showed what the
     * invoice charges: a reseller's package (the list has never applied the reseller layer to
     * a package, OQ-R11-A9-05). Pinned, so a change to it is a decision, not an accident.
     */
    unlistedInvoice?: bigint,
  ) {
    const was = money(shown, 'IRT');
    if (personal === null) {
      expect(line.bot).toBe(title.replace('{price}', formatMoney(was)));
      expect(line.mini).toEqual({ price: was, personal: null });
      expect(line.invoice).toEqual(money(unlistedInvoice ?? shown, 'IRT'));
      return;
    }
    const now = money(personal.price, 'IRT');
    expect(line.bot).toBe(
      `${title.replace('{price}', formatMoneyIsolated(now))} ${SUFFIX(personal.percent)}`,
    );
    expect(line.bot).not.toContain('\u0336');
    expect(line.bot).not.toContain(formatMoney(was).split(' ')[0] as string);
    // The amount on the button, once, is the amount the invoice charges.
    const figure = formatMoney(line.invoice).split(' ')[0] as string;
    expect(line.bot.split(figure).length - 1).toBe(1);
    expect(line.bot).toContain(`\u2066${figure}\u2069`);
    expect(line.mini).toEqual({ price: was, personal: { percent: personal.percent, price: now } });
    // The hard rule: the listed figure IS the invoice's.
    expect(line.invoice).toEqual(now);
  }

  const PLAN = 'پلن فهرست — {price}';
  const RENEW = '🔄 تمدید پلن تمدید — {price}';
  const PACKAGE_LINE = 'ده گیگ — {price}';

  async function reseller(tierPercent: number): Promise<void> {
    const tier = await api.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name: 'Silver',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: tierPercent,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await api.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key(),
      tierId: tier.id,
      grants: [
        { kind: 'OPERATION', subject: null },
        { kind: 'PRODUCT', subject: null },
        { kind: 'PANEL', subject: null },
        { kind: 'BOT', subject: null },
      ],
    });
    await api.container.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key(),
      customerId: customer,
      write: { tierId: tier.id, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
    });
  }

  async function automaticRule(percent: bigint): Promise<void> {
    const created = await api.container.discounts.create(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        kind: 'AUTOMATIC',
        code: null,
        label: 'حراج',
        type: 'PERCENTAGE',
        value: percent,
        currency: null,
        appliesTo: ['NEW_SERVICE', 'RENEW'],
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
      },
    });
    await api.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: created.rule.id,
    });
  }

  // -------------------------------------------------------------------------
  // The cases
  // -------------------------------------------------------------------------

  it('(a) a discounted customer: every list shows the invoice price, tagged', async () => {
    await setFlag('personal_discount', true);
    await setPercent(20);
    expectListed(await plan(), PLAN, LIST, { percent: 20, price: 80_000n });
    expectListed(await renewal(), RENEW, LIST, { percent: 20, price: 80_000n });
    // A package is not under the personal discount: listed and charged at its own price.
    expectListed(await traffic(), PACKAGE_LINE, PACKAGE, null);
  });

  it('(b) a customer with no personal discount: the lists are what they always were', async () => {
    await setFlag('personal_discount', true);
    expectListed(await plan(), PLAN, LIST, null);
    expectListed(await renewal(), RENEW, LIST, null);
    expectListed(await traffic(), PACKAGE_LINE, PACKAGE, null);
  });

  it('(c) a reseller whose tier price is better: the tier price, untagged', async () => {
    await setFlag('personal_discount', true);
    await reseller(20);
    // 20 % tier: 80 000; a 10 % personal discount (90 000) loses to it.
    await setPercent(10);
    expectListed(await plan(), PLAN, 80_000n, null);
    expectListed(await renewal(), RENEW, 80_000n, null);
    expectListed(await traffic(), PACKAGE_LINE, PACKAGE, null, 40_000n);
  });

  it('(d) a reseller whose personal discount is better: the personal price, never stacked', async () => {
    await setFlag('personal_discount', true);
    await reseller(20);
    // 35 % off the LIST price (65 000) beats the 80 000 tier price; never 35 % off 80 000.
    await setPercent(35);
    expectListed(await plan(), PLAN, 80_000n, { percent: 35, price: 65_000n });
    expectListed(await renewal(), RENEW, 80_000n, { percent: 35, price: 65_000n });
    expectListed(await traffic(), PACKAGE_LINE, PACKAGE, null, 40_000n);
  });

  it('(e) the flag off: a stored percent changes no list', async () => {
    await setPercent(20);
    expectListed(await plan(), PLAN, LIST, null);
    expectListed(await renewal(), RENEW, LIST, null);
    expectListed(await traffic(), PACKAGE_LINE, PACKAGE, null);
  });

  it('(f) an automatic rule that is larger: the list is not tagged with the personal discount', async () => {
    await setFlag('personal_discount', true);
    await setPercent(30);
    await automaticRule(40n);
    // The invoice takes the 40 % rule (60 000), never the 30 % personal price (70 000); the
    // list shows what it always did — a plan list has never shown an automatic rule.
    const line = await plan();
    expect(line.bot).toBe(PLAN.replace('{price}', formatMoney(money(LIST, 'IRT'))));
    expect(line.mini).toEqual({ price: money(LIST, 'IRT'), personal: null });
    expect(line.invoice).toEqual(money(60_000n, 'IRT'));
  });

  it('(g) an automatic rule that is smaller: the personal price, equal to the invoice', async () => {
    await setFlag('personal_discount', true);
    await setPercent(30);
    await automaticRule(10n);
    expectListed(await plan(), PLAN, LIST, { percent: 30, price: 70_000n });
    expectListed(await renewal(), RENEW, LIST, { percent: 30, price: 70_000n });
  });

  it('listing writes nothing: no order, no quote, no row', async () => {
    await setFlag('personal_discount', true);
    await setPercent(20);
    const count = async () =>
      Number(
        (
          (await api.container.database.db.execute(
            sql`SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantA.tenantId}`,
          )) as unknown as { rows: { n: number }[] }
        ).rows[0]?.n ?? 0,
      );
    const before = await count();
    await tap(`ck:${SEED_IDS.categoryA}.0`);
    await tap(`n:${serviceId}`);
    await tap(`v:${serviceId}`);
    await miniGet(
      MINIAPP_ROUTES.category,
      { categoryId: SEED_IDS.categoryA },
      miniAppCategoryResponseSchema,
    );
    await miniGet(
      MINIAPP_ROUTES.serviceOffer,
      { serviceId, kind: 'RENEW' },
      miniAppServiceOfferSchema,
    );
    expect(await count()).toBe(before);
  });
});
