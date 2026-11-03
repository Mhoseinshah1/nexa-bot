import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  PANEL_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import {
  BRIDGE_SECRET,
  bridgeTls,
  startFakeCustomBridge,
  type FakeCustomBridge,
} from '../support/fake-custom-bridge';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * v0.9.5 PR-3: connection files from a CUSTOM bridge (protocol v1.1), end to end.
 *
 * The shipped container and bot runtime, the real `CustomPanelAdapter` over the real
 * `SafeHttpClient`, against the fake bridge over HTTPS — and nothing else new: the files
 * reach the customer through the SAME `SubscriptionFileService` RickPanel's do, so «فقط
 * فایل», «دریافت فایل‌های جدید» and the files after a delivery work unchanged. What is new
 * is the per-panel gate: the bridge's latest health check must have announced `files`.
 * Every case has its control: the same bridge without the capability is never asked.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '930941';
const OTHER_TG = '930942';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('custom bridge connection files (protocol v1.1)', () => {
  const tls = bridgeTls();
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let bridge: FakeCustomBridge;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let owner: ActorContext;
  let customerId: UserId;
  let otherId: UserId;
  let panelId: string;
  let updateSeq = 0;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      PANEL_HTTP_CA_FILE: tls.caFile,
      // The configuration's ceiling, so a file just over the 5 MiB bound reaches the
      // adapter's own refusal instead of the response cap (default 512 KiB).
      PANEL_HTTP_MAX_RESPONSE_BYTES: String(8 * 1024 * 1024),
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await bridge?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    sent = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-cf', roleKeys: ['owner'] }),
    );
    for (const [tg, name] of [
      [CUSTOMER_TG, 'سارا'],
      [OTHER_TG, 'نیما'],
    ] as const) {
      const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor(tg), {
        idempotencyKey: `resolve-${tg}`,
        telegramUserId: tg,
        from: { id: Number(tg), first_name: name },
        botInstanceId: BOT_A,
      });
      if (tg === CUSTOMER_TG) customerId = resolved.customer.id;
      else otherId = resolved.customer.id;
    }
  });

  /** A custom panel on a fresh bridge, passed through the REAL connection test. */
  async function bridgePanel(files: boolean): Promise<void> {
    // 127.0.0.2: the container's URL policy denies the host its own data services use.
    bridge = await startFakeCustomBridge({ host: '127.0.0.2', tls, files });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Bridge',
      providerType: 'custom',
      baseUrl: bridge.baseUrl,
      credentials: { apiToken: BRIDGE_SECRET },
      activation: {},
      idempotencyKey: randomUUID(),
    });
    panelId = created.view.panel.id;
    await testConnection();
  }

  const testConnection = async () => {
    // A re-test inside the per-panel probe cooldown is refused; the cooldown is not what
    // these cases are about.
    await ctx.container.database.db.execute(sql`DELETE FROM panel_probe_claims`);
    const tested = await ctx.container.panels.testConnection(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
    });
    expect(tested.probed).toBe(true);
  };

  const announced = async () =>
    (await ctx.container.panels.get(tenantA, owner, panelId)).health?.announcedCapabilities;

  const filesOnly = (enabled: boolean) =>
    ctx.container.panels.update(tenantA, owner, panelId, {
      filesOnlyDelivery: enabled,
      idempotencyKey: randomUUID(),
    });

  async function enableRotation(): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_link_rotation',
      enabled: true,
      expectedVersion: null,
      confirmKey: 'customer_link_rotation',
      reason: 'let customers replace a leaked link',
      idempotencyKey: randomUUID(),
    });
  }

  async function paidOrder(key: string, who: UserId): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پل',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: who,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: who,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, who, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), who, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  async function deliveredService(key: string, who: UserId = customerId): Promise<ServiceRecord> {
    const orderId = await paidOrder(key, who);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    expect(service.deliveryState).toBe('DELIVERED');
    return service;
  }

  const reload = async (id: string): Promise<ServiceRecord> => {
    const found = await services.findById(tenantA, id as never);
    if (found === null) throw new Error('service vanished');
    return found;
  };

  const tap = (data: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `cf-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    });
  };

  const raw = (one: (typeof sent)[number]) => JSON.stringify(one.body);
  const textOf = (one: (typeof sent)[number]) =>
    String(one.body['text'] ?? one.body['caption'] ?? one.body['unparseable'] ?? '');
  const posts = (suffix: string) => sent.filter((one) => one.url.endsWith(suffix));
  const documents = () => posts('/sendDocument');
  /** Every message that is text or a caption: the places a link could be written. */
  const customerText = () =>
    sent
      .filter((one) => !one.url.endsWith('/sendMediaGroup') && !one.url.endsWith('/sendDocument'))
      .map(raw)
      .join('\n');
  const filesRequests = () =>
    bridge.requests.filter((one) => one.verified && one.route === 'files').map((one) => one.path);

  // =========================================================================
  // The capability, stored from the health check
  // =========================================================================

  it('stores what the latest health check announced, and drops it when a later one does not', async () => {
    await bridgePanel(true);
    expect(await announced()).toEqual(['SUBSCRIPTION_FILES']);
    bridge.setFilesSupported(false);
    await testConnection();
    expect(await announced()).toEqual([]);
  });

  it('control: a v1.0 bridge announces nothing and is healthy exactly as before', async () => {
    await bridgePanel(false);
    expect(await announced()).toEqual([]);
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.health?.state).toBe('HEALTHY');
  });

  // =========================================================================
  // «فقط فایل», end to end
  // =========================================================================

  it('files only: the card with NO link, then the service’s OWN file, fetched by its own username', async () => {
    await bridgePanel(true);
    await filesOnly(true);
    const service = await deliveredService('fo');
    const url = service.subscriptionUrl ?? '-';
    expect(url).not.toBe('-');
    expect(customerText()).not.toContain(url);
    expect(posts('/sendPhoto'), 'no QR of a link nobody is shown').toHaveLength(0);
    const card = posts('/sendMessage').find((one) =>
      textOf(one).includes('سرویس با موفقیت ایجاد شد'),
    );
    expect(card, 'the delivery card was sent').toBeDefined();
    expect(textOf(card!)).toContain(service.providerUsername);
    expect(textOf(card!)).toContain('فایل‌های اتصال شما در پیام‌های بعدی ارسال می‌شود');

    // One file, so one document (an album needs two), after the card.
    expect(documents()).toHaveLength(1);
    const document = textOf(documents()[0]!);
    const own = bridge.defaultFile(service.providerUsername);
    expect(document).toContain(own.name);
    expect(document).toContain(own.bytes.toString('utf8'));
    expect(sent.indexOf(card!)).toBeLessThan(sent.indexOf(documents()[0]!));
    expect(filesRequests()).toEqual([`/v1/accounts/${service.providerUsername}/files`]);
  });

  it('control: a bridge WITHOUT `files` cannot be set to files only, and is never asked for files', async () => {
    await bridgePanel(false);
    await expect(filesOnly(true)).rejects.toMatchObject({
      code: PANEL_ERROR_CODES.PANEL_FILES_ONLY_UNSUPPORTED,
    });
    const service = await deliveredService('nofiles');
    expect(customerText()).toContain(service.subscriptionUrl ?? '-');
    expect(documents()).toHaveLength(0);
    expect(posts('/sendMediaGroup')).toHaveLength(0);
    expect(bridge.count('files')).toBe(0);
    expect(await ctx.container.subscriptionFiles.offered(tenantA, service)).toBe(false);
  });

  it('link + files: the link card, then the files; the files button is offered', async () => {
    await bridgePanel(true);
    const service = await deliveredService('both');
    expect(customerText()).toContain(service.subscriptionUrl ?? '-');
    expect(documents()).toHaveLength(1);
    expect(await ctx.container.subscriptionFiles.offered(tenantA, service)).toBe(true);
  });

  it('a lost announcement stops every fetch at once: no files after a delivery, no button', async () => {
    await bridgePanel(true);
    bridge.setFilesSupported(false);
    await testConnection();
    const service = await deliveredService('lost');
    expect(documents()).toHaveLength(0);
    expect(bridge.count('files')).toBe(0);
    expect(await ctx.container.subscriptionFiles.offered(tenantA, service)).toBe(false);
  });

  it('a refused file (too big, or of an unlisted type) is not sent; the others are', async () => {
    await bridgePanel(true);
    const service = await deliveredService('refused');
    const ok = Buffer.from('{"ok":true}', 'utf8').toString('base64');
    const mixed = [
      {
        name: 'big.json',
        contentType: 'application/json',
        contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      },
      { name: 'page.html', contentType: 'text/html', contentBase64: ok },
      { name: 'one.json', contentType: 'application/json', contentBase64: ok },
      { name: 'two.yaml', contentType: 'text/yaml', contentBase64: ok },
    ];
    // The name is the provisioner's choice, so the mixed list is planted after delivery
    // and asked for by the customer's tap.
    bridge.setFiles(service.providerUsername, mixed);
    sent = [];
    const result = await ctx.container.subscriptionFiles.send(tenantA, systemActor('tap'), {
      customerId,
      serviceId: service.id,
      chatId: CUSTOMER_TG,
      botInstanceId: BOT_A,
    });
    expect(result).toEqual({ outcome: 'SENT', sent: 2, failed: 2 });
    const album = JSON.stringify(posts('/sendMediaGroup'));
    expect(album).toContain('one.json');
    expect(album).toContain('two.yaml');
    expect(album).not.toContain('big.json');
    expect(album).not.toContain('page.html');
  });

  it('one customer never receives another’s files: each service’s own name, own bytes', async () => {
    await bridgePanel(true);
    const mine = await deliveredService('mine', customerId);
    const theirs = await deliveredService('theirs', otherId);
    sent = [];
    const result = await ctx.container.subscriptionFiles.send(tenantA, systemActor('tap'), {
      customerId,
      serviceId: mine.id,
      chatId: CUSTOMER_TG,
      botInstanceId: BOT_A,
    });
    expect(result).toEqual({ outcome: 'SENT', sent: 1, failed: 0 });
    const delivered = JSON.stringify(sent);
    expect(delivered).toContain(bridge.defaultFile(mine.providerUsername).name);
    expect(delivered).not.toContain(theirs.providerUsername);
    // And asking for someone else's service is refused before any panel is asked.
    const before = bridge.count('files');
    expect(
      await ctx.container.subscriptionFiles.send(tenantA, systemActor('tap'), {
        customerId,
        serviceId: theirs.id,
        chatId: CUSTOMER_TG,
        botInstanceId: BOT_A,
      }),
    ).toEqual({ outcome: 'NOT_FOUND' });
    expect(bridge.count('files')).toBe(before);
  });

  // =========================================================================
  // «دریافت فایل‌های جدید»
  // =========================================================================

  it('«دریافت فایل‌های جدید»: rotates through the bridge and sends the new files, never a link', async () => {
    await enableRotation();
    await bridgePanel(true);
    await filesOnly(true);
    const service = await deliveredService('rotate');
    const oldUrl = service.subscriptionUrl ?? '-';

    sent = [];
    const asked = await tap(`rc:${service.id}`);
    expect(asked.intent).toBe('SERVICE_ROTATE_ASK');
    await tap(`rd:${service.id}`);
    sent = [];
    const before = bridge.count('files');
    await ctx.container.provisionerLoop.tick();
    const after = await reload(service.id);
    expect(after.subscriptionUrl, 'the bridge really rotated').not.toBe(oldUrl);
    expect(bridge.count('rotate')).toBe(1);
    expect(customerText()).not.toContain(after.subscriptionUrl ?? '-');
    expect(customerText()).not.toContain(oldUrl);
    const answer = sent.find((one) => textOf(one).includes('با موفقیت تغییر کرد'));
    expect(answer, 'the card is answered').toBeDefined();
    expect(textOf(answer!)).toContain(`فایل‌های اتصال سرویس ${service.providerUsername}`);
    expect(documents(), 'the new files follow').toHaveLength(1);
    expect(sent.indexOf(answer!)).toBeLessThan(sent.indexOf(documents()[0]!));
    expect(bridge.count('files')).toBe(before + 1);
  });
});
