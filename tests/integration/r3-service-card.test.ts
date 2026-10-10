import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationCardRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation-card.repository';
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
 * R3 (v0.3.5 real-test fixes) — what happens on the customer's side after a provisioning
 * or a service operation, end to end through the shipped container: the real RickPanel
 * adapter over the real SafeHttpClient against `tests/support/fake-rickpanel.ts`, and the
 * real customer messenger against a Telegram stand-in that records every request.
 *
 * - item 6: a RickPanel service's details, then EVERY connection file, after a paid
 *   purchase and after a trial — and a file that cannot be sent never fails provisioning;
 * - item 10: disable and enable edit the SAME card the customer tapped, 🟢 ↔ 🔴, with the
 *   switch turned round, and nothing else is sent for a normal success.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '960960';

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
  readonly body: Record<string, unknown>;
}

describe('R3 — service delivery, connection files and the service card', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  /** Per Bot API method, what the stand-in answers instead of `ok`. */
  let answers: Record<string, { status: number; body: unknown }>;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;
  let updateSeq = 7000;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const method = (request.url ?? '').split('/').at(-1) ?? '';
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ method, raw, body });
        const answer = answers[method] ?? {
          status: 200,
          body: { ok: true, result: { message_id: 4242 } },
        };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
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
    sent = [];
    answers = {};

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r3', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-r3-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    customerId = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve'), {
        idempotencyKey: `resolve-r3-${CUSTOMER_TG}`,
        telegramUserId: CUSTOMER_TG,
        from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
  });

  async function product(key: string, price: bigint | null): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: `پلن ${key}`,
        description: null,
        audience: price === null ? 'HIDDEN' : 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: price === null ? null : money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  /** A paid purchase, provisioned and delivered by one provisioner tick. */
  async function paidService(key: string): Promise<ServiceRecord> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: await product(key, 250_000n),
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
      orderId: confirmed.id as OrderId,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    return service;
  }

  /*
   * A trial, the way R1 issues one: configured on the panel (100 MB for 72 hours), claimed
   * for that panel with no product, provisioned by the ordinary provisioner and announced
   * by the ordinary delivery lane — so the files follow it exactly as they follow a purchase.
   */
  async function trialService(): Promise<ServiceRecord> {
    // F5: the panel's own trial is the one switch; there is no `trials` flag to turn on.
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
    const claimed = await ctx.container.trials.claim(tenantA, systemActor('trial'), customerId, {
      idempotencyKey: 'r3-trial',
      panelId,
    });
    if (claimed.outcome !== 'ISSUED') throw new Error(`trial refused: ${JSON.stringify(claimed)}`);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, claimed.orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('trial not provisioned');
    if (!service.isTrial) throw new Error('the trial service is not marked as a trial');
    return service;
  }

  /** Codex review of #116: `key` repeats an update, as Telegram's redelivery does. */
  const tap = (data: string, messageId: number, key?: string) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: key ?? `r3-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(CUSTOMER_TG), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: messageId,
            date: 0,
            chat: { id: Number(CUSTOMER_TG), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
    });
  };

  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    (
      (await ctx.container.database.db.execute(query as never)) as unknown as {
        rows: { n: number }[];
      }
    ).rows[0]?.n ?? 0;

  const of = (method: string) => sent.filter((one) => one.method === method);

  /**
   * The delivery message first, then every file after it — since round N (F2) as ONE album,
   * in the panel's order, each file with the panel's own caption.
   */
  function expectDetailsThenFiles(service: ServiceRecord): void {
    const details = sent.findIndex(
      (one) =>
        (one.method === 'sendPhoto' || one.method === 'sendMessage') &&
        one.raw.includes(service.subscriptionUrl ?? '-'),
    );
    expect(details, 'the service details were delivered').toBeGreaterThanOrEqual(0);
    const albums = sent
      .map((one, index) => ({ one, index }))
      .filter(({ one }) => one.method === 'sendMediaGroup');
    expect(albums).toHaveLength(1);
    expect(of('sendDocument'), 'no file goes on its own').toHaveLength(0);
    const [{ one, index }] = albums as [{ one: Sent; index: number }];
    expect(index, 'files come after the details').toBeGreaterThan(details);
    expect([...one.raw.matchAll(/filename="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      `${service.providerUsername}.json`,
      `${service.providerUsername}.txt`,
    ]);
    const media = JSON.parse(/name="media"\r\n\r\n([^\r]*)\r\n/u.exec(one.raw)?.[1] ?? '[]') as {
      caption?: string;
    }[];
    expect(media.map((item) => item.caption)).toEqual([
      `${service.providerUsername} — JSON`,
      `${service.providerUsername} — links`,
    ]);
  }

  // =========================================================================
  // Item 6 — the connection files arrive by themselves
  // =========================================================================

  describe('automatic RickPanel connection files', () => {
    it('a paid purchase: the details, then every connection file', async () => {
      const service = await paidService('paid');
      expect(service.deliveryState).toBe('DELIVERED');
      expectDetailsThenFiles(service);
      expect(panel.filesCalls()).toBe(1);

      // Told once: another tick sends neither the details nor the files again.
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('sendDocument')).toHaveLength(0);
      expect(of('sendMediaGroup')).toHaveLength(0);
      expect(panel.filesCalls()).toBe(1);
    });

    it('a trial: the same details and files, through the same delivery lane', async () => {
      const service = await trialService();
      const [order] = (
        (await ctx.container.database.db.execute(
          sql`SELECT purpose FROM orders WHERE id = ${service.orderId}`,
        )) as unknown as { rows: { purpose: string }[] }
      ).rows;
      expect(order?.purpose).toBe('TRIAL');
      expect(service.deliveryState).toBe('DELIVERED');
      expectDetailsThenFiles(service);
    });

    it('a panel that cannot build the files does not fail the provisioning', async () => {
      panel.filesBody = JSON.stringify({ unexpected: true });
      const service = await paidService('files-broken');
      expect(service.state).toBe('ACTIVE');
      expect(service.deliveryState).toBe('DELIVERED');
      expect(of('sendDocument')).toHaveLength(0);
      expect(of('sendMediaGroup')).toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'PROVISION' AND state = 'SUCCEEDED'`,
        ),
      ).toBe(1);
      // Nothing says the service failed, and the customer can still ask for the files.
      expect(await count(sql`SELECT count(*)::int AS n FROM customer_notifications`)).toBe(0);
    });

    it('Telegram refusing a file does not touch the delivered service', async () => {
      answers['sendMediaGroup'] = {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: file rejected' },
      };
      const service = await paidService('files-refused');
      expect(service.state).toBe('ACTIVE');
      expect(service.deliveryState).toBe('DELIVERED');
      // One attempt, then it stops: nothing is retried, and no file goes on its own instead.
      expect(of('sendMediaGroup')).toHaveLength(1);
      expect(of('sendDocument')).toHaveLength(0);
    });

    it('never logs or stores the file bytes', async () => {
      const secret = `R3FILESECRET-${randomUUID()}`;
      panel.filesBody = JSON.stringify([
        {
          filename: 'secret.txt',
          media_type: 'text/plain',
          content_b64: Buffer.from(secret, 'utf8').toString('base64'),
        },
      ]);
      await paidService('files-secret');
      expect(of('sendDocument')[0]?.raw).toContain(secret);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM operational_events WHERE context::text LIKE ${`%${secret}%`}`,
        ),
      ).toBe(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE (before::text || after::text) LIKE ${`%${secret}%`}`,
        ),
      ).toBe(0);
    });
  });

  // =========================================================================
  // Item 10 — disable / enable edit the SAME card
  // =========================================================================

  describe('disable and enable on the service card', () => {
    const CARD = 5150;

    /*
     * B8: both directions ASK first. The switch's own tap (`u:` / `e:` — also on a card
     * drawn before this release) edits the SAME card into the question and plans nothing;
     * only the confirm (`uq:` / `eq:`) plans the operation, and cancel (`sv:`) puts the card
     * back unchanged.
     */
    const operations = (serviceId: string, type: string) =>
      count(
        sql`SELECT count(*)::int AS n FROM provisioning_operations
             WHERE service_id = ${serviceId} AND type = ${type}`,
      );
    const callbacks = (one: Sent | undefined) =>
      [
        ...JSON.stringify(one?.body['reply_markup'] ?? {}).matchAll(/"callback_data":"([^"]+)"/gu),
      ].map((m) => m[1] as string);

    it('B8: switching OFF asks in the card first, and plans nothing until confirmed', async () => {
      const service = await paidService('b8-off');
      sent = [];
      const asked = await tap(`u:${service.id}`, CARD);
      expect(asked.replyKey).toBe('bot.service.suspend_confirm');
      expect(of('sendMessage'), 'no new message').toHaveLength(0);
      const [question] = of('editMessageText');
      expect(of('editMessageText')).toHaveLength(1);
      expect(question?.body['message_id']).toBe(CARD);
      expect(String(question?.body['text'])).toBe(
        `آیا سرویس ${service.providerUsername} خاموش شود؟\nتا وقتی آن را دوباره روشن نکنید، اتصال برقرار نمی‌شود. اگر سرویس شما تاریخ اتمام دارد، زمان باقی‌ماندهٔ آن در این مدت هم سپری می‌شود و متوقف نمی‌شود.`,
      );
      const data = callbacks(question);
      expect(data).toEqual([`uq:${service.id}`, `sv:${service.id}`]);
      expect(JSON.stringify(question?.body['reply_markup'])).toContain('✖️ انصراف');
      for (const one of data) expect(Buffer.byteLength(one, 'utf8')).toBeLessThanOrEqual(64);
      expect(await operations(service.id, 'SUSPEND'), 'the question plans nothing').toBe(0);
      await ctx.container.provisionerLoop.tick();
      expect(panel.users.get(service.providerUsername)?.status).toBe('active');

      // The confirm is the only tap that plans it — once, whatever Telegram redelivers.
      const key = `b8-confirm-${randomUUID()}`;
      await tap(`uq:${service.id}`, CARD, key);
      await tap(`uq:${service.id}`, CARD, key);
      expect(await operations(service.id, 'SUSPEND')).toBe(1);
      await ctx.container.provisionerLoop.tick();
      expect(panel.users.get(service.providerUsername)?.status).toBe('disabled');
    });

    it('B8: switching ON asks in the card first, and plans nothing until confirmed', async () => {
      const service = await paidService('b8-on');
      await tap(`uq:${service.id}`, CARD);
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('SUSPENDED');

      sent = [];
      const asked = await tap(`e:${service.id}`, CARD);
      expect(asked.replyKey).toBe('bot.service.resume_confirm');
      const [question] = of('editMessageText');
      expect(question?.body['message_id']).toBe(CARD);
      expect(String(question?.body['text'])).toBe(
        `آیا سرویس ${service.providerUsername} دوباره روشن شود؟`,
      );
      expect(callbacks(question)).toEqual([`eq:${service.id}`, `sv:${service.id}`]);
      expect(of('sendMessage')).toHaveLength(0);
      expect(await operations(service.id, 'RESUME')).toBe(0);

      await tap(`eq:${service.id}`, CARD);
      expect(await operations(service.id, 'RESUME')).toBe(1);
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('ACTIVE');
    });

    it('B8: cancel puts the same card back and changes nothing', async () => {
      const service = await paidService('b8-cancel');
      await tap(`u:${service.id}`, CARD);
      sent = [];
      await tap(`sv:${service.id}`, CARD);
      const [card] = of('editMessageText');
      expect(of('editMessageText')).toHaveLength(1);
      expect(card?.body['message_id']).toBe(CARD);
      expect(String(card?.body['text'])).toContain('🟢');
      expect(callbacks(card)).toContain(`u:${service.id}`);
      expect(of('sendMessage')).toHaveLength(0);
      expect(await operations(service.id, 'SUSPEND')).toBe(0);
      await ctx.container.provisionerLoop.tick();
      expect(panel.users.get(service.providerUsername)?.status).toBe('active');
    });

    it('B8: a switch the service no longer offers is not asked about — the card is redrawn with the notice', async () => {
      const service = await paidService('b8-stale');
      sent = [];
      // Enable on an ACTIVE service: a keyboard from before it was switched back on.
      const stale = await tap(`e:${service.id}`, CARD);
      expect(stale.replyKey).toBe('bot.service.card');
      expect(JSON.stringify(of('answerCallbackQuery').at(-1))).toContain(
        'این قابلیت برای سرویس شما در دسترس نیست',
      );
      expect(await operations(service.id, 'RESUME')).toBe(0);
    });

    it('disable edits the same card to inactive and turns the switch into enable, and back', async () => {
      const service = await paidService('switch');
      sent = [];

      // The tap sends nothing new: no «request registered». Round N (F4): the SAME card
      // reads «working», with no switch to tap twice, until the panel has answered.
      const tapped = await tap(`uq:${service.id}`, CARD);
      expect(tapped.replyKey).toBeNull();
      expect(of('sendMessage')).toHaveLength(0);
      const [working] = of('editMessageText');
      expect(of('editMessageText')).toHaveLength(1);
      expect(working?.body['message_id']).toBe(CARD);
      expect(String(working?.body['text'])).toContain('⏳');
      expect(JSON.stringify(working?.body['reply_markup'])).not.toContain(`"u:${service.id}"`);
      expect(JSON.stringify(working?.body['reply_markup'])).not.toContain(`"e:${service.id}"`);
      expect(of('answerCallbackQuery')).toHaveLength(1);

      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('SUSPENDED');
      expect(panel.users.get(service.providerUsername)?.status).toBe('disabled');
      const [disabled] = of('editMessageText');
      expect(disabled?.body['message_id']).toBe(CARD);
      expect(disabled?.body['chat_id']).toBe(CUSTOMER_TG);
      expect(String(disabled?.body['text'])).toContain('🔴');
      expect(String(disabled?.body['text'])).not.toContain('🟢');
      const disabledButtons = JSON.stringify(disabled?.body['reply_markup']);
      expect(disabledButtons).toContain(`"e:${service.id}"`);
      expect(disabledButtons).not.toContain(`"u:${service.id}"`);
      expect(of('sendMessage'), 'nothing but the edit').toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'SERVICE_ACTION_SUCCEEDED'`,
        ),
        'the card is the answer; no second «applied» sentence',
      ).toBe(0);

      // Told once.
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(0);

      // Enable, from the same card: back to active, and the switch turned round again.
      await tap(`eq:${service.id}`, CARD);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('ACTIVE');
      const [enabled] = of('editMessageText');
      expect(enabled?.body['message_id']).toBe(CARD);
      expect(String(enabled?.body['text'])).toContain('🟢');
      const enabledButtons = JSON.stringify(enabled?.body['reply_markup']);
      expect(enabledButtons).toContain(`"u:${service.id}"`);
      expect(enabledButtons).not.toContain(`"e:${service.id}"`);
      expect(of('sendMessage')).toHaveLength(0);
    });

    it('a card Telegram can no longer edit is sent once as a new message', async () => {
      const service = await paidService('switch-gone');
      answers['editMessageText'] = {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
      };
      sent = [];
      await tap(`uq:${service.id}`, CARD);
      // The «working» edit is best effort: refused, it is not sent instead.
      expect(of('editMessageText')).toHaveLength(1);
      expect(of('sendMessage')).toHaveLength(0);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(1);
      const cards = of('sendMessage');
      expect(cards).toHaveLength(1);
      expect(String(cards[0]?.body['text'])).toContain('🔴');
      expect(JSON.stringify(cards[0]?.body['reply_markup'])).toContain(`"e:${service.id}"`);

      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('sendMessage')).toHaveLength(0);
      expect(of('editMessageText')).toHaveLength(0);
    });

    it('a disable the panel cannot perform puts the card back as it was, with the failure on it', async () => {
      const service = await paidService('switch-fail');
      (panel.users as Map<string, unknown>).delete(service.providerUsername);
      await tap(`uq:${service.id}`, CARD);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('ACTIVE');
      // Round N (F4): the card that read «working» is answered ON the card — still active,
      // the switch offered again, and the failure line under the status. Never «inactive».
      const [answered] = of('editMessageText');
      expect(of('editMessageText')).toHaveLength(1);
      expect(answered?.body['message_id']).toBe(CARD);
      const text = String(answered?.body['text']);
      expect(text).toContain('🟢');
      expect(text).not.toContain('🔴');
      expect(text).not.toContain('⏳');
      expect(text).toContain('درخواست قبلی شما روی سرور انجام نشد');
      expect(JSON.stringify(answered?.body['reply_markup'])).toContain(`"u:${service.id}"`);
      expect(of('sendMessage'), 'no separate failure message').toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'SERVICE_ACTION_FAILED'`,
        ),
        'the card is the answer',
      ).toBe(0);
      const [operation] = (
        (await ctx.container.database.db.execute(
          sql`SELECT announced_at FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
        )) as unknown as { rows: { announced_at: Date | null }[] }
      ).rows;
      expect(operation?.announced_at, 'still answered once').not.toBeNull();

      // Told once.
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(0);
    });

    it('a double tap plans one operation and keeps the first card', async () => {
      const service = await paidService('switch-twice');
      await tap(`uq:${service.id}`, CARD);
      await tap(`uq:${service.id}`, CARD + 1);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
        ),
      ).toBe(1);
      expect(await count(sql`SELECT count(*)::int AS n FROM operation_card_messages`)).toBe(1);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      // The card the operation was asked from is the one answered.
      expect(of('editMessageText').map((one) => one.body['message_id'])).toEqual([CARD]);
    });

    it('a request with no card to edit is still answered by message', async () => {
      const service = await paidService('switch-nocard');
      await ctx.container.provisioning.requestFromCustomer(
        tenantA,
        systemActor('no-card'),
        customerId,
        service.id,
        'SUSPEND',
        { idempotencyKey: 'no-card' },
      );
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'SERVICE_ACTION_SUCCEEDED'`,
        ),
      ).toBe(1);
    });

    /*
     * Codex review of #110, P1: a 429 on the card gave the claim back with no wait, so the
     * next tick asked the rate-limited bot again. Now the card is held until Telegram's
     * `retry_after` has passed. The repository is asked at chosen instants — the clock
     * the rule is written against — before and after that wait.
     */
    async function heldCard(service: ServiceRecord, retryAfterSeconds: number) {
      const cards = new DrizzleOperationCardRepository(ctx.container.database.db);
      const [row] = (
        (await ctx.container.database.db.execute(
          sql`SELECT c.operation_id, c.answered_at, c.next_attempt_at
                FROM operation_card_messages c
                JOIN provisioning_operations o ON o.id = c.operation_id
               WHERE o.service_id = ${service.id}`,
        )) as unknown as {
          rows: { operation_id: string; answered_at: Date | null; next_attempt_at: Date | null }[];
        }
      ).rows;
      if (row === undefined) throw new Error('no card');
      expect(row.answered_at, 'the claim was given back').toBeNull();
      expect(row.next_attempt_at, 'with a wait').not.toBeNull();
      const retryAt = new Date(row.next_attempt_at as Date);
      const waited = retryAt.getTime() - Date.now();
      expect(waited).toBeGreaterThan((retryAfterSeconds - 5) * 1000);
      expect(waited).toBeLessThanOrEqual(retryAfterSeconds * 1000);
      const later = new Date(Date.now() + 3_600_000);
      const due = (at: Date) =>
        ctx.container.uow.run(tenantA, async (tx) =>
          cards.dueForAnswer(tenantA, later, at, 10, tx),
        );
      const claim = (at: Date) =>
        ctx.container.uow.run(tenantA, async (tx) =>
          cards.claim(tenantA, row.operation_id, at, tx),
        );
      const justBefore = new Date(retryAt.getTime() - 1_000);
      expect(await due(justBefore), 'not due before retry_after').toEqual([]);
      expect(await claim(justBefore), 'not claimable before retry_after').toBeNull();
      expect(await due(retryAt), 'due once it has passed').toEqual([row.operation_id]);
      expect((await claim(retryAt))?.messageId, 'and claimable').toBe(CARD);
    }

    it("a 429 on the edit holds the card until Telegram's retry_after", async () => {
      const service = await paidService('switch-429-edit');
      answers['editMessageText'] = {
        status: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 30 } },
      };
      await tap(`uq:${service.id}`, CARD);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(1);
      expect(of('sendMessage'), 'a 429 is not a reason to send instead').toHaveLength(0);
      // The very next tick asks nothing of the rate-limited bot.
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(0);
      await heldCard(service, 30);
    });

    it("a 429 on the fallback send holds the card until Telegram's retry_after", async () => {
      const service = await paidService('switch-429-send');
      answers['editMessageText'] = {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
      };
      answers['sendMessage'] = {
        status: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 20 } },
      };
      await tap(`uq:${service.id}`, CARD);
      sent = [];
      await ctx.container.provisionerLoop.tick();
      expect(of('editMessageText')).toHaveLength(1);
      expect(of('sendMessage')).toHaveLength(1);
      await heldCard(service, 20);
    });
  });

  // =========================================================================
  // Round N (F4) — every service action works from, and answers on, the same card
  // =========================================================================

  describe('round N: the same card', () => {
    const CARD = 6160;

    /*
     * Codex review of #116, finding 1: Telegram redelivers a disable whose failure the card
     * has already answered. The replay must not turn the answered card back into «working»
     * — the operation has ended and nothing would ever answer it again.
     */
    it('a redelivered switch tap leaves the answered card alone', async () => {
      const service = await paidService('replay-switch');
      (panel.users as Map<string, unknown>).delete(service.providerUsername);
      const key = `replay-${randomUUID()}`;
      await tap(`uq:${service.id}`, CARD, key);
      await ctx.container.provisionerLoop.tick();
      const [ended] = (
        (await ctx.container.database.db.execute(
          sql`SELECT state FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
        )) as unknown as { rows: { state: string }[] }
      ).rows;
      expect(ended?.state).toBe('FAILED');

      sent = [];
      const again = await tap(`uq:${service.id}`, CARD, key);
      expect(again.replyKey).toBeNull();
      expect(of('editMessageText'), 'the answered card is not touched').toHaveLength(0);
      expect(of('sendMessage')).toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
        ),
      ).toBe(1);
    });

    it('reads «working» wherever it is drawn while a change is unsettled, then final', async () => {
      const service = await paidService('working-any');
      await tap(`uq:${service.id}`, CARD);
      // The card opened again — from another message — before the panel has answered.
      sent = [];
      await tap(`sv:${service.id}`, CARD + 1);
      const [redrawn] = of('editMessageText');
      expect(redrawn?.body['message_id']).toBe(CARD + 1);
      expect(String(redrawn?.body['text'])).toContain('⏳');
      expect(JSON.stringify(redrawn?.body['reply_markup'])).not.toContain(`"u:${service.id}"`);

      await ctx.container.provisionerLoop.tick();
      sent = [];
      await tap(`sv:${service.id}`, CARD + 1);
      const [settled] = of('editMessageText');
      expect(String(settled?.body['text'])).toContain('🔴');
      expect(String(settled?.body['text'])).not.toContain('⏳');
      expect(JSON.stringify(settled?.body['reply_markup'])).toContain(`"e:${service.id}"`);
    });

    it('opens every sub-screen IN the card, with a way back that restores the card in place', async () => {
      const service = await paidService('in-card');
      for (const data of [
        `n:${service.id}`,
        `v:${service.id}`,
        `nt:${service.id}`,
        `fa:${service.id}`,
        `ta:${service.id}`,
      ]) {
        sent = [];
        const reply = await tap(data, CARD);
        expect(reply.replyKey, data).not.toBeNull();
        expect(of('sendMessage'), `${data}: no new message`).toHaveLength(0);
        const [screen] = of('editMessageText');
        expect(screen?.body['message_id'], `${data}: the card's own message`).toBe(CARD);
        expect(JSON.stringify(screen?.body['reply_markup']), `${data}: a way back`).toContain(
          `"sv:${service.id}"`,
        );
      }
      sent = [];
      await tap(`sv:${service.id}`, CARD);
      expect(of('sendMessage')).toHaveLength(0);
      const [card] = of('editMessageText');
      expect(card?.body['message_id']).toBe(CARD);
      expect(String(card?.body['text'])).toContain(service.providerUsername);
      expect(JSON.stringify(card?.body['reply_markup'])).toContain(`"u:${service.id}"`);
    });
  });
});
