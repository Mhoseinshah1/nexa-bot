import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  EMPTY_PRODUCT_DISPLAY,
  PAYMENT_ROUTES,
  SESSION_COOKIE_NAME,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
  paymentReinquireResponseSchema,
  paymentResponseSchema,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayCardTransferRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-card-transfer.repository';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';
import {
  FakeTonPaysTelegram,
  JPEG_BYTES,
  startFakeTelegram,
  telegramLaneWith,
  useClock,
  type FakeWrite,
} from './tonpays-telegram-fixture';

/**
 * The provider review window (`docs/tonpays-telegram-gateway-audit.md` §9.6; the owner's
 * decision of 2026-10-01), end to end: the 70 minutes are the customer's window; a receipt
 * TonPays ACKNOWLEDGES before them opens a 24-hour review, written once under the payment's
 * lock; the one settlement path compares the review deadline under that lock; a review that
 * ends unresolved goes to UNKNOWN for an operator, never EXPIRED and never FAILED.
 *
 * The container's clock is moved (`useClock`) so the settlement path decides at exactly the
 * boundary under test. Races use two connections and a lock barrier, never a sleep. The
 * provider is a fake written from the owner's transcription (`OQ-WP10-01`).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const TELEGRAM_KEY = 'tpt_live_REVIEW_key_never_leak_0b7e';

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

describe('the TonPays Telegram provider review window', () => {
  let ctx: TestContext;
  let telegram: Awaited<ReturnType<typeof startFakeTelegram>>;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
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

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    clock = useClock(ctx);
    products = new DrizzleProductRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-rv', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-rv-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-rv'), {
        idempotencyKey: 'resolve-rv',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      apiKey: TELEGRAM_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS_TELEGRAM',
      status: 'ACTIVE',
    });
    fake = new FakeTonPaysTelegram();
    telegram.files.clear();
    lane = telegramLaneWith(ctx, fake);
  });

  function key(): string {
    seq += 1;
    return `rv-${String(seq)}`;
  }

  const tap = (data: string) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(
      { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
      systemActor('bot'),
      {
        idempotencyKey: `rv-update-${String(updateSeq)}`,
        botInstanceId: BOT_A,
        update: {
          update_id: updateSeq,
          callback_query: {
            id: `cbq-${String(updateSeq)}`,
            from: { id: Number(MARYAM), first_name: 'مریم', is_bot: false },
            data,
            message: {
              message_id: updateSeq,
              date: 0,
              chat: { id: Number(MARYAM), type: 'private' },
              from: { id: 999999, is_bot: true, first_name: 'Nexa' },
            },
          },
        },
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
      },
    );
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function attempt(): Promise<{
    orderId: string;
    paymentId: PaymentId;
    invoiceId: string;
    expiresAt: Date;
  }> {
    const row = await products.create(tenantA, {
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
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    await tap(`p:${row.id}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (draft === undefined) throw new Error('no draft');
    await tap(`Z:${draft.id}`);
    await tap(`gp:${draft.id}.TONPAYS_TELEGRAM`);
    const [payment] = await rows<{ id: string; expires_at: string }>(
      sql`SELECT id, expires_at FROM payments WHERE order_id = ${draft.id} AND method = 'GATEWAY'
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (payment === undefined) throw new Error('no attempt');
    await lane.runOnce(tenantA);
    const [invoice] = await rows<{ provider_invoice_id: string | null }>(
      sql`SELECT provider_invoice_id FROM gateway_invoices WHERE payment_id = ${payment.id}`,
    );
    if (invoice?.provider_invoice_id == null) throw new Error('not created');
    return {
      orderId: draft.id,
      paymentId: payment.id as PaymentId,
      invoiceId: invoice.provider_invoice_id,
      expiresAt: new Date(payment.expires_at),
    };
  }

  /** The customer sends a receipt photo and the worker uploads it with `mode`'s answer. */
  async function sendReceipt(
    paymentId: string,
    mode: FakeWrite | FakeTonPaysTelegram['receiptMode'],
  ) {
    fake.receiptMode = mode;
    const opened = await ctx.container.gatewayReceiptCaptures.openReceiptCapture(
      tenantA,
      systemActor(key()),
      { customerId: maryam, paymentId, botInstanceId: BOT_A },
    );
    if (opened === null) throw new Error('no receipt window');
    const fileId = `photo-${key()}`;
    telegram.files.set(fileId, JPEG_BYTES);
    const queued = await ctx.container.gatewayReceiptCaptures.receivePhoto(
      tenantA,
      systemActor(key()),
      {
        customerId: maryam,
        botInstanceId: BOT_A,
        file: {
          kind: 'PHOTO',
          fileId,
          fileUniqueId: fileId,
          mimeType: null,
          fileName: null,
          fileSize: BigInt(JPEG_BYTES.byteLength),
          telegramMessageId: 1n,
          caption: null,
        },
      },
    );
    expect(queued).toBe('QUEUED');
    await lane.runOnce(tenantA);
  }

  /** An attempt whose receipt TonPays acknowledged at minute `minute`. */
  async function reviewed(minute = 30) {
    const created = await attempt();
    clock.at(new Date(created.expiresAt.getTime() - (70 - minute) * 60_000));
    await sendReceipt(created.paymentId, 'ACK');
    const state = await paymentOf(created.paymentId);
    if (state.provider_review_until === null) throw new Error('no review opened');
    return {
      ...created,
      reviewStartedAt: new Date(state.provider_review_started_at!),
      reviewUntil: new Date(state.provider_review_until),
    };
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{
      state: string;
      evidence_kind: string | null;
      confirmed_by_admin_id: string | null;
      provider_review_started_at: string | null;
      provider_review_until: string | null;
    }>(sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      outcome: string | null;
      provider_status: string | null;
      next_inquiry_at: string | null;
      late_completion_observed_at: string | null;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice');
    return row;
  }

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const notified = async (subjectId: string) =>
    (
      await rows<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications WHERE subject_id = ${subjectId} ORDER BY kind`,
      )
    ).map((row) => row.kind);

  const confirmNow = (paymentId: string) =>
    ctx.container.payments.confirmGatewayPayment(tenantA, systemActor(key()), paymentId, {
      evidenceNote: 'tonpays_telegram:completed:paid',
    });

  /** Moves the review's end into the past and runs the review sweep. */
  async function lapse(review: { paymentId: string; reviewUntil: Date }) {
    clock.at(review.reviewUntil);
    await lane.runOnce(tenantA);
    expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
  }

  // =====================================================================================

  describe('opening the review', () => {
    it('TPTG-25/29: only an acknowledging upload answer opens it; a lost, refused, rate-limited or unsignalled answer, a string "true" and an inquiry `processing` open nothing', async () => {
      const opened = await reviewed(20);
      expect(opened.reviewUntil.getTime() - opened.reviewStartedAt.getTime()).toBe(
        TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
      );
      const [winner] = await rows<{ opened_review: boolean }>(
        sql`SELECT opened_review FROM gateway_receipt_submissions WHERE payment_id = ${opened.paymentId}`,
      );
      expect(winner?.opened_review).toBe(true);

      for (const mode of [
        'NO_SIGNAL',
        'STRING_TRUE',
        'TIMEOUT',
        'SERVER_ERROR',
        { code: 'RATE_LIMIT_EXCEEDED', status: 429 },
        { code: 'INVALID_RECEIPT_TYPE', status: 400 },
      ] as const) {
        const other = await attempt();
        clock.at(new Date(other.expiresAt.getTime() - 30 * 60_000));
        await sendReceipt(other.paymentId, mode);
        expect(
          (await paymentOf(other.paymentId)).provider_review_until,
          JSON.stringify(mode),
        ).toBeNull();
      }

      // An INQUIRY reporting `processing` is a hint for the screen, never an acknowledgement.
      const inquired = await attempt();
      fake.set(inquired.invoiceId, 'processing', false);
      clock.at(new Date(inquired.expiresAt.getTime() - 30 * 60_000));
      await lane.runOnce(tenantA);
      expect((await invoiceOf(inquired.paymentId)).provider_status).toBe('processing');
      expect((await paymentOf(inquired.paymentId)).provider_review_until).toBeNull();
      // And without a review the 70 minutes stand: the expiry sweep takes it.
      clock.at(new Date(inquired.expiresAt.getTime() + 1));
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(inquired.paymentId)).state).toBe('EXPIRED');
    });

    it('TPTG-24/31: an acknowledgement observed AT minute 70 opens nothing, even with the sweep late', async () => {
      const created = await attempt();
      clock.at(new Date(created.expiresAt.getTime() - 60_000));
      fake.duringReceipt = () => {
        clock.at(created.expiresAt);
        return Promise.resolve();
      };
      await sendReceipt(created.paymentId, 'ACK');
      fake.duringReceipt = null;
      expect((await paymentOf(created.paymentId)).provider_review_until).toBeNull();
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(created.paymentId)).state).toBe('EXPIRED');
    });

    it('TPTG-25: in review, the expiry sweep never takes the payment, however long after minute 70', async () => {
      const review = await reviewed(69);
      clock.at(new Date(review.expiresAt.getTime() + 3_600_000));
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('PENDING');
      expect(await notified(review.paymentId)).not.toContain('PAYMENT_EXPIRED');
    });
  });

  describe('settling during the review', () => {
    it('TPTG-02/27: an approval at minute 71 settles because the review deadline is compared under the lock', async () => {
      const review = await reviewed(60);
      fake.set(review.invoiceId, 'completed', true);
      clock.at(new Date(review.expiresAt.getTime() + 60_000));
      await lane.runOnce(tenantA);
      const payment = await paymentOf(review.paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(payment.evidence_kind).toBe('GATEWAY_INQUIRY');
      expect(await orderState(review.orderId)).toBe('PAID');
      expect((await invoiceOf(review.paymentId)).outcome).toBe('SETTLED');
    });

    it('TPTG-02: without a review, the same approval at minute 71 is LATE_COMPLETION and settles nothing, even with the provider saying processing', async () => {
      const created = await attempt();
      fake.set(created.invoiceId, 'processing', false);
      clock.at(new Date(created.expiresAt.getTime() - 60_000));
      await lane.runOnce(tenantA);
      fake.set(created.invoiceId, 'completed', true);
      clock.at(new Date(created.expiresAt.getTime() + 60_000));
      const answer = await confirmNow(created.paymentId);
      expect(answer).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'DEADLINE_PASSED' });
      expect((await paymentOf(created.paymentId)).state).toBe('PENDING');
    });

    it('TPTG-28: half-open at the review deadline — settles at review_until − 1 ms, DEADLINE_PASSED at review_until', async () => {
      const early = await reviewed(10);
      clock.at(new Date(early.reviewUntil.getTime() - 1));
      expect((await confirmNow(early.paymentId)).outcome).toBe('SETTLED');

      const late = await reviewed(10);
      clock.at(late.reviewUntil);
      expect(await confirmNow(late.paymentId)).toMatchObject({
        outcome: 'NOT_ELIGIBLE',
        reason: 'DEADLINE_PASSED',
      });
      // Through the lane at the same moment: recorded as LATE_COMPLETION, nothing settled.
      fake.set(late.invoiceId, 'completed', true);
      await lane.runOnce(tenantA);
      expect((await paymentOf(late.paymentId)).state).toBe('UNKNOWN');
      expect((await invoiceOf(late.paymentId)).outcome).toBe('LATE_COMPLETION');
    });

    it('TPTG-38: in review, rejected/expired/canceled fail it and tell the customer; pending/processing/need_action/completed-without-paid leave it PENDING', async () => {
      for (const status of ['pending', 'processing', 'need_action']) {
        const review = await reviewed(30);
        fake.set(review.invoiceId, status, false);
        clock.at(new Date(review.expiresAt.getTime() + 5 * 60_000));
        await lane.runOnce(tenantA);
        expect((await paymentOf(review.paymentId)).state, status).toBe('PENDING');
      }
      const unpaid = await reviewed(30);
      fake.set(unpaid.invoiceId, 'completed', false);
      clock.at(new Date(unpaid.expiresAt.getTime() + 5 * 60_000));
      await lane.runOnce(tenantA);
      expect((await paymentOf(unpaid.paymentId)).state).toBe('PENDING');

      for (const status of ['rejected', 'expired', 'canceled']) {
        const review = await reviewed(30);
        fake.set(review.invoiceId, status, false);
        clock.at(new Date(review.expiresAt.getTime() + 5 * 60_000));
        await lane.runOnce(tenantA);
        expect((await paymentOf(review.paymentId)).state, status).toBe('FAILED');
        expect(await notified(review.paymentId)).toContain('GATEWAY_PAYMENT_FAILED');
        expect(await orderState(review.orderId)).toBe('AWAITING_PAYMENT');
      }
    });

    it('TPTG-40: the inquiry follows the review cadence and the last one is due fifteen seconds before the review deadline', async () => {
      const review = await reviewed(30);
      // The acknowledgement brought the first inquiry forward at once.
      const first = new Date((await invoiceOf(review.paymentId)).next_inquiry_at!);
      expect(first.getTime()).toBeLessThanOrEqual(clock.now().getTime());
      clock.at(new Date(review.reviewStartedAt.getTime() + 10_000));
      await lane.runOnce(tenantA);
      const next = new Date((await invoiceOf(review.paymentId)).next_inquiry_at!);
      expect(next.getTime() - (review.reviewStartedAt.getTime() + 10_000)).toBe(120_000);
      clock.at(new Date(review.reviewUntil.getTime() - 60_000));
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = ${clock.now()} WHERE payment_id = ${review.paymentId}`,
      );
      await lane.runOnce(tenantA);
      const last = new Date((await invoiceOf(review.paymentId)).next_inquiry_at!);
      expect(last.getTime()).toBe(review.reviewUntil.getTime() - 15_000);
    });
  });

  describe('the end of the review', () => {
    it('TPTG-34/35: a fresh lane reads the persisted deadline; at it the payment is UNKNOWN — never EXPIRED or FAILED — with the event and the condition written once', async () => {
      const review = await reviewed(40);
      lane = telegramLaneWith(ctx, fake);
      clock.at(new Date(review.reviewUntil.getTime() - 1));
      await lane.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('PENDING');
      await lapse(review);
      clock.at(new Date(review.reviewUntil.getTime() + 60_000));
      await lane.runOnce(tenantA);
      const events = await rows<{ event_type: string }>(
        sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${review.paymentId}
            AND event_type = 'PaymentOutcomeUnknown'`,
      );
      expect(events).toHaveLength(1);
      const conditions = await rows<{ occurrence_count: number }>(
        sql`SELECT occurrence_count FROM operational_events
            WHERE dedupe_key = ${`payments.gateway_review_unresolved:${review.paymentId}`}`,
      );
      expect(conditions).toHaveLength(1);
      expect(await notified(review.paymentId)).not.toContain('GATEWAY_PAYMENT_FAILED');
      expect(await notified(review.paymentId)).not.toContain('PAYMENT_EXPIRED');
    });

    it('TPTG-35: UNKNOWN is never auto-settled or auto-failed — a later approval is LATE_COMPLETION, a later "no" is recorded only', async () => {
      const review = await reviewed(40);
      await lapse(review);
      const invoice = (
        await rows<{ provider_order_id: string }>(
          sql`SELECT provider_order_id FROM gateway_invoices WHERE payment_id = ${review.paymentId}`,
        )
      )[0]!;
      fake.set(review.invoiceId, 'rejected', false);
      const hint = (status: string, delivery: string) =>
        lane.receiveWebhook(
          String(tenantA.tenantId),
          'TONPAYS_TELEGRAM',
          {
            invoice_id: review.invoiceId,
            order_id: invoice.provider_order_id,
            status,
            delivery_id: delivery,
          },
          delivery,
        );
      await hint('rejected', 'd-1');
      clock.at(new Date(review.reviewUntil.getTime() + 10_000));
      await lane.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
      expect((await invoiceOf(review.paymentId)).provider_status).toBe('rejected');
      expect(await notified(review.paymentId)).not.toContain('GATEWAY_PAYMENT_FAILED');

      fake.set(review.invoiceId, 'completed', true);
      await hint('completed', 'd-2');
      clock.at(new Date(review.reviewUntil.getTime() + 20_000));
      await lane.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
      // The late approval is RECORDED (the outcome keeps the earlier "no" it first saw).
      const recorded = await invoiceOf(review.paymentId);
      expect(recorded.late_completion_observed_at).not.toBeNull();
      expect(recorded.provider_status).toBe('completed');
      expect(
        await rows(
          sql`SELECT code FROM operational_events WHERE code = 'payments.gateway_late_completion'`,
        ),
      ).toHaveLength(1);
      expect(await orderState(review.orderId)).toBe('AWAITING_PAYMENT');
    });

    it('TPTG-32: at the review deadline an approval and the sweep race on two connections — exactly one wins, and an UNKNOWN row is never settled', async () => {
      const repo = new DrizzlePaymentRepository(ctx.container.database.db);
      // (b) The sweep holds the payment's lock; the approval waits on it, then finds UNKNOWN.
      const swept = await reviewed(20);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const sweeping = ctx.container.uow.run(tenantA, async (tx) => {
        const moved = await repo.loseTrackOfReviewed(tenantA, swept.reviewUntil, 10, tx);
        locked();
        await held;
        return moved.length;
      });
      let answer: Awaited<ReturnType<typeof confirmNow>> | null;
      try {
        await holding;
        clock.at(new Date(swept.reviewUntil.getTime() - 1));
        const approving = confirmNow(swept.paymentId);
        await awaitBlocked();
        release();
        answer = await approving;
      } finally {
        release();
      }
      expect(await sweeping).toBe(1);
      expect(answer).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'PAYMENT_NOT_PENDING' });
      expect((await paymentOf(swept.paymentId)).state).toBe('UNKNOWN');
      expect(await orderState(swept.orderId)).toBe('AWAITING_PAYMENT');

      // (a) The approval holds the lock first: the sweep skips the row, the approval settles,
      // and a later sweep finds nothing to move.
      const approved = await reviewed(20);
      let releaseHolder: () => void = () => undefined;
      const heldHolder = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let lockedHolder: () => void = () => undefined;
      const holdingHolder = new Promise<void>((resolve) => {
        lockedHolder = resolve;
      });
      const holder = ctx.container.uow.run(tenantA, async (tx) => {
        await tx.tx.execute(
          sql`SELECT id FROM payments WHERE id = ${approved.paymentId} FOR UPDATE`,
        );
        lockedHolder();
        await heldHolder;
      });
      try {
        await holdingHolder;
        const skipped = await ctx.container.uow.run(tenantA, (tx) =>
          repo.loseTrackOfReviewed(tenantA, approved.reviewUntil, 10, tx),
        );
        expect(skipped).toHaveLength(0);
      } finally {
        releaseHolder();
        await holder;
      }
      clock.at(new Date(approved.reviewUntil.getTime() - 1));
      expect((await confirmNow(approved.paymentId)).outcome).toBe('SETTLED');
      const later = await ctx.container.uow.run(tenantA, (tx) =>
        repo.loseTrackOfReviewed(tenantA, approved.reviewUntil, 10, tx),
      );
      expect(later).toHaveLength(0);
      expect((await paymentOf(approved.paymentId)).state).toBe('CONFIRMED');
    });
  });

  /*
   * FIX10 BUG-1: one row that throws stops neither the sweeps nor the rows beside it. Before
   * this, a throwing inquiry threw the whole pass, and the review sweep after it never ran:
   * a lapsed review stayed PENDING instead of going to an operator as UNKNOWN.
   */
  describe('a row that throws (FIX10 BUG-1)', () => {
    it('inquiries that throw on an undecryptable key do not stop the review sweep', async () => {
      const review = await reviewed(40);
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateway_credentials SET api_key_ciphertext = 'v9.not-an-envelope'
            WHERE tenant_id = ${tenantA.tenantId} AND provider = 'TONPAYS_TELEGRAM'`,
      );
      clock.at(review.reviewUntil);
      // Its inquiry is due, so the pass meets the throwing row before the sweep.
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices
               SET next_inquiry_at = ${new Date(review.reviewUntil.getTime() - 60_000).toISOString()}::timestamptz,
                   inquiry_claimed_until = NULL
             WHERE payment_id = ${review.paymentId}`,
      );
      const report = await lane.runOnce(tenantA);
      expect(report.rowFailures).toBe(1);
      expect(report.reviewsLapsed).toBe(1);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
    });

    it('a lane whose claim itself throws does not stop the review sweep or the lanes after it', async () => {
      const review = await reviewed(40);
      clock.at(review.reviewUntil);
      const broken = telegramLaneWith(ctx, fake, {
        invoices: (real) => {
          real.claimInquiries = () => Promise.reject(new Error('the claim transaction failed'));
          return real;
        },
      });
      const report = await broken.runOnce(tenantA);
      expect(report.rowFailures).toBe(1);
      expect(report.reviewsLapsed).toBe(1);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
    });

    it('a receipt whose processing throws is backed off and the receipt queued after it is uploaded in the same pass', async () => {
      const first = await attempt();
      const second = await attempt();
      clock.at(new Date(first.expiresAt.getTime() - 30 * 60_000));
      const queue = async (paymentId: string): Promise<string> => {
        const opened = await ctx.container.gatewayReceiptCaptures.openReceiptCapture(
          tenantA,
          systemActor(key()),
          { customerId: maryam, paymentId, botInstanceId: BOT_A },
        );
        if (opened === null) throw new Error('no receipt window');
        const fileId = `photo-${key()}`;
        telegram.files.set(fileId, JPEG_BYTES);
        const queued = await ctx.container.gatewayReceiptCaptures.receivePhoto(
          tenantA,
          systemActor(key()),
          {
            customerId: maryam,
            botInstanceId: BOT_A,
            file: {
              kind: 'PHOTO',
              fileId,
              fileUniqueId: fileId,
              mimeType: null,
              fileName: null,
              fileSize: BigInt(JPEG_BYTES.byteLength),
              telegramMessageId: 1n,
              caption: null,
            },
          },
        );
        expect(queued).toBe('QUEUED');
        return fileId;
      };
      const poisonedFile = await queue(first.paymentId);
      await queue(second.paymentId);
      fake.receiptMode = 'ACK';
      const errors: string[] = [];
      const poisoned = telegramLaneWith(ctx, fake, {
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (context, message) => errors.push(`${message} ${JSON.stringify(context)}`),
        },
        receiptFiles: {
          download: (scope, binding, options) =>
            binding.fileId === poisonedFile
              ? Promise.reject(new Error('disk full'))
              : ctx.container.receiptFiles.download(
                  scope,
                  { botInstanceId: binding.botInstanceId as never, fileId: binding.fileId },
                  options,
                ),
        },
      });
      const report = await poisoned.runOnce(tenantA);
      expect(report.rowFailures).toBe(1);
      expect(report.receipts).toBe(1);
      // The receipt after the one that threw was uploaded and opened its review.
      expect((await paymentOf(second.paymentId)).provider_review_until).not.toBeNull();
      // The one that threw: never sent, still queued, lease given back, retried later.
      const [backedOff] = await rows<{
        state: string;
        sent_at: string | null;
        claimed_until: string | null;
        retry_at: string | null;
      }>(
        sql`SELECT state, sent_at, claimed_until, retry_at FROM gateway_receipt_submissions
            WHERE payment_id = ${first.paymentId}`,
      );
      expect(backedOff).toMatchObject({ state: 'QUEUED', sent_at: null, claimed_until: null });
      expect(new Date(backedOff!.retry_at!).getTime()).toBeGreaterThan(clock.now().getTime());
      expect((await paymentOf(first.paymentId)).state).toBe('PENDING');
      expect(errors.some((line) => line.includes(first.paymentId))).toBe(true);
      expect(errors.join('\n')).not.toContain('disk full');
    });
  });

  describe('money in flight', () => {
    it('TPTG-36: in review and when UNKNOWN, the wallet purchase, the customer’s cancellation and withdrawal are refused, and the order is not expired', async () => {
      const review = await reviewed(30);
      const refusedWith = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error: unknown) {
          return isNexaError(error) ? error.code : String(error);
        }
        return 'accepted';
      };
      const tryAll = async () => {
        expect(
          await refusedWith(
            ctx.container.payments.settleFromWallet(tenantA, systemActor(key()), maryam, {
              idempotencyKey: key(),
              orderId: review.orderId,
            }),
          ),
        ).toBe('commerce.order_transfer_under_review');
        expect(
          await refusedWith(
            ctx.container.orders.cancelByCustomer(tenantA, systemActor(key()), {
              idempotencyKey: key(),
              customerId: maryam,
              orderId: review.orderId,
            }),
          ),
        ).toBe('commerce.order_transfer_under_review');
      };
      await tryAll();
      expect(
        await refusedWith(
          ctx.container.payments.withdrawPending(tenantA, systemActor(key()), maryam, {
            idempotencyKey: key(),
            paymentId: review.paymentId,
          }),
        ),
      ).toBe('commerce.order_transfer_under_review');
      expect((await paymentOf(review.paymentId)).state).toBe('PENDING');

      await lapse(review);
      await tryAll();
      // The order's own deadline passes while its payment is UNKNOWN: it is not expired.
      clock.at(new Date(review.reviewUntil.getTime() + 7 * 24 * 3_600_000));
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect(await orderState(review.orderId)).toBe('AWAITING_PAYMENT');
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
    });
  });

  describe('reconciliation', () => {
    it('TPTG-37: needs payments.reconcile and RECORDED evidence, only from UNKNOWN, conditional, and confirms through the one settlement path with RECONCILIATION evidence', async () => {
      const review = await reviewed(30);
      const reconcile = (actor: ActorContext, to: 'CONFIRMED' | 'FAILED', idempotencyKey = key()) =>
        ctx.container.payments.reconcileGatewayPayment(tenantA, actor, review.paymentId, {
          to,
          note: 'checked against the TonPays panel',
          idempotencyKey,
        });
      // The code, and WHICH refusal: the state check names the state, the evidence check
      // its reason — both are PAYMENT_STATE_INVALID, so the code alone cannot tell them apart.
      const code = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error: unknown) {
          if (!isNexaError(error)) return String(error);
          const which = error.details['reason'] ?? error.details['state'];
          return which === undefined ? error.code : `${error.code}:${String(which)}`;
        }
        return 'accepted';
      };
      // Only from UNKNOWN.
      expect(await code(reconcile(owner, 'CONFIRMED'))).toBe(
        'commerce.payment_state_invalid:PENDING',
      );
      await lapse(review);
      // Without the permission.
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'support-rv',
          roleKeys: ['support'],
        }),
      );
      expect(await code(reconcile(support, 'CONFIRMED'))).toBe('platform.permission_denied');
      // Without recorded evidence: the last inquiry said `processing`.
      expect(await code(reconcile(owner, 'CONFIRMED'))).toBe(
        'commerce.payment_state_invalid:RECONCILIATION_EVIDENCE_MISSING',
      );
      expect(await code(reconcile(owner, 'FAILED'))).toBe(
        'commerce.payment_state_invalid:RECONCILIATION_EVIDENCE_MISSING',
      );
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');

      // The operator asks the provider again; the answer is recorded, nothing moves.
      fake.set(review.invoiceId, 'completed', true);
      clock.at(new Date(review.reviewUntil.getTime() + 120_000));
      expect(
        await ctx.container.payments.reinquireGatewayPayment(tenantA, owner, review.paymentId, {
          idempotencyKey: key(),
        }),
      ).toBe(true);
      await lane.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');

      // Evidence says completed + paid: FAILED is refused, CONFIRMED settles, once.
      expect(await code(reconcile(owner, 'FAILED'))).toBe(
        'commerce.payment_state_invalid:RECONCILIATION_EVIDENCE_MISSING',
      );
      const confirmKey = key();
      await reconcile(owner, 'CONFIRMED', confirmKey);
      const replay = await reconcile(owner, 'CONFIRMED', confirmKey);
      expect(replay.state).toBe('CONFIRMED');
      expect(await code(reconcile(owner, 'CONFIRMED'))).toBe(
        'commerce.payment_state_invalid:CONFIRMED',
      );
      const payment = await paymentOf(review.paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(payment.evidence_kind).toBe('RECONCILIATION');
      expect(payment.confirmed_by_admin_id).not.toBeNull();
      expect(await orderState(review.orderId)).toBe('PAID');
    });

    it('TPTG-37: a recorded "no" lets an operator fail it, and the customer is told', async () => {
      const review = await reviewed(30);
      await lapse(review);
      fake.set(review.invoiceId, 'canceled', false);
      clock.at(new Date(review.reviewUntil.getTime() + 120_000));
      await ctx.container.payments.reinquireGatewayPayment(tenantA, owner, review.paymentId, {
        idempotencyKey: key(),
      });
      await lane.runOnce(tenantA);
      const failed = await ctx.container.payments.reconcileGatewayPayment(
        tenantA,
        owner,
        review.paymentId,
        { to: 'FAILED', note: null, idempotencyKey: key() },
      );
      expect(failed.state).toBe('FAILED');
      expect(await notified(review.paymentId)).toContain('GATEWAY_PAYMENT_FAILED');
      expect(await orderState(review.orderId)).toBe('AWAITING_PAYMENT');
    });
  });

  /*
   * The same rule over real HTTP (§10): the route takes the payment from the PATH, the
   * permission from the SESSION, and refuses with the service's own code — the Web Admin
   * not drawing the button for a support operator is not what stops them.
   */
  /*
   * The independent review of this route (F1–F12) and the lead's decision on OQ-TPTG-17:
   * while an order has money in flight through a provider, nothing invites a second payment;
   * an UNKNOWN always has a terminal exit; and the rules the first falsification record did
   * not isolate each have a test of their own.
   */
  describe('money in flight across the order (OQ-TPTG-17, decided)', () => {
    const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
    const refusal = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error: unknown) {
        return isNexaError(error) ? error.code : String(error);
      }
      return 'accepted';
    };
    const paymentsOf = async (orderId: string) =>
      (
        await rows<{ state: string }>(
          sql`SELECT state FROM payments WHERE order_id = ${orderId} ORDER BY created_at`,
        )
      ).map((row) => row.state);
    const inBot = (bot: BotInstanceId) => ({ tenantId: tenantA.tenantId, botInstanceId: bot });

    async function fourteenDayOrders() {
      await ctx.container.database.db.execute(sql`
        INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'sales.order_expiry_minutes',
                ${JSON.stringify(20_160)}::jsonb, 1)`);
    }

    async function enableWebsite() {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS',
        config: OPEN_ROUTE,
      });
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS',
        apiKey: 'tp_live_WEBSITE_review_key_0001',
      });
      await ctx.container.paymentGateways.setStatus(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TONPAYS',
        status: 'ACTIVE',
      });
    }

    async function activateBotB() {
      await ctx.container.database.db.execute(
        sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
      );
    }

    it('review F7: in review, the same route in the same bot hands the attempt back at minute 71 — no second invoice', async () => {
      // An order that outlives the customer window, so only the attempt's own rule decides.
      await fourteenDayOrders();
      const review = await reviewed(30);
      clock.at(new Date(review.expiresAt.getTime() + 60_000));
      const again = await ctx.container.payments.requestGatewayPayment(
        inBot(BOT_A),
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId: review.orderId, provider: 'TONPAYS_TELEGRAM' },
      );
      expect(again.payment.id).toBe(review.paymentId);
      expect(fake.creates).toHaveLength(1);
    });

    it('review F1: in review and when UNKNOWN, no new attempt — another bot, a manual transfer, a new tap — even with a 14-day order', async () => {
      await fourteenDayOrders();
      await activateBotB();
      const review = await reviewed(30);
      const tryAll = async () => {
        expect(
          await refusal(
            ctx.container.payments.requestGatewayPayment(
              inBot(BOT_A2),
              systemActor(key()),
              maryam,
              {
                idempotencyKey: key(),
                orderId: review.orderId,
                provider: 'TONPAYS_TELEGRAM',
              },
            ),
          ),
        ).toBe('commerce.order_transfer_under_review');
        expect(
          await refusal(
            ctx.container.payments.requestManualTransfer(inBot(BOT_A), systemActor(key()), maryam, {
              idempotencyKey: key(),
              orderId: review.orderId,
            }),
          ),
        ).toBe('commerce.order_transfer_under_review');
      };
      await tryAll();
      await lapse(review);
      await tryAll();
      // EXP-2: the customer taps the route again in the same bot. Nothing new is created.
      await tap(`gp:${review.orderId}.TONPAYS_TELEGRAM`);
      expect(await paymentsOf(review.orderId)).toEqual(['UNKNOWN']);
      expect(fake.creates).toHaveLength(1);
    });

    it('review F3: a receipt sent and not yet answered is money in flight — no cancellation, no withdrawal, no wallet purchase, no new attempt', async () => {
      await activateBotB();
      const created = await attempt();
      const opened = await ctx.container.gatewayReceiptCaptures.openReceiptCapture(
        inBot(BOT_A),
        systemActor(key()),
        { customerId: maryam, paymentId: created.paymentId, botInstanceId: BOT_A },
      );
      expect(opened).not.toBeNull();
      telegram.files.set('receipt-f3', JPEG_BYTES);
      expect(
        await ctx.container.gatewayReceiptCaptures.receivePhoto(inBot(BOT_A), systemActor(key()), {
          customerId: maryam,
          botInstanceId: BOT_A,
          file: {
            kind: 'PHOTO',
            fileId: 'receipt-f3',
            fileUniqueId: 'receipt-f3',
            mimeType: null,
            fileName: null,
            fileSize: BigInt(JPEG_BYTES.byteLength),
            telegramMessageId: 1n,
            caption: null,
          },
        }),
      ).toBe('QUEUED');
      expect(
        await refusal(
          ctx.container.orders.cancelByCustomer(tenantA, systemActor(key()), {
            idempotencyKey: key(),
            customerId: maryam,
            orderId: created.orderId,
          }),
        ),
      ).toBe('commerce.order_transfer_under_review');
      expect(
        await refusal(
          ctx.container.payments.withdrawPending(tenantA, systemActor(key()), maryam, {
            idempotencyKey: key(),
            paymentId: created.paymentId,
          }),
        ),
      ).toBe('commerce.order_transfer_under_review');
      expect(
        await refusal(
          ctx.container.payments.settleFromWallet(tenantA, systemActor(key()), maryam, {
            idempotencyKey: key(),
            orderId: created.orderId,
          }),
        ),
      ).toBe('commerce.order_transfer_under_review');
      expect(
        await refusal(
          ctx.container.payments.requestGatewayPayment(inBot(BOT_A2), systemActor(key()), maryam, {
            idempotencyKey: key(),
            orderId: created.orderId,
            provider: 'TONPAYS_TELEGRAM',
          }),
        ),
      ).toBe('commerce.order_transfer_under_review');
      expect(await paymentsOf(created.orderId)).toEqual(['PENDING']);
      expect(await orderState(created.orderId)).toBe('AWAITING_PAYMENT');
    });

    it('review F1 (race): a new attempt waiting on the payment a receipt is being queued under sees the receipt and is refused', async () => {
      await activateBotB();
      const created = await attempt();
      const window = await ctx.container.gatewayReceiptCaptures.openReceiptCapture(
        inBot(BOT_A),
        systemActor(key()),
        { customerId: maryam, paymentId: created.paymentId, botInstanceId: BOT_A },
      );
      if (window === null) throw new Error('no window');
      const repo = new DrizzlePaymentRepository(ctx.container.database.db);
      const cards = new DrizzleGatewayCardTransferRepository(ctx.container.database.db);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // The receipt lane's own shape: the payment's lock, then the submission, then commit.
      const queuing = ctx.container.uow.run(tenantA, async (tx) => {
        await repo.findByIdForUpdate(tenantA, created.paymentId, tx);
        locked();
        await held;
        return cards.queueSubmission(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            paymentId: created.paymentId,
            providerInvoiceId: created.invoiceId,
            botInstanceId: BOT_A,
            customerId: maryam,
            captureId: window.id,
            telegramFileId: 'race-file',
            telegramFileUniqueId: 'race-file',
            declaredSize: 10n,
            now: clock.now(),
          },
          tx,
        );
      });
      await holding;
      const requesting = refusal(
        ctx.container.payments.requestGatewayPayment(inBot(BOT_A2), systemActor(key()), maryam, {
          idempotencyKey: key(),
          orderId: created.orderId,
          provider: 'TONPAYS_TELEGRAM',
        }),
      );
      await awaitBlocked();
      release();
      expect(await queuing).not.toBeNull();
      expect(await requesting).toBe('commerce.order_transfer_under_review');
      expect(await paymentsOf(created.orderId)).toEqual(['PENDING']);
    });

    it('review F1: a receipt is refused while the order has another live payment', async () => {
      await enableWebsite();
      const created = await attempt();
      await ctx.container.payments.requestGatewayPayment(inBot(BOT_A), systemActor(key()), maryam, {
        idempotencyKey: key(),
        orderId: created.orderId,
        provider: 'TONPAYS',
      });
      expect(
        await ctx.container.gatewayReceiptCaptures.openReceiptCapture(
          inBot(BOT_A),
          systemActor(key()),
          { customerId: maryam, paymentId: created.paymentId, botInstanceId: BOT_A },
        ),
      ).not.toBeNull();
      telegram.files.set('receipt-f1', JPEG_BYTES);
      expect(
        await ctx.container.gatewayReceiptCaptures.receivePhoto(inBot(BOT_A), systemActor(key()), {
          customerId: maryam,
          botInstanceId: BOT_A,
          file: {
            kind: 'PHOTO',
            fileId: 'receipt-f1',
            fileUniqueId: 'receipt-f1',
            mimeType: null,
            fileName: null,
            fileSize: BigInt(JPEG_BYTES.byteLength),
            telegramMessageId: 1n,
            caption: null,
          },
        }),
      ).toBe('CLOSED');
      const [submitted] = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM gateway_receipt_submissions WHERE payment_id = ${created.paymentId}`,
      );
      expect(submitted?.n).toBe(0);
    });

    it('review F1 (backstop): an UNKNOWN whose order another payment settled is returned to the wallet, exactly, through the one credit path', async () => {
      // The website route, opened BEFORE any receipt — the coexistence the guard still allows.
      await enableWebsite();
      const created = await attempt();
      const website = await ctx.container.payments.requestGatewayPayment(
        inBot(BOT_A),
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), orderId: created.orderId, provider: 'TONPAYS' },
      );
      expect((await confirmNow(website.payment.id)).outcome).toBe('SETTLED');
      expect(await orderState(created.orderId)).toBe('PAID');
      /*
       * The Telegram attempt's review, written as a release before the guard would have
       * written it (the receipt is now refused while another payment settled the order):
       * the CHECK and the guard trigger accept exactly this shape.
       */
      const ackAt = new Date(created.expiresAt.getTime() - 40 * 60_000);
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET provider_review_started_at = ${ackAt.toISOString()}::timestamptz,
                   provider_review_until = ${ackAt.toISOString()}::timestamptz + interval '24 hours'
             WHERE id = ${created.paymentId}`,
      );
      const reviewUntil = new Date(ackAt.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS);
      await lapse({ paymentId: created.paymentId, reviewUntil });
      fake.set(created.invoiceId, 'completed', true);
      clock.at(new Date(reviewUntil.getTime() + 120_000));
      await ctx.container.payments.reinquireGatewayPayment(tenantA, owner, created.paymentId, {
        idempotencyKey: key(),
      });
      await lane.runOnce(tenantA);
      const reconciled = await ctx.container.payments.reconcileGatewayPayment(
        tenantA,
        owner,
        created.paymentId,
        { to: 'CONFIRMED', note: 'paid twice', idempotencyKey: key() },
      );
      // The order's one confirmed slot is the website payment's: this one is resolved FAILED
      // by the operator, and its money returned — the customer is told of the refund only.
      expect(reconciled.state).toBe('FAILED');
      expect(await orderState(created.orderId)).toBe('PAID');
      expect(await notified(created.paymentId)).not.toContain('GATEWAY_PAYMENT_FAILED');
      const refunds = await rows<{ state: string; amount: string; channel: string }>(
        sql`SELECT state, amount::text AS amount, channel FROM refunds WHERE payment_id = ${created.paymentId}`,
      );
      expect(refunds).toEqual([expect.objectContaining({ state: 'COMPLETED', amount: '250000' })]);
      const credits = await rows<{ amount: string }>(
        sql`SELECT amount::text AS amount FROM wallet_entries WHERE customer_id = ${maryam} AND amount > 0`,
      );
      expect(credits.map((row) => row.amount)).toEqual(['250000']);
      const [audit] = await rows<{ after: { returnedToWallet: string | null } }>(
        sql`SELECT after FROM audit_logs WHERE entity_id = ${created.paymentId}
             AND action = 'payment.reconcile_confirmed'`,
      );
      expect(audit?.after.returnedToWallet).toBe('250000');
    });

    it('review F2: reconciling CONFIRMED needs paid === true, not completed alone or with paid absent', async () => {
      const review = await reviewed(30);
      await lapse(review);
      const confirm = () =>
        ctx.container.payments.reconcileGatewayPayment(tenantA, owner, review.paymentId, {
          to: 'CONFIRMED',
          note: null,
          idempotencyKey: key(),
        });
      const reasonOf = async () => {
        try {
          await confirm();
        } catch (error: unknown) {
          return isNexaError(error) ? String(error.details['reason']) : String(error);
        }
        return 'accepted';
      };
      let at = review.reviewUntil.getTime() + 120_000;
      for (const paid of [false, undefined]) {
        fake.set(review.invoiceId, 'completed', paid);
        clock.at(new Date(at));
        await ctx.container.payments.reinquireGatewayPayment(tenantA, owner, review.paymentId, {
          idempotencyKey: key(),
        });
        await lane.runOnce(tenantA);
        expect((await invoiceOf(review.paymentId)).provider_status).toBe('completed');
        expect(await reasonOf()).toBe('RECONCILIATION_EVIDENCE_MISSING');
        at += 120_000;
      }
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');
    });

    it('review F5: the operator’s question passes the post-deadline bound, and is spaced a minute apart', async () => {
      const review = await reviewed(30);
      await lapse(review);
      // The bound reached by hints already: only the operator's question may pass it.
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET post_deadline_inquiries = 3 WHERE payment_id = ${review.paymentId}`,
      );
      fake.set(review.invoiceId, 'completed', true);
      clock.at(new Date(review.reviewUntil.getTime() + 120_000));
      const ask = () =>
        ctx.container.payments.reinquireGatewayPayment(tenantA, owner, review.paymentId, {
          idempotencyKey: key(),
        });
      expect(await ask()).toBe(true);
      // Back to back: the request just recorded spaces the next one.
      expect(await ask()).toBe(false);
      await lane.runOnce(tenantA);
      expect((await invoiceOf(review.paymentId)).provider_status).toBe('completed');
      // The inquiry just made spaces it too, though the request it answered is cleared.
      clock.at(new Date(review.reviewUntil.getTime() + 130_000));
      expect(await ask()).toBe(false);
    });

    it('review F5: in review, a customer’s check is spaced a minute after the last inquiry', async () => {
      const review = await reviewed(30);
      await lane.runOnce(tenantA);
      const [asked] = await rows<{ last_inquiry_at: string | null }>(
        sql`SELECT last_inquiry_at FROM gateway_invoices WHERE payment_id = ${review.paymentId}`,
      );
      if (asked?.last_inquiry_at == null) throw new Error('no inquiry was made');
      const last = new Date(asked.last_inquiry_at);
      clock.at(new Date(last.getTime() + 10_000));
      const view = await lane.attemptFor(tenantA, maryam, review.paymentId);
      if (view === null) throw new Error('no attempt');
      await lane.requestCheck(tenantA, view);
      expect(new Date((await invoiceOf(review.paymentId)).next_inquiry_at!).getTime()).toBe(
        last.getTime() + 60_000,
      );
    });

    it('review F8: reconciling resolves the open "review unresolved" condition', async () => {
      const review = await reviewed(30);
      await lapse(review);
      const open = () =>
        rows<{ resolved_at: string | null }>(
          sql`SELECT resolved_at FROM operational_events
               WHERE code = 'payments.gateway_review_unresolved' AND resolved_at IS NULL`,
        );
      expect(await open()).toHaveLength(1);
      fake.set(review.invoiceId, 'canceled', false);
      clock.at(new Date(review.reviewUntil.getTime() + 120_000));
      await ctx.container.payments.reinquireGatewayPayment(tenantA, owner, review.paymentId, {
        idempotencyKey: key(),
      });
      await lane.runOnce(tenantA);
      await ctx.container.payments.reconcileGatewayPayment(tenantA, owner, review.paymentId, {
        to: 'FAILED',
        note: null,
        idempotencyKey: key(),
      });
      expect(await open()).toEqual([]);
    });

    it('review F9: a lapsed review reaches the financial log as ops.financial.outcome_unknown', async () => {
      let flag = 0;
      const k = () => `f9-log-${String((flag += 1))}`;
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: k(),
        confirmKey: 'ops_notifications',
        reason: 'Review F9 financial log.',
      });
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '-1001234567890',
        expectedVersion: null,
        idempotencyKey: k(),
      });
      const review = await reviewed(30);
      await lapse(review);
      for (let round = 0; round < 20; round += 1) {
        if ((await ctx.container.relay.processBatch()).claimed === 0) break;
      }
      const logs = await rows<{ template_key: string }>(
        sql`SELECT template_key FROM notifications WHERE tenant_id = ${tenantA.tenantId}
             AND template_key = 'ops.financial.outcome_unknown'`,
      );
      expect(logs).toHaveLength(1);
    });
  });

  describe('reconciliation over HTTP', () => {
    let api: ApiApp;
    const ORIGIN = 'https://admin.example.test';

    beforeAll(async () => {
      api = await createApiApp(
        testConfig({ PANEL_HTTP_ALLOW_LOOPBACK: 'true', TELEGRAM_API_BASE_URL: telegram.base }),
      );
    }, 120_000);

    afterAll(async () => {
      await api?.close();
    });

    afterEach(() => {
      delete (api.container.clock as { now?: () => Date }).now;
    });

    const inject = (options: Record<string, unknown>) =>
      api.app
        .getHttpAdapter()
        .getInstance()
        .inject(options as never);

    async function cookieFor(username: string, roleKeys?: readonly string[]): Promise<string> {
      const password = `the-${username}-password`;
      if (roleKeys !== undefined) {
        await createAdmin(ctx.container, tenantA, { username, password, roleKeys });
      }
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.login}`,
        headers: { origin: ORIGIN },
        payload: { username, password },
      });
      const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
        String(response.headers['set-cookie'] ?? ''),
      );
      if (match === null) throw new Error(`no session for ${username}`);
      return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    }

    it('TPTG-37 (HTTP): support is refused, the evidence decides, a replay moves once, and the detail shows the review and the receipt lane', async () => {
      api.container.setInstallationTenant(tenantA.tenantId);
      // One clock for both containers: the review's deadlines are in the test's time.
      (api.container.clock as { now: () => Date }).now = () => ctx.container.clock.now();

      const review = await reviewed(30);
      let finance = await cookieFor('finance-rv', ['finance']);
      await createAdmin(ctx.container, tenantA, {
        username: 'support-rv-http',
        password: 'the-support-rv-http-password',
        roleKeys: ['support'],
      });
      const post = (cookie: string, route: string, payload: unknown) =>
        inject({
          method: 'POST',
          url: `${API_PREFIX}${route}`,
          headers: { cookie, origin: ORIGIN },
          payload,
        });
      const codeOf = (body: string) => (JSON.parse(body) as { error: { code: string } }).error.code;

      // In review, the detail shows it — and reconcile refuses: only UNKNOWN is reconciled.
      const inReview = await inject({
        method: 'GET',
        url: `${API_PREFIX}${PAYMENT_ROUTES.detail(review.paymentId)}`,
        headers: { cookie: finance },
      });
      expect(inReview.statusCode).toBe(200);
      const detail = paymentResponseSchema.parse(inReview.json()).payment;
      expect(detail.providerReviewUntil).toBe(review.reviewUntil.toISOString());
      expect(detail.gatewayInvoice?.receiptSubmissions.map((one) => one.state)).toEqual([
        'ACCEPTED',
      ]);
      expect(detail.gatewayInvoice?.receiptSubmissions[0]?.openedReview).toBe(true);
      // Never a Telegram file id, nor the card number, on the operator's wire.
      expect(inReview.body).not.toContain('photo-');
      expect(inReview.body).not.toContain('6037');
      const early = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), {
        idempotencyKey: 'http-early-1',
        to: 'CONFIRMED',
      });
      expect(early.statusCode).toBe(409);
      expect(codeOf(early.body)).toBe('commerce.payment_state_invalid');

      await lapse(review);
      // A day has passed on the shared clock: the sessions are taken afresh.
      finance = await cookieFor('finance-rv');
      const support = await cookieFor('support-rv-http');

      const denied = await post(support, PAYMENT_ROUTES.reconcile(review.paymentId), {
        idempotencyKey: 'http-denied-1',
        to: 'CONFIRMED',
      });
      expect(denied.statusCode).toBe(403);
      expect(codeOf(denied.body)).toBe('platform.permission_denied');
      const deniedAsk = await post(support, PAYMENT_ROUTES.reinquire(review.paymentId), {
        idempotencyKey: 'http-denied-2',
      });
      expect(deniedAsk.statusCode).toBe(403);
      // A malformed body is refused before anything is read.
      const malformed = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), {
        idempotencyKey: 'http-bad-1',
        to: 'PAID',
      });
      expect(malformed.statusCode).toBe(400);
      // No recorded `completed`+`paid` yet: the operator's word is not evidence.
      const unsupported = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), {
        idempotencyKey: 'http-unsupported-1',
        to: 'CONFIRMED',
      });
      expect(codeOf(unsupported.body)).toBe('commerce.payment_state_invalid');
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');

      fake.set(review.invoiceId, 'completed', true);
      clock.at(new Date(review.reviewUntil.getTime() + 120_000));
      const asked = await post(finance, PAYMENT_ROUTES.reinquire(review.paymentId), {
        idempotencyKey: 'http-ask-1',
      });
      expect(asked.statusCode).toBe(201);
      expect(paymentReinquireResponseSchema.parse(asked.json()).requested).toBe(true);
      await lane.runOnce(tenantA);
      expect((await paymentOf(review.paymentId)).state).toBe('UNKNOWN');

      const body = { idempotencyKey: 'http-confirm-1', to: 'CONFIRMED', note: 'checked' };
      const confirmed = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), body);
      expect(confirmed.statusCode).toBe(201);
      expect(paymentResponseSchema.parse(confirmed.json()).payment.state).toBe('CONFIRMED');
      const replay = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), body);
      expect(paymentResponseSchema.parse(replay.json()).payment.state).toBe('CONFIRMED');
      const again = await post(finance, PAYMENT_ROUTES.reconcile(review.paymentId), {
        ...body,
        idempotencyKey: 'http-confirm-2',
      });
      expect(codeOf(again.body)).toBe('commerce.payment_state_invalid');
      const payment = await paymentOf(review.paymentId);
      expect(payment.evidence_kind).toBe('RECONCILIATION');
      expect(await orderState(review.orderId)).toBe('PAID');
      const [credits] = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payments WHERE id = ${review.paymentId} AND state = 'CONFIRMED'`,
      );
      expect(credits?.n).toBe(1);
    });
  });

  /** Waits until PostgreSQL reports a backend of this database blocked on a lock. */
  async function awaitBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 2_500; attempt += 1) {
      const found = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query NOT ILIKE '%pg_stat_activity%'`,
      );
      if ((found[0]?.n ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('nothing ever blocked on a lock; the interleaving never happened');
  }
});
