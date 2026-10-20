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

function harness(options: { method: string; orderId: string | null; provider?: string | null }) {
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
      options.orderId === null ? null : { id: options.orderId, code: 'KQ7M2X9T' },
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
    service: async () => null,
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
    invoices: { findByPayment: async () => null },
    facts,
    words,
    refundRequests: { findById: async () => null },
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

  it('a bank-transfer order carries no wallet line: no wallet moved', async () => {
    const h = harness({ method: 'MANUAL_TRANSFER', orderId: 'ord-1' });
    await h.consumer.handle(h.event('PaymentConfirmed', confirmed('MANUAL_TRANSFER', 'ord-1')), TX);
    expect(h.queued[0]!.values).not.toHaveProperty('balanceBefore');
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
    expect(render(failed)).toContain('رسید توسط اپراتور رد شد');
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
