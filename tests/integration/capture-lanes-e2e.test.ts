import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  templateDefinition,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type ProductId,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleGatewayProviderRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-provider-request.repository';
import { DrizzleServiceRefundRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository';
import type { BotTurnResult } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import {
  FakeTonPaysTelegram,
  JPEG_BYTES,
  startFakeTelegram,
  telegramLaneWith,
  useClock,
} from './tonpays-telegram-fixture';

/**
 * v0.8.2 hotfix: every window a customer's button opens is READ by the handler the next
 * message reaches — through the real router (`BotRuntime.handle`, what the webhook's update
 * handler calls), with the gateway worker's pass between the tap and the message, as it is in
 * production (the worker runs every few seconds; a customer takes longer than that to send a
 * photo).
 *
 * The owner's real case: TonPays underpaid after the customer's FIRST receipt (so the
 * provider's review window was open), «📤 ارسال رسید مابقی» opened the remainder window, and
 * the photo sent inside it was answered «در حال حاضر منتظر رسیدی از شما نیستیم» — the
 * worker's capture sweep had closed the window as PAYMENT_CLOSED because the payment was in
 * review, which is exactly when a remainder window is meant to be open.
 *
 * Assertions are by template KEY and by the rows written, never by rendered amount text.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910933';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'),
  Buffer.alloc(2_048, 5),
]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(2_048, 3)]);

/** One receipt file, as Telegram delivers it in `message`. */
interface ReceiptShape {
  readonly name: string;
  readonly bytes: Buffer;
  readonly message: (fileId: string) => Record<string, unknown>;
}

const photoShape: ReceiptShape = {
  name: 'a photo',
  bytes: JPEG_BYTES,
  message: (fileId) => ({
    photo: [
      { file_id: fileId, file_unique_id: fileId, width: 800, height: 1200, file_size: 4_096 },
    ],
  }),
};
const documentShape = (name: string, mimeType: string, bytes: Buffer): ReceiptShape => ({
  name,
  bytes,
  message: (fileId) => ({
    document: {
      file_id: fileId,
      file_unique_id: fileId,
      file_name: `receipt.${mimeType.split('/')[1] ?? 'bin'}`,
      mime_type: mimeType,
      file_size: 4_096,
    },
  }),
});
/** Telegram sets `document` beside `animation` on every animation (Bot API, Message). */
const animationShape = (name: string, mimeType: string, bytes: Buffer): ReceiptShape => {
  const doc = documentShape(name, mimeType, bytes);
  return {
    name,
    bytes,
    message: (fileId) => ({
      ...doc.message(fileId),
      animation: {
        file_id: fileId,
        file_unique_id: fileId,
        width: 320,
        height: 240,
        duration: 1,
        mime_type: mimeType,
        file_size: 4_096,
      },
    }),
  };
};

/** Every receipt format the TonPays first-receipt lane accepts (`receivePhoto`). */
const ACCEPTED_SHAPES: readonly ReceiptShape[] = [
  photoShape,
  documentShape('a JPEG document', 'image/jpeg', JPEG_BYTES),
  documentShape('a WebP document', 'image/webp', WEBP_BYTES),
  animationShape('a GIF animation', 'image/gif', GIF_BYTES),
];

describe('every capture lane a button opens is consumed by the handler the next message reaches', () => {
  let ctx: TestContext;
  let telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  let panel: FakeMarzban;
  let panelId: string;
  let owner: ActorContext;
  let fake: FakeTonPaysTelegram;
  let lane: GatewayPaymentService;
  let clock: ReturnType<typeof useClock>;
  let seq = 0;
  let updateSeq = 0;

  beforeAll(async () => {
    telegram = await startFakeTelegram();
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: telegram.base,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await telegram?.close();
  });

  afterEach(async () => {
    clock?.restore();
    await panel?.close();
  });

  const key = () => {
    seq += 1;
    return `cl-${String(seq)}`;
  };

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    clock = useClock(ctx);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-cl', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-cl-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-cl'), {
      idempotencyKey: 'resolve-cl',
      telegramUserId: MARYAM,
      from: { id: Number(MARYAM), first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      apiKey: 'tpt_live_TG_key_0001',
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      status: 'ACTIVE',
    });
    fake = new FakeTonPaysTelegram();
    fake.enforceOneOpenInvoice = true;
    telegram.sent.length = 0;
    telegram.files.clear();
    // The production lane: its screens, and its cancel/refund machinery.
    lane = telegramLaneWith(ctx, fake, {
      invoiceScreens: ctx.container.wizardScreens,
      providerRequests: true,
    });
  });

  // ------------------------------------------------------------------------------------
  // the router, as the webhook's update handler drives it
  // ------------------------------------------------------------------------------------

  const handle = (update: Record<string, unknown>): Promise<BotTurnResult> => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(
      { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
      systemActor('bot'),
      {
        idempotencyKey: `cl-update-${String(updateSeq)}`,
        botInstanceId: BOT_A,
        update: { update_id: updateSeq, ...update },
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مشتری' },
      },
    );
  };

  const tapOn = (messageId: number | null, data: string) =>
    handle({
      callback_query: {
        id: `cbq-${String(updateSeq + 1)}`,
        from: { id: Number(MARYAM), first_name: 'مشتری', is_bot: false },
        data,
        message: {
          message_id: messageId ?? updateSeq + 1,
          date: 0,
          chat: { id: Number(MARYAM), type: 'private' },
          from: { id: 999999, is_bot: true, first_name: 'Nexa' },
        },
      },
    });

  const message = (content: Record<string, unknown>) =>
    handle({
      message: {
        message_id: updateSeq + 1,
        date: 0,
        chat: { id: Number(MARYAM), type: 'private' },
        from: { id: Number(MARYAM), first_name: 'مشتری', is_bot: false },
        ...content,
      },
    });

  const sendFile = (fileId: string, shape: ReceiptShape = photoShape) => {
    telegram.files.set(fileId, shape.bytes);
    return message(shape.message(fileId));
  };
  const sendText = (text: string) => message({ text });

  /** The gateway worker's pass, as `main.worker.ts` runs it: every lane, the sweeps included. */
  const workerPass = () => lane.runOnce(tenantA);

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  const callbacksOf = (body: Record<string, unknown> | undefined): string[] =>
    [...JSON.stringify(body?.['reply_markup'] ?? {}).matchAll(/"callback_data":"([^"]+)"/gu)].map(
      (match) => match[1]!,
    );
  const lastSent = () => telegram.sent.at(-1);

  async function product(): Promise<ProductId> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن تست',
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
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  /** A DRAFT order for the product: its tap and the username question's answer. */
  async function draft(): Promise<string> {
    await tapOn(null, `p:${await product()}`);
    const [order] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at DESC LIMIT 1`,
    );
    await tapOn(null, `Z:${order!.id}`);
    return order!.id;
  }

  /** The TonPays card invoice on screen: the order's tap, the worker's create. */
  async function tonPaysInvoice(): Promise<{ paymentId: string; message: number }> {
    const orderId = await draft();
    await tapOn(null, `gp:${orderId}.TONPAYS_TELEGRAM`);
    const message = updateSeq;
    const [payment] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'`,
    );
    await workerPass();
    return { paymentId: payment!.id, message };
  }

  /** The next inquiry is due now (the worker's schedule is not what is tested here). */
  const inquireNow = async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second',
            inquiry_claimed_until = NULL
          WHERE provider = 'TONPAYS_TELEGRAM' AND outcome IS NULL AND provider_invoice_id IS NOT NULL`,
    );
    return workerPass();
  };
  const firstInvoice = () => fake.invoices.values().next().value!;

  /** The new message the worker sent last: a next step goes out as one (R9 C1). */
  const nextStepMessage = (): number => {
    const body = telegram.sent.filter((one) => one['sentMessageId'] !== undefined).at(-1);
    expect(body, 'the next step was sent as a new message').toBeDefined();
    return Number(body!['sentMessageId']);
  };

  /**
   * The owner's case up to the remainder button: the FIRST receipt sent through the bot and
   * acknowledged (the provider's review opens), then TonPays finds the transfer short.
   */
  async function underpaidInReview(): Promise<{ paymentId: string; step: number }> {
    const { paymentId, message: invoice } = await tonPaysInvoice();
    expect((await tapOn(invoice, `gr:${paymentId}`)).replyKey).toBe(
      'bot.payment.gateway_receipt_prompt',
    );
    await workerPass();
    expect((await sendFile('first-receipt')).replyKey).toBe('bot.payment.gateway_receipt_queued');
    await workerPass(); // uploaded and acknowledged: the review opens
    const [inReview] = await rows<{ provider_review_until: Date | null }>(
      sql`SELECT provider_review_until FROM payments WHERE id = ${paymentId}`,
    );
    expect(inReview!.provider_review_until, 'the provider review is open').not.toBeNull();
    fake.underpay(firstInvoice().invoiceId, 12_000);
    await inquireNow();
    return { paymentId, step: nextStepMessage() };
  }

  /** The same after an OVERpayment: the refund-card button. */
  async function overpaidInReview(): Promise<{ paymentId: string; step: number }> {
    const { paymentId, message: invoice } = await tonPaysInvoice();
    await tapOn(invoice, `gr:${paymentId}`);
    await workerPass();
    await sendFile('first-receipt-over');
    await workerPass();
    fake.overpay(firstInvoice().invoiceId, 15_000);
    await inquireNow();
    return { paymentId, step: nextStepMessage() };
  }

  const submissions = (paymentId: string) =>
    rows<{ provider_invoice_id: string; state: string; telegram_file_unique_id: string }>(
      sql`SELECT provider_invoice_id, state, telegram_file_unique_id
            FROM gateway_receipt_submissions WHERE payment_id = ${paymentId}
           ORDER BY created_at`,
    );

  /** The `GatewayPaymentAttentionRaised` rows, through the REAL financial-log consumer. */
  async function opsLogKeys(paymentId: string): Promise<string[]> {
    const db = ctx.container.database.db;
    const out: string[] = [];
    const attention = await rows<{ id: string; payload: unknown; occurred_at: Date | string }>(
      sql`SELECT id, payload, occurred_at FROM outbox_messages
           WHERE event_type = 'GatewayPaymentAttentionRaised' AND aggregate_id = ${paymentId}
           ORDER BY sequence`,
    );
    for (const row of attention) {
      const queued: { templateKey: TemplateKey; values: TemplateValues }[] = [];
      const consumer = new FinancialLogConsumer({
        lane: {
          financialDestination: async () =>
            ({ transport: 'TELEGRAM', chatId: '-1001', topicId: null }) as never,
          queue: async (_scope, input) => {
            queued.push({ templateKey: input.templateKey, values: input.values });
            return undefined;
          },
        },
        payments: new DrizzlePaymentRepository(db),
        customers: new DrizzleCustomerRepository(db),
        invoices: new DrizzleGatewayInvoiceRepository(db),
        facts: new DrizzleOpsLogFacts(db),
        words: i18nOpsLogWords,
        refundRequests: new DrizzleServiceRefundRequestRepository(db),
        providerRequests: new DrizzleGatewayProviderRequestRepository(db),
      });
      const event = {
        eventId: row.id,
        eventType: 'GatewayPaymentAttentionRaised',
        eventVersion: 1,
        tenantId: String(tenantA.tenantId),
        aggregateType: 'Payment',
        aggregateId: paymentId,
        sequence: 1,
        correlationId: 'hotfix-capture-lanes',
        causationId: null,
        actor: { type: 'SYSTEM_JOB', id: null },
        occurredAt: new Date(row.occurred_at).toISOString(),
        payload: row.payload,
      } as unknown as DomainEvent;
      await ctx.container.uow.run(tenantA, (tx) => consumer.handle(event, tx as never));
      for (const one of queued) {
        // Rendered, so a key whose values do not fill its template fails here.
        renderTemplateBody(
          templateDefinition(one.templateKey),
          CATALOGUE_FA[one.templateKey as never],
          one.values,
          'fa',
          DEFAULT_TEMPLATE_PRESENTATION,
        );
        out.push(one.templateKey);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------
  // the owner's case: the remainder receipt
  // ------------------------------------------------------------------------------------

  describe('the TonPays remainder receipt, after the first receipt opened the review', () => {
    it.each(ACCEPTED_SHAPES.map((shape) => [shape.name, shape] as const))(
      '%s sent after the worker’s pass is the REMAINDER’s receipt: queued, uploaded to the remainder invoice, and the screen says so',
      async (_name, shape) => {
        const { paymentId, step } = await underpaidInReview();
        expect(callbacksOf(telegram.sent.find((one) => one['sentMessageId'] === step))).toContain(
          `gr:${paymentId}`,
        );
        expect((await tapOn(step, `gr:${paymentId}`)).replyKey).toBe(
          'bot.payment.gateway_receipt_prompt',
        );
        // The worker runs between the tap and the photo, as it does in production.
        await workerPass();
        const answer = await sendFile('remainder-receipt', shape);
        expect(answer.replyKey).toBe('bot.payment.gateway_receipt_queued');
        expect(await submissions(paymentId)).toEqual([
          expect.objectContaining({ provider_invoice_id: firstInvoice().invoiceId }),
          expect.objectContaining({
            provider_invoice_id: 'TP-REM123XYZ0',
            state: 'QUEUED',
            telegram_file_unique_id: 'remainder-receipt',
          }),
        ]);
        const [audit] = await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_logs
               WHERE action = 'gateway_receipt.queued' AND entity_id = ${paymentId}`,
        );
        expect(audit!.n, 'one audit row per queued receipt').toBe(2);

        await workerPass(); // the existing upload lane sends it
        expect(fake.receipts.at(-1)!.url).toBe(
          'https://tonpays.online/api/custom/v1/invoices/TP-REM123XYZ0/receipt',
        );
        await inquireNow();
        expect((await tapOn(step, `gc:${paymentId}`)).replyKey).toBe(
          'bot.payment.gateway_card_underpaid_receipt_sent',
        );
        // The operator was told about the underpayment once; nothing settled or credited.
        expect(await opsLogKeys(paymentId)).toEqual(['ops.financial.payment_underpaid']);
        const [payment] = await rows<{ state: string }>(
          sql`SELECT state FROM payments WHERE id = ${paymentId}`,
        );
        expect(payment!.state).toBe('PENDING');
        const entries = await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM wallet_entries WHERE payment_id = ${paymentId}`,
        );
        expect(entries[0]!.n).toBe(0);
      },
    );

    it('an MP4 animation (Telegram’s converted GIF) is refused exactly as the first-receipt lane refuses it, and the window stays open for a photo', async () => {
      const { paymentId, step } = await underpaidInReview();
      await tapOn(step, `gr:${paymentId}`);
      await workerPass();
      const mp4 = animationShape('an MP4 animation', 'video/mp4', Buffer.alloc(2_048, 1));
      expect((await sendFile('remainder-mp4', mp4)).replyKey).toBe(
        'bot.payment.gateway_receipt_photo_only',
      );
      await workerPass();
      expect((await sendFile('remainder-photo')).replyKey).toBe(
        'bot.payment.gateway_receipt_queued',
      );
      expect((await submissions(paymentId)).map((one) => one.provider_invoice_id)).toEqual([
        firstInvoice().invoiceId,
        'TP-REM123XYZ0',
      ]);
    });

    const windows = (paymentId: string) =>
      rows<{ provider_invoice_id: string; close_reason: string | null }>(
        sql`SELECT provider_invoice_id, close_reason FROM gateway_receipt_captures
             WHERE payment_id = ${paymentId} ORDER BY opened_at`,
      );

    it('the worker’s sweep keeps a remainder window open through the review, and closes it EXPIRED at its own deadline', async () => {
      const { paymentId, step } = await underpaidInReview();
      await tapOn(step, `gr:${paymentId}`);
      await workerPass();
      await workerPass();
      expect((await windows(paymentId)).at(-1)).toEqual({
        provider_invoice_id: 'TP-REM123XYZ0',
        close_reason: null,
      });
      // Past the window's ten minutes (the review is still open): closed EXPIRED, and a photo
      // is no longer the remainder's.
      clock.shift(11 * 60_000);
      await workerPass();
      expect((await windows(paymentId)).at(-1)).toEqual({
        provider_invoice_id: 'TP-REM123XYZ0',
        close_reason: 'EXPIRED',
      });
      expect((await sendFile('too-late')).replyKey).toBe('bot.payment.receipt_not_expected');
      expect((await submissions(paymentId)).map((one) => one.provider_invoice_id)).toEqual([
        firstInvoice().invoiceId,
      ]);
    });

    it('the sweep still closes an ORDINARY window once the payment is in review (the rule the fix keeps)', async () => {
      const { paymentId, message: invoice } = await tonPaysInvoice();
      expect((await tapOn(invoice, `gr:${paymentId}`)).replyKey).toBe(
        'bot.payment.gateway_receipt_prompt',
      );
      // A review opened by another path while the window was open (the acknowledgement of a
      // receipt closes its own windows itself; this is the sweep's half of the rule).
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET provider_review_started_at = now(),
                                provider_review_until = now() + interval '24 hours'
             WHERE id = ${paymentId}`,
      );
      await workerPass();
      expect(await windows(paymentId)).toEqual([
        { provider_invoice_id: firstInvoice().invoiceId, close_reason: 'PAYMENT_CLOSED' },
      ]);
      expect((await sendFile('in-review')).replyKey).toBe('bot.payment.receipt_not_expected');
      expect(await submissions(paymentId)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------
  // every lane, opened by its button and consumed by the next message
  // ------------------------------------------------------------------------------------

  /**
   * Every capture lane a customer's button opens in the bot. `open` taps the button the way
   * a customer does and returns what the next message is; the worker's pass then runs, and
   * the message must be read by the lane — never fall through to «منتظر رسیدی از شما نیستیم»
   * or the unknown-message reply. The Mini App's receipt is not here: it is its own surface
   * (an upload with the payment id in the path), tested at its own entry in
   * `miniapp-surface.test.ts`.
   */
  type Lane =
    | 'MANUAL_ORDER_RECEIPT'
    | 'MANUAL_TOPUP_RECEIPT'
    | 'TONPAYS_FIRST_RECEIPT'
    | 'TONPAYS_REMAINDER_RECEIPT'
    | 'TONPAYS_REFUND_CARD'
    | 'TONPAYS_CARD_CHANGE';

  interface LaneCase {
    /** Taps the button that opens the lane; resolves to the message that answers it. */
    readonly open: () => Promise<{
      /** The reply to the tap that opened the window; null for a tap that opens none. */
      readonly opened: TemplateKey | null;
      readonly consume: () => Promise<BotTurnResult>;
      readonly consumed: TemplateKey;
      readonly written: () => Promise<number>;
    }>;
  }

  const manualReceipt = async (paymentId: string, invoiceKey: TemplateKey) => ({
    opened: invoiceKey,
    consume: async () => {
      expect((await tapOn(null, `i:${paymentId}`)).replyKey).toBe('bot.payment.receipt_prompt');
      await workerPass();
      return sendFile(`manual-${paymentId.slice(0, 8)}`);
    },
    consumed: 'bot.payment.receipt_received' as TemplateKey,
    written: async () =>
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${paymentId}`,
        )
      )[0]!.n,
  });

  const EXPECTED_OPENED: Record<Lane, TemplateKey | null> = {
    MANUAL_ORDER_RECEIPT: 'bot.payment.transfer_instructions',
    MANUAL_TOPUP_RECEIPT: 'bot.payment.transfer_instructions',
    TONPAYS_FIRST_RECEIPT: 'bot.payment.gateway_receipt_prompt',
    TONPAYS_REMAINDER_RECEIPT: 'bot.payment.gateway_receipt_prompt',
    TONPAYS_REFUND_CARD: 'bot.payment.gateway_refund_card_prompt',
    TONPAYS_CARD_CHANGE: null,
  };

  const LANES: Record<Lane, LaneCase> = {
    MANUAL_ORDER_RECEIPT: {
      open: async () => {
        const orderId = await draft();
        const invoice = await tapOn(null, `m:${orderId}`);
        const [payment] = await rows<{ id: string }>(
          sql`SELECT id FROM payments WHERE order_id = ${orderId}`,
        );
        return manualReceipt(payment!.id, invoice.replyKey!);
      },
    },
    MANUAL_TOPUP_RECEIPT: {
      open: async () => {
        await tapOn(null, 'o:');
        await sendText('50000');
        const route = callbacksOf(lastSent()).find((data) => data.endsWith('.MANUAL_TRANSFER'));
        expect(route, 'the card-to-card top-up route is offered').toBeDefined();
        const invoice = await tapOn(null, route!);
        const [payment] = await rows<{ id: string }>(
          sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId} AND order_id IS NULL`,
        );
        return manualReceipt(payment!.id, invoice.replyKey!);
      },
    },
    TONPAYS_FIRST_RECEIPT: {
      open: async () => {
        const { paymentId, message: invoice } = await tonPaysInvoice();
        return {
          opened: (await tapOn(invoice, `gr:${paymentId}`)).replyKey!,
          consume: async () => {
            await workerPass();
            return sendFile('first');
          },
          consumed: 'bot.payment.gateway_receipt_queued',
          written: async () => (await submissions(paymentId)).length,
        };
      },
    },
    TONPAYS_REMAINDER_RECEIPT: {
      open: async () => {
        const { paymentId, step } = await underpaidInReview();
        return {
          opened: (await tapOn(step, `gr:${paymentId}`)).replyKey!,
          consume: async () => {
            await workerPass();
            return sendFile('remainder');
          },
          consumed: 'bot.payment.gateway_receipt_queued',
          // The first receipt is not counted: only the remainder's.
          written: async () =>
            (await submissions(paymentId)).filter(
              (one) => one.provider_invoice_id === 'TP-REM123XYZ0',
            ).length,
        };
      },
    },
    TONPAYS_REFUND_CARD: {
      open: async () => {
        const { paymentId, step } = await overpaidInReview();
        return {
          opened: (await tapOn(step, `gf:${paymentId}`)).replyKey!,
          consume: async () => {
            await workerPass();
            return sendText('6037991234567890\nAli Rezaei');
          },
          consumed: 'bot.payment.gateway_refund_requested',
          written: async () =>
            (
              await rows<{ n: number }>(
                sql`SELECT count(*)::int AS n FROM gateway_provider_requests
                     WHERE payment_id = ${paymentId} AND kind = 'REFUND'`,
              )
            )[0]!.n,
        };
      },
    },
    TONPAYS_CARD_CHANGE: {
      // No window: the tap IS the request row, and the worker's pass consumes it.
      open: async () => {
        const { paymentId, message: invoice } = await tonPaysInvoice();
        clock.shift(61_000);
        return {
          opened: null,
          consume: async () => {
            const tap = await tapOn(invoice, `gk:${paymentId}`);
            await workerPass();
            return tap;
          },
          consumed: 'bot.payment.gateway_card_changing',
          written: async () =>
            (
              await rows<{ n: number }>(
                sql`SELECT count(*)::int AS n FROM gateway_card_changes
                     WHERE payment_id = ${paymentId} AND state = 'APPLIED'`,
              )
            )[0]!.n,
        };
      },
    },
  };

  it.each(Object.keys(LANES) as Lane[])(
    '%s: opened by its button, read by the next message after the worker’s pass, one row written',
    async (name) => {
      const lane = await LANES[name].open();
      expect(lane.opened).toBe(EXPECTED_OPENED[name]);
      const answer = await lane.consume();
      expect(answer.replyKey).not.toBe('bot.payment.receipt_not_expected');
      expect(answer.replyKey).toBe(lane.consumed);
      expect(await lane.written()).toBe(1);
    },
  );
});
