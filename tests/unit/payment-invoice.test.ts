import { describe, expect, it } from 'vitest';
import {
  money,
  type Money,
  type PaymentDestinationSnapshot,
  type ScopeContext,
} from '@nexa/contracts';
import { createTranslator } from '@nexa/i18n';
import { PaymentDestinationRenderer } from '../../apps/api/src/modules/commerce/payments/infrastructure/destination-renderer';
import { cardInvoiceAmountValues } from '../../apps/api/src/surfaces/telegram/card-invoice';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * The invoice layout is a requirement, so it is pinned by a test rather than by the
 * catalogue alone. Reordering the lines or dropping a row from the body fails here.
 */
describe('the manual-transfer invoice', () => {
  const translator = createTranslator();
  const scope = { tenantId: 't', botInstanceId: 'b' } as unknown as ScopeContext;
  const renderer = new PaymentDestinationRenderer({
    render: (_scope, key, values) => Promise.resolve(translator.translate(key, values)),
  });

  const total: Money = money(250_000n, 'IRT');
  const snapshot = (over: Partial<PaymentDestinationSnapshot> = {}): PaymentDestinationSnapshot =>
    ({
      bankName: 'بانک ملی',
      holderName: 'علی رضایی',
      cardNumber: '6037991234567893',
      iban: null,
      ...over,
    }) as PaymentDestinationSnapshot;

  async function invoice(over: Partial<PaymentDestinationSnapshot> = {}): Promise<string> {
    // As a customer with no custom emoji reads it (owner spec §4: markers, fallback emoji).
    return appearanceFallbackText(
      translator.translate('bot.payment.transfer_instructions', {
        destination: await renderer.render(scope, snapshot(over)),
        total,
        reference: 'NX-7781',
        // R8 A2: what the surface supplies beside `total`.
        ...cardInvoiceAmountValues(total),
        expiresTime: new Date('2026-10-20T09:10:00Z'),
      }),
    );
  }

  it('renders the R8 A2 owner layout in order: heading, amount in rial, card, holder, deadline, tracking code', async () => {
    const body = await invoice();
    const at = (needle: string): number => {
      const index = body.indexOf(needle);
      expect(index, `${needle} is missing from the invoice`).toBeGreaterThanOrEqual(0);
      return index;
    };

    expect(body.startsWith('🧾')).toBe(true);
    const order = [
      at('فاکتور کارت‌به‌کارت'),
      at('مبلغ قابل واریز:'),
      at('۲٬۵۰۰٬۰۰۰ ریال'),
      at('(معادل ۲۵۰٬۰۰۰ تومان)'),
      at('کارت مقصد:'),
      at('علی رضایی'),
      at('مهلت واریز: ساعت'),
      at('کد پیگیری پرداخت: '),
    ];
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
  });

  it('substitutes every declared token, leaving no literal {token} for a customer', async () => {
    expect(await invoice()).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/u);
  });

  it('carries the reference, and the card digits the snapshot froze — four by four (R8 A2)', async () => {
    const body = await invoice();
    expect(body).toContain('NX-7781');
    expect(body).toContain('6037 9912 3456 7893');
  });

  // An absent Sheba is not composed at all — the reason the block is built from per-line
  // keys rather than from an optional placeholder, which would render as `{sheba}`.
  it('omits the Sheba line when the tenant configured none, and shows it when it did', async () => {
    expect(await invoice()).not.toContain('شبا');
    expect(await invoice({ iban: 'IR429600000001003242000012' })).toContain(
      'شبا: IR429600000001003242000012',
    );
  });
});
