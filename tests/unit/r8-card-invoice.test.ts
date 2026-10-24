import { describe, expect, it } from 'vitest';
import {
  money,
  overrideBodyForFormat,
  templateDefinition,
  type PaymentDestinationSnapshot,
  type PaymentId,
  type ScopeContext,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, createTranslator, renderTemplateBody } from '@nexa/i18n';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  cardInvoiceAmountValues,
  copyCardNumberButton,
  copyRialAmountButton,
} from '../../apps/api/src/surfaces/telegram/card-invoice';
import {
  cardDigits,
  cardNumberToCopy,
  groupedCardNumber,
} from '../../apps/api/src/modules/commerce/payments/domain/card-number';
import { transferFigures } from '../../apps/api/src/modules/commerce/payments/domain/transfer-figures';
import {
  cardChangeOffered,
  decideCardChange,
  type CardChangeAllowance,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';
import { PaymentDestinationRenderer } from '../../apps/api/src/modules/commerce/payments/infrastructure/destination-renderer';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import type { GatewayCardFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * R8 A1 + A2: the card-to-card invoice.
 *
 * A1 (owner screenshots, v0.8.1). A purchase: principal 470,000, Nexa's customer fee 47,000,
 * payable 517,000 — which is what Nexa sends TonPays (`sent_amount`) — and TonPays' own exact
 * figure `final_amount` 569,574. A top-up: 20,000 / 22,000 / 25,099. The exact figure is
 * TonPays' own (its markup and a unique tail, on top of the payable): it is the right thing to
 * TRANSFER (TonPays approves automatically only on it) and the wrong thing to settle, credit
 * or refund — those read the payment's principal, and nothing on this screen changes that.
 *
 * A2: the owner-approved layout — the exact amount in RIAL, large, Persian digits, Toman beside
 * it; never the word «کارمزد»; the card four by four; copy buttons carrying rial digits and
 * sixteen card digits; «🔄 تعویض کارت» when the provider and the owner's limits allow it.
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-0000000000a8' as PaymentId;
const CREATED_AT = new Date('2026-10-20T08:00:00Z');
const EXPIRES_AT = new Date('2026-10-20T09:10:00Z');

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    source: 'NEXA',
    customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
    orderId: '01a0fa00-0000-7000-8000-0000000000d1' as never,
    state: 'PENDING',
    method: 'GATEWAY',
    amount: money(470_000n, 'IRT'),
    reference: 'ref',
    code: 'AB12CD34',
    evidenceKind: null,
    evidenceNote: null,
    externalReference: 'TPT-1',
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'TONPAYS_TELEGRAM',
    topupCashbackPercent: null,
    customerFee: {
      basisPoints: 1000,
      fee: money(47_000n, 'IRT'),
      payable: money(517_000n, 'IRT'),
    },
    providerReviewStartedAt: null,
    providerReviewUntil: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as PaymentRecord;
}

function invoice(overrides: Partial<GatewayInvoiceRecord> = {}): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider: 'TONPAYS_TELEGRAM',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'TPT-1',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    providerUserId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: null,
    webInvoiceUrl: null,
    providerUnit: 'IRT',
    sentAmount: 517_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
    fx: null,
    botInstanceId: '01900000-0000-7000-8000-00000000a001',
    providerChargeId: null,
    requestAmount: 517_000n,
    finalAmount: 569_574n,
    creditAmount: null,
    providerStatus: 'pending',
    providerPaid: false,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
    rowFailures: 0,
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
    cardNumber: '5859831887438546',
    cardName: 'محمد احمدی',
    cardSeq: 1,
    cardReceivedAt: CREATED_AT,
    cardChangeShown: true,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: false,
    reconcileInquiryRequestedAt: null,
    cryptoPayCurrency: null,
    cryptoRequested: null,
    cryptoPaid: null,
    cryptoReceived: null,
    cryptoReceivedCurrency: null,
    cryptoPayAddress: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as GatewayInvoiceRecord;
}

const OWNER_DEFAULTS: CardChangeAllowance['limits'] = {
  maxSwitches: 2,
  cooldownSeconds: 60,
  maxDistinctCards: 2,
};
const unused = (limits = OWNER_DEFAULTS): CardChangeAllowance => ({
  limits,
  switches: 0,
  lastSwitchAt: null,
  distinctCards: 1,
});
const facts = (allowance: CardChangeAllowance | null = unused()): GatewayCardFacts => ({
  latestChange: null,
  submissions: [],
  providerFacts: null,
  latestCancel: null,
  latestRefund: null,
  openElsewherePaymentId: null,
  changeAllowance: allowance,
});

/** Ten minutes in: past every cooldown. */
const AT = new Date(CREATED_AT.getTime() + 10 * 60_000);

const copies = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
  reply.buttons.flatMap((button) => ('copyText' in button ? [button.copyText] : []));
const data = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
  reply.buttons.map((button) => ('data' in button ? button.data : null));
const rows = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
  reply.buttons.map((button) => ('row' in button ? (button.row ?? null) : null));
const rendered = (reply: ReturnType<typeof gatewayAttemptScreen>): string => {
  const key = reply.key as TemplateKey;
  return appearanceFallbackText(
    renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], reply.values, 'fa', {
      timezone: 'Asia/Tehran',
      calendar: 'gregorian',
    } as never),
  );
};

describe('R8 A1: the screenshot figures', () => {
  it('purchase: 470,000 + 47,000 = 517,000 sent; TonPays’ exact 569,574 Toman is shown and copied as 5,695,740 rial', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      AT,
      facts(),
    );
    expect(reply.key).toBe('bot.payment.gateway_card_invoice');
    expect(reply.values).toMatchObject({
      amountRial: '۵٬۶۹۵٬۷۴۰',
      amountToman: '۵۶۹٬۵۷۴',
      // Still supplied, for an override written for the earlier layout.
      transferAmount: '569574',
      payable: money(517_000n, 'IRT'),
      principal: money(470_000n, 'IRT'),
      fee: money(47_000n, 'IRT'),
    });
    expect(copies(reply)).toEqual(['5695740', '5859831887438546']);
    const text = rendered(reply);
    expect(text).toContain('<b>۵٬۶۹۵٬۷۴۰ ریال</b>');
    expect(text).toContain('(معادل ۵۶۹٬۵۷۴ تومان)');
    // The four-line breakdown is gone: no principal, fee or payable figure, no fee word.
    expect(text).not.toContain('کارمزد');
    for (const figure of ['470,000', '47,000', '517,000', '569574', '۴۷۰٬۰۰۰', '۵۱۷٬۰۰۰']) {
      expect(text).not.toContain(figure);
    }
  });

  it('top-up: 20,000 + 2,000 = 22,000 sent; TonPays’ exact 25,099 Toman is 250,990 rial, and no internal-invoice line', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment({
          orderId: null,
          amount: money(20_000n, 'IRT'),
          customerFee: {
            basisPoints: 1000,
            fee: money(2_000n, 'IRT'),
            payable: money(22_000n, 'IRT'),
          },
        }),
        invoice: invoice({ sentAmount: 22_000n, requestAmount: 22_000n, finalAmount: 25_099n }),
      },
      null,
      AT,
      facts(),
    );
    expect(reply.key).toBe('bot.payment.gateway_card_invoice');
    expect(copies(reply)).toEqual(['250990', '5859831887438546']);
    const text = rendered(reply);
    expect(text).toContain('<b>۲۵۰٬۹۹۰ ریال</b>');
    expect(text).toContain('(معادل ۲۵٬۰۹۹ تومان)');
    expect(text).not.toContain('فاکتور داخلی');
    expect(text).not.toContain('22,000');
    expect(text).not.toContain('کارمزد');
  });

  it('with no TonPays figure the exact amount is what Nexa sent (the payable), in rial', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: null }) },
      'o',
      AT,
      facts(),
    );
    expect(copies(reply)[0]).toBe('5170000');
    expect(reply.values).toMatchObject({ amountRial: '۵٬۱۷۰٬۰۰۰', amountToman: '۵۱۷٬۰۰۰' });
  });
});

describe('R8 A2: the TonPays card invoice', () => {
  it('renders the owner’s mock, line by line, in order', () => {
    const text = rendered(
      gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, facts()),
    );
    expect(text.split('\n')).toEqual([
      '🧾 فاکتور کارت‌به‌کارت تون‌پی',
      'مبلغ قابل واریز:',
      '<b>۵٬۶۹۵٬۷۴۰ ریال</b>',
      '(معادل ۵۶۹٬۵۷۴ تومان)',
      '⚠️ این مبلغ مخصوص پرداخت شماست؛ دقیقاً همین را واریز کنید تا خودکار تأیید شود.',
      '💳 کارت مقصد:',
      '5859 8318 8743 8546',
      '👤 محمد احمدی',
      '⏳ مهلت واریز: ساعت 12:40',
      'کد پیگیری پرداخت: AB12CD34',
    ]);
    expect(text).not.toContain('اگر چند دقیقه بعد');
  });

  it('draws the four rows: copies / switch / receipt + cancel / main menu, and no status check', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      AT,
      facts(),
    );
    expect(data(reply)).toEqual([
      null,
      null,
      `gk:${PAYMENT_ID}`,
      `gr:${PAYMENT_ID}`,
      `gq:${PAYMENT_ID}`,
      'mm:',
    ]);
    expect(rows(reply)).toEqual([0, 0, 1, 2, 2, null]);
    expect(data(reply).some((one) => one?.startsWith('gc:'))).toBe(false);
  });

  it('why the switch was missing: drawn inside the first minute after the card arrives (the tap explains the wait)', () => {
    const justShown = new Date(CREATED_AT.getTime() + 5_000);
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      justShown,
      facts(),
    );
    expect(data(reply)).toContain(`gk:${PAYMENT_ID}`);
    // …while the decision the tap makes is "wait", with the seconds left.
    expect(decideCardChange(invoice(), null, justShown, unused())).toEqual({
      kind: 'COOLDOWN',
      retryAfterSeconds: 55,
    });
  });

  it('respects the owner’s R5C-1 limits: zero switches, used switches, distinct cards', () => {
    const at = (allowance: CardChangeAllowance) =>
      data(
        gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, facts(allowance)),
      );
    expect(at(unused({ ...OWNER_DEFAULTS, maxSwitches: 0 }))).not.toContain(`gk:${PAYMENT_ID}`);
    expect(at({ ...unused(), switches: 2, distinctCards: 1 })).not.toContain(`gk:${PAYMENT_ID}`);
    expect(at({ ...unused(), switches: 1, distinctCards: 2 })).not.toContain(`gk:${PAYMENT_ID}`);
    expect(at({ ...unused(), switches: 1, distinctCards: 1 })).toContain(`gk:${PAYMENT_ID}`);
    // The provider saying no, or exhausted, still hides it whatever the owner allows.
    expect(cardChangeOffered(invoice({ cardChangeShown: false }), null, AT, unused())).toBe(false);
    expect(cardChangeOffered(invoice({ cardChangeExhausted: true }), null, AT, unused())).toBe(
      false,
    );
  });

  it('the owner’s cooldown runs from the last switch, and the longest wait is the one answered', () => {
    const last = new Date(AT.getTime() - 20_000);
    expect(
      decideCardChange(invoice(), null, AT, {
        ...unused({ ...OWNER_DEFAULTS, cooldownSeconds: 120 }),
        switches: 1,
        lastSwitchAt: last,
      }),
    ).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 100 });
    expect(
      decideCardChange(
        invoice({ cardChangeCooldownUntil: new Date(AT.getTime() + 300_000) }),
        null,
        AT,
        { ...unused(), switches: 1, lastSwitchAt: last },
      ),
    ).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 300 });
    expect(decideCardChange(invoice(), null, AT, unused()).kind).toBe('AVAILABLE');
  });

  it('every follow-up screen shows the same amount presentation, and none says «کارمزد»', () => {
    const keys = [
      'bot.payment.gateway_card_invoice',
      'bot.payment.gateway_card_receipt_sent',
      'bot.payment.gateway_card_receipt_refused',
      'bot.payment.gateway_card_changing',
      'bot.payment.gateway_card_receipt_empty',
      'bot.payment.gateway_card_receipt_invoice',
    ] as const;
    const values = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      AT,
      facts(),
    ).values;
    for (const key of keys) {
      const text = renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values, 'fa', {
        timezone: 'Asia/Tehran',
        calendar: 'gregorian',
      } as never);
      expect(text, key).toContain('۵٬۶۹۵٬۷۴۰ ریال');
      expect(text, key).not.toContain('کارمزد');
      expect(text, key).not.toContain('بررسی وضعیت');
      expect(text, key).not.toMatch(/\{[A-Za-z]+\}/u);
    }
  });
});

describe('R8 A2: the manual card-to-card invoice', () => {
  const translator = createTranslator();
  const scope = { tenantId: 't', botInstanceId: 'b' } as unknown as ScopeContext;
  const destinations = new PaymentDestinationRenderer({
    render: (_scope, key, values) => Promise.resolve(translator.translate(key, values)),
  });
  const snapshot: PaymentDestinationSnapshot = {
    bankName: 'بانک ملت',
    holderName: 'محمد احمدی',
    cardNumber: '5859831887438546',
    iban: null,
    label: 'اصلی',
  };

  async function manual(payable: bigint, principal: bigint): Promise<string> {
    const definition = templateDefinition('bot.payment.transfer_instructions');
    const total = money(payable, 'IRT');
    return appearanceFallbackText(
      renderTemplateBody(
        definition,
        CATALOGUE_FA['bot.payment.transfer_instructions'],
        {
          destination: await destinations.render(scope, snapshot),
          total,
          ...(payable === principal
            ? {}
            : { principal: money(principal, 'IRT'), fee: money(payable - principal, 'IRT') }),
          reference: 'AB12CD34',
          ...cardInvoiceAmountValues(total),
          expiresTime: EXPIRES_AT,
        },
        'fa',
        { timezone: 'Asia/Tehran', calendar: 'gregorian' } as never,
      ),
    );
  }

  it('without a fee: the amount in rial, bold, Toman beside, the card four by four', async () => {
    const text = await manual(25_099n, 25_099n);
    expect(text.split('\n')).toEqual([
      '🧾 فاکتور کارت‌به‌کارت',
      'مبلغ قابل واریز:',
      '<b>۲۵۰٬۹۹۰ ریال</b>',
      '(معادل ۲۵٬۰۹۹ تومان)',
      '⚠️ دقیقاً همین مبلغ را واریز کنید، سپس تصویر رسید را ارسال کنید؛ پرداخت شما پس از بررسی رسید تأیید می‌شود.',
      '💳 کارت مقصد:',
      '5859 8318 8743 8546',
      '👤 محمد احمدی',
      'بانک: بانک ملت',
      '⏳ مهلت واریز: ساعت 12:40',
      'کد پیگیری پرداخت: AB12CD34',
    ]);
  });

  it('with a fee: the payable is the one amount shown, and the fee is never named', async () => {
    const text = await manual(517_000n, 470_000n);
    expect(text).toContain('<b>۵٬۱۷۰٬۰۰۰ ریال</b>');
    expect(text).toContain('(معادل ۵۱۷٬۰۰۰ تومان)');
    expect(text).not.toContain('کارمزد');
    expect(text).not.toContain('470,000');
    expect(text).not.toContain('47,000');
  });

  it('copy buttons: rial digits without separators, sixteen card digits without spaces', () => {
    expect(copyRialAmountButton(money(517_000n, 'IRT'))).toMatchObject({
      copyText: '5170000',
      row: 0,
    });
    expect(copyRialAmountButton(money(2_500_370n, 'IRR'))).toMatchObject({ copyText: '2500370' });
    expect(copyCardNumberButton('5859 8318 8743 8546')).toMatchObject({
      copyText: '5859831887438546',
      row: 0,
    });
  });
});

describe('R8 A2: the pure helpers', () => {
  it('transferFigures: Toman ×10 is rial; a rial amount that is not a whole toman has no Toman line', () => {
    expect(transferFigures(money(25_099n, 'IRT'))).toEqual({
      amountRial: '۲۵۰٬۹۹۰',
      amountToman: '۲۵٬۰۹۹',
      copyRial: '250990',
    });
    expect(transferFigures(money(250_995n, 'IRR'))).toEqual({
      amountRial: '۲۵۰٬۹۹۵',
      amountToman: null,
      copyRial: '250995',
    });
    expect(transferFigures(money(100n, 'USD'))).toBeNull();
    expect(transferFigures(money(-1n, 'IRT'))).toBeNull();
    expect(cardInvoiceAmountValues(money(250_995n, 'IRR'))).toEqual({ amountRial: '۲۵۰٬۹۹۵' });
  });

  it('card numbers: grouped four by four from any separator or digit script; anything else as sent', () => {
    expect(groupedCardNumber('5859831887438546')).toBe('5859 8318 8743 8546');
    expect(groupedCardNumber('6037-9911-0000-1001')).toBe('6037 9911 0000 1001');
    expect(groupedCardNumber('۵۸۵۹۸۳۱۸۸۷۴۳۸۵۴۶')).toBe('5859 8318 8743 8546');
    expect(groupedCardNumber('12345')).toBe('12345');
    expect(cardDigits('6037 9911 0000 1001')).toBe('6037991100001001');
    expect(cardDigits('60379911000010011')).toBeNull();
    expect(cardNumberToCopy('6037-9911-0000-1001')).toBe('6037991100001001');
    expect(cardNumberToCopy('IR12')).toBe('IR12');
  });
});

describe('R8 A2: an owner override keeps working', () => {
  const resolverWith = (key: TemplateKey, body: string) =>
    new TemplateResolver(
      {
        findOverride: async (_scope: unknown, wanted: TemplateKey) =>
          wanted === key
            ? { key, locale: 'fa', body, version: 1, revision: 1, updatedAt: CREATED_AT }
            : null,
      } as unknown as TemplateRepository,
      { isEnabled: async () => true } as unknown as FeatureFlagResolver,
      new I18nTemplateCatalogue(),
      {
        presentationFor: async () => ({ timezone: 'Asia/Tehran', calendar: 'gregorian' }) as never,
      },
    );
  const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;

  it('the owner’s top-up override of the card invoice (A1’s second screenshot) still renders, from the same values', async () => {
    const key = 'bot.payment.gateway_card_invoice' as TemplateKey;
    const stored =
      'مبلغ سفارش یا شارژ: {principal}\nمبلغ واریزی شما (با کارمزد درگاه): {transferAmount}\n' +
      'شمارهٔ فاکتور داخلی: {payable} (این عدد را واریز نکنید)\n{cardNumber}\nکد پیگیری پرداخت: {reference}';
    const reply = gatewayAttemptScreen(
      {
        payment: payment({
          orderId: null,
          amount: money(20_000n, 'IRT'),
          customerFee: {
            basisPoints: 1000,
            fee: money(2_000n, 'IRT'),
            payable: money(22_000n, 'IRT'),
          },
        }),
        invoice: invoice({ sentAmount: 22_000n, finalAmount: 25_099n }),
      },
      null,
      AT,
      facts(),
    );
    const text = await resolverWith(key, stored).render(scope, key, reply.values);
    // Exactly the text the owner saw: the override is theirs to change, never rewritten here.
    expect(text).toBe(
      'مبلغ سفارش یا شارژ: 20,000 تومان\nمبلغ واریزی شما (با کارمزد درگاه): 25099\n' +
        'شمارهٔ فاکتور داخلی: 22,000 تومان (این عدد را واریز نکنید)\n5859831887438546\nکد پیگیری پرداخت: AB12CD34',
    );
  });

  it('a plain-text override of the manual invoice, saved before it became HTML, is still sent as plain text', async () => {
    const key = 'bot.payment.transfer_instructions' as TemplateKey;
    const stored = 'واریز به R&D <فوری>: {total}\n{destination}\n{reference}';
    const text = await resolverWith(key, stored).render(scope, key, {
      destination: 'کارت',
      total: money(25_099n, 'IRT'),
      reference: 'AB12CD34',
      ...cardInvoiceAmountValues(money(25_099n, 'IRT')),
    });
    expect(text).toBe('واریز به R&amp;D &lt;فوری&gt;: 25,099 تومان\nکارت\nAB12CD34');
  });

  it('an override that uses an HTML tag was written for HTML and is left as it is; other keys are never touched', () => {
    const manual = templateDefinition('bot.payment.transfer_instructions');
    expect(overrideBodyForFormat(manual, '<b>{amountRial}</b> & {destination}')).toBe(
      '<b>{amountRial}</b> & {destination}',
    );
    expect(overrideBodyForFormat(manual, 'A & B')).toBe('A &amp; B');
    // Always HTML: an override there was always written for HTML.
    const tonpays = templateDefinition('bot.payment.gateway_card_invoice');
    expect(overrideBodyForFormat(tonpays, 'A & B')).toBe('A & B');
    expect(manual.format).toBe('TELEGRAM_HTML');
    expect(manual.legacyPlainOverrides).toBe(true);
  });
});
