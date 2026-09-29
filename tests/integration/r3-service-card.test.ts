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

  const setSetting = (key: string, value: unknown) =>
    ctx.container.settingsService.set(tenantA, owner, {
      key,
      value,
      expectedVersion: null,
      idempotencyKey: randomUUID(),
    });

  /*
   * A trial, through the path this base has: an order of purpose TRIAL, provisioned by the
   * ordinary provisioner and announced by the ordinary delivery lane. (R1 routes the new
   * per-panel trial through the same provisioning path; this proves the delivery half
   * does not care which.)
   */
  async function trialService(): Promise<ServiceRecord> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'trials',
      enabled: true,
      expectedVersion: null,
      confirmKey: 'trials',
      reason: 'offer a trial',
      idempotencyKey: randomUUID(),
    });
    await setSetting('trial.product_id', await product('trial', null));
    const claimed = await ctx.container.trials.claim(tenantA, systemActor('trial'), customerId, {
      idempotencyKey: 'r3-trial',
    });
    if (claimed.outcome !== 'ISSUED') throw new Error(`trial refused: ${JSON.stringify(claimed)}`);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, claimed.orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('trial not provisioned');
    return service;
  }

  const tap = (data: string, messageId: number) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `r3-update-${String(updateSeq)}-${randomUUID()}`,
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
  const captionOf = (one: Sent) => /name="caption"\r\n\r\n([^\r]*)\r\n/u.exec(one.raw)?.[1];

  /** The delivery message first, then every file after it, each captioned with the username. */
  function expectDetailsThenFiles(service: ServiceRecord): void {
    const details = sent.findIndex(
      (one) =>
        (one.method === 'sendPhoto' || one.method === 'sendMessage') &&
        one.raw.includes(service.subscriptionUrl ?? '-'),
    );
    expect(details, 'the service details were delivered').toBeGreaterThanOrEqual(0);
    const documents = sent
      .map((one, index) => ({ one, index }))
      .filter(({ one }) => one.method === 'sendDocument');
    expect(documents.map(({ one }) => /filename="([^"]+)"/u.exec(one.raw)?.[1])).toEqual([
      `${service.providerUsername}.json`,
      `${service.providerUsername}.txt`,
    ]);
    for (const { one, index } of documents) {
      expect(index, 'files come after the details').toBeGreaterThan(details);
      expect(captionOf(one)).toBe(`👤 نام کاربری: ${service.providerUsername}`);
    }
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
      answers['sendDocument'] = {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: file rejected' },
      };
      const service = await paidService('files-refused');
      expect(service.state).toBe('ACTIVE');
      expect(service.deliveryState).toBe('DELIVERED');
      // One attempt, then it stops: nothing is retried.
      expect(of('sendDocument')).toHaveLength(1);
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

    it('disable edits the same card to inactive and turns the switch into enable, and back', async () => {
      const service = await paidService('switch');
      sent = [];

      // The tap itself sends nothing: no «request registered».
      const tapped = await tap(`u:${service.id}`, CARD);
      expect(tapped.replyKey).toBeNull();
      expect(of('sendMessage')).toHaveLength(0);
      expect(of('editMessageText')).toHaveLength(0);
      expect(of('answerCallbackQuery')).toHaveLength(1);

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
      await tap(`e:${service.id}`, CARD);
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
      await tap(`u:${service.id}`, CARD);
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

    it('a disable the panel cannot perform leaves the card as it was and is told as a failure', async () => {
      const service = await paidService('switch-fail');
      (panel.users as Map<string, unknown>).delete(service.providerUsername);
      sent = [];
      await tap(`u:${service.id}`, CARD);
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id as never))?.state).toBe('ACTIVE');
      expect(of('editMessageText'), 'the card never says inactive').toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'SERVICE_ACTION_FAILED'`,
        ),
      ).toBe(1);
    });

    it('a double tap plans one operation and keeps the first card', async () => {
      const service = await paidService('switch-twice');
      await tap(`u:${service.id}`, CARD);
      await tap(`u:${service.id}`, CARD + 1);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM provisioning_operations
               WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
        ),
      ).toBe(1);
      expect(await count(sql`SELECT count(*)::int AS n FROM operation_card_messages`)).toBe(1);
      sent = [];
      await ctx.container.provisionerLoop.tick();
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
  });
});
