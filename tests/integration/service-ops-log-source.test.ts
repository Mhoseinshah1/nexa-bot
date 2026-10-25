import { createHmac, randomUUID } from 'node:crypto';
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
  miniAppServiceOfferSchema,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { EventConsumer } from '../../apps/api/src/modules/platform/eventing/application/event-consumer';
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

/**
 * Hotfix v0.8.2-e — every service log reaches the operations group exactly once, with its source.
 *
 * The owner's report: a wallet purchase posted its payment log («✅ پرداخت سفارش تأیید شد · روش:
 * کیف پول») and the service was delivered, but no «🛒 خرید جدید» (L11) reached «سفارش‌ها و
 * سرویس‌ها». The test server was migrated from the previous bot by the one-click `.nxpkg`
 * import, which marks every customer it wrote `source = 'MIRZA'`; `ServiceLogConsumer` and
 * `OperationLog` refused any customer (and service) not `NEXA`, so every purchase, renewal,
 * extra traffic, extra time, trial and link change of a migrated customer was silent. The
 * payment log reads only the PAYMENT's provenance, so it still arrived.
 *
 * Everything here goes through what the customer actually uses — the bot's own taps through
 * `BotRuntime.handle`, the Mini App over real HTTP — then the real provisioner against a
 * RickPanel on a socket, the real relay and the real dispatcher, and reads the text the
 * operations chat RECEIVED.
 *
 * MUTATIONS (each applied, the named tests red, reverted, green):
 *  - `ServiceLogConsumer.handle`: `if (customer === null || customer.source !== 'NEXA') return;`
 *    put back -> "a 'bot' / 'miniapp' wallet purchase (imported customer: true) ..." (no
 *    «خرید جدید» at all) and "every service action ...: 'bot' 'LINK' / 'bot' 'TRIAL' /
 *    'miniapp' 'TRIAL'".
 *  - `OperationLog.operationSucceeded`: `service.source !== 'NEXA'` put back, and separately
 *    `customer.source !== 'NEXA'` -> "every service action ...: 'bot' / 'miniapp' 'RENEW',
 *    'ADD_TRAFFIC', 'ADD_TIME'".
 *  - the services log's dedupe key made unique per handling -> every "wallet purchase" case
 *    («a redelivery posts nothing»).
 *  - `serviceCreated`: the first-purchase line set unconditionally -> every "wallet purchase"
 *    case (its second purchase).
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const OPS_CHAT = '-1001234567890';
const GIB = 1024n ** 3n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** Telegram's own signer, independently of the verifier the API runs. */
function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${randomUUID().slice(0, 8)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** The headline each log type's message opens with (`packages/i18n/src/ops-log.fa.ts`). */
const HEADLINE = {
  created: '🛒 خرید جدید',
  renewed: '🔄 تمدید سرویس',
  traffic: '➕ حجم اضافه',
  time: '⏳ زمان اضافه',
  link: '🔁 تغییر لینک سرویس',
  trial: '🧪 اکانت تست',
} as const;
const SOURCE = { bot: '📲 منبع: ربات', miniapp: '📲 منبع: مینی‌اپ' } as const;
const FIRST_PURCHASE = '🥇 خرید اول کاربر: بله';

describe('hotfix v0.8.2-e: one service log per purchase and per service action, with its source', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel | undefined;
  let panelId: string;
  let productId: ProductId;
  let owner: ActorContext;
  let seq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-hf-e-dist-'));
  const key = () => `hf-e-key-${String((seq += 1)).padStart(6, '0')}-abcdef`;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { multipart: raw.length };
        }
        sent.push({ url: request.url ?? '', body });
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
    telegram.closeAllConnections();
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
    sent = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'hf-e-owner', roleKeys: ['owner'] }),
    );
    for (const flag of ['mini_app', 'ops_notifications', 'customer_link_rotation']) {
      const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: flag as never,
        enabled: true,
        expectedVersion: current.version,
        idempotencyKey: key(),
        confirmKey: flag,
        reason: 'hotfix v0.8.2-e integration test',
      });
    }
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.telegram_chat_id',
      value: OPS_CHAT,
      expectedVersion: null,
      idempotencyKey: key(),
    });

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: key(),
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
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
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;
  });

  // --- the pipeline after a customer's tap ------------------------------------------------

  /**
   * The provisioner, the relay and the dispatcher, until nothing is left to do.
   *
   * The dispatcher's courtesy ceiling to Telegram is a per-minute window kept in the process
   * (`remainingBudget`), shared by every test in this file; it is reopened before each pass so
   * a message is never left PENDING by the test's own pace rather than by the code under test.
   */
  async function settle(): Promise<void> {
    const dispatcher = ctx.container.notificationDispatcher as unknown as {
      windowStartedAt: number;
    };
    for (let round = 0; round < 3; round += 1) {
      dispatcher.windowStartedAt = 0;
      await ctx.container.provisionerLoop.tick();
      for (let batch = 0; batch < 50; batch += 1) {
        if ((await ctx.container.relay.processBatch()).claimed === 0) break;
      }
      await ctx.container.notificationDispatcher.tick();
    }
  }

  /** Every message the operations chat received, as Telegram was handed it. */
  const opsTexts = (): string[] =>
    sent
      .filter((one) => one.url.endsWith('/sendMessage') && String(one.body['chat_id']) === OPS_CHAT)
      .map((one) => String(one.body['text'] ?? ''));

  /** The messages opening with `headline` that reached the operations chat after `from`. */
  const logsSince = (from: number, headline: string): string[] =>
    opsTexts()
      .slice(from)
      .filter((text) => text.startsWith(headline));

  /** As the one-click `.nxpkg` import leaves a customer: `source = 'MIRZA'` with its Mirza id. */
  async function markImported(customerId: UserId): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET source = 'MIRZA', source_ref = ${`user:${customerId}`}
           WHERE id = ${customerId}`,
    );
  }

  const credit = (customerId: UserId, amountMinor = 2_000_000n) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
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

  const latestOrder = async (customerId: UserId, purpose: string): Promise<string> => {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM orders WHERE customer_id = ${customerId} AND purpose = ${purpose}
           ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error(`no ${purpose} order`);
    return id;
  };

  // --- the bot ------------------------------------------------------------------------------

  let updateSeq = 0;
  const update = (telegramUserId: number, payload: Record<string, unknown>) => {
    updateSeq += 1;
    return {
      idempotencyKey: `hf-e-update-${String(updateSeq)}`,
      botInstanceId: BOT_A1,
      update: { update_id: updateSeq, ...payload },
      telegramUserId: String(telegramUserId),
      from: { id: telegramUserId, first_name: 'مشتری' },
    };
  };
  const botTap = (telegramUserId: number, data: string) =>
    ctx.container.botRuntime.handle(
      tenantA,
      systemActor('hf-e-bot'),
      update(telegramUserId, {
        callback_query: {
          id: `cbq-${String(updateSeq + 1)}`,
          from: { id: telegramUserId, is_bot: false, first_name: 'مشتری' },
          data,
          message: {
            message_id: updateSeq + 1,
            date: 0,
            chat: { id: telegramUserId, type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      }),
    );
  const botText = (telegramUserId: number, text: string) =>
    ctx.container.botRuntime.handle(
      tenantA,
      systemActor('hf-e-bot'),
      update(telegramUserId, {
        message: {
          message_id: updateSeq + 1,
          date: 0,
          chat: { id: telegramUserId, type: 'private' },
          from: { id: telegramUserId, is_bot: false, first_name: 'مشتری' },
          text,
        },
      }),
    );
  /**
   * The `callback_data` of the first button on the bot's last screen whose data starts with
   * `prefix` — or, with `byLabel`, whose LABEL does (a renewal's data is a compact token).
   */
  const botButton = (prefix: string, byLabel = false): string => {
    const drawn = sent.filter(
      (one) => one.url.endsWith('/sendMessage') || one.url.endsWith('/editMessageText'),
    );
    const markup = drawn.at(-1)?.body['reply_markup'] as
      { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
    const found = (markup?.inline_keyboard ?? [])
      .flat()
      .find((button) => (byLabel ? button.text : (button.callback_data ?? '')).startsWith(prefix));
    if (found?.callback_data === undefined) {
      throw new Error(
        `no ${prefix} button on the bot's last screen: ${JSON.stringify(drawn.at(-1)?.body)}`,
      );
    }
    return found.callback_data;
  };

  async function botCustomer(telegramUserId: number, imported: boolean): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${String(telegramUserId)}`),
      {
        idempotencyKey: `hf-e-resolve-${String(telegramUserId)}`,
        telegramUserId: String(telegramUserId),
        from: { id: telegramUserId, first_name: 'مشتری' },
        botInstanceId: BOT_A1,
      },
    );
    if (imported) await markImported(resolved.customer.id);
    await credit(resolved.customer.id);
    return resolved.customer.id;
  }

  /** «خرید» -> the product -> «💰 پرداخت از کیف پول»: the bot's two taps. */
  async function botBuy(telegramUserId: number, customerId: UserId): Promise<string> {
    await botTap(telegramUserId, `p:${productId}`);
    const orderId = await latestOrder(customerId, 'NEW_SERVICE');
    await botTap(telegramUserId, `w:${orderId}`);
    return orderId;
  }

  // --- the Mini App -----------------------------------------------------------------------

  const call = (
    token: string,
    method: 'GET' | 'POST',
    route: string,
    params: Record<string, string> = {},
    payload?: unknown,
  ) =>
    inject({
      method,
      url: `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  async function miniCustomer(
    telegramUserId: number,
    imported: boolean,
  ): Promise<{ token: string; customerId: UserId }> {
    const minted = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const customerId = await customerIdOf(telegramUserId);
    if (imported) await markImported(customerId);
    await credit(customerId);
    return { token: (JSON.parse(minted.body) as { token: string }).token, customerId };
  }

  /** The Mini App's order sheet: a draft for the product, then «پرداخت از کیف پول». */
  async function miniBuy(token: string): Promise<string> {
    const created = await call(token, 'POST', MINIAPP_ROUTES.orders, {}, { productId });
    expect(created.statusCode, created.body).toBe(201);
    const draft = miniAppOrderSchema.parse(JSON.parse(created.body));
    const paid = await call(token, 'POST', MINIAPP_ROUTES.orderPayWallet, { orderId: draft.id });
    expect(paid.statusCode, paid.body).toBe(201);
    return draft.id;
  }

  // --- the purchase: L11, once, with its source and the first-purchase line ---------------

  /** The rows the lane wrote for a service-created log of this order — the delivery's input. */
  const createdRowsOf = async (orderCode: string) =>
    (
      await ctx.container.database.db.execute<{ dedupe_key: string; status: string }>(
        sql`SELECT dedupe_key, status FROM notifications
             WHERE tenant_id = ${tenantA.tenantId}
               AND template_key IN ('ops.log.service_created', 'ops.log.service_created_wallet')
               AND payload ->> 'orderCode' = ${orderCode}`,
      )
    ).rows;
  const codeOf = async (orderId: string): Promise<string> => {
    const rows = await ctx.container.database.db.execute<{ code: string }>(
      sql`SELECT code FROM orders WHERE id = ${orderId}`,
    );
    return rows.rows[0]!.code;
  };

  /**
   * `ServiceProvisioned` handled AGAIN — what a relay redelivery past a lost claim does —
   * then a second provisioner, relay and dispatcher pass: neither may post the purchase twice
   * (the event is written once per create, and the lane's dedupe key is the event's).
   */
  async function redeliverServiceProvisioned(orderId: string): Promise<void> {
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      orderId as never,
    );
    const rows = await ctx.container.database.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM outbox_messages
           WHERE event_type = 'ServiceProvisioned' AND aggregate_id = ${service!.id}`,
    );
    expect(rows.rows, 'one ServiceProvisioned per create').toHaveLength(1);
    const row = rows.rows[0]!;
    const event: DomainEvent = {
      eventId: String(row['id']),
      eventType: String(row['event_type']),
      eventVersion: Number(row['event_version']),
      tenantId: String(row['tenant_id']),
      aggregateType: String(row['aggregate_type']),
      aggregateId: String(row['aggregate_id']),
      sequence: Number(row['sequence']),
      correlationId: String(row['correlation_id']),
      causationId: null,
      actor: row['actor'] as DomainEvent['actor'],
      occurredAt: new Date(String(row['occurred_at'])).toISOString(),
      payload: row['payload'],
    };
    const consumer = (
      ctx.container.relay as unknown as {
        consumers: { name: string; handle: EventConsumer['handle'] }[];
      }
    ).consumers.find((one) => one.name === 'ops-log.services');
    await ctx.container.database.db.transaction((tx) =>
      consumer!.handle(event, { tx, scope: tenantA } as never),
    );
    await settle();
  }

  const PURCHASES = [
    { surface: 'bot', imported: true, tg: 960_101 },
    { surface: 'bot', imported: false, tg: 960_102 },
    { surface: 'miniapp', imported: true, tg: 960_103 },
    { surface: 'miniapp', imported: false, tg: 960_104 },
  ] as const;

  it.each(PURCHASES)(
    'a $surface wallet purchase (imported customer: $imported) posts exactly one «خرید جدید» with its source, «خرید اول کاربر» on the first only',
    async ({ surface, imported, tg }) => {
      let buy: () => Promise<string>;
      if (surface === 'bot') {
        const customerId = await botCustomer(tg, imported);
        buy = () => botBuy(tg, customerId);
      } else {
        const { token } = await miniCustomer(tg, imported);
        buy = () => miniBuy(token);
      }

      // The first purchase.
      let from = opsTexts().length;
      const first = await buy();
      await settle();
      const firstLogs = logsSince(from, HEADLINE.created);
      expect(firstLogs, 'exactly one «خرید جدید» for the first purchase').toHaveLength(1);
      expect(firstLogs[0]).toContain(SOURCE[surface]);
      expect(firstLogs[0]).not.toContain(SOURCE[surface === 'bot' ? 'miniapp' : 'bot']);
      expect(firstLogs[0]).toContain(FIRST_PURCHASE);
      // L11: the wallet's own line, the order's code.
      expect(firstLogs[0]).toContain('👛 کیف پول:');
      const firstCode = await codeOf(first);
      expect(firstLogs[0]).toContain(firstCode);

      // Retried: a second provisioner pass and a redelivered event post nothing new.
      from = opsTexts().length;
      await redeliverServiceProvisioned(first);
      expect(logsSince(from, HEADLINE.created), 'a redelivery posts nothing').toEqual([]);
      expect(await createdRowsOf(firstCode)).toHaveLength(1);

      // The second purchase: logged, and not as a first one.
      from = opsTexts().length;
      const second = await buy();
      await settle();
      const secondLogs = logsSince(from, HEADLINE.created);
      expect(secondLogs, 'exactly one «خرید جدید» for the second purchase').toHaveLength(1);
      expect(secondLogs[0]).toContain(SOURCE[surface]);
      expect(secondLogs[0]).toContain(await codeOf(second));
      expect(secondLogs[0]).not.toContain('خرید اول کاربر');
    },
    60_000,
  );

  // --- every other service log, from each surface that offers the action -----------------

  /** An ACTIVE extra package of the kind. */
  async function addon(kind: 'ADD_TRAFFIC' | 'ADD_TIME'): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: key(),
      draft: {
        kind,
        title: kind === 'ADD_TRAFFIC' ? '۱۰ گیگابایت' : '۳۰ روز',
        sortOrder: 10,
        specification: {
          kind,
          trafficBytes: kind === 'ADD_TRAFFIC' ? 10n * GIB : null,
          durationDays: kind === 'ADD_TIME' ? 30 : null,
        } as never,
        price: money(80_000n, 'IRT'),
        panelId: null,
        productId: null,
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: key(),
      addonId: created.id,
    });
    return created.id;
  }

  async function offerTrial(): Promise<void> {
    const current = await ctx.container.panelTrials.get(tenantA, owner, panelId);
    await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 72,
      label: 'تست رایگان',
    });
  }

  /**
   * The owner's case for an existing service: an imported customer holding a service the
   * import adopted (`source = 'MIRZA'` on both), bought through the service lane and then
   * marked as the import marks an adopted one.
   */
  async function importedService(customerId: UserId): Promise<string> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('hf-e-fixture'), {
      idempotencyKey: key(),
      customerId,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('hf-e-fixture'), {
      idempotencyKey: key(),
      customerId,
      orderId: draft.id,
    });
    await ctx.container.payments.settleFromWallet(
      tenantA,
      systemActor('hf-e-fixture'),
      customerId,
      {
        idempotencyKey: key(),
        orderId: confirmed.id,
      },
    );
    await settle();
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      confirmed.id,
    );
    expect(service?.state, 'the fixture service must be ACTIVE').toBe('ACTIVE');
    await ctx.container.database.db.execute(
      sql`UPDATE services SET source = 'MIRZA', source_ref = ${`service:${service!.id}`}
           WHERE id = ${service!.id}`,
    );
    return service!.id;
  }

  type Action = 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'LINK' | 'TRIAL';
  const ACTIONS: readonly {
    readonly surface: 'bot' | 'miniapp';
    readonly action: Action;
    readonly headline: string;
    /** Whether the owner's reviewed template prints a source line (R9 C2 item 6). */
    readonly sourced: boolean;
  }[] = [
    { surface: 'bot', action: 'RENEW', headline: HEADLINE.renewed, sourced: true },
    { surface: 'bot', action: 'ADD_TRAFFIC', headline: HEADLINE.traffic, sourced: true },
    { surface: 'bot', action: 'ADD_TIME', headline: HEADLINE.time, sourced: true },
    { surface: 'bot', action: 'LINK', headline: HEADLINE.link, sourced: false },
    { surface: 'bot', action: 'TRIAL', headline: HEADLINE.trial, sourced: false },
    { surface: 'miniapp', action: 'RENEW', headline: HEADLINE.renewed, sourced: true },
    { surface: 'miniapp', action: 'ADD_TRAFFIC', headline: HEADLINE.traffic, sourced: true },
    { surface: 'miniapp', action: 'ADD_TIME', headline: HEADLINE.time, sourced: true },
    // The Mini App offers no link change (`MINIAPP_SERVICE_ACTIONS`); its trial is a claim.
    { surface: 'miniapp', action: 'TRIAL', headline: HEADLINE.trial, sourced: false },
  ];

  it.each(ACTIONS)(
    'every service action of an imported customer posts exactly one log: $surface $action',
    async ({ surface, action, headline, sourced }) => {
      const tg =
        961_000 + ACTIONS.findIndex((one) => one.surface === surface && one.action === action);
      if (action === 'ADD_TRAFFIC' || action === 'ADD_TIME') await addon(action);
      if (action === 'TRIAL') await offerTrial();

      let from: number;
      if (surface === 'bot') {
        const customerId = await botCustomer(tg, true);
        if (action === 'TRIAL') {
          from = opsTexts().length;
          await botText(tg, '/trial');
        } else {
          const serviceId = await importedService(customerId);
          from = opsTexts().length;
          if (action === 'LINK') {
            await botTap(tg, `rc:${serviceId}`);
            await botTap(tg, `rd:${serviceId}`);
          } else {
            if (action === 'RENEW') {
              await botTap(tg, `n:${serviceId}`);
              await botTap(tg, botButton('🔄', true));
            }
            if (action === 'ADD_TRAFFIC') {
              await botTap(tg, `v:${serviceId}`);
              await botTap(tg, botButton('a:'));
            }
            if (action === 'ADD_TIME') {
              await botTap(tg, `h:${serviceId}`);
              await botTap(tg, botButton('b:'));
            }
            await botTap(tg, `w:${await latestOrder(customerId, action)}`);
          }
        }
      } else {
        const { token, customerId } = await miniCustomer(tg, true);
        if (action === 'TRIAL') {
          from = opsTexts().length;
          const claimed = await call(token, 'POST', MINIAPP_ROUTES.trial, {}, { panelId: null });
          expect(claimed.statusCode, claimed.body).toBe(201);
        } else {
          const serviceId = await importedService(customerId);
          from = opsTexts().length;
          const offer = miniAppServiceOfferSchema.parse(
            JSON.parse(
              (await call(token, 'GET', MINIAPP_ROUTES.serviceOffer, { serviceId, kind: action }))
                .body,
            ),
          );
          const option = offer.options[0];
          expect(option, `the Mini App offers a ${action}`).toBeDefined();
          const quote = await call(
            token,
            'POST',
            MINIAPP_ROUTES.serviceQuote,
            { serviceId },
            { kind: action, addonId: option!.addonId, planId: option!.planId },
          );
          expect(quote.statusCode, quote.body).toBe(201);
          const order = miniAppOrderSchema.parse(JSON.parse(quote.body));
          const paid = await call(token, 'POST', MINIAPP_ROUTES.orderPayWallet, {
            orderId: order.id,
          });
          expect(paid.statusCode, paid.body).toBe(201);
        }
      }
      await settle();

      const logs = logsSince(from, headline);
      expect(logs, `exactly one «${headline}»`).toHaveLength(1);
      if (sourced) {
        expect(logs[0]).toContain(SOURCE[surface]);
        expect(logs[0]).not.toContain(SOURCE[surface === 'bot' ? 'miniapp' : 'bot']);
      }
      // A service action is never also posted as a new purchase.
      expect(logsSince(from, HEADLINE.created)).toEqual([]);

      // A second relay and provisioner pass post nothing new.
      const after = opsTexts().length;
      await settle();
      expect(logsSince(after, headline)).toEqual([]);
    },
    60_000,
  );
});
