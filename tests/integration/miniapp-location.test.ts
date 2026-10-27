import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppPath,
  miniAppServiceDetailSchema,
  miniAppServiceLocationResultSchema,
  miniAppServiceLocationsSchema,
  miniAppServicesResponseSchema,
  money,
  providerDescriptor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ProviderCapability,
  type ProviderLocationOutcome,
  type ProviderUserRef,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceLocationInput } from '../../apps/api/src/modules/commerce/locations/application/service-location-admin.service';
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
 * Round 9, C5 (part 2b): the mini app's location change over real HTTP.
 *
 * The endpoints add no business logic: they call `CommercialActionService.offer /
 * locationTarget / draft` and `LocationChangeService.requestFree`, the services the bot's
 * location flow calls. What only this layer can show: another customer's service is "not
 * found" and nothing is moved, drafted or recorded for it; the cooldown and the rolling
 * limit the services enforce reach the page as their own codes; and what a move records
 * says it came from the mini app.
 *
 * As `location-change.test.ts`, no shipped provider declares `LOCATION_CHANGE`, so the
 * Marzban descriptor is given the capability for this file (a stand-in for the PROVIDER;
 * every row, lock and decision asserted is production code).
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const originalCapabilities: ProviderCapability[] = [];

function installLocationCapability(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) throw new Error('no marzban descriptor');
  const capabilities = descriptor.capabilities as ProviderCapability[];
  originalCapabilities.splice(0, originalCapabilities.length, ...capabilities);
  capabilities.push('LOCATION_CHANGE');
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  proto['readLocation'] = async (
    _target: unknown,
    _http: unknown,
    _ref: ProviderUserRef,
  ): Promise<ProviderLocationOutcome> => ({
    ok: true,
    found: true,
    locationKey: 'de',
    subscriptionUrl: null,
  });
  proto['applyLocation'] = async (
    _target: unknown,
    _http: unknown,
    _ref: ProviderUserRef,
    key: string,
  ): Promise<ProviderLocationOutcome> => ({
    ok: true,
    found: true,
    locationKey: key,
    subscriptionUrl: null,
  });
}

function uninstallLocationCapability(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) return;
  const capabilities = descriptor.capabilities as ProviderCapability[];
  capabilities.splice(0, capabilities.length, ...originalCapabilities);
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  delete proto['readLocation'];
  delete proto['applyLocation'];
}

function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((field) => `${field}=${fields[field]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('the mini app location change', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let panel: FakeMarzban | undefined;
  let owner: ActorContext;
  let panelId: string;
  let keySeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-loc-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-loc-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>mini</title>');
    const env = {
      MINIAPP_DIST_DIR: distDir,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    };
    ctx = await createTestContext(env);
    api = await createApiApp(testConfig(env));
    installLocationCapability();
  }, 120_000);

  afterAll(async () => {
    uninstallLocationCapability();
    await api?.close();
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    rmSync(distDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await panel?.close();
    panel = undefined;
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'loc-owner', roleKeys: ['owner'] }),
    );
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'mini_app' as never);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'mini_app' as never,
      enabled: true,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'mini-app location test',
    });
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
  });

  // --- helpers ---------------------------------------------------------------------------

  async function sessionFor(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const call = (
    token: string,
    method: 'GET' | 'POST',
    route: string,
    params: Record<string, string> = {},
    payload?: unknown,
    idempotencyKey: string = key(),
  ) =>
    inject({
      method,
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  const customerIdOf = async (telegramUserId: number): Promise<UserId> => {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId}
            AND telegram_user_id = ${String(telegramUserId)}`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('no customer');
    return id as UserId;
  };

  /** An ACTIVE service owned by the customer, bought the way the bot buys one. */
  async function activeService(customerId: UserId, tag: string): Promise<string> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-draft`,
      customerId,
      productId: created.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${tag}-fund`,
      direction: 'CREDIT',
      amountMinor: 5_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(tag), customerId, {
      idempotencyKey: `${tag}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      confirmed.id,
    );
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return service.id;
  }

  const location = (overrides: Partial<ServiceLocationInput>): ServiceLocationInput => ({
    panelId,
    productId: null,
    locationKey: 'nl',
    label: 'هلند',
    initial: false,
    enabled: true,
    price: { amountMinor: 30_000n, currency: 'IRT' },
    limits: { cooldownHours: null, maxChanges: null, periodDays: null },
    sortOrder: 10,
    ...overrides,
  });

  let locationSeq = 0;
  async function configure(input: ServiceLocationInput): Promise<string> {
    locationSeq += 1;
    const saved = await ctx.container.serviceLocations.create(tenantA, owner, {
      idempotencyKey: `miniloc-config-${String(locationSeq)}`,
      location: input,
    });
    return saved.location.id;
  }

  /** The panel's initial location `de`, a paid `nl` and a free `fi`. */
  async function standardLocations(
    limits: ServiceLocationInput['limits'] = {
      cooldownHours: null,
      maxChanges: null,
      periodDays: null,
    },
  ): Promise<{ nl: string; fi: string }> {
    await configure(
      location({ locationKey: 'de', label: 'آلمان', initial: true, enabled: false, price: null }),
    );
    const nl = await configure(location({ limits }));
    const fi = await configure(
      location({
        locationKey: 'fi',
        label: 'فنلاند',
        price: { amountMinor: 0n, currency: 'IRT' },
        limits,
        sortOrder: 20,
      }),
    );
    return { nl, fi };
  }

  async function count(table: string): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ n: string }>(
      sql.raw(`SELECT count(*)::text AS n FROM ${table}`),
    );
    return Number(rows.rows[0]?.n ?? '0');
  }

  async function movingCustomer() {
    const token = await sessionFor(800101);
    const serviceId = await activeService(await customerIdOf(800101), 'miniloc');
    return { token, serviceId };
  }

  // --- the cases -------------------------------------------------------------------------

  it('offers the configured targets with their prices, and says so on the service', async () => {
    const { token, serviceId } = await movingCustomer();
    const before = miniAppServiceDetailSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.service, { serviceId })).body),
    );
    expect(before.canChangeLocation, 'nothing configured: no sheet').toBe(false);
    const refused = await call(token, 'GET', MINIAPP_ROUTES.serviceLocations, { serviceId });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).error.code).toBe(
      COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
    );

    await standardLocations();
    const detail = miniAppServiceDetailSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.service, { serviceId })).body),
    );
    expect(detail.canChangeLocation).toBe(true);
    const offer = miniAppServiceLocationsSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.serviceLocations, { serviceId })).body),
    );
    expect(offer.current).toEqual({ label: 'آلمان' });
    expect(offer.targets.map((target) => [target.label, target.price.amountMinor])).toEqual([
      ['هلند', '30000'],
      ['فنلاند', '0'],
    ]);
    // Nothing the service does not expose: no capacity, no tag. R11 B4 adds the remaining
    // count, which is null with no limit set (as here).
    expect(offer.remaining).toBeNull();
    expect(Object.keys(offer).sort()).toEqual(['current', 'remaining', 'targets']);
    expect(Object.keys(offer.targets[0] ?? {}).sort()).toEqual(['id', 'label', 'price']);
  }, 60_000);

  it("answers another customer's service as not found, and moves, drafts and records nothing", async () => {
    const { token: alice, serviceId } = await movingCustomer();
    const { nl, fi } = await standardLocations();
    const bob = await sessionFor(800102);

    const read = await call(bob, 'GET', MINIAPP_ROUTES.serviceLocations, { serviceId });
    expect(read.statusCode, read.body).toBe(404);
    expect(JSON.parse(read.body).error.code).toBe('miniapp.not_found');
    for (const locationId of [nl, fi]) {
      const asked = await call(
        bob,
        'POST',
        MINIAPP_ROUTES.serviceLocation,
        { serviceId },
        { locationId },
      );
      expect(asked.statusCode, asked.body).toBe(404);
      expect(JSON.parse(asked.body).error.code).toBe('miniapp.not_found');
    }
    expect(await count('service_location_changes')).toBe(0);
    const orders = await ctx.container.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM orders WHERE purpose = 'CHANGE_LOCATION'`,
    );
    expect(orders.rows[0]?.n).toBe('0');

    // The owner's own request still works afterwards: nothing was left half-done.
    const own = miniAppServiceLocationResultSchema.parse(
      JSON.parse(
        (
          await call(
            alice,
            'POST',
            MINIAPP_ROUTES.serviceLocation,
            { serviceId },
            { locationId: fi },
          )
        ).body,
      ),
    );
    expect(own).toEqual({ outcome: 'REQUESTED' });
  }, 60_000);

  it('requests a free move through the service the bot calls, recorded as the mini app', async () => {
    const { token, serviceId } = await movingCustomer();
    const { fi } = await standardLocations();
    const sent = key();
    const first = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: fi },
      sent,
    );
    expect(first.statusCode, first.body).toBe(201);
    expect(miniAppServiceLocationResultSchema.parse(JSON.parse(first.body))).toEqual({
      outcome: 'REQUESTED',
    });
    // A retry under the same key is the same request, not a second move.
    const again = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: fi },
      sent,
    );
    expect(again.statusCode, again.body).toBe(201);
    expect(await count('service_location_changes')).toBe(1);

    const audited = await ctx.container.database.db.execute<{ source_surface: string }>(
      sql`SELECT source_surface FROM audit_logs WHERE action = 'service.change_location_request'`,
    );
    expect(audited.rows.length).toBeGreaterThan(0);
    expect(audited.rows.every((row) => row.source_surface === 'MINI_APP')).toBe(true);

    await ctx.container.provisionerLoop.tick();
    const moved = miniAppServicesResponseSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.services)).body),
    );
    expect(moved.items[0]?.locationLabel).toBe('فنلاند');
  }, 60_000);

  it('quotes a priced move as the ordinary draft order, recorded as the mini app', async () => {
    const { token, serviceId } = await movingCustomer();
    const { nl } = await standardLocations();
    const asked = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: nl },
    );
    expect(asked.statusCode, asked.body).toBe(201);
    const result = miniAppServiceLocationResultSchema.parse(JSON.parse(asked.body));
    expect(result.outcome).toBe('ORDER');
    if (result.outcome !== 'ORDER') return;
    expect(result.order.purpose).toBe('CHANGE_LOCATION');
    expect(result.order.state).toBe('DRAFT');
    expect(result.order.subtotal.amountMinor).toBe('30000');
    const rows = await ctx.container.database.db.execute<{ source_surface: string | null }>(
      sql`SELECT source_surface FROM orders WHERE purpose = 'CHANGE_LOCATION'`,
    );
    expect(rows.rows).toEqual([{ source_surface: 'MINI_APP' }]);
    // A priced move is bought, never requested for free.
    expect(await count('service_location_changes')).toBe(1);
    const changes = await ctx.container.database.db.execute<{ order_id: string | null }>(
      sql`SELECT order_id FROM service_location_changes`,
    );
    expect(changes.rows[0]?.order_id).toBe(result.order.id);
  }, 60_000);

  it('passes the cooldown refusal through, and moves nothing', async () => {
    const { token, serviceId } = await movingCustomer();
    const { nl, fi } = await standardLocations({
      cooldownHours: 24,
      maxChanges: null,
      periodDays: null,
    });
    const first = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: fi },
    );
    expect(first.statusCode, first.body).toBe(201);
    await ctx.container.provisionerLoop.tick();

    // Every target is inside its cooldown: nothing is advertised any more …
    const offer = await call(token, 'GET', MINIAPP_ROUTES.serviceLocations, { serviceId });
    expect(offer.statusCode).toBe(409);
    // … and a request for one anyway is refused with the service's own code.
    const refused = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: nl },
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body).error.code).toBe(COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN);
    expect(await count('service_location_changes')).toBe(1);
  }, 60_000);

  it('refuses a target that is not one of the service’s own offer', async () => {
    const { token, serviceId } = await movingCustomer();
    await standardLocations();
    const asked = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: '01900000-0000-7000-8000-0000000000ff' },
    );
    expect(asked.statusCode, asked.body).toBe(409);
    expect(JSON.parse(asked.body).error.code).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE);
    expect(await count('service_location_changes')).toBe(0);
  }, 60_000);
});
