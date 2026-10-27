import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MINIAPP_ROUTES } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { ApiError } from '../../apps/miniapp/src/api';
import { dateOnly, money, parseAmountInput, signedMoney } from '../../apps/miniapp/src/format';
import { trialErrorText } from '../../apps/miniapp/src/screens/trial';
import { LEDGER_REASON_KEY } from '../../apps/miniapp/src/screens/wallet-labels';

/**
 * Round 9, C5 part 2a: the wallet, profile, referral and trial screens of the customer mini
 * app, rendered from mocked API answers through the whole shell (handshake, tab bar, stack).
 *
 * The notification centre and the reseller panel have no capability behind them, so the
 * tests also pin that nothing in the shell reaches either.
 */

const BOT = '01900000-0000-7000-8000-00000000a001';
const IRT = (amount: number | string) => ({
  amountMinor: String(amount),
  currency: 'IRT' as const,
});
const text = (key: keyof typeof MINIAPP_FA, values: Record<string, string | number> = {}) =>
  MINIAPP_FA[key].replace(/\{([a-z]+)\}/gu, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]),
  );

type Reply = { status?: number; body: unknown } | unknown;
type Handler = (url: URL, init: RequestInit) => Reply;

interface Call {
  readonly method: string;
  readonly route: string;
  readonly query: string;
  readonly body: unknown;
}

const baseMe = (overrides: Record<string, unknown> = {}) => ({
  customer: { firstName: 'سارا', username: 'sara_k' },
  botLink: 'https://t.me/nexa_bot',
  gate: null,
  wallet: { balance: IRT(1_250_000) },
  reseller: null,
  ...overrides,
});

const openLink = vi.fn();
const openTelegramLink = vi.fn();

/** Serves the mini-app API from `routes` (`'GET /wallet'`), recording every call. */
function serve(routes: Record<string, Handler>, me: unknown = baseMe()) {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    'POST /bots/:bot/session': () => ({
      token: `${BOT}.secret`,
      expiresAt: '2026-10-25T13:00:00.000Z',
    }),
    'GET /me': () => me,
    'GET /services': () => ({ items: [], page: 0, pages: 1, total: 0 }),
    'GET /trial': () => ({ offers: [] }),
    // R11 B3: the invited-friends list is off unless a test turns it on.
    'GET /referral/friends': () => ({ enabled: false }),
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const route = url.pathname.replace('/miniapp/api/v1', '').replace(BOT, ':bot');
      const method = init.method ?? 'GET';
      calls.push({
        method,
        route,
        query: url.search,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const handler = all[`${method} ${route}`];
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ error: { kind: 'NOT_FOUND', code: 'miniapp.not_found' } }),
          {
            status: 404,
          },
        );
      }
      const reply = handler(url, init) as { status?: number; body?: unknown; __reply?: true };
      const status = reply?.__reply === true ? (reply.status ?? 200) : 200;
      const body = reply?.__reply === true ? reply.body : reply;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const refuse = (status: number, code: string, details?: Record<string, unknown>) => ({
  __reply: true,
  status,
  body: { error: { kind: 'CONFLICT', code, ...(details === undefined ? {} : { details }) } },
});

async function mount() {
  // The handshake is once per document; each test is a new document.
  vi.resetModules();
  window.history.pushState({}, '', `/miniapp/${BOT}/`);
  (window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: {
      initData: 'query_id=x&hash=y',
      colorScheme: 'dark',
      BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
      ready() {},
      expand() {},
      openLink,
      openTelegramLink,
      onEvent() {},
    },
  };
  const { App } = await import('../../apps/miniapp/src/app');
  render(<App />);
  await screen.findByRole('navigation');
}

const tab = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const tabWallet = () => tab(MINIAPP_FA['miniapp.tab_wallet']);
const tabProfile = () => tab(MINIAPP_FA['miniapp.tab_profile']);

beforeEach(() => {
  sessionStorage.clear();
  openLink.mockReset();
  openTelegramLink.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

const wallet = (extra: Record<string, unknown> = {}) => ({
  balance: IRT(1_250_000),
  presets: [IRT(100_000), IRT(200_000), IRT(500_000)],
  minimum: IRT(50_000),
  maximum: IRT(5_000_000),
  // R10 D4: the gift-card field is drawn only while the server says the feature is on.
  giftCards: false,
  ...extra,
});

const entries = {
  items: [
    {
      id: 'e1',
      direction: 'CREDIT',
      reason: 'REFERRAL_COMMISSION',
      amount: IRT(29_000),
      createdAt: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 'e2',
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: IRT(264_000),
      createdAt: '2026-10-19T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};

describe('wallet', () => {
  it('draws the balance, the presets and the ledger with each amount signed by its direction', async () => {
    serve({ 'GET /wallet': () => wallet(), 'GET /wallet/entries': () => entries });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.wallet_reason_referral'));
    expect(screen.getAllByText(money(IRT(1_250_000))).length).toBeGreaterThan(0);
    for (const preset of [100_000, 200_000, 500_000]) {
      expect(screen.getByRole('button', { name: money(IRT(preset)) })).toBeTruthy();
    }
    // A credit adds, a debit takes: the row's amount carries the sign, not just the colour.
    expect(screen.getByText(`+${money(IRT(29_000))}`)).toBeTruthy();
    expect(screen.getByText(`−${money(IRT(264_000))}`)).toBeTruthy();
    expect(screen.getByText(text('miniapp.wallet_reason_purchase'))).toBeTruthy();
    expect(signedMoney('DEBIT', IRT(5))).toMatch(/^−/u);
  });

  it('R10 D4: draws no gift-card field while the feature is off', async () => {
    serve({ 'GET /wallet': () => wallet(), 'GET /wallet/entries': () => entries });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.wallet_reason_referral'));
    expect(screen.queryByText(text('miniapp.wallet_gift_title'))).toBeNull();
  });

  it('R10 D4: redeems a typed gift card, says what was credited, and gives one sentence for a refusal', async () => {
    let answer: unknown = {
      outcome: 'REDEEMED',
      amount: IRT(50_000),
      balance: IRT(1_300_000),
    };
    const calls = serve({
      'GET /wallet': () => wallet({ giftCards: true }),
      'GET /wallet/entries': () => entries,
      'POST /wallet/gift-card': () => answer,
    });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.wallet_gift_title'));
    const field = screen.getByLabelText(text('miniapp.wallet_gift_label'));
    fireEvent.change(field, { target: { value: 'abcd-efgh-jkmn-pqrs-tvwx' } });
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_gift_submit') }));
    await screen.findByText(
      text('miniapp.wallet_gift_redeemed', {
        amount: money(IRT(50_000)),
        balance: money(IRT(1_300_000)),
      }),
    );
    expect(calls.find((call) => call.route === MINIAPP_ROUTES.walletGiftCard)?.body).toEqual({
      code: 'abcd-efgh-jkmn-pqrs-tvwx',
    });
    // The code is not kept on the screen once answered.
    expect((field as HTMLInputElement).value).toBe('');
    answer = { outcome: 'REJECTED' };
    fireEvent.change(screen.getByLabelText(text('miniapp.wallet_gift_label')), {
      target: { value: '2222-3333-4444-5555-6666' },
    });
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_gift_submit') }));
    await screen.findByText(text('miniapp.wallet_gift_rejected'));
  });

  it('lists the payments, a pending top-up included, and opens one in the payment screen', async () => {
    const calls = serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'GET /payments': () => ({
        items: [
          {
            id: 'p1',
            code: 'P1',
            method: 'MANUAL_TRANSFER',
            state: 'PENDING',
            amount: IRT(200_000),
            provider: 'MANUAL_TRANSFER',
            topup: true,
            createdAt: '2026-10-25T10:20:00.000Z',
          },
          {
            id: 'p2',
            code: 'P2',
            method: 'WALLET',
            state: 'CONFIRMED',
            amount: IRT(264_000),
            provider: null,
            topup: false,
            createdAt: '2026-10-19T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
      'GET /payments/p1': () => ({
        paymentId: 'p1',
        method: 'MANUAL_TRANSFER',
        state: 'PENDING',
        transferPending: true,
        receiptFiled: false,
        gateway: null,
        order: null,
      }),
    });
    await mount();
    tabWallet();
    fireEvent.click(await screen.findByRole('tab', { name: text('miniapp.wallet_tab_payments') }));
    await screen.findByText(text('miniapp.wallet_payment_topup'));
    expect(screen.getByText(text('miniapp.wallet_payment_order'))).toBeTruthy();
    expect(screen.getByText(new RegExp(text('miniapp.wallet_pstate_PENDING'), 'u'))).toBeTruthy();
    expect(screen.getAllByText(money(IRT(200_000))).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.route === '/payments')).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(text('miniapp.wallet_payment_topup'), 'u') }),
    );
    await screen.findByText(text('miniapp.pay_transfer_open'));
    expect(calls.some((call) => call.route === '/payments/p1')).toBe(true);
  });

  it('says so when there is no history, in both lists', async () => {
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => ({ items: [], nextCursor: null }),
      'GET /payments': () => ({ items: [], nextCursor: null }),
    });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.wallet_entries_empty'));
    fireEvent.click(screen.getByRole('tab', { name: text('miniapp.wallet_tab_payments') }));
    await screen.findByText(text('miniapp.wallet_payments_empty'));
  });

  it('says a read failed and retries it', async () => {
    let failing = true;
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => (failing ? refuse(500, 'internal.unhandled') : entries),
    });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.error'));
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.retry') }));
    await screen.findByText(text('miniapp.wallet_reason_purchase'));
  });

  it('fetches the next page with the cursor the server gave and appends it', async () => {
    const calls = serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': (url) =>
        url.searchParams.get('cursor') === 'abc 1'
          ? {
              items: [
                {
                  id: 'e3',
                  direction: 'CREDIT',
                  reason: 'START_GIFT',
                  amount: IRT(10_000),
                  createdAt: '2026-09-01T10:00:00.000Z',
                },
              ],
              nextCursor: null,
            }
          : { ...entries, nextCursor: 'abc 1' },
    });
    await mount();
    tabWallet();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.wallet_more') }));
    await screen.findByText(text('miniapp.wallet_reason_start_gift'));
    expect(screen.getByText(text('miniapp.wallet_reason_purchase'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('miniapp.wallet_more') })).toBeNull();
    expect(
      calls.filter((call) => call.route === '/wallet/entries').map((call) => call.query),
    ).toEqual(['', '?cursor=abc%201']);
  });

  it("quotes a preset, refuses it below the floor in the server's figures, then offers routes", async () => {
    const quotes: unknown[] = [];
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'POST /wallet/topup/quote': (_url, init) => {
        const body = JSON.parse(String(init.body)) as { amount: { amountMinor: string } };
        quotes.push(body.amount.amountMinor);
        return body.amount.amountMinor === '100000'
          ? { outcome: 'BELOW_MINIMUM', minimum: IRT(150_000) }
          : {
              outcome: 'ROUTES',
              amount: IRT(200_000),
              routes: [
                {
                  provider: 'MANUAL_TRANSFER',
                  kind: 'CARD_TO_CARD',
                  name: 'x',
                  paysInChat: false,
                  giftPercent: 5,
                },
                {
                  provider: 'TETRAPAY',
                  kind: 'GATEWAY',
                  name: 'تتراپی',
                  paysInChat: false,
                  giftPercent: 0,
                },
              ],
            };
      },
    });
    await mount();
    tabWallet();
    fireEvent.click(await screen.findByRole('button', { name: money(IRT(100_000)) }));
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_continue') }));
    await screen.findByText(text('miniapp.wallet_below_minimum', { amount: money(IRT(150_000)) }));
    fireEvent.click(screen.getByRole('button', { name: money(IRT(200_000)) }));
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_continue') }));
    await screen.findByText(text('miniapp.wallet_routes_title', { amount: money(IRT(200_000)) }));
    expect(
      screen.queryByText(text('miniapp.wallet_below_minimum', { amount: money(IRT(150_000)) })),
    ).toBeNull();
    expect(screen.getByText(text('miniapp.checkout_card'))).toBeTruthy();
    expect(screen.getByText('تتراپی')).toBeTruthy();
    expect(screen.getByText(text('miniapp.wallet_route_gift', { percent: 5 }))).toBeTruthy();
    expect(quotes).toEqual(['100000', '200000']);
  });

  it('reads a typed amount in any digits, quotes that, and sends the chosen route to the top-up', async () => {
    const calls = serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'POST /wallet/topup/quote': () => ({
        outcome: 'ROUTES',
        amount: IRT(250_000),
        routes: [
          {
            provider: 'MANUAL_TRANSFER',
            kind: 'CARD_TO_CARD',
            name: 'x',
            paysInChat: false,
            giftPercent: 0,
          },
        ],
      }),
      'POST /wallet/topup': () => ({
        kind: 'CARD_TO_CARD',
        instruction: {
          paymentId: 'pay-1',
          orderId: null,
          amount: IRT(250_000),
          copyAmount: '2500000',
          amountRial: '۲٬۵۰۰٬۰۰۰',
          amountToman: '۲۵۰٬۰۰۰',
          reference: 'TRK1',
          expiresAt: null,
          destination: null,
        },
      }),
    });
    await mount();
    tabWallet();
    fireEvent.change(await screen.findByLabelText(text('miniapp.wallet_custom_label')), {
      target: { value: '۲۵۰٬۰۰۰' },
    });
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_continue') }));
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.checkout_card') }));
    await screen.findByText(text('miniapp.card_title'));
    const quote = calls.find((call) => call.route === '/wallet/topup/quote');
    expect(quote?.body).toEqual({ amount: IRT(250_000) });
    const topup = calls.find((call) => call.route === '/wallet/topup');
    expect(topup?.body).toEqual({ amount: IRT(250_000), provider: 'MANUAL_TRANSFER' });
    /*
     * v0.8.2 hotfix: the amount to transfer reads in RIAL with Toman only in brackets, as the
     * bot's card invoice — never «۲۵۰٬۰۰۰ تومان» beside a button that copies 2500000.
     */
    expect(
      screen.getByText(text('miniapp.card_amount_rial', { amount: '۲٬۵۰۰٬۰۰۰' })),
    ).toBeTruthy();
    expect(screen.getByText(text('miniapp.card_amount_toman', { amount: '۲۵۰٬۰۰۰' }))).toBeTruthy();
    expect(screen.queryByText(money(IRT(250_000)))).toBeNull();
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.card_copy_rial') }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('2500000'));
  });

  /*
   * R10 B6: the bot's card invoice (R8 A2) states ONE amount — the one to transfer, fee
   * included — and never breaks it into principal and «کارمزد». The mini app's card screen is
   * the same invoice. Served here with the principal and fee an earlier server sent beside it:
   * neither the wire schema nor the screen lets them through.
   */
  it('R10 B6: a card top-up with a customer fee shows one rial amount, Toman in brackets, and no «کارمزد»', async () => {
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'POST /wallet/topup/quote': () => ({
        outcome: 'ROUTES',
        amount: IRT(470_000),
        routes: [
          {
            provider: 'MANUAL_TRANSFER',
            kind: 'CARD_TO_CARD',
            name: 'x',
            paysInChat: false,
            giftPercent: 0,
          },
        ],
      }),
      'POST /wallet/topup': () => ({
        kind: 'CARD_TO_CARD',
        instruction: {
          paymentId: 'pay-fee',
          orderId: null,
          amount: IRT(517_000),
          copyAmount: '5170000',
          amountRial: '۵٬۱۷۰٬۰۰۰',
          amountToman: '۵۱۷٬۰۰۰',
          principal: IRT(470_000),
          fee: IRT(47_000),
          reference: 'TRK2',
          expiresAt: null,
          destination: null,
        },
      }),
    });
    await mount();
    tabWallet();
    fireEvent.change(await screen.findByLabelText(text('miniapp.wallet_custom_label')), {
      target: { value: '470000' },
    });
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_continue') }));
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.checkout_card') }));
    await screen.findByText(text('miniapp.card_title'));
    expect(screen.getByText('۵٬۱۷۰٬۰۰۰ ریال')).toBeTruthy();
    expect(screen.getByText('(معادل ۵۱۷٬۰۰۰ تومان)')).toBeTruthy();
    const page = document.body.textContent ?? '';
    expect(page).not.toContain('کارمزد');
    expect(page).not.toContain(money(IRT(470_000)));
    expect(page).not.toContain(money(IRT(47_000)));
    // No mini-app string can name the fee on a card screen.
    expect(
      Object.entries(MINIAPP_FA).filter(
        ([key, value]) => key.startsWith('miniapp.card_') && value.includes('کارمزد'),
      ),
    ).toEqual([]);
  });

  it('opens the provider page for a gateway top-up and follows the payment', async () => {
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'POST /wallet/topup/quote': () => ({
        outcome: 'ROUTES',
        amount: IRT(200_000),
        routes: [
          {
            provider: 'TETRAPAY',
            kind: 'GATEWAY',
            name: 'تتراپی',
            paysInChat: false,
            giftPercent: 0,
          },
        ],
      }),
      'POST /wallet/topup': () => ({
        kind: 'GATEWAY',
        attempt: {
          paymentId: 'pay-2',
          orderId: null,
          provider: 'TETRAPAY',
          invoiceReady: true,
          payUrl: 'https://pay.example/x',
          paysInChat: false,
          expiresAt: null,
        },
      }),
      'GET /payments/pay-2': () => ({
        paymentId: 'pay-2',
        method: 'GATEWAY',
        state: 'PENDING',
        transferPending: false,
        receiptFiled: false,
        gateway: {
          paymentId: 'pay-2',
          orderId: null,
          provider: 'TETRAPAY',
          invoiceReady: true,
          payUrl: 'https://pay.example/x',
          paysInChat: false,
          expiresAt: null,
        },
        order: null,
      }),
    });
    await mount();
    tabWallet();
    fireEvent.click(await screen.findByRole('button', { name: money(IRT(200_000)) }));
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.wallet_continue') }));
    fireEvent.click(await screen.findByRole('button', { name: 'تتراپی' }));
    await screen.findByText(text('miniapp.pay_title'));
    expect(openLink).toHaveBeenCalledWith('https://pay.example/x');
  });

  it('refuses text that is not a whole number before asking the server', async () => {
    const calls = serve({ 'GET /wallet': () => wallet(), 'GET /wallet/entries': () => entries });
    await mount();
    tabWallet();
    fireEvent.change(await screen.findByLabelText(text('miniapp.wallet_custom_label')), {
      target: { value: '12.5' },
    });
    expect(screen.getByText(text('miniapp.wallet_amount_invalid'))).toBeTruthy();
    expect(screen.getByRole('button', { name: text('miniapp.wallet_continue') })).toHaveProperty(
      'disabled',
      true,
    );
    expect(calls.some((call) => call.route === '/wallet/topup/quote')).toBe(false);
    expect(parseAmountInput('0', 'IRT')).toBeNull();
    expect(parseAmountInput('-5', 'IRT')).toBeNull();
    expect(parseAmountInput('٣٠٠،۰۰۰', 'IRT')).toEqual(IRT(300_000));
    expect(parseAmountInput('99999999999999999999', 'IRT')).toBeNull();
  });

  it('draws no spending chart, no history filter and no notifications entry', async () => {
    serve({ 'GET /wallet': () => wallet(), 'GET /wallet/entries': () => entries });
    await mount();
    tabWallet();
    await screen.findByText(text('miniapp.wallet_reason_purchase'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/اعلان/u)).toBeNull();
  });

  it('names every ledger reason', () => {
    for (const key of Object.values(LEDGER_REASON_KEY)) expect(MINIAPP_FA[key]).toBeTruthy();
  });
});

describe('profile', () => {
  it('shows the name, the username and the entries that are backed — and nothing else', async () => {
    serve({ 'GET /trial': () => ({ offers: [] }) });
    await mount();
    tabProfile();
    await screen.findByText(text('miniapp.profile_wallet_history'));
    expect(screen.getByText('سارا')).toBeTruthy();
    expect(screen.getByText('@sara_k')).toBeTruthy();
    expect(screen.getByText(text('miniapp.profile_referral'))).toBeTruthy();
    // Hidden, because nothing backs them: notifications, discount codes, the reseller panel,
    // the reminder and marketing switches, the default service username, the order count.
    for (const hidden of [
      /اعلان/u,
      /کدهای تخفیف/u,
      /پنل نمایندگی/u,
      /پیام‌های تبلیغاتی/u,
      /نام کاربری سرویس/u,
      /ویرایش/u,
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(text('miniapp.profile_trial'))).toBeNull();
  });

  it('shows the reseller tier as a label for an active reseller, never as a link to a panel', async () => {
    serve({}, baseMe({ reseller: { tierName: 'طلایی' } }));
    await mount();
    tabProfile();
    await screen.findByText(text('miniapp.profile_reseller', { tier: 'طلایی' }));
    expect(screen.queryByRole('button', { name: /نمایندگی/u })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows no tier for an ordinary customer', async () => {
    serve({});
    await mount();
    tabProfile();
    await screen.findByText(text('miniapp.profile_wallet_history'));
    expect(screen.queryByText(/سطح نمایندگی/u)).toBeNull();
  });

  it('offers the trial row only while a panel offers a trial', async () => {
    serve({
      'GET /trial': () => ({
        offers: [
          { panelId: 'pn1', label: 'آلمان', trafficBytes: String(1024 ** 3), durationHours: 24 },
        ],
      }),
    });
    await mount();
    tabProfile();
    expect(await screen.findByRole('button', { name: text('miniapp.profile_trial') })).toBeTruthy();
  });

  it('does not fail the screen when the trial read fails: that row is simply absent', async () => {
    serve({ 'GET /trial': () => refuse(500, 'internal.unhandled') });
    await mount();
    tabProfile();
    await screen.findByText(text('miniapp.profile_wallet_history'));
    expect(screen.queryByText(text('miniapp.profile_trial'))).toBeNull();
  });

  it('opens the wallet and the referral screens from its rows', async () => {
    serve({
      'GET /wallet': () => wallet(),
      'GET /wallet/entries': () => entries,
      'GET /referral': () => ({ active: false }),
    });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    await screen.findByText(text('miniapp.referral_inactive'));
  });
});

describe('home', () => {
  it('has a top-up button, no bell and no notifications entry', async () => {
    serve({ 'GET /wallet': () => wallet(), 'GET /wallet/entries': () => entries });
    await mount();
    expect(screen.queryByText(/اعلان/u)).toBeNull();
    expect(screen.queryByLabelText(/اعلان/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.home_topup') }));
    await screen.findByText(text('miniapp.wallet_topup_title'));
  });

  it('shows the trial shortcut only while a panel offers a trial', async () => {
    serve({});
    await mount();
    expect(screen.queryByRole('button', { name: text('miniapp.home_shortcut_trial') })).toBeNull();
    cleanup();
    serve({
      'GET /trial': () => ({
        offers: [
          { panelId: 'pn1', label: 'آلمان', trafficBytes: String(1024 ** 3), durationHours: 24 },
        ],
      }),
    });
    await mount();
    expect(
      await screen.findByRole('button', { name: text('miniapp.home_shortcut_trial') }),
    ).toBeTruthy();
  });

  it('reaches no screen for notifications or the reseller panel', () => {
    const keys = Object.keys(MINIAPP_FA);
    expect(
      keys.filter((key) => /notification|reseller_panel|reseller_dashboard/u.test(key)),
    ).toEqual([]);
    expect(
      Object.keys(MINIAPP_ROUTES).filter((key) => /notification|reseller/iu.test(key)),
    ).toEqual([]);
  });
});

describe('referral', () => {
  const active = {
    active: true,
    commissionPercent: 10,
    inviteLink: 'https://t.me/nexa_bot?start=ref-abc123',
    stats: { referralCount: 12, referredPurchaseCount: 5, commissionReceivedTotal: IRT(87_000) },
  };

  it('draws the commission, the link, the figures — and no list of friends', async () => {
    serve({ 'GET /referral': () => active });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    await screen.findByText(text('miniapp.referral_headline', { percent: 10 }));
    expect(screen.getByText(active.inviteLink)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText(money(IRT(87_000)))).toBeTruthy();
    expect(screen.queryByText(/دوستان اخیر/u)).toBeNull();
  });

  it('shares through Telegram and copies the link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve({ 'GET /referral': () => active });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.referral_share') }));
    expect(openTelegramLink).toHaveBeenCalledWith(
      `https://t.me/share/url?url=${encodeURIComponent(active.inviteLink)}`,
    );
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.referral_copy') }));
    await screen.findByText(text('miniapp.copied'));
    expect(writeText).toHaveBeenCalledWith(active.inviteLink);
  });

  it("says the program is off in the bot's sentence, and a failed read can be retried", async () => {
    let state: 'off' | 'down' = 'down';
    serve({
      'GET /referral': () =>
        state === 'down' ? refuse(500, 'internal.unhandled') : { active: false },
    });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    await screen.findByText(text('miniapp.error'));
    state = 'off';
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.retry') }));
    await screen.findByText(text('miniapp.referral_inactive'));
  });

  it('hides the figures card when the server returned none', async () => {
    serve({ 'GET /referral': () => ({ ...active, stats: null }) });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    await screen.findByText(text('miniapp.referral_headline', { percent: 10 }));
    expect(screen.queryByText(text('miniapp.referral_stat_invited'))).toBeNull();
  });

  it('R11 B3: draws no friends section while the feature is off', async () => {
    const calls = serve({ 'GET /referral': () => active });
    await mount();
    tabProfile();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.profile_referral') }));
    await screen.findByText(text('miniapp.referral_headline', { percent: 10 }));
    await waitFor(() =>
      expect(calls.some((call) => call.route === MINIAPP_ROUTES.referralFriends)).toBe(true),
    );
    expect(screen.queryByText(text('miniapp.referral_friends_title'))).toBeNull();
    expect(screen.queryByText(text('miniapp.referral_friends_empty'))).toBeNull();
  });

  describe('R11 B3: the invited friends', () => {
    const friend = (overrides: Record<string, unknown> = {}) => ({
      displayName: 'مهسا',
      joinedAt: '2026-10-20T10:00:00.000Z',
      status: 'JOINED',
      rewardNotBefore: null,
      ...overrides,
    });
    const counts = { total: 4, joined: 1, purchased: 1, rewardPending: 1, rewardPaid: 1 };

    async function open() {
      await mount();
      tabProfile();
      fireEvent.click(
        await screen.findByRole('button', { name: text('miniapp.profile_referral') }),
      );
    }

    it('draws the summary, each friend with a masked name, a date and one status, and the held date', async () => {
      serve({
        'GET /referral': () => active,
        'GET /referral/friends': () => ({
          enabled: true,
          counts,
          items: [
            friend({ displayName: '@ma***', status: 'REWARD_PAID' }),
            friend({
              displayName: 'علی',
              status: 'REWARD_PENDING',
              rewardNotBefore: '2026-10-28T00:00:00.000Z',
            }),
            friend({ displayName: null, status: 'PURCHASED' }),
            friend({ displayName: 'رضا', status: 'JOINED' }),
          ],
          nextCursor: null,
        }),
      });
      await open();
      await screen.findByText(text('miniapp.referral_friends_title'));
      expect(screen.getByText(text('miniapp.referral_friends_total', { count: 4 }))).toBeTruthy();
      expect(screen.getByText('@ma***')).toBeTruthy();
      expect(screen.getByText('علی')).toBeTruthy();
      // No name at all: the screen's own words, never a blank.
      expect(screen.getByText(text('miniapp.referral_friend_unnamed'))).toBeTruthy();
      // A status word is in the summary AND on the friend that has it.
      for (const key of [
        'miniapp.referral_friend_status_joined',
        'miniapp.referral_friend_status_purchased',
        'miniapp.referral_friend_status_reward_pending',
        'miniapp.referral_friend_status_reward_paid',
      ] as const) {
        expect(screen.getAllByText(text(key))).toHaveLength(2);
      }
      expect(
        screen.getByText(
          text('miniapp.referral_friend_held_until', {
            date: dateOnly('2026-10-28T00:00:00.000Z'),
          }),
        ),
      ).toBeTruthy();
      expect(
        screen.getAllByText(
          text('miniapp.referral_friend_joined_on', { date: dateOnly('2026-10-20T10:00:00.000Z') }),
        ),
      ).toHaveLength(4);
      // The ONLY paging control is absent when there is no further page.
      expect(
        screen.queryByRole('button', { name: text('miniapp.referral_friends_more') }),
      ).toBeNull();
    });

    it('appends the next page by its cursor and then stops offering more', async () => {
      const calls = serve({
        'GET /referral': () => active,
        'GET /referral/friends': (url) =>
          url.searchParams.get('cursor') === null
            ? {
                enabled: true,
                counts: { ...counts, total: 2 },
                items: [friend({ displayName: 'اول', joinedAt: '2026-10-21T10:00:00.000Z' })],
                nextCursor: 'cursor-1',
              }
            : {
                enabled: true,
                counts: { ...counts, total: 2 },
                items: [friend({ displayName: 'دوم', joinedAt: '2026-10-20T10:00:00.000Z' })],
                nextCursor: null,
              },
      });
      await open();
      await screen.findByText('اول');
      expect(screen.queryByText('دوم')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: text('miniapp.referral_friends_more') }));
      await screen.findByText('دوم');
      expect(screen.getByText('اول')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: text('miniapp.referral_friends_more') }),
      ).toBeNull();
      const asked = calls.filter((call) => call.route === MINIAPP_ROUTES.referralFriends);
      expect(asked.map((call) => call.query)).toEqual(['', '?cursor=cursor-1']);
    });

    it('says so when nobody has joined yet', async () => {
      serve({
        'GET /referral': () => active,
        'GET /referral/friends': () => ({
          enabled: true,
          counts: { total: 0, joined: 0, purchased: 0, rewardPending: 0, rewardPaid: 0 },
          items: [],
          nextCursor: null,
        }),
      });
      await open();
      await screen.findByText(text('miniapp.referral_friends_empty'));
    });

    it('keeps the rest of the screen when the list cannot be read, and can retry it', async () => {
      let down = true;
      serve({
        'GET /referral': () => active,
        'GET /referral/friends': () =>
          down
            ? refuse(500, 'internal.unhandled')
            : { enabled: true, counts, items: [friend()], nextCursor: null },
      });
      await open();
      await screen.findByText(text('miniapp.error'));
      expect(screen.getByText(text('miniapp.referral_headline', { percent: 10 }))).toBeTruthy();
      down = false;
      fireEvent.click(screen.getByRole('button', { name: text('miniapp.retry') }));
      await screen.findByText('مهسا');
    });
  });
});

describe('trial', () => {
  const offer = {
    panelId: 'pn1',
    label: 'آلمان',
    trafficBytes: String(2 * 1024 ** 3),
    durationHours: 24,
  };

  async function openTrial() {
    await mount();
    fireEvent.click(
      await screen.findByRole('button', { name: text('miniapp.home_shortcut_trial') }),
    );
  }

  it('claims the offered panel and says the service is being built', async () => {
    const calls = serve({
      'GET /trial': () => ({ offers: [offer] }),
      'POST /trial': () => ({ serviceId: 'svc-1' }),
    });
    await openTrial();
    await screen.findByText(text('miniapp.trial_hours', { hours: 24 }));
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.trial_claim') }));
    await screen.findByText(text('miniapp.trial_issued'));
    expect(calls.find((call) => call.method === 'POST' && call.route === '/trial')?.body).toEqual({
      panelId: 'pn1',
    });
    // Nothing the offer does not carry is drawn: no device count, no upgrade promise.
    expect(screen.queryByText(/دستگاه/u)).toBeNull();
    expect(screen.queryByText(/تخفیف/u)).toBeNull();
  });

  it('lets the customer pick among several panels, each claim naming its panel', async () => {
    const calls = serve({
      'GET /trial': () => ({ offers: [offer, { ...offer, panelId: 'pn2', label: 'هلند' }] }),
      'POST /trial': () => ({ serviceId: 'svc-2' }),
    });
    await openTrial();
    fireEvent.click(
      await screen.findByRole('button', {
        name: text('miniapp.trial_claim_offer', { label: 'هلند' }),
      }),
    );
    await screen.findByText(text('miniapp.trial_issued'));
    expect(calls.find((call) => call.method === 'POST' && call.route === '/trial')?.body).toEqual({
      panelId: 'pn2',
    });
  });

  it("answers a refused claim with the bot's one sentence and withdraws the offer", async () => {
    let refused = false;
    serve({
      'GET /trial': () => ({ offers: refused ? [] : [offer] }),
      'POST /trial': () => {
        refused = true;
        return refuse(409, 'miniapp.route_unavailable', { outcome: 'REFUSED' });
      },
    });
    await openTrial();
    fireEvent.click(await screen.findByRole('button', { name: text('miniapp.trial_claim') }));
    await waitFor(() =>
      expect(document.querySelector('p.error')?.textContent).toBe(
        text('miniapp.trial_unavailable'),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: text('miniapp.trial_claim') })).toBeNull(),
    );
    expect(screen.queryByText(text('miniapp.trial_issued'))).toBeNull();
  });

  it('says nothing can be claimed when no panel offers a trial now, and still leads to the store', async () => {
    let reads = 0;
    serve({ 'GET /trial': () => ({ offers: ++reads === 1 ? [offer] : [] }) });
    await openTrial();
    await screen.findByText(text('miniapp.trial_unavailable'));
    expect(screen.queryByRole('button', { name: text('miniapp.trial_claim') })).toBeNull();
    expect(screen.getByRole('button', { name: text('miniapp.trial_to_store') })).toBeTruthy();
  });

  it('maps the claim refusals: refused, choose, and anything else', () => {
    const conflict = (outcome: string) =>
      new ApiError(409, 'miniapp.route_unavailable', { outcome });
    expect(trialErrorText(conflict('REFUSED'))).toBe(MINIAPP_FA['miniapp.trial_unavailable']);
    expect(trialErrorText(conflict('CHOOSE'))).toBe(MINIAPP_FA['miniapp.trial_choose']);
    expect(trialErrorText(new ApiError(429, 'miniapp.rate_limited', {}))).toBe(
      MINIAPP_FA['miniapp.rate_limited'],
    );
    expect(trialErrorText(new ApiError(500, 'internal.unhandled', {}))).toBe(
      MINIAPP_FA['miniapp.error'],
    );
  });
});

describe('the store and home after the first screen', () => {
  it('draws every category tab, not only the first page of twenty', async () => {
    // 45 categories: the server pages them twenty at a time (`hasMore`), as the shop does.
    const all = Array.from({ length: 45 }, (_, index) => ({
      id: `cat-${String(index)}`,
      name: `دسته ${String(index)}`,
      emoji: null,
    }));
    const calls = serve({
      'GET /catalogue/categories': (url) => {
        const page = Number(url.searchParams.get('page') ?? '0');
        const items = all.slice(page * 20, page * 20 + 20);
        return { items, page, hasMore: (page + 1) * 20 < all.length };
      },
      'GET /catalogue/categories/cat-0': () => ({ items: [], page: 0, hasMore: false }),
    });
    await mount();
    tab(text('miniapp.tab_store'));
    await screen.findByRole('tab', { name: 'دسته 44' });
    expect(screen.getAllByRole('tab')).toHaveLength(45);
    expect(screen.getByRole('tab', { name: 'دسته 20' })).toBeTruthy();
    expect(
      calls.filter((one) => one.route === '/catalogue/categories').map((one) => one.query),
    ).toEqual(['?page=0', '?page=1', '?page=2']);
  });

  it('shows the balance as it is now when the customer comes back home, not the sign-in one', async () => {
    let balance = 1_250_000;
    const calls = serve({
      'GET /me': () => baseMe({ wallet: { balance: IRT(balance) } }),
      'GET /wallet': () => wallet({ balance: IRT(balance) }),
      'GET /wallet/entries': () => entries,
    });
    await mount();
    await screen.findByText(money(IRT(1_250_000)));
    // A card-to-card top-up of 100,000 is confirmed while the customer is on the wallet tab.
    tabWallet();
    balance = 1_350_000;
    await screen.findByText(text('miniapp.wallet_reason_referral'));
    tab(text('miniapp.tab_home'));
    await screen.findByText(money(IRT(1_350_000)));
    expect(screen.queryByText(money(IRT(1_250_000)))).toBeNull();
    expect(calls.filter((one) => one.route === '/me').length).toBeGreaterThanOrEqual(2);
  });
});
