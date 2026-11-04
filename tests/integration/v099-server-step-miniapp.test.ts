import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppCategoriesResponseSchema,
  miniAppCategoryResponseSchema,
  miniAppPath,
  miniAppServersResponseSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  createApiApp,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';

/**
 * V099 «انتخاب سرور در خرید»: the mini app store's endpoints for the server step, over real
 * HTTP. `GET /catalogue/servers` says whether to draw the step and lists the servers; the
 * category list and a category's plans take an optional `serverId`. Without it every answer
 * is the one the store had before — the existing fields, unchanged.
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

describe('V099: the mini app server step API', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let owner: ActorContext;
  let keySeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-v099-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-v099-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

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

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'v099-owner', roleKeys: ['owner'] }),
    );
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'mini_app' as never);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'mini_app' as never,
      enabled: true,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'v099 server step test',
    });
  });

  const db = () => ctx.container.database.db;

  async function sessionFor(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const get = (token: string, route: string, params: Record<string, string> = {}, query = '') =>
    inject({
      method: 'GET',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  async function server(name: string): Promise<string> {
    const id = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${id}, ${tenantA.tenantId}, ${name}, 'sanaei',
              ${`https://${id.slice(0, 8)}.example.test`}, 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, id);
    return id;
  }

  async function category(name: string, sortOrder: number): Promise<string> {
    const id = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, status, visibility, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, ${name}, 'ACTIVE', 'VISIBLE', ${sortOrder})`);
    return id;
  }

  async function plan(panelId: string, categoryId: string, title: string): Promise<ProductId> {
    const products = new DrizzleProductRepository(db());
    const now = ctx.container.clock.now();
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', now);
    return created.id;
  }

  async function fleet() {
    const germany = await server('آلمان');
    const netherlands = await server('هلند');
    const monthly = await category('یک‌ماهه ۳۰ روزه', 1);
    const special = await category('ویژه', 2);
    return {
      germany,
      netherlands,
      monthly,
      special,
      germanyMonthly: await plan(germany, monthly, 'آلمان ۵۰ گیگ'),
      netherlandsMonthly: await plan(netherlands, monthly, 'هلند ۵۰ گیگ'),
      germanySpecial: await plan(germany, special, 'آلمان ویژه'),
    };
  }

  const serverSelectionOn = () =>
    ctx.container.settingsService.set(tenantA, owner, {
      key: 'sales.server_selection',
      value: true,
      expectedVersion: null,
      idempotencyKey: key(),
    });

  it('OFF (the default): the servers route says so and lists nothing; the store is unchanged', async () => {
    const f = await fleet();
    const token = await sessionFor(800101);
    const servers = await get(token, MINIAPP_ROUTES.servers);
    expect(servers.statusCode, servers.body).toBe(200);
    expect(miniAppServersResponseSchema.parse(JSON.parse(servers.body))).toStrictEqual({
      enabled: false,
      step: false,
      items: [],
      page: 0,
      hasMore: false,
    });
    // The two existing routes answer exactly their old shape, every server's rows included.
    const categories = JSON.parse((await get(token, MINIAPP_ROUTES.categories)).body);
    expect(Object.keys(categories).sort()).toStrictEqual(['hasMore', 'items', 'page']);
    expect(miniAppCategoriesResponseSchema.parse(categories).items.map((c) => c.id)).toStrictEqual([
      f.monthly,
      f.special,
    ]);
    const plans = JSON.parse(
      (await get(token, MINIAPP_ROUTES.category, { categoryId: f.monthly })).body,
    );
    expect(Object.keys(plans).sort()).toStrictEqual(['hasMore', 'items', 'page']);
    expect(
      miniAppCategoryResponseSchema
        .parse(plans)
        .items.map((p) => p.id)
        .sort(),
    ).toStrictEqual([f.germanyMonthly, f.netherlandsMonthly].sort());
  });

  it('ON: lists the servers by name, and narrows the categories and the plans to one', async () => {
    const f = await fleet();
    await serverSelectionOn();
    const token = await sessionFor(800102);

    const servers = miniAppServersResponseSchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.servers)).body),
    );
    expect(servers).toStrictEqual({
      enabled: true,
      step: true,
      items: [
        { id: f.germany, name: 'آلمان' },
        { id: f.netherlands, name: 'هلند' },
      ],
      page: 0,
      hasMore: false,
    });

    const onNetherlands = miniAppCategoriesResponseSchema.parse(
      JSON.parse(
        (await get(token, MINIAPP_ROUTES.categories, {}, `?serverId=${f.netherlands}`)).body,
      ),
    );
    // «ویژه» has no plan on the Netherlands.
    expect(onNetherlands.items.map((c) => c.id)).toStrictEqual([f.monthly]);

    const germanyMonthly = miniAppCategoryResponseSchema.parse(
      JSON.parse(
        (
          await get(
            token,
            MINIAPP_ROUTES.category,
            { categoryId: f.monthly },
            `?serverId=${f.germany}&page=0`,
          )
        ).body,
      ),
    );
    expect(germanyMonthly.items.map((p) => p.id)).toStrictEqual([f.germanyMonthly]);

    // Without the filter the routes are the whole catalogue still.
    const all = miniAppCategoriesResponseSchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.categories)).body),
    );
    expect(all.items.map((c) => c.id)).toStrictEqual([f.monthly, f.special]);
  });

  it('ON with one server able to sell: step is false (skipped); a drained server filters to nothing', async () => {
    const f = await fleet();
    await serverSelectionOn();
    await db().execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'v099 test' WHERE id = ${f.netherlands}`,
    );
    const token = await sessionFor(800103);
    const servers = miniAppServersResponseSchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.servers)).body),
    );
    expect(servers.enabled).toBe(true);
    expect(servers.step).toBe(false);
    expect(servers.items).toStrictEqual([{ id: f.germany, name: 'آلمان' }]);
    const drained = miniAppCategoriesResponseSchema.parse(
      JSON.parse(
        (await get(token, MINIAPP_ROUTES.categories, {}, `?serverId=${f.netherlands}`)).body,
      ),
    );
    expect(drained.items).toStrictEqual([]);
  });

  it('refuses a serverId that is not an id', async () => {
    await fleet();
    const token = await sessionFor(800104);
    const bad = await get(token, MINIAPP_ROUTES.categories, {}, '?serverId=not-a-uuid');
    expect(bad.statusCode).toBe(400);
  });
});
