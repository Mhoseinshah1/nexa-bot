import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  TELEGRAM_SECRET_TOKEN_HEADER,
  money,
  parseCustomServiceVolume,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
  tenantA,
  testConfig,
} from './harness';

/**
 * R5C-2 B1 — the custom service over Telegram: the entry is the LAST item of the category
 * list, the allowed range is shown before each figure is asked for, and each figure is
 * checked the moment it is typed, with the wrong input named and the range repeated.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-custom-service';
const BOT_A = SEED_IDS.botA1;
const CUSTOMER_TELEGRAM_ID = 5557654321;
const CHAT_ID = 4343;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const units = (gb: string): bigint => {
  const parsed = parseCustomServiceVolume(gb);
  if (parsed === null) throw new Error(gb);
  return parsed;
};

describe('R5C-2 B1: the custom service over Telegram', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let panelA: string;
  let updateId = 9000;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
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
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  const send = (kind: 'text' | 'tap', value: string) => {
    const id = (updateId += 1);
    const from = { id: CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' };
    const chat = { id: CHAT_ID, type: 'private' };
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload:
        kind === 'text'
          ? { update_id: id, message: { message_id: id, date: 0, chat, from, text: value } }
          : {
              update_id: id,
              callback_query: {
                id: `cbq-${id}`,
                from,
                data: value,
                message: {
                  message_id: id,
                  date: 0,
                  chat,
                  from: { id: 999999, is_bot: true, first_name: 'Nexa' },
                },
              },
            },
    });
  };

  const messages = () =>
    sent.filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'));
  const lastText = () => String(messages()[messages().length - 1]?.body['text']);
  const lastButtons = () =>
    (
      (
        messages()[messages().length - 1]?.body['reply_markup'] as
          { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined
      )?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => b.callback_data);

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'marzban', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
    // A sellable product, so the category list has a category for the entry to come AFTER.
    const products = new DrizzleProductRepository(api.container.database.db);
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as never,
        categoryId: seededCategoryFor(tenantA) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner-r5c2-b1', roleKeys: ['owner'] }),
    );
    const flag = (await api.container.featureFlags.list(tenantA, owner)).find(
      (one) => one.key === 'custom_service',
    )!;
    await api.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: 'b1-flag-key',
      key: 'custom_service',
      enabled: true,
      expectedVersion: flag.version,
      confirmKey: 'custom_service',
      reason: 'b1',
    });
    await api.container.customServiceAdmin.saveLocation(tenantA, owner, {
      idempotencyKey: 'b1-location-key',
      panelId: panelA,
      label: 'آلمان',
      enabled: true,
    });
    const base = {
      label: null,
      customerId: null,
      resellerTierId: null,
      panelId: null,
      enabled: true,
      unitPriceMinor: 1000n,
    } as const;
    await api.container.customServiceAdmin.createRule(tenantA, owner, {
      idempotencyKey: 'b1-volume-key',
      rule: { ...base, dimension: 'VOLUME', minUnits: units('1'), maxUnits: units('100') },
    });
    await api.container.customServiceAdmin.createRule(tenantA, owner, {
      idempotencyKey: 'b1-time-rule-key',
      rule: { ...base, dimension: 'TIME', minUnits: 7n, maxUnits: 90n },
    });
  });

  it('draws the entry LAST: after every category, never first', async () => {
    await send('text', '/catalog');
    const buttons = lastButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[buttons.length - 1]).toBe('cu:');
    expect(buttons.slice(0, -1).every((data) => data.startsWith('ck:'))).toBe(true);
    expect(buttons.indexOf('cu:')).toBe(buttons.length - 1);
  });

  it('shows the range before asking, validates each figure at once, and repeats the range', async () => {
    await send('tap', 'cu:');
    expect(lastButtons()).toEqual([`cv:${panelA}`]);
    await send('tap', `cv:${panelA}`);
    expect(lastText()).toContain('حجم را بین 1 تا 100 گیگابایت');

    // 2000 GB: refused NOW, naming the volume, with the range — not the generic sentence.
    await send('text', '2000');
    expect(lastText()).toContain('حجم واردشده درست نیست');
    expect(lastText()).toContain('بین 1 تا 100 گیگابایت');
    expect(lastText()).not.toBe(CATALOGUE_FA['bot.custom_service.unavailable']);

    // A valid volume moves on and shows the days range.
    await send('text', '10');
    expect(lastText()).toContain('مدت را بین 7 تا 90 روز');

    // 400 days and 3 days: the days are the wrong input, the range is repeated.
    await send('text', '400');
    expect(lastText()).toContain('مدت واردشده درست نیست');
    expect(lastText()).toContain('بین 7 تا 90 روز');
    await send('text', '3');
    expect(lastText()).toContain('مدت واردشده درست نیست');
  });

  /*
   * R12 F3 item 2: the volume and days questions carry «🔙 بازگشت به مکان‌ها» (there is no
   * pre-invoice yet) and «انصراف»; each closes the open window, so the next number typed is an
   * ordinary message again.
   */
  it('R12 F3: the volume and days questions carry back and cancel, and each closes the window', async () => {
    await send('tap', 'cu:');
    await send('tap', `cv:${panelA}`);
    expect(lastButtons()).toEqual(['ik:', 'iz:']);

    await send('tap', 'ik:');
    expect(lastButtons()).toEqual([`cv:${panelA}`]);
    await send('text', '10');
    expect(lastText()).toBe(CATALOGUE_FA['bot.unknown_command']);

    await send('tap', `cv:${panelA}`);
    await send('text', '10');
    expect(lastText()).toContain('مدت را بین 7 تا 90 روز');
    expect(lastButtons()).toEqual(['ik:', 'iz:']);
    await send('tap', 'iz:');
    expect(lastText()).toContain('خوش برگشتی');
    await send('text', '30');
    expect(lastText()).toBe(CATALOGUE_FA['bot.unknown_command']);
  });

  it('the days step answers UNAVAILABLE, not a range, when the flag was turned off after the volume step', async () => {
    await send('tap', 'cu:');
    await send('tap', `cv:${panelA}`);
    await send('text', '10');
    expect(lastText()).toContain('مدت را بین 7 تا 90 روز');

    const owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-r5c2-off',
        roleKeys: ['owner'],
      }),
    );
    const flag = (await api.container.featureFlags.list(tenantA, owner)).find(
      (one) => one.key === 'custom_service',
    )!;
    await api.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: 'b1-flag-off-key',
      key: 'custom_service',
      enabled: false,
      expectedVersion: flag.version,
      confirmKey: 'custom_service',
      reason: 'b1 off',
    });

    // An out-of-range figure would otherwise be answered with the range prompt.
    await send('text', '3');
    expect(lastText()).toBe(CATALOGUE_FA['bot.custom_service.unavailable']);
    expect(lastText()).not.toContain('مدت را بین');
  });
});
