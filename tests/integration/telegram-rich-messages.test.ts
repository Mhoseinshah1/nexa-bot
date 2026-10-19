import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  TELEGRAM_SECRET_TOKEN_HEADER,
  money,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  makePanelSellable,
  migrateOnce,
  resetDatabase,
  seededCategoryFor,
  tenantA,
  testConfig,
} from './harness';

/**
 * R4 PR-F, end to end: the plan list through the real container, a real socket standing in
 * for Telegram, and the tenant's `rich_messages` flag stored in `feature_flag_states`.
 *
 * - off: `sendMessage` / `editMessageText` with `text`, as before;
 * - on: `editMessageText` with `rich_message` — the table and the buttons inside it — and the
 *   SAME routes; a tap on a rich button is an ordinary callback and goes where it always went;
 * - refused: the same screen once more the ordinary way, and one ERROR row in
 *   `operational_events` under `telegram.rich_message_refused`.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-rich-flow';
const BOT_A = SEED_IDS.botA1;
const CUSTOMER_TELEGRAM_ID = 5551234568;
const CHAT_ID = 4343;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('rich messages over Telegram', () => {
  let api: ApiApp;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let productId: string;

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
        const raw = Buffer.concat(chunks).toString('utf8');
        sent.push({ url: request.url ?? '', body: JSON.parse(raw) as Record<string, unknown> });
        reply(request, response);
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

  const ok = (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
  };

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    reply = ok;
    const panelId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(api.container, tenantA, panelId);
    const products = new DrizzleProductRepository(api.container.database.db);
    const created = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as never,
        categoryId: seededCategoryFor(tenantA) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    productId = created.id;
  });

  const setFlag = (key: string, enabled: boolean) =>
    api.container.database.db.execute(
      sql`INSERT INTO feature_flag_states (id, tenant_id, flag_key, enabled, version)
          VALUES (${randomUUID()}, ${tenantA.tenantId}, ${key}, ${enabled}, 1)`,
    );

  let updateId = 7000;
  const tap = (data: string) => {
    const id = (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        callback_query: {
          id: `cbq-${id}`,
          from: { id: CUSTOMER_TELEGRAM_ID, is_bot: false, first_name: 'Ali' },
          data,
          message: {
            message_id: id,
            date: 0,
            chat: { id: CHAT_ID, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    });
  };

  const screens = () =>
    sent.filter((one) => /\/(sendMessage|sendRichMessage|editMessageText)$/u.test(one.url));
  const routes = (body: unknown): string[] =>
    JSON.stringify(body)
      .match(/"callback_data":"[^"]*"/gu)
      ?.map((one) => one) ?? [];
  const category = () => `ck:${seededCategoryFor(tenantA)}.0`;

  it('off: the plan list is the ordinary edited text, exactly as before', async () => {
    await tap(category());
    const last = screens().at(-1);
    expect(last?.url.endsWith('/editMessageText')).toBe(true);
    expect(last?.body['text']).toBe(CATALOGUE_FA['bot.catalog.heading']);
    expect(last?.body).not.toHaveProperty('rich_message');
  });

  it('on: the plan list is a rich message with its table, and routes exactly as off', async () => {
    await tap(category());
    const off = screens().at(-1);
    sent = [];
    await setFlag('rich_messages', true);
    await tap(category());
    const on = screens().at(-1);
    expect(on?.url.endsWith('/editMessageText')).toBe(true);
    expect(on?.body).not.toHaveProperty('text');
    const blocks = (on?.body['rich_message'] as { blocks: { type: string }[] }).blocks;
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'table', 'buttons', 'buttons']);
    expect(JSON.stringify(blocks)).toContain('پلن پایه');
    expect(routes(on?.body)).toEqual(routes(off?.body));
    expect(routes(on?.body)).toContain(`"callback_data":"p:${productId}"`);

    // The tap on a button INSIDE the rich message is an ordinary callback: the pre-invoice.
    sent = [];
    await tap(`p:${productId}`);
    const next = screens().at(-1);
    expect(next?.url.endsWith('/editMessageText')).toBe(true);
    expect(next?.body).toHaveProperty('rich_message');
  });

  it('refused: the same screen once more the ordinary way, and one ERROR row', async () => {
    await tap(category());
    const ordinary = screens().at(-1);
    sent = [];
    await setFlag('rich_messages', true);
    reply = (request, response) => {
      if ((request.url ?? '').endsWith('/editMessageText') && sent.at(-1)?.body['rich_message']) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: RICH_INVALID' }),
        );
        return;
      }
      ok(request, response);
    };
    await tap(category());
    const edits = screens();
    expect(edits).toHaveLength(2);
    expect(edits[0]?.body).toHaveProperty('rich_message');
    // The same body, but for the message id: each tap here hangs off its own message.
    expect({ ...edits[1]?.body, message_id: 0 }).toEqual({ ...ordinary?.body, message_id: 0 });
    const rows = await api.container.database.db.execute(
      sql`SELECT code, severity FROM operational_events WHERE tenant_id = ${tenantA.tenantId}
          AND code = 'telegram.rich_message_refused'`,
    );
    expect(rows.rows).toEqual([{ code: 'telegram.rich_message_refused', severity: 'ERROR' }]);
  });
});
