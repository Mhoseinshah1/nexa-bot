import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  type CurrencyCode,
  type DomainEvent,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import type {
  BalanceAround,
  LedgerEntryFact,
  OpsLogFacts,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';

/**
 * Round 4 PR-D — the payments topic (L1-L6), from synthetic payments and an in-memory ledger.
 *
 * What is asserted: the method's name appears once and in Persian; the payment is its short
 * public code; no id line; the wallet is shown before → after for a top-up, a wallet purchase
 * and a refund into the wallet; and the destination's switch decides whether anything is queued.
 *
 * MUTATION: reading the top-up balance from the wrong entries (`entriesOfPayment` reasons) ->
 * the L1 test; reading the wallet purchase from the wrong reason -> the L2 test; showing the
 * refund balance before the credit -> the L6 test.
 */

const AT = new Date('2026-10-12T09:30:00Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const irt = (n: number) => money(BigInt(n), 'IRT');
const TX = {} as never;

interface Row {
  id: string;
  paymentId: string | null;
  orderId: string | null;
  signed: bigint;
  reason: string;
  at: number;
  reference?: string;
}

interface OrderOverrides {
  readonly title?: string;
  readonly purpose?: string;
  readonly isFirstPurchase?: boolean;
  readonly reseller?: boolean;
}

function harness(options: {
  method: string;
  orderId: string | null;
  provider?: string | null;
  order?: OrderOverrides;
  invoice?: Record<string, unknown> | null;
  /** R11 A7: the panel account of the service the order is tied to; null/absent for none. */
  serviceUsername?: string | null;
  /** The payment's resolution note (`<provider>:<status>`), which picks the L4 headline. */
  resolutionNote?: string;
  /** A service refund request and the service it is about, for `ServiceRefundRequestResolved`. */
  refundRequest?: Record<string, unknown>;
  service?: Record<string, unknown>;
}) {
  const payment = {
    id: 'pay-1',
    code: 'RT4W8N2B',
    reference: 'ref-1',
    customerId: 'cust-1',
    orderId: options.orderId,
    method: options.method,
    gatewayProvider: options.provider ?? null,
    source: 'NEXA',
    amount: irt(250_000),
    customerFee: null,
    confirmedAt: AT,
    resolvedAt: AT,
    resolutionNote: options.resolutionNote ?? null,
  };
  const customer = {
    id: 'cust-1',
    telegramUserId: '700100200',
    username: 'nima_t',
    firstName: 'نیما',
    lastName: null,
    phoneNumber: null,
    source: 'NEXA',
    status: 'ACTIVE',
    blockedReason: null,
  };
  const ledger: Row[] = [];
  const entryOf = (row: Row): LedgerEntryFact =>
    ({
      id: row.id,
      customerId: 'cust-1',
      amount: irt(Number(row.signed < 0n ? -row.signed : row.signed)),
      reason: row.reason,
      reference: row.reference ?? `ref-${row.id}`,
    }) as LedgerEntryFact;
  const facts = {
    order: async () =>
      options.orderId === null
        ? null
        : {
            id: options.orderId,
            code: 'KQ7M2X9T',
            title: 'پلن ۳۰ روزه',
            purpose: 'NEW_SERVICE',
            isFirstPurchase: false,
            reseller: false,
            ...options.order,
          },
    entriesOfPayment: async (_s: unknown, paymentId: string, reasons: readonly string[]) =>
      ledger
        .filter((row) => row.paymentId === paymentId && reasons.includes(row.reason))
        .map(entryOf),
    ledgerEntryByReference: async (_s: unknown, reference: string) => {
      const row = ledger.find((one) => one.reference === reference);
      return row === undefined ? null : entryOf(row);
    },
    entriesOfOrder: async (_s: unknown, orderId: string, reason: string) =>
      ledger.filter((row) => row.orderId === orderId && row.reason === reason).map(entryOf),
    balanceAround: async (
      _s: unknown,
      _customerId: string,
      currency: CurrencyCode,
      ids: readonly string[],
    ): Promise<BalanceAround | null> => {
      if (ids.length === 0) return null;
      const last = Math.max(...ledger.filter((row) => ids.includes(row.id)).map((row) => row.at));
      const after = ledger
        .filter((row) => row.at <= last)
        .reduce((sum, row) => sum + row.signed, 0n);
      const own = ledger
        .filter((row) => ids.includes(row.id))
        .reduce((sum, row) => sum + row.signed, 0n);
      return { before: money(after - own, currency), after: money(after, currency) };
    },
    service: async () => (options.service ?? null) as never,
    serviceUsernameOfOrder: async () => options.serviceUsername ?? null,
    admin: async () => null,
  } as unknown as OpsLogFacts;
  const queued: Parameters<
    ConstructorParameters<typeof FinancialLogConsumer>[0]['lane']['queue']
  >[1][] = [];
  let destination: object | null = { transport: 'TELEGRAM' };
  const consumer = new FinancialLogConsumer({
    lane: {
      financialDestination: async () => destination as never,
      queue: async (_scope, input) => {
        queued.push(input);
        return undefined;
      },
    },
    payments: { findById: async () => payment as never },
    customers: { findById: async () => customer as never },
    invoices: { findByPayment: async () => (options.invoice ?? null) as never },
    facts,
    words,
    refundRequests: { findById: async () => (options.refundRequest ?? null) as never },
  });
  const event = (eventType: string, payload: unknown): DomainEvent =>
    ({
      eventId: `evt-${eventType}`,
      eventType,
      eventVersion: 1,
      tenantId: '01900000-0000-7000-8000-000000000001',
      aggregateType: 'Payment',
      aggregateId: 'pay-1',
      sequence: 1,
      correlationId: 'corr',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: AT.toISOString(),
      payload,
    }) as unknown as DomainEvent;
  return {
    ledger,
    queued,
    consumer,
    event,
    setDestination: (value: object | null) => (destination = value),
  };
}

const render = (input: { templateKey: TemplateKey | string; values: unknown }): string =>
  renderTemplateBody(
    templateDefinition(input.templateKey as TemplateKey),
    CATALOGUE_FA[input.templateKey as TemplateKey],
    input.values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

const confirmed = (method: string, orderId: string | null, evidenceKind = 'OPERATOR_REVIEW') => ({
  customerId: 'cust-1',
  orderId,
  method,
  evidenceKind,
  amountMinor: '250000',
  currency: 'IRT',
});

describe('L1 — a wallet top-up', () => {
  it('shows the wallet before → after of THE credit the payment wrote, the method once in Persian, the short code, two buttons', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: null });
    h.ledger.push(
      { id: 'e0', paymentId: null, orderId: null, signed: 40_000n, reason: 'ADMIN_CREDIT', at: 1 },
      {
        id: 'e1',
        paymentId: 'pay-1',
        orderId: null,
        signed: 250_000n,
        reason: 'TOPUP_RECEIPT',
        at: 2,
      },
      // After the credit: not part of the figure.
      { id: 'e2', paymentId: null, orderId: null, signed: 777_000n, reason: 'ADMIN_CREDIT', at: 3 },
    );
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', null)), TX);
    expect(h.queued).toHaveLength(1);
    const message = h.queued[0]!;
    expect(message.logType).toBe('PAYMENT_TOPUP');
    expect(message.values).toMatchObject({
      balanceBefore: irt(40_000),
      balanceAfter: irt(290_000),
      reference: 'RT4W8N2B',
    });
    expect(message.buttons).toEqual([
      { kind: 'USER', ref: 'cust-1' },
      { kind: 'PAYMENT', ref: 'pay-1' },
    ]);
    const text = render(message);
    expect(text).toContain('۴۰٬۰۰۰ تومان ← ۲۹۰٬۰۰۰ تومان');
    expect(text.match(/کارت به کارت/gu)).toHaveLength(1);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/MANUAL_TRANSFER|NaN|undefined/);
  });

  it('queues nothing when the payments log is not configured or switched off', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: null });
    h.setDestination(null);
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', null)), TX);
    expect(h.queued).toEqual([]);
  });

  it('is silent for a payment the import carried as history', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: null });
    await h.consumer.handle(
      h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', null, 'LEGACY_IMPORT')),
      TX,
    );
    expect(h.queued).toEqual([]);
  });
});

describe('L2 — an order paid', () => {
  it('a wallet payment shows the wallet before → after of THIS order’s purchase debit', async () => {
    const h = harness({ method: 'WALLET', orderId: 'ord-1' });
    h.ledger.push(
      { id: 'e0', paymentId: null, orderId: null, signed: 600_000n, reason: 'ADMIN_CREDIT', at: 1 },
      {
        id: 'e1',
        paymentId: 'pay-1',
        orderId: 'ord-1',
        signed: -250_000n,
        reason: 'PURCHASE',
        at: 2,
      },
      {
        id: 'e2',
        paymentId: null,
        orderId: null,
        signed: 5_000_000n,
        reason: 'ADMIN_CREDIT',
        at: 3,
      },
    );
    await h.consumer.handle(
      h.event('PaymentConfirmed', confirmed('WALLET', 'ord-1', 'WALLET_DEBIT')),
      TX,
    );
    const message = h.queued[0]!;
    expect(message.logType).toBe('PAYMENT_ORDER');
    expect(message.values).toMatchObject({
      balanceBefore: irt(600_000),
      balanceAfter: irt(350_000),
      orderCode: 'KQ7M2X9T',
    });
    expect(render(message)).toContain('۶۰۰٬۰۰۰ تومان ← ۳۵۰٬۰۰۰ تومان');
    expect(message.buttons).toEqual([
      { kind: 'USER', ref: 'cust-1' },
      { kind: 'PAYMENT', ref: 'pay-1' },
      { kind: 'ORDER', ref: 'ord-1' },
    ]);
  });

  /*
   * Hotfix v0.8.2-e (the owner's request): a wallet payment goes through no gateway and is
   * evidenced by its own debit, so «کارمزد درگاه: ۰» and «منبع تأیید: کسر از کیف پول» are noise;
   * a card or gateway payment keeps both. MUTATION: the WALLET branch that deletes them removed
   * -> the wallet row fails; the deletion made unconditional -> the card and gateway rows fail.
   */
  it.each([
    ['WALLET', null, 'WALLET_DEBIT', false],
    ['MANUAL_TRANSFER', null, 'OPERATOR_REVIEW', true],
    ['GATEWAY', 'TONPAYS', 'GATEWAY_INQUIRY', true],
  ] as const)(
    'a %s order payment (provider %s, evidence %s) prints the fee and evidence lines: %s',
    async (method, provider, evidenceKind, shown) => {
      const h = harness({ method, orderId: 'ord-1', provider });
      if (method === 'WALLET') {
        h.ledger.push(
          {
            id: 'e0',
            paymentId: null,
            orderId: null,
            signed: 600_000n,
            reason: 'ADMIN_CREDIT',
            at: 1,
          },
          {
            id: 'e1',
            paymentId: 'pay-1',
            orderId: 'ord-1',
            signed: -250_000n,
            reason: 'PURCHASE',
            at: 2,
          },
        );
      }
      await h.consumer.handle(
        h.event('PaymentConfirmed', confirmed(method, 'ord-1', evidenceKind)),
        TX,
      );
      const message = h.queued[0]!;
      expect(message.templateKey).toBe('ops.financial.order_paid');
      const text = render(message);
      expect(text.includes('💳 کارمزد درگاه:'), 'the fee line').toBe(shown);
      expect(text.includes('🔎 منبع تأیید:'), 'the evidence line').toBe(shown);
      // Everything else of the message stays: the amounts, and the wallet line for a wallet.
      expect(text).toContain('💰 مبلغ اصل: ۲۵۰٬۰۰۰ تومان');
      expect(text).toContain('💵 مبلغ قابل پرداخت: ۲۵۰٬۰۰۰ تومان');
      expect(text.includes('👛 موجودی کیف پول: ۶۰۰٬۰۰۰ تومان ← ۳۵۰٬۰۰۰ تومان')).toBe(
        method === 'WALLET',
      );
      expect(text).not.toMatch(/\{[a-zA-Z]+\}|NaN|undefined/);
    },
  );

  it('a bank-transfer order carries no wallet line: no wallet moved', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', 'ord-1')), TX);
    expect(h.queued[0]!.values).not.toHaveProperty('balanceBefore');
  });
});

describe('L2 — the product, the operation and the badges (R5C-2 C2)', () => {
  const paid = async (order: OrderOverrides) => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1', order });
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', 'ord-1')), TX);
    return { message: h.queued[0]!, text: render(h.queued[0]!) };
  };

  it('names the product and the operation, and no badge for an ordinary repeat purchase', async () => {
    const { text } = await paid({});
    expect(text).toContain('🏷 محصول: پلن ۳۰ روزه');
    expect(text).toContain('🔧 عملیات: خرید');
    expect(text.split('\n')[0]).toBe('✅ پرداخت سفارش تأیید شد');
    expect(text).not.toMatch(/نماینده|اولین خرید/);
  });

  it.each([
    ['NEW_SERVICE', 'خرید'],
    ['CUSTOM_SERVICE', 'خرید'],
    ['RENEW', 'تمدید'],
    ['ADD_TRAFFIC', 'حجم'],
    ['ADD_TIME', 'زمان'],
  ])('a %s order reads «%s»', async (purpose, word) => {
    const { text } = await paid({ purpose });
    expect(text).toContain(`🔧 عملیات: ${word}\n`);
  });

  it('shows the «اولین خرید» and «نماینده» badges in the title when they apply', async () => {
    const { text, message } = await paid({ isFirstPurchase: true, reseller: true });
    expect(text.split('\n')[0]).toBe('✅ پرداخت سفارش تأیید شد · 🥇 اولین خرید · 🧑‍💼 نماینده');
    expect(message.values).toMatchObject({ badges: ' · 🥇 اولین خرید · 🧑‍💼 نماینده' });
    expect((await paid({ reseller: true })).text.split('\n')[0]).toBe(
      '✅ پرداخت سفارش تأیید شد · 🧑‍💼 نماینده',
    );
  });
});

describe('L3 — a crypto payment', () => {
  it('is its own type, titled by what it paid for, and carries no fee or evidence line', async () => {
    const h = harness({ method: 'GATEWAY', orderId: null, provider: 'NOWPAYMENTS' });
    h.ledger.push({
      id: 'e1',
      paymentId: 'pay-1',
      orderId: null,
      signed: 250_000n,
      reason: 'TOPUP_CRYPTO',
      at: 1,
    });
    await h.consumer.handle(
      h.event('PaymentConfirmed', confirmed('GATEWAY', null, 'GATEWAY_INQUIRY')),
      TX,
    );
    const message = h.queued[0]!;
    expect(message.logType).toBe('PAYMENT_CRYPTO');
    expect(message.templateKey).toBe('ops.log.payment_crypto');
    expect(message.values).toMatchObject({ balanceBefore: irt(0), balanceAfter: irt(250_000) });
    expect(message.values).not.toHaveProperty('fee');
    const text = render(message);
    expect(text).toContain('شارژ کیف پول');
    // A figure this system does not hold is not printed, and the line is dropped whole.
    expect(text).not.toMatch(/\{[a-zA-Z]+\}|NaN|undefined/);
  });
});

describe('L3 — the crypto figures the provider reported (R5C-2 C4)', () => {
  const invoice = (overrides: Record<string, unknown> = {}) => ({
    provider: 'NOWPAYMENTS',
    providerUnit: 'USD',
    sentAmount: 1234n,
    requestAmount: 1234n,
    finalAmount: null,
    providerStatus: 'finished',
    providerInvoiceId: 'INV-1',
    hintedPaymentId: '5077125051',
    providerChargeId: null,
    conversionRateMinor: null,
    cryptoPayCurrency: 'MANA',
    cryptoRequested: '155.38559757',
    cryptoPaid: '155.38559757',
    cryptoReceived: '1131.7812095',
    cryptoReceivedCurrency: 'TRX',
    cryptoPayAddress: '0xd1cDE08A07cD25adEbEd35c3867a59228C09B606',
    ...overrides,
  });
  const paidCrypto = async (inv: Record<string, unknown>) => {
    const h = harness({
      method: 'GATEWAY',
      orderId: 'ord-1',
      provider: 'NOWPAYMENTS',
      invoice: inv,
    });
    await h.consumer.handle(
      h.event('PaymentConfirmed', confirmed('GATEWAY', 'ord-1', 'GATEWAY_INQUIRY')),
      TX,
    );
    return render(h.queued[0]!);
  };

  it('prints the requested, paid and received amounts and the pay address', async () => {
    const text = await paidCrypto(invoice());
    expect(text).toContain('🔢 مبلغ درخواستی: ۱۵۵٫۳۸۵۵۹۷۵۷ MANA');
    expect(text).toContain('💸 مبلغ پرداخت‌شده: ۱۵۵٫۳۸۵۵۹۷۵۷ MANA');
    expect(text).toContain('📥 مبلغ دریافتی نهایی: ۱۱۳۱٫۷۸۱۲۰۹۵ TRX');
    // The address is a token, never converted to Persian digits.
    expect(text).toContain('🏦 آدرس کیف پول: 0xd1cDE08A07cD25adEbEd35c3867a59228C09B606');
    expect(text).not.toMatch(/\{[a-zA-Z]+\}|NaN|undefined/);
  });

  it('labels the received figure with the pay currency only when the provider sent no outcome currency', async () => {
    const text = await paidCrypto(invoice({ cryptoReceivedCurrency: null }));
    expect(text).toContain('📥 مبلغ دریافتی نهایی: ۱۱۳۱٫۷۸۱۲۰۹۵ MANA');
  });

  it('drops a line the provider reported nothing for', async () => {
    const text = await paidCrypto(
      invoice({ cryptoPaid: null, cryptoReceived: null, cryptoPayAddress: null }),
    );
    expect(text).toContain('مبلغ درخواستی');
    expect(text).not.toMatch(/مبلغ پرداخت‌شده|مبلغ دریافتی نهایی|آدرس کیف پول/);
  });
});

describe('L4 / L5 — a failed payment, a late approval', () => {
  it('names the Persian cause and the method once; the late approval offers the manual credit button', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    await h.consumer.handle(
      h.event('PaymentFailed', {
        customerId: 'cust-1',
        orderId: 'ord-1',
        method: 'MANUAL_TRANSFER',
        cause: 'REJECTED',
      }),
      TX,
    );
    const failed = h.queued[0]!;
    expect(failed.logType).toBe('PAYMENT_FAILED');
    // R8 A3: an operator's rejection is «رسید رد شد», naming the operator.
    expect(failed.templateKey).toBe('ops.financial.receipt_rejected');
    expect(render(failed)).toContain('🧾 رسید رد شد');
    expect(render(failed)).toContain('دلیل رد: اپراتور');
    expect(render(failed).match(/کارت به کارت/gu)).toHaveLength(1);

    await h.consumer.handle(
      h.event('PaymentLateCompletionObserved', {
        customerId: 'cust-1',
        orderId: 'ord-1',
        provider: 'TONPAYS',
      }),
      TX,
    );
    const late = h.queued[1]!;
    expect(late.logType).toBe('PAYMENT_LATE');
    expect(late.buttons).toContainEqual({ kind: 'MANUAL_CREDIT', ref: 'cust-1' });
    expect(render(late)).not.toMatch(UUID);

    await h.consumer.handle(h.event('PaymentOutcomeUnknown', {}), TX);
    expect(h.queued[2]!.templateKey).toBe('ops.financial.outcome_unknown');
  });
});

describe('L6 — a refund', () => {
  const refundPayload = (channel: string) => ({
    refundId: 'rf-1',
    customerId: 'cust-1',
    paymentId: 'pay-1',
    orderId: 'ord-1',
    channel,
    amountMinor: '250000',
    currency: 'IRT',
  });

  it('a refund into the wallet shows the wallet before → after of the credit it wrote', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    h.ledger.push(
      { id: 'e0', paymentId: null, orderId: null, signed: 10_000n, reason: 'ADMIN_CREDIT', at: 1 },
      {
        id: 'e1',
        paymentId: 'pay-1',
        orderId: 'ord-1',
        signed: 250_000n,
        reason: 'REFUND',
        at: 2,
        reference: 'rf-1:refund',
      },
    );
    await h.consumer.handle(h.event('RefundCompleted', refundPayload('WALLET_CREDIT')), TX);
    const message = h.queued[0]!;
    expect(message.logType).toBe('REFUND');
    expect(message.values).toMatchObject({
      balanceBefore: irt(10_000),
      balanceAfter: irt(260_000),
    });
    expect(render(message)).toContain('۱۰٬۰۰۰ تومان ← ۲۶۰٬۰۰۰ تومان');
  });

  it('two partial refunds: each message shows the wallet around ITS OWN credit, never the newest', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    h.ledger.push(
      { id: 'e0', paymentId: null, orderId: null, signed: 10_000n, reason: 'ADMIN_CREDIT', at: 1 },
      {
        id: 'e1',
        paymentId: 'pay-1',
        orderId: 'ord-1',
        signed: 100_000n,
        reason: 'REFUND',
        at: 2,
        reference: 'rf-1:refund',
      },
      {
        id: 'e2',
        paymentId: 'pay-1',
        orderId: 'ord-1',
        signed: 50_000n,
        reason: 'REFUND',
        at: 3,
        reference: 'rf-2:refund',
      },
    );
    // The FIRST refund's event, handled after the second refund was written.
    await h.consumer.handle(
      h.event('RefundCompleted', {
        ...refundPayload('WALLET_CREDIT'),
        refundId: 'rf-1',
        amountMinor: '100000',
      }),
      TX,
    );
    expect(h.queued[0]!.values).toMatchObject({
      balanceBefore: irt(10_000),
      balanceAfter: irt(110_000),
    });
  });

  it('a refund outside the wallet moves no wallet line, and a failed one says why in Persian', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    await h.consumer.handle(h.event('RefundCompleted', refundPayload('EXTERNAL_MANUAL')), TX);
    expect(h.queued[0]!.values).not.toHaveProperty('balanceBefore');
    await h.consumer.handle(
      h.event('RefundFailed', { ...refundPayload('EXTERNAL_MANUAL'), cause: 'SUPERSEDED' }),
      TX,
    );
    expect(render(h.queued[1]!)).toContain('بازگشت وجه با درخواست دیگری جایگزین شد');
  });
});

/**
 * R11 A7 — every payment log of an order tied to a service prints the service's panel account
 * name as its own line («👤 نام کاربری سرویس»), and a log of an order with no service (and a
 * wallet top-up) prints no such line.
 *
 * MUTATIONS (each applied, the named tests red, reverted, green):
 *  - `FinancialLogConsumer.withServiceUsername` body removed -> every «names the service» case
 *    except order_paid / crypto (which read it in `PaymentConfirmed`) and the refund request;
 *  - the `PaymentConfirmed` call of `withServiceUsername` removed -> the order_paid and crypto cases;
 *  - the `ServiceRefundRequestResolved` line removed -> the refund-request case.
 */
describe('R11 A7 — payment logs of an order tied to a service name its panel account', () => {
  const LINE = '👤 نام کاربری سرویس: nx7k2m9q';
  const LABEL = 'نام کاربری سرویس';
  const refundPayload = (channel: string) => ({
    refundId: 'rf-1',
    customerId: 'cust-1',
    paymentId: 'pay-1',
    orderId: 'ord-1',
    channel,
    amountMinor: '250000',
    currency: 'IRT',
  });
  const invoice = {
    provider: 'TONPAYS',
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    creditAmount: 123_456n,
    providerInvoiceId: 'inv-1',
  };

  interface Case {
    readonly name: string;
    readonly template: string;
    readonly setup: Parameters<typeof harness>[0];
    readonly run: (h: ReturnType<typeof harness>) => Promise<void>;
  }
  const base = { method: 'MANUAL_TRANSFER', orderId: 'ord-1' } as const;
  const cases: Case[] = [
    {
      name: 'L2 order paid (card)',
      template: 'ops.financial.order_paid',
      setup: base,
      run: (h) =>
        h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', 'ord-1')), TX),
    },
    {
      name: 'L2 order paid (wallet)',
      template: 'ops.financial.order_paid',
      setup: { method: 'WALLET', orderId: 'ord-1' },
      run: async (h) => {
        h.ledger.push({
          id: 'e1',
          paymentId: 'pay-1',
          orderId: 'ord-1',
          signed: -250_000n,
          reason: 'PURCHASE',
          at: 1,
        });
        await h.consumer.handle(
          h.event('PaymentConfirmed', confirmed('WALLET', 'ord-1', 'WALLET_DEBIT')),
          TX,
        );
      },
    },
    {
      name: 'L3 crypto order payment',
      template: 'ops.log.payment_crypto',
      setup: { method: 'GATEWAY', orderId: 'ord-1', provider: 'NOWPAYMENTS' },
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentConfirmed', confirmed('GATEWAY', 'ord-1', 'GATEWAY_INQUIRY')),
          TX,
        ),
    },
    {
      name: 'L4 payment failed',
      template: 'ops.financial.payment_failed',
      setup: { ...base, resolutionNote: 'TONPAYS:failed' },
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentFailed', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            method: 'GATEWAY',
            cause: 'GATEWAY_FAILED',
          }),
          TX,
        ),
    },
    {
      name: 'L4 invoice cancelled',
      template: 'ops.financial.invoice_cancelled',
      setup: { ...base, resolutionNote: 'TONPAYS:canceled_by_customer' },
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentFailed', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            method: 'GATEWAY',
            cause: 'GATEWAY_FAILED',
          }),
          TX,
        ),
    },
    {
      name: 'L4 receipt rejected',
      template: 'ops.financial.receipt_rejected',
      setup: base,
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentFailed', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            method: 'MANUAL_TRANSFER',
            cause: 'REJECTED',
          }),
          TX,
        ),
    },
    {
      name: 'L4 payment expired',
      template: 'ops.financial.payment_expired',
      setup: { ...base, resolutionNote: 'TONPAYS:expired' },
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentFailed', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            method: 'GATEWAY',
            cause: 'GATEWAY_FAILED',
          }),
          TX,
        ),
    },
    {
      name: 'L4 underpaid',
      template: 'ops.financial.payment_underpaid',
      setup: { ...base, invoice },
      run: (h) =>
        h.consumer.handle(
          h.event('GatewayPaymentAttentionRaised', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
            reason: 'UNDERPAID',
          }),
          TX,
        ),
    },
    {
      name: 'L4 overpaid',
      template: 'ops.financial.payment_overpaid',
      setup: { ...base, invoice },
      run: (h) =>
        h.consumer.handle(
          h.event('GatewayPaymentAttentionRaised', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
            reason: 'OVERPAID',
          }),
          TX,
        ),
    },
    {
      name: 'L5 late completion',
      template: 'ops.financial.late_completion',
      setup: base,
      run: (h) =>
        h.consumer.handle(
          h.event('PaymentLateCompletionObserved', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
          }),
          TX,
        ),
    },
    {
      name: 'L5 outcome unknown',
      template: 'ops.financial.outcome_unknown',
      setup: base,
      run: (h) => h.consumer.handle(h.event('PaymentOutcomeUnknown', {}), TX),
    },
    {
      name: 'L5 credit amount mismatch',
      template: 'ops.financial.credit_amount_mismatch',
      setup: { method: 'GATEWAY', orderId: 'ord-1', provider: 'TONPAYS', invoice },
      run: (h) =>
        h.consumer.handle(
          h.event('GatewayPaymentAttentionRaised', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
            reason: 'CREDIT_AMOUNT_MISMATCH',
          }),
          TX,
        ),
    },
    {
      name: 'L5 late credit',
      template: 'ops.financial.late_credit',
      setup: base,
      run: async (h) => {
        h.ledger.push({
          id: 'e1',
          paymentId: 'pay-1',
          orderId: 'ord-1',
          signed: 250_000n,
          reason: 'GATEWAY_LATE_CREDIT',
          at: 1,
        });
        await h.consumer.handle(
          h.event('PaymentLateCredited', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
            entryId: 'e1',
            amountMinor: '250000',
            currency: 'IRT',
          }),
          TX,
        );
      },
    },
    {
      // R12 F1: money returned for a cancelled attempt / an order paid another way.
      name: 'L5 late credit returned',
      template: 'ops.financial.late_credit_returned',
      setup: base,
      run: async (h) => {
        h.ledger.push({
          id: 'e1',
          paymentId: 'pay-1',
          orderId: 'ord-1',
          signed: 250_000n,
          reason: 'GATEWAY_LATE_CREDIT',
          at: 1,
        });
        await h.consumer.handle(
          h.event('PaymentLateCredited', {
            customerId: 'cust-1',
            orderId: 'ord-1',
            provider: 'TONPAYS',
            entryId: 'e1',
            amountMinor: '250000',
            currency: 'IRT',
            basis: 'RETURNED',
          }),
          TX,
        );
      },
    },
    {
      name: 'L6 refund completed',
      template: 'ops.financial.refund_completed',
      setup: base,
      run: (h) =>
        h.consumer.handle(h.event('RefundCompleted', refundPayload('EXTERNAL_MANUAL')), TX),
    },
    {
      name: 'L6 refund failed',
      template: 'ops.financial.refund_failed',
      setup: base,
      run: (h) =>
        h.consumer.handle(
          h.event('RefundFailed', { ...refundPayload('EXTERNAL_MANUAL'), cause: 'SUPERSEDED' }),
          TX,
        ),
    },
    {
      name: 'L6 service refund request',
      template: 'ops.financial.service_refund_request',
      setup: {
        ...base,
        // Unlike the payment logs this one names the SERVICE directly (no order lookup).
        serviceUsername: null,
        service: { id: 'svc-1', code: 'SV3H5J7K', providerUsername: 'nx7k2m9q' },
        refundRequest: {
          customerId: 'cust-1',
          serviceId: 'svc-1',
          paymentId: 'pay-1',
          approvedAmount: irt(250_000),
          decidedByAdminId: null,
          resolvedAt: AT,
        },
      },
      run: (h) =>
        h.consumer.handle(
          h.event('ServiceRefundRequestResolved', {
            requestId: 'req-1',
            customerId: 'cust-1',
            paymentId: 'pay-1',
            outcome: 'COMPLETED',
          }),
          TX,
        ),
    },
  ];

  it.each(cases)('$name: prints the service username as its own line', async (one) => {
    const h = harness({ serviceUsername: 'nx7k2m9q', ...one.setup });
    await one.run(h);
    const message = h.queued.at(-1)!;
    expect(message.templateKey).toBe(one.template);
    expect(message.values).toMatchObject({ serviceUsername: 'nx7k2m9q' });
    const text = render(message);
    expect(text.split('\n')).toContain(LINE);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}|NaN|undefined/);
  });

  it.each(cases.filter((one) => one.name !== 'L6 service refund request'))(
    '$name: an order with no service prints no such line',
    async (one) => {
      const h = harness({ serviceUsername: null, ...one.setup });
      await one.run(h);
      const message = h.queued.at(-1)!;
      expect(message.templateKey).toBe(one.template);
      expect(message.values).not.toHaveProperty('serviceUsername');
      expect(render(message)).not.toContain(LABEL);
    },
  );

  it('a service refund request of a service the panel account of which is unknown prints no line', async () => {
    const h = harness({
      ...base,
      service: { id: 'svc-1', code: 'SV3H5J7K', providerUsername: '' },
      refundRequest: {
        customerId: 'cust-1',
        serviceId: 'svc-1',
        paymentId: 'pay-1',
        approvedAmount: null,
        decidedByAdminId: null,
        resolvedAt: AT,
      },
    });
    await h.consumer.handle(
      h.event('ServiceRefundRequestResolved', {
        requestId: 'req-1',
        customerId: 'cust-1',
        paymentId: 'pay-1',
        outcome: 'REJECTED',
      }),
      TX,
    );
    expect(render(h.queued[0]!)).not.toContain(LABEL);
  });

  it('a wallet top-up (no order) is unchanged: no service line, and no lookup', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: null, serviceUsername: 'nx7k2m9q' });
    h.ledger.push({
      id: 'e1',
      paymentId: 'pay-1',
      orderId: null,
      signed: 250_000n,
      reason: 'TOPUP_RECEIPT',
      at: 1,
    });
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', null)), TX);
    const message = h.queued[0]!;
    expect(message.templateKey).toBe('ops.financial.topup_credited');
    expect(message.values).not.toHaveProperty('serviceUsername');
    expect(render(message)).not.toContain(LABEL);
  });

  it('prints only the username: a subscription link or token that sits in the name is redacted', async () => {
    const h = harness({
      ...base,
      serviceUsername: 'https://sub.example.com/s/0123456789abcdef0123456789abcdef',
    });
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', 'ord-1')), TX);
    const text = render(h.queued[0]!);
    expect(text).toContain('👤 نام کاربری سرویس: [redacted]');
    expect(text).not.toContain('sub.example.com');
    expect(text).not.toContain('0123456789abcdef');
  });
});
