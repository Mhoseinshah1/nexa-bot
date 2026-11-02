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
  miniAppServiceLocationsSchema,
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
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/bot-runtime';
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
 * Round 11, B4: the location changes a customer has LEFT, on the bot's service card, the bot's
 * location screen and the mini app's service view and location sheet.
 *
 * (Set-up shared in shape with `miniapp-location.test.ts`: the mini app over real HTTP, the
 * bot runtime in-process, one PostgreSQL, the Marzban descriptor given LOCATION_CHANGE.)
 *
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

describe('R11 B4: the remaining location changes', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let panel: FakeMarzban | undefined;
  let owner: ActorContext;
  let panelId: string;
  let keySeq = 0;
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  let updateSeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-loc-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-loc-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          sent.push({
            url: request.url ?? '',
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        } catch {
          // not JSON: nothing to record
        }
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
    sent = [];
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
    // R11 B4: the line is behind `location_remaining_display` (off by default); the cases below
    // switch it on, and the flag cases switch it off again.
    await setRemainingFlag(true);
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

  async function count(table: string): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ n: string }>(
      sql.raw(`SELECT count(*)::text AS n FROM ${table}`),
    );
    return Number(rows.rows[0]?.n ?? '0');
  }

  // --- helpers of this file ---------------------------------------------------------------

  /** The customer, the bot's way of tapping, and the text the bot last drew. */
  const tapUpdate = (data: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `b4-update-${String(updateSeq)}`,
      botInstanceId: BOT_A1,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: 800101, is_bot: false, first_name: 'مشتری' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 6160, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: '800101',
      from: { id: 800101, first_name: 'مشتری' },
    };
  };

  const REMAINING_LINE = 'تغییر لوکیشن باقی‌مانده';
  const line = (remaining: number, max: number) =>
    `${REMAINING_LINE}: ${String(remaining)} از ${String(max)}`;

  /** Taps `data` and returns what the bot drew: its text and the callbacks of its buttons. */
  async function tap(
    data: string,
  ): Promise<{ text: string; callbacks: string[]; key: string | null }> {
    sent = [];
    const reply = await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('b4-bot'),
      tapUpdate(data),
    );
    const drawn = sent
      .filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'))
      .at(-1);
    const markup = JSON.stringify(drawn?.body['reply_markup'] ?? {});
    return {
      text: String(drawn?.body['text'] ?? ''),
      callbacks: [...markup.matchAll(/"callback_data":"([^"]+)"/gu)].map((m) => m[1] ?? ''),
      key: reply.replyKey ?? null,
    };
  }

  /** The service card as the customer sees it. */
  const card = (serviceId: string) => tap(`s:${serviceId}`);
  /** The location screen the card's button opens. */
  const choice = (serviceId: string) => tap(`lc:${serviceId}`);

  const detailOf = async (token: string, serviceId: string) =>
    miniAppServiceDetailSchema.parse(
      JSON.parse((await call(token, 'GET', MINIAPP_ROUTES.service, { serviceId })).body),
    );

  const sheetOf = async (token: string, serviceId: string) => {
    const response = await call(token, 'GET', MINIAPP_ROUTES.serviceLocations, { serviceId });
    return response.statusCode === 200
      ? miniAppServiceLocationsSchema.parse(JSON.parse(response.body))
      : null;
  };

  const requestFree = (customerId: UserId, serviceId: string, locationId: string, tag: string) =>
    ctx.container.locationChanges.requestFree(tenantA, systemActor(tag), customerId, {
      serviceId,
      locationId,
      idempotencyKey: `b4-free-${tag}`,
    });

  /** The panel's initial `de` (disabled as a target), and two FREE targets `nl` and `fi`. */
  async function freeLocations(limits: ServiceLocationInput['limits']) {
    await configure(
      location({ locationKey: 'de', label: 'آلمان', initial: true, enabled: false, price: null }),
    );
    const free = { amountMinor: 0n, currency: 'IRT' as const };
    const nl = await configure(location({ locationKey: 'nl', price: free, limits }));
    const fi = await configure(
      location({ locationKey: 'fi', label: 'فنلاند', price: free, limits, sortOrder: 20 }),
    );
    return { nl, fi };
  }

  const LIMIT_3 = { cooldownHours: null, maxChanges: 3, periodDays: 30 };

  async function customer() {
    const token = await sessionFor(800101);
    const customerId = await customerIdOf(800101);
    const serviceId = await activeService(customerId, 'b4');
    return { token, customerId, serviceId };
  }

  async function setRemainingFlag(enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(
      tenantA,
      'location_remaining_display',
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'location_remaining_display',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'b4 remaining line',
    });
  }

  // --- the cases -------------------------------------------------------------------------

  it('enabled and limited: shows «N از M» on the bot card, the bot screen, the mini app view and sheet, and counts down', async () => {
    const { token, customerId, serviceId } = await customer();
    const { nl } = await freeLocations(LIMIT_3);

    expect((await card(serviceId)).text).toContain(line(3, 3));
    const screen = await choice(serviceId);
    expect(screen.key).toBe('bot.service.location_choice');
    expect(screen.text).toContain(line(3, 3));
    expect((await detailOf(token, serviceId)).locationRemaining).toEqual({ remaining: 3, max: 3 });
    expect((await sheetOf(token, serviceId))?.remaining).toEqual({ remaining: 3, max: 3 });

    await requestFree(customerId, serviceId, nl, 'one');
    await ctx.container.provisionerLoop.tick();

    expect((await card(serviceId)).text).toContain(line(2, 3));
    expect((await choice(serviceId)).text).toContain(line(2, 3));
    expect((await detailOf(token, serviceId)).locationRemaining).toEqual({ remaining: 2, max: 3 });
    expect((await sheetOf(token, serviceId))?.remaining).toEqual({ remaining: 2, max: 3 });
  }, 90_000);

  it('shows what the SERVER enforces: changes are made until refused, and the figure shown before each one predicts it', async () => {
    const { token, customerId, serviceId } = await customer();
    const { nl, fi } = await freeLocations(LIMIT_3);
    const targets = [nl, fi];
    let accepted = 0;
    let refusedAt: number | null = null;

    for (let attempt = 0; attempt < 6 && refusedAt === null; attempt += 1) {
      const shown = (await detailOf(token, serviceId)).locationRemaining;
      expect(shown, 'a limit is set: a figure is always shown').not.toBeNull();
      // The bot's card says the same number as the mini app's view.
      expect((await card(serviceId)).text).toContain(line(shown?.remaining ?? -1, 3));

      const target = targets[attempt % 2] as string;
      try {
        await requestFree(customerId, serviceId, target, `loop-${String(attempt)}`);
        accepted += 1;
        expect(shown?.remaining, `attempt ${String(attempt)} was allowed`).toBeGreaterThan(0);
        await ctx.container.provisionerLoop.tick();
      } catch (error) {
        refusedAt = attempt;
        expect(shown?.remaining, 'refused exactly when the figure said 0').toBe(0);
        expect(error).toMatchObject({ code: COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED });
      }
    }

    expect(accepted, 'the server allowed exactly the limit').toBe(3);
    expect(refusedAt).toBe(3);

    // At zero: the figure is still there, the button is gone, and the refusal is unchanged.
    const atZero = await card(serviceId);
    expect(atZero.text).toContain(line(0, 3));
    expect(atZero.callbacks.some((data) => data.startsWith('lc:'))).toBe(false);
    const view = await detailOf(token, serviceId);
    expect(view.locationRemaining).toEqual({ remaining: 0, max: 3 });
    expect(view.canChangeLocation).toBe(false);
    expect(await sheetOf(token, serviceId)).toBeNull();
    // The service is in nl now (nl, fi, nl): fi is the target a stale tap would ask for.
    const stale = await tap(`lt:${encodeIdPair(serviceId, fi)}`);
    expect(stale.key).toBe('bot.service.location_limit');
    const crafted = await call(
      token,
      'POST',
      MINIAPP_ROUTES.serviceLocation,
      { serviceId },
      { locationId: fi },
    );
    expect(crafted.statusCode).toBe(409);
    expect(JSON.parse(crafted.body).error.code).toBe(
      COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED,
    );
    expect(await count('service_location_changes')).toBe(3);
  }, 120_000);

  it('applies the customer’s override to the figure, the way it applies it to the enforcement', async () => {
    const { token, customerId, serviceId } = await customer();
    const { nl } = await freeLocations(LIMIT_3);
    await requestFree(customerId, serviceId, nl, 'ovr');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.customerControls.setLocationOverride(tenantA, owner, {
      idempotencyKey: 'b4-override',
      customerId,
      limits: { cooldownHours: null, maxChanges: 1, periodDays: 30 },
      reason: 'tighter for this customer',
    });
    expect((await card(serviceId)).text).toContain(line(0, 1));
    expect((await detailOf(token, serviceId)).locationRemaining).toEqual({ remaining: 0, max: 1 });
    // And with the override removed the location's own limit is back.
    await ctx.container.customerControls.setLocationOverride(tenantA, owner, {
      idempotencyKey: 'b4-override-off',
      customerId,
      limits: null,
      reason: 'back',
    });
    expect((await card(serviceId)).text).toContain(line(2, 3));
  }, 90_000);

  it('enabled but unlimited: says nothing about what remains, and the screens are as they were', async () => {
    const { token, serviceId } = await customer();
    await freeLocations({ cooldownHours: 24, maxChanges: null, periodDays: null });

    const shownCard = await card(serviceId);
    expect(shownCard.text).not.toContain(REMAINING_LINE);
    expect(shownCard.callbacks.some((data) => data.startsWith('lc:'))).toBe(true);
    const screen = await choice(serviceId);
    expect(screen.key).toBe('bot.service.location_choice');
    expect(screen.text).not.toContain(REMAINING_LINE);
    // Byte for byte the old screen: where it is now, a blank line, the prompt.
    expect(screen.text).toContain('لوکیشن فعلی: آلمان\n\nلوکیشن مقصد را انتخاب کنید:');
    expect((await detailOf(token, serviceId)).locationRemaining).toBeNull();
    expect((await sheetOf(token, serviceId))?.remaining).toBeNull();
  }, 90_000);

  it('says nothing when a target is unlimited, however limited the others are', async () => {
    const { token, serviceId } = await customer();
    await configure(
      location({ locationKey: 'de', label: 'آلمان', initial: true, enabled: false, price: null }),
    );
    const free = { amountMinor: 0n, currency: 'IRT' as const };
    await configure(location({ locationKey: 'nl', price: free, limits: LIMIT_3 }));
    await configure(
      location({
        locationKey: 'fi',
        label: 'فنلاند',
        price: free,
        sortOrder: 20,
        limits: { cooldownHours: null, maxChanges: null, periodDays: null },
      }),
    );
    expect((await card(serviceId)).text).not.toContain(REMAINING_LINE);
    expect((await detailOf(token, serviceId)).locationRemaining).toBeNull();
  }, 90_000);

  it('disabled: nothing at all — no target configured, or the panel policy switched it off', async () => {
    const { token, serviceId } = await customer();

    // Nothing configured: the feature is not on for this service, limit or not.
    expect((await card(serviceId)).text).not.toContain(REMAINING_LINE);
    expect((await detailOf(token, serviceId)).locationRemaining).toBeNull();

    await freeLocations(LIMIT_3);
    expect((await card(serviceId)).text).toContain(line(3, 3));

    // The panel policy's «تغییر لوکیشن سرویس» switch off: the same limit is still configured.
    const current = await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId);
    await ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
      policy: {
        delivery: { mode: 'CARD_WITH_QR' },
        actions: { LOCATION_CHANGE: { customerEnabled: false } },
      },
      expectedRevision: current.policy.revision,
      idempotencyKey: 'b4-policy-off',
    });
    const off = await card(serviceId);
    expect(off.text).not.toContain(REMAINING_LINE);
    expect(off.callbacks.some((data) => data.startsWith('lc:'))).toBe(false);
    const view = await detailOf(token, serviceId);
    expect(view.locationRemaining).toBeNull();
    expect(view.canChangeLocation).toBe(false);
  }, 90_000);

  it('flag off (the default): no line on the bot card, the bot screen, the mini app view or the sheet — and the button and enforcement are untouched; on again, the line is back', async () => {
    const { token, serviceId } = await customer();
    await freeLocations(LIMIT_3);
    await setRemainingFlag(false);

    const shownCard = await card(serviceId);
    expect(shownCard.text).not.toContain(REMAINING_LINE);
    // The button is the location feature's, not this flag's.
    expect(shownCard.callbacks.some((data) => data.startsWith('lc:'))).toBe(true);
    const screen = await choice(serviceId);
    expect(screen.key).toBe('bot.service.location_choice');
    expect(screen.text).not.toContain(REMAINING_LINE);
    expect(screen.text).toContain('لوکیشن فعلی: آلمان\n\nلوکیشن مقصد را انتخاب کنید:');
    const view = await detailOf(token, serviceId);
    expect(view.locationRemaining).toBeNull();
    expect(view.canChangeLocation).toBe(true);
    const sheet = await sheetOf(token, serviceId);
    expect(sheet?.remaining).toBeNull();
    expect(sheet?.targets.length).toBeGreaterThan(0);

    await setRemainingFlag(true);
    expect((await card(serviceId)).text).toContain(line(3, 3));
    expect((await choice(serviceId)).text).toContain(line(3, 3));
    expect((await detailOf(token, serviceId)).locationRemaining).toEqual({ remaining: 3, max: 3 });
    expect((await sheetOf(token, serviceId))?.remaining).toEqual({ remaining: 3, max: 3 });
  }, 90_000);

  it('flag on but location change not offered or no limit: still no line (the flag adds a switch, not a condition-free line)', async () => {
    const { token, serviceId } = await customer();
    // Nothing configured: disabled.
    expect((await card(serviceId)).text).not.toContain(REMAINING_LINE);
    expect((await detailOf(token, serviceId)).locationRemaining).toBeNull();
    // Configured without a limit.
    await freeLocations({ cooldownHours: null, maxChanges: null, periodDays: null });
    expect((await card(serviceId)).text).not.toContain(REMAINING_LINE);
    expect((await detailOf(token, serviceId)).locationRemaining).toBeNull();
  }, 90_000);
});
