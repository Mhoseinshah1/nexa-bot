import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  UNLIMITED_TRAFFIC_BYTES,
  money,
  parseTrafficGb,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * WP21 (brief §4.6): a traffic figure typed in GB reaches the provider as canonical bytes.
 *
 * The HTTP boundary's half — `10.25` becomes 11,005,853,696 bytes in the row — is pinned in
 * `products-http.test.ts`. This is the other half: the row's bytes are exactly what the
 * panel is asked to allow, with no unit conversion anywhere between. The product is written
 * with the bytes `parseTrafficGb` produces, the one conversion the boundary uses.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const PRICE = 250_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('WP21 — a GB figure reaches the panel as bytes', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const seeded = await createAdmin(ctx.container, tenantA, {
      username: 'owner-wp21',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(seeded);
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban WP21',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-wp21-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-wp21',
      telegramUserId: '930931',
      from: { id: 930931, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  /** Buys a product of this many bytes from the wallet and provisions it. */
  async function provisioned(key: string, trafficBytes: bigint) {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: PRICE,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    expect(service?.state).toBe('ACTIVE');
    return service;
  }

  it('asks the panel for exactly the bytes 10.25 GB converts to', async () => {
    const bytes = parseTrafficGb('10.25');
    expect(bytes).toBe(11_005_853_696n);
    const service = await provisioned('quarter', bytes ?? 0n);
    expect(service?.trafficLimitBytes).toBe(11_005_853_696n);
    const [account] = [...panel.users.values()];
    expect(account?.dataLimit).toBe(11_005_853_696);
  });

  it('asks the panel for the nearest byte of 0.01 GB, not a float of it', async () => {
    await provisioned('hundredth', parseTrafficGb('0.01') ?? 0n);
    const [account] = [...panel.users.values()];
    expect(account?.dataLimit).toBe(10_737_418);
  });

  it('asks the panel for no limit when the product is explicitly unlimited', async () => {
    await provisioned('unlimited', UNLIMITED_TRAFFIC_BYTES);
    const [account] = [...panel.users.values()];
    // Marzban's own "no limit" is a zero `data_limit`, which the fake reads back as null.
    expect(account?.dataLimit).toBeNull();
  });
});
