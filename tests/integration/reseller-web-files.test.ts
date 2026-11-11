import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  RESELLER_API_PREFIX,
  RESELLER_SESSION_COOKIE_NAME,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import {
  BRIDGE_SECRET,
  bridgeTls,
  startFakeCustomBridge,
  type FakeCustomBridge,
} from '../support/fake-custom-bridge';
import { readZip } from '../support/zip-reader';
import {
  adminActorFor,
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  testConfig,
} from './harness';

/**
 * PR-4 §5.2 — the reseller panel's services and connection files, against the real app over
 * HTTP, the real `CustomPanelAdapter` and `SubscriptionFileService` against the fake custom
 * bridge (protocol v1.1 files), and a socket standing in for Telegram.
 *
 * Proves: files offered / not offered; a files-only panel hides the link and the QR; another
 * reseller's service id is not found on every route; the download headers (attachment,
 * no-store, nosniff, type by extension); the ZIP; the ten-per-ten-minutes bound; nothing of a
 * file is written to the database (every table is searched for its bytes and name); the
 * Telegram send is the bot's own send; the list's chips, counts and search; the dashboard; the
 * renewal quote refused on a short wallet (no credit); the price list.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const RESELLER_TG = '942001';
const OTHER_TG = '942002';

const systemActor = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

describe('the reseller web panel — services and connection files (PR-4)', () => {
  const tls = bridgeTls();
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: string }[];
  let bridge: FakeCustomBridge | undefined;
  let owner: ActorContext;
  let reseller: UserId;
  let other: UserId;
  let panelId: string;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let address = '10.1.1.1';

  const db = () => api.container.database.db;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ remoteAddress: address, ...options } as never);

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        sent.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const bound = telegram.address();
    if (bound === null || typeof bound === 'string') throw new Error('no address');
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      PANEL_HTTP_CA_FILE: tls.caFile,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(bound.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  beforeEach(async () => {
    sent = [];
    address = `10.${String(1 + Math.floor(Math.random() * 200))}.${String(Math.floor(Math.random() * 200))}.9`;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(db());
    services = new DrizzleServiceRepository(db());
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'rwf-owner', roleKeys: ['owner'] }),
    );
    reseller = await customer(RESELLER_TG, 'سارا');
    other = await customer(OTHER_TG, 'نیما');
    const tier = await api.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: randomUUID(),
      write: {
        name: 'نقره‌ای',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 20,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await api.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: randomUUID(),
      tierId: tier.id,
      grants: [
        { kind: 'OPERATION', subject: null },
        { kind: 'PRODUCT', subject: null },
        { kind: 'PANEL', subject: null },
        { kind: 'BOT', subject: null },
      ],
    });
    for (const id of [reseller, other]) {
      await api.container.resellersAdmin.register(tenantA, owner, {
        idempotencyKey: randomUUID(),
        customerId: id,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
    }
    const flag = await api.container.featureFlagResolver.resolve(tenantA, 'reseller_web_panel');
    await api.container.featureFlags.set(tenantA, owner, {
      key: 'reseller_web_panel',
      enabled: true,
      expectedVersion: flag.version,
      idempotencyKey: randomUUID(),
      reason: 'reseller panel test',
    });
  });

  async function customer(tg: string, name: string): Promise<UserId> {
    const resolved = await api.container.customers.resolveFromUpdate(tenantA, systemActor(tg), {
      intake: 'INTERNAL',
      idempotencyKey: `resolve-${tg}`,
      telegramUserId: tg,
      from: { id: Number(tg), first_name: name },
      botInstanceId: BOT_A,
    });
    return resolved.customer.id;
  }

  async function bridgePanel(files: boolean): Promise<void> {
    bridge = await startFakeCustomBridge({ host: '127.0.0.2', tls, files });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Bridge',
      providerType: 'custom',
      baseUrl: bridge.baseUrl,
      credentials: { apiToken: BRIDGE_SECRET },
      activation: {},
      idempotencyKey: randomUUID(),
    });
    panelId = created.view.panel.id;
    await db().execute(sql`DELETE FROM panel_probe_claims`);
    const tested = await api.container.panels.testConnection(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
    });
    expect(tested.probed).toBe(true);
  }

  async function product(price = 250_000n): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return created.id;
  }

  async function delivered(who: UserId, productId?: ProductId): Promise<ServiceRecord> {
    const tag = randomUUID();
    const plan = productId ?? (await product());
    const draft = await api.container.orders.createDraft(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-draft`,
      customerId: who,
      productId: plan,
    });
    const confirmed = await api.container.orders.confirm(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-confirm`,
      customerId: who,
      orderId: draft.id,
    });
    await api.container.wallet.adjust(tenantA, owner, who, {
      idempotencyKey: `${tag}-credit`,
      direction: 'CREDIT',
      amountMinor: confirmed.totals.total.amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });
    await api.container.payments.settleFromWallet(tenantA, systemActor(tag), who, {
      idempotencyKey: `${tag}-pay`,
      orderId: confirmed.id as OrderId,
    });
    await api.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    return service;
  }

  async function signedIn(who: UserId = reseller): Promise<string> {
    const issued = await api.container.resellerWeb.access.issueLink(tenantA, systemActor('l'), {
      customerId: who,
      botInstanceId: BOT_A,
    });
    if (issued.kind !== 'ISSUED') throw new Error(issued.kind);
    const token = /#token=(.+)$/u.exec(issued.url)?.[1] as string;
    const response = await inject({
      method: 'POST',
      url: `${RESELLER_API_PREFIX}/auth/exchange`,
      headers: { origin: ORIGIN, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0' },
      payload: { token },
    });
    expect(response.statusCode, response.body).toBe(200);
    return new RegExp(`${RESELLER_SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie']),
    )?.[1] as string;
  }

  const call = (cookie: string, method: string, path: string, payload?: unknown) =>
    inject({
      method,
      url: `${RESELLER_API_PREFIX}${path}`,
      headers: {
        origin: ORIGIN,
        cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const codeOf = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code?: string } }).error?.code;

  /** Every text column of every table, searched for `needle`: nothing of a file is stored. */
  async function storedAnywhere(needle: string): Promise<string[]> {
    const tables = await db().execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const hits: string[] = [];
    for (const { table_name } of tables.rows) {
      const found = await db().execute(
        sql.raw(
          `SELECT 1 FROM "${table_name}" t WHERE t::text LIKE '%' || ${`'${needle.replace(/'/gu, "''")}'`} || '%' LIMIT 1`,
        ),
      );
      if (found.rows.length > 0) hits.push(table_name);
    }
    return hits;
  }

  // =========================================================================

  it('offers the files, lists them, downloads one and the ZIP with no-store headers, and stores nothing', async () => {
    await bridgePanel(true);
    const service = await delivered(reseller);
    const own = (bridge as FakeCustomBridge).defaultFile(service.providerUsername);
    const cookie = await signedIn();

    const detail = (await call(cookie, 'GET', `/services/${service.id}`)).json() as {
      filesOffered: boolean;
      filesOnly: boolean;
      subscriptionUrl: string | null;
      qrKinds: string[];
    };
    expect(detail.filesOffered).toBe(true);
    expect(detail.filesOnly).toBe(false);
    expect(detail.subscriptionUrl).toBe(service.subscriptionUrl);
    expect(detail.qrKinds).toEqual(['SUB_LINK']);

    const listed = await call(cookie, 'GET', `/services/${service.id}/files`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      files: [{ index: 0, fileName: own.name, sizeBytes: own.bytes.length }],
    });
    expect(listed.headers['cache-control']).toBe('no-store, private');

    const one = await call(cookie, 'GET', `/services/${service.id}/files/0`);
    expect(one.statusCode).toBe(200);
    expect(one.rawPayload.equals(own.bytes)).toBe(true);
    expect(one.headers['content-disposition']).toBe(
      `attachment; filename="${own.name}"; filename*=UTF-8''${encodeURIComponent(own.name)}`,
    );
    expect(one.headers['cache-control']).toBe('no-store, private');
    expect(one.headers['x-content-type-options']).toBe('nosniff');
    expect(one.headers['content-type']).toMatch(/^application\/json/u);
    expect((await call(cookie, 'GET', `/services/${service.id}/files/1`)).statusCode).toBe(404);

    const zip = await call(cookie, 'GET', `/services/${service.id}/files-zip`);
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['cache-control']).toBe('no-store, private');
    expect(zip.headers['x-content-type-options']).toBe('nosniff');
    expect(String(zip.headers['content-disposition'])).toMatch(/^attachment; filename=".+\.zip"/u);
    const entries = readZip(zip.rawPayload);
    expect([...entries.keys()]).toEqual([own.name]);
    expect(entries.get(own.name)?.equals(own.bytes)).toBe(true);

    // Nothing of a file was written anywhere: neither its bytes nor its name.
    expect(await storedAnywhere(own.bytes.toString('utf8').slice(0, 40))).toEqual([]);
    expect(await storedAnywhere(own.name)).toEqual([]);
    // Each fetch is audited — how many files, never a name.
    const audited = await db().execute<{ after: { files: number; purpose: string } }>(
      sql`SELECT after FROM audit_logs WHERE action = 'reseller_web.files_fetched' ORDER BY occurred_at`,
    );
    expect(audited.rows.map((row) => row.after.purpose)).toEqual([
      'LIST',
      'DOWNLOAD',
      'DOWNLOAD',
      'ZIP',
    ]);
  });

  it('bounds fetches at ten per service per ten minutes per reseller', async () => {
    await bridgePanel(true);
    const service = await delivered(reseller);
    const cookie = await signedIn();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await call(cookie, 'GET', `/services/${service.id}/files`)).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(
      (bridge as FakeCustomBridge).requests.filter((one) => one.route === 'files'),
      'the eleventh never reached the panel',
    ).toHaveLength(10 + 1 /* the delivery's own send */);
  });

  it('a panel without files offers none and refuses a fetch with the Persian reason code', async () => {
    await bridgePanel(false);
    const service = await delivered(reseller);
    const cookie = await signedIn();
    const detail = (await call(cookie, 'GET', `/services/${service.id}`)).json() as {
      filesOffered: boolean;
    };
    expect(detail.filesOffered).toBe(false);
    const refused = await call(cookie, 'GET', `/services/${service.id}/files`);
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('reseller_web.files_unavailable');
  });

  it('files only: no link and no QR', async () => {
    await bridgePanel(true);
    await api.container.panels.update(tenantA, owner, panelId, {
      filesOnlyDelivery: true,
      idempotencyKey: randomUUID(),
    });
    const service = await delivered(reseller);
    const cookie = await signedIn();
    const detail = (await call(cookie, 'GET', `/services/${service.id}`)).json() as {
      filesOnly: boolean;
      subscriptionUrl: string | null;
      qrKinds: string[];
      filesOffered: boolean;
    };
    expect(detail).toMatchObject({
      filesOnly: true,
      subscriptionUrl: null,
      qrKinds: [],
      filesOffered: true,
    });
    expect((await call(cookie, 'GET', `/services/${service.id}/qr/SUB_LINK`)).statusCode).toBe(404);
  });

  it('another reseller’s service is not found on every route', async () => {
    await bridgePanel(true);
    const theirs = await delivered(other);
    const cookie = await signedIn();
    const routes: [string, string, unknown?][] = [
      ['GET', `/services/${theirs.id}`],
      ['PUT', `/services/${theirs.id}/note`, { note: 'x' }],
      ['GET', `/services/${theirs.id}/qr/SUB_LINK`],
      ['POST', `/services/${theirs.id}/send-connection`],
      ['POST', `/services/${theirs.id}/rotate-link`],
      ['GET', `/services/${theirs.id}/files`],
      ['GET', `/services/${theirs.id}/files/0`],
      ['GET', `/services/${theirs.id}/files-zip`],
      ['POST', `/services/${theirs.id}/files/send`],
      ['GET', `/services/${theirs.id}/offer/RENEW`],
      ['POST', `/services/${theirs.id}/quote`, { kind: 'RENEW', addonId: null, planId: null }],
    ];
    for (const [method, path, payload] of routes) {
      const response = await call(cookie, method, path, payload);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(codeOf(response), `${method} ${path}`).toBe('reseller_web.not_found');
    }
    expect(
      (bridge as FakeCustomBridge).requests.filter((one) => one.route === 'files'),
      'the panel was never asked for their files by this reseller',
    ).toHaveLength(1);
    const list = (await call(cookie, 'GET', '/services')).json() as { total: number };
    expect(list.total).toBe(0);
    const note = await db().execute<{ customer_note: string | null }>(
      sql`SELECT customer_note FROM services WHERE id = ${theirs.id}`,
    );
    expect(note.rows[0]?.customer_note).toBeNull();
  });

  it('«ارسال فایل‌ها به تلگرام من» is the bot’s own send, to the reseller’s own chat', async () => {
    await bridgePanel(true);
    const service = await delivered(reseller);
    const cookie = await signedIn();
    const documents = () =>
      sent.filter(
        (one) => one.url.endsWith('/sendDocument') || one.url.endsWith('/sendMediaGroup'),
      );

    sent = [];
    await api.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `rwf-update-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: 77,
        callback_query: {
          id: 'cbq-77',
          from: { id: Number(RESELLER_TG), is_bot: false, first_name: 'سارا' },
          data: `sf:${service.id}`,
          message: {
            message_id: 3,
            date: 0,
            chat: { id: Number(RESELLER_TG), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: RESELLER_TG,
      from: { id: Number(RESELLER_TG), first_name: 'سارا' },
    });
    const fromBot = documents().map((one) => one.body.replace(/--[-\w]+/gu, '<boundary>'));
    expect(fromBot.length).toBeGreaterThan(0);

    sent = [];
    const panel = await call(cookie, 'POST', `/services/${service.id}/files/send`);
    expect(panel.statusCode, panel.body).toBe(200);
    const fromPanel = documents().map((one) => one.body.replace(/--[-\w]+/gu, '<boundary>'));
    expect(fromPanel).toEqual(fromBot);
    expect(fromPanel.join('')).toContain(RESELLER_TG);
  });

  it('lists the reseller’s services with chip counts and search, and edits the note', async () => {
    await bridgePanel(true);
    const a = await delivered(reseller);
    const b = await delivered(reseller);
    await db().execute(
      sql`UPDATE services SET expires_at = now() + interval '2 days' WHERE id = ${b.id}`,
    );
    const cookie = await signedIn();
    const all = (await call(cookie, 'GET', '/services')).json() as {
      counts: Record<string, number>;
      items: { id: string; expiring: boolean }[];
    };
    expect(all.counts).toMatchObject({ ALL: 2, ACTIVE: 2, EXPIRING: 1, EXPIRED: 0 });
    const expiring = (await call(cookie, 'GET', '/services?filter=EXPIRING')).json() as {
      items: { id: string }[];
    };
    expect(expiring.items.map((item) => item.id)).toEqual([b.id]);
    const noted = await call(cookie, 'PUT', `/services/${a.id}/note`, { note: 'مشتری علی' });
    expect(noted.statusCode, noted.body).toBe(200);
    const searched = (
      await call(cookie, 'GET', `/services?q=${encodeURIComponent('علی')}`)
    ).json() as {
      items: { id: string; note: string | null }[];
    };
    expect(searched.items).toEqual([expect.objectContaining({ id: a.id, note: 'مشتری علی' })]);
    const dashboard = (await call(cookie, 'GET', '/dashboard')).json() as {
      activeServices: number;
      expiringCount: number;
      monthSales: { count: number };
      tier: { name: string };
    };
    expect(dashboard).toMatchObject({ activeServices: 2, expiringCount: 1 });
    expect(dashboard.monthSales.count).toBe(2);
    expect(dashboard.tier.name).toBe('نقره‌ای');
  });

  it('a renewal is quoted by the bot’s pricing and refused on a short wallet — there is no credit', async () => {
    await bridgePanel(true);
    const service = await delivered(reseller);
    const cookie = await signedIn();
    const quote = await call(cookie, 'POST', `/services/${service.id}/quote`, {
      kind: 'RENEW',
      addonId: null,
      planId: null,
    });
    expect(quote.statusCode, quote.body).toBe(200);
    const order = quote.json() as { id: string; total: { amountMinor: string } };
    // The reseller's price: 20 % off the list price.
    expect(order.total.amountMinor).toBe('200000');
    const balanceBefore = await api.container.wallet.balanceForCustomer(
      tenantA,
      systemActor('b'),
      reseller,
    );
    const paid = await call(cookie, 'POST', `/orders/${order.id}/pay-wallet`);
    expect(paid.statusCode).toBe(409);
    expect(codeOf(paid)).toBe('commerce.wallet_insufficient_funds');
    const balanceAfter = await api.container.wallet.balanceForCustomer(
      tenantA,
      systemActor('b'),
      reseller,
    );
    expect(balanceAfter.amountMinor).toBe(balanceBefore.amountMinor);
    // Another reseller cannot pay (or see) this order.
    const others = await signedIn(other);
    expect((await call(others, 'POST', `/orders/${order.id}/pay-wallet`)).statusCode).toBe(404);
  });

  it('the price list shows list price, the reseller’s price and the discount, by category', async () => {
    await bridgePanel(true);
    await product(500_000n);
    const cookie = await signedIn();
    const prices = (await call(cookie, 'GET', '/prices')).json() as {
      groups: {
        items: {
          listPrice: { amountMinor: string };
          yourPrice: { amountMinor: string };
          discountPercent: number;
        }[];
      }[];
    };
    expect(prices.groups).toHaveLength(1);
    expect(prices.groups[0]?.items[0]).toMatchObject({
      listPrice: { amountMinor: '500000' },
      yourPrice: { amountMinor: '400000' },
      discountPercent: 20,
    });
  });
});
