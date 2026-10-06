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
  type DeliveryTutorialMode,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleDeliveryTutorialRepository } from '../../apps/api/src/modules/control/client-apps/infrastructure/drizzle-delivery-tutorial.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Phase 2 item 5, against real everything: the operator's per-panel editor (revision,
 * audit, tenant isolation, the table's CHECKs), and the tutorial the delivery sweep sends
 * after a paid or a trial service on that panel was delivered — once, after the link, and
 * never again for the same service, whatever re-arms its delivery.
 *
 * A real PostgreSQL, the real provisioner and delivery sweep, a fake RickPanel on a socket,
 * and a socket standing in for Telegram.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const TEXT =
  'کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است. لطفاً حتماً از آخرین نسخه برنامه استفاده کنید.';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a panel’s tutorial after delivery', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let services: DrizzleServiceRepository;
  let products: DrizzleProductRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;
  let ownerId: string;

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
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    products = new DrizzleProductRepository(ctx.container.database.db);
    sent = [];
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    const admin = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tutorial',
      roleKeys: ['owner'],
    });
    ownerId = admin.id;
    owner = adminActorFor(admin);
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-tutorial',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-tutorial',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  async function configure(
    input: {
      readonly mode?: DeliveryTutorialMode;
      readonly text?: string | null;
      readonly videoClientAppId?: string | null;
      readonly appliesToPurchase?: boolean;
      readonly appliesToTrial?: boolean;
    } = {},
  ) {
    const current = await ctx.container.deliveryTutorials.get(tenantA, owner, panelId);
    return ctx.container.deliveryTutorials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.tutorial.revision,
      mode: input.mode ?? 'TEXT',
      text: input.text === undefined ? TEXT : input.text,
      videoClientAppId: input.videoClientAppId ?? null,
      appliesToPurchase: input.appliesToPurchase ?? true,
      appliesToTrial: input.appliesToTrial ?? true,
    });
  }

  async function paidOrder(key: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
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
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  async function trial(key: string): Promise<string> {
    const current = await ctx.container.panelTrials.get(tenantA, owner, panelId);
    await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 72,
      label: null,
    });
    const issued = await ctx.container.trials.claim(tenantA, systemActor(key), customerId, {
      idempotencyKey: key,
      panelId,
    });
    if (issued.outcome !== 'ISSUED') throw new Error(`trial refused: ${JSON.stringify(issued)}`);
    return issued.serviceId;
  }

  /** The tutorial messages Telegram was asked for: text, or a video captioned with it. */
  const tutorialTexts = () =>
    sent.filter((one) => one.url.endsWith('/sendMessage') && one.body['text'] === TEXT);
  const tutorialVideos = () => sent.filter((one) => one.url.endsWith('/sendVideo'));

  // --- The operator's editor ---------------------------------------------------------------

  it('starts DISABLED with nothing stored, and saves, audits and replays a write', async () => {
    const first = await ctx.container.deliveryTutorials.get(tenantA, owner, panelId);
    expect(first.tutorial).toMatchObject({ mode: 'DISABLED', revision: 0, text: null });

    const key = randomUUID();
    const body = {
      idempotencyKey: key,
      expectedRevision: 0,
      mode: 'TEXT',
      text: `  ${TEXT}  `,
      videoClientAppId: null,
      appliesToPurchase: true,
      appliesToTrial: false,
    };
    const saved = await ctx.container.deliveryTutorials.update(tenantA, owner, panelId, body);
    expect(saved.changed).toBe(true);
    expect(saved.tutorial).toMatchObject({
      mode: 'TEXT',
      text: TEXT,
      appliesToTrial: false,
      revision: 1,
    });
    const replay = await ctx.container.deliveryTutorials.update(tenantA, owner, panelId, body);
    expect(replay).toMatchObject({ changed: true, tutorial: { revision: 1 } });

    const audits = await ctx.container.database.db.execute<{ before: unknown; after: unknown }>(
      sql`SELECT before, after FROM audit_logs
           WHERE action = 'panel.delivery_tutorial_update' AND entity_id = ${panelId}`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.before).toBeNull();
    expect(audits.rows[0]?.after).toMatchObject({ mode: 'TEXT', text: TEXT });
  });

  it('keeps the text through a switch to DISABLED, and refuses a stale revision', async () => {
    await configure({ mode: 'TEXT' });
    const off = await configure({ mode: 'DISABLED' });
    expect(off.tutorial).toMatchObject({ mode: 'DISABLED', text: TEXT, revision: 2 });
    const unchanged = await configure({ mode: 'DISABLED' });
    expect(unchanged).toMatchObject({ changed: false, tutorial: { revision: 2 } });

    await expect(
      ctx.container.deliveryTutorials.update(tenantA, owner, panelId, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        mode: 'TEXT',
        text: TEXT,
        videoClientAppId: null,
        appliesToPurchase: true,
        appliesToTrial: true,
      }),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.DELIVERY_TUTORIAL_STALE });
  });

  it('refuses a video app that is not this tenant’s, and markup in the text', async () => {
    await expect(
      configure({ mode: 'VIDEO', videoClientAppId: '01900000-0000-7000-8000-00000000dead' }),
    ).rejects.toMatchObject({ code: 'control.client_app_not_found' });
    await expect(
      configure({ text: '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>' }),
    ).rejects.toMatchObject({ code: 'commerce.request_invalid' });
  });

  it('is tenant-scoped: another tenant can neither read nor write this panel’s tutorial', async () => {
    await configure();
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    await expect(
      ctx.container.deliveryTutorials.get(tenantB, ownerB, panelId),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.PANEL_NOT_FOUND });
    await expect(
      ctx.container.deliveryTutorials.update(tenantB, ownerB, panelId, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        mode: 'TEXT',
        text: 'نفوذ',
        videoClientAppId: null,
        appliesToPurchase: true,
        appliesToTrial: true,
      }),
    ).rejects.toMatchObject({ code: PANEL_ERROR_CODES.PANEL_NOT_FOUND });
    const repository = new DrizzleDeliveryTutorialRepository(ctx.container.database.db);
    expect(await repository.find(tenantB, panelId)).toBeNull();
    expect((await repository.find(tenantA, panelId))?.text).toBe(TEXT);
  });

  it('the table refuses what the mode cannot send, an unknown mode, and a foreign panel', async () => {
    const insert = (mode: string, text: string | null, app: string | null, tenant = tenantA) =>
      ctx.container.database.db.execute(
        sql`INSERT INTO delivery_tutorials (tenant_id, panel_id, mode, text, video_client_app_id)
             VALUES (${tenant.tenantId}, ${panelId}, ${mode}, ${text}, ${app})`,
      );
    await expect(insert('BOGUS', TEXT, null)).rejects.toThrow();
    await expect(insert('TEXT', null, null)).rejects.toThrow();
    await expect(insert('VIDEO', TEXT, null)).rejects.toThrow();
    await expect(insert('TEXT', '   ', null)).rejects.toThrow();
    await expect(insert('TEXT', TEXT, null, tenantB)).rejects.toThrow();
    // A DISABLED row may keep nothing at all — the deterministic default.
    await insert('DISABLED', null, null);
    const rows = await ctx.container.database.db.execute<{
      applies_to_purchase: boolean;
      applies_to_trial: boolean;
      revision: number;
    }>(sql`SELECT applies_to_purchase, applies_to_trial, revision FROM delivery_tutorials`);
    expect(rows.rows).toEqual([{ applies_to_purchase: true, applies_to_trial: true, revision: 1 }]);
  });

  // --- The send -----------------------------------------------------------------------------

  it('a paid delivery is followed by the tutorial, once, after the link', async () => {
    await configure({ mode: 'TEXT' });
    const orderId = await paidOrder('paid');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(tutorialTexts()).toHaveLength(1);
    const linkAt = sent.findIndex((one) => one.url.endsWith('/sendPhoto'));
    const tutorialAt = sent.indexOf(tutorialTexts()[0] as (typeof sent)[number]);
    expect(linkAt).toBeGreaterThanOrEqual(0);
    expect(tutorialAt, 'after the delivery card').toBeGreaterThan(linkAt);
    expect(tutorialTexts()[0]?.body['chat_id']).toBe('930930');

    // The claim is durable, keyed by the service.
    const claims = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM request_idempotency
           WHERE key = ${`delivery_tutorial:${service?.id ?? ''}`}`,
    );
    expect(claims.rows[0]?.n).toBe(1);

    // Delivery re-armed for the same service (a replay, a second sweep): the link goes again,
    // the tutorial does not.
    sent = [];
    await ctx.container.database.db.execute(
      sql`UPDATE services SET delivery_state = 'PENDING', delivered_at = NULL,
                              delivery_next_attempt_at = now() - interval '1 minute'
           WHERE id = ${service?.id ?? ''}`,
    );
    await ctx.container.provisionerLoop.tick();
    expect(
      sent.some((one) => one.url.endsWith('/sendPhoto')),
      'the link went again',
    ).toBe(true);
    expect(tutorialTexts(), 'the tutorial did not').toHaveLength(0);
  });

  it('a trial delivery is followed by a trial-only tutorial; a paid one is not', async () => {
    await configure({ mode: 'TEXT', appliesToPurchase: false, appliesToTrial: true });
    const serviceId = await trial('trial-1');
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, serviceId as never))?.deliveryState).toBe('DELIVERED');
    expect(tutorialTexts()).toHaveLength(1);

    sent = [];
    await paidOrder('paid-after-trial');
    await ctx.container.provisionerLoop.tick();
    expect(sent.some((one) => one.url.endsWith('/sendPhoto'))).toBe(true);
    expect(tutorialTexts()).toHaveLength(0);
  });

  it('a DISABLED tutorial, or none, sends nothing extra', async () => {
    await paidOrder('none');
    await ctx.container.provisionerLoop.tick();
    expect(sent.some((one) => one.url.endsWith('/sendPhoto'))).toBe(true);
    const nothing = sent.filter(
      (one) => one.url.endsWith('/sendVideo') || one.body['text'] === TEXT,
    );
    expect(nothing).toHaveLength(0);

    await configure({ mode: 'TEXT' });
    await configure({ mode: 'DISABLED' });
    sent = [];
    await paidOrder('disabled');
    await ctx.container.provisionerLoop.tick();
    expect(sent.some((one) => one.url.endsWith('/sendPhoto'))).toBe(true);
    expect(tutorialTexts()).toHaveLength(0);
  });

  it('VIDEO_TEXT sends the delivering bot’s client-app video with the text as its caption', async () => {
    const app = await ctx.container.clientApps.create(tenantA, owner, {
      platform: 'ANDROID',
      name: 'Sing-box',
      icon: null,
      description: 'سازگار با لینک اشتراک',
      officialUrl: 'https://downloads.example.com/app.apk',
      alternativeUrl: null,
      helpUrl: null,
      guide: '1. برنامه را نصب کنید',
      deliveryKinds: [],
      protocols: [],
      providerTypes: [],
      sortOrder: 10,
      idempotencyKey: 'app-singbox',
    });
    await ctx.container.database.db.execute(
      sql`INSERT INTO client_app_videos (id, tenant_id, client_app_id, bot_instance_id, file_id,
                                          file_unique_id, set_by_admin_id)
           VALUES (${randomUUID()}, ${tenantA.tenantId}, ${app.id}, ${BOT_A}, 'file-singbox',
                   'uniq-singbox', ${ownerId})`,
    );
    const saved = await configure({ mode: 'VIDEO_TEXT', videoClientAppId: app.id });
    expect(saved.videoOptions).toEqual([
      expect.objectContaining({ clientAppId: app.id, enabled: true, botsWithVideo: 1 }),
    ]);

    await paidOrder('video');
    await ctx.container.provisionerLoop.tick();
    expect(tutorialVideos()).toHaveLength(1);
    expect(tutorialVideos()[0]?.body).toMatchObject({ video: 'file-singbox', caption: TEXT });
    expect(tutorialTexts(), 'the text went as the caption, not twice').toHaveLength(0);
  });
});
