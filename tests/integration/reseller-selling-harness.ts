import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import {
  API_PREFIX,
  EMPTY_PRODUCT_DISPLAY,
  RESELLER_API_PREFIX,
  SESSION_COOKIE_NAME,
  RESELLER_SESSION_COOKIE_NAME,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type FeatureFlagKey,
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
 * PR-5 — the shared fixture of the reseller panel's selling suites: the real app over HTTP,
 * the real database as `nexa_app` (row-level security on), the fake custom bridge as the
 * panel and a socket standing in for Telegram. Two ACTIVE resellers on a 20 %-off tier that
 * grants everything, the panel flag on.
 */

export const ORIGIN = 'https://admin.example.test';
export const BOT_A = SEED_IDS.botA1 as BotInstanceId;

export const systemActor = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

export interface SellingHarness {
  readonly api: ApiApp;
  readonly sent: { url: string; body: string }[];
  readonly owner: ActorContext;
  readonly reseller: UserId;
  readonly other: UserId;
  readonly tierId: string;
  readonly panelId: string;
  readonly bridge: FakeCustomBridge;
  readonly products: DrizzleProductRepository;
  readonly services: DrizzleServiceRepository;
  db(): ApiApp['container']['database']['db'];
  customer(tg: string, name: string): Promise<UserId>;
  product(price?: bigint, title?: string, categoryId?: string): Promise<ProductId>;
  credit(who: UserId, amountMinor: bigint): Promise<void>;
  balance(who: UserId): Promise<bigint>;
  setFlag(key: FeatureFlagKey, enabled: boolean): Promise<void>;
  signedIn(who?: UserId): Promise<string>;
  call(
    cookie: string,
    method: string,
    path: string,
    payload?: unknown,
    key?: string,
  ): Promise<{ statusCode: number; body: string; json: () => unknown }>;
  delivered(who: UserId, productId?: ProductId): Promise<ServiceRecord>;
  /** A Web Admin call as the owner, with a fresh admin session. */
  admin(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: string; json: () => unknown }>;
}

export const codeOf = (response: { json: () => unknown }): string | undefined =>
  (response.json() as { error?: { code?: string } }).error?.code;

/** Registers the suite's hooks; the returned getter is valid inside each test. */
export function useSellingHarness(tag: string): () => SellingHarness {
  const tls = bridgeTls();
  let api: ApiApp;
  let telegram: Server;
  const sent: { url: string; body: string }[] = [];
  let bridge: FakeCustomBridge | undefined;
  let current: SellingHarness | undefined;
  let address = '10.2.2.2';

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
    sent.length = 0;
    address = `10.${String(1 + Math.floor(Math.random() * 200))}.${String(Math.floor(Math.random() * 200))}.7`;
    const db = () => api.container.database.db;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    const products = new DrizzleProductRepository(db());
    const services = new DrizzleServiceRepository(db());
    const ownerAdmin = await createAdmin(api.container, tenantA, {
      username: `${tag}-owner`,
      roleKeys: ['owner'],
    });
    const owner = adminActorFor(ownerAdmin);
    const inject = (options: Record<string, unknown>) =>
      api.app
        .getHttpAdapter()
        .getInstance()
        .inject({ remoteAddress: address, ...options } as never);

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

    async function setFlag(key: FeatureFlagKey, enabled: boolean): Promise<void> {
      const flag = await api.container.featureFlagResolver.resolve(tenantA, key);
      await api.container.featureFlags.set(tenantA, owner, {
        key,
        enabled,
        expectedVersion: flag.version,
        idempotencyKey: randomUUID(),
        reason: 'reseller selling test',
      });
    }

    const reseller = await customer('943001', 'سارا');
    const other = await customer('943002', 'نیما');
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
    await setFlag('reseller_web_panel', true);

    bridge = await startFakeCustomBridge({ host: '127.0.0.2', tls, files: true });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Bridge',
      providerType: 'custom',
      baseUrl: bridge.baseUrl,
      credentials: { apiToken: BRIDGE_SECRET },
      activation: {},
      idempotencyKey: randomUUID(),
    });
    const panelId = created.view.panel.id;
    await db().execute(sql`DELETE FROM panel_probe_claims`);
    const tested = await api.container.panels.testConnection(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
    });
    expect(tested.probed).toBe(true);

    async function product(
      price = 250_000n,
      title = 'پلن ماهانه',
      categoryId: string = SEED_IDS.categoryA,
    ): Promise<ProductId> {
      const made = await products.create(tenantA, {
        id: api.container.ids.uuid() as ProductId,
        draft: {
          title,
          description: null,
          audience: 'EVERYONE',
          sortOrder: 10,
          panelId: panelId as PanelId,
          categoryId: categoryId as ProductCategoryId,
          specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
          price: money(price, 'IRT'),
          display: EMPTY_PRODUCT_DISPLAY,
        },
        now: api.container.clock.now(),
      });
      await products.setStatus(tenantA, made.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
      return made.id;
    }

    async function credit(who: UserId, amountMinor: bigint): Promise<void> {
      await api.container.wallet.adjust(tenantA, owner, who, {
        idempotencyKey: randomUUID(),
        direction: 'CREDIT',
        amountMinor,
        currency: 'IRT',
        note: 'fixture',
      });
    }

    async function balance(who: UserId): Promise<bigint> {
      return (await api.container.wallet.balanceForCustomer(tenantA, systemActor('b'), who))
        .amountMinor;
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

    const call = (
      cookie: string,
      method: string,
      path: string,
      payload?: unknown,
      key?: string,
    ): Promise<{ statusCode: number; body: string; json: () => unknown }> =>
      inject({
        method,
        url: `${RESELLER_API_PREFIX}${path}`,
        headers: {
          origin: ORIGIN,
          cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}`,
          ...(method === 'GET' ? {} : { 'idempotency-key': key ?? randomUUID() }),
        },
        ...(payload === undefined ? {} : { payload }),
      }) as never;

    async function delivered(who: UserId, productId?: ProductId): Promise<ServiceRecord> {
      const tagged = randomUUID();
      const plan = productId ?? (await product());
      const draft = await api.container.orders.createDraft(tenantA, systemActor(tagged), {
        idempotencyKey: `${tagged}-draft`,
        customerId: who,
        productId: plan,
      });
      const confirmed = await api.container.orders.confirm(tenantA, systemActor(tagged), {
        idempotencyKey: `${tagged}-confirm`,
        customerId: who,
        orderId: draft.id,
      });
      await credit(who, confirmed.totals.total.amountMinor);
      await api.container.payments.settleFromWallet(tenantA, systemActor(tagged), who, {
        idempotencyKey: `${tagged}-pay`,
        orderId: confirmed.id as OrderId,
      });
      await api.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, confirmed.id);
      if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
      return service;
    }

    let adminCookie: string | null = null;
    async function admin(
      method: string,
      path: string,
      payload?: unknown,
    ): Promise<{ statusCode: number; body: string; json: () => unknown }> {
      if (adminCookie === null) {
        const login = await inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          headers: { origin: ORIGIN },
          payload: { username: ownerAdmin.username, password: ownerAdmin.password },
        });
        adminCookie = `${SESSION_COOKIE_NAME}=${
          /nexa_admin_session=([^;]+)/u.exec(String(login.headers['set-cookie']))?.[1] as string
        }`;
      }
      return inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: { origin: ORIGIN, cookie: adminCookie },
        ...(payload === undefined ? {} : { payload }),
      }) as never;
    }

    current = {
      admin,
      api,
      sent,
      owner,
      reseller,
      other,
      tierId: tier.id,
      panelId,
      bridge,
      products,
      services,
      db,
      customer,
      product,
      credit,
      balance,
      setFlag,
      signedIn,
      call,
      delivered,
    };
  });

  return () => {
    if (current === undefined) throw new Error('the selling harness is not set up');
    return current;
  };
}
