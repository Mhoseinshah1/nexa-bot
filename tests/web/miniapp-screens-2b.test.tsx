import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIAPP_FA } from '../../apps/miniapp/src/i18n/miniapp.fa';
import { MiniAppApi } from '../../apps/miniapp/src/api';
import { applyTheme, type TelegramWebApp } from '../../apps/miniapp/src/telegram';
import { Support } from '../../apps/miniapp/src/screens/support';
import { NewTicket, Ticket } from '../../apps/miniapp/src/screens/ticket';
import { Apps } from '../../apps/miniapp/src/screens/apps';
import { ServiceDetail } from '../../apps/miniapp/src/screens/service-detail';
import { Gate } from '../../apps/miniapp/src/screens/gate';

/**
 * Round 9, C5 part 2b: Support, the connection guide, the QR and location sheets, the
 * channel gate and the light skin — rendered against a REAL `MiniAppApi` over a stubbed
 * `fetch`, so the headers, the contract schemas and the error codes are the production
 * path. Only the shell (`useApp`) is replaced by a context the test owns.
 *
 * What these show that the integration suite cannot: what the customer is SHOWN. Each
 * element the service cannot back (attachments, auto-add, remaining location changes, the
 * «پیشنهادی» tag, per-channel ticks) is asserted ABSENT, and every read has its empty and
 * error state.
 */

const state = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../../apps/miniapp/src/app', () => ({ useApp: () => state.ctx }));

const BOT = '01900000-0000-7000-8000-00000000a001';
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const fa = (key: keyof typeof MINIAPP_FA) => MINIAPP_FA[key];

type Handler = (request: { method: string; body: unknown; headers: Record<string, string> }) => {
  status?: number;
  body?: unknown;
};
let routes: Record<string, Handler> = {};
let calls: { key: string; body: unknown; headers: Record<string, string> }[] = [];
let navigate: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
let refreshMe: ReturnType<typeof vi.fn>;

function mountApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace('/miniapp/api/v1', '').split('?')[0] ?? '';
      const key = `${method} ${path}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ key, body, headers });
      const handler = routes[key];
      if (handler === undefined) return new Response('{}', { status: 404 });
      const answer = handler({ method, body, headers });
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
    }),
  );
  navigate = vi.fn();
  replace = vi.fn();
  refreshMe = vi.fn(async () => undefined);
  state.ctx = {
    api: new MiniAppApi(BOT),
    me: {},
    refreshMe,
    navigate,
    replace,
    back: vi.fn(),
  };
}

const refusal = (status: number, code: string) => ({
  status,
  body: { error: { kind: 'CONFLICT', code } },
});

beforeEach(() => {
  routes = {};
  calls = [];
  mountApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

// ---------------------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------------------

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  code: '#1042',
  subject: 'کندی اتصال در ساعات شب',
  categoryTitle: 'اتصال',
  status: 'WAITING_FOR_CUSTOMER',
  lastMessageAt: '2026-10-24T10:00:00.000Z',
  ...overrides,
});

describe('Support', () => {
  const categories = { body: { items: [{ id: 'c1', title: 'اتصال' }] } };

  it('lists the customer’s tickets with the bot’s status words, and opens one', async () => {
    routes['GET /ticket-categories'] = () => categories;
    routes['GET /tickets'] = () => ({
      body: {
        items: [
          ticket(),
          ticket({ id: 't2', subject: 'رسید', status: 'WAITING_FOR_SUPPORT' }),
          ticket({ id: 't3', subject: 'بسته', status: 'CLOSED' }),
        ],
      },
    });
    render(<Support />);
    expect(await screen.findByText('کندی اتصال در ساعات شب')).toBeTruthy();
    expect(screen.getByText(fa('miniapp.ticket_status_WAITING_FOR_CUSTOMER'))).toBeTruthy();
    expect(screen.getByText(fa('miniapp.ticket_status_WAITING_FOR_SUPPORT'))).toBeTruthy();
    expect(screen.getByText(fa('miniapp.ticket_status_CLOSED'))).toBeTruthy();
    fireEvent.click(screen.getByText('رسید'));
    expect(navigate).toHaveBeenCalledWith({ name: 'ticket', ticketId: 't2' });
    // The design’s attach button has no backing: text tickets only.
    expect(screen.queryByLabelText('پیوست')).toBeNull();
  });

  it('offers a new ticket only when a category is active', async () => {
    routes['GET /tickets'] = () => ({ body: { items: [] } });
    routes['GET /ticket-categories'] = () => ({ body: { items: [] } });
    const { unmount } = render(<Support />);
    expect(await screen.findByText(fa('miniapp.support_no_tickets'))).toBeTruthy();
    expect(screen.queryByText(fa('miniapp.support_new_ticket'))).toBeNull();
    unmount();

    routes['GET /ticket-categories'] = () => categories;
    render(<Support />);
    fireEvent.click(await screen.findByText(fa('miniapp.support_new_ticket')));
    expect(navigate).toHaveBeenCalledWith({ name: 'ticket-new' });
  });

  it('says an error, and retries', async () => {
    routes['GET /ticket-categories'] = () => categories;
    let fail = true;
    routes['GET /tickets'] = () =>
      fail ? { status: 500, body: {} } : { body: { items: [ticket()] } };
    render(<Support />);
    expect(await screen.findByText(fa('miniapp.error'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText(fa('miniapp.retry')));
    expect(await screen.findByText('کندی اتصال در ساعات شب')).toBeTruthy();
  });

  it('shows the operator’s FAQ and contact link only when they exist', async () => {
    routes['GET /ticket-categories'] = () => categories;
    routes['GET /tickets'] = () => ({ body: { items: [] } });
    routes['GET /support'] = () => ({
      body: {
        faqs: [{ question: 'رسید کی تأیید می‌شود؟', answer: 'تا یک ساعت' }],
        supportUrl: null,
      },
    });
    const { unmount } = render(<Support />);
    fireEvent.click(screen.getByRole('tab', { name: fa('miniapp.support_tab_faq') }));
    expect(await screen.findByText('رسید کی تأیید می‌شود؟')).toBeTruthy();
    expect(screen.getByText('تا یک ساعت')).toBeTruthy();
    expect(screen.queryByText(fa('miniapp.support_contact'))).toBeNull();
    unmount();

    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    routes['GET /support'] = () => ({ body: { faqs: [], supportUrl: 'https://t.me/support_nx' } });
    render(<Support />);
    fireEvent.click(screen.getByRole('tab', { name: fa('miniapp.support_tab_faq') }));
    // An empty FAQ is said, not invented.
    expect(await screen.findByText(fa('miniapp.support_no_faq'))).toBeTruthy();
    fireEvent.click(screen.getByText(fa('miniapp.support_contact')));
    expect(open).toHaveBeenCalledWith('https://t.me/support_nx', '_blank', 'noopener');
  });
});

describe('a ticket', () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    ...ticket(),
    messages: [
      {
        author: 'CUSTOMER',
        text: 'وصل نمی‌شود',
        hasAttachment: true,
        createdAt: '2026-10-24T09:00:00.000Z',
      },
      {
        author: 'SUPPORT',
        text: 'لینک جدید بگیرید.',
        hasAttachment: false,
        createdAt: '2026-10-24T10:00:00.000Z',
      },
    ],
    ...overrides,
  });

  it('shows the conversation, says an attachment is in the bot, and sends a reply', async () => {
    routes['GET /tickets/t1'] = () => ({ body: detail() });
    routes['POST /tickets/t1/replies'] = ({ body }) => ({
      status: 201,
      body: detail({
        messages: [
          ...detail().messages,
          {
            author: 'CUSTOMER',
            text: (body as { text: string }).text,
            hasAttachment: false,
            createdAt: '2026-10-24T11:00:00.000Z',
          },
        ],
      }),
    });
    render(<Ticket ticketId="t1" />);
    expect(await screen.findByText('لینک جدید بگیرید.')).toBeTruthy();
    expect(screen.getByText(fa('miniapp.ticket_attachment'))).toBeTruthy();
    const send = screen.getByRole('button', { name: fa('miniapp.ticket_reply_send') });
    expect((send as HTMLButtonElement).disabled, 'nothing typed, nothing to send').toBe(true);
    fireEvent.change(screen.getByLabelText(fa('miniapp.ticket_reply_label')), {
      target: { value: 'ممنون' },
    });
    fireEvent.click(send);
    expect(await screen.findByText('ممنون')).toBeTruthy();
    const post = calls.find((call) => call.key === 'POST /tickets/t1/replies');
    expect(post?.body).toEqual({ text: 'ممنون' });
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('has no reply box on a closed ticket, and offers a new one', async () => {
    routes['GET /tickets/t1'] = () => ({ body: detail({ status: 'CLOSED' }) });
    render(<Ticket ticketId="t1" />);
    expect(await screen.findByText(fa('miniapp.ticket_closed'))).toBeTruthy();
    expect(screen.queryByLabelText(fa('miniapp.ticket_reply_label'))).toBeNull();
    fireEvent.click(screen.getByText(fa('miniapp.support_new_ticket')));
    expect(replace).toHaveBeenCalledWith({ name: 'ticket-new' });
  });

  it('says why a reply was refused, in the bot’s words', async () => {
    routes['GET /tickets/t1'] = () => ({ body: detail() });
    routes['POST /tickets/t1/replies'] = () => refusal(409, 'ticket.message_limit');
    render(<Ticket ticketId="t1" />);
    await screen.findByText('لینک جدید بگیرید.');
    fireEvent.change(screen.getByLabelText(fa('miniapp.ticket_reply_label')), {
      target: { value: 'سلام' },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.ticket_reply_send') }));
    expect(await screen.findByText(fa('miniapp.ticket_message_limit'))).toBeTruthy();
  });

  it('answers a missing ticket with the one not-found sentence', async () => {
    routes['GET /tickets/t9'] = () => ({
      status: 404,
      body: { error: { kind: 'NOT_FOUND', code: 'miniapp.not_found' } },
    });
    render(<Ticket ticketId="t9" />);
    expect(await screen.findByText(fa('miniapp.not_found'))).toBeTruthy();
  });
});

describe('a new ticket', () => {
  it('says so when no category is active, with no form', async () => {
    routes['GET /ticket-categories'] = () => ({ body: { items: [] } });
    render(<NewTicket />);
    expect(await screen.findByText(fa('miniapp.ticket_category_none'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: fa('miniapp.ticket_submit') })).toBeNull();
  });

  it('opens the ticket with the chosen category and goes to it; the open limit is said', async () => {
    routes['GET /ticket-categories'] = () => ({ body: { items: [{ id: 'c1', title: 'اتصال' }] } });
    routes['POST /tickets'] = () => refusal(409, 'ticket.open_limit');
    render(<NewTicket />);
    await screen.findByLabelText(fa('miniapp.ticket_category'));
    const submit = screen.getByRole('button', { name: fa('miniapp.ticket_submit') });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(fa('miniapp.ticket_category')), {
      target: { value: 'c1' },
    });
    fireEvent.change(screen.getByLabelText(fa('miniapp.ticket_text')), {
      target: { value: 'کمک' },
    });
    fireEvent.click(submit);
    expect(await screen.findByText(fa('miniapp.ticket_open_limit'))).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();

    routes['POST /tickets'] = () => ({
      status: 201,
      body: {
        ...ticket({ id: 'new1' }),
        messages: [
          {
            author: 'CUSTOMER',
            text: 'کمک',
            hasAttachment: false,
            createdAt: '2026-10-25T00:00:00.000Z',
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.ticket_submit') }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith({ name: 'ticket', ticketId: 'new1' }));
    expect(calls.filter((call) => call.key === 'POST /tickets').at(-1)?.body).toEqual({
      categoryId: 'c1',
      text: 'کمک',
    });
  });
});

// ---------------------------------------------------------------------------------------
// The connection guide
// ---------------------------------------------------------------------------------------

describe('the connection guide', () => {
  const app = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    name: 'برنامهٔ نمونه',
    description: 'ساده‌ترین',
    officialUrl: 'https://example.test/get',
    alternativeUrl: null,
    helpUrl: null,
    guide: 'اول نصب کنید.\nبعد لینک را وارد کنید.',
    ...overrides,
  });

  it('shows the operator’s apps with only the links that exist, and their guide verbatim', async () => {
    routes['GET /guide'] = () => ({ body: { platforms: ['ANDROID', 'IOS'] } });
    routes['GET /guide/ANDROID'] = () => ({
      body: { platform: 'ANDROID', apps: [app()], fallbackGuide: null },
    });
    routes['GET /guide/IOS'] = () => ({
      body: { platform: 'IOS', apps: [], fallbackGuide: 'راهنمای آیفون' },
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Apps />);
    expect(await screen.findByText('برنامهٔ نمونه')).toBeTruthy();
    expect(screen.getByText('ساده‌ترین')).toBeTruthy();
    expect(screen.getByText(/اول نصب کنید/u)).toBeTruthy();
    fireEvent.click(screen.getByText(fa('miniapp.apps_download')));
    expect(open).toHaveBeenCalledWith('https://example.test/get', '_blank', 'noopener');
    expect(screen.queryByText(fa('miniapp.apps_download_alt'))).toBeNull();
    expect(screen.queryByText(fa('miniapp.apps_help'))).toBeNull();
    // The deep link into the app has no backing in the client-apps setting.
    expect(screen.queryByText(/افزودن خودکار/u)).toBeNull();

    // A platform with no app shows the tenant’s own text for it.
    fireEvent.click(screen.getByRole('tab', { name: fa('miniapp.platform_IOS') }));
    expect(await screen.findByText('راهنمای آیفون')).toBeTruthy();
    expect(screen.queryByText('برنامهٔ نمونه')).toBeNull();
  });

  it('says so when nothing is configured: no platforms, or a platform with neither', async () => {
    routes['GET /guide'] = () => ({ body: { platforms: [] } });
    const { unmount } = render(<Apps />);
    expect(await screen.findByText(fa('miniapp.apps_none'))).toBeTruthy();
    unmount();

    routes['GET /guide'] = () => ({ body: { platforms: ['WINDOWS'] } });
    routes['GET /guide/WINDOWS'] = () => ({
      body: { platform: 'WINDOWS', apps: [], fallbackGuide: null },
    });
    render(<Apps />);
    expect(await screen.findByText(fa('miniapp.apps_platform_none'))).toBeTruthy();
  });

  it('says an error, and leads to support', async () => {
    routes['GET /guide'] = () => ({ status: 500, body: {} });
    render(<Apps />);
    expect(await screen.findByText(fa('miniapp.error'))).toBeTruthy();
    fireEvent.click(screen.getByText(fa('miniapp.service_support')));
    expect(navigate).toHaveBeenCalledWith({ name: 'support' });
  });
});

// ---------------------------------------------------------------------------------------
// The service screen's sheets
// ---------------------------------------------------------------------------------------

const GIB = 1024n ** 3n;
const service = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  code: 'S1',
  title: 'پلن پایه',
  state: 'ACTIVE',
  username: 'nx1',
  trafficUsedBytes: String(GIB),
  trafficLimitBytes: String(50n * GIB),
  expiresAt: '2026-12-20T00:00:00.000Z',
  usageSyncedAt: '2026-10-25T00:00:00.000Z',
  deviceLimit: 3,
  locationLabel: 'آلمان',
  isTrial: false,
  subscriptionUrl: 'https://sub.example.test/abc',
  working: false,
  actions: [],
  qr: true,
  qrKinds: ['SUB_LINK'],
  canChangeLocation: true,
  locationRemaining: null,
  autoRenew: { offered: false, enabled: false, price: null, leadHours: 24 },
  ...overrides,
});

const money = (amount: string) => ({ amountMinor: amount, currency: 'IRT' });

describe('the QR and link sheet', () => {
  let write: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    URL.createObjectURL = vi.fn(() => 'blob:qr');
    URL.revokeObjectURL = vi.fn();
  });

  it('draws the server’s QR, copies the link, and closes with Escape', async () => {
    routes['GET /services/s1'] = () => ({ body: service() });
    routes['GET /services/s1/qr/SUB_LINK'] = () => ({ body: {} });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.service_show_qr')));
    const dialog = await screen.findByRole('dialog', { name: fa('miniapp.service_qr_title') });
    expect(
      (await within(dialog).findByAltText(fa('miniapp.service_qr_alt'))).getAttribute('src'),
    ).toBe('blob:qr');
    expect(within(dialog).getByText(fa('miniapp.service_qr_hint'))).toBeTruthy();
    fireEvent.click(within(dialog).getByText(fa('miniapp.service_copy_link')));
    await waitFor(() => expect(write).toHaveBeenCalledWith('https://sub.example.test/abc'));
    expect(await within(dialog).findByText(fa('miniapp.service_copied'))).toBeTruthy();
    // Nothing the service cannot do: no single-config or file tab, no save, no share.
    expect(screen.queryByText(/کانفیگ تکی/u)).toBeNull();
    expect(screen.queryByText(/ذخیره تصویر/u)).toBeNull();
    expect(screen.queryByText(/اشتراک‌گذاری/u)).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr');
  });

  it('R11 A4: draws both QRs of a BOTH panel, each under its own caption', async () => {
    routes['GET /services/s1'] = () => ({ body: service({ qrKinds: ['SUB_LINK', 'SINGBOX'] }) });
    routes['GET /services/s1/qr/SUB_LINK'] = () => ({ body: {} });
    routes['GET /services/s1/qr/SINGBOX'] = () => ({ body: {} });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.service_show_qr')));
    const dialog = await screen.findByRole('dialog', { name: fa('miniapp.service_qr_title') });
    expect(await within(dialog).findAllByAltText(fa('miniapp.service_qr_alt'))).toHaveLength(2);
    expect(within(dialog).getByText(fa('miniapp.service_qr_sublink'))).toBeTruthy();
    expect(within(dialog).getByText(fa('miniapp.service_qr_singbox'))).toBeTruthy();
  });

  it('a single QR carries no kind caption', async () => {
    routes['GET /services/s1'] = () => ({ body: service() });
    routes['GET /services/s1/qr/SUB_LINK'] = () => ({ body: {} });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.service_show_qr')));
    const dialog = await screen.findByRole('dialog', { name: fa('miniapp.service_qr_title') });
    expect(await within(dialog).findAllByAltText(fa('miniapp.service_qr_alt'))).toHaveLength(1);
    expect(within(dialog).queryByText(fa('miniapp.service_qr_sublink'))).toBeNull();
  });

  it('says so when the image cannot be made, and when the clipboard refuses', async () => {
    write.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    routes['GET /services/s1'] = () => ({ body: service() });
    routes['GET /services/s1/qr/SUB_LINK'] = () => ({ status: 500, body: {} });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.service_show_qr')));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(fa('miniapp.service_qr_failed'))).toBeTruthy();
    fireEvent.click(within(dialog).getByText(fa('miniapp.service_copy_link')));
    expect(await within(dialog).findByText(fa('miniapp.service_copy_failed'))).toBeTruthy();
  });

  it('is not offered when the service has no QR', async () => {
    routes['GET /services/s1'] = () => ({
      body: service({ qr: false, qrKinds: [], subscriptionUrl: null }),
    });
    render(<ServiceDetail serviceId="s1" />);
    await screen.findByText('پلن پایه');
    expect(screen.queryByText(fa('miniapp.service_show_qr'))).toBeNull();
  });
});

/**
 * Round 10, D1: «تمدید خودکار». ON asks first and names the server's quote; only the confirm
 * posts; OFF acts at once; a refusal is the server's, in Persian; nothing is drawn for a
 * service that is neither offered it nor opted in.
 */
describe('automatic renewal', () => {
  const offered = { offered: true, enabled: false, price: money('120000'), leadHours: 24 };
  const confirmText = /^تأیید: تمدید خودکار با مبلغ/u;

  it('is not drawn for a service neither offered it nor opted in', async () => {
    routes['GET /services/s1'] = () => ({ body: service() });
    render(<ServiceDetail serviceId="s1" />);
    await screen.findByText('پلن پایه');
    expect(screen.queryByText(fa('miniapp.auto_renew_title'))).toBeNull();
  });

  it('asks before switching on, and only the confirmation posts', async () => {
    routes['GET /services/s1'] = () => ({ body: service({ autoRenew: offered }) });
    routes['POST /services/s1/auto-renew'] = () => ({
      body: { offered: false, enabled: true, price: money('120000'), leadHours: 24 },
    });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.auto_renew_enable')));
    expect(calls.some((call) => call.key === 'POST /services/s1/auto-renew')).toBe(false);
    fireEvent.click(await screen.findByText(confirmText));
    expect(await screen.findByText(fa('miniapp.auto_renew_disable'))).toBeTruthy();
    const post = calls.find((call) => call.key === 'POST /services/s1/auto-renew');
    // The confirm names the figure it showed: the consent is bound to it (Codex, PR 338).
    expect(post?.body).toEqual({ enabled: true, expected: money('120000') });
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('a price that rose before the confirm is asked again at the new figure, never recorded', async () => {
    routes['GET /services/s1'] = () => ({ body: service({ autoRenew: offered }) });
    routes['POST /services/s1/auto-renew'] = () => ({
      body: { offered: true, enabled: false, price: money('130000'), leadHours: 24 },
    });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.auto_renew_enable')));
    fireEvent.click(await screen.findByText(confirmText));
    // Still the question, now naming the new price; the second confirm carries THAT figure.
    await waitFor(() =>
      expect(calls.filter((call) => call.key === 'POST /services/s1/auto-renew')).toHaveLength(1),
    );
    fireEvent.click(await screen.findByText(confirmText));
    await waitFor(() =>
      expect(calls.filter((call) => call.key === 'POST /services/s1/auto-renew')).toHaveLength(2),
    );
    const posts = calls.filter((call) => call.key === 'POST /services/s1/auto-renew');
    expect(posts.map((call) => call.body)).toEqual([
      { enabled: true, expected: money('120000') },
      { enabled: true, expected: money('130000') },
    ]);
    expect(screen.queryByText(fa('miniapp.auto_renew_disable'))).toBeNull();
  });

  it('switches off at once, and answers a refusal in Persian', async () => {
    routes['GET /services/s1'] = () => ({
      body: service({
        autoRenew: { offered: false, enabled: true, price: money('120000'), leadHours: 24 },
      }),
    });
    routes['POST /services/s1/auto-renew'] = () =>
      refusal(409, 'commerce.auto_renew_not_available');
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.auto_renew_disable')));
    expect(await screen.findByText(fa('miniapp.auto_renew_unavailable'))).toBeTruthy();
    expect(calls.find((call) => call.key === 'POST /services/s1/auto-renew')?.body).toEqual({
      enabled: false,
    });
  });
});

describe('the location sheet', () => {
  const offer = {
    current: { label: 'آلمان' },
    targets: [
      { id: 'l-nl', label: 'هلند', price: money('30000') },
      { id: 'l-fi', label: 'فنلاند', price: money('0') },
    ],
    remaining: null,
  };

  async function openSheet() {
    routes['GET /services/s1'] = () => ({ body: service() });
    render(<ServiceDetail serviceId="s1" />);
    fireEvent.click(await screen.findByText(fa('miniapp.location_open')));
    return screen.findByRole('dialog', { name: fa('miniapp.location_title') });
  }

  it('is not offered when the service says it cannot be moved', async () => {
    routes['GET /services/s1'] = () => ({ body: service({ canChangeLocation: false }) });
    render(<ServiceDetail serviceId="s1" />);
    await screen.findByText('پلن پایه');
    expect(screen.queryByText(fa('miniapp.location_open'))).toBeNull();
  });

  const remainingText = (remaining: number, max: number) =>
    fa('miniapp.location_remaining')
      .replace('{remaining}', String(remaining))
      .replace('{max}', String(max));

  it('R11 B4: says nothing about what remains when the server sends no limit', async () => {
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    const dialog = await openSheet();
    await within(dialog).findByText('هلند');
    expect(screen.queryByText(/تغییر لوکیشن باقی‌مانده/u)).toBeNull();
  });

  it('R11 B4: says how many changes are left on the service view and on the sheet', async () => {
    routes['GET /services/s1'] = () => ({
      body: service({ locationRemaining: { remaining: 2, max: 3 } }),
    });
    routes['GET /services/s1/locations'] = () => ({
      body: { ...offer, remaining: { remaining: 2, max: 3 } },
    });
    render(<ServiceDetail serviceId="s1" />);
    expect(await screen.findByText(remainingText(2, 3))).toBeTruthy();
    fireEvent.click(await screen.findByText(fa('miniapp.location_open')));
    const dialog = await screen.findByRole('dialog', { name: fa('miniapp.location_title') });
    expect(await within(dialog).findByText(remainingText(2, 3))).toBeTruthy();
  });

  it('R11 B4: at zero the view still says «0 از 3», and offers no way into the sheet', async () => {
    routes['GET /services/s1'] = () => ({
      body: service({ canChangeLocation: false, locationRemaining: { remaining: 0, max: 3 } }),
    });
    render(<ServiceDetail serviceId="s1" />);
    expect(await screen.findByText(remainingText(0, 3))).toBeTruthy();
    expect(screen.queryByText(fa('miniapp.location_open'))).toBeNull();
  });

  it('lists where it is and the priced targets, and draws nothing the service does not expose', async () => {
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    const dialog = await openSheet();
    expect(await within(dialog).findByText('هلند')).toBeTruthy();
    expect(within(dialog).getByText(fa('miniapp.location_current'))).toBeTruthy();
    expect(within(dialog).getByText(fa('miniapp.location_free'))).toBeTruthy();
    // The remaining-count pill, the «پیشنهادی» tag and the «ظرفیت تکمیل» state have no backing.
    expect(within(dialog).queryByText(/تغییر دیگر/u)).toBeNull();
    expect(within(dialog).queryByText(/پیشنهادی/u)).toBeNull();
    expect(within(dialog).queryByText(/ظرفیت/u)).toBeNull();
    expect(
      (within(dialog).getByText(fa('miniapp.location_pick')).closest('button') as HTMLButtonElement)
        .disabled,
      'nothing picked, nothing to confirm',
    ).toBe(true);
  });

  it('requests a free move on confirmation, and says it is queued', async () => {
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    routes['POST /services/s1/location'] = () => ({ status: 201, body: { outcome: 'REQUESTED' } });
    const dialog = await openSheet();
    fireEvent.click(await within(dialog).findByText('فنلاند'));
    fireEvent.click(
      within(dialog).getByText(fa('miniapp.location_move').replace('{location}', 'فنلاند')),
    );
    expect(await within(dialog).findByText(fa('miniapp.location_requested'))).toBeTruthy();
    const post = calls.find((call) => call.key === 'POST /services/s1/location');
    expect(post?.body).toEqual({ locationId: 'l-fi' });
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('takes a priced move to the ordinary checkout', async () => {
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    routes['POST /services/s1/location'] = () => ({
      status: 201,
      body: {
        outcome: 'ORDER',
        order: {
          id: 'o1',
          code: 'O1',
          state: 'DRAFT',
          purpose: 'CHANGE_LOCATION',
          title: 'تغییر لوکیشن',
          trafficBytes: null,
          durationDays: null,
          subtotal: money('30000'),
          discount: money('0'),
          total: money('30000'),
          discountApplied: false,
          discountEditable: false,
          cashback: null,
          expiresAt: null,
          serviceId: 's1',
          username: 'nx1',
          usernameModes: [],
          locations: [],
          features: [],
          description: null,
        },
      },
    });
    const dialog = await openSheet();
    fireEvent.click(await within(dialog).findByText('هلند'));
    fireEvent.click(within(dialog).getByText(/ادامه و پیش‌فاکتور/u));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ name: 'checkout', orderId: 'o1' }));
  });

  it('says the cooldown and the limit in the bot’s words, and keeps the sheet open', async () => {
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    routes['POST /services/s1/location'] = () => refusal(409, 'commerce.location_change_cooldown');
    const dialog = await openSheet();
    fireEvent.click(await within(dialog).findByText('فنلاند'));
    fireEvent.click(
      within(dialog).getByText(fa('miniapp.location_move').replace('{location}', 'فنلاند')),
    );
    expect(await within(dialog).findByText(fa('miniapp.location_cooldown'))).toBeTruthy();
    routes['POST /services/s1/location'] = () =>
      refusal(409, 'commerce.location_change_limit_reached');
    fireEvent.click(
      within(dialog).getByText(fa('miniapp.location_move').replace('{location}', 'فنلاند')),
    );
    expect(await within(dialog).findByText(fa('miniapp.location_limit'))).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says so when nothing can be offered, and retries', async () => {
    routes['GET /services/s1/locations'] = () =>
      refusal(409, 'commerce.service_action_unavailable');
    const dialog = await openSheet();
    expect(await within(dialog).findByText(fa('miniapp.location_unavailable'))).toBeTruthy();
    routes['GET /services/s1/locations'] = () => ({ body: offer });
    fireEvent.click(within(dialog).getByText(fa('miniapp.retry')));
    expect(await within(dialog).findByText('هلند')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------
// The channel gate
// ---------------------------------------------------------------------------------------

describe('the channel gate', () => {
  const gate = {
    kind: 'CHANNELS' as const,
    channels: [
      { handle: '@nexa_news', joinUrl: 'https://t.me/nexa_news' },
      { handle: null, joinUrl: 'https://t.me/+private' },
    ],
  };

  it('is the artboard: title, sentence, the missing channels, the join buttons, the check', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    routes['POST /gate/check'] = () => ({
      status: 201,
      body: {
        customer: { firstName: null, username: null },
        botLink: null,
        gate: null,
        wallet: null,
        reseller: null,
      },
    });
    render(<Gate gate={gate} />);
    expect(screen.getByRole('heading', { name: fa('miniapp.gate_title') })).toBeTruthy();
    expect(screen.getByText(fa('miniapp.gate_channels'))).toBeTruthy();
    expect(screen.getByText('@nexa_news').closest('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('کانال 2')).toBeTruthy();
    const joins = screen.getAllByText(fa('miniapp.gate_join'));
    expect(joins).toHaveLength(2);
    fireEvent.click(joins[0] as HTMLElement);
    expect(open).toHaveBeenCalledWith('https://t.me/nexa_news', '_blank', 'noopener');
    // Only MISSING channels come back: no «۱ از ۲», no progress bar, no «عضو هستید ✓», and no
    // claim that membership is checked by itself.
    expect(screen.queryByText(/از ۲|از 2/u)).toBeNull();
    expect(screen.queryByText(/عضو هستید/u)).toBeNull();
    expect(screen.queryByText(/به‌صورت خودکار/u)).toBeNull();
    expect(document.querySelector('progress, [role="progressbar"]')).toBeNull();
    // The check is the full-width primary button under the card.
    const check = screen.getByRole('button', { name: fa('miniapp.gate_check') });
    expect(check.className).toContain('btn-wide');
    fireEvent.click(check);
    await waitFor(() => expect(refreshMe).toHaveBeenCalled());
    expect(calls.some((call) => call.key === 'POST /gate/check')).toBe(true);
  });

  it('says why a check failed', async () => {
    routes['POST /gate/check'] = () => ({
      status: 429,
      body: { error: { kind: 'RATE', code: 'miniapp.rate_limited' } },
    });
    render(<Gate gate={gate} />);
    fireEvent.click(screen.getByRole('button', { name: fa('miniapp.gate_check') }));
    expect(await screen.findByText(fa('miniapp.rate_limited'))).toBeTruthy();
  });

  it('keeps the blocked and terms gates', () => {
    const { unmount } = render(<Gate gate={{ kind: 'BLOCKED' }} />);
    expect(screen.getByText(fa('miniapp.gate_blocked'))).toBeTruthy();
    unmount();
    render(
      <Gate gate={{ kind: 'TERMS', terms: { versionId: 'v1', title: 'قوانین', body: 'متن' } }} />,
    );
    expect(screen.getByText('قوانین')).toBeTruthy();
    expect(screen.getByText(fa('miniapp.gate_terms_accept'))).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------
// The light skin
// ---------------------------------------------------------------------------------------

describe('the light skin', () => {
  const tokens = readFileSync(join(REPO_ROOT, 'apps/miniapp/src/styles/tokens.css'), 'utf8');
  const base = readFileSync(join(REPO_ROOT, 'apps/miniapp/src/styles/base.css'), 'utf8');
  const block = (selector: RegExp): string => {
    const match = selector.exec(tokens);
    if (match === null) throw new Error(`no ${String(selector)}`);
    const start = tokens.indexOf('{', match.index);
    return tokens.slice(start + 1, tokens.indexOf('\n}', start));
  };
  const properties = (css: string) => [...css.matchAll(/^\s*(--[a-z0-9-]+):/gmu)].map((m) => m[1]);
  const dark = block(/:root,\s*:root\[data-theme='dark'\]/u);
  const light = block(/:root\[data-theme='light'\]/u);

  it('redefines every colour token the dark skin defines', () => {
    const lightProps = new Set(properties(light));
    const missing = properties(dark).filter((name) => !lightProps.has(name));
    expect(missing).toEqual([]);
  });

  it('follows Telegram’s themeParams for the page, the text, the button and the links', () => {
    for (const [token, param] of [
      ['--bg-0', 'bg-color'],
      ['--fg', 'text-color'],
      ['--fg-2', 'subtitle-text-color'],
      ['--fg-3', 'hint-color'],
      ['--accent', 'button-color'],
      ['--accent-fg', 'button-text-color'],
      ['--danger', 'destructive-text-color'],
      ['--usage', 'link-color'],
    ] as const) {
      expect(light, token).toMatch(new RegExp(`${token}:\\s*var\\(--tg-theme-${param}`, 'u'));
    }
    expect(light).toContain('--tg-theme-secondary-bg-color');
  });

  it('draws a card with its lift from the token, so the light skin owns its own shadow', () => {
    expect(base).toMatch(/\.glass\s*\{[^}]*var\(--card-shadow\)/u);
    expect(light).toMatch(/--card-shadow:/u);
  });

  it('writes data-theme from Telegram’s colour scheme, light only when asked', () => {
    const app = (colorScheme: 'light' | 'dark') => ({ colorScheme }) as unknown as TelegramWebApp;
    applyTheme(app('light'));
    expect(document.documentElement.dataset['theme']).toBe('light');
    applyTheme(app('dark'));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    applyTheme(null);
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('the sources of this part', () => {
  it('draw their text from the catalogue: no Persian literal in a screen', () => {
    for (const file of [
      'screens/support.tsx',
      'screens/ticket.tsx',
      'screens/apps.tsx',
      'screens/qr-sheet.tsx',
      'screens/location-sheet.tsx',
      'screens/gate.tsx',
      'sheet.tsx',
    ]) {
      const text = readFileSync(join(REPO_ROOT, 'apps/miniapp/src', file), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
      expect(code, file).not.toMatch(/[؀-ۿ]/u);
    }
  });
});
