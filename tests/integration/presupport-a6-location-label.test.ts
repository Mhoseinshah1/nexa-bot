import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
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
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Pre-support A6: the location a customer is told their service is in.
 *
 * One precedence, for the service card AND the delivery card: where the service was MOVED
 * to; else the operator's label for the initial location of the panel the service is on
 * NOW; else the product's label. A service balanced onto a sibling panel therefore names
 * the sibling's place — before this, it named the home product's.
 *
 * Real PostgreSQL, the real container and bot runtime, and a recording Telegram stand-in;
 * the service rows are written directly, because what is under test is the read, and a
 * balanced placement end to end is `panel-balancing.test.ts`'s.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '961961';
const CARD = 5151;

const HOME_LABEL = 'آلمان — فرانکفورت';
const PEER_LABEL = 'هلند — آمستردام';
const PRODUCT_LABEL = 'مولتی لوکیشن';
const MOVED_LABEL = 'فنلاند — هلسینکی';
const PEER_KEY = 'nl-ams-internal-key';

const systemActor = (label: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: label as CorrelationId,
});

interface Sent {
  readonly method: string;
  readonly raw: string;
}

describe('pre-support A6 — the service location label', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let home: string;
  let peer: string;
  let customerId: UserId;
  let n = 0;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        sent.push({
          method: (request.url ?? '').split('/').at(-1) ?? '',
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 4242 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-a6', roleKeys: ['owner'] }),
    );
    home = await panel('Frankfurt');
    peer = await panel('Amsterdam');
    customerId = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve'), {
        idempotencyKey: `resolve-a6-${CUSTOMER_TG}`,
        telegramUserId: CUSTOMER_TG,
        from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
  });

  async function panel(name: string): Promise<string> {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name,
      providerType: 'marzban',
      baseUrl: `https://${name.toLowerCase()}.example.test`,
      idempotencyKey: `a6-panel-${name}`,
    });
    await makePanelSellable(ctx.container, tenantA, created.view.panel.id);
    return created.view.panel.id;
  }

  async function initialLocation(panelId: string, key: string, label: string): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO service_locations (id, tenant_id, panel_id, product_id, location_key, label,
                                     is_initial, enabled)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${panelId}, NULL, ${key},
              ${label}, true, false)`);
  }

  /** A paid-for service of a product sold on `home`, whose account sits on `onPanel`. */
  async function serviceOn(onPanel: string): Promise<string> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: home as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(1_000n, 'IRT'),
        display: { ...EMPTY_PRODUCT_DISPLAY, serviceLocationLabel: PRODUCT_LABEL },
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = `a6-draft-${String((n += 1))}`;
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: k,
      customerId,
      productId: product.id,
    });
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            subscription_url, traffic_limit_bytes, state, provisioned_at,
                            expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${order.id}, ${onPanel}, ${product.id},
              ${'nx' + id.replace(/-/g, '').slice(0, 8)},
              ${id.replace(/-/g, '').slice(0, 32)},
              ${ctx.container.ids.uuid()},
              ${`https://sub.example.test/sub/${id.replace(/-/g, '')}`},
              53687091200, 'ACTIVE', now(), now() + interval '30 days')`);
    return id;
  }

  /** The service card, drawn into the message the tap came from. */
  async function cardText(serviceId: string): Promise<string> {
    sent = [];
    await ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `a6-update-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: 8000 + (n += 1),
        callback_query: {
          id: `cbq-a6-${String(n)}`,
          from: { id: Number(CUSTOMER_TG), is_bot: false, first_name: 'سارا' },
          data: `s:${serviceId}`,
          message: {
            message_id: CARD,
            date: 0,
            chat: { id: Number(CUSTOMER_TG), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
    });
    const drawn = sent.find((one) => /^(editMessageText|sendMessage)$/u.test(one.method));
    expect(drawn, 'the card was drawn').toBeDefined();
    return String((JSON.parse(drawn?.raw ?? '{}') as { text?: unknown }).text);
  }

  /** The delivery card's text (the photo's caption), through the real delivery lane. */
  async function deliveryCardText(serviceId: string): Promise<string> {
    const services = new DrizzleServiceRepository(ctx.container.database.db);
    const service = await services.findById(tenantA, serviceId as never);
    if (service === null) throw new Error('no service');
    sent = [];
    await ctx.container.delivery.deliver(tenantA, service, CUSTOMER_TG, BOT_A);
    const photo = sent.find((one) => one.method === 'sendPhoto');
    expect(photo, 'the delivery card went out as the QR photo').toBeDefined();
    return /name="caption"\r\n\r\n([\s\S]*?)\r\n--/u.exec(photo?.raw ?? '')?.[1] ?? '';
  }

  it("names the sibling panel's location for a service balanced onto it, on both cards", async () => {
    await initialLocation(home, 'de-fra', HOME_LABEL);
    await initialLocation(peer, PEER_KEY, PEER_LABEL);
    const serviceId = await serviceOn(peer);

    for (const text of [await cardText(serviceId), await deliveryCardText(serviceId)]) {
      expect(text).toContain(PEER_LABEL);
      expect(text, "not the home panel's place").not.toContain(HOME_LABEL);
      expect(text, "not the product's label").not.toContain(PRODUCT_LABEL);
    }
  });

  it('names where a moved service was moved to, over its panel and its product', async () => {
    await initialLocation(peer, PEER_KEY, PEER_LABEL);
    const serviceId = await serviceOn(peer);
    await ctx.container.database.db.execute(sql`
      UPDATE services SET location_key = 'fi-hel', location_label = ${MOVED_LABEL}
       WHERE id = ${serviceId}`);

    for (const text of [await cardText(serviceId), await deliveryCardText(serviceId)]) {
      expect(text).toContain(MOVED_LABEL);
      expect(text).not.toContain(PEER_LABEL);
      expect(text).not.toContain(PRODUCT_LABEL);
    }
  });

  it("falls back to the product's label when the panel has no initial location", async () => {
    const serviceId = await serviceOn(peer);
    for (const text of [await cardText(serviceId), await deliveryCardText(serviceId)]) {
      expect(text).toContain(PRODUCT_LABEL);
    }
  });

  it('never shows an internal panel or provider identifier', async () => {
    await initialLocation(peer, PEER_KEY, PEER_LABEL);
    const serviceId = await serviceOn(peer);
    for (const text of [await cardText(serviceId), await deliveryCardText(serviceId)]) {
      for (const internal of [peer, home, PEER_KEY, 'Amsterdam', 'amsterdam.example.test']) {
        expect(text, internal).not.toContain(internal);
      }
    }
  });
});
