import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_ERROR_CODES } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { REFUSAL_REPLIES } from '../../apps/api/src/surfaces/telegram/runtime/refusals';
import { ApiError, MiniAppApi } from '../../apps/miniapp/src/api';
import {
  COMMERCE_ERROR_BOT_KEY,
  COMMERCE_ERROR_GENERIC,
  commerceErrorText,
} from '../../apps/miniapp/src/commerce-errors';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { Checkout } from '../../apps/miniapp/src/screens/checkout';
import { Services } from '../../apps/miniapp/src/screens/services';
import { Store } from '../../apps/miniapp/src/screens/store';
import { errorText } from '../../apps/miniapp/src/ui';

/**
 * R12 F3 item 5 — the mini app's quick wins, rendered against a REAL `MiniAppApi` over a
 * stubbed `fetch` (only the shell is replaced), so the contract schemas are the production path:
 *
 *   - every commerce refusal has a sentence (the bot's own words) or is decided generic;
 *   - the custom-username rule is stated before the customer is refused;
 *   - «لغو سفارش» asks before it cancels;
 *   - «بیشتر» ADDS the next page under the ones shown;
 *   - the empty services list leads to the store.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const wire = (amount: string) => ({ amountMinor: amount, currency: 'IRT' });
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

type Handler = (request: { body: unknown }) => { status?: number; body?: unknown };
let routes: Record<string, Handler> = {};
let calls: string[] = [];
let navigate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const full = url.replace('/miniapp/api/v1', '');
      const path = full.split('?')[0] ?? '';
      calls.push(`${method} ${full}`);
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) return new Response('{}', { status: 404 });
      const answer = handler({ body });
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
    }),
  );
  navigate = vi.fn();
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: {},
    refreshMe: vi.fn(async () => undefined),
    navigate,
    replace: vi.fn(),
    back: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('R12 F3 item 5: every commerce refusal has a sentence or is decided generic', () => {
  const allCodes = Object.values(COMMERCE_ERROR_CODES) as string[];

  it('maps each commerce code to the bot’s words, or lists it as generic — none is left undecided', () => {
    const undecided = allCodes.filter(
      (code) =>
        !(code in COMMERCE_ERROR_BOT_KEY) &&
        !COMMERCE_ERROR_GENERIC.includes(code) &&
        // The mini app's own words for these (ui.tsx), checked first.
        !MINIAPP_OWN.includes(code),
    );
    expect(undecided, 'add the code to COMMERCE_ERROR_BOT_KEY or COMMERCE_ERROR_GENERIC').toEqual(
      [],
    );
    // Generic means "no sentence of its own": never also mapped.
    expect(COMMERCE_ERROR_GENERIC.filter((code) => code in COMMERCE_ERROR_BOT_KEY)).toEqual([]);
  });

  it('is the same sentence the bot refuses with, code for code', () => {
    for (const [code, key] of Object.entries(REFUSAL_REPLIES)) {
      // The bot's other refusal map entries (platform codes, say) are not commerce codes.
      if (!allCodes.includes(code)) continue;
      expect(COMMERCE_ERROR_BOT_KEY[code], code).toBe(key);
    }
  });

  it('shows the bot’s sentence without its icon markers, and never an unfilled placeholder', () => {
    for (const code of Object.keys(COMMERCE_ERROR_BOT_KEY)) {
      const text = commerceErrorText(code);
      expect(text, code).not.toBeNull();
      expect(text, code).not.toMatch(/\{[^}]*\}/u);
    }
    expect(commerceErrorText(COMMERCE_ERROR_CODES.ORDER_EXPIRED)).toBe(
      CATALOGUE_FA['bot.order.expired'],
    );
    // The receipt cap is filled in, not printed as a token.
    expect(commerceErrorText(COMMERCE_ERROR_CODES.RECEIPT_LIMIT_REACHED)).not.toContain('{limit}');
    expect(commerceErrorText(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND)).not.toContain('{icon');
  });

  it('errorText answers a mapped code with it, and an unknown one with the generic sentence', () => {
    const refused = (code: string) =>
      new ApiError(409, code, { kind: 'CONFLICT', code, message: '', details: {} } as never);
    expect(errorText(refused(COMMERCE_ERROR_CODES.ORDER_EXPIRED))).toBe(
      CATALOGUE_FA['bot.order.expired'],
    );
    // OQ-R11-A11-04: past the deadline only because a payment is still live — never "order
    // again", which invites a second payment; the bot's in-review sentence instead.
    const live = new ApiError(409, COMMERCE_ERROR_CODES.ORDER_EXPIRED, { paymentLive: true });
    expect(errorText(live)).toBe(
      CATALOGUE_FA['bot.order.payment_in_review'].replaceAll(/\{icon:[a-z]+\}\s*/gu, '').trim(),
    );
    expect(errorText(live)).not.toBe(CATALOGUE_FA['bot.order.expired']);
    expect(errorText(refused(COMMERCE_ERROR_CODES.SERVICE_LOCATION_NOT_FOUND))).toBe(
      fa('miniapp.error'),
    );
    // The mini app's own words still win where it has them.
    expect(errorText(refused('commerce.discount_code_rejected'))).toBe(
      fa('miniapp.checkout_discount_refused'),
    );
  });
});

/** The codes `ui.tsx` words itself (`ERROR_TEXT`), which the shared table need not repeat. */
const MINIAPP_OWN: readonly string[] = [COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED];

const order = (overrides: Record<string, unknown> = {}) => ({
  id: '01900000-0000-7000-8000-0000000000c1',
  code: 'ABCD1234',
  state: 'DRAFT',
  purpose: 'NEW_SERVICE',
  title: 'پلن پایه',
  trafficBytes: String(50n * 1024n ** 3n),
  durationDays: 30,
  subtotal: wire('250000'),
  discount: wire('0'),
  total: wire('250000'),
  discountApplied: false,
  personalDiscountPercent: null,
  discountEditable: true,
  cashback: null,
  expiresAt: null,
  serviceId: null,
  username: null,
  usernameModes: ['AUTOMATIC', 'CUSTOM'],
  locations: [],
  features: [],
  description: null,
  ...overrides,
});
const paymentRoutes = {
  wallet: { balance: wire('0'), sufficient: false, shortfall: wire('250000') },
  routes: [],
};

describe('R12 F3 item 5: the checkout', () => {
  it('states the username rule — the bot’s own lines — beside the custom field', async () => {
    routes['GET /orders/01900000-0000-7000-8000-0000000000c1'] = () => ({ body: order() });
    routes['GET /orders/01900000-0000-7000-8000-0000000000c1/payment-routes'] = () => ({
      body: paymentRoutes,
    });
    render(<Checkout orderId="01900000-0000-7000-8000-0000000000c1" />);
    const rule = await screen.findByTestId('username-rule');
    const lines = within(rule)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(lines).toEqual(
      CATALOGUE_FA['bot.username.instructions']
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^•\s*/u, '')),
    );
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('asks before cancelling: only the confirmation cancels, «انصراف» does not', async () => {
    routes['GET /orders/01900000-0000-7000-8000-0000000000c1'] = () => ({ body: order() });
    routes['GET /orders/01900000-0000-7000-8000-0000000000c1/payment-routes'] = () => ({
      body: paymentRoutes,
    });
    routes['POST /orders/01900000-0000-7000-8000-0000000000c1/cancel'] = () => ({
      body: order({ state: 'CANCELLED' }),
    });
    render(<Checkout orderId="01900000-0000-7000-8000-0000000000c1" />);
    fireEvent.click(await screen.findByRole('button', { name: fa('miniapp.checkout_cancel') }));

    // The sheet asks, in the bot's words, and nothing was cancelled yet.
    const sheet = await screen.findByRole('dialog', { name: fa('miniapp.checkout_cancel_title') });
    expect(within(sheet).getByText(fa('miniapp.checkout_cancel_question'))).toBeTruthy();
    expect(fa('miniapp.checkout_cancel_question')).toBe(CATALOGUE_FA['bot.order.cancel_confirm']);
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);

    // «انصراف» closes the question and cancels nothing.
    fireEvent.click(within(sheet).getByRole('button', { name: fa('miniapp.sheet_cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);

    // The confirmation is the one tap that cancels.
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.checkout_cancel') }));
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: fa('miniapp.checkout_cancel_yes') }));
    await waitFor(() =>
      expect(
        calls.filter((call) => call === 'POST /orders/01900000-0000-7000-8000-0000000000c1/cancel'),
      ).toHaveLength(1),
    );
  });
});

const service = (n: number) => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  code: null,
  title: `سرویس ${String(n)}`,
  state: 'ACTIVE',
  username: `user${String(n)}`,
  trafficUsedBytes: '0',
  trafficLimitBytes: String(50n * 1024n ** 3n),
  expiresAt: null,
  usageSyncedAt: null,
  deviceLimit: null,
  locationLabel: null,
  isTrial: false,
});

describe('R12 F3 item 5: «بیشتر» adds the next page, and an empty list leads to the store', () => {
  it('the services list keeps page one on screen and appends page two under it', async () => {
    routes['GET /services'] = () => ({
      body: { items: [service(1), service(2)], page: 0, pages: 2, total: 3 },
    });
    render(<Services />);
    await screen.findByText('سرویس 1');
    // The second page is a different read.
    routes['GET /services'] = () => ({
      body: { items: [service(3)], page: 1, pages: 2, total: 3 },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.store_more') }));
    await screen.findByText('سرویس 3');
    expect(screen.getByText('سرویس 1')).toBeTruthy();
    expect(screen.getByText('سرویس 2')).toBeTruthy();
    // No further page: no further button.
    expect(screen.queryByRole('button', { name: fa('miniapp.store_more') })).toBeNull();
    expect(calls.filter((call) => call.startsWith('GET /services?'))).toEqual([
      'GET /services?page=0',
      'GET /services?page=1',
    ]);
  });

  it('a category’s plans: page two is added under page one', async () => {
    routes['GET /catalogue/categories'] = () => ({
      body: { items: [{ id: 'c1', name: 'ماهانه', emoji: null }], page: 0, hasMore: false },
    });
    const plan = (id: string, title: string) => ({
      id,
      title,
      price: wire('100000'),
      personalDiscount: null,
      trafficBytes: String(50n * 1024n ** 3n),
      durationDays: 30,
      deviceLimit: null,
      locations: [],
      features: [],
    });
    routes['GET /catalogue/categories/c1'] = () => ({
      body: {
        items: [plan('01900000-0000-7000-8000-0000000000a1', 'پلن اول')],
        page: 0,
        hasMore: true,
      },
    });
    render(<Store />);
    await screen.findByText('پلن اول');
    routes['GET /catalogue/categories/c1'] = () => ({
      body: {
        items: [plan('01900000-0000-7000-8000-0000000000a2', 'پلن دوم')],
        page: 1,
        hasMore: false,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.store_more') }));
    await screen.findByText('پلن دوم');
    expect(screen.getByText('پلن اول')).toBeTruthy();
    expect(screen.queryByRole('button', { name: fa('miniapp.store_more') })).toBeNull();
  });

  it('an empty services list has the buy button, and it opens the store', async () => {
    routes['GET /services'] = () => ({ body: { items: [], page: 0, pages: 0, total: 0 } });
    render(<Services />);
    await screen.findByText(fa('miniapp.home_no_services'));
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.home_buy') }));
    expect(navigate).toHaveBeenCalledWith({ name: 'store' });
  });
});
