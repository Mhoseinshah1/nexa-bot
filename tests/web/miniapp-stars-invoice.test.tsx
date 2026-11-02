import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import type { InvoiceStatus } from '../../apps/miniapp/src/telegram';
import { PayStatus } from '../../apps/miniapp/src/screens/pay-status';

/**
 * R11 B5 — the in-app Stars invoice on the payment screen, against a REAL `MiniAppApi` over a
 * stubbed `fetch` and a stubbed `Telegram.WebApp.openInvoice`.
 *
 * The rule under test is the one a client can break: `openInvoice`'s `paid` is the CLIENT's
 * word. The screen says «در حال تأیید پرداخت…» and keeps reading the server; only the server's
 * CONFIRMED makes it say the payment is confirmed. `cancelled` and `failed` leave the order
 * payable, with the button still there.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const PAYMENT = 'p-stars-1';
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

let paymentState: 'PENDING' | 'CONFIRMED' = 'PENDING';
let calls: string[] = [];
let linkStatus = 200;
let invoiceStatus: InvoiceStatus = 'paid';
const openInvoice = vi.fn((_url: string, callback?: (status: InvoiceStatus) => void) => {
  callback?.(invoiceStatus);
});

const statusBody = (inAppInvoice = true) => ({
  paymentId: PAYMENT,
  method: 'GATEWAY',
  state: paymentState,
  transferPending: false,
  receiptFiled: false,
  gateway: {
    paymentId: PAYMENT,
    orderId: 'o1',
    provider: 'TELEGRAM_STARS',
    invoiceReady: true,
    payUrl: null,
    paysInChat: true,
    inAppInvoice,
    expiresAt: null,
  },
  order: {
    id: 'o1',
    code: 'O-1',
    state: paymentState === 'CONFIRMED' ? 'PAID' : 'AWAITING_PAYMENT',
    title: 'پلن ستاره',
  },
});

function mount(inAppInvoice = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace('/miniapp/api/v1', '').split('?')[0] ?? '';
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === `/payments/${PAYMENT}`) {
        return new Response(JSON.stringify(statusBody(inAppInvoice)), { status: 200 });
      }
      if (method === 'POST' && path === `/payments/${PAYMENT}/stars-invoice`) {
        return linkStatus === 200
          ? new Response(
              JSON.stringify({ paymentId: PAYMENT, invoiceLink: 'https://t.me/$invoice-1' }),
              { status: 201 },
            )
          : new Response(
              JSON.stringify({ error: { kind: 'CONFLICT', code: 'miniapp.route_unavailable' } }),
              { status: linkStatus },
            );
      }
      if (method === 'POST' && path === `/payments/${PAYMENT}/check`) {
        return new Response(JSON.stringify(statusBody(inAppInvoice).gateway), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: { botLink: 'https://t.me/nexa_bot' },
    refreshMe: vi.fn(async () => undefined),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  };
  (window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: {
      initData: 'query_id=x&hash=y',
      colorScheme: 'dark',
      openLink: vi.fn(),
      openTelegramLink: vi.fn(),
      openInvoice,
    },
  };
}

beforeEach(() => {
  paymentState = 'PENDING';
  calls = [];
  linkStatus = 200;
  invoiceStatus = 'paid';
  openInvoice.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

describe('the in-app Stars invoice (R11 B5)', () => {
  it('opens the link once on arrival from checkout, and a client `paid` is NOT a paid order', async () => {
    mount();
    render(<PayStatus paymentId={PAYMENT} openInvoice />);
    await waitFor(() => expect(openInvoice).toHaveBeenCalledTimes(1));
    expect(openInvoice.mock.calls[0]?.[0]).toBe('https://t.me/$invoice-1');
    // The client said paid; the server still says PENDING. The screen says "confirming".
    expect(await screen.findByText(fa('miniapp.pay_stars_confirming'))).toBeTruthy();
    expect(screen.queryByText(fa('miniapp.pay_confirmed'))).toBeNull();
    // No button to pay again while the charge is being confirmed.
    expect(screen.queryByText(fa('miniapp.pay_stars_open'))).toBeNull();
    // It only ever ASKED the server; nothing claims the payment.
    expect(calls.filter((one) => one.startsWith('POST'))).toEqual([
      `POST /payments/${PAYMENT}/stars-invoice`,
    ]);
  });

  it('says confirmed only once the server does', async () => {
    mount();
    render(<PayStatus paymentId={PAYMENT} openInvoice />);
    await screen.findByText(fa('miniapp.pay_stars_confirming'));
    paymentState = 'CONFIRMED';
    // The next read of the payment (the screen polls, and re-reads after the invoice closes).
    fireEvent.click(screen.getByText(fa('miniapp.pay_check')));
    expect(await screen.findByText(fa('miniapp.pay_confirmed'))).toBeTruthy();
  });

  it('leaves the order payable after `cancelled` or `failed`, with the button to pay again', async () => {
    for (const closed of ['cancelled', 'failed'] as const) {
      invoiceStatus = closed;
      mount();
      render(<PayStatus paymentId={PAYMENT} openInvoice />);
      expect(await screen.findByText(fa('miniapp.pay_stars_not_completed'))).toBeTruthy();
      expect(screen.getByText(fa('miniapp.pay_waiting'))).toBeTruthy();
      expect(screen.getByText(fa('miniapp.pay_stars_open'))).toBeTruthy();
      cleanup();
    }
  });

  it('pays again from the button, and says the existing refusal when Stars is no longer offered', async () => {
    mount();
    linkStatus = 409;
    render(<PayStatus paymentId={PAYMENT} />);
    fireEvent.click(await screen.findByText(fa('miniapp.pay_stars_open')));
    expect(await screen.findByText(fa('miniapp.wallet_route_unavailable'))).toBeTruthy();
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it('draws no in-app button for an attempt the server does not offer here, and opens nothing', async () => {
    mount(false);
    render(<PayStatus paymentId={PAYMENT} openInvoice />);
    expect(await screen.findByText(fa('miniapp.pay_in_chat'))).toBeTruthy();
    expect(screen.queryByText(fa('miniapp.pay_stars_open'))).toBeNull();
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it('says so on a Telegram without openInvoice, and the chat invoice stays', async () => {
    mount();
    (window as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp[
      'openInvoice'
    ] = undefined;
    render(<PayStatus paymentId={PAYMENT} openInvoice />);
    expect(await screen.findByText(fa('miniapp.pay_stars_unsupported'))).toBeTruthy();
    expect(screen.getByText(fa('miniapp.pay_in_chat'))).toBeTruthy();
  });
});
