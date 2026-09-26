import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { minorOf, PaymentGatewaysPage, percentOf } from '../../apps/web/src/pages/payment-gateways';
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

  it.each([
    ['payment-accounts', 'payments.accounts.view', 'payments.accounts.edit'],
    ['payment-gateways', 'payments.gateways.view', 'payments.gateways.edit'],
  ])('%s is shown for view and hidden for edit alone', (id, view, edit) => {
    expect(navPermitted(entry(id), [view])).toBe(true);
    expect(navPermitted(entry(id), [view, edit])).toBe(true);
    expect(navPermitted(entry(id), [edit])).toBe(false);
    expect(navPermitted(entry(id), [])).toBe(false);
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
    const view = renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
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
    const { api, view, input } = await open();
    expect(input.value).toBe('5');
    expect(view.container.textContent).toContain('به‌عنوان هدیه به کیف پول مشتری واریز می‌شود');

    fireEvent.change(input, { target: { value: '۱۲' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const saved = api.calls.find((call) => call.method === 'POST');
    expect((saved?.body as { topupCashbackPercent?: unknown }).topupCashbackPercent).toBe(12);
  });

  it('refuses a figure outside 0–100 at the field, and will not save it', async () => {
    const { api, input } = await open();
    fireEvent.change(input, { target: { value: '150' } });

    expect(
      await screen.findByText('درصد هدیهٔ شارژ باید عددی صحیح از ۰ تا ۱۰۰ باشد.'),
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
    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
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
    const view = renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
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
    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
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
    renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    expect(await screen.findByText('لازم نیست')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تنظیم کلید API' })).toBeNull();
  });
});
