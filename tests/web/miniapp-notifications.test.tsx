import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MINIAPP_NOTIFICATION_WINDOW_DAYS } from '@nexa/contracts';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';

/**
 * Round 11, B1: the customer mini app's notification centre — the bell in the header with
 * its unread counter, the list (newest first, paged), a tap that marks one read and
 * «همه خوانده شد» that marks all. Rendered from mocked API answers through the whole shell.
 *
 * With the feature off the server's `/me` carries no `notifications` block, and the shell
 * then draws no bell and never asks for the list.
 */

const BOT = '01900000-0000-7000-8000-00000000a001';
const text = (key: keyof typeof MINIAPP_FA, values: Record<string, string | number> = {}) =>
  MINIAPP_FA[key].replace(/\{([a-z]+)\}/gu, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]),
  );

interface Call {
  readonly method: string;
  readonly route: string;
  readonly query: string;
}

const meWith = (notifications: { unreadCount: number } | null) => ({
  customer: { firstName: 'سارا', username: 'sara_k' },
  botLink: 'https://t.me/nexa_bot',
  gate: null,
  wallet: { balance: { amountMinor: '1000', currency: 'IRT' } },
  reseller: null,
  notifications,
});

type Handler = (url: URL) => unknown;

/** Serves the mini-app API, recording every call; unknown routes answer 404. */
function serve(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    'POST /bots/:bot/session': () => ({
      token: `${BOT}.secret`,
      expiresAt: '2026-10-25T13:00:00.000Z',
    }),
    'GET /services': () => ({ items: [], page: 0, pages: 1, total: 0 }),
    'GET /trial': () => ({ offers: [] }),
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const route = url.pathname
        .replace('/miniapp/api/v1', '')
        .replace(BOT, ':bot')
        .replace(/\/notifications\/[^/]+\/read$/u, '/notifications/:id/read');
      const method = init.method ?? 'GET';
      calls.push({ method, route, query: url.search });
      const handler = all[`${method} ${route}`];
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ error: { kind: 'NOT_FOUND', code: 'miniapp.not_found' } }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(handler(url)), { status: 200 });
    }),
  );
  return calls;
}

/** Telegram's own back button: the shell registers its `back` here. */
let pressBack: () => void = () => undefined;

async function mount() {
  vi.resetModules();
  window.history.pushState({}, '', `/miniapp/${BOT}/`);
  (window as unknown as { Telegram: unknown }).Telegram = {
    WebApp: {
      initData: 'query_id=x&hash=y',
      colorScheme: 'dark',
      BackButton: {
        show() {},
        hide() {},
        onClick(handler: () => void) {
          pressBack = handler;
        },
        offClick() {},
      },
      ready() {},
      expand() {},
      openLink() {},
      openTelegramLink() {},
      onEvent() {},
    },
  };
  const { App } = await import('../../apps/miniapp/src/app');
  render(<App />);
  await screen.findByRole('navigation');
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

const item = (id: string, body: string, read: boolean, at = '2026-10-26T08:00:00.000Z') => ({
  id,
  text: body,
  createdAt: at,
  read,
});

/** The writes the centre made (the sign-in's own POST is not one of them). */
const writes = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === 'POST' && call.route.startsWith('/notifications'));

const bellName = (count: number) => text('miniapp.notifications_bell_unread', { count });

describe('the bell', () => {
  it('is not drawn, and the list is never asked for, while the feature is off', async () => {
    const calls = serve({ 'GET /me': () => meWith(null) });
    await mount();
    expect(screen.queryByRole('button', { name: /اعلان/u })).toBeNull();
    expect(screen.queryByLabelText(/اعلان/u)).toBeNull();
    expect(calls.some((call) => call.route.startsWith('/notifications'))).toBe(false);
  });

  it('shows the unread counter, and opens the list', async () => {
    const calls = serve({
      'GET /me': () => meWith({ unreadCount: 3 }),
      'GET /notifications': () => ({
        items: [item('n1', 'سفارش لغو شد.', false)],
        nextCursor: null,
        unreadCount: 3,
      }),
    });
    await mount();
    const bell = await screen.findByRole('button', { name: bellName(3) });
    expect(within(bell).getByText('3')).toBeTruthy();
    fireEvent.click(bell);
    await screen.findByText('سفارش لغو شد.');
    expect(calls.filter((call) => call.route === '/notifications')).toHaveLength(1);
  });

  it('draws no badge at zero, and caps the number it writes', async () => {
    serve({ 'GET /me': () => meWith({ unreadCount: 0 }) });
    await mount();
    const bell = await screen.findByRole('button', { name: text('miniapp.notifications_title') });
    expect(bell.querySelector('.bell-badge')).toBeNull();
    cleanup();
    serve({ 'GET /me': () => meWith({ unreadCount: 250 }) });
    await mount();
    const many = await screen.findByRole('button', { name: bellName(250) });
    expect(within(many).getByText('99+')).toBeTruthy();
  });
});

describe('the list', () => {
  it('draws the messages in the order the server sent them, unread ones marked, as text', async () => {
    serve({
      'GET /me': () => meWith({ unreadCount: 1 }),
      'GET /notifications': () => ({
        items: [
          item('n1', 'تازه <b>مهم</b>', false, '2026-10-26T09:00:00.000Z'),
          item('n2', 'قدیمی', true, '2026-10-25T09:00:00.000Z'),
        ],
        nextCursor: null,
        unreadCount: 1,
      }),
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: bellName(1) }));
    const first = await screen.findByText('تازه <b>مهم</b>');
    const second = screen.getByText('قدیمی');
    // The text is data: markup in a message is drawn literally, never interpreted.
    expect(first.querySelector('b')).toBeNull();
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('img', { name: text('miniapp.notifications_unread') })).toHaveLength(
      1,
    );
    expect(
      screen.getByText(
        text('miniapp.notifications_window', { days: MINIAPP_NOTIFICATION_WINDOW_DAYS }),
      ),
    ).toBeTruthy();
  });

  it('says so when there is nothing to list, and disables «همه خوانده شد»', async () => {
    serve({
      'GET /me': () => meWith({ unreadCount: 0 }),
      'GET /notifications': () => ({ items: [], nextCursor: null, unreadCount: 0 }),
    });
    await mount();
    fireEvent.click(
      await screen.findByRole('button', { name: text('miniapp.notifications_title') }),
    );
    await screen.findByText(text('miniapp.notifications_empty'));
    expect(
      screen.getByRole('button', { name: text('miniapp.notifications_read_all') }),
    ).toHaveProperty('disabled', true);
  });

  it('pages: «more» asks with the cursor it was given and appends', async () => {
    const calls = serve({
      'GET /me': () => meWith({ unreadCount: 2 }),
      'GET /notifications': (url) =>
        url.searchParams.get('cursor') === 'CURSOR-1'
          ? { items: [item('n2', 'صفحهٔ دوم', true)], nextCursor: null, unreadCount: 2 }
          : { items: [item('n1', 'صفحهٔ اول', false)], nextCursor: 'CURSOR-1', unreadCount: 2 },
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: bellName(2) }));
    await screen.findByText('صفحهٔ اول');
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.notifications_more') }));
    await screen.findByText('صفحهٔ دوم');
    expect(screen.getByText('صفحهٔ اول')).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('miniapp.notifications_more') })).toBeNull();
    expect(
      calls.filter((call) => call.route === '/notifications').map((call) => call.query),
    ).toEqual(['', '?cursor=CURSOR-1']);
  });
});

describe('marking read', () => {
  it('a tap on an unread message marks that one read and lowers the bell', async () => {
    let unread = 2;
    const calls = serve({
      'GET /me': () => meWith({ unreadCount: unread }),
      'GET /notifications': () => ({
        items: [item('n1', 'الف', false), item('n2', 'ب', false)],
        nextCursor: null,
        unreadCount: unread,
      }),
      'POST /notifications/:id/read': () => {
        unread -= 1;
        return { marked: 1, unreadCount: unread };
      },
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: bellName(2) }));
    fireEvent.click(await screen.findByText('الف'));
    await waitFor(() =>
      expect(
        screen.getAllByRole('img', { name: text('miniapp.notifications_unread') }),
      ).toHaveLength(1),
    );
    expect(writes(calls).map((call) => call.route)).toEqual(['/notifications/:id/read']);
    // A second tap on the same, now read, message asks nothing.
    fireEvent.click(screen.getByText('الف'));
    expect(writes(calls)).toHaveLength(1);
    // Telegram's back button returns to the tab, whose bell shows the lowered counter.
    act(() => pressBack());
    expect(await screen.findByRole('button', { name: bellName(1) })).toBeTruthy();
  });

  it('«همه خوانده شد» marks every message read in one request', async () => {
    let unread = 2;
    const calls = serve({
      'GET /me': () => meWith({ unreadCount: unread }),
      'GET /notifications': () => ({
        items: [item('n1', 'الف', false), item('n2', 'ب', false)],
        nextCursor: null,
        unreadCount: unread,
      }),
      'POST /notifications/read-all': () => {
        unread = 0;
        return { marked: 2, unreadCount: 0 };
      },
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: bellName(2) }));
    await screen.findByText('الف');
    fireEvent.click(screen.getByRole('button', { name: text('miniapp.notifications_read_all') }));
    await waitFor(() =>
      expect(
        screen.queryAllByRole('img', { name: text('miniapp.notifications_unread') }),
      ).toHaveLength(0),
    );
    expect(writes(calls).map((call) => call.route)).toEqual(['/notifications/read-all']);
    expect(
      screen.getByRole('button', { name: text('miniapp.notifications_read_all') }),
    ).toHaveProperty('disabled', true);
  });

  it('shows a refusal in Persian and keeps the message unread', async () => {
    serve({
      'GET /me': () => meWith({ unreadCount: 1 }),
      'GET /notifications': () => ({
        items: [item('n1', 'الف', false)],
        nextCursor: null,
        unreadCount: 1,
      }),
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: bellName(1) }));
    fireEvent.click(await screen.findByText('الف'));
    await screen.findByRole('alert');
    expect(screen.getByText(text('miniapp.not_found'))).toBeTruthy();
    expect(screen.getAllByRole('img', { name: text('miniapp.notifications_unread') })).toHaveLength(
      1,
    );
  });
});
