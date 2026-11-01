import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
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
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R11 A4: «فقط فایل، بدون لینک ساب» through the shipped container and the real bot runtime,
 * against the fake RickPanel (the one provider that hands over files): the delivery card,
 * «سرویس‌های من», a stale link button, «دریافت فایل‌های جدید» and the files' captions.
 * Each case has the option OFF as its control, or is the control.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '930931';
const OTHER_TG = '930932';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('files only, no subscription link (R11 A4): the bot', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;
  let updateSeq = 0;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // A photo goes out as multipart; a body that is not JSON is kept raw rather
        // than thrown on, which would leave the request unanswered and the send UNCONFIRMED.
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
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-fo', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-fo-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

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
    }
  });

  async function enableRotation(hours?: number): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_link_rotation',
      enabled: true,
      expectedVersion: null,
      // TENANT_WIDE: the flag names itself and says why (ADR-0010).
      confirmKey: 'customer_link_rotation',
      reason: 'let customers replace a leaked link',
      idempotencyKey: randomUUID(),
    });
    if (hours !== undefined) {
      const current = await ctx.container.settingsService.get(
        tenantA,
        owner,
        'services.link_rotation_cooldown_hours',
      );
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'services.link_rotation_cooldown_hours',
        value: hours,
        expectedVersion: current.version,
        idempotencyKey: randomUUID(),
      });
    }
  }

  async function paidOrder(key: string, who: UserId): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
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

  /** An ACTIVE service whose first link has been delivered. */
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

  const rotations = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
    );

  const tap = (data: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `fo-update-${String(updateSeq)}-${randomUUID()}`,
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
  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});
  const lastEdit = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/editMessageText')).at(-1) ?? {});

  const raw = (one: (typeof sent)[number]) => JSON.stringify(one.body);
  const textOf = (one: (typeof sent)[number]) =>
    String(one.body['text'] ?? one.body['caption'] ?? one.body['unparseable'] ?? '');
  const posts = (suffix: string) => sent.filter((one) => one.url.endsWith(suffix));
  /** Every message that is text or a caption: the places a link could be written. */
  const customerText = () =>
    sent
      .filter((one) => !one.url.endsWith('/sendMediaGroup') && !one.url.endsWith('/sendDocument'))
      .map(raw)
      .join('\n');

  const filesOnly = (enabled: boolean) =>
    ctx.container.panels.update(tenantA, owner, panelId, {
      filesOnlyDelivery: enabled,
      idempotencyKey: randomUUID(),
    });

  // =========================================================================
  // The delivery card
  // =========================================================================

  it('delivers the card with NO link and NO QR, and the files right after it', async () => {
    await filesOnly(true);
    const service = await deliveredService('card');
    const url = service.subscriptionUrl ?? '-';
    expect(url).not.toBe('-');
    expect(customerText()).not.toContain(url);
    expect(customerText()).not.toContain(url.split('/').at(-1) ?? '-');
    expect(posts('/sendPhoto'), 'no QR of a link nobody is shown').toHaveLength(0);
    const card = posts('/sendMessage').find((one) =>
      textOf(one).includes('سرویس با موفقیت ایجاد شد'),
    );
    expect(card, 'the delivery card was sent').toBeDefined();
    expect(textOf(card!)).toContain(service.providerUsername);
    expect(textOf(card!)).toContain('فایل‌های اتصال شما در پیام‌های بعدی ارسال می‌شود');
    expect(textOf(card!)).not.toContain('لینک اتصال');
    expect(posts('/sendMediaGroup'), 'the connection files follow, as one album').toHaveLength(1);
    // The delivery is recorded exactly as any other: the link itself is still stored.
    expect(service.deliveryState).toBe('DELIVERED');
  });

  it('control: with the option off the same purchase shows the link and its QR', async () => {
    const service = await deliveredService('card-off');
    expect(posts('/sendPhoto').length + posts('/sendMessage').length).toBeGreaterThan(0);
    expect(customerText()).toContain(service.subscriptionUrl ?? '-');
    expect(posts('/sendPhoto').length).toBeGreaterThan(0);
  });

  // =========================================================================
  // «سرویس‌های من»
  // =========================================================================

  it('draws the service card with no link button and «دریافت فایل‌های جدید» for «تغییر لینک»', async () => {
    await enableRotation();
    await filesOnly(true);
    const service = await deliveredService('mine');
    sent = [];
    await tap(`s:${service.id}`);
    const card = lastMessage();
    expect(card).not.toContain(`"callback_data":"r:${service.id}"`);
    expect(card).not.toContain('لینک اشتراک');
    expect(card).not.toContain('تغییر لینک');
    expect(card, 'the same tap, the same slot').toContain(`"callback_data":"rc:${service.id}"`);
    expect(card).toContain('دریافت فایل‌های جدید');
    expect(card, 'the files button stays').toContain(`sf:${service.id}`);
    expect(card).not.toContain(service.subscriptionUrl ?? '-');
  });

  it('control: with the option off the card keeps «لینک اشتراک» and «تغییر لینک»', async () => {
    await enableRotation();
    const service = await deliveredService('mine-off');
    sent = [];
    await tap(`s:${service.id}`);
    expect(lastMessage()).toContain(`"callback_data":"r:${service.id}"`);
    expect(lastMessage()).toContain('تغییر لینک');
    expect(lastMessage()).not.toContain('دریافت فایل‌های جدید');
  });

  it('answers a stale «لینک اشتراک» button with the files, never the link', async () => {
    await filesOnly(true);
    const service = await deliveredService('stale');
    panel.forgetFileReads();
    sent = [];
    await tap(`r:${service.id}`);
    expect(customerText()).not.toContain(service.subscriptionUrl ?? '-');
    expect(posts('/sendPhoto')).toHaveLength(0);
    expect(posts('/sendMediaGroup'), 'the files were sent instead').toHaveLength(1);
  });

  // =========================================================================
  // «دریافت فایل‌های جدید»
  // =========================================================================

  it('asks for new FILES, rotates through the ordinary path, and announces files with no link', async () => {
    await enableRotation();
    await filesOnly(true);
    const service = await deliveredService('rotate');
    const oldUrl = service.subscriptionUrl ?? '-';

    sent = [];
    const asked = await tap(`rc:${service.id}`);
    expect(asked.intent).toBe('SERVICE_ROTATE_ASK');
    expect(lastEdit()).toContain('فایل‌های اتصال جدید ساخته می‌شود');
    expect(lastEdit()).toContain('بله، فایل‌های جدید بساز');
    expect(lastEdit()).not.toContain('لینک اشتراک جدید');
    expect(lastEdit()).not.toContain('بله، لینک جدید بساز');
    expect(lastEdit()).toContain(`rd:${service.id}`);

    sent = [];
    await tap(`rd:${service.id}`);
    panel.forgetFileReads();
    sent = [];
    await ctx.container.provisionerLoop.tick();
    const after = await reload(service.id);
    expect(after.subscriptionUrl, 'the panel really rotated its link').not.toBe(oldUrl);
    expect(panel.revokeCalls()).toBe(1);
    const [operation] = await rotations(service.id);
    expect(operation?.state).toBe('SUCCEEDED');

    expect(customerText()).not.toContain(after.subscriptionUrl ?? '-');
    expect(customerText()).not.toContain(oldUrl);
    expect(posts('/sendPhoto'), 'never a QR').toHaveLength(0);
    const answer = sent.find((one) => textOf(one).includes('با موفقیت تغییر کرد'));
    expect(answer, 'the card is answered').toBeDefined();
    expect(textOf(answer!)).toContain(`فایل‌های اتصال سرویس ${service.providerUsername}`);
    expect(textOf(answer!)).not.toContain('لینک');
    expect(raw(answer!), 'the way back to the card').toContain(`sv:${service.id}`);
    expect(posts('/sendMediaGroup'), 'the new files follow, as one album').toHaveLength(1);
    expect(sent.indexOf(answer!)).toBeLessThan(sent.indexOf(posts('/sendMediaGroup')[0]!));
  });

  it('words the cooldown refusal as files, not as a link', async () => {
    await enableRotation(24);
    await filesOnly(true);
    const service = await deliveredService('cooldown');
    await tap(`rd:${service.id}`);
    panel.forgetFileReads();
    await ctx.container.provisionerLoop.tick();
    sent = [];
    await tap(`rd:${service.id}`);
    const shown = lastEdit();
    expect(shown).toContain('فایل جدید گرفته‌اید');
    expect(shown).not.toContain('لینک جدید گرفته‌اید');
  });

  // =========================================================================
  // The files' captions
  // =========================================================================

  it('builds a file caption that names the link without the link', async () => {
    const service = await deliveredService('caption');
    await ctx.container.panelSettings.set(
      tenantA,
      owner,
      panelId,
      'panel.connection_files.caption_template',
      {
        value: 'U {username}\nL {sub_link}',
        expectedVersion: null,
        idempotencyKey: 'fo-caption-template',
      },
    );
    const albumCaption = async () => {
      panel.forgetFileReads();
      sent = [];
      await tap(`sf:${service.id}`);
      return posts('/sendMediaGroup').map(raw).join('') + posts('/sendDocument').map(raw).join('');
    };
    const withLink = await albumCaption();
    expect(withLink, 'control: the template renders the link while the option is off').toContain(
      service.subscriptionUrl ?? '-',
    );
    await filesOnly(true);
    const without = await albumCaption();
    expect(without).toContain(service.providerUsername);
    expect(without).not.toContain(service.subscriptionUrl ?? '-');
  });

  // =========================================================================
  // «نوع بارکد»
  // =========================================================================

  const setQrKind = (qrKind: 'SUB_LINK' | 'SINGBOX' | 'BOTH', singboxIntervalMinutes?: number) =>
    ctx.container.panels.update(tenantA, owner, panelId, {
      qrKind,
      ...(singboxIntervalMinutes === undefined ? {} : { singboxIntervalMinutes }),
      idempotencyKey: randomUUID(),
    });
  const photoCaptions = () =>
    posts('/sendPhoto').map((one) => String(one.body['unparseable'] ?? ''));

  it('BOTH: two QR photos with their own captions, then the whole delivery card', async () => {
    await setQrKind('BOTH', 90);
    const service = await deliveredService('both');
    const photos = posts('/sendPhoto');
    expect(photos).toHaveLength(2);
    const captions = photoCaptions();
    expect(captions[0]).toContain('QR لینک اشتراک');
    expect(captions[1]).toContain('sing-box');
    const card = posts('/sendMessage').find((one) =>
      textOf(one).includes('سرویس با موفقیت ایجاد شد'),
    );
    expect(textOf(card!)).toContain(service.subscriptionUrl ?? '-');
    expect(sent.indexOf(card!)).toBeGreaterThan(sent.indexOf(photos[1]!));
  });

  it('control: the default kind sends one photo, the card as its caption', async () => {
    await deliveredService('sublink');
    expect(posts('/sendPhoto')).toHaveLength(1);
  });

  it('files-only overrides BOTH: no photo, no link, no sing-box string, files only', async () => {
    await setQrKind('BOTH');
    await filesOnly(true);
    const service = await deliveredService('both-files-only');
    expect(posts('/sendPhoto')).toHaveLength(0);
    expect(customerText()).not.toContain(service.subscriptionUrl ?? '-');
    expect(customerText()).not.toContain('sing-box');
    expect(posts('/sendMediaGroup')).toHaveLength(1);
  });

  // =========================================================================
  // An operator's resend (Codex review of #349)
  // =========================================================================

  /*
   * Both surfaces' entry is `DeliveryService.resendForOperator`: the Web Admin's
   * `POST services/:id/resend` calls it directly, and the Telegram management panel's «K:»
   * tap calls it from `adminServiceAct`. On a files-only panel the card it sends carries no
   * configuration, so the files must follow it — the resend records DELIVERED, and no later
   * sweep would send them.
   */
  const resendLanded = () => {
    expect(customerText()).not.toContain('https://');
    expect(posts('/sendPhoto')).toHaveLength(0);
    const card = posts('/sendMessage').find((one) =>
      textOf(one).includes('فایل‌های اتصال شما در پیام‌های بعدی ارسال می‌شود'),
    );
    expect(card, 'the files-only card was sent').toBeDefined();
    const album = posts('/sendMediaGroup');
    expect(album, 'the connection files follow the card').toHaveLength(1);
    expect(sent.indexOf(album[0]!)).toBeGreaterThan(sent.indexOf(card!));
  };

  it('an operator resend (the Web Admin entry) on a files-only panel sends the files too', async () => {
    await filesOnly(true);
    const service = await deliveredService('resend-web');
    panel.forgetFileReads();
    sent = [];
    const record = await ctx.container.delivery.resendForOperator(tenantA, owner, service.id);
    expect(record).toMatchObject({ state: 'DELIVERED', recorded: true });
    resendLanded();
    // Recorded once: the next sweep sends neither the card nor the files again.
    panel.forgetFileReads();
    sent = [];
    await ctx.container.provisionerLoop.tick();
    expect(posts('/sendMediaGroup')).toHaveLength(0);
  });

  it('an operator resend from the Telegram management panel («K:») sends the files too', async () => {
    await filesOnly(true);
    const service = await deliveredService('resend-tg');
    const ADMIN_TG = '930999';
    await ctx.container.adminManagement.setTelegramBinding(tenantA, owner, owner.id as never, {
      telegramUserId: ADMIN_TG,
      reason: 'files-only resend test',
    });
    panel.forgetFileReads();
    sent = [];
    const tapped = await tap(`K:${service.id}`, ADMIN_TG);
    expect(tapped.replyKey).toBe('bot.admin.service_resent');
    resendLanded();
  });

  it('control: an operator resend on a link panel sends the card with its link and no files', async () => {
    const service = await deliveredService('resend-link');
    panel.forgetFileReads();
    sent = [];
    await ctx.container.delivery.resendForOperator(tenantA, owner, service.id);
    expect(customerText()).toContain(service.subscriptionUrl ?? '-');
    expect(posts('/sendMediaGroup')).toHaveLength(0);
  });

  // =========================================================================
  // Phase 4 PR-3 (review of PR #369): a support-AI deep link forwarded to someone else
  // =========================================================================

  /** `/start <payload>` typed (or opened from a deep link) by `telegramUserId`. */
  const start = (payload: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `fo-start-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'نیما' },
          text: `/start ${payload}`,
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'نیما' },
    });
  };

  it('a deep link naming another customer’s service is refused by the bot’s own handlers: nothing leaks, nothing changes', async () => {
    await enableRotation();
    const service = await deliveredService('forwarded');
    const ordersBefore = (
      await ctx.container.database.db.execute(sql`SELECT count(*)::int AS n FROM orders`)
    ).rows[0] as { n: number };
    for (const code of ['rn', 'at', 'am', 'lc', 'ro', 'sv']) {
      sent = [];
      await start(`sai-${code}-${service.id}`, OTHER_TG);
      const told = sent.map(raw).join('\n');
      expect(told, code).not.toContain(service.providerUsername);
      expect(told, code).not.toContain(service.subscriptionUrl ?? '-');
      expect(told, code).not.toContain(service.id);
    }
    expect((await rotations(service.id)).length).toBe(0);
    const ordersAfter = (
      await ctx.container.database.db.execute(sql`SELECT count(*)::int AS n FROM orders`)
    ).rows[0] as { n: number };
    expect(ordersAfter.n).toBe(ordersBefore.n);
    expect((await reload(service.id)).customerId).toBe(customerId);
    // Control: the owner's own link opens the card.
    sent = [];
    await start(`sai-sv-${service.id}`);
    expect(sent.map(raw).join('\n')).toContain(service.providerUsername);
  });
});
