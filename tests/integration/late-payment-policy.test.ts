import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
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
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { tenantB } from './harness';
import { withDatabaseScope } from '../../apps/api/src/infrastructure/persistence/database-scope';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import {
  resolveLatePaymentPolicy,
  settingsLateCreditPolicy,
} from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
import { lateDeliveryOrderId } from '../../apps/api/src/modules/commerce/payments/application/late-delivery';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
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

/**
 * NEXA-OWNER-BATCH-1 PR-5 — each online gateway's late-payment POLICY: WALLET, REVIEW, DELIVER.
 *
 * Built exactly like `late-gateway-credit.test.ts` (the container's services decide, the lane
 * runs the REAL `TonPaysAdapter` over a recording fake TonPays), with the lane wired as the
 * container wires it: the one policy resolver, the credit, and the delivery.
 *
 * MUTATIONS (run on this branch; each turns at least one case below red — the PR body lists
 * which): drop the `EXISTING` stop in `lateDeliveryPreamble` (the exactly-once guard); drop each
 * of the four DELIVER conditions (sellable, covers, capacity → the purchase's own
 * `prepareFulfilment`, blocked); charge `PAYMENT_PLACE_PERMISSION` instead of
 * `payments.reconcile` in `decideLateCompletion`.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910910';
const API_KEY = 'tp_live_KEY_that_must_never_leak_71c0de';
const SWITCH = 'payments.late_credit.tonpays_enabled';

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

interface FakeInvoice {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amount: number;
  /** What the provider says it was asked for; defaults to the real amount. */
  requestAmount: number | null;
  status: string;
  paid: unknown;
}

/** The documented TonPays request and response shapes, and nothing more. */
class FakeTonPays {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly checks: string[] = [];
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice: FakeInvoice = {
        invoiceId,
        orderId: String(body.order_id),
        amount: Number(body.amount),
        requestAmount: Number(body.amount),
        status: 'pending',
        paid: false,
      };
      this.invoices.set(invoiceId, invoice);
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount + 37,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}?p=xyz`,
        callback_url: body.callback_url,
      });
    }
    if (url.endsWith('/api/v1/invoices/check')) {
      const invoiceId = String(body.invoice_id);
      this.checks.push(invoiceId);
      const invoice = this.invoices.get(invoiceId);
      if (invoice === undefined) {
        return json(404, { detail: { code: 'INVOICE_NOT_FOUND', message: 'x' } });
      }
      return json(200, {
        invoice_id: invoice.invoiceId,
        order_id: invoice.orderId,
        ...(invoice.requestAmount === null ? {} : { request_amount: invoice.requestAmount }),
        final_amount: invoice.amount + 37,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND', message: 'x' } });
  };

  set(invoiceId: string, status: string, paid: unknown): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = status;
    invoice.paid = paid;
  }

  setRequestAmount(invoiceId: string, amount: number | null): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.requestAmount = amount;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the late-payment policy of an online gateway', () => {
  let ctx: TestContext;
  let telegram: Server;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let updateSeq = 0;
  let settingSeq = 0;
  /** What the customer's notification lane handed to Telegram. */
  const sends: { templateKey: string; values: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      request.on('data', () => undefined);
      request.on('end', () => {
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
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-lp', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-lp-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-m'), {
        intake: 'INTERNAL',
        idempotencyKey: 'resolve-m',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    tonpays = new FakeTonPays();
    offsetMs = 0;
    sends.length = 0;
    lane = laneWith(tonpays);
  });

  /** The production lane's wiring: the same policy reader and the same credit path. */
  function laneWith(
    fake: FakeTonPays,
    withLateCredit = true,
    invoiceScreens?: { refresh(scope: TenantContext, paymentId: string): Promise<void> },
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TonPaysAdapter({ fetch: fake.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
      budget: new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async (scope: TenantContext, provider) =>
        gatewayCallbackUrl(await origins.originFor(scope), provider, String(scope.tenantId)),
      customers: new DrizzleCustomerRepository(db),
      conditions: new DrizzleOperationalConditionReader(db),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      outbox: ctx.container.outbox,
      clock: { now: () => new Date(Date.now() + offsetMs) },
      ids: ctx.container.ids,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...(invoiceScreens === undefined ? {} : { invoiceScreens }),
      ...(withLateCredit
        ? {
            lateCredit: {
              policyFor: settingsLateCreditPolicy(ctx.container.settingsResolver),
              credit: (scope, actor, id, input) =>
                ctx.container.payments.creditLateGatewayApproval(scope, actor, id, input),
              latePolicy: (scope, provider) =>
                resolveLatePaymentPolicy(ctx.container.settingsResolver, scope, provider),
              deliver: (scope, actor, id, input) =>
                ctx.container.payments.deliverLateGatewayApproval(scope, actor, id, input),
            },
          }
        : {}),
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function setSetting(key: string, value: unknown) {
    settingSeq += 1;
    const current = (await ctx.container.settingsService.list(tenantA, owner)).find(
      (row) => row.key === key,
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key,
      value,
      expectedVersion: current?.version ?? null,
      idempotencyKey: `lp-setting-${String(settingSeq)}`,
    });
  }

  async function enableTonPays(config: Partial<PaymentGatewayConfig> = {}) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: 'tp-cfg',
      provider: 'TONPAYS',
      config: { ...OPEN_ROUTE, ...config },
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: 'tp-cred',
      provider: 'TONPAYS',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: 'tp-on',
      provider: 'TONPAYS',
      status: 'ACTIVE',
    });
  }

  async function product(priceMinor = 250_000n): Promise<ProductId> {
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
        price: money(priceMinor, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  const tap = (data: string) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `lp-update-${String(updateSeq)}`,
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
    });
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function draftOrder(priceMinor = 250_000n): Promise<string> {
    const productId = await product(priceMinor);
    await tap(`p:${productId}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (draft === undefined) throw new Error('no draft');
    await tap(`Z:${draft.id}`);
    return draft.id;
  }

  async function payWithGateway(orderId: string): Promise<{ paymentId: PaymentId }> {
    await tap(`g:${orderId}`);
    const [payment] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}
          AND method = 'GATEWAY' ORDER BY created_at DESC LIMIT 1`,
    );
    if (payment === undefined) throw new Error('no gateway payment');
    return { paymentId: payment.id as PaymentId };
  }

  const pass = () => lane.runOnce(tenantA);

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      provider_invoice_id: string | null;
      outcome: string | null;
      late_completion_observed_at: Date | null;
      next_inquiry_at: Date | null;
      last_inquiry_at: Date | null;
      post_deadline_inquiries: number;
      inquiry_attempts: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{ state: string; reference: string; code: string | null }>(
      sql`SELECT state, reference, code FROM payments WHERE id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const walletTotal = async () => {
    const balance = await new DrizzleWalletRepository(ctx.container.database.db).balanceOf(
      tenantA,
      maryam,
      'IRT',
    );
    return balance.amountMinor;
  };

  /** What the customer was told about this payment, other than that it expired. */
  const notices = (paymentId: string) =>
    rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
           AND subject_id = ${paymentId} AND kind <> 'PAYMENT_EXPIRED' ORDER BY created_at, kind`,
    );

  const serviceCount = async () =>
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM services WHERE tenant_id = ${tenantA.tenantId}`,
      )
    )[0]!.n;

  const webhook = (
    invoice: { provider_order_id: string; provider_invoice_id: string | null },
    status: string,
    deliveryId: string,
  ) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS',
      {
        invoice_id: invoice.provider_invoice_id,
        order_id: invoice.provider_order_id,
        request_amount: 250000,
        final_amount: 250037,
        credit_amount: 250037,
        status,
        paid: status === 'completed',
        delivery_id: deliveryId,
        event: `invoice.${status}`,
        occurred_at: 1727200000,
        api_version: 1,
      },
      deliveryId,
    );

  /** A created attempt for a fresh order. */
  async function createdAttempt(priceMinor = 250_000n) {
    await enableTonPays();
    const orderId = await draftOrder(priceMinor);
    const { paymentId } = await payWithGateway(orderId);
    await pass();
    const invoice = await invoiceOf(paymentId);
    if (invoice.provider_invoice_id === null) throw new Error('not created');
    return { orderId, paymentId, invoice, invoiceId: invoice.provider_invoice_id };
  }

  /** The attempt's deadline passed, as the database sees it; the sweep has not run. */
  const pastDeadline = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
    );

  // -------------------------------------------------------------------------------------
  // PR-5 fixtures
  // -------------------------------------------------------------------------------------

  let keySeq = 0;
  const key = () => `lp-key-${String((keySeq += 1))}`;

  /** The attempt closed for good: its deadline and its order's passed, and the sweep ran. */
  async function closed(orderId: string, paymentId: string, orderStaysOpen = false) {
    await pastDeadline(paymentId);
    await ctx.container.database.db.execute(
      orderStaysOpen
        ? sql`UPDATE orders SET expires_at = now() + interval '1 hour' WHERE id = ${orderId}`
        : sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${orderId}`,
    );
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
    expect(await orderState(orderId)).toBe(orderStaysOpen ? 'AWAITING_PAYMENT' : 'EXPIRED');
  }

  /** The provider approves the closed attempt; a webhook brings the inquiry forward. */
  async function approveLate(
    invoice: { provider_order_id: string; provider_invoice_id: string | null },
    invoiceId: string,
    delivery: string,
  ) {
    tonpays.set(invoiceId, 'completed', true);
    await webhook(invoice, 'completed', delivery);
    offsetMs += 6 * 60_000;
    return pass();
  }

  const servicesOf = (orderId: string) =>
    rows<{ id: string; order_id: string; provider_username: string }>(
      sql`SELECT id, order_id, provider_username FROM services
           WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}`,
    );

  const walletEntries = () =>
    rows<{ reason: string; direction: string; amount: string; reference: string }>(
      sql`SELECT reason, direction, amount::text AS amount, reference FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
           ORDER BY reason, created_at`,
    );

  const lateEvent = async (paymentId: string) =>
    (
      await rows<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM outbox_messages
             WHERE event_type = 'PaymentLateCredited' AND aggregate_id = ${paymentId}`,
      )
    ).map((row) => row.payload);

  async function finance(): Promise<ActorContext> {
    return adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: `fin-${key()}`,
        roleKeys: ['finance'],
      }),
    );
  }

  const decide = (
    actor: ActorContext,
    paymentId: string,
    choice: 'DELIVER' | 'WALLET',
    k = key(),
  ) =>
    ctx.container.payments.decideLateCompletion(tenantA, actor, paymentId, {
      choice,
      idempotencyKey: k,
    });

  /** The «پرداخت دیرهنگام» situation on the payment's page. */
  async function situationActions(paymentId: string) {
    const record = await ctx.container.payments.get(tenantA, owner, paymentId);
    const found = await ctx.container.payments.situations(tenantA, owner, [record]);
    return found.get(record.id as PaymentId)?.guide.actions ?? [];
  }

  /** The panel takes no new service (drained by its operator): no capacity for this one. */
  const fillPanel = () =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'نگهداری' WHERE id = ${panelId}`,
    );

  // =====================================================================================
  // The migration
  // =====================================================================================

  it('the migration maps a stored true to WALLET and false to REVIEW, audits each, and leaves every other value alone', async () => {
    const db = ctx.container.database.db;
    const insert = (settingKey: string, value: string) =>
      db.execute(sql`
        INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
        VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${settingKey}, ${value}::jsonb, 3, now())
        ON CONFLICT (tenant_id, setting_key) DO UPDATE SET value = EXCLUDED.value, version = 3`);
    await insert('payments.late_credit.tonpays_enabled', 'true');
    await insert('payments.late_credit.tetrapay_enabled', 'false');
    await insert('payments.late_credit.rialit_enabled', '"DELIVER"');
    await insert('payments.late_credit.window_hours', '12');
    const file = readFileSync(
      join(__dirname, '../../apps/api/drizzle/0322_late_payment_policy.sql'),
      'utf8',
    );
    for (const statement of file.split('--> statement-breakpoint')) {
      await db.execute(sql.raw(statement));
    }
    const stored = await rows<{ setting_key: string; value: unknown; version: number }>(
      sql`SELECT setting_key, value, version FROM setting_values
           WHERE tenant_id = ${tenantA.tenantId} AND setting_key LIKE 'payments.late_credit.%'
           ORDER BY setting_key`,
    );
    expect(stored).toEqual([
      { setting_key: 'payments.late_credit.rialit_enabled', value: 'DELIVER', version: 3 },
      { setting_key: 'payments.late_credit.tetrapay_enabled', value: 'REVIEW', version: 4 },
      { setting_key: 'payments.late_credit.tonpays_enabled', value: 'WALLET', version: 4 },
      { setting_key: 'payments.late_credit.window_hours', value: 12, version: 3 },
    ]);
    const audits = await rows<{ entity_id: string; before: unknown; after: unknown }>(
      sql`SELECT entity_id, before, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND actor_label = 'migration:0322_late_payment_policy'
           ORDER BY entity_id`,
    );
    expect(audits).toEqual([
      {
        entity_id: 'payments.late_credit.tetrapay_enabled',
        before: { value: false, source: 'TENANT' },
        after: { value: 'REVIEW', source: 'TENANT' },
      },
      {
        entity_id: 'payments.late_credit.tonpays_enabled',
        before: { value: true, source: 'TENANT' },
        after: { value: 'WALLET', source: 'TENANT' },
      },
    ]);
    // Re-running moves nothing: there is no boolean left.
    for (const statement of file.split('--> statement-breakpoint')) {
      await db.execute(sql.raw(statement));
    }
    expect(
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE actor_label = 'migration:0322_late_payment_policy'`,
        )
      )[0]!.n,
    ).toBe(2);
    // And the resolver reads what was written; an unstored route keeps its old default's meaning.
    expect(await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'TONPAYS')).toBe(
      'WALLET',
    );
    expect(
      await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'TETRAPAY'),
    ).toBe('REVIEW');
    expect(await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'RIALIT')).toBe(
      'DELIVER',
    );
    expect(
      await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'TONPAYS_TELEGRAM'),
    ).toBe('WALLET');
    expect(await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'CUSTOM')).toBe(
      'REVIEW',
    );
    // Stars and card-to-card name no setting: they keep their own rules.
    expect(
      await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'TELEGRAM_STARS'),
    ).toBeNull();
    expect(
      await resolveLatePaymentPolicy(ctx.container.settingsResolver, tenantA, 'MANUAL_TRANSFER'),
    ).toBeNull();
  });

  // =====================================================================================
  // WALLET
  // =====================================================================================

  it('WALLET is unchanged: a closed attempt approved late is credited once, nothing is built, the customer is told the credit', async () => {
    await setSetting(SWITCH, 'WALLET');
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await closed(orderId, paymentId);
    const report = await approveLate(invoice, invoiceId, 'w-1');
    expect(report.lateCredits).toBe(1);
    expect(await walletEntries()).toEqual([
      {
        reason: 'GATEWAY_LATE_CREDIT',
        direction: 'CREDIT',
        amount: '250000',
        reference: `${paymentId}:late-credit`,
      },
    ]);
    expect(await serviceCount()).toBe(0);
    expect(await orderState(lateDeliveryOrderId(paymentId))).toBeUndefined();
    expect((await notices(paymentId)).map((n) => n.kind)).toEqual([
      'GATEWAY_LATE_PAYMENT_CREDITED',
    ]);
    // The event is the one it always was: no disposition field on the plain WALLET path.
    const [event] = await lateEvent(paymentId);
    expect(event).not.toHaveProperty('disposition');
  });

  // =====================================================================================
  // DELIVER
  // =====================================================================================

  describe('DELIVER', () => {
    beforeEach(async () => {
      await setSetting(SWITCH, 'DELIVER');
    });

    it('delivers the service of an EXPIRED order through a fulfilment order tied to the payment, at the order’s frozen total, once', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      const report = await approveLate(invoice, invoiceId, 'd-1');
      expect(report.lateCredits).toBe(1);
      expect(report.lateCompletions).toBe(0);

      const fulfilment = lateDeliveryOrderId(paymentId);
      // The original order stays EXPIRED (frozen); the fulfilment order is the one PAID.
      expect(await orderState(orderId)).toBe('EXPIRED');
      expect(await orderState(fulfilment)).toBe('PAID');
      const [copy] = await rows<{ total_amount: string; product_id: string; panel_id: string }>(
        sql`SELECT total_amount::text, product_id, panel_id FROM orders WHERE id = ${fulfilment}`,
      );
      const [orig] = await rows<{ total_amount: string; product_id: string; panel_id: string }>(
        sql`SELECT total_amount::text, product_id, panel_id FROM orders WHERE id = ${orderId}`,
      );
      expect(copy).toEqual(orig);
      // One service, for the fulfilment order, planned for the provisioner.
      expect(await servicesOf(fulfilment)).toHaveLength(1);
      expect(await serviceCount()).toBe(1);
      // The money passed through the wallet once: the late credit, then the purchase. Net zero.
      expect(await walletEntries()).toEqual([
        {
          reason: 'GATEWAY_LATE_CREDIT',
          direction: 'CREDIT',
          amount: '250000',
          reference: `${paymentId}:late-credit`,
        },
        { reason: 'PURCHASE', direction: 'DEBIT', amount: '250000', reference: expect.any(String) },
      ]);
      expect(await walletTotal()).toBe(0n);
      // The payment itself is untouched (EXPIRED stays frozen); its invoice says LATE_CREDITED.
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
      // No «credited to your wallet» message: the service is the customer's message.
      expect(await notices(paymentId)).toEqual([]);
      const [event] = await lateEvent(paymentId);
      expect(event).toMatchObject({
        disposition: 'DELIVERED',
        deliveredOrderId: fulfilment,
        decidedBy: 'POLICY',
      });
    });

    it('pays the ORIGINAL order when it still awaits payment', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId, true);
      await approveLate(invoice, invoiceId, 'd-orig');
      expect(await orderState(orderId)).toBe('PAID');
      expect(await servicesOf(orderId)).toHaveLength(1);
      expect(await orderState(lateDeliveryOrderId(paymentId))).toBeUndefined();
      expect(await walletTotal()).toBe(0n);
      const [event] = await lateEvent(paymentId);
      expect(event).toMatchObject({ disposition: 'DELIVERED', deliveredOrderId: orderId });
    });

    async function expectFallback(paymentId: string, reason: string, amount = '250000') {
      // The WALLET path: the payment's amount in the wallet once, nothing built, the customer told.
      expect(await walletEntries()).toEqual([
        {
          reason: 'GATEWAY_LATE_CREDIT',
          direction: 'CREDIT',
          amount,
          reference: `${paymentId}:late-credit`,
        },
      ]);
      expect(await walletTotal()).toBe(BigInt(amount));
      expect(await serviceCount()).toBe(0);
      expect(await orderState(lateDeliveryOrderId(paymentId))).toBeUndefined();
      expect((await notices(paymentId)).map((n) => n.kind)).toEqual([
        'GATEWAY_LATE_PAYMENT_CREDITED',
      ]);
      const events = await lateEvent(paymentId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ disposition: 'DELIVERY_FALLBACK', fallbackReason: reason });
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
    }

    it('falls back to the wallet when the product is no longer sellable', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      const [line] = await rows<{ product_id: string }>(
        sql`SELECT product_id FROM orders WHERE id = ${orderId}`,
      );
      await products.setStatus(
        tenantA,
        line!.product_id as ProductId,
        'ACTIVE',
        'INACTIVE',
        ctx.container.clock.now(),
      );
      await approveLate(invoice, invoiceId, 'f-product');
      await expectFallback(paymentId, 'PRODUCT_NOT_SELLABLE');
    });

    it('falls back to the wallet when the payment does not cover the order’s total (never re-priced)', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      /*
       * The order's frozen total is more than the attempt's principal (an order repriced after
       * its attempt was issued). Its snapshot guard is lifted for this one write only.
       */
      const db = ctx.container.database.db;
      await db.execute(sql`ALTER TABLE orders DISABLE TRIGGER USER`);
      try {
        await db.execute(
          sql`UPDATE orders SET total_amount = 300000, subtotal_amount = 300000,
                                line_unit_price_amount = 300000
               WHERE id = ${orderId}`,
        );
      } finally {
        await db.execute(sql`ALTER TABLE orders ENABLE TRIGGER USER`);
      }
      await closed(orderId, paymentId);
      await approveLate(invoice, invoiceId, 'f-amount');
      await expectFallback(paymentId, 'AMOUNT_DOES_NOT_COVER');
    });

    it('falls back to the wallet when the panel has no room', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      await fillPanel();
      await approveLate(invoice, invoiceId, 'f-panel');
      await expectFallback(paymentId, 'PANEL_FULL');
    });

    it('falls back to the wallet when the customer is blocked', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      await ctx.container.customers.block(tenantA, owner, {
        idempotencyKey: key(),
        customerId: maryam,
        reason: 'آزمون',
      });
      await approveLate(invoice, invoiceId, 'f-blocked');
      await expectFallback(paymentId, 'CUSTOMER_BLOCKED');
    });

    it('a CANCELLED order is not delivered: the money goes to the wallet with the reason', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId, true);
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET state = 'CANCELLED', cancelled_at = now() WHERE id = ${orderId}`,
      );
      await approveLate(invoice, invoiceId, 'f-cancelled');
      await expectFallback(paymentId, 'ORDER_CLOSED');
    });

    it('a double callback and concurrent deliveries settle the payment ONCE', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      tonpays.set(invoiceId, 'completed', true);
      await webhook(invoice, 'completed', 'dd-1');
      await webhook(invoice, 'completed', 'dd-1');
      await webhook(invoice, 'completed', 'dd-2');
      offsetMs += 6 * 60_000;
      await pass();
      offsetMs += 6 * 60_000;
      await pass();
      const deliver = () =>
        ctx.container.payments.deliverLateGatewayApproval(tenantA, systemActor('race'), paymentId, {
          providerRequestAmount: 250_000n,
          evidenceNote: null,
        });
      const raced = await Promise.all([deliver(), deliver(), deliver()]);
      expect(raced.map((one) => one.outcome)).toEqual([
        'ALREADY_SETTLED',
        'ALREADY_SETTLED',
        'ALREADY_SETTLED',
      ]);
      expect(await serviceCount()).toBe(1);
      expect(
        (await walletEntries()).filter((e) => e.reason === 'GATEWAY_LATE_CREDIT'),
      ).toHaveLength(1);
      expect((await walletEntries()).filter((e) => e.reason === 'PURCHASE')).toHaveLength(1);
      expect(await walletTotal()).toBe(0n);
      expect(await lateEvent(paymentId)).toHaveLength(1);
    });

    it('three first deliveries racing on three connections: exactly one writes, the rest find it', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      tonpays.set(invoiceId, 'completed', true);
      const bare = laneWith(tonpays, false);
      offsetMs += 6 * 60_000;
      await bare.runOnce(tenantA);
      const deliver = () =>
        ctx.container.payments.deliverLateGatewayApproval(tenantA, systemActor('race'), paymentId, {
          providerRequestAmount: 250_000n,
          evidenceNote: null,
        });
      const raced = await Promise.all([deliver(), deliver(), deliver()]);
      expect(raced.filter((one) => one.outcome === 'DELIVERED')).toHaveLength(1);
      expect(raced.filter((one) => one.outcome === 'ALREADY_SETTLED')).toHaveLength(2);
      expect(await serviceCount()).toBe(1);
      expect(await walletTotal()).toBe(0n);
    });

    it('a delivery racing an operator’s «به کیف پول» settles once, whichever wins', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      tonpays.set(invoiceId, 'completed', true);
      offsetMs += 6 * 60_000;
      await laneWith(tonpays, false).runOnce(tenantA);
      const operator = await finance();
      const [lane, op] = await Promise.allSettled([
        ctx.container.payments.deliverLateGatewayApproval(tenantA, systemActor('race'), paymentId, {
          providerRequestAmount: 250_000n,
          evidenceNote: null,
        }),
        decide(operator, paymentId, 'WALLET'),
      ]);
      const delivered = lane.status === 'fulfilled' && lane.value.outcome === 'DELIVERED';
      const credited = op.status === 'fulfilled';
      expect([delivered, credited].filter(Boolean)).toHaveLength(1);
      expect(
        (await walletEntries()).filter((e) => e.reason === 'GATEWAY_LATE_CREDIT'),
      ).toHaveLength(1);
      expect(await walletTotal()).toBe(delivered ? 0n : 250_000n);
      expect(await serviceCount()).toBe(delivered ? 1 : 0);
      if (!credited) {
        expect(
          op.status === 'rejected' && isNexaError(op.reason) && op.reason.details,
        ).toMatchObject({
          reason: 'LATE_PAYMENT_ALREADY_SETTLED',
        });
      }
    });
  });

  // =====================================================================================
  // REVIEW
  // =====================================================================================

  describe('REVIEW', () => {
    beforeEach(async () => {
      await setSetting(SWITCH, 'REVIEW');
    });

    /** A late completion in the operator's queue: nothing moved. */
    async function lateCompletion() {
      const attempt = await createdAttempt();
      await closed(attempt.orderId, attempt.paymentId);
      const report = await approveLate(attempt.invoice, attempt.invoiceId, `r-${key()}`);
      expect(report.lateCompletions).toBe(1);
      expect(await walletEntries()).toEqual([]);
      expect((await invoiceOf(attempt.paymentId)).outcome).toBe('LATE_COMPLETION');
      expect(await situationActions(attempt.paymentId)).toEqual([
        'LATE_DELIVER',
        'LATE_TO_WALLET',
        'VERIFY_AT_PROVIDER',
      ]);
      return attempt;
    }

    it('«تحویل سرویس» delivers once; a second decision — the same click again, another operator, the other choice — moves nothing', async () => {
      const { paymentId } = await lateCompletion();
      const operator = await finance();
      const k = key();
      const first = await decide(operator, paymentId, 'DELIVER', k);
      expect(first.outcome).toBe('DELIVERED');
      expect(await orderState(lateDeliveryOrderId(paymentId))).toBe('PAID');
      expect(await serviceCount()).toBe(1);
      // The same request again (a lost answer, a double click): answered, nothing more.
      expect((await decide(operator, paymentId, 'DELIVER', k)).outcome).toBe('ALREADY_SETTLED');
      // Another operator, either choice: refused.
      const other = await finance();
      await expect(decide(other, paymentId, 'DELIVER')).rejects.toMatchObject({
        details: { reason: 'LATE_PAYMENT_ALREADY_SETTLED' },
      });
      await expect(decide(other, paymentId, 'WALLET')).rejects.toMatchObject({
        details: { reason: 'LATE_PAYMENT_ALREADY_SETTLED' },
      });
      expect(await serviceCount()).toBe(1);
      expect(await walletEntries()).toHaveLength(2);
      expect(await walletTotal()).toBe(0n);
      const [event] = await lateEvent(paymentId);
      expect(event).toMatchObject({ disposition: 'DELIVERED', decidedBy: 'OPERATOR' });
      // Out of the queue: nothing left to decide.
      expect(await situationActions(paymentId)).not.toContain('LATE_DELIVER');
    });

    it('«به کیف پول» credits once and builds nothing; a second decision moves nothing', async () => {
      const { paymentId } = await lateCompletion();
      const operator = await finance();
      const first = await decide(operator, paymentId, 'WALLET');
      expect(first.outcome).toBe('CREDITED');
      expect(await walletTotal()).toBe(250_000n);
      expect(await serviceCount()).toBe(0);
      expect((await notices(paymentId)).map((n) => n.kind)).toEqual([
        'GATEWAY_LATE_PAYMENT_CREDITED',
      ]);
      await expect(decide(operator, paymentId, 'DELIVER')).rejects.toMatchObject({
        details: { reason: 'LATE_PAYMENT_ALREADY_SETTLED' },
      });
      expect(await walletTotal()).toBe(250_000n);
      expect(await serviceCount()).toBe(0);
    });

    it('two operators racing on the two choices: exactly one decision lands', async () => {
      const { paymentId } = await lateCompletion();
      const [a, b] = [await finance(), await finance()];
      const raced = await Promise.allSettled([
        decide(a, paymentId, 'DELIVER'),
        decide(b, paymentId, 'WALLET'),
      ]);
      expect(raced.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
      expect(
        (await walletEntries()).filter((e) => e.reason === 'GATEWAY_LATE_CREDIT'),
      ).toHaveLength(1);
      const delivered = (await serviceCount()) === 1;
      expect(await walletTotal()).toBe(delivered ? 0n : 250_000n);
    });

    it('«تحویل سرویس» with a failing condition goes to the wallet, with the reason', async () => {
      const { paymentId } = await lateCompletion();
      await fillPanel();
      const answer = await decide(await finance(), paymentId, 'DELIVER');
      expect(answer).toMatchObject({ outcome: 'CREDITED', fallbackReason: 'PANEL_FULL' });
      expect(await walletTotal()).toBe(250_000n);
      expect(await serviceCount()).toBe(0);
      const [event] = await lateEvent(paymentId);
      expect(event).toMatchObject({
        disposition: 'DELIVERY_FALLBACK',
        fallbackReason: 'PANEL_FULL',
        decidedBy: 'OPERATOR',
      });
    });

    it('an administrator without payments.reconcile is refused, and nothing moves', async () => {
      const { paymentId } = await lateCompletion();
      // A receipt reviewer reads payments and decides card-to-card receipts, and nothing more.
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'rr-lp',
          roleKeys: ['receipt_reviewer'],
        }),
      );
      for (const choice of ['DELIVER', 'WALLET'] as const) {
        await expect(decide(support, paymentId, choice)).rejects.toMatchObject({
          code: 'platform.permission_denied',
        });
      }
      expect(await walletEntries()).toEqual([]);
      expect(await serviceCount()).toBe(0);
      const denied = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE entity_id = ${paymentId} AND result = 'DENIED'`,
      );
      expect(denied[0]!.n).toBeGreaterThanOrEqual(2);
    });

    it('another tenant cannot see or decide this tenant’s late completion', async () => {
      const { paymentId } = await lateCompletion();
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-lp-b', roleKeys: ['owner'] }),
      );
      for (const choice of ['DELIVER', 'WALLET'] as const) {
        await expect(
          ctx.container.payments.decideLateCompletion(tenantB, ownerB, paymentId, {
            choice,
            idempotencyKey: key(),
          }),
        ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });
      }
      expect(await walletEntries()).toEqual([]);
      expect(await serviceCount()).toBe(0);
    });

    it('RLS: as nexa_app, another tenant sees none of the delivery’s rows; the tenant itself sees them all', async () => {
      const { paymentId } = await lateCompletion();
      await decide(await finance(), paymentId, 'DELIVER');
      const fulfilment = lateDeliveryOrderId(paymentId);
      const app = ctx.applicationDatabase;
      const counts = (scope: typeof tenantA) =>
        withDatabaseScope(scope, async () => {
          const result = await app.db.execute(sql`
            SELECT (SELECT count(*)::int FROM payments WHERE id = ${paymentId}) AS payments,
                   (SELECT count(*)::int FROM orders WHERE id = ${fulfilment}) AS orders,
                   (SELECT count(*)::int FROM wallet_entries WHERE payment_id = ${paymentId}) AS credits,
                   (SELECT count(*)::int FROM services WHERE order_id = ${fulfilment}) AS services,
                   (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${paymentId}
                      AND event_type = 'PaymentLateCredited') AS events`);
          return result.rows[0];
        });
      expect(await counts(tenantB)).toEqual({
        payments: 0,
        orders: 0,
        credits: 0,
        services: 0,
        events: 0,
      });
      expect(await counts(tenantA)).toEqual({
        payments: 1,
        orders: 1,
        credits: 1,
        services: 1,
        events: 1,
      });
    });

    it('the lane never delivers under REVIEW, however often the approval is seen', async () => {
      const { paymentId, invoice, invoiceId } = await lateCompletion();
      await approveLate(invoice, invoiceId, 'r-again');
      expect(await walletEntries()).toEqual([]);
      expect(await serviceCount()).toBe(0);
      // And the lane's own delivery refuses under the lock: the policy is read again there.
      const lane = await ctx.container.payments.deliverLateGatewayApproval(
        tenantA,
        systemActor('direct'),
        paymentId,
        {
          providerRequestAmount: 250_000n,
          evidenceNote: null,
        },
      );
      expect(lane).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'SETTING_OFF' });
    });
  });

  // =====================================================================================
  // The operations log
  // =====================================================================================

  describe('the operations log', () => {
    const LOG_CHAT = '-1001234567890';
    let flagSeq = 0;

    async function configureLog() {
      const k = () => `lp-log-${String((flagSeq += 1))}`;
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: k(),
        confirmKey: 'ops_notifications',
        reason: 'Late payment log.',
      });
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: LOG_CHAT,
        expectedVersion: null,
        idempotencyKey: k(),
      });
    }

    async function relayAll() {
      for (let round = 0; round < 20; round += 1) {
        const result = await ctx.container.relay.processBatch();
        if (result.claimed === 0) return;
      }
    }

    const logs = (templateKey: string) =>
      rows<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = ${templateKey}`,
      );

    it('a delivery names the gateway and the delivered service’s panel username', async () => {
      await configureLog();
      await setSetting(SWITCH, 'DELIVER');
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      await approveLate(invoice, invoiceId, 'log-d');
      await relayAll();
      await relayAll();
      const [service] = await servicesOf(lateDeliveryOrderId(paymentId));
      const written = await logs('ops.financial.late_delivered');
      expect(written).toHaveLength(1);
      expect(written[0]!.payload).toMatchObject({
        gateway: 'تون‌پی (وب‌سایت)',
        serviceUsername: service!.provider_username,
        amount: { amountMinor: '250000', currency: 'IRT' },
      });
      expect(await logs('ops.financial.late_credit')).toHaveLength(0);
    });

    it('a fallback names the gateway and the reason', async () => {
      await configureLog();
      await setSetting(SWITCH, 'DELIVER');
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      await fillPanel();
      await approveLate(invoice, invoiceId, 'log-f');
      await relayAll();
      await relayAll();
      const written = await logs('ops.financial.late_delivery_fallback');
      expect(written).toHaveLength(1);
      expect(written[0]!.payload).toMatchObject({
        gateway: 'تون‌پی (وب‌سایت)',
        cause: 'پنل ظرفیت ندارد',
        balanceAfter: { amountMinor: '250000', currency: 'IRT' },
      });
    });

    it('a REVIEW late completion carries «تحویل سرویس» and «به کیف پول», each opening the payment’s decision', async () => {
      await configureLog();
      await setSetting(SWITCH, 'REVIEW');
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      await closed(orderId, paymentId);
      await approveLate(invoice, invoiceId, 'log-r');
      await relayAll();
      await relayAll();
      const written = await logs('ops.financial.late_completion');
      expect(written).toHaveLength(1);
      expect(written[0]!.payload['__buttons']).toEqual([
        { kind: 'LATE_DELIVER', ref: paymentId },
        { kind: 'LATE_TO_WALLET', ref: paymentId },
        { kind: 'USER', ref: maryam },
      ]);
    });
  });
});
