import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProductCategoryId } from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  TELEGRAM_SECRET_TOKEN_HEADER,
  money,
  type ProductId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { appearanceFallbackText as plain } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Item 12 (blocker C4): old MirzaBot buttons, through the REAL webhook.
 *
 * NEXA answers on the token MirzaBot used, so a customer can scroll up after cutover and tap
 * a MirzaBot keyboard. Each case below sends that tap the way Telegram would and holds the
 * four promises: the webhook answers 2xx and nothing throws; the tap is acknowledged
 * (`answerCallbackQuery`) and answered with `bot.callback.stale` plus the main-menu button;
 * no order, payment, wallet entry, service, provisioning operation or reservation is
 * written; and no panel is dialled. The shapes are MirzaBot's own `callback_data`
 * (`tests/unit/legacy-mirzabot-callbacks.test.ts` carries the full corpus and its source).
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-legacy-callbacks';
const BOT_A = SEED_IDS.botA1;
const BOT_B = SEED_IDS.botB1;
// Distinct from every other suite's customer, so a shared anti-spam window cannot meet it.
const CUSTOMER = 7_770_001_234;
const CHAT_ID = 7_770_001_234;

/** MirzaBot shapes a customer is most likely to tap, the money and service ones first. */
const LEGACY_TAPS = [
  'confirmandgetservice',
  'confirmandgetserviceDiscount',
  'Confirmpay_user_17_aB3dE5',
  'cart_to_offline',
  'aqayepardakht',
  'Extra_volume_user123ab',
  'extend_user123ab',
  'removebyuser-user123ab',
  'changelink_user123ab',
  'product_user123ab',
  'backuser',
  'typepanel%marzban',
] as const;

/** Admin-side MirzaBot shapes: a bound administrator's old keyboard is in a chat too. */
const LEGACY_ADMIN_TAPS = [
  'Confirm_pay_aB3dE5',
  'reject_pay_aB3dE5',
  'addbalanceuser_5551234567',
  'remoceserviceadmin-user123ab',
  'editpay-cart-oncard',
] as const;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('Item 12: an old MirzaBot button, through the webhook', () => {
  let api: ApiApp;
  let telegram: Server;
  let panel: Server;
  let sent: Sent[];
  let panelRequests: string[];
  let products: DrizzleProductRepository;
  let panelA: string;
  let updateId = 90_000;
  let panelUrl = '';

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return address.port;
  };

  beforeAll(async () => {
    sent = [];
    panelRequests = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
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
    // The panel: anything that reaches it is a provider call a stale tap must never make.
    panel = createServer((request, response) => {
      panelRequests.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(500);
      response.end();
    });
    const telegramPort = await listen(telegram);
    const panelPort = await listen(panel);
    panelUrl = `http://127.0.0.1:${String(panelPort)}`;
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(telegramPort)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    await new Promise<void>((resolve) => panel.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    panelRequests = [];
    products = new DrizzleProductRepository(api.container.database.db);
    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei',
              ${panelUrl}, 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelA);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const command = (text: string, bot: string = BOT_A) => {
    const id = (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: CHAT_ID, type: 'private' },
          from: { id: CUSTOMER, is_bot: false, first_name: 'Ali' },
          text,
        },
      },
    });
  };

  /** A tap whose `callback_query` the caller may shape — `data` absent, a number, anything. */
  const rawTap = (callback: Record<string, unknown>, bot: string = BOT_A) => {
    const id = (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        callback_query: {
          id: `cbq-${String(id)}`,
          from: { id: CUSTOMER, is_bot: false, first_name: 'Ali' },
          // An old message sent by the same bot in the customer's private chat. Each tap its
          // own message id, as each NEXA screen is: the R2 wizard binds a step to its message.
          message: {
            message_id: id,
            date: 1_700_000_000,
            chat: { id: CHAT_ID, type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Bot' },
          },
          chat_instance: '-123',
          ...callback,
        },
      },
    });
  };
  const tap = (data: string, bot: string = BOT_A) => rawTap({ data }, bot);

  const messages = () =>
    sent.filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'));
  const lastMessage = () => messages()[messages().length - 1];
  const answers = () => sent.filter((one) => one.url.includes('/answerCallbackQuery'));
  const buttonsOf = (message: Sent | undefined) =>
    (
      (
        message?.body['reply_markup'] as
          { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined
      )?.inline_keyboard ?? []
    ).flat();

  const STALE = plain(CATALOGUE_FA['bot.callback.stale']);

  /** Every row a stale tap could write if it reached commercial or provider work. */
  const commercialCounts = async (): Promise<Record<string, number>> => {
    const tables = [
      'orders',
      'payments',
      'payment_receipts',
      'wallet_entries',
      'services',
      'provisioning_operations',
      'service_commercial_actions',
      'service_username_reservations',
      'panel_capacity_reservations',
      'gateway_invoices',
      'trial_grants',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const result = await api.container.database.db.execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
      );
      counts[table] = Number((result.rows[0] as { n: number }).n);
    }
    return counts;
  };

  const orderStates = async () =>
    (
      await api.container.database.db.execute(
        sql`SELECT id, state, total_amount FROM orders ORDER BY created_at ASC`,
      )
    ).rows as Record<string, unknown>[];

  async function sellableProduct(scope: typeof tenantA, panelId: string) {
    const created = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as never,
        categoryId: seededCategoryFor(scope) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return created;
  }

  /** The stale answer, exactly: one message, the sentence, the main-menu button, one ack. */
  const expectStaleAnswer = (label: string) => {
    expect(messages(), label).toHaveLength(1);
    expect(lastMessage()?.body['text'], label).toBe(STALE);
    expect(
      buttonsOf(lastMessage()).map((button) => button.callback_data),
      label,
    ).toEqual(['mm:']);
    expect(answers(), label).toHaveLength(1);
    expect(answers()[0]?.body['callback_query_id'], label).toMatch(/^cbq-/u);
  };

  // -------------------------------------------------------------------------
  // The cases
  // -------------------------------------------------------------------------

  it('answers every MirzaBot shape with the stale-button sentence and the main menu, and writes nothing commercial', async () => {
    await command('/start');
    const before = await commercialCounts();
    for (const data of LEGACY_TAPS) {
      sent = [];
      const response = await tap(data);
      expect(response.statusCode, data).toBe(201);
      expectStaleAnswer(data);
      // Nothing read from the data reaches the reply.
      expect(JSON.stringify(sent), data).not.toContain(data);
    }
    expect(await commercialCounts()).toEqual(before);
    expect(panelRequests).toEqual([]);
    const failures = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'telegram.turn_failed'`,
    );
    expect(Number((failures.rows[0] as { n: number }).n)).toBe(0);
  });

  it('records nothing of the payload: no operational event, audit row or outbox message names it', async () => {
    await command('/start');
    for (const data of ['Confirmpay_user_17_aB3dE5', 'removebyuser-user123ab']) await tap(data);
    for (const table of ['operational_events', 'audit_logs', 'outbox_messages']) {
      const rows = await api.container.database.db.execute(
        sql.raw(`SELECT row_to_json(t)::text AS j FROM ${table} t`),
      );
      const text = rows.rows.map((row) => String((row as { j: string }).j)).join('\n');
      expect(text, table).not.toContain('Confirmpay_user');
      expect(text, table).not.toContain('removebyuser');
    }
  });

  it('answers an administrator’s old MirzaBot keyboard the same way, and moves no money', async () => {
    await command('/start');
    const before = await commercialCounts();
    for (const data of LEGACY_ADMIN_TAPS) {
      sent = [];
      expect((await tap(data)).statusCode, data).toBe(201);
      expectStaleAnswer(data);
    }
    expect(await commercialCounts()).toEqual(before);
    expect(panelRequests).toEqual([]);
  });

  it('answers malformed callbacks without a 500: no data, a number, empty, oversized, junk', async () => {
    const shapes: Record<string, unknown>[] = [
      {},
      { data: 42 },
      { data: null },
      { data: '' },
      { data: { nested: 'mm:' } },
      { data: 'x'.repeat(4096) },
      { data: '\u0000‮' },
    ];
    for (const shape of shapes) {
      sent = [];
      const response = await rawTap(shape);
      expect(response.statusCode, JSON.stringify(shape).slice(0, 40)).toBe(201);
      expectStaleAnswer(JSON.stringify(shape).slice(0, 40));
    }
  });

  it('answers an unknown NEXA-shaped action and a malformed id as stale, never as a neighbour', async () => {
    for (const data of ['zz:', 'mm', 'mk:', 'p:not-a-uuid', 'c:', 'C:1234']) {
      sent = [];
      expect((await tap(data)).statusCode, data).toBe(201);
      expectStaleAnswer(data);
    }
  });

  it('refuses a TRUNCATED confirm on a real order, leaving it exactly as it was', async () => {
    const sellable = await sellableProduct(tenantA, panelA);
    await tap(`p:${sellable.id}`);
    const orderId = String((await orderStates())[0]?.['id']);
    const before = await commercialCounts();
    sent = [];

    // Cut where a client limit or a copy-paste would cut: mid-uuid, and the last character.
    await tap(`c:${orderId.slice(0, 20)}`);
    expectStaleAnswer('half');
    sent = [];
    await tap(`c:${orderId.slice(0, -1)}`);
    expectStaleAnswer('one short');

    expect((await orderStates())[0]?.['state']).toBe('DRAFT');
    expect(await commercialCounts()).toEqual(before);
  });

  it('leaves a current callback exactly as it was: the main menu and a real draft', async () => {
    await tap('mm:');
    expect(lastMessage()?.body['text']).toBe(plain(CATALOGUE_FA['bot.start.welcome_back']));
    expect(lastMessage()?.body['text']).not.toBe(STALE);

    const sellable = await sellableProduct(tenantA, panelA);
    sent = [];
    await tap(`p:${sellable.id}`);
    expect(await orderStates()).toHaveLength(1);
    expect(lastMessage()?.body['text']).not.toBe(STALE);
  });

  it('keeps a typed unknown message on its own answer: the stale sentence is for buttons only', async () => {
    await command('backuser');
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);

    // A message with no text at all (a sticker) is UNSUPPORTED like an unreadable tap, and
    // still is not a tap: no stale sentence, no main-menu button.
    sent = [];
    const id = (updateId += 1);
    await inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: CHAT_ID, type: 'private' },
          from: { id: CUSTOMER, is_bot: false, first_name: 'Ali' },
          sticker: { file_id: 'sticker-file', file_unique_id: 'u', width: 1, height: 1 },
        },
      },
    });
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.unknown_command']);
    expect(buttonsOf(lastMessage())).toEqual([]);
  });

  it('leaves a customer’s order in flight untouched by a legacy tap, and the order still payable', async () => {
    const sellable = await sellableProduct(tenantA, panelA);
    await tap(`p:${sellable.id}`);
    const orderId = String((await orderStates())[0]?.['id']);
    await tap(`c:${orderId}`);
    expect((await orderStates())[0]?.['state']).toBe('AWAITING_PAYMENT');
    const before = await commercialCounts();

    for (const data of ['confirmandgetservice', 'Confirmpay_user_17_aB3dE5', 'cart_to_offline']) {
      sent = [];
      await tap(data);
      expectStaleAnswer(data);
    }
    expect((await orderStates())[0]?.['state']).toBe('AWAITING_PAYMENT');
    expect(await commercialCounts()).toEqual(before);

    // The current keyboard still works after the old one was tapped.
    sent = [];
    await tap(`pm:${orderId}`);
    expect(lastMessage()?.body['text']).not.toBe(STALE);
    expect(answers()).toHaveLength(1);
  });

  it('answers a BLOCKED customer with the block message, never the stale menu', async () => {
    await command('/start');
    await api.container.database.db.execute(sql`
      UPDATE customers SET status = 'BLOCKED', blocked_at = now()`);
    const before = await commercialCounts();
    sent = [];
    expect((await tap('confirmandgetservice')).statusCode).toBe(201);
    expect(lastMessage()?.body['text']).toBe(CATALOGUE_FA['bot.blocked']);
    expect(buttonsOf(lastMessage())).toEqual([]);
    expect(answers()).toHaveLength(1);
    expect(await commercialCounts()).toEqual(before);
  });

  it('keeps tenants apart: a legacy tap on tenant B’s bot touches nothing of tenant A’s, and A’s ids mean nothing there', async () => {
    const sellable = await sellableProduct(tenantA, panelA);
    await tap(`p:${sellable.id}`);
    const orderId = String((await orderStates())[0]?.['id']);
    const before = await commercialCounts();

    sent = [];
    expect((await tap('confirmandgetservice', BOT_B)).statusCode).toBe(201);
    expectStaleAnswer('tenant B legacy');

    // Tenant A's own order id, tapped through tenant B's bot: refused without saying it exists.
    sent = [];
    await tap(`c:${orderId}`, BOT_B);
    expect(lastMessage()?.body['text']).toBe(plain(CATALOGUE_FA['bot.order.unavailable']));
    expect((await orderStates())[0]?.['state']).toBe('DRAFT');
    expect(await commercialCounts()).toEqual(before);

    // The tapper became a customer of tenant B only — never resolved into tenant A.
    const rows = await api.container.database.db.execute(
      sql`SELECT tenant_id FROM customers WHERE telegram_user_id = ${String(CUSTOMER)}
          ORDER BY tenant_id`,
    );
    expect(rows.rows.map((row) => (row as { tenant_id: string }).tenant_id).sort()).toEqual(
      [tenantA.tenantId, tenantB.tenantId].sort(),
    );
  });
});
