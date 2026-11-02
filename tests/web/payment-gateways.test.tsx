import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@nexa/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import {
  conversionRateOf,
  minorOf,
  PaymentGatewaysPage,
  percentOf,
  takesCustomerFee,
  takesConversionRate,
} from '../../apps/web/src/pages/payment-gateways';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Two rules the Codex review of the payment batch found broken on this screen.
 *
 * `minorOf` used to delete every non-digit and submit the remainder as though the
 * operator had typed it: `-100` became a positive `100`, `1e6` became `16`, and the server
 * saw a valid number with nothing to report. These two fields decide which customer
 * payments a route accepts. Now it accepts only ways of WRITING a whole number of minor
 * units, and refuses everything else so the caller can say so against the field.
 */
describe('minorOf', () => {
  it('keeps a plain integer and strips leading zeros', () => {
    expect(minorOf('500000')).toBe('500000');
    expect(minorOf('0042')).toBe('42');
    expect(minorOf('  7  ')).toBe('7');
  });

  it('reads empty as "no bound"', () => {
    expect(minorOf('')).toBe('0');
    expect(minorOf('   ')).toBe('0');
  });

  it('accepts grouping separators and Persian or Arabic-Indic digits', () => {
    expect(minorOf('1,000,000')).toBe('1000000');
    expect(minorOf('1 000 000')).toBe('1000000');
    expect(minorOf('۱٬۰۰۰٬۰۰۰')).toBe('1000000');
    expect(minorOf('١٢٣')).toBe('123');
  });

  it('refuses a sign, a decimal point, an exponent or letters rather than rewriting them', () => {
    // The two Codex named: a sign inverted to a positive bound, an exponent read as digits.
    expect(minorOf('-100')).toBeNull();
    expect(minorOf('1e6')).toBeNull();
    expect(minorOf('+100')).toBeNull();
    expect(minorOf('10.5')).toBeNull();
    expect(minorOf('abc')).toBeNull();
    expect(minorOf('12a')).toBeNull();
  });
});

/**
 * The two payment navigation entries require the VIEW key, and only that.
 *
 * They used to admit either key on the stated ground that an edit-only role could use
 * the page. It could not: the route disables the list on `!view`, the form opens from a
 * row, and the server's `list` charges `view`. A link is a promise that a page will work.
 */
describe('payment navigation permissions', () => {
  const entry = (id: string) => {
    const found = NAV.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no nav entry ${id}`);
    return found;
  };

  /*
   * UX Batch 01, item 7: one entry, «روش‌های پرداخت», for both. The cards are managed on
   * the card-to-card method's own view, so a role that reads only the cards needs this
   * entry to reach them — and an edit key alone still draws nothing.
   */
  it.each<[PermissionKey, PermissionKey]>([
    ['payments.accounts.view', 'payments.accounts.edit'],
    ['payments.gateways.view', 'payments.gateways.edit'],
  ])('payment-gateways is shown for %s and hidden for edit alone', (view, edit) => {
    expect(navPermitted(entry('payment-gateways'), [view])).toBe(true);
    expect(navPermitted(entry('payment-gateways'), [view, edit])).toBe(true);
    expect(navPermitted(entry('payment-gateways'), [edit])).toBe(false);
    expect(navPermitted(entry('payment-gateways'), [])).toBe(false);
  });

  it('has no separate «حساب‌های دریافت» entry any more', () => {
    expect(NAV.some((candidate) => candidate.path === '/payment-accounts')).toBe(false);
    expect(NAV.some((candidate) => candidate.id === 'payment-accounts')).toBe(false);
  });
});

/**
 * The route's top-up gift (Payment File 02 §17, D5), edited on the gateway form.
 *
 * `percentOf` has `minorOf`'s rule: a figure is accepted as typed or refused, never
 * clamped or rounded, because this one decides how much money a customer is given.
 */
describe('percentOf', () => {
  it('reads a whole percentage from 0 to 100, in any digits, with an optional %', () => {
    expect(percentOf('0')).toBe(0);
    expect(percentOf('10')).toBe(10);
    expect(percentOf(' 100 ')).toBe(100);
    expect(percentOf('۱۵')).toBe(15);
    expect(percentOf('١٢')).toBe(12);
    expect(percentOf('10%')).toBe(10);
    expect(percentOf('۱۰٪')).toBe(10);
  });

  it.each(['', '101', '-1', '10.5', '1e1', 'ten', '1000', '10%%'])('refuses %j', (value) => {
    expect(percentOf(value)).toBeNull();
  });
});

describe('the gateway form’s top-up gift', () => {
  const GATEWAY = {
    provider: 'MANUAL_TRANSFER',
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 5,
    customerFeeBasisPoints: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  const open = async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [GATEWAY] } },
      { url: '/payment-gateways/MANUAL_TRANSFER', body: { gateway: GATEWAY } },
    ]);
    const view = renderPage(
      <PaymentGatewaysPage provider="MANUAL_TRANSFER" denied={false} mayEdit />,
    );
    // The table shows the route's gift before anything is opened.
    expect(await screen.findByText('5%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    return {
      api,
      view,
      input: (await screen.findByLabelText('هدیهٔ شارژ (درصد)')) as HTMLInputElement,
    };
  };

  it('opens with the route’s gift, explains it, and saves the percentage as typed', async () => {
    const { api, input } = await open();
    expect(input.value).toBe('5');
    expect(document.body.textContent).toContain('به‌عنوان هدیه به کیف پول مشتری واریز می‌شود');

    fireEvent.change(input, { target: { value: '۱۲' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const saved = api.calls.find((call) => call.method === 'POST');
    expect((saved?.body as { topupCashbackPercent?: unknown }).topupCashbackPercent).toBe(12);
  });

  it('R6 item 4: card-to-card takes a customer fee (default 0), saved as basis points', async () => {
    expect(takesCustomerFee('MANUAL_TRANSFER')).toBe(true);
    expect(takesCustomerFee('TONPAYS')).toBe(true);
    expect(takesCustomerFee('NOT_A_ROUTE')).toBe(false);
    const { api } = await open();
    const fee = (await screen.findByLabelText('کارمزد مشتری (%)')) as HTMLInputElement;
    expect(fee.value).toBe('0');
    fireEvent.change(fee, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const saved = api.calls.find((call) => call.method === 'POST');
    expect((saved?.body as { customerFeeBasisPoints?: unknown }).customerFeeBasisPoints).toBe(1000);
  });

  it('refuses a figure outside 0–100 at the field, and will not save it', async () => {
    const { api, input } = await open();
    fireEvent.change(input, { target: { value: '150' } });

    expect(
      await screen.findByText('درصد هدیهٔ شارژ باید عددی صحیح از 0 تا 100 باشد.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیره' })).toBeDisabled();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

/**
 * The two purpose switches (customer UX completion §D/§F, §L). Both travel on every
 * save, as the form shows them — the server defaults an ABSENT switch to on, so a form
 * that omitted one would silently turn a route back on.
 */
describe('the gateway form’s purpose switches', () => {
  const GATEWAY = {
    provider: 'MANUAL_TRANSFER',
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: false,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  const open = async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [GATEWAY] } },
      { url: '/payment-gateways/MANUAL_TRANSFER', body: { gateway: GATEWAY } },
    ]);
    renderPage(<PaymentGatewaysPage provider="MANUAL_TRANSFER" denied={false} mayEdit />);
    // The table names the one purpose the route is on for, and not the other.
    const cell = await screen.findByText('خرید سرویس');
    expect(cell.textContent).not.toContain('شارژ کیف پول');
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    return {
      api,
      purchase: await screen.findByRole('switch', { name: 'خرید سرویس' }),
      topup: screen.getByRole('switch', { name: 'شارژ کیف پول' }),
    };
  };

  it('opens with the route’s switches and sends both flags as shown', async () => {
    const { api, purchase, topup } = await open();
    expect(purchase).toHaveAttribute('aria-checked', 'true');
    expect(topup).toHaveAttribute('aria-checked', 'false');

    // Purchase off, top-up on: the reverse of what the route holds.
    fireEvent.click(purchase);
    fireEvent.click(topup);
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const body = api.calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body['allowServicePurchase']).toBe(false);
    expect(body['allowWalletTopup']).toBe(true);
  });

  it('sends both flags untouched when the operator changes something else', async () => {
    const { api } = await open();
    fireEvent.change(screen.getByLabelText('ترتیب نمایش'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const body = api.calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body['allowServicePurchase']).toBe(true);
    expect(body['allowWalletTopup']).toBe(false);
    expect(body['sortOrder']).toBe(3);
  });

  it('says in amber when a route is on for nothing', async () => {
    const off = { ...GATEWAY, allowServicePurchase: false, allowWalletTopup: false };
    stubApi([{ url: '/payment-gateways', body: { gateways: [off] } }]);
    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
    expect(await screen.findByText('برای هیچ کاری')).toBeInTheDocument();
  });
});

/**
 * §5 — the wallet top-up warning. The bot hides «💰 افزایش موجودی» when no route can fund
 * a top-up; the page says so and why, from the server's `walletTopup` alone. These tests
 * deliberately send route rows whose own fields would say "fine" (ACTIVE, top-up on) beside
 * a server verdict that says otherwise: the page must draw the verdict, never re-decide it.
 */
describe('the wallet top-up warning', () => {
  const ROW = {
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };
  const MANUAL = { ...ROW, provider: 'MANUAL_TRANSFER' };
  const TONPAYS = {
    ...ROW,
    provider: 'TONPAYS',
    status: 'DISABLED',
    credential: { required: true, setAt: '2026-09-11T08:00:00.000Z' },
  };
  const TELEGRAM = {
    ...ROW,
    provider: 'TONPAYS_TELEGRAM',
    status: 'DISABLED',
    credential: { required: true, setAt: null },
  };

  const render = (walletTopup: unknown, gateways: unknown[] = [MANUAL, TONPAYS, TELEGRAM]) => {
    stubApi([{ url: '/payment-gateways', body: { gateways, walletTopup } }]);
    return renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
  };

  it('explains, per route, why no route can fund a top-up — card-to-card with no card, a keyed route switched off', async () => {
    const view = render({
      available: false,
      routes: [
        { provider: 'MANUAL_TRANSFER', blockers: ['NO_RECEIVING_ACCOUNT'] },
        { provider: 'TONPAYS', blockers: ['INACTIVE'] },
        { provider: 'TONPAYS_TELEGRAM', blockers: ['INACTIVE', 'PURPOSE_OFF'] },
      ],
    });
    expect(
      await screen.findByText(t('web.payment_gateways_topup_unavailable_title')),
    ).toBeInTheDocument();
    const text = view.container.textContent ?? '';
    expect(text).toContain('«💰 افزایش موجودی»');
    expect(text).toContain(t('web.payment_gateways_topup_block_no_receiving_account'));
    // TONPAYS has a key and is off; TONPAYS_TELEGRAM has none.
    expect(text).toContain(t('web.payment_gateways_topup_block_inactive_keyed'));
    expect(text).toContain(
      `${t('web.payment_gateways_topup_block_inactive_no_key')}${t('web.list_separator')}${t('web.payment_gateways_topup_block_purpose_off')}`,
    );
  });

  it('draws nothing when the server says a route can fund a top-up — even beside rows that look switched off', async () => {
    const off = {
      ...MANUAL,
      status: 'DISABLED',
      allowServicePurchase: false,
      allowWalletTopup: false,
    };
    render({ available: true, routes: [{ provider: 'MANUAL_TRANSFER', blockers: [] }] }, [off]);
    await screen.findByText('برای هیچ کاری');
    expect(screen.queryByText(t('web.payment_gateways_topup_unavailable_title'))).toBeNull();
  });

  it('draws nothing for a response from the previous release, which sends no verdict', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [MANUAL] } }]);
    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
    await screen.findAllByText(t('web.payment_gateway_provider_manual_transfer'));
    expect(screen.queryByText(t('web.payment_gateways_topup_unavailable_title'))).toBeNull();
  });

  it('names the unpriceable route', async () => {
    const view = render(
      {
        available: false,
        routes: [{ provider: 'MANUAL_TRANSFER', blockers: ['UNPRICEABLE'] }],
      },
      [MANUAL],
    );
    await screen.findByText(t('web.payment_gateways_topup_unavailable_title'));
    expect(view.container.textContent).toContain(t('web.payment_gateways_topup_block_unpriceable'));
  });
});

/**
 * WP11A — the TonPays route's API key is write-only on this screen.
 *
 * The list shows whether a key is configured and when; the key itself is never in any
 * response the page receives, so it cannot be rendered, and the form that replaces it
 * starts empty every time and posts to the credential route alone.
 */
describe('the TonPays API key', () => {
  const TONPAYS = {
    provider: 'TONPAYS',
    status: 'DISABLED',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: true, setAt: null },
    callbackUrl: 'https://bot.example.com/payments/webhook/tonpays/t-1',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  it('shows a missing key, the generated callback URL, and no field holding any key', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [TONPAYS] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="TONPAYS" denied={false} mayEdit />);
    expect(await screen.findByText('تنظیم نشده')).toBeInTheDocument();
    expect(view.container.textContent).toContain(TONPAYS.callbackUrl);
    // Nothing on the page is an input until the operator asks to replace the key.
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('shows a configured key as a state, and replaces it through an empty write-only form', async () => {
    const configured = {
      ...TONPAYS,
      credential: { required: true, setAt: '2026-09-20T08:00:00.000Z' },
    };
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [configured] } },
      { url: '/payment-gateways/TONPAYS/credential', body: { gateway: configured } },
    ]);
    renderPage(<PaymentGatewaysPage provider="TONPAYS" denied={false} mayEdit />);
    expect(await screen.findByText('تنظیم شده ••••••••')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تنظیم کلید API' }));
    const input = (await screen.findByLabelText('کلید API جدید')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');

    fireEvent.change(input, { target: { value: 'tp_new_key_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ کلید' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.filter((call) => call.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain('/payment-gateways/TONPAYS/credential');
    expect((posted[0]!.body as Record<string, unknown>)['apiKey']).toBe('tp_new_key_123');
  });

  it('draws no key control for a view-only role and none for a route that takes no key', async () => {
    const manual = {
      ...TONPAYS,
      provider: 'MANUAL_TRANSFER',
      credential: { required: false, setAt: null },
    };
    stubApi([{ url: '/payment-gateways', body: { gateways: [TONPAYS, manual] } }]);
    // TonPays' own view, for a role that may only view it: the state, and no control.
    const viewOnly = renderPage(
      <PaymentGatewaysPage provider="TONPAYS" denied={false} mayEdit={false} />,
    );
    expect(await screen.findByText('تنظیم نشده')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تنظیم کلید API' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ویرایش' })).toBeNull();
    viewOnly.unmount();
    // Card-to-card's own view, for an editor: its own controls, and no key control.
    renderPage(<PaymentGatewaysPage provider="MANUAL_TRANSFER" denied={false} mayEdit />);
    expect(await screen.findByText('لازم نیست')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ویرایش' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تنظیم کلید API' })).toBeNull();
  });
});

/**
 * NOWPayments (`docs/nowpayments-gateway-audit.md` §5.7): the IPN secret is a second
 * write-only field beside the key, shown as a state and never a value; the credential check
 * posts to its own route and the last result is shown for diagnosis.
 */
describe('the NOWPayments key, IPN secret and credential check', () => {
  const NOWPAYMENTS = {
    provider: 'NOWPAYMENTS',
    status: 'DISABLED',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: {
      required: true,
      setAt: '2026-09-20T08:00:00.000Z',
      webhookSecretRequired: true,
      webhookSecretSetAt: null,
      lastCheckAt: '2026-09-21T08:00:00.000Z',
      lastCheckResult: 'refused:INVALID_API_KEY',
    },
    callbackUrl: 'https://bot.example.com/payments/webhook/nowpayments/t-1',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  it('shows the missing IPN secret and the failed last check as states', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="NOWPAYMENTS" denied={false} mayEdit />);
    expect(await screen.findByText('کلید IPN تنظیم نشده')).toBeInTheDocument();
    expect(screen.getByText('اتصال ناموفق')).toBeInTheDocument();
    expect(view.container.textContent).toContain('refused:INVALID_API_KEY');
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('replaces the IPN secret through its own empty write-only field and route', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      { url: '/payment-gateways/NOWPAYMENTS/webhook-secret', body: { gateway: NOWPAYMENTS } },
    ]);
    renderPage(<PaymentGatewaysPage provider="NOWPAYMENTS" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم کلید API' }));
    const input = (await screen.findByLabelText('کلید IPN جدید (IPN Secret)')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'ipn_secret_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ کلید IPN' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.filter((call) => call.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain('/payment-gateways/NOWPAYMENTS/webhook-secret');
    expect((posted[0]!.body as Record<string, unknown>)['secret']).toBe('ipn_secret_123');
  });

  it('Codex #141: shows a failed check, and a retry of the same check reuses its idempotency key', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      {
        url: '/payment-gateways/NOWPAYMENTS/check',
        status: 502,
        body: {
          error: {
            kind: 'unavailable',
            code: 'test.upstream',
            message: 'the check could not be completed',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<PaymentGatewaysPage provider="NOWPAYMENTS" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'بررسی اتصال' }));
    // W6: an unmapped 5xx is said in Persian; the server's English never reaches the page.
    expect(await screen.findByText(t('web.err_status_5xx'))).toBeInTheDocument();
    expect(screen.queryByText('the check could not be completed')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'بررسی اتصال' })).not.toBeDisabled();
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fireEvent.click(screen.getByRole('button', { name: 'بررسی اتصال' }));
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'POST').length).toBeGreaterThanOrEqual(2);
    });
    const keys = api.calls
      .filter((call) => call.method === 'POST')
      .map((call) => (call.body as Record<string, unknown>)['idempotencyKey']);
    expect(new Set(keys).size).toBe(1);
  });

  it('runs the credential check through its own route, and offers it to no other route', async () => {
    const tonpays = { ...NOWPAYMENTS, provider: 'TONPAYS' };
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS, tonpays] } },
      { url: '/payment-gateways/NOWPAYMENTS/check', body: { gateway: NOWPAYMENTS } },
    ]);
    // On TonPays' own view, with a stored key, no check is drawn…
    const other = renderPage(<PaymentGatewaysPage provider="TONPAYS" denied={false} mayEdit />);
    expect(await screen.findByRole('button', { name: 'تنظیم کلید API' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بررسی اتصال' })).toBeNull();
    other.unmount();
    // …and on NOWPayments' own, it is.
    renderPage(<PaymentGatewaysPage provider="NOWPAYMENTS" denied={false} mayEdit />);
    const checks = await screen.findAllByRole('button', { name: 'بررسی اتصال' });
    expect(checks).toHaveLength(1);
    fireEvent.click(checks[0]!);
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(api.calls.filter((call) => call.method === 'POST')[0]!.url).toContain(
      '/payment-gateways/NOWPAYMENTS/check',
    );
  });
});

/**
 * CentralPay (`docs/centralpay-gateway-audit.md` §5.7): the verify key is a second write-only
 * field beside the API key, shown as a state and never a value; no credential check is
 * offered (the guide documents no safe read).
 */
describe('the CentralPay API key and verify key', () => {
  const CENTRALPAY = {
    provider: 'CENTRALPAY',
    status: 'DISABLED',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: {
      required: true,
      setAt: '2026-09-20T08:00:00.000Z',
      webhookSecretRequired: false,
      webhookSecretSetAt: null,
      lastCheckAt: null,
      lastCheckResult: null,
      verifyKeyRequired: true,
      verifyKeySetAt: null,
    },
    callbackUrl: 'https://bot.example.com/payments/return/centralpay/t-1',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  it('shows the missing verify key as a state, offers no check and no IPN secret', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [CENTRALPAY] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="CENTRALPAY" denied={false} mayEdit />);
    expect(await screen.findByText('کلید تأیید (verify) تنظیم نشده')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بررسی اتصال' })).toBeNull();
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('replaces the verify key through its own empty write-only field and route', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [CENTRALPAY] } },
      { url: '/payment-gateways/CENTRALPAY/verify-key', body: { gateway: CENTRALPAY } },
    ]);
    renderPage(<PaymentGatewaysPage provider="CENTRALPAY" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم کلید API' }));
    expect(screen.queryByLabelText('کلید IPN جدید (IPN Secret)')).toBeNull();
    const input = (await screen.findByLabelText('کلید تأیید جدید (verify)')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'md5_verify_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ کلید تأیید' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.filter((call) => call.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain('/payment-gateways/CENTRALPAY/verify-key');
    expect((posted[0]!.body as Record<string, unknown>)['verifyKey']).toBe('md5_verify_123');
  });
});

/**
 * TetraPay (`docs/tetrapay-gateway-audit.md`): the API key, an OPTIONAL webhook secret (a state
 * and never a value), the webhook URL to paste into TetraPay's panel - with a copy button -, the
 * bot username the customer is returned to (read from the stored bot, never typed), and the
 * provider's daily-limit hiding.
 */
describe('the TetraPay page', () => {
  const TETRAPAY = {
    provider: 'TETRAPAY',
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    customerFeeBasisPoints: 250,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: {
      required: true,
      setAt: '2026-09-20T08:00:00.000Z',
      webhookSecretRequired: false,
      webhookSecretSupported: true,
      webhookSecretSetAt: null,
      lastCheckAt: null,
      lastCheckResult: null,
      verifyKeyRequired: false,
      verifyKeySetAt: null,
    },
    callbackUrl: 'https://bot.example.com/payments/webhook/tetrapay/t-1',
    botUsername: 'nexa_test_bot',
    hiddenUntil: '2026-10-23T20:30:00.000Z',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  it('shows the webhook secret as optional (not a gap), the webhook URL with copy, the bot username and the hiding', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [TETRAPAY] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="TETRAPAY" denied={false} mayEdit />);
    expect(await screen.findByText('رمز وب‌هوک (اختیاری) تنظیم نشده')).toBeInTheDocument();
    expect(screen.queryByText('کلید IPN تنظیم نشده')).toBeNull();
    expect(
      await screen.findByText('https://bot.example.com/payments/webhook/tetrapay/t-1'),
    ).toBeInTheDocument();
    expect(
      view.container.querySelector(
        '[data-copy-value="https://bot.example.com/payments/webhook/tetrapay/t-1"]',
      ),
    ).not.toBeNull();
    expect(screen.getByText('@nexa_test_bot')).toBeInTheDocument();
    expect(screen.getByText('پنهان‌شده تا (سقف روزانهٔ درگاه)')).toBeInTheDocument();
  });

  it('saves the webhook secret through its own empty write-only field, with TetraPay wording', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [TETRAPAY] } },
      { url: '/payment-gateways/TETRAPAY/webhook-secret', body: { gateway: TETRAPAY } },
    ]);
    renderPage(<PaymentGatewaysPage provider="TETRAPAY" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم کلید API' }));
    expect(screen.queryByLabelText('کلید IPN جدید (IPN Secret)')).toBeNull();
    const input = (await screen.findByLabelText(
      'رمز وب‌هوک جدید (whsec_ — اختیاری)',
    )) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'whsec_abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ رمز وب‌هوک' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.filter((call) => call.method === 'POST');
    expect(posted[0]!.url).toContain('/payment-gateways/TETRAPAY/webhook-secret');
    expect((posted[0]!.body as Record<string, unknown>)['secret']).toBe('whsec_abc123');
  });
});

/**
 * Round 9 C4: a refused enable says in Persian exactly what is missing (the server's
 * `details.reason`), never only the generic «درگاه پرداخت اکنون در دسترس نیست».
 *
 * MUTATION: the toggle's banner put the generic sentence first -> both per-route tests
 * failed (the generic sentence came back); restored.
 */
describe('the enable refusal names the missing piece', () => {
  const route = (provider: string) => ({
    provider,
    status: 'DISABLED',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    customerFeeBasisPoints: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: true, setAt: null },
    callbackUrl: `https://bot.example.com/payments/webhook/${provider.toLowerCase()}/t-1`,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  });
  const refusal = (reason: string) => ({
    error: {
      kind: 'conflict',
      code: 'commerce.payment_gateway_unavailable',
      message: 'This payment route needs its API key before it can be switched on.',
      correlationId: 'test',
      details: { reason },
    },
  });

  for (const provider of ['TETRAPAY', 'RIALIT'] as const) {
    it(`${provider}: a missing API key is said in Persian, not the generic sentence`, async () => {
      stubApi([
        { url: '/payment-gateways', body: { gateways: [route(provider)] } },
        {
          url: `/payment-gateways/${provider}/status`,
          method: 'POST',
          status: 409,
          body: refusal('CREDENTIAL_MISSING'),
        },
      ]);
      renderPage(<PaymentGatewaysPage provider={provider} denied={false} mayEdit />);
      fireEvent.click(await screen.findByRole('button', { name: 'فعال کردن' }));
      expect(
        await screen.findByText(/این درگاه روشن نشد: کلید API آن ثبت نشده است/u),
      ).toBeInTheDocument();
      expect(screen.queryByText('درگاه پرداخت اکنون در دسترس نیست.')).toBeNull();
    });
  }

  it('each other gap has its own sentence; an unknown reason keeps the generic one', async () => {
    const { gatewayEnableRefusalText } = await import('../../apps/web/src/error-text');
    const { ApiError } = await import('../../apps/web/src/api/client');
    const of = (reason: string) =>
      gatewayEnableRefusalText(
        new ApiError(409, 'commerce.payment_gateway_unavailable', 'x', { reason }),
      );
    expect(of('WEBHOOK_SECRET_MISSING')).toContain('کلید وب‌هوک');
    expect(of('VERIFY_KEY_MISSING')).toContain('کلید تأیید');
    expect(of('RATE_MISSING')).toContain('نرخ تبدیل');
    expect(of('FX_UNAVAILABLE')).toContain('نرخ مرکزی');
    expect(of('STATUS_RACE')).toBeUndefined();
    expect(gatewayEnableRefusalText(new Error('x'))).toBeUndefined();
  });
});

describe('the Rialit page', () => {
  it('names the route, explains the one-fee rule, and shows the webhook URL to paste into Rialit', async () => {
    const rialit = {
      provider: 'RIALIT',
      status: 'DISABLED',
      displayName: null,
      instructions: null,
      minAmountMinor: '0',
      maxAmountMinor: '0',
      currency: 'IRT',
      eligibility: {
        activateAfterPayments: 0,
        deactivateAfterPayments: 0,
        activateAfterAccountDays: 0,
      },
      sortOrder: 0,
      topupCashbackPercent: 0,
      customerFeeBasisPoints: 0,
      allowServicePurchase: true,
      allowWalletTopup: true,
      credential: { required: true, setAt: null },
      callbackUrl: 'https://bot.example.com/payments/webhook/rialit/t-1',
      createdAt: '2026-09-10T12:30:00.000Z',
      updatedAt: '2026-09-10T12:30:00.000Z',
    };
    stubApi([{ url: '/payment-gateways', body: { gateways: [rialit] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="RIALIT" denied={false} mayEdit />);
    expect(await screen.findByText('نشانی وب‌هوک (در پنل ریالیت وارد کنید)')).toBeInTheDocument();
    expect(view.container.textContent).toContain(
      'https://bot.example.com/payments/webhook/rialit/t-1',
    );
    expect(view.container.textContent).toContain('درگاه ریالیت');
    fireEvent.click(screen.getByRole('button', { name: 'تنظیم کلید API' }));
    expect(await screen.findByText(/فقط یک طرف کارمزد بگیرد/u)).toBeInTheDocument();
  });
});

/**
 * Round 10 C1 — the custom gateway (`docs/protocols/custom-gateway.md`): one secret, a bridge
 * address and an optional callback allow-list, a «تست اتصال», disabled by default, and every
 * refusal said in Persian.
 */
describe('the custom gateway page', () => {
  const custom = (overrides: Record<string, unknown> = {}) => ({
    provider: 'CUSTOM',
    status: 'DISABLED',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    customerFeeBasisPoints: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: true, setAt: null },
    callbackUrl: 'https://bot.example.com/payments/webhook/custom/t-1',
    endpoint: { baseUrl: null, ipAllowlist: [] },
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
    ...overrides,
  });

  it('names the route, shows the missing bridge address, and offers no test before a secret and an address', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [custom()] } }]);
    const view = renderPage(<PaymentGatewaysPage provider="CUSTOM" denied={false} mayEdit />);
    expect(await screen.findAllByText('نشانی پل ثبت نشده')).not.toHaveLength(0);
    expect(view.container.textContent).toContain('درگاه سفارشی (پل پرداخت)');
    expect(screen.queryByRole('button', { name: 'تست اتصال' })).toBeNull();
  });

  it('saves the bridge address and the allow-list through their own route, normalised', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [custom()] } },
      { url: '/payment-gateways/CUSTOM/endpoint', method: 'POST', body: { gateway: custom() } },
    ]);
    renderPage(<PaymentGatewaysPage provider="CUSTOM" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم پل (رمز و نشانی)' }));
    expect(await screen.findByText(/فقط پاسخ امضاشدهٔ استعلام پل/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('نشانی پایهٔ پل (https)'), {
      target: { value: 'https://Pay.Example.com/nexa/' },
    });
    fireEvent.change(screen.getByLabelText('نشانی‌های مجاز اعلان پل (اختیاری)'), {
      target: { value: '203.0.113.0/24\n198.51.100.7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ نشانی پل' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/CUSTOM/endpoint'))).toBe(true);
    });
    const sent = api.calls.find((call) => call.url.includes('/CUSTOM/endpoint'))?.body as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      baseUrl: 'https://pay.example.com/nexa',
      ipAllowlist: ['203.0.113.0/24', '198.51.100.7'],
    });
  });

  it('refuses an http address at the field, sending nothing', async () => {
    const api = stubApi([{ url: '/payment-gateways', body: { gateways: [custom()] } }]);
    renderPage(<PaymentGatewaysPage provider="CUSTOM" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم پل (رمز و نشانی)' }));
    fireEvent.change(await screen.findByLabelText('نشانی پایهٔ پل (https)'), {
      target: { value: 'http://pay.example.com' },
    });
    expect(await screen.findByText(/نشانی پل باید با https/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیرهٔ نشانی پل' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('نشانی‌های مجاز اعلان پل (اختیاری)'), {
      target: { value: '0.0.0.0/0' },
    });
    expect(await screen.findByText(/هر خط فهرست مجاز/u)).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.includes('/CUSTOM/endpoint'))).toBe(false);
  });

  it('while the route is on, the address is read-only and the reason is said', async () => {
    stubApi([
      {
        url: '/payment-gateways',
        body: {
          gateways: [
            custom({
              status: 'ACTIVE',
              credential: { required: true, setAt: '2026-10-26T09:10:00.000Z' },
              endpoint: { baseUrl: 'https://pay.example.com/nexa', ipAllowlist: [] },
            }),
          ],
        },
      },
    ]);
    renderPage(<PaymentGatewaysPage provider="CUSTOM" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیم پل (رمز و نشانی)' }));
    expect(await screen.findByText(/اول درگاه را خاموش کنید/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیرهٔ نشانی پل' })).toBeDisabled();
  });

  it('offers «تست اتصال» once the secret and the address are set, through the check route', async () => {
    const ready = custom({
      credential: { required: true, setAt: '2026-10-26T09:10:00.000Z' },
      endpoint: { baseUrl: 'https://pay.example.com/nexa', ipAllowlist: ['203.0.113.0/24'] },
    });
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [ready] } },
      { url: '/payment-gateways/CUSTOM/check', method: 'POST', body: { gateway: ready } },
    ]);
    const view = renderPage(<PaymentGatewaysPage provider="CUSTOM" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'تست اتصال' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/CUSTOM/check'))).toBe(true);
    });
    expect(view.container.textContent).toContain('203.0.113.0/24');
  });

  it('says each refusal in Persian: no address on enable, change while on, a refused address, a short secret', async () => {
    const { gatewayRequestRefusalText } = await import('../../apps/web/src/error-text');
    const { ApiError } = await import('../../apps/web/src/api/client');
    const conflict = (reason: string) =>
      gatewayRequestRefusalText(
        new ApiError(409, 'commerce.payment_gateway_unavailable', 'x', { reason }),
      );
    const invalid = (reason: string) =>
      gatewayRequestRefusalText(new ApiError(400, 'commerce.request_invalid', 'x', { reason }));
    expect(conflict('ENDPOINT_MISSING')).toContain('نشانی پل');
    expect(conflict('ENDPOINT_CHANGE_WHILE_ACTIVE')).toContain('خاموش');
    expect(conflict('ENDPOINT_CHANGE_WITH_OPEN_ATTEMPTS')).toContain('پرداخت');
    expect(invalid('ENDPOINT_ADDRESS_REFUSED')).toContain('نشانی');
    expect(invalid('ENDPOINT_URL_INVALID')).toContain('https://');
    expect(invalid('ALLOWLIST_INVALID')).toContain('CIDR');
    expect(invalid('SECRET_TOO_SHORT')).toContain('32');
    expect(invalid('SOMETHING_ELSE')).toBeUndefined();
  });
});

/**
 * WP18 — the customer gateway fee field. Only a route that settles through `GATEWAY` draws
 * it; a typed `5.25` travels as 525 basis points, and 525 reopens as `5.25`.
 */
describe('the customer gateway fee', () => {
  const route = (provider: 'TONPAYS' | 'MANUAL_TRANSFER', customerFeeBasisPoints: number) => ({
    provider,
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    customerFeeBasisPoints,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: provider === 'TONPAYS', setAt: null },
    callbackUrl: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  });

  const openRoute = async (gateway: ReturnType<typeof route>) => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [gateway] } },
      { url: `/payment-gateways/${gateway.provider}`, body: { gateway } },
    ]);
    renderPage(<PaymentGatewaysPage provider={gateway.provider} denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'ویرایش' }));
    return api;
  };

  it('reopens 525 basis points as 5.25 and saves a typed 7.5 as 750 basis points', async () => {
    const api = await openRoute(route('TONPAYS', 525));
    expect(screen.getByText('5.25%')).toBeInTheDocument();
    const input = (await screen.findByLabelText('کارمزد مشتری (%)')) as HTMLInputElement;
    expect(input.value).toBe('5.25');

    fireEvent.change(input, { target: { value: '۷٫۵' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const saved = api.calls.find((call) => call.method === 'POST');
    expect((saved?.body as { customerFeeBasisPoints?: unknown }).customerFeeBasisPoints).toBe(750);
  });

  it('refuses a third decimal or a figure above 100 at the field, and will not save it', async () => {
    const api = await openRoute(route('TONPAYS', 0));
    const input = (await screen.findByLabelText('کارمزد مشتری (%)')) as HTMLInputElement;
    for (const bad of ['5.123', '100.01', '-1', '1e2']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(
        await screen.findByText('کارمزد مشتری باید عددی از 0 تا 100 با حداکثر دو رقم اعشار باشد.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'ذخیره' })).toBeDisabled();
    }
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('R6 item 4: card-to-card now draws the fee field, defaulting to 0, and sends it as typed', async () => {
    const api = await openRoute(route('MANUAL_TRANSFER', 0));
    const field = (await screen.findByLabelText('کارمزد مشتری (%)')) as HTMLInputElement;
    expect(field.value).toBe('0');
    fireEvent.change(field, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const saved = api.calls.find((call) => call.method === 'POST');
    expect((saved?.body as Record<string, unknown>)['customerFeeBasisPoints']).toBe(1000);
  });
});

/** Package A: the Telegram Stars rate — sales-currency minor units per Star. */
describe('the Web Admin rate field', () => {
  it('is shown for a fixed-rate route only — none since spec §8 priced Stars by the central rate', () => {
    expect(takesConversionRate('TELEGRAM_STARS')).toBe(false);
    expect(takesConversionRate('TONPAYS')).toBe(false);
    expect(takesConversionRate('MANUAL_TRANSFER')).toBe(false);
  });

  it('clears on empty, sets a positive whole number, and refuses anything else', () => {
    expect(conversionRateOf('')).toBeNull();
    expect(conversionRateOf('  ')).toBeNull();
    expect(conversionRateOf('1300')).toBe('1300');
    expect(conversionRateOf('۱۳۰۰')).toBe('1300');
    expect(conversionRateOf('0')).toBeUndefined();
    expect(conversionRateOf('1.5')).toBeUndefined();
    expect(conversionRateOf('-3')).toBeUndefined();
  });
});
