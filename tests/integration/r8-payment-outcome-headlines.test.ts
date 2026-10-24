import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  templateDefinition,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type TemplateKey,
  type TemplateValues,
  type UserId,
} from '@nexa/contracts';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleGatewayProviderRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-provider-request.repository';
import { DrizzleServiceRefundRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository';
import { SEED_IDS, createTestContext, tenantA, type TestContext } from './harness';

/**
 * Round 8 A3 — a non-successful payment gets the headline of what actually happened, in the
 * operations group (L4) and, through its template's name, on the Web Admin notifications page.
 *
 * Before: «❌ پرداخت ناموفق/رد شد · علت: درگاه پرداخت را ناموفق اعلام کرد» for a customer's
 * cancel, a gateway's rejected receipt, an expired invoice and a real failure alike. One
 * fixture per outcome, each a payment row exactly as the production path resolves it (the
 * `<provider>:<status>` note `failGatewayPayment` writes), through the real consumer and SQL.
 *
 * MUTATION (each reverted, the named test failed, restored):
 *  - `paymentFailureOutcome` returning FAILED for every gateway status -> the cancel, receipt
 *    and expiry tests;
 *  - the cancel request's `requestedByNexa` ignored -> 'a bare canceled…';
 *  - the operator's reason not quoted -> 'an operator rejecting a receipt…'.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('R8 A3: distinct headlines for a payment that did not succeed', () => {
  let ctx: TestContext;
  let c: UserId;
  let n = 0;
  const key = (label: string) => `r8-a3-${label}-${String((n += 1))}`;
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const run = <T>(work: (tx: never) => Promise<T>) =>
    ctx.container.uow.run(tenantA, (tx) => work(tx as never));

  beforeAll(async () => {
    ctx = await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('resolve-958301'),
      {
        idempotencyKey: 'resolve-958301',
        telegramUserId: '958301',
        from: { id: 958301, first_name: 'آرش', username: 'arash' },
        botInstanceId: BOT_A,
      },
    );
    c = customer.id;
  });

  /** A payment as the production path leaves it: FAILED, with its resolution note. */
  async function failedPayment(input: {
    method: 'GATEWAY' | 'MANUAL_TRANSFER';
    note: string;
  }): Promise<string> {
    const id = ctx.container.ids.uuid();
    await exec(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount,
        currency, reference, gateway_provider, resolution_note, resolved_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${c}, NULL, 'FAILED', ${input.method}, 180000, 'IRT',
        ${key('ref')}, ${input.method === 'GATEWAY' ? 'TONPAYS_TELEGRAM' : null},
        ${input.note}, now(), now())`);
    return id;
  }

  async function cancelRequest(paymentId: string, idempotencyKey: string): Promise<void> {
    await exec(sql`INSERT INTO gateway_provider_requests (id, tenant_id, payment_id, bot_instance_id,
        customer_id, kind, state, requested_at, sent_at, decided_at, idempotency_key)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${paymentId}, ${BOT_A}, ${c},
        'CANCEL', 'APPLIED', now(), now(), now(), ${idempotencyKey})`);
  }

  async function headline(
    paymentId: string,
    cause: 'REJECTED' | 'GATEWAY_FAILED',
  ): Promise<{ templateKey: string; text: string }> {
    const db = ctx.container.database.db;
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
      words,
      refundRequests: new DrizzleServiceRefundRequestRepository(db),
      providerRequests: new DrizzleGatewayProviderRequestRepository(db),
    });
    const event = {
      eventId: ctx.container.ids.uuid(),
      eventType: 'PaymentFailed',
      eventVersion: 1,
      tenantId: String(tenantA.tenantId),
      aggregateType: 'Payment',
      aggregateId: paymentId,
      sequence: 1,
      correlationId: 'r8-a3',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: new Date().toISOString(),
      payload: { customerId: c, orderId: null, method: 'GATEWAY', cause },
    } as unknown as DomainEvent;
    await run((tx) => consumer.handle(event, tx));
    expect(queued).toHaveLength(1);
    const one = queued[0]!;
    return {
      templateKey: one.templateKey,
      text: renderTemplateBody(
        templateDefinition(one.templateKey),
        CATALOGUE_FA[one.templateKey as never],
        one.values,
        'fa',
        DEFAULT_TEMPLATE_PRESENTATION,
      ),
    };
  }

  it('the customer’s «لغو فاکتور»: «فاکتور لغو شد», cancelled by the customer', async () => {
    const id = await failedPayment({
      method: 'GATEWAY',
      note: 'tonpays_telegram:canceled_by_customer',
    });
    const out = await headline(id, 'GATEWAY_FAILED');
    expect(out.templateKey).toBe('ops.financial.invoice_cancelled');
    expect(out.text.startsWith('🚫 فاکتور لغو شد')).toBe(true);
    expect(out.text).toContain('🙋 لغوکننده: مشتری');
    expect(out.text).not.toContain('ناموفق');
  });

  it('a bare canceled reads who asked from the payment’s cancel request — the customer, or Nexa', async () => {
    const asked = await failedPayment({ method: 'GATEWAY', note: 'tonpays_telegram:canceled' });
    await cancelRequest(asked, key('tap'));
    expect((await headline(asked, 'GATEWAY_FAILED')).text).toContain('لغوکننده: مشتری');

    const replaced = await failedPayment({ method: 'GATEWAY', note: 'tonpays_telegram:canceled' });
    await cancelRequest(replaced, `sibling-cancel:${ctx.container.ids.uuid()}`);
    expect((await headline(replaced, 'GATEWAY_FAILED')).text).toContain('لغوکننده: Nexa');

    const elsewhere = await failedPayment({ method: 'GATEWAY', note: 'tonpays:canceled' });
    expect((await headline(elsewhere, 'GATEWAY_FAILED')).text).toContain('لغوکننده: در خود درگاه');
  });

  it('a gateway rejecting the receipt: «رسید رد شد», with the gateway’s reasons', async () => {
    const id = await failedPayment({ method: 'GATEWAY', note: 'tonpays_telegram:rejected' });
    await run((tx) =>
      new DrizzleGatewayProviderRequestRepository(ctx.container.database.db).recordFacts(
        tenantA,
        id as never,
        {
          need: null,
          remainingAmount: null,
          remainingCardNumber: null,
          remainingCardHolder: null,
          remainingInvoiceId: null,
          remainingReceiptReceived: null,
          refundAmount: null,
          refundPending: null,
          rejectReasons: ['مبلغ رسید با فاکتور برابر نیست', 'low_balance'],
        },
        new Date(),
        tx,
      ),
    );
    const out = await headline(id, 'GATEWAY_FAILED');
    expect(out.templateKey).toBe('ops.financial.receipt_rejected');
    expect(out.text.startsWith('🧾 رسید رد شد')).toBe(true);
    expect(out.text).toContain('📝 دلیل رد: درگاه: مبلغ رسید با فاکتور برابر نیست، low_balance');
  });

  it('an operator rejecting a receipt: «رسید رد شد», with the operator’s own reason', async () => {
    const id = await failedPayment({ method: 'MANUAL_TRANSFER', note: 'رسید ناخوانا است' });
    const out = await headline(id, 'REJECTED');
    expect(out.templateKey).toBe('ops.financial.receipt_rejected');
    expect(out.text).toContain('📝 دلیل رد: اپراتور: رسید ناخوانا است');
  });

  it('an expired invoice: «پرداخت منقضی شد»', async () => {
    const id = await failedPayment({ method: 'GATEWAY', note: 'tonpays_telegram:expired' });
    const out = await headline(id, 'GATEWAY_FAILED');
    expect(out.templateKey).toBe('ops.financial.payment_expired');
    expect(out.text.startsWith('⌛ پرداخت منقضی شد')).toBe(true);
  });

  it('a real failure: «پرداخت ناموفق», with the real Persian cause — or the code beside the generic one', async () => {
    const missing = await failedPayment({
      method: 'GATEWAY',
      note: 'tonpays_telegram:nexa.credential_missing',
    });
    const out = await headline(missing, 'GATEWAY_FAILED');
    expect(out.templateKey).toBe('ops.financial.payment_failed');
    expect(out.text.startsWith('❌ پرداخت ناموفق')).toBe(true);
    expect(out.text).toContain('⚠️ علت: کلید API درگاه تنظیم نشده است');

    const odd = await failedPayment({ method: 'GATEWAY', note: 'nowpayments:SOME_NEW_CODE' });
    expect((await headline(odd, 'GATEWAY_FAILED')).text).toContain(
      'درگاه پرداخت را ناموفق اعلام کرد (کد: SOME_NEW_CODE)',
    );
  });

  it('the four headlines are four different template names on the Web Admin notifications page', async () => {
    const { TEMPLATE_COPY_FA } = await import('../../apps/web/src/i18n/templates.fa');
    const names = [
      'ops.financial.payment_failed',
      'ops.financial.invoice_cancelled',
      'ops.financial.receipt_rejected',
      'ops.financial.payment_expired',
    ].map((one) => (TEMPLATE_COPY_FA as Record<string, readonly string[]>)[one]?.[0]);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual([
      'گزارش مالی: پرداخت ناموفق',
      'گزارش مالی: فاکتور لغو شد',
      'گزارش مالی: رسید رد شد',
      'گزارش مالی: پرداخت منقضی شد',
    ]);
  });
});
