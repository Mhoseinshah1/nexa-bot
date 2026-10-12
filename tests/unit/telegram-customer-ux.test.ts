import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_SLOT_FALLBACKS,
  money,
  templateDefinition,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import {
  CATALOG_OPEN_CALLBACK_DATA,
  TOPUP_MENU_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
  intentOf,
  notificationButtons,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { WIZARD_GATES } from '../../apps/api/src/surfaces/telegram/wizard-state';
import { CustomerScreenComposer } from '../../apps/api/src/modules/commerce/messaging/application/customer-screens';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * Owner spec §2 and §3: the customer UX package, at the level of the rules each screen is
 * built from. The edit-in-place flows themselves are driven end to end in
 * `tests/integration/customer-ux-services.test.ts` (My Services) and
 * `tests/integration/telegram-payment-flow.test.ts` (the manual-transfer receipt).
 */

const TEHRAN = { timezone: 'Asia/Tehran', calendar: 'jalali' } as const;

/** A key's DEFAULT body rendered as a customer with no custom emoji reads it. */
function rendered(key: TemplateKey, values: TemplateValues): string {
  return appearanceFallbackText(
    renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values, 'fa', TEHRAN),
  );
}

const tapping = (data: string) => intentOf({ callback_query: { id: 'q', data } });

describe('§2.1 the low-balance alert', () => {
  it('names no command, and carries the wallet top-up as its one inline button', () => {
    expect(CATALOGUE_FA['bot.wallet.low_balance']).not.toContain('/wallet');
    expect(notificationButtons('WALLET_LOW_BALANCE', {})).toEqual([
      {
        label: { kind: 'TEMPLATE', key: 'bot.wallet.topup_button' },
        inline: 'wallet.topup',
        data: TOPUP_MENU_CALLBACK_PREFIX,
      },
    ]);
    // The EXISTING top-up flow: the same tap the wallet screen's own button makes.
    expect(tapping(TOPUP_MENU_CALLBACK_PREFIX).intent).toBe('TOPUP_MENU');
  });
});

describe('§2.2 the wallet-credit message', () => {
  const amount = money(500_000n, 'IRT');
  /*
   * The top-up keeps the two approved lines. The receipt CREDITED to the wallet does not
   * (batch 2026-10-10, brief C2.1): it is a reviewer's disposition that leaves the payment
   * FAILED and any order AWAITING_PAYMENT, so it says the receipt was approved, the money is
   * in the wallet, and an order it was for is still unpaid — and still never «/wallet».
   */
  const TOPUP_LINES =
    '✅ پرداخت شما بررسی و تأیید شد.\n💎 مبلغ 500,000 تومان به کیف پول شما اضافه شد.';
  const RECEIPT_CREDIT_LINES =
    '✅ رسید شما بررسی و تأیید شد.\n💎 مبلغ 500,000 تومان به کیف پول شما واریز شد.\n' +
    'این مبلغ به‌عنوان پرداخت سفارش ثبت نشده است؛ اگر رسید برای سفارشی بود، آن سفارش هنوز در انتظار پرداخت است و تا پایان مهلتش می‌توانید آن را از کیف پول پرداخت کنید.';
  const LINES = {
    'bot.wallet.topup_credited': TOPUP_LINES,
    'bot.payment.receipt_credited_to_wallet': RECEIPT_CREDIT_LINES,
  } as const;

  it.each(['bot.wallet.topup_credited', 'bot.payment.receipt_credited_to_wallet'] as const)(
    '%s reads its approved lines and nothing about /wallet',
    (key) => {
      const text = rendered(key, { amount });
      expect(text).toBe(LINES[key]);
      expect(CATALOGUE_FA[key]).not.toContain('/wallet');
    },
  );

  /*
   * B14: the wallet-credit success message (an approved receipt, or a gateway top-up) ends
   * with the payment's tracking code, after exactly two blank lines — and without a code (an
   * override, a reader not wired) it is the lines alone, with no blank line left behind.
   */
  it.each(['bot.wallet.topup_credited', 'bot.payment.receipt_credited_to_wallet'] as const)(
    '%s ends with «کد پیگیری پرداخت: …» after two blank lines',
    (key) => {
      const text = rendered(key, {
        amount,
        reference: 'c0ffee00-0000-7000-8000-000000000001:topup',
      });
      expect(text).toBe(
        LINES[key] + '\n\n\nکد پیگیری پرداخت: c0ffee00-0000-7000-8000-000000000001:topup',
      );
    },
  );

  it.each(['WALLET_TOPUP_CREDITED', 'RECEIPT_CREDITED_TO_WALLET'] as const)(
    '%s carries exactly «کیف پول» and «خرید سرویس», side by side, from the registry',
    (kind) => {
      expect(notificationButtons(kind, {})).toEqual([
        {
          label: { kind: 'TEMPLATE', key: 'bot.wallet.open_button' },
          inline: 'wallet.open',
          data: WALLET_OPEN_CALLBACK_DATA,
          row: 0,
        },
        {
          label: { kind: 'TEMPLATE', key: 'bot.catalog.open_button' },
          inline: 'catalog.open',
          data: CATALOG_OPEN_CALLBACK_DATA,
          row: 0,
        },
      ]);
      expect(CATALOGUE_FA['bot.wallet.open_button']).toBe('💰 کیف پول');
      expect(CATALOGUE_FA['bot.catalog.open_button']).toBe('🛒 خرید سرویس');
    },
  );

  it('opens the wallet and the catalogue as NEW messages, which no wizard gate edits', () => {
    expect(tapping(WALLET_OPEN_CALLBACK_DATA).intent).toBe('WALLET');
    expect(tapping(CATALOG_OPEN_CALLBACK_DATA).intent).toBe('CATALOG');
    // Not a wizard button: the credit message is the record and must stay as it is.
    expect(WIZARD_GATES.has('WALLET')).toBe(false);
    expect(WIZARD_GATES.has('CATALOG')).toBe(false);
  });

  it('gives no other kind these buttons', () => {
    expect(notificationButtons('PAYMENT_REJECTED', {})).toEqual([]);
    expect(notificationButtons('WALLET_MASS_CREDITED', {})).toEqual([]);
  });
});

describe('§2.4 the manual-transfer receipt', () => {
  it('honours «پرداخت را انجام دادم» only from the invoice it was drawn on', () => {
    expect(WIZARD_GATES.get('PAY_SENT')).toEqual({
      kind: null,
      adoptAs: 'ORDER',
      from: ['INVOICE'],
    });
  });

  it('answers the first receipt with the brief’s two sentences, a blank line between them', () => {
    expect(rendered('bot.payment.receipt_received', {})).toBe(
      'رسید شما دریافت شد و در حال بررسی است.\n\nپس از بررسی، نتیجه به شما اطلاع داده می‌شود.',
    );
  });

  it('tells the invoice to send an image of the receipt, not a file', () => {
    const body = CATALOGUE_FA['bot.payment.transfer_instructions'];
    expect(body).toContain('تصویر رسید را ارسال کنید');
    expect(body).not.toContain('فایل');
  });

  it('asks for an image of the receipt, and no longer advertises a file', () => {
    const prompt = rendered('bot.payment.receipt_prompt', { minutes: 30 });
    expect(prompt).toContain('تصویر رسید');
    expect(prompt).not.toContain('فایل');
    expect(prompt).toContain('30');
  });
});

describe('§3 the account screen shows the moment it was drawn', () => {
  it('adds today and the time, in the tenant zone and calendar, after a blank line', async () => {
    const screens = new CustomerScreenComposer({
      render: async (_scope, key) => CATALOGUE_FA[key],
    });
    const summary = await screens.walletSummary(
      { tenantId: '01900000-0000-7000-8000-000000000001', botInstanceId: null } as never,
      {
        telegramId: '42',
        displayName: 'علی',
        // Registered long ago: the date shown must not be this one.
        registeredAt: new Date('2025-01-01T08:00:00Z'),
        balance: money(0n, 'IRT'),
        serviceCount: 0,
        paidInvoiceCount: 0,
        referralCount: 0,
        group: 'CUSTOMER',
        now: new Date('2026-10-02T19:52:00Z'),
      },
    );
    const text = rendered(summary.key, summary.values);
    expect(
      text.endsWith('🔖 گروه کاربری: کاربر عادی\n\n📅 تاریخ: 1405/07/10\n🕒 ساعت: 23:22'),
    ).toBe(true);
  });
});

/*
 * Owner spec §4: a meaningful icon in a customer MESSAGE is an appearance slot, so a
 * tenant's premium custom emoji reaches it and the fallback is the same emoji as before.
 * Pinned over the whole catalogue: a body that types one of these emoji again, instead of
 * its marker, fails here. Button labels are exempt (a label carries no entity), and so is
 * an emoji quoting a button label inside «…».
 */
describe('§4 customer messages draw their icons from Appearance', () => {
  const SLOTTED: Readonly<Record<string, string>> = {
    '✅': 'success',
    '❌': 'error',
    '⚠️': 'warning',
    ℹ️: 'info',
    '💳': 'payment',
    '💰': 'wallet',
    '💵': 'amount',
    '🧾': 'invoice',
    '🛒': 'purchase',
    '🧪': 'trial',
    '🎁': 'referral',
    '🎫': 'ticket',
    '⏳': 'time',
    '📅': 'date',
    '🔗': 'link',
    '👤': 'user',
    '🌍': 'location',
    '🪪': 'identity',
  };
  const customerBodies = Object.entries(CATALOGUE_FA).filter(
    ([key]) =>
      key.startsWith('bot.') &&
      !key.startsWith('bot.admin.') &&
      !key.startsWith('bot.command.') &&
      !key.startsWith('bot.menu.') &&
      !key.endsWith('_button') &&
      !key.endsWith('.button'),
  );

  it('types none of the slotted emoji where its marker belongs', () => {
    const typed: string[] = [];
    for (const [key, body] of customerBodies) {
      for (const glyph of Object.keys(SLOTTED)) {
        const at = [...body.matchAll(new RegExp(glyph, 'gu'))].filter(
          (match) => body[(match.index ?? 0) - 1] !== '«',
        );
        if (at.length > 0) typed.push(`${key}: ${glyph}`);
      }
    }
    expect(typed).toEqual([]);
  });

  it('renders each marker as the emoji the body drew before, with nothing configured', () => {
    expect(rendered('bot.service.transfer_done', {})).toBe(
      '✅ سرویس با موفقیت به کاربر مقصد منتقل شد.',
    );
    expect(APPEARANCE_SLOT_FALLBACKS.phone).toBe('📱');
    for (const [glyph, slot] of Object.entries(SLOTTED)) {
      expect(APPEARANCE_SLOT_FALLBACKS[slot as keyof typeof APPEARANCE_SLOT_FALLBACKS]).toBe(glyph);
    }
  });
});
