import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  money,
  paymentTrackingCode,
  type PaymentGatewayProvider,
  type PaymentId,
  type TemplateKey,
  type TemplateValues,
  type UserId,
} from '@nexa/contracts';
import { createTranslator } from '@nexa/i18n';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import type { GatewayCardFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * FIX-02 (2026-10-09): every payment invoice carries the payment's ONE public tracking code
 * before anything is paid, every later screen of the same payment carries the same code, and
 * no customer text ever carries the stored, role-suffixed reference (`…:topup`, `…:gateway`).
 *
 * The screens are rendered through the REAL catalogue, so a template that loses its line, or
 * a call site that passes the raw reference, fails here as the customer would see it.
 */

const CODE = '7d433a363380f69e';
const LINE = `کد پیگیری پرداخت: ${CODE}`;
/** Every role suffix a payment reference is written with — none may reach a customer. */
const SUFFIXES = [':topup', ':gateway', ':gateway-topup', ':manual', ':wallet', ':purchase'];

const translator = createTranslator();
function rendered(key: TemplateKey | null, values: TemplateValues): string {
  if (key === null) throw new Error('a screen with no key');
  return appearanceFallbackText(translator.translate(key, values));
}

const AT = new Date('2026-10-09T10:00:00Z');
const EXPIRES_AT = new Date('2026-10-09T11:10:00Z');
const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;

function payment(kind: 'ORDER' | 'TOPUP', overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
    orderId: kind === 'ORDER' ? ('01a0fa00-0000-7000-8000-0000000000d1' as never) : null,
    state: 'PENDING',
    method: 'GATEWAY',
    amount: money(250_000n, 'IRT'),
    // The stored shape, suffix and all: what the screens must NOT print.
    reference: `${CODE}:${kind === 'ORDER' ? 'gateway' : 'gateway-topup'}`,
    evidenceKind: null,
    evidenceNote: null,
    externalReference: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'TONPAYS',
    topupCashbackPercent: null,
    customerFee: null,
    providerReviewStartedAt: null,
    providerReviewUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function invoice(
  provider: PaymentGatewayProvider,
  overrides: Partial<GatewayInvoiceRecord> = {},
): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider,
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'INV-1',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    providerUserId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: 'https://t.me/pay',
    webInvoiceUrl: 'https://pay.example/i/1',
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
    fx: null,
    botInstanceId: '01900000-0000-7000-8000-00000000a001',
    providerChargeId: null,
    requestAmount: 250_000n,
    finalAmount: null,
    creditAmount: null,
    providerStatus: 'pending',
    providerPaid: false,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
    inquiryAttempts: 0,
    nextInquiryAt: null,
    postDeadlineInquiries: 0,
    webhookStatusHint: null,
    lastWebhookAt: null,
    lastWebhookDeliveryId: null,
    webhookCount: 0,
    outcome: null,
    outcomeAt: null,
    lateCompletionObservedAt: null,
    cardNumber: provider === 'TONPAYS_TELEGRAM' ? '6037-9911-0000-1001' : null,
    cardName: provider === 'TONPAYS_TELEGRAM' ? 'علی رضایی' : null,
    cardSeq: 1,
    cardReceivedAt: AT,
    cardChangeShown: true,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: false,
    reconcileInquiryRequestedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as GatewayInvoiceRecord;
}

const NO_FACTS: GatewayCardFacts = { latestChange: null, submissions: [] };

function screen(
  provider: PaymentGatewayProvider,
  kind: 'ORDER' | 'TOPUP',
  paymentOver: Partial<PaymentRecord> = {},
  invoiceOver: Partial<GatewayInvoiceRecord> = {},
): { key: TemplateKey | null; text: string } {
  const reply = gatewayAttemptScreen(
    {
      payment: payment(kind, { gatewayProvider: provider, ...paymentOver }),
      invoice: invoice(provider, invoiceOver),
    },
    null,
    AT,
    provider === 'TONPAYS_TELEGRAM' ? NO_FACTS : null,
  );
  return { key: reply.key, text: rendered(reply.key, reply.values) };
}

function expectCodeAndNoSuffix(text: string, where: string): void {
  expect(text, `${where}: the code line`).toContain(LINE);
  for (const suffix of SUFFIXES) {
    expect(text, `${where}: ${suffix} leaked`).not.toContain(suffix);
  }
}

const PROVIDERS: readonly PaymentGatewayProvider[] = [
  'TONPAYS',
  'TONPAYS_TELEGRAM',
  'NOWPAYMENTS',
  'CENTRALPAY',
  'TELEGRAM_STARS',
];
const KINDS = ['ORDER', 'TOPUP'] as const;

describe('FIX-02: the gateway invoice carries the code BEFORE anything is paid', () => {
  for (const provider of PROVIDERS) {
    for (const kind of KINDS) {
      it(`${provider} ${kind}: the preparing screen and the invoice show «${LINE}»`, () => {
        const preparing = screen(provider, kind, {}, { creationState: 'CREATING' });
        expectCodeAndNoSuffix(preparing.text, `${provider} ${kind} preparing (${preparing.key})`);
        const ready = screen(provider, kind);
        expectCodeAndNoSuffix(ready.text, `${provider} ${kind} invoice (${ready.key})`);
      });

      it(`${provider} ${kind}: the invoice with a customer fee shows it too`, () => {
        const fee = {
          basisPoints: 300,
          fee: money(7_500n, 'IRT'),
          payable: money(257_500n, 'IRT'),
        };
        const ready = screen(provider, kind, { customerFee: fee as never });
        expectCodeAndNoSuffix(ready.text, `${provider} ${kind} fee invoice (${ready.key})`);
      });
    }
  }
});

describe('FIX-02: the same code on every later screen of the same payment', () => {
  const states: readonly {
    readonly name: string;
    readonly payment?: Partial<PaymentRecord>;
    readonly invoice?: Partial<GatewayInvoiceRecord>;
  }[] = [
    { name: 'confirmed', payment: { state: 'CONFIRMED' } },
    { name: 'failed (not approved)', payment: { state: 'FAILED' } },
    {
      name: 'failed (create refused)',
      payment: { state: 'FAILED' },
      invoice: { creationState: 'CREATE_FAILED' },
    },
    { name: 'create refused, still pending', invoice: { creationState: 'CREATE_FAILED' } },
    { name: 'expired', payment: { expiresAt: new Date(AT.getTime() - 1) } },
    { name: 'closed', payment: { state: 'EXPIRED' as never } },
    { name: 'unresolved', payment: { state: 'UNKNOWN' } },
    {
      name: 'in review',
      payment: { providerReviewUntil: new Date(AT.getTime() + 60_000) },
    },
    {
      name: 'review lapsed',
      payment: { providerReviewUntil: new Date(AT.getTime() - 1) },
    },
  ];
  for (const provider of PROVIDERS) {
    for (const kind of KINDS) {
      it(`${provider} ${kind}: every state quotes the one code, never a suffix`, () => {
        for (const state of states) {
          const shown = screen(provider, kind, state.payment, state.invoice);
          expectCodeAndNoSuffix(shown.text, `${provider} ${kind} ${state.name} (${shown.key})`);
        }
      });
    }
  }

  it('a create whose answer was lost, and a created invoice with no link, quote it too', () => {
    const lost = screen('TONPAYS', 'ORDER', {}, { creationState: 'CREATE_UNKNOWN' as never });
    expectCodeAndNoSuffix(lost.text, `create unknown (${lost.key})`);
    const noLink = screen('TONPAYS', 'ORDER', {}, { invoiceUrl: null, webInvoiceUrl: null });
    expectCodeAndNoSuffix(noLink.text, `no link (${noLink.key})`);
  });

  it('a TonPays card invoice without a card quotes it', () => {
    const missing = screen('TONPAYS_TELEGRAM', 'TOPUP', {}, { creationErrorCode: 'NO_CARD' });
    expect(missing.key).toBe('bot.payment.gateway_card_missing');
    expectCodeAndNoSuffix(missing.text, 'card missing');
  });
});

describe('FIX-02: the manual transfer and custom-instruction invoices', () => {
  const total = money(250_000n, 'IRT');
  it.each(['manual', 'topup'] as const)(
    'the card-to-card invoice (%s) labels the code exactly and carries no suffix',
    (role) => {
      const text = rendered('bot.payment.transfer_instructions', {
        total,
        destination: 'شماره کارت: 6037991234567893',
        reference: paymentTrackingCode(`${CODE}:${role}`),
      });
      expectCodeAndNoSuffix(text, `transfer ${role}`);
      expect(text).not.toContain('شناسه فاکتور');
    },
  );

  it('the custom-instruction invoice (no destination) labels it exactly', () => {
    const text = rendered('bot.payment.manual_instructions', {
      total,
      reference: paymentTrackingCode(`${CODE}:manual`),
    });
    expectCodeAndNoSuffix(text, 'manual instructions');
    expect(text).not.toContain('کد پیگیری این پرداخت');
  });

  it.each([
    ['bot.payment.received_for_review', {}],
    // Codex review of #253: both EDIT the invoice, so both must keep its code.
    ['bot.payment.receipt_prompt', { minutes: 10 }],
    ['bot.payment.cancel_confirm', {}],
    ['bot.payment.expired', {}],
    ['bot.payment.rejected', { reason: 'رسید ناخوانا' }],
    ['bot.wallet.topup_credited', { amount: total }],
    ['bot.payment.receipt_credited_to_wallet', { amount: total }],
  ] as const)('%s, after the invoice, quotes the same code', (key, extra) => {
    const text = rendered(key, { ...extra, reference: paymentTrackingCode(`${CODE}:topup`) });
    expectCodeAndNoSuffix(text, key);
  });
});

/**
 * The grep the brief asks for: no surface builds a customer-facing `reference` value from a
 * stored reference without passing it through `paymentTrackingCode`. A call site reverted to
 * `reference: payment.reference` fails here, by file and line.
 */
describe('FIX-02: no surface renders a raw stored reference', () => {
  const ROOT = join(__dirname, '..', '..');
  const DISPLAY_SOURCES = [
    'apps/api/src/surfaces/telegram/bot-runtime.ts',
    'apps/api/src/modules/commerce/payments/application/receipt-review-caption.ts',
    'apps/api/src/modules/commerce/payments/application/financial-log.consumer.ts',
    'apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader.ts',
    'apps/api/src/modules/commerce/messaging/infrastructure/drizzle-renewal-facts.reader.ts',
    'apps/web/src/pages/payments.tsx',
    'apps/web/src/pages/orders.tsx',
    'apps/web/src/pages/customer-360-workspace.tsx',
  ];
  // `x.reference` used as a value, with no `paymentTrackingCode(` wrapping it on the line.
  const RAW = /(?<![\w.])(?:[A-Za-z_]\w*\.)+reference\b(?!\s*[(:])/u;

  it.each(DISPLAY_SOURCES)(
    '%s passes every stored reference through paymentTrackingCode',
    (file) => {
      const offending = readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => {
          const code = line.replace(/\/\/.*$|^\s*\*.*$/u, '');
          if (!RAW.test(code)) return false;
          if (/paymentTrackingCode\(/u.test(code)) return false;
          // Not a stored reference reaching text: the provider's own id, a query parameter, a
          // typed search, or SQL that SELECTS the column for a reader to convert.
          return !/externalReference|providerReference|query\.reference|search\.reference|error\.details|record\.values|\bSELECT\b/u.test(
            code,
          );
        })
        .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
      expect(offending).toEqual([]);
    },
  );
});
