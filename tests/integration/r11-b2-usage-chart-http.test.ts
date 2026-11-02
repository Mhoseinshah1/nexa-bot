import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  USAGE_SNAPSHOT_BUCKET_MINUTES,
  miniAppPath,
  miniAppServiceDetailSchema,
  miniAppUsageHistorySchema,
  type ActorContext,
  type BotInstanceId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
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
import { paidOrder, rickPanel } from './usage-sync-fixtures';

/**
 * R11 B2: the mini app's usage-history endpoint and the detail flag, over real HTTP.
 *
 * The endpoint adds no business logic beyond the stored snapshots: what only this layer can
 * show is that ANOTHER customer's service is "not found", that the route does not exist while
 * `service_usage_chart` is off, that the range is closed to 7 and 30 days, that a point
 * carries the used volume and nothing else (no connected-device count), and that reading it
 * never touches a panel.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const HOUR = USAGE_SNAPSHOT_BUCKET_MINUTES * 60_000;
const DAY = 86_400_000;

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

describe('R11 B2: the mini app usage chart endpoint', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let panel: FakeRickpanel | undefined;
  let owner: ActorContext;
  let panelId: string;
  let keySeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-usage-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-usage-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

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

  async function setFlag(flag: 'mini_app' | 'service_usage_chart', enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: flag,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'R11 B2 test',
    });
  }

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'usage-owner', roleKeys: ['owner'] }),
    );
    await setFlag('mini_app', true);
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    panelId = await rickPanel(ctx, tenantA, owner, panel, 'b2-http');
    await validatePanelConnection(ctx.container, tenantA, panelId);
  });

  async function sessionFor(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const get = (token: string, route: string, params: Record<string, string>, query = '') =>
    inject({
      method: 'GET',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  /** One ACTIVE service bought the way a customer buys one, owned by a Telegram user. */
  async function ownedService(): Promise<{ serviceId: string; telegramUserId: number }> {
    const telegramUserId = 800101;
    await sessionFor(telegramUserId); // resolves the customer
    const customers = await ctx.container.database.withClient((client) =>
      client.query<{ id: string }>(
        'SELECT id FROM customers WHERE tenant_id = $1::uuid AND telegram_user_id = $2',
        [tenantA.tenantId, String(telegramUserId)],
      ),
    );
    const customerId = customers.rows[0]?.id as UserId | undefined;
    if (customerId === undefined) throw new Error('no customer');
    const orderId = await paidOrder(ctx, tenantA, owner, { panelId, customerId, key: 'b2http' });
    await ctx.container.provisionerLoop.tick();
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      orderId,
    );
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { serviceId: service.id, telegramUserId };
  }

  async function snapshotAt(serviceId: string, ageMs: number, usedBytes: number): Promise<void> {
    const takenAt = new Date(Math.floor((Date.now() - ageMs) / HOUR) * HOUR + 60_000);
    await ctx.container.database.withClient((client) =>
      client.query(
        `INSERT INTO service_usage_snapshots
           (tenant_id, service_id, bucket_at, taken_at, used_bytes, total_bytes, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5, 53687091200, NULL)`,
        [
          tenantA.tenantId,
          serviceId,
          new Date(Math.floor(takenAt.getTime() / HOUR) * HOUR).toISOString(),
          takenAt.toISOString(),
          usedBytes,
        ],
      ),
    );
  }

  it('answers the owner their own points for 7 or 30 days, used volume only', async () => {
    await setFlag('service_usage_chart', true);
    const { serviceId, telegramUserId } = await ownedService();
    await snapshotAt(serviceId, 20 * DAY, 100);
    await snapshotAt(serviceId, 3 * DAY, 200);
    await snapshotAt(serviceId, 1 * DAY, 300);
    const token = await sessionFor(telegramUserId);

    const week = await get(token, MINIAPP_ROUTES.serviceUsage, { serviceId }, '?days=7');
    expect(week.statusCode, week.body).toBe(200);
    const sevenDays = miniAppUsageHistorySchema.parse(JSON.parse(week.body));
    expect(sevenDays.days).toBe(7);
    expect(sevenDays.points.map((point) => point.usedBytes)).toEqual(['200', '300']);
    expect(sevenDays.totalBytes).toBe('53687091200');
    expect(sevenDays.expiresAt).toBeNull();

    const month = miniAppUsageHistorySchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.serviceUsage, { serviceId }, '?days=30')).body),
    );
    expect(month.points.map((point) => point.usedBytes)).toEqual(['100', '200', '300']);
    // The default range is the week; nothing but the used volume rides on a point.
    const byDefault = miniAppUsageHistorySchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.serviceUsage, { serviceId })).body),
    );
    expect(byDefault.days).toBe(7);
    expect(Object.keys(month.points[0] ?? {}).sort()).toEqual(['at', 'usedBytes']);
    expect(Object.keys(month).sort()).toEqual([
      'days',
      'expiresAt',
      'from',
      'points',
      'to',
      'totalBytes',
    ]);
  }, 90_000);

  it("answers another customer's service as not found and returns none of its points", async () => {
    await setFlag('service_usage_chart', true);
    const { serviceId } = await ownedService();
    await snapshotAt(serviceId, DAY, 300);
    const stranger = await sessionFor(800102);
    const response = await get(stranger, MINIAPP_ROUTES.serviceUsage, { serviceId }, '?days=7');
    expect(response.statusCode, response.body).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('miniapp.not_found');
    expect(response.body).not.toContain('300');
  }, 90_000);

  it('does not exist while the flag is off, and the service screen says no chart', async () => {
    const { serviceId, telegramUserId } = await ownedService();
    await snapshotAt(serviceId, DAY, 300);
    const token = await sessionFor(telegramUserId);

    const off = await get(token, MINIAPP_ROUTES.serviceUsage, { serviceId }, '?days=7');
    expect(off.statusCode, 'off: as if the route did not exist').toBe(404);
    const detailOff = miniAppServiceDetailSchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.service, { serviceId })).body),
    );
    expect(detailOff.usageChart).toBe(false);

    await setFlag('service_usage_chart', true);
    const detailOn = miniAppServiceDetailSchema.parse(
      JSON.parse((await get(token, MINIAPP_ROUTES.service, { serviceId })).body),
    );
    expect(detailOn.usageChart).toBe(true);
    expect((await get(token, MINIAPP_ROUTES.serviceUsage, { serviceId })).statusCode).toBe(200);
  }, 90_000);

  it('refuses a range other than 7 or 30 days', async () => {
    await setFlag('service_usage_chart', true);
    const { serviceId, telegramUserId } = await ownedService();
    const token = await sessionFor(telegramUserId);
    for (const days of ['5', '0', '90', 'abc', '-7']) {
      const response = await get(
        token,
        MINIAPP_ROUTES.serviceUsage,
        { serviceId },
        `?days=${days}`,
      );
      expect(response.statusCode, `days=${days}: ${response.body}`).toBe(400);
    }
  }, 90_000);

  it('reads only stored snapshots: no request reaches the panel', async () => {
    await setFlag('service_usage_chart', true);
    const { serviceId, telegramUserId } = await ownedService();
    await snapshotAt(serviceId, DAY, 300);
    const token = await sessionFor(telegramUserId);
    const before = panel?.requests.length ?? 0;
    for (const days of ['7', '30']) {
      const response = await get(
        token,
        MINIAPP_ROUTES.serviceUsage,
        { serviceId },
        `?days=${days}`,
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(panel?.requests.length, 'the history route makes no panel call').toBe(before);
  }, 90_000);
});
