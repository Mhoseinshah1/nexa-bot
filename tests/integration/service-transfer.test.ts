import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  uuidV7Schema,
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
import {
  DrizzleServiceRepository,
  SERVICE_LIFECYCLE_LOCK_CLASS,
} from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
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
 * Package F — a customer hands one of their services to another customer of the tenant
 * (`docs/package-f-service-transfer-audit.md`), end to end: a real PostgreSQL with the
 * migration's triggers, the real provisioner and Marzban adapter against the fake panel on a
 * socket, the real bot runtime, and the real notification dispatcher against a socket
 * standing in for Telegram.
 *
 * Every item of the brief's F9 is a case here, and so is each database rule the migration
 * adds: a rule with no test is a rule that will be silently reverted.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const SENDER_TG = '931001';
const RECIPIENT_TG = '931002';
const THIRD_TG = '931003';
const BLOCKED_TG = '931004';
/** A customer of tenant B ONLY. */
const FOREIGN_TG = '931005';
const PRICE = 250_000n;

const PROMPT = 'سرویس را به چه کاربری می‌خواهید انتقال دهید؟ شناسه کاربری عددی مقصد را ارسال کنید.';
const DONE = '✅ سرویس با موفقیت به کاربر مقصد منتقل شد.';
const UNAVAILABLE =
  'انتقال این سرویس در حال حاضر ممکن نیست. سرویس باید فعال یا خاموش باشد، سرویس تست نباشد و پرداخت، درخواست یا عملیات در جریانی نداشته باشد.';
const HEADING = '🎁 یک سرویس برای شما انتقال داده شد';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('Package F — a customer transfers a service to another customer', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let productId: ProductId;
  let sender: UserId;
  let recipient: UserId;
  let third: UserId;
  let blocked: UserId;
  let owner: ActorContext;
  let updateSeq = 0;
  let keySeq = 0;
  const key = (label: string) => `${label}-${String((keySeq += 1))}`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
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
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-transfer',
        roleKeys: ['owner'],
      }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-transfer-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

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
        price: money(PRICE, 'IRT'),
        display: { ...EMPTY_PRODUCT_DISPLAY, serviceLocationLabel: 'آلمان' },
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;

    sender = await resolve(SENDER_TG, 'مریم');
    recipient = await resolve(RECIPIENT_TG, 'سارا', 'sara_r');
    third = await resolve(THIRD_TG, 'علی');
    blocked = await resolve(BLOCKED_TG, 'رضا');
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-recipient',
      customerId: blocked,
      reason: 'fixture',
    });
    await resolve(FOREIGN_TG, 'بیگانه', undefined, true);
  });

  async function resolve(
    telegramUserId: string,
    firstName: string,
    username?: string,
    inTenantB = false,
  ): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      inTenantB ? tenantB : tenantA,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-transfer-${telegramUserId}`,
        telegramUserId,
        from: {
          id: Number(telegramUserId),
          first_name: firstName,
          ...(username === undefined ? {} : { username }),
        },
        botInstanceId: inTenantB ? BOT_B : BOT_A,
      },
    );
    return resolved.customer.id;
  }

  const fund = (customerId: UserId, label: string, amount = PRICE) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key(`${label}-credit`),
      direction: 'CREDIT',
      amountMinor: amount,
      currency: 'IRT',
      note: 'fixture',
    });

  /** A NEW_SERVICE order paid from the sender's wallet, provisioned and delivered. */
  async function deliveredService(label: string, buyer: UserId = sender): Promise<ServiceRecord> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(label), {
      idempotencyKey: key(`${label}-draft`),
      customerId: buyer,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(label), {
      idempotencyKey: key(`${label}-confirm`),
      customerId: buyer,
      orderId: draft.id,
    });
    await fund(buyer, label);
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(label), buyer, {
      idempotencyKey: key(`${label}-pay`),
      orderId: confirmed.id as OrderId,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service.state !== 'ACTIVE' || service.deliveryState !== 'DELIVERED') {
      throw new Error(`the fixture must start ACTIVE and DELIVERED: ${JSON.stringify(service)}`);
    }
    sent = [];
    return service;
  }

  /** How many times the service has changed hands: the version a fresh screen carries. */
  const versionOf = (serviceId: string) =>
    count(
      sql`SELECT count(*)::int AS n FROM service_ownership_transfers WHERE service_id = ${serviceId}`,
    );

  /**
   * A confirmation, as the bot would send it. Its ownership version is read when the call
   * is made — a screen drawn just now — unless a test names the version of an older one.
   * An id that is no UUID has no version; the service refuses it as not found before any
   * version is compared.
   */
  const transfer = async (
    serviceId: string,
    recipientTelegramUserId: string,
    idempotencyKey = key('transfer'),
    from: UserId = sender,
    ownershipVersion?: number,
  ) =>
    ctx.container.serviceTransfers.transfer(tenantA, systemActor('transfer'), {
      customerId: from,
      serviceId,
      recipientTelegramUserId,
      ownershipVersion:
        ownershipVersion ??
        (uuidV7Schema.safeParse(serviceId).success ? await versionOf(serviceId) : 0),
      botInstanceId: BOT_A,
      idempotencyKey,
    });

  async function refusalOf(promise: Promise<unknown>): Promise<{
    code: string;
    details: Record<string, unknown>;
  }> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return { code: error.code, details: error.details };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  const ownerOf = async (serviceId: string) =>
    (await services.findById(tenantA, serviceId))?.customerId;

  const transfersOf = (serviceId: string) =>
    count(
      sql`SELECT count(*)::int AS n FROM service_ownership_transfers WHERE service_id = ${serviceId}`,
    );

  const tapUpdate = (data: string, telegramUserId = SENDER_TG) => {
    updateSeq += 1;
    return {
      idempotencyKey: `transfer-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    };
  };

  const textUpdate = (text: string, telegramUserId = SENDER_TG) => {
    updateSeq += 1;
    return {
      idempotencyKey: `transfer-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
      update: {
        update_id: updateSeq,
        message: {
          message_id: updateSeq,
          date: 0,
          text,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
        },
      },
    };
  };

  const handle = (update: ReturnType<typeof tapUpdate> | ReturnType<typeof textUpdate>) =>
    ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);

  /** The messages the stand-in received, never the bare `answerCallbackQuery` beside them. */
  const messages = () => sent.filter((one) => !one.url.includes('/answerCallbackQuery'));
  const lastSent = () => messages().at(-1)?.body ?? {};
  const lastText = () => String(lastSent().text ?? '');
  const callbacksOf = (body: Record<string, unknown>): string[] => {
    const markup = body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] };
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
  };

  /** Drives the bot flow to the confirmation screen and returns its confirm callback. */
  async function askAndType(serviceId: string, typed: string): Promise<string> {
    await handle(tapUpdate(`ta:${serviceId}`));
    expect(lastText()).toBe(PROMPT);
    await handle(textUpdate(typed));
    const confirm = callbacksOf(lastSent()).find((data) => data.startsWith('tc:'));
    if (confirm === undefined) throw new Error(`no confirmation: ${lastText()}`);
    return confirm;
  }

  // =========================================================================
  // The happy path, through the bot (F1, F6, F7)
  // =========================================================================

  it('transfers a service from the service detail, confirmed with the brief’s own words', async () => {
    const service = await deliveredService('happy');

    // The detail draws the button, on the refund request's row.
    await handle(tapUpdate(`s:${service.id}`));
    const detail = lastSent();
    expect(callbacksOf(detail)).toContain(`ta:${service.id}`);
    expect(JSON.stringify(detail)).toContain('🔄 انتقال سرویس');

    // The prompt, then the summary: the account, the location, what is left, the recipient.
    await handle(tapUpdate(`ta:${service.id}`));
    expect(lastText()).toBe(PROMPT);
    await handle(textUpdate(RECIPIENT_TG));
    const confirmation = lastText();
    expect(confirmation).toContain(service.providerUsername);
    expect(confirmation).toContain('آلمان');
    expect(confirmation).toContain(RECIPIENT_TG);
    expect(confirmation).toContain('سارا @sara_r');
    expect(confirmation).toContain('روز');
    const confirmButton = (
      lastSent().reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat()[0]!;
    expect(confirmButton.text).toBe('✅ تأیید انتقال سرویس');
    expect(confirmButton.callback_data).toBe(`tc:${service.id}.${RECIPIENT_TG}.0`);
    // Nothing moved on the way to the confirmation.
    expect(await ownerOf(service.id)).toBe(sender);
    expect(await transfersOf(service.id)).toBe(0);

    await handle(tapUpdate(confirmButton.callback_data));
    expect(lastText()).toBe(DONE);
    expect(await ownerOf(service.id)).toBe(recipient);

    const [row] = await rows<{
      from_customer_id: string;
      to_customer_id: string;
      actor_type: string;
      bot_instance_id: string;
      id: string;
    }>(sql`SELECT * FROM service_ownership_transfers WHERE service_id = ${service.id}`);
    expect(row).toMatchObject({
      from_customer_id: sender,
      to_customer_id: recipient,
      actor_type: 'SYSTEM_JOB',
      bot_instance_id: BOT_A,
    });

    // F7: an explicit audit row and an event, with the ids and nothing else.
    const audits = await rows<{ before: unknown; after: unknown; result: string }>(
      sql`SELECT before, after, result FROM audit_logs
           WHERE action = 'service.transfer' AND entity_id = ${service.id}`,
    );
    expect(audits).toEqual([
      {
        before: { customerId: sender },
        after: { customerId: recipient, transferId: row!.id },
        result: 'SUCCESS',
      },
    ]);
    const events = await rows<{ payload: unknown; aggregate_type: string }>(
      sql`SELECT payload, aggregate_type FROM outbox_messages
           WHERE event_type = 'ServiceOwnershipTransferred' AND aggregate_id = ${service.id}`,
    );
    expect(events).toEqual([
      {
        aggregate_type: 'Service',
        payload: { serviceId: service.id, fromCustomerId: sender, toCustomerId: recipient },
      },
    ]);
    // Neither carries the subscription link or its reference.
    const fresh = await services.findById(tenantA, service.id);
    for (const leak of [fresh!.subscriptionUrl ?? 'no-url', fresh!.subscriptionRef]) {
      expect(JSON.stringify(audits)).not.toContain(leak);
      expect(JSON.stringify(events)).not.toContain(leak);
      expect(
        JSON.stringify(row, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ).not.toContain(leak);
    }

    // F6: the recipient's notification is queued in the same transaction, for the transfer.
    const queued = await rows<{ customer_id: string; subject_id: string; state: string }>(
      sql`SELECT customer_id, subject_id, state FROM customer_notifications
           WHERE kind = 'SERVICE_TRANSFER_RECEIVED'`,
    );
    expect(queued).toEqual([{ customer_id: recipient, subject_id: row!.id, state: 'PENDING' }]);
  });

  it('takes the service out of the sender’s view and puts it in the recipient’s', async () => {
    const service = await deliveredService('views');
    await transfer(service.id, RECIPIENT_TG);

    // The sender: the same answer as a service that does not exist.
    await handle(tapUpdate(`s:${service.id}`));
    const senderSees = JSON.stringify(lastSent());
    expect(senderSees).not.toContain(service.providerUsername);
    expect((await ctx.container.provisioning.pageForCustomer(tenantA, sender, 1)).count).toBe(0);
    await expect(
      ctx.container.provisioning.getForCustomer(tenantA, sender, service.id),
    ).rejects.toMatchObject({ code: 'commerce.service_not_found' });

    // The recipient: their list, and the detail through their own ownership check.
    const page = await ctx.container.provisioning.pageForCustomer(tenantA, recipient, 1);
    expect(page.items.map((one) => one.id)).toEqual([service.id]);
    await handle(tapUpdate(`s:${service.id}`, RECIPIENT_TG));
    expect(JSON.stringify(lastSent())).toContain(service.providerUsername);
  });

  it('tells the recipient through the dispatcher, with one «مشخصات سرویس» button opening the service', async () => {
    const service = await deliveredService('notify');
    const done = await transfer(service.id, RECIPIENT_TG);
    sent = [];
    await ctx.container.customerNotificationLoop.tick();

    const toRecipient = messages().filter((one) => String(one.body.chat_id) === RECIPIENT_TG);
    expect(toRecipient).toHaveLength(1);
    const body = toRecipient[0]!.body;
    const text = String(body.text);
    expect(text.startsWith(HEADING)).toBe(true);
    expect(text).toContain(service.providerUsername);
    expect(text).toContain('آلمان');
    const keyboard = (
      body.reply_markup as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();
    expect(keyboard).toEqual([{ text: 'مشخصات سرویس', callback_data: `s:${service.id}` }]);
    // Nothing went to the sender, and the row is resolved.
    expect(messages().filter((one) => String(one.body.chat_id) === SENDER_TG)).toHaveLength(0);
    expect(
      await rows<{ state: string }>(
        sql`SELECT state FROM customer_notifications WHERE subject_id = ${done.transfer.id}`,
      ),
    ).toEqual([{ state: 'DELIVERED' }]);

    // The button opens the service through the recipient's own ownership check.
    sent = [];
    await handle(tapUpdate(`s:${service.id}`, RECIPIENT_TG));
    expect(JSON.stringify(lastSent())).toContain(service.providerUsername);
  });

  it('supersedes the notification of a recipient who no longer holds the service when it is sent', async () => {
    const service = await deliveredService('passed-on');
    const first = await transfer(service.id, RECIPIENT_TG);
    // The recipient passes it on before the lane runs.
    const second = await transfer(service.id, THIRD_TG, key('onward'), recipient);
    sent = [];
    await ctx.container.customerNotificationLoop.tick();

    const states = await rows<{ subject_id: string; state: string }>(
      sql`SELECT subject_id, state FROM customer_notifications
           WHERE kind = 'SERVICE_TRANSFER_RECEIVED' ORDER BY created_at`,
    );
    expect(states).toEqual([
      { subject_id: first.transfer.id, state: 'SUPERSEDED' },
      { subject_id: second.transfer.id, state: 'DELIVERED' },
    ]);
    expect(messages().filter((one) => String(one.body.chat_id) === RECIPIENT_TG)).toHaveLength(0);
    expect(messages().filter((one) => String(one.body.chat_id) === THIRD_TG)).toHaveLength(1);
  });

  // =========================================================================
  // The recipient (F2)
  // =========================================================================

  it('refuses a transfer to oneself, and writes nothing', async () => {
    const service = await deliveredService('self');
    const refused = await refusalOf(transfer(service.id, SENDER_TG));
    expect(refused).toMatchObject({
      code: 'commerce.service_transfer_recipient_refused',
      details: { refusal: 'RECIPIENT_SELF' },
    });
    expect(await transfersOf(service.id)).toBe(0);
    expect(await ownerOf(service.id)).toBe(sender);

    // In the bot: its own sentence, and the window stays open for the right id.
    await handle(tapUpdate(`ta:${service.id}`));
    await handle(textUpdate(SENDER_TG));
    expect(lastText()).toContain('نمی‌توانید سرویس را به خودتان انتقال دهید');
    await handle(textUpdate(RECIPIENT_TG));
    expect(callbacksOf(lastSent())).toContain(`tc:${service.id}.${RECIPIENT_TG}.0`);
  });

  it('refuses an unknown recipient and text that is no numeric id, keeping the window open', async () => {
    const service = await deliveredService('unknown');
    expect(await refusalOf(transfer(service.id, '939999'))).toMatchObject({
      details: { refusal: 'RECIPIENT_UNKNOWN' },
    });
    expect(await refusalOf(transfer(service.id, 'not-an-id'))).toMatchObject({
      details: { refusal: 'RECIPIENT_INVALID' },
    });

    await handle(tapUpdate(`ta:${service.id}`));
    await handle(textUpdate('@sara_r'));
    expect(lastText()).toContain('این یک شناسه کاربری عددی معتبر نیست');
    await handle(textUpdate('939999'));
    expect(lastText()).toContain('کاربری با این شناسه در ربات پیدا نشد');
    // Persian digits are read as the id they spell.
    await handle(textUpdate('۹۳۱۰۰۲'));
    expect(callbacksOf(lastSent())).toContain(`tc:${service.id}.${RECIPIENT_TG}.0`);
    expect(await transfersOf(service.id)).toBe(0);
  });

  it('refuses a blocked recipient with the same sentence as an unknown one', async () => {
    const service = await deliveredService('blocked');
    expect(await refusalOf(transfer(service.id, BLOCKED_TG))).toMatchObject({
      details: { refusal: 'RECIPIENT_BLOCKED' },
    });
    await handle(tapUpdate(`ta:${service.id}`));
    await handle(textUpdate(BLOCKED_TG));
    const blockedAnswer = lastText();
    await handle(textUpdate('939999'));
    expect(blockedAnswer).toBe(lastText());
    expect(await ownerOf(service.id)).toBe(sender);
    expect(blocked).toBeDefined();
  });

  it('never crosses a tenant: a customer of another tenant is unknown here', async () => {
    const service = await deliveredService('cross-tenant');
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customers WHERE telegram_user_id = ${FOREIGN_TG}`,
      ),
    ).toBe(1);
    expect(await refusalOf(transfer(service.id, FOREIGN_TG))).toMatchObject({
      details: { refusal: 'RECIPIENT_UNKNOWN' },
    });
    expect(await transfersOf(service.id)).toBe(0);
  });

  // =========================================================================
  // The service (F3)
  // =========================================================================

  it('refuses a service with an OPEN refund request', async () => {
    const service = await deliveredService('refund');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_refund_requests',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key('feature-flag'),
      confirmKey: 'customer_refund_requests',
      reason: 'Package F integration.',
    });
    await ctx.container.serviceRefundRequests.file(tenantA, systemActor('file'), {
      customerId: sender,
      serviceId: service.id,
      botInstanceId: BOT_A,
      reason: 'دیگر لازم ندارم',
      idempotencyKey: key('refund-file'),
    });
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      code: 'commerce.service_not_transferable',
      details: { reason: 'REFUND_REQUESTED' },
    });
    // The button is not drawn either.
    expect(await ctx.container.serviceTransfers.offered(tenantA, service)).toBe(false);
  });

  it('refuses a service with a paid renewal not yet applied, and one awaiting payment', async () => {
    const service = await deliveredService('renewal');
    await fund(sender, 'renew');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('renew'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('renew-quote') },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor('renew'), sender, {
      orderId: order.id,
      idempotencyKey: key('renew-confirm'),
    });
    // AWAITING_PAYMENT: the sender may be paying for it right now.
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      details: { reason: 'PAYMENT_PENDING' },
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('renew'), sender, {
      idempotencyKey: key('renew-pay'),
      orderId: order.id,
    });
    // PAID, and its RENEW planned and not yet applied.
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      details: { reason: 'OPERATION_PENDING' },
    });
    // Once applied, the service moves — with the renewal still the sender's purchase.
    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();
    const done = await transfer(service.id, RECIPIENT_TG);
    expect(done.replayed).toBe(false);
    expect(
      await rows<{ customer_id: string }>(
        sql`SELECT customer_id FROM service_commercial_actions WHERE order_id = ${order.id}`,
      ),
    ).toEqual([{ customer_id: sender }]);
  });

  it.each(['ADD_TRAFFIC', 'ADD_TIME'] as const)(
    'refuses a service with a paid %s not yet applied',
    async (kind) => {
      const service = await deliveredService(`addon-${kind}`);
      const addon = await ctx.container.serviceAddons.create(tenantA, owner, {
        idempotencyKey: key('addon'),
        draft: {
          kind,
          title: kind === 'ADD_TRAFFIC' ? 'بسته ۱۰ گیگ' : 'بسته ۱۵ روز',
          sortOrder: 10,
          specification: {
            kind,
            trafficBytes: kind === 'ADD_TRAFFIC' ? 10_737_418_240n : null,
            durationDays: kind === 'ADD_TIME' ? 15 : null,
          },
          price: money(50_000n, 'IRT'),
        },
      });
      await ctx.container.serviceAddons.activate(tenantA, owner, {
        idempotencyKey: key('addon-on'),
        addonId: addon.id,
      });
      await fund(sender, 'addon');
      const { order } = await ctx.container.commercialActions.draft(
        tenantA,
        systemActor('addon'),
        sender,
        { serviceId: service.id, kind, addonId: addon.id, idempotencyKey: key('addon-quote') },
      );
      await ctx.container.commercialActions.confirm(tenantA, systemActor('addon'), sender, {
        orderId: order.id,
        idempotencyKey: key('addon-confirm'),
      });
      await ctx.container.payments.settleFromWallet(tenantA, systemActor('addon'), sender, {
        idempotencyKey: key('addon-pay'),
        orderId: order.id,
      });
      expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
        details: { reason: 'OPERATION_PENDING' },
      });
      expect(await ownerOf(service.id)).toBe(sender);
    },
  );

  it('refuses a service an operator has planned to terminate, and a usage read the sender asked for', async () => {
    const service = await deliveredService('terminate-planned');
    // A usage read the sender asked for, still PLANNED.
    const sync = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO provisioning_operations
            (id, tenant_id, operation_id, service_id, panel_id, type, state, requested_by_customer_id)
          VALUES (${sync}, ${tenantA.tenantId}, substr(md5(random()::text), 1, 16),
                  ${service.id}, ${panelId}, 'SYNC_USAGE', 'PLANNED', ${sender})`,
    );
    // A usage read the sender asked for is announced to whoever owns the service when it ends.
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      details: { reason: 'OPERATION_PENDING' },
    });
    // Once decided, an operator's planned terminate holds it back the same way.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'FAILED', completed_at = now() WHERE id = ${sync}`,
    );
    expect((await ctx.container.serviceTransfers.offered(tenantA, service)) as boolean).toBe(true);
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: key('terminate'),
    });
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      details: { reason: 'OPERATION_PENDING' },
    });
  });

  it('lets a SCHEDULED usage read through: nobody asked for it and nobody is told', async () => {
    const service = await deliveredService('scheduled-sync');
    await ctx.container.database.db.execute(
      sql`INSERT INTO provisioning_operations
            (id, tenant_id, operation_id, service_id, panel_id, type, state, requested_by_customer_id)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, substr(md5(random()::text), 1, 16),
                  ${service.id}, ${panelId}, 'SYNC_USAGE', 'PLANNED', NULL)`,
    );
    expect((await transfer(service.id, RECIPIENT_TG)).replayed).toBe(false);
  });

  it.each(['EXPIRED', 'UNRECONCILED', 'TERMINATED', 'PENDING_PROVISION'] as const)(
    'refuses a service that is %s',
    async (state) => {
      const service = await deliveredService(`state-${state}`);
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = ${state},
              provisioned_at = CASE WHEN ${state} IN ('UNRECONCILED', 'PENDING_PROVISION') THEN NULL ELSE provisioned_at END,
              terminated_at = CASE WHEN ${state} = 'TERMINATED' THEN now() ELSE NULL END
            WHERE id = ${service.id}`,
      );
      expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
        code: 'commerce.service_not_transferable',
        details: { reason: 'SERVICE_STATE' },
      });
      expect(await transfersOf(service.id)).toBe(0);
    },
  );

  it('transfers a SUSPENDED service, which the brief names beside an ACTIVE one', async () => {
    const service = await deliveredService('suspended');
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${service.id}`,
    );
    expect((await transfer(service.id, RECIPIENT_TG)).replayed).toBe(false);
    expect(await ownerOf(service.id)).toBe(recipient);
  });

  it.each(['PENDING', 'UNCONFIRMED', 'FAILED'] as const)(
    'refuses a service whose link is %s rather than DELIVERED',
    async (deliveryState) => {
      const service = await deliveredService(`delivery-${deliveryState}`);
      await ctx.container.database.db.execute(
        sql`UPDATE services SET delivery_state = ${deliveryState}, delivered_at = NULL
             WHERE id = ${service.id}`,
      );
      expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
        details: { reason: 'NOT_DELIVERED' },
      });
    },
  );

  it('refuses a trial, and draws no button for one', async () => {
    // R1: the panel's own trial, issued from no product.
    await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: key('trial-config'),
      expectedRevision: 0,
      enabled: true,
      trafficAmount: '1',
      trafficUnit: 'GB',
      durationHours: 24,
      label: null,
    });
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'trials',
      enabled: true,
      expectedVersion: null,
      confirmKey: 'trials',
      reason: 'offer a trial',
      idempotencyKey: key('trial-flag'),
    });
    const claimed = await ctx.container.trials.claim(tenantA, systemActor('trial'), sender, {
      idempotencyKey: key('trial-claim'),
      panelId,
    });
    if (claimed.outcome !== 'ISSUED') throw new Error(JSON.stringify(claimed));
    await ctx.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, claimed.serviceId);
    expect(service?.state).toBe('ACTIVE');
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(await refusalOf(transfer(service!.id, RECIPIENT_TG))).toMatchObject({
      details: { reason: 'TRIAL' },
    });
    expect(await ctx.container.serviceTransfers.offered(tenantA, service!)).toBe(false);
    // And the service detail the customer actually sees draws no transfer button — the
    // bot asks the evaluator, never merely whether the feature is wired.
    await handle(tapUpdate(`s:${service!.id}`));
    const detail = callbacksOf(lastSent());
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.some((data) => data.startsWith('ta:'))).toBe(false);
  });

  it('answers another customer’s service, and one that does not exist, as not found', async () => {
    const service = await deliveredService('foreign');
    expect(
      await refusalOf(transfer(service.id, THIRD_TG, key('foreign'), recipient)),
    ).toMatchObject({ code: 'commerce.service_not_found' });
    expect(await refusalOf(transfer(ctx.container.ids.uuid(), RECIPIENT_TG))).toMatchObject({
      code: 'commerce.service_not_found',
    });
    expect(await refusalOf(transfer('not-a-uuid', RECIPIENT_TG))).toMatchObject({
      code: 'commerce.service_not_found',
    });
    // In the bot, a foreign service's ask is the ordinary unknown-service answer.
    await handle(tapUpdate(`ta:${service.id}`, RECIPIENT_TG));
    expect(lastText()).not.toBe(PROMPT);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_text_captures
                       WHERE purpose = 'SERVICE_TRANSFER_RECIPIENT'`),
    ).toBe(0);
  });

  // =========================================================================
  // Races (F3's locking discipline)
  // =========================================================================

  /** Holds the service row from outside, with `work` done inside, until released. */
  async function holdRow(
    serviceId: string,
    work: (tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) => Promise<void>,
  ): Promise<{ release: () => Promise<void> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    let held!: () => void;
    const holding = new Promise<void>((resolveHeld) => (held = resolveHeld));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM services WHERE id = ${serviceId} FOR UPDATE`);
      await work(tx as never);
      held();
      await gate;
    });
    await holding;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  /** Resolves once `expected` backends of THIS database wait on a lock. */
  async function waiters(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const n = await count(
        sql`SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
              JOIN pg_stat_activity a ON a.pid = l.pid
             WHERE NOT l.granted AND a.datname = current_database()`,
      );
      if (n >= expected) return;
      if (Date.now() > deadline) throw new Error(`${what} never waited`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  it('loses to a terminate that holds the service first, and moves nothing', async () => {
    const service = await deliveredService('terminate-race');
    const holder = await holdRow(service.id, async (tx) => {
      await tx.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${service.id}`,
      );
    });
    const racing = refusalOf(transfer(service.id, RECIPIENT_TG));
    await waiters(1, 'the transfer');
    await holder.release();
    expect(await racing).toMatchObject({
      code: 'commerce.service_not_transferable',
      details: { reason: 'SERVICE_STATE' },
    });
    expect(await transfersOf(service.id)).toBe(0);
    expect(await ownerOf(service.id)).toBe(sender);
  });

  it('takes the lifecycle lock a settlement takes, and waits for whoever holds it', async () => {
    const service = await deliveredService('lifecycle');
    // Held from outside: the transfer takes the row, then waits here.
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    let held!: () => void;
    const holding = new Promise<void>((resolveHeld) => (held = resolveHeld));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SERVICE_LIFECYCLE_LOCK_CLASS},
              hashtext(${`${tenantA.tenantId}:${service.id}`}))`,
      );
      held();
      await gate;
    });
    await holding;
    const racing = transfer(service.id, RECIPIENT_TG);
    await waiters(1, 'the transfer, on the lifecycle lock');
    // The transfer holds the row by now; a second transfer queues behind it.
    expect(await ownerOf(service.id)).toBe(sender);
    release();
    await holder;
    expect((await racing).replayed).toBe(false);
    expect(await ownerOf(service.id)).toBe(recipient);
  });

  it('serialises two transfers to two recipients: exactly one moves the service', async () => {
    const service = await deliveredService('two-recipients');
    const holder = await holdRow(service.id, async () => undefined);
    const racing = Promise.allSettled([
      transfer(service.id, RECIPIENT_TG),
      transfer(service.id, THIRD_TG),
    ]);
    await waiters(2, 'the two transfers');
    await holder.release();
    const results = await racing;
    const won = results.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe('commerce.service_not_found');
    expect(await transfersOf(service.id)).toBe(1);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof transfer>>>).value;
    expect(await ownerOf(service.id)).toBe(winner.transfer.toCustomerId);
  });

  it('serialises a double tap under two keys: one transfer, and both answered with it', async () => {
    const service = await deliveredService('double-tap');
    const holder = await holdRow(service.id, async () => undefined);
    const racing = Promise.all([
      transfer(service.id, RECIPIENT_TG),
      transfer(service.id, RECIPIENT_TG),
    ]);
    await waiters(2, 'the two taps');
    await holder.release();
    const [one, two] = await racing;
    expect(one.transfer.id).toBe(two.transfer.id);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(await transfersOf(service.id)).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE kind = 'SERVICE_TRANSFER_RECEIVED'`),
    ).toBe(1);
  });

  // =========================================================================
  // Idempotency (F8)
  // =========================================================================

  it('answers a replayed key with the transfer it made, and a later tap with the same one', async () => {
    const service = await deliveredService('replay');
    const first = await transfer(service.id, RECIPIENT_TG, 'the-key');
    const again = await transfer(service.id, RECIPIENT_TG, 'the-key');
    expect(again).toEqual({ ...first, replayed: true });
    const later = await transfer(service.id, RECIPIENT_TG, 'another-key');
    expect(later.transfer.id).toBe(first.transfer.id);
    expect(later.replayed).toBe(true);
    // A key reused for a different service is a refusal, not a replay.
    const other = await deliveredService('replay-other');
    expect(await refusalOf(transfer(other.id, RECIPIENT_TG, 'the-key'))).toMatchObject({
      code: 'commerce.request_invalid',
    });
    expect(await transfersOf(service.id)).toBe(1);
    expect(await transfersOf(other.id)).toBe(0);

    // In the bot: the confirmation tapped twice says the same thing twice.
    const third = await deliveredService('replay-bot');
    const confirm = await askAndType(third.id, RECIPIENT_TG);
    await handle(tapUpdate(confirm));
    expect(lastText()).toBe(DONE);
    await handle(tapUpdate(confirm));
    expect(lastText()).toBe(DONE);
    // And one redelivered update is one transfer.
    const redelivered = tapUpdate(confirm);
    await handle(redelivered);
    await handle(redelivered);
    expect(await transfersOf(third.id)).toBe(1);
  });

  it('is given back by its recipient: the newest row counts, never the first', async () => {
    const service = await deliveredService('given-back');
    expect((await transfer(service.id, RECIPIENT_TG)).replayed).toBe(false);
    // The database admits B → A only because the NEWEST row names it; the first row
    // (A → B) names the opposite direction.
    const back = await transfer(service.id, SENDER_TG, key('back'), recipient);
    expect(back.replayed).toBe(false);
    expect(await ownerOf(service.id)).toBe(sender);
    expect(await transfersOf(service.id)).toBe(2);
    // The recipient taps their confirmation (drawn at version 1) again under a new key: the
    // newest row is theirs, so the answer is that transfer — not "not found" because the
    // first row was not.
    expect(await transfer(service.id, SENDER_TG, key('back-again'), recipient, 1)).toEqual({
      ...back,
      replayed: true,
    });
  });

  it('refuses a confirmation drawn before the service changed hands and came back', async () => {
    const service = await deliveredService('stale-confirm');
    // The sender's confirmation, drawn at version 0 and tapped: A → B.
    const confirm = await askAndType(service.id, RECIPIENT_TG);
    expect(confirm.endsWith('.0')).toBe(true);
    await handle(tapUpdate(confirm));
    expect(lastText()).toBe(DONE);
    // B gives it back: the service is A's again, at version 2.
    await transfer(service.id, SENDER_TG, key('stale-back'), recipient);
    expect(await ownerOf(service.id)).toBe(sender);

    // A taps the SAME old keyboard. The service is A's, so no replay applies: the version
    // the screen carries is all that tells it apart from a fresh confirmation.
    await handle(tapUpdate(confirm));
    expect(lastText()).toBe(UNAVAILABLE);
    expect(await ownerOf(service.id)).toBe(sender);
    expect(await transfersOf(service.id)).toBe(2);
    expect(
      await refusalOf(transfer(service.id, RECIPIENT_TG, key('stale-direct'), sender, 0)),
    ).toMatchObject({
      code: 'commerce.service_not_transferable',
      details: { reason: 'CONFIRMATION_STALE' },
    });

    // A screen drawn now carries the new version, and it moves the service.
    const fresh = await askAndType(service.id, RECIPIENT_TG);
    expect(fresh.endsWith('.2')).toBe(true);
    await handle(tapUpdate(fresh));
    expect(lastText()).toBe(DONE);
    expect(await ownerOf(service.id)).toBe(recipient);
    expect(await transfersOf(service.id)).toBe(3);
  });

  it('refuses a sender who has been blocked, and moves nothing', async () => {
    const service = await deliveredService('blocked-sender');
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-sender',
      customerId: sender,
      reason: 'fixture',
    });
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      code: 'commerce.customer_blocked',
    });
    expect(await transfersOf(service.id)).toBe(0);
    expect(await ownerOf(service.id)).toBe(sender);
  });

  it('refuses a transfer in a tenant that has stopped accepting work', async () => {
    const service = await deliveredService('stopped-tenant');
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await refusalOf(transfer(service.id, RECIPIENT_TG))).toMatchObject({
      code: 'commerce.request_invalid',
    });
    expect(await transfersOf(service.id)).toBe(0);
    expect(await ownerOf(service.id)).toBe(sender);
  });

  // =========================================================================
  // What does not move (F4, F5)
  // =========================================================================

  it('leaves every financial row exactly as it was', async () => {
    const created = await ctx.container.cashbackRules.create(tenantA, owner, {
      idempotencyKey: key('cashback'),
      write: {
        label: 'کش‌بک',
        percent: 10,
        appliesTo: ['NEW_SERVICE', 'RENEW'],
        productId: null,
        categoryId: null,
        startsAt: null,
        endsAt: null,
      },
    });
    await ctx.container.cashbackRules.activate(tenantA, owner, {
      idempotencyKey: key('cashback-on'),
      ruleId: created.id,
    });
    const service = await deliveredService('history');
    await ctx.container.provisionerLoop.tick();
    await fund(sender, 'history-renew');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('history'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('history-quote') },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor('history'), sender, {
      orderId: order.id,
      idempotencyKey: key('history-confirm'),
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('history'), sender, {
      idempotencyKey: key('history-pay'),
      orderId: order.id,
    });
    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();
    expect(await count(sql`SELECT count(*)::int AS n FROM order_cashback`)).toBeGreaterThan(0);

    const tables = [
      'orders',
      'payments',
      'wallet_entries',
      'order_cashback',
      'cashback_reversals',
      'order_referral_commissions',
      'referral_commission_reversals',
      'referrals',
      'discount_redemptions',
      'order_reseller_terms',
      'service_commercial_actions',
      'refunds',
      'trial_grants',
      'service_username_reservations',
      'panel_capacity_reservations',
    ];
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const table of tables) {
        out[table] = await rows(
          sql`SELECT row_to_json(t)::text AS r FROM ${sql.identifier(table)} t ORDER BY 1`,
        );
      }
      out.operations = await rows(
        sql`SELECT row_to_json(t)::text AS r FROM provisioning_operations t ORDER BY 1`,
      );
      return out;
    };
    const before = await snapshot();
    const balanceBefore = await ctx.container.wallet.balance(tenantA, owner, sender);
    await transfer(service.id, RECIPIENT_TG);
    expect(await snapshot()).toEqual(before);
    expect(await ctx.container.wallet.balance(tenantA, owner, sender)).toEqual(balanceBefore);
    expect((await ctx.container.wallet.balance(tenantA, owner, recipient)).amountMinor).toBe(0n);
    // The order still names its payer.
    expect(
      await rows<{ customer_id: string }>(
        sql`SELECT o.customer_id FROM orders o JOIN services s ON s.order_id = o.id
             WHERE s.id = ${service.id}`,
      ),
    ).toEqual([{ customer_id: sender }]);
  });

  it('never calls the provider: no username change, no re-creation, no rotation', async () => {
    const service = await deliveredService('provider');
    const before = {
      requests: panel.requests.length,
      user: JSON.stringify(panel.users.get(service.providerUsername)),
      row: await services.findById(tenantA, service.id),
    };
    await transfer(service.id, RECIPIENT_TG);
    expect(panel.requests.length).toBe(before.requests);
    expect(JSON.stringify(panel.users.get(service.providerUsername))).toBe(before.user);
    const after = await services.findById(tenantA, service.id);
    expect({
      providerUsername: after!.providerUsername,
      subscriptionUrl: after!.subscriptionUrl,
      subscriptionRef: after!.subscriptionRef,
      providerClientId: after!.providerClientId,
      panelId: after!.panelId,
      orderId: after!.orderId,
      state: after!.state,
      expiresAt: after!.expiresAt,
      trafficLimitBytes: after!.trafficLimitBytes,
    }).toEqual({
      providerUsername: before.row!.providerUsername,
      subscriptionUrl: before.row!.subscriptionUrl,
      subscriptionRef: before.row!.subscriptionRef,
      providerClientId: before.row!.providerClientId,
      panelId: before.row!.panelId,
      orderId: before.row!.orderId,
      state: before.row!.state,
      expiresAt: before.row!.expiresAt,
      trafficLimitBytes: before.row!.trafficLimitBytes,
    });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM provisioning_operations
                       WHERE service_id = ${service.id} AND state = 'PLANNED'`),
    ).toBe(0);
  });

  it('clears the sender’s note, so the recipient never reads it', async () => {
    const service = await deliveredService('note');
    const note = 'رمز وای‌فای خانه ۱۲۳۴';
    await ctx.container.provisioning.setCustomerNote(
      tenantA,
      systemActor('note'),
      sender,
      service.id,
      note,
    );
    await transfer(service.id, RECIPIENT_TG);
    expect((await services.findById(tenantA, service.id))?.customerNote).toBeNull();
    sent = [];
    await handle(tapUpdate(`s:${service.id}`, RECIPIENT_TG));
    expect(JSON.stringify(lastSent())).toContain(service.providerUsername);
    expect(JSON.stringify(sent)).not.toContain(note);
    await ctx.container.customerNotificationLoop.tick();
    expect(JSON.stringify(sent)).not.toContain(note);
  });

  it('refuses the recipient a refund of money somebody else paid', async () => {
    const service = await deliveredService('recipient-refund');
    await transfer(service.id, RECIPIENT_TG);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_refund_requests',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key('feature-flag'),
      confirmKey: 'customer_refund_requests',
      reason: 'Package F integration.',
    });
    const moved = await services.findById(tenantA, service.id);
    expect(await ctx.container.serviceRefundRequests.offeredFor(tenantA, moved!)).toBe(false);
  });

  // =========================================================================
  // The old owner's commercial draft
  // =========================================================================

  it('refuses to confirm the old owner’s renewal draft for a service they gave away', async () => {
    const service = await deliveredService('old-draft');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('old-draft'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('old-quote') },
    );
    // A DRAFT does not hold the transfer back.
    await transfer(service.id, RECIPIENT_TG);
    expect(
      await refusalOf(
        ctx.container.commercialActions.confirm(tenantA, systemActor('old-draft'), sender, {
          orderId: order.id,
          idempotencyKey: key('old-confirm'),
        }),
      ),
    ).toMatchObject({ code: 'commerce.service_not_found' });
    expect(
      (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${order.id}`))[0]
        ?.state,
    ).toBe('DRAFT');
  });

  /**
   * The race the confirmation cannot close alone: an order confirmed in the moment a transfer
   * committed. Made deterministic by writing the transfer the way the database admits one —
   * the row, then the owner — after the old owner's order is already awaiting payment.
   */
  async function transferBehindTheOrdersBack(serviceId: string, to: UserId): Promise<void> {
    await ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO service_ownership_transfers
              (id, tenant_id, service_id, from_customer_id, to_customer_id, bot_instance_id,
               idempotency_key, actor_type, actor_label, correlation_id)
            VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${serviceId}, ${sender},
                    ${to}, ${BOT_A}, ${key('raw')}, 'SYSTEM_JOB', 'test', 'test')`,
      );
      await tx.execute(sql`UPDATE services SET customer_id = ${to} WHERE id = ${serviceId}`);
    });
  }

  it('refuses to settle the old owner’s renewal from the wallet, and takes nothing', async () => {
    const service = await deliveredService('old-wallet');
    await fund(sender, 'old-wallet-renew');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('old-wallet'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('ow-quote') },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor('old-wallet'), sender, {
      orderId: order.id,
      idempotencyKey: key('ow-confirm'),
    });
    await transferBehindTheOrdersBack(service.id, recipient);
    const balance = await ctx.container.wallet.balance(tenantA, owner, sender);
    const refused = await refusalOf(
      ctx.container.payments.settleFromWallet(tenantA, systemActor('old-wallet'), sender, {
        idempotencyKey: key('ow-pay'),
        orderId: order.id,
      }),
    );
    expect(refused).toMatchObject({
      code: 'commerce.service_action_not_allowed',
      details: { reason: 'SERVICE_NOT_OWNED' },
    });
    expect(await ctx.container.wallet.balance(tenantA, owner, sender)).toEqual(balance);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM provisioning_operations
                       WHERE service_id = ${service.id} AND type = 'RENEW'`),
    ).toBe(0);
  });

  it('refunds the old owner’s bank transfer for a renewal of a service they gave away', async () => {
    const service = await deliveredService('old-transfer');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('old-transfer'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('ot-quote') },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor('old-transfer'), sender, {
      orderId: order.id,
      idempotencyKey: key('ot-confirm'),
    });
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('old-transfer'),
      sender,
      { idempotencyKey: key('ot-manual'), orderId: order.id },
    );
    await transferBehindTheOrdersBack(service.id, recipient);
    const balance = await ctx.container.wallet.balance(tenantA, owner, sender);
    const confirmed = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      owner,
      payment.id,
      { idempotencyKey: key('ot-confirm-op'), note: 'کارت به کارت' },
    );
    expect(confirmed.payment.state).toBe('CONFIRMED');
    expect(confirmed.order?.state).toBe('REFUNDED');
    // The money arrived and went back to the payer's wallet, through the one credit path.
    expect(
      (await ctx.container.wallet.balance(tenantA, owner, sender)).amountMinor -
        balance.amountMinor,
    ).toBe(order.totals.total.amountMinor);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM provisioning_operations
                       WHERE service_id = ${service.id} AND type = 'RENEW'`),
    ).toBe(0);
    expect(await ownerOf(service.id)).toBe(recipient);
  });

  // =========================================================================
  // The database's own rules (migration 0130)
  // =========================================================================

  async function sqlRefusal(query: ReturnType<typeof sql>): Promise<string> {
    try {
      await ctx.container.database.db.execute(query as never);
    } catch (error) {
      return String((error as { cause?: { message?: string } }).cause?.message ?? error);
    }
    throw new Error('expected the database to refuse');
  }

  it('refuses a change of owner with no transfer row, and one the newest row does not name', async () => {
    const service = await deliveredService('raw-owner');
    expect(
      await sqlRefusal(
        sql`UPDATE services SET customer_id = ${recipient} WHERE id = ${service.id}`,
      ),
    ).toMatch(/changes owner only through a service_ownership_transfers row/);

    await transfer(service.id, RECIPIENT_TG);
    // Back to the sender, or on to a third customer, without a newer row: refused.
    for (const to of [sender, third]) {
      expect(
        await sqlRefusal(sql`UPDATE services SET customer_id = ${to} WHERE id = ${service.id}`),
      ).toMatch(/changes owner only through/);
    }
    expect(await ownerOf(service.id)).toBe(recipient);
    // An update that does not touch the owner is not the guard's business.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET customer_note = 'x' WHERE id = ${service.id}`,
    );
  });

  it('refuses a change of the order a service was bought by', async () => {
    const service = await deliveredService('raw-order');
    const other = await deliveredService('raw-order-2');
    expect(
      await sqlRefusal(
        sql`UPDATE services SET order_id = ${other.orderId} WHERE id = ${service.id}`,
      ),
    ).toMatch(/keeps the tenant and the order/);
  });

  it('refuses a service written for a customer other than its order’s', async () => {
    const service = await deliveredService('raw-insert');
    expect(
      await sqlRefusal(
        sql`INSERT INTO services
              SELECT (jsonb_populate_record(s, jsonb_build_object(
                'id', ${ctx.container.ids.uuid()}::text,
                'customer_id', ${recipient}::text,
                'provider_username', 'other-name',
                'subscription_ref', md5('x')))).*
              FROM services s WHERE s.id = ${service.id}`,
      ),
    ).toMatch(/must belong to the customer of order/);
  });

  it('refuses a commercial action written for a customer who does not own the service', async () => {
    const service = await deliveredService('raw-action');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('raw-action'),
      sender,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: key('ra-quote') },
    );
    // The same row again, for the recipient's copy of the order: not the service's owner.
    expect(
      await sqlRefusal(
        sql`INSERT INTO service_commercial_actions
              SELECT (jsonb_populate_record(a, jsonb_build_object(
                'id', ${ctx.container.ids.uuid()}::text,
                'customer_id', ${recipient}::text))).*
              FROM service_commercial_actions a WHERE a.order_id = ${order.id}`,
      ),
    ).toMatch(/is not owned by customer/);
  });

  it('keeps the transfer rows append-only', async () => {
    const service = await deliveredService('append-only');
    const done = await transfer(service.id, RECIPIENT_TG);
    expect(
      await sqlRefusal(
        sql`UPDATE service_ownership_transfers SET to_customer_id = ${third} WHERE id = ${done.transfer.id}`,
      ),
    ).toMatch(/append-only/);
    expect(
      await sqlRefusal(sql`DELETE FROM service_ownership_transfers WHERE id = ${done.transfer.id}`),
    ).toMatch(/append-only/);
    expect(
      await sqlRefusal(
        sql`INSERT INTO service_ownership_transfers
              (id, tenant_id, service_id, from_customer_id, to_customer_id, bot_instance_id,
               idempotency_key, actor_type, correlation_id)
            VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${service.id}, ${recipient},
                    ${recipient}, ${BOT_A}, 'self', 'SYSTEM_JOB', 'test')`,
      ),
    ).toMatch(/service_ownership_transfers_parties_check/);
  });
});
