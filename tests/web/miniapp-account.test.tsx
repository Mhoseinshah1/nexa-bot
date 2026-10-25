import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MINIAPP_ROUTES } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { ApiError } from '../../apps/miniapp/src/api';
import { money, parseAmountInput, signedMoney } from '../../apps/miniapp/src/format';
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
          principal: null,
          fee: null,
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
