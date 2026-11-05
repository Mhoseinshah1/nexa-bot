import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { attemptWire } from '../../apps/api/src/surfaces/miniapp/projections';
import { chooseTonPaysLink } from '../../apps/api/src/modules/commerce/payments/domain/tonpays';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * The TonPays (website) route's «لینک پرداخت»: the standard API returns the provider's
 * Telegram bot link (`invoice_url`) and its web link (`web_invoice_url`), and the route's
 * choice — frozen on the attempt — decides which one the bot and the mini app hand the
 * customer. One pure function decides; both surfaces are checked against it here.
 */

const BOT = 'https://t.me/TonPaysInvoiceBot?start=inv_abc';
const WEB = 'https://tonpays.example/invoice/abc';

describe('chooseTonPaysLink', () => {
  it('TELEGRAM_BOT takes invoice_url, WEB takes web_invoice_url', () => {
    const links = { invoiceUrl: BOT, webInvoiceUrl: WEB };
    expect(chooseTonPaysLink('TELEGRAM_BOT', links)).toEqual({ url: BOT, kind: 'TELEGRAM_BOT' });
    expect(chooseTonPaysLink('WEB', links)).toEqual({ url: WEB, kind: 'WEB' });
  });

  it('an absent choice is the default, the bot', () => {
    expect(chooseTonPaysLink(undefined, { invoiceUrl: BOT, webInvoiceUrl: WEB })?.url).toBe(BOT);
  });

  it('falls back to the other link when the chosen one is missing', () => {
    expect(chooseTonPaysLink('TELEGRAM_BOT', { invoiceUrl: null, webInvoiceUrl: WEB })).toEqual({
      url: WEB,
      kind: 'WEB',
    });
    expect(chooseTonPaysLink('WEB', { invoiceUrl: BOT, webInvoiceUrl: null })).toEqual({
      url: BOT,
      kind: 'TELEGRAM_BOT',
    });
    expect(chooseTonPaysLink('WEB', { invoiceUrl: BOT, webInvoiceUrl: '' })?.url).toBe(BOT);
  });

  it('is null when neither link exists', () => {
    expect(chooseTonPaysLink('TELEGRAM_BOT', { invoiceUrl: null, webInvoiceUrl: null })).toBeNull();
    expect(chooseTonPaysLink('WEB', { invoiceUrl: null, webInvoiceUrl: null })).toBeNull();
  });
});

const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;
const CREATED_AT = new Date('2026-10-02T10:00:00Z');
const AT = new Date('2026-10-02T10:30:00Z');

const payment = {
  id: PAYMENT_ID,
  orderId: '01a0fa00-0000-7000-8000-0000000000d1',
  customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
  state: 'PENDING',
  method: 'GATEWAY',
  amount: money(250_000n, 'IRT'),
  reference: 'ref',
  expiresAt: new Date('2026-10-02T11:10:00Z'),
  gatewayProvider: 'TONPAYS',
  customerFee: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
} as unknown as PaymentRecord;

function invoice(overrides: Partial<GatewayInvoiceRecord>): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider: 'TONPAYS',
    creationState: 'CREATED',
    createdInvoiceAt: CREATED_AT,
    invoiceUrl: BOT,
    webInvoiceUrl: WEB,
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    requestAmount: 250_000n,
    finalAmount: 250_000n,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as unknown as GatewayInvoiceRecord;
}

describe('the bot payment screen', () => {
  it('a bot-link invoice opens the bot, with its own button key', () => {
    const reply = gatewayAttemptScreen(
      { payment, invoice: invoice({ paymentLink: 'TELEGRAM_BOT' }) },
      null,
      AT,
    );
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.tonpays_bot_pay_button' },
      url: BOT,
    });
  });

  it('a web-link invoice opens the web page, with the generic pay button', () => {
    const reply = gatewayAttemptScreen(
      { payment, invoice: invoice({ paymentLink: 'WEB' }) },
      null,
      AT,
    );
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.gateway_pay_button' },
      url: WEB,
    });
  });

  it('falls back to the web page, labelled as the web page, when the bot link is missing', () => {
    const reply = gatewayAttemptScreen(
      { payment, invoice: invoice({ paymentLink: 'TELEGRAM_BOT', invoiceUrl: null }) },
      null,
      AT,
    );
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.gateway_pay_button' },
      url: WEB,
    });
  });
});

describe('the mini app attempt', () => {
  it.each([
    ['TELEGRAM_BOT', BOT],
    ['WEB', WEB],
  ] as const)('%s hands the customer %s', (choice, url) => {
    expect(attemptWire({ payment, invoice: invoice({ paymentLink: choice }) }, false).payUrl).toBe(
      url,
    );
  });

  it('falls back to the other link, and is null with neither', () => {
    expect(
      attemptWire({ payment, invoice: invoice({ paymentLink: 'WEB', webInvoiceUrl: null }) }, false)
        .payUrl,
    ).toBe(BOT);
    expect(
      attemptWire(
        {
          payment,
          invoice: invoice({ paymentLink: 'WEB', webInvoiceUrl: null, invoiceUrl: null }),
        },
        false,
      ).payUrl,
    ).toBeNull();
  });
});
