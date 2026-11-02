import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppOrderSchema,
  miniAppPath,
  miniAppServiceDetailSchema,
  miniAppServicesResponseSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
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
 * R11 A4: the mini app for a service on a «فقط فایل، بدون لینک ساب» panel. The API must not
 * even SEND the link: the detail payload has no `subscriptionUrl`, says no QR is available,
 * and the QR route answers as it does for a service with no link. The option cannot be set
 * on a Marzban panel through the service (it hands over no files), so the column is written
 * directly here: this file is about the mini app's rule, not the setting's.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const GIB = 1024n ** 3n;

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

describe('the mini app on a files-only panel', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let panel: FakeMarzban | undefined;
  let owner: ActorContext;
  let keySeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-fo-'));
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-fo-key-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>mini</title>');
    const env = {
      MINIAPP_DIST_DIR: distDir,
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
      await createAdmin(ctx.container, tenantA, { username: 'mini-fo-owner', roleKeys: ['owner'] }),
    );
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'mini_app');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'mini_app',
      enabled: true,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'mini-app files-only test',
    });
  });

  const call = (
    token: string,
    route: string,
    params: Record<string, string> = {},
    post?: unknown,
  ) =>
    inject({
      method: post === undefined ? 'GET' : 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(post === undefined ? {} : { 'idempotency-key': key() }),
      },
      ...(post === undefined ? {} : { payload: post }),
    });

  /** A delivered service on a Marzban panel; its id, panel and the customer's session. */
  async function deliveredService(): Promise<{
    token: string;
    serviceId: string;
    panelId: string;
  }> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(),
    });
    const panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const made = await products.create(tenantA, {
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
    await products.setStatus(tenantA, made.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    const minted = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: 700901, first_name: 'سارا' }) },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const token = (JSON.parse(minted.body) as { token: string }).token;
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM customers WHERE tenant_id = ${tenantA.tenantId} AND telegram_user_id = '700901'`,
    );
    const customerId = rows.rows[0]?.id as UserId;
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const order = miniAppOrderSchema.parse(
      JSON.parse((await call(token, MINIAPP_ROUTES.orders, {}, { productId: made.id })).body),
    );
    await call(token, MINIAPP_ROUTES.orderPayWallet, { orderId: order.id }, {});
    await ctx.container.provisionerLoop.tick();
    const serviceId = miniAppServicesResponseSchema.parse(
      JSON.parse((await call(token, MINIAPP_ROUTES.services)).body),
    ).items[0]?.id as string;
    return { token, serviceId, panelId };
  }

  const setFilesOnly = (panelId: string, value: boolean) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET files_only_delivery = ${value} WHERE id = ${panelId}`,
    );

  it('control: with the option off the detail carries the link and offers its QR', async () => {
    const { token, serviceId } = await deliveredService();
    const response = await call(token, MINIAPP_ROUTES.service, { serviceId });
    expect(response.statusCode, response.body).toBe(200);
    const detail = miniAppServiceDetailSchema.parse(JSON.parse(response.body));
    expect(detail.subscriptionUrl).not.toBeNull();
    expect(detail.qr).toBe(true);
    expect((await call(token, MINIAPP_ROUTES.serviceQr, { serviceId })).statusCode).toBe(200);
  });

  it('sends no link at all, offers no QR, and the QR route answers not found', async () => {
    const { token, serviceId, panelId } = await deliveredService();
    const stored = await ctx.container.database.db.execute<{ subscription_url: string }>(
      sql`SELECT subscription_url FROM services WHERE id = ${serviceId}`,
    );
    const url = stored.rows[0]?.subscription_url ?? '-';
    expect(url).not.toBe('-');
    await setFilesOnly(panelId, true);

    const response = await call(token, MINIAPP_ROUTES.service, { serviceId });
    expect(response.statusCode, response.body).toBe(200);
    // Not only the field: the string itself is nowhere in the bytes sent to the client.
    expect(response.body).not.toContain(url);
    expect(response.body).not.toContain(url.split('/').at(-1) ?? '-');
    const detail = miniAppServiceDetailSchema.parse(JSON.parse(response.body));
    expect(detail.subscriptionUrl).toBeNull();
    expect(detail.qr).toBe(false);
    expect((await call(token, MINIAPP_ROUTES.serviceQr, { serviceId })).statusCode).toBe(404);

    const list = await call(token, MINIAPP_ROUTES.services);
    expect(list.body).not.toContain(url);
  }, 60_000);

  // ---- «نوع بارکد» --------------------------------------------------------------------

  const setQr = (panelId: string, kind: string, minutes = 360) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET qr_kind = ${kind}, singbox_interval_minutes = ${minutes} WHERE id = ${panelId}`,
    );

  it('offers the QRs the panel is set to, and draws only those', async () => {
    const { token, serviceId, panelId } = await deliveredService();
    const kindsOf = async () =>
      miniAppServiceDetailSchema.parse(
        JSON.parse((await call(token, MINIAPP_ROUTES.service, { serviceId })).body),
      ).qrKinds;
    const qr = (kind: string) =>
      call(token, MINIAPP_ROUTES.serviceQrKind, { serviceId, kind }).then((r) => r.statusCode);

    expect(await kindsOf()).toEqual(['SUB_LINK']);
    expect(await qr('SUB_LINK')).toBe(200);
    expect(await qr('SINGBOX')).toBe(404);

    await setQr(panelId, 'SINGBOX', 90);
    expect(await kindsOf()).toEqual(['SINGBOX']);
    expect(await qr('SINGBOX')).toBe(200);
    expect(await qr('SUB_LINK')).toBe(404);
    // The unnamed route draws the first QR on offer.
    expect((await call(token, MINIAPP_ROUTES.serviceQr, { serviceId })).statusCode).toBe(200);

    await setQr(panelId, 'BOTH');
    expect(await kindsOf()).toEqual(['SUB_LINK', 'SINGBOX']);
    expect(await qr('SUB_LINK')).toBe(200);
    expect(await qr('SINGBOX')).toBe(200);
    expect(await qr('OTHER')).toBe(404);
  }, 60_000);

  it('files-only wins over every QR kind: no kinds, no link, every QR route not found', async () => {
    const { token, serviceId, panelId } = await deliveredService();
    await setFilesOnly(panelId, true);
    for (const kind of ['SUB_LINK', 'SINGBOX', 'BOTH']) {
      await setQr(panelId, kind);
      const response = await call(token, MINIAPP_ROUTES.service, { serviceId });
      const detail = miniAppServiceDetailSchema.parse(JSON.parse(response.body));
      expect(detail.qrKinds, kind).toEqual([]);
      expect(detail.qr, kind).toBe(false);
      expect(detail.subscriptionUrl, kind).toBeNull();
      expect(response.body, kind).not.toContain('sing-box');
      for (const route of ['SUB_LINK', 'SINGBOX']) {
        expect(
          (await call(token, MINIAPP_ROUTES.serviceQrKind, { serviceId, kind: route })).statusCode,
          `${kind}/${route}`,
        ).toBe(404);
      }
      expect((await call(token, MINIAPP_ROUTES.serviceQr, { serviceId })).statusCode, kind).toBe(
        404,
      );
    }
  }, 60_000);
});
